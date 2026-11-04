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
