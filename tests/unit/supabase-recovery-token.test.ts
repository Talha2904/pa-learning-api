import { describe, expect, it, vi } from 'vitest';
import { SupabaseIdentityProvider } from '../../src/infrastructure/external-services/supabase-identity-provider.js';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('SupabaseIdentityProvider.createRecoveryToken', () => {
  it('asks generate_link for a recovery token (which sends no email) and returns the hashed token', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(200, { id: 'u1', hashed_token: 'hash-123', action_link: 'https://x/verify' }));
    const p = new SupabaseIdentityProvider('https://proj.supabase.co/', 'service-key', fetchMock);
    await expect(p.createRecoveryToken('glin@pa.co.uk')).resolves.toBe('hash-123');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://proj.supabase.co/auth/v1/admin/generate_link');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ type: 'recovery', email: 'glin@pa.co.uk' });
    expect(init.headers.Authorization).toBe('Bearer service-key');
  });

  it('also reads the token from a nested properties object', async () => {
    const p = new SupabaseIdentityProvider('https://proj.supabase.co', 'k', vi.fn().mockResolvedValue(json(200, { properties: { hashed_token: 'h2' } })));
    await expect(p.createRecoveryToken('a@b.co')).resolves.toBe('h2');
  });

  it('returns null when no user has that email', async () => {
    const p = new SupabaseIdentityProvider('https://proj.supabase.co', 'k', vi.fn().mockResolvedValue(json(404, { msg: 'User not found' })));
    await expect(p.createRecoveryToken('nobody@b.co')).resolves.toBeNull();
  });

  it('throws on other failures so the caller can log them', async () => {
    const p = new SupabaseIdentityProvider('https://proj.supabase.co', 'k', vi.fn().mockResolvedValue(json(500, {})));
    await expect(p.createRecoveryToken('a@b.co')).rejects.toThrow('Could not create a reset link.');
  });
});
