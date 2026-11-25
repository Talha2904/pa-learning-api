import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { composePasswordResetEmail, composeWelcomeEmail } from '../../src/application/services/account-email.js';
import { createTestApp, type TestApp } from '../support/test-app.js';

let t: TestApp;

const ask = (email: string) => request(t.app).post('/api/v1/auth/password-reset').send({ email });
const register = (fullName: string, email: string) =>
  request(t.app).post('/api/v1/auth/register').send({ fullName, email, password: 'long-enough-pass' });
/** The endpoint answers before sending; give the background work a moment. */
const settle = () => new Promise((r) => setTimeout(r, 50));

beforeAll(async () => {
  t = await createTestApp();
  expect((await register('Grace Lin', 'glin@pa.co.uk')).status).toBe(201);
  expect((await register('Tom Gone', 'tgone@pa.co.uk')).status).toBe(201);
  await t.db.query(`update profiles set status = 'inactive' where email = 'tgone@pa.co.uk'`);
});

afterAll(async () => {
  await t.close();
});

beforeEach(() => {
  t.email.sent.length = 0;
});

describe('POST /auth/password-reset', () => {
  it('emails a one-time link into Lumen, sent through our own mail sender', async () => {
    const res = await ask('  GLIN@pa.co.uk ');
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ success: true, data: { requested: true } });

    await vi.waitFor(() => expect(t.email.sent).toHaveLength(1));
    const mail = t.email.sent[0]!;
    expect(mail.to).toBe('glin@pa.co.uk');
    expect(mail.subject).toBe('Reset your Lumen password');
    const token = t.identity.recoveryTokens.at(-1)!.token;
    const link = `http://localhost:5173/?token_hash=${encodeURIComponent(token)}&type=recovery`;
    expect(mail.text).toContain(link);
    expect(mail.html).toContain('RESET MY PASSWORD');
    expect(mail.text).toContain('Hi Grace,');
  });

  it('answers identically for unknown and deactivated addresses, and sends nothing', async () => {
    const unknown = await ask('nobody@pa.co.uk');
    const inactive = await ask('tgone@pa.co.uk');
    for (const res of [unknown, inactive]) {
      expect(res.status).toBe(202);
      expect(res.body).toEqual({ success: true, data: { requested: true } });
    }
    await settle();
    expect(t.email.sent).toHaveLength(0);
  });

  it('sends at most one email per address per minute', async () => {
    t.clock.todayValue = '2026-09-11';
    await ask('glin@pa.co.uk');
    await ask('glin@pa.co.uk');
    await settle();
    expect(t.email.sent).toHaveLength(1);
  });

  it('gives an active person with no account one, plus a set-password link', async () => {
    await t.db.query(`insert into profiles (full_name, email, role) values ('Noah Nolink', 'nnolink@pa.co.uk', 'team_member')`);
    expect((await ask('nnolink@pa.co.uk')).status).toBe(202);
    await vi.waitFor(() => expect(t.email.sent).toHaveLength(1));
    expect(t.email.sent[0]).toMatchObject({ to: 'nnolink@pa.co.uk', subject: 'Your Lumen account is ready' });
    const linked = await t.db.query<{ auth_user_id: string | null }>(`select auth_user_id from profiles where email = 'nnolink@pa.co.uk'`);
    expect(linked.rows[0]!.auth_user_id).not.toBeNull();
  });

  it('rejects a malformed email with a field error', async () => {
    const res = await ask('not-an-email');
    expect(res.status).toBe(400);
    expect(res.body.details[0].path).toBe('email');
  });

  it('works without signing in', async () => {
    t.clock.todayValue = '2026-09-12';
    expect((await request(t.app).post('/api/v1/auth/password-reset').send({ email: 'glin@pa.co.uk' })).status).toBe(202);
  });
});

describe('composeWelcomeEmail', () => {
  it('escapes names and links in the HTML and says how to get a new link', () => {
    const m = composeWelcomeEmail({
      to: 'a@b.co',
      firstName: '<b>Al</b>',
      setPasswordUrl: 'https://x.test/r?a=1&b="2"',
      signInUrl: 'https://x.test/',
    });
    expect(m.subject).toBe('Your Lumen account is ready');
    expect(m.html).toContain('&lt;b&gt;Al&lt;/b&gt;');
    expect(m.html).toContain('https://x.test/r?a=1&amp;b=&quot;2&quot;');
    expect(m.html).not.toContain('<b>Al</b>');
    expect(m.text).toContain('Forgot password?');
  });
});

describe('composePasswordResetEmail', () => {
  it('escapes names and links in the HTML', () => {
    const m = composePasswordResetEmail({ to: 'a@b.co', firstName: '<b>Al</b>', resetUrl: 'https://x.test/r?a=1&b="2"' });
    expect(m.html).toContain('&lt;b&gt;Al&lt;/b&gt;');
    expect(m.html).toContain('https://x.test/r?a=1&amp;b=&quot;2&quot;');
    expect(m.html).not.toContain('<b>Al</b>');
  });
});
