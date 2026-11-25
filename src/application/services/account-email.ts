import type { EmailMessage } from '../ports/email-sender.js';

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export interface PasswordResetEmailInput {
  to: string;
  firstName: string;
  /** One-time link into Lumen's "Set a new password" screen. */
  resetUrl: string;
}

/** "Reset your Lumen password" (plain text + simple, escaped HTML). Pure function. */
export function composePasswordResetEmail(input: PasswordResetEmailInput): EmailMessage {
  const subject = 'Reset your Lumen password';
  const text = [
    `Hi ${input.firstName},`,
    '',
    'We received a request to reset the password for your Lumen account.',
    'Open this link to choose a new password:',
    '',
    input.resetUrl,
    '',
    'The link works once and expires after a short time.',
    "If you didn't ask for this, you can ignore this email - your password won't change.",
    '',
    'Lumen by Project Accountants',
  ].join('\n');

  const html = `<!doctype html><html><body style="font-family:Poppins,Arial,sans-serif;color:#01122e;font-size:14px;line-height:1.6">
<p>Hi ${escapeHtml(input.firstName)},</p>
<p>We received a request to reset the password for your <b>Lumen</b> account. Use the button below to choose a new password.</p>
<p style="margin:24px 0"><a href="${escapeHtml(input.resetUrl)}" style="background:#0d1a33;color:#fff;padding:12px 20px;text-decoration:none;font-weight:600;border-radius:8px">RESET MY PASSWORD</a></p>
<p style="color:#5b6b82;font-size:12px">The link works once and expires after a short time. If the button doesn't work, copy this address into your browser:<br><span style="word-break:break-all">${escapeHtml(input.resetUrl)}</span></p>
<p style="color:#5b6b82;font-size:12px">If you didn't ask for this, you can ignore this email - your password won't change.</p>
<p style="color:#5b6b82;font-size:12px">Lumen by Project Accountants</p>
</body></html>`;

  return { to: input.to, cc: [], subject, text, html };
}

export interface WelcomeEmailInput {
  to: string;
  firstName: string;
  /** One-time link into Lumen's "Set a new password" screen. */
  setPasswordUrl: string;
  /** Site root, for signing in later or asking for a new link. */
  signInUrl: string;
}

/** "Your Lumen account is ready" with a set-password link (plain text + escaped HTML). Pure function. */
export function composeWelcomeEmail(input: WelcomeEmailInput): EmailMessage {
  const subject = 'Your Lumen account is ready';
  const text = [
    `Hi ${input.firstName},`,
    '',
    'You have been added to Lumen, the Project Accountants learning and CPD platform.',
    'Open this link to set your password:',
    '',
    input.setPasswordUrl,
    '',
    `The link works once and expires after a short time. If it has expired, go to ${input.signInUrl}, choose "Forgot password?" and enter this email address to get a new one.`,
    '',
    'Lumen by Project Accountants',
  ].join('\n');

  const html = `<!doctype html><html><body style="font-family:Poppins,Arial,sans-serif;color:#01122e;font-size:14px;line-height:1.6">
<p>Hi ${escapeHtml(input.firstName)},</p>
<p>You have been added to <b>Lumen</b>, the Project Accountants learning and CPD platform. Use the button below to set your password.</p>
<p style="margin:24px 0"><a href="${escapeHtml(input.setPasswordUrl)}" style="background:#0d1a33;color:#fff;padding:12px 20px;text-decoration:none;font-weight:600;border-radius:8px">SET MY PASSWORD</a></p>
<p style="color:#5b6b82;font-size:12px">The link works once and expires after a short time. If the button doesn't work, copy this address into your browser:<br><span style="word-break:break-all">${escapeHtml(input.setPasswordUrl)}</span></p>
<p style="color:#5b6b82;font-size:12px">If the link has expired, go to <a href="${escapeHtml(input.signInUrl)}">${escapeHtml(input.signInUrl)}</a>, choose "Forgot password?" and enter this email address to get a new one.</p>
<p style="color:#5b6b82;font-size:12px">Lumen by Project Accountants</p>
</body></html>`;

  return { to: input.to, cc: [], subject, text, html };
}
