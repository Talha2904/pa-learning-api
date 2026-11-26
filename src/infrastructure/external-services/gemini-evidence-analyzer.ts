import { ApiError, createPartFromBase64, createPartFromUri, FileState, GoogleGenAI, type Part } from '@google/genai';
import {
  EvidenceAnalyzerError,
  type EvidenceAnalyzer,
  type EvidenceAnalyzerInput,
  type EvidenceAnalyzerOutput,
} from '../../application/ports/evidence-analyzer.js';
import { parseEvidenceAnalysis } from '../../application/services/evidence-analysis.schema.js';
import type { EvidenceExpectation } from '../../domain/value-objects/evidence-analysis.js';
import { claimText, SYSTEM_INSTRUCTION } from './evidence-prompt.js';

/** Inline requests are capped at ~20 MB after base64 (+33%); bigger files go through the Files API. */
const INLINE_MAX_BYTES = 14 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 90_000;

/** JSON Schema for structured output (mirrors EvidenceAnalysis). */
const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    isCertificate: { type: 'boolean' },
    documentType: { type: 'string', description: 'What the document is, e.g. "Course completion certificate".' },
    extracted: {
      type: 'object',
      properties: {
        participantName: { type: ['string', 'null'] },
        courseTitle: { type: ['string', 'null'] },
        provider: { type: ['string', 'null'] },
        completionDate: { type: ['string', 'null'], description: 'YYYY-MM-DD' },
        hours: { type: ['number', 'null'] },
        certificateId: { type: ['string', 'null'] },
      },
      required: ['participantName', 'courseTitle', 'provider', 'completionDate', 'hours', 'certificateId'],
    },
    checks: {
      type: 'object',
      properties: {
        name: { type: 'string', enum: ['match', 'partial', 'mismatch', 'not_found'] },
        title: { type: 'string', enum: ['match', 'partial', 'mismatch', 'not_found'] },
        provider: { type: 'string', enum: ['match', 'partial', 'mismatch', 'not_found'] },
      },
      required: ['name', 'title', 'provider'],
    },
    tamperingSigns: { type: 'array', items: { type: 'string' } },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    summary: { type: 'string' },
  },
  required: ['isCertificate', 'documentType', 'extracted', 'checks', 'tamperingSigns', 'confidence', 'summary'],
};

/** Overloaded / rate-limited / temporarily down: worth trying another model or later. */
const isBusy = (err: unknown) =>
  err instanceof ApiError && (err.status === 408 || err.status === 429 || err.status >= 500);

/**
 * Google Gemini (Developer API) implementation of the EvidenceAnalyzer port.
 * `models` is tried in order: when one is overloaded (503/429/5xx) the next
 * one is used straight away, so a demand spike on one model doesn't stall checks.
 */
export class GeminiEvidenceAnalyzer implements EvidenceAnalyzer {
  private readonly ai: GoogleGenAI;
  private readonly models: string[];

  constructor(apiKey: string, models: string[]) {
    if (models.length === 0) throw new Error('GeminiEvidenceAnalyzer needs at least one model');
    this.ai = new GoogleGenAI({ apiKey });
    this.models = [...new Set(models)];
  }

  async analyze({ bytes, mimeType, expected }: EvidenceAnalyzerInput): Promise<EvidenceAnalyzerOutput> {
    let uploadedName: string | null = null;
    try {
      let filePart: Part;
      if (bytes.length <= INLINE_MAX_BYTES) {
        filePart = createPartFromBase64(Buffer.from(bytes).toString('base64'), mimeType);
      } else {
        const file = await this.uploadLarge(bytes, mimeType);
        uploadedName = file.name;
        filePart = createPartFromUri(file.uri, mimeType);
      }

      const { response, model } = await this.generate(filePart, expected);

      const raw = response.text;
      if (!raw) {
        const reason = response.promptFeedback?.blockReason ?? response.candidates?.[0]?.finishReason ?? 'empty';
        throw new EvidenceAnalyzerError(`The model returned no result (${reason}).`, false);
      }
      let analysis;
      try {
        analysis = parseEvidenceAnalysis(raw);
      } catch {
        throw new EvidenceAnalyzerError('The model returned an unreadable result.', true);
      }
      const usage = response.usageMetadata;
      return {
        provider: 'gemini',
        model: response.modelVersion ?? model,
        analysis,
        inputTokens: usage?.promptTokenCount ?? null,
        outputTokens: usage ? (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0) : null,
      };
    } catch (err) {
      throw toAnalyzerError(err);
    } finally {
      if (uploadedName) await this.ai.files.delete({ name: uploadedName }).catch(() => undefined);
    }
  }

  /** First model that answers wins; busy models are skipped, other errors stop immediately. */
  private async generate(filePart: Part, expected: EvidenceExpectation) {
    let lastBusy: unknown = null;
    for (const model of this.models) {
      try {
        const response = await this.ai.models.generateContent({
          model,
          contents: [{ role: 'user', parts: [filePart, { text: claimText(expected) }] }],
          config: {
            systemInstruction: SYSTEM_INSTRUCTION,
            responseMimeType: 'application/json',
            responseJsonSchema: RESPONSE_SCHEMA,
            temperature: 0,
            httpOptions: { timeout: REQUEST_TIMEOUT_MS },
          },
        });
        return { response, model };
      } catch (err) {
        if (!isBusy(err)) throw err;
        lastBusy = err;
      }
    }
    throw lastBusy;
  }

  private async uploadLarge(bytes: Uint8Array, mimeType: string): Promise<{ name: string; uri: string }> {
    let file = await this.ai.files.upload({
      file: new Blob([Buffer.from(bytes)], { type: mimeType }),
      config: { mimeType },
    });
    for (let i = 0; i < 30 && file.state === FileState.PROCESSING && file.name; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      file = await this.ai.files.get({ name: file.name });
    }
    if (!file.name || !file.uri || file.state === FileState.FAILED) {
      throw new EvidenceAnalyzerError('The file could not be processed by the model.', false);
    }
    return { name: file.name, uri: file.uri };
  }
}

function toAnalyzerError(err: unknown): EvidenceAnalyzerError {
  if (err instanceof EvidenceAnalyzerError) return err;
  if (err instanceof ApiError) {
    // 429 / 5xx / timeouts are temporary; 400/401/403/404 are configuration or content problems.
    const retryable = err.status === 408 || err.status === 429 || err.status >= 500;
    return new EvidenceAnalyzerError(`Gemini API error ${err.status}: ${err.message.slice(0, 300)}`, retryable, retryable);
  }
  // Network failure / timeout - the service, not the file.
  return new EvidenceAnalyzerError(`Gemini request failed: ${(err as Error)?.message ?? String(err)}`, true, true);
}
