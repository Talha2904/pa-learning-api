import { randomBytes } from 'node:crypto';
import type { Person } from '../../domain/entities/person.js';
import type { PersonRepository } from '../../domain/repositories/person-repository.js';
import { emailDomain, toEmail } from '../../domain/value-objects/email.js';
import { ConflictError } from '../../shared/errors/app-errors.js';
import type { Logger } from '../../shared/utils/logger.js';
import type { EmailSender } from '../ports/email-sender.js';
import type { IdentityProvider } from '../ports/identity-provider.js';
import { composeWelcomeEmail } from '../services/account-email.js';
import { RESET_LINK_PATH } from './password-reset.service.js';

export interface AccountInviteOptions {
  /** Frontend origin used in the emailed link, e.g. https://lumen.example. */
  appBaseUrl: string;
  /** Lower-case domains allowed to sign in; empty = any. */
  allowedEmailDomains: string[];
  /** How many invites to send at once from a bulk import. */
  concurrency?: number;
  /** Waits between welcome-email attempts; one retry per entry. Default: 30 s, then 2 min. */
  retryDelaysMs?: number[];
}

/**
 * Gives people added by the Learning Team / HR a sign-in: creates their Supabase account
 * (with a random password nobody knows) and emails them a one-time "set your password" link.
 *
 * Best effort: never throws, so adding a person always succeeds. Anyone whose invite
 * failed can use "Forgot password?" later (PasswordResetService falls back to this service
 * for people who still have no account).
 */
export class AccountInviteService {
  constructor(
    private readonly people: PersonRepository,
    private readonly identity: IdentityProvider,
    private readonly email: EmailSender,
    private readonly logger: Logger,
    private readonly options: AccountInviteOptions,
  ) {}

  /** Creates the account and sends the welcome email. Returns true when it was sent (tests / logs only). */
  async invite(personId: string): Promise<boolean> {
    const person = await this.provision(personId);
    return person ? this.sendWelcome(person) : false;
  }

  /**
   * For a single add: waits only for the account (a quick call with its own timeout),
   * then sends the email in the background so a slow mail server can't hold up the request.
   */
  async inviteWithoutWaitingForEmail(personId: string): Promise<void> {
    const person = await this.provision(personId);
    if (person) void this.sendWelcome(person);
  }

  /** Invites many people without holding up the request (bulk import). */
  inviteInBackground(personIds: string[]): Promise<void> {
    const queue = [...personIds];
    const worker = async () => {
      for (let id = queue.shift(); id; id = queue.shift()) await this.invite(id);
    };
    return Promise.all(Array.from({ length: Math.min(this.options.concurrency ?? 3, queue.length) }, worker)).then(
      () => undefined,
    );
  }

  /** Ensures an eligible person has an account; returns them, or null when they shouldn't be invited or it failed. */
  private async provision(personId: string): Promise<Person | null> {
    try {
      const person = await this.people.findById(personId);
      if (!person || person.status !== 'active') return null;
      const allowed = this.options.allowedEmailDomains;
      if (allowed.length > 0 && !allowed.includes(emailDomain(toEmail(person.email)))) return null;
      if (person.authUserId) return person;

      try {
        const { authUserId } = await this.identity.createUser({
          email: toEmail(person.email),
          password: randomBytes(32).toString('base64url'),
          fullName: person.fullName,
        });
        return await this.people.update(person.id, { authUserId });
      } catch (err) {
        // An account already exists for this email: it is linked to the profile on first sign-in,
        // so the set-password link still works. Anything else is a real failure.
        if (err instanceof ConflictError && err.code === 'EMAIL_TAKEN') return person;
        throw err;
      }
    } catch (err) {
      this.logger.error('account invite failed: could not create the account', { profileId: personId, err });
      return null;
    }
  }

  /** Sends the welcome email, retrying after a delay if the link or the mail server fails. */
  private async sendWelcome(person: Person): Promise<boolean> {
    const delays = this.options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
    const attempts = delays.length + 1;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const email = toEmail(person.email);
        // A fresh link each attempt, so the one that finally arrives is valid.
        const token = await this.identity.createRecoveryToken(email);
        if (!token) throw new Error('no account to create a set-password link for');
        const base = this.options.appBaseUrl.replace(/\/$/, '');
        await this.email.send(
          composeWelcomeEmail({
            to: email,
            firstName: person.fullName.split(/\s+/)[0] ?? person.fullName,
            setPasswordUrl: `${base}${RESET_LINK_PATH}?token_hash=${encodeURIComponent(token)}&type=recovery`,
            signInUrl: `${base}/`,
          }),
        );
        this.logger.info('welcome email sent', { profileId: person.id, attempt });
        return true;
      } catch (err) {
        if (attempt === attempts) {
          this.logger.error('account invite failed: could not send the welcome email', { profileId: person.id, attempts, err });
          return false;
        }
        this.logger.warn('welcome email failed, retrying', { profileId: person.id, attempt, err });
        await sleep(delays[attempt - 1]!);
      }
    }
    return false;
  }
}

/** Waits before the 2nd and 3rd attempts: 30 seconds, then 2 minutes. */
const DEFAULT_RETRY_DELAYS_MS = [30_000, 120_000];

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
