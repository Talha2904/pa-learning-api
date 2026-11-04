/**
 * The authentication provider (Supabase Auth today; Microsoft SSO later).
 * Only account lifecycle lives here - sign-in happens in the browser.
 */
export interface IdentityProvider {
  /** Creates a confirmed email/password account. Throws ConflictError('EMAIL_TAKEN') if it exists. */
  createUser(input: { email: string; password: string; fullName: string }): Promise<{ authUserId: string }>;
  deleteUser(authUserId: string): Promise<void>;
  /**
   * Creates a one-time password-recovery token for an existing account WITHOUT sending
   * any email (we send our own). Returns the hashed token the browser redeems, or null
   * when no account has this email.
   */
  createRecoveryToken(email: string): Promise<string | null>;
}

/** Verified identity extracted from a bearer token. */
export interface AuthIdentity {
  authUserId: string;
  email: string | null;
}

export interface AuthTokenVerifier {
  /** Throws UnauthenticatedError when the token is missing, expired or forged. */
  verify(token: string): Promise<AuthIdentity>;
}
