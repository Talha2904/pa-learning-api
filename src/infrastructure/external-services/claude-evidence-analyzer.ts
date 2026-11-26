import Anthropic from '@anthropic-ai/sdk';
import {
  EvidenceAnalyzerError,
  type EvidenceAnalyzer,
  type EvidenceAnalyzerInput,
  type EvidenceAnalyzerOutput,
} from '../../application/ports/evidence-analyzer.js';
import { parseEvidenceAnalysis } from '../../application/services/evidence-analysis.schema.js';
import { claimText, SYSTEM_INSTRUCTION } from './evidence-prompt.js';

const REQUEST_TIMEOUT_MS = 120_000;
const MAX_TOKENS = 16_000;

const nullable = (type: 'string' | 'number', description?: string) => ({
  anyOf: [{ type, ...(description ? { description } : {}) }, { type: 'null' }],
});
const checkResult = { type: 'string', enum: ['match', 'partial', 'mismatch', 'not_found'] };

/**
 * JSON Schema for structured output (mirrors EvidenceAnalysis). Kept to the subset
 * Claude's structured outputs accept (no numeric bounds; every object closed).
 * The reply is still validated by parseEvidenceAnalysis - model output is untrusted.
 */
const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    isCertificate: { type: 'boolean' },
    documentType: { type: 'string', description: 'What the document is, e.g. "Course completion certificate".' },
    extracted: {
      type: 'object',
      properties: {
        participantName: nullable('string'),
        courseTitle: nullable('string'),
        provider: nullable('string'),
        completionDate: nullable('string', 'YYYY-MM-DD'),
        hours: nullable('number'),
        certificateId: nullable('string'),
      },
      required: ['participantName', 'courseTitle', 'provider', 'completionDate', 'hours', 'certificateId'],
      additionalProperties: false,
    },
    checks: {
      type: 'object',
      properties: { name: checkResult, title: checkResult, provider: checkResult },
      required: ['name', 'title', 'provider'],
      additionalProperties: false,
    },
    tamperingSigns: { type: 'array', items: { type: 'string' } },
    confidence: { type: 'number', description: '0 to 1' },
    summary: { type: 'string' },
  },
  required: ['isCertificate', 'documentType', 'extracted', 'checks', 'tamperingSigns', 'confidence', 'summary'],
  additionalProperties: false,
};

type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
const IMAGE_TYPES: readonly string[] = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

function fileBlock(bytes: Uint8Array, mimeType: string): Anthropic.ContentBlockParam {
  const data = Buffer.from(bytes).toString('base64');
  if (mimeType === 'application/pdf') {
    return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } };
  }
  if (IMAGE_TYPES.includes(mimeType)) {
    return { type: 'image', source: { type: 'base64', media_type: mimeType as ImageMediaType, data } };
  }
  throw new EvidenceAnalyzerError(`Unsupported file type for automatic checks: ${mimeType}.`, false);
}

/** Overloaded / rate-limited / temporarily down (429, 5xx, 529): worth trying another model or later. */
const isBusy = (err: unknown) =>
  err instanceof Anthropic.APIError &&
  !(err instanceof Anthropic.APIConnectionError) &&
  (err.status === 408 || err.status === 429 || (err.status ?? 0) >= 500);

/**
 * Anthropic Claude implementation of the EvidenceAnalyzer port (ADR 0005).
 * Selected with AI_PROVIDER=claude. Reads PDFs/images directly and answers with
 * the same JSON as the Gemini adapter; the firm's rules then decide the outcome.
 * `models` is tried in order: when one is overloaded (429/529/5xx) the next one
 * is used straight away, so a demand spike on one model doesn't stall checks.
 */
export class ClaudeEvidenceAnalyzer implements EvidenceAnalyzer {
  private readonly client: Anthropic;
  private readonly models: string[];

  constructor(apiKey: string, models: string[]) {
    if (models.length === 0) throw new Error('ClaudeEvidenceAnalyzer needs at least one model');
    this.client = new Anthropic({ apiKey, timeout: REQUEST_TIMEOUT_MS });
    this.models = [...new Set(models)];
  }

  async analyze({ bytes, mimeType, expected }: EvidenceAnalyzerInput): Promise<EvidenceAnalyzerOutput> {
    try {
      const { response, model } = await this.generate([
        fileBlock(bytes, mimeType),
        { type: 'text', text: claimText(expected) },
      ]);

      // A safety decline is never a pass: hand the evidence to a person (not retried).
      if (response.stop_reason === 'refusal') {
        const category = response.stop_details?.category ?? 'unspecified';
        throw new EvidenceAnalyzerError(`The model declined to read this file (${category}).`, false);
      }
      if (response.stop_reason === 'max_tokens') {
        throw new EvidenceAnalyzerError('The model result was cut off.', true);
      }

      const raw = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('');
      if (!raw) throw new EvidenceAnalyzerError(`The model returned no result (${response.stop_reason ?? 'empty'}).`, false);

      let analysis;
      try {
        analysis = parseEvidenceAnalysis(raw);
      } catch {
        throw new EvidenceAnalyzerError('The model returned an unreadable result.', true);
      }
      return {
        provider: 'claude',
        model: response.model || model,
        analysis,
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      };
    } catch (err) {
      throw toAnalyzerError(err);
    }
  }

  /** First model that answers wins; busy models are skipped, other errors stop immediately. */
  private async generate(content: Anthropic.ContentBlockParam[]) {
    let lastBusy: unknown = null;
    for (const [i, model] of this.models.entries()) {
      const isLast = i === this.models.length - 1;
      try {
        const response = await this.client.messages.create(
          {
            model,
            max_tokens: MAX_TOKENS,
            system: SYSTEM_INSTRUCTION,
            messages: [{ role: 'user', content }],
            output_config: { effort: 'medium', format: { type: 'json_schema', schema: RESPONSE_SCHEMA } },
          },
          // Move to the next model straight away; only the last one gets one SDK retry for a blip.
          // Longer outages are handled by the check queue's back-off.
          { maxRetries: isLast ? 1 : 0 },
        );
        return { response, model };
      } catch (err) {
        if (!isBusy(err)) throw err;
        lastBusy = err;
      }
    }
    throw lastBusy;
  }
}

function toAnalyzerError(err: unknown): EvidenceAnalyzerError {
  if (err instanceof EvidenceAnalyzerError) return err;
  // Timeouts and network failures - the service, not the file (APIConnectionTimeoutError extends this).
  if (err instanceof Anthropic.APIConnectionError) {
    return new EvidenceAnalyzerError(`Claude request failed: ${err.message}`, true, true);
  }
  if (err instanceof Anthropic.APIError) {
    // 429 rate limit / 5xx / 529 overloaded are temporary; 400/401/403/404 are configuration or content problems.
    const status = err.status ?? 0;
    const retryable = status === 408 || status === 429 || status >= 500;
    return new EvidenceAnalyzerError(`Claude API error ${status}: ${err.message.slice(0, 300)}`, retryable, retryable);
  }
  return new EvidenceAnalyzerError(`Claude request failed: ${(err as Error)?.message ?? String(err)}`, true, true);
}
