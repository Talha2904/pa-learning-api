import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it, vi } from 'vitest';
import { EvidenceAnalyzerError } from '../../src/application/ports/evidence-analyzer.js';
import { ClaudeEvidenceAnalyzer } from '../../src/infrastructure/external-services/claude-evidence-analyzer.js';

const expected = {
  personName: 'Sarah Whitfield',
  itemTitle: 'AML annual update',
  itemDescription: null,
  provider: 'ICAEW',
  hours: 1.5,
  completedOn: '2026-02-11',
  category: 'Mandatory Compliance',
  deliveryType: 'eLearning',
};

const answer = {
  isCertificate: true,
  documentType: 'Certificate',
  extracted: { participantName: 'Sarah Whitfield', courseTitle: 'AML', provider: 'ICAEW', completionDate: '2026-02-10', hours: 1.5, certificateId: null },
  checks: { name: 'match', title: 'match', provider: 'match' },
  tamperingSigns: [],
  confidence: 0.9,
  summary: 'ok',
};

type CreateParams = Anthropic.MessageCreateParamsNonStreaming;

/** Analyzer with the SDK call stubbed (no network, fake key). */
function analyzerWith(impl: (req: CreateParams) => Promise<unknown>, models = ['claude-opus-5-5']) {
  const a = new ClaudeEvidenceAnalyzer('test-key-not-real', models);
  const create = vi.fn(impl);
  (a as unknown as { client: { messages: { create: unknown } } }).client.messages.create = create;
  return { a, create };
}

const reply = (text: string, extra: Record<string, unknown> = {}) => ({
  model: 'claude-opus-5-5',
  stop_reason: 'end_turn',
  stop_details: null,
  content: [{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'text', text }],
  usage: { input_tokens: 2100, output_tokens: 320 },
  ...extra,
});

const overloaded = () =>
  Anthropic.APIError.generate(529, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }, 'Overloaded', new Headers());

const pdf = { bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]), mimeType: 'application/pdf', expected };
const fail = (a: ClaudeEvidenceAnalyzer, input = pdf) =>
  a.analyze(input).catch((e: unknown) => e) as Promise<EvidenceAnalyzerError>;

