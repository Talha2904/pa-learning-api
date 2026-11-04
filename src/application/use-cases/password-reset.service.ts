import type { PersonRepository } from '../../domain/repositories/person-repository.js';
import { emailDomain, toEmail, type Email } from '../../domain/value-objects/email.js';
import type { Logger } from '../../shared/utils/logger.js';
import type { Clock } from '../ports/clock.js';
import type { EmailSender } from '../ports/email-sender.js';
import type { IdentityProvider } from '../ports/identity-provider.js';
import { composePasswordResetEmail } from '../services/account-email.js';

export interface PasswordResetOptions {
  /** Frontend origin used in the emailed link, e.g. https://lumen.example. */
  appBaseUrl: string;
  /** Lower-case domains allowed to sign in; empty = any. */
  allowedEmailDomains: string[];
  /** Minimum gap between reset emails to the same address (protects inboxes from spam). */
  cooldownMs?: number;
}

/**
 * The emailed link opens the site root: it is always served (no SPA fallback needed in nginx),
 * and the frontend reads `token_hash` / `type=recovery` from the query on any page.
 */
export const RESET_LINK_PATH = '/';

/**
 * "Forgot password?": emails a one-time reset link through the firm's own SMTP
 * (not Supabase's mailer), so no Supabase dashboard email/redirect settings are needed.
 *
 * Always behaves the same whether or not the address has an account, so the
 * endpoint can't be used to discover who has one. Only active people get an email.
 */
export class PasswordResetService {
  private readonly lastSent = new Map<Email, number>();
  private readonly cooldownMs: number;

  constructor(
    private readonly people: PersonRepository,
    private readonly identity: IdentityProvider,
    private readonly email: EmailSender,
    private readonly clock: Clock,
    private readonly logger: Logger,
    private readonly options: PasswordResetOptions,
  ) {
    this.cooldownMs = options.cooldownMs ?? 60_000;
  }

  /**
   * Sends the reset email if the address belongs to an active person with an account.
   * Never throws for "unknown" or "not allowed" addresses; delivery errors are logged.
   * Returns true when an email was sent (for tests / logs only - never shown to the caller).
   */
  async request(rawEmail: string): Promise<boolean> {
    let email: Email;
    try {
      email = toEmail(rawEmail);
    } catch {
      return false;
    }
    const allowed = this.options.allowedEmailDomains;
    if (allowed.length > 0 && !allowed.includes(emailDomain(email))) return false;

    const now = this.clock.now().getTime();
    // Forget expired cooldowns so the map can't grow without limit.
    for (const [key, at] of this.lastSent) if (now - at >= this.cooldownMs) this.lastSent.delete(key);
    const previous = this.lastSent.get(email);
    if (previous !== undefined && now - previous < this.cooldownMs) return false;

    try {
      const person = await this.people.findByEmail(email);
      if (!person || !person.authUserId || person.status !== 'active') return false;

      const token = await this.identity.createRecoveryToken(email);
      if (!token) return false;

      this.lastSent.set(email, now);
      const base = this.options.appBaseUrl.replace(/\/$/, '');
      const resetUrl = `${base}${RESET_LINK_PATH}?token_hash=${encodeURIComponent(token)}&type=recovery`;
      await this.email.send(
        composePasswordResetEmail({ to: email, firstName: person.fullName.split(/\s+/)[0] ?? person.fullName, resetUrl }),
      );
      this.logger.info('password reset email sent', { profileId: person.id });
      return true;
    } catch (err) {
      this.lastSent.delete(email);
      this.logger.error('password reset email failed', { err });
      return false;
    }
  }
}
