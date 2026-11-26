import { describe, expect, it } from 'vitest';
import { loadEnv } from '../../src/infrastructure/config/env.js';

// Fake values only - never real keys.
const base = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://unused',
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key-not-real',
};

describe('AI provider configuration', () => {
  it('defaults to Gemini with checks off', () => {
    const env = loadEnv({ ...base });
    expect(env).toMatchObject({
      AI_VERIFICATION_ENABLED: false,
      AI_PROVIDER: 'gemini',
      CLAUDE_MODEL: 'claude-opus-5-5',
      CLAUDE_FALLBACK_MODELS: ['claude-sonnet-5-5'],
    });
  });

  it('reads a comma-separated Claude fallback list (empty = none)', () => {
    expect(loadEnv({ ...base, CLAUDE_FALLBACK_MODELS: ' claude-sonnet-5-5 , claude-haiku-5-5 ' }).CLAUDE_FALLBACK_MODELS).toEqual([
      'claude-sonnet-5-5',
      'claude-haiku-5-5',
    ]);
    expect(loadEnv({ ...base, CLAUDE_FALLBACK_MODELS: '' }).CLAUDE_FALLBACK_MODELS).toEqual([]);
  });

  it('needs no key at all while checks are off, whichever provider is selected', () => {
    expect(() => loadEnv({ ...base, AI_PROVIDER: 'claude' })).not.toThrow();
    expect(() => loadEnv({ ...base, AI_PROVIDER: 'gemini' })).not.toThrow();
  });

  it('requires GEMINI_API_KEY when Gemini is selected and enabled', () => {
    expect(() => loadEnv({ ...base, AI_VERIFICATION_ENABLED: 'true', ANTHROPIC_API_KEY: 'fake' })).toThrow(/GEMINI_API_KEY/);
    expect(() => loadEnv({ ...base, AI_VERIFICATION_ENABLED: 'true', GEMINI_API_KEY: 'fake' })).not.toThrow();
  });

  it('requires ANTHROPIC_API_KEY when Claude is selected and enabled', () => {
    const claude = { ...base, AI_VERIFICATION_ENABLED: 'true', AI_PROVIDER: 'claude' };
    expect(() => loadEnv({ ...claude, GEMINI_API_KEY: 'fake' })).toThrow(/ANTHROPIC_API_KEY/);
    const env = loadEnv({ ...claude, ANTHROPIC_API_KEY: 'fake', CLAUDE_MODEL: 'claude-sonnet-5-5' });
    expect(env).toMatchObject({ AI_PROVIDER: 'claude', CLAUDE_MODEL: 'claude-sonnet-5-5' });
  });

  it('rejects an unknown provider', () => {
    expect(() => loadEnv({ ...base, AI_PROVIDER: 'openai' })).toThrow(/AI_PROVIDER/);
  });
});
