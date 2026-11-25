import { describe, expect, it } from 'vitest';
import type { EmailMessage } from '../../src/application/ports/email-sender.js';
import { AccountInviteService } from '../../src/application/use-cases/account-invite.service.js';
import type { Person } from '../../src/domain/entities/person.js';
import type { PersonRepository } from '../../src/domain/repositories/person-repository.js';
import { silentLogger } from '../../src/shared/utils/logger.js';
import { FakeIdentityProvider } from '../support/fakes.js';

const person = { id: 'p1', fullName: 'Nina New', email: 'nnew@pa.co.uk', status: 'active', authUserId: null } as unknown as Person;

function setup(failuresBeforeSuccess: number, retryDelaysMs = [0, 0]) {
  const stored: Person = { ...person };
  const people = {
    findById: async () => stored,
    update: async (_id: string, changes: Partial<Person>) => Object.assign(stored, changes),
  } as unknown as PersonRepository;
  const identity = new FakeIdentityProvider();
  let attempts = 0;
  const sent: EmailMessage[] = [];
  const email = {
    send: async (m: EmailMessage) => {
      attempts++;
      if (attempts <= failuresBeforeSuccess) throw new Error('smtp timeout');
      sent.push(m);
    },
  };
  const service = new AccountInviteService(people, identity, email, silentLogger, {
    appBaseUrl: 'https://lumen.test',
    allowedEmailDomains: [],
    retryDelaysMs,
  });
  return { service, identity, sent, stored, attempts: () => attempts };
}

describe('AccountInviteService', () => {
  it('creates the account and emails a set-password link', async () => {
    const s = setup(0);
    expect(await s.service.invite('p1')).toBe(true);
    expect(s.stored.authUserId).not.toBeNull();
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0]!.text).toContain(`https://lumen.test/?token_hash=${encodeURIComponent(s.identity.recoveryTokens.at(-1)!.token)}`);
  });

  it('retries a failed email, with a fresh link each time', async () => {
    const s = setup(2);
    expect(await s.service.invite('p1')).toBe(true);
    expect(s.attempts()).toBe(3);
    expect(s.sent).toHaveLength(1);
    expect(s.identity.recoveryTokens).toHaveLength(3);
    expect(s.sent[0]!.text).toContain(encodeURIComponent(s.identity.recoveryTokens.at(-1)!.token));
  });

  it('gives up after the last retry without throwing, keeping the account', async () => {
    const s = setup(5);
    expect(await s.service.invite('p1')).toBe(false);
    expect(s.attempts()).toBe(3);
    expect(s.stored.authUserId).not.toBeNull(); // they can still use "Forgot password?"
  });
});