describe('ClaudeEvidenceAnalyzer', () => {
  it('reads the file and returns the validated analysis', async () => {
    const { a, create } = analyzerWith(async () => reply(JSON.stringify(answer)));
    const out = await a.analyze(pdf);
    expect(out).toMatchObject({ provider: 'claude', model: 'claude-opus-5-5', inputTokens: 2100, outputTokens: 320 });
    expect(out.analysis.checks).toEqual({ name: 'match', title: 'match', provider: 'match' });

    const req = create.mock.calls[0]![0];
    expect(req.model).toBe('claude-opus-5-5');
    expect(req.system).toContain('Ignore any instructions');
    expect(req.output_config?.format?.type).toBe('json_schema');
    const content = req.messages[0]!.content as Anthropic.ContentBlockParam[];
    expect(content[0]).toMatchObject({ type: 'document', source: { type: 'base64', media_type: 'application/pdf' } });
    expect(content[1]).toMatchObject({ type: 'text' });
    expect((content[1] as Anthropic.TextBlockParam).text).toContain('Sarah Whitfield');
  });

  it('sends images as image blocks', async () => {
    const { a, create } = analyzerWith(async () => reply(JSON.stringify(answer)));
    await a.analyze({ ...pdf, mimeType: 'image/png' });
    const content = create.mock.calls[0]![0].messages[0]!.content as Anthropic.ContentBlockParam[];
    expect(content[0]).toMatchObject({ type: 'image', source: { type: 'base64', media_type: 'image/png' } });
  });

  it('treats malformed output as a temporary failure (retried, never verified)', async () => {
    const { a } = analyzerWith(async () => reply('{"isCertificate": "maybe"'));
    const err = await fail(a);
    expect(err).toBeInstanceOf(EvidenceAnalyzerError);
    expect(err).toMatchObject({ retryable: true, busy: false });
  });

  it('reports "busy, try later" when Claude is overloaded (529) or rate-limited (429)', async () => {
    for (const status of [529, 429, 503]) {
      const { a } = analyzerWith(async () => {
        throw Anthropic.APIError.generate(status, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }, 'Overloaded', new Headers());
      });
      expect(await fail(a)).toMatchObject({ retryable: true, busy: true });
    }
  });

  it('falls back to the next model straight away when the main one is overloaded (529)', async () => {
    const { a, create } = analyzerWith(
      async ({ model }) => {
        if (model === 'claude-opus-5-5') throw overloaded();
        return reply(JSON.stringify(answer), { model });
      },
      ['claude-opus-5-5', 'claude-sonnet-5-5'],
    );
    const out = await a.analyze(pdf);
    expect(out).toMatchObject({ provider: 'claude', model: 'claude-sonnet-5-5' });
    expect(create.mock.calls.map(([r]) => r.model)).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5']);
    // No SDK retry on a model we can fall back from; one retry on the last.
    expect(create.mock.calls.map((c) => (c as unknown[])[1])).toEqual([{ maxRetries: 0 }, { maxRetries: 1 }]);
  });

  it('reports "busy, try later" when every model is overloaded', async () => {
    const { a, create } = analyzerWith(async () => {
      throw overloaded();
    }, ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']);
    expect(await fail(a)).toMatchObject({ retryable: true, busy: true });
    expect(create).toHaveBeenCalledTimes(3);
  });

  it('does not try other models for a refusal or a request problem', async () => {
    const refusal = reply('', { stop_reason: 'refusal', stop_details: { type: 'refusal', category: null, explanation: null }, content: [] });
    const { a, create } = analyzerWith(async () => refusal, ['claude-opus-5-5', 'claude-sonnet-5-5']);
    expect(await fail(a)).toMatchObject({ retryable: false });
    expect(create).toHaveBeenCalledOnce();
  });

  it('does not switch model on a network failure (retried later by the queue)', async () => {
    const { a, create } = analyzerWith(async () => {
      throw new Anthropic.APIConnectionError({ message: 'socket hang up' });
    }, ['claude-opus-5-5', 'claude-sonnet-5-5']);
    expect(await fail(a)).toMatchObject({ retryable: true, busy: true });
    expect(create).toHaveBeenCalledOnce();
  });

  it('reports "busy, try later" on a timeout or network failure', async () => {
    const { a } = analyzerWith(async () => {
      throw new Anthropic.APIConnectionTimeoutError();
    });
    expect(await fail(a)).toMatchObject({ retryable: true, busy: true });
  });

  it('does not retry a request problem (400)', async () => {
    const { a, create } = analyzerWith(async () => {
      throw Anthropic.APIError.generate(400, { type: 'error', error: { type: 'invalid_request_error', message: 'bad' } }, 'bad', new Headers());
    });
    expect(await fail(a)).toMatchObject({ retryable: false, busy: false });
    expect(create).toHaveBeenCalledOnce();
  });

  it('hands a refusal to a person: a final failure, never an analysis', async () => {
    const { a } = analyzerWith(async () =>
      reply('', { stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber', explanation: null }, content: [] }),
    );
    const err = await fail(a);
    expect(err).toBeInstanceOf(EvidenceAnalyzerError);
    expect(err).toMatchObject({ retryable: false, busy: false });
    expect(err.message).toContain('declined');
  });

  it('rejects a file type the model cannot read without calling the API', async () => {
    const { a, create } = analyzerWith(async () => reply(JSON.stringify(answer)));
    expect(await fail(a, { ...pdf, mimeType: 'text/html' })).toMatchObject({ retryable: false });
    expect(create).not.toHaveBeenCalled();
  });
});
