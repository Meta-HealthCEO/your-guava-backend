const { Resend } = require('resend');

let client = null;

const appUrl = () => (process.env.CLIENT_URL || 'http://localhost:5173').replace(/\/$/, '');

const isConfigured = () => Boolean(process.env.RESEND_API_KEY && process.env.RESEND_FROM_EMAIL);

const getClient = () => {
  if (!isConfigured()) return null;
  if (!client) client = new Resend(process.env.RESEND_API_KEY);
  return client;
};

const escapeHtml = (value = '') =>
  String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const plainLines = (lines) => lines.filter(Boolean).join('\n');

const baseHtml = ({ title, intro, children, ctaLabel, ctaUrl }) => `
<!doctype html>
<html>
  <body style="margin:0;background:#0f0f0f;font-family:Arial,sans-serif;color:#f0f0f0;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#0f0f0f;padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;background:#1a1a1a;border:1px solid #2a2a2a;border-radius:12px;overflow:hidden;">
            <tr>
              <td style="padding:24px 24px 10px;">
                <p style="margin:0 0 12px;font-size:13px;font-weight:700;">
                  <span style="color:#6b8e3a;">Your</span> <span style="color:#d43d3d;">Guava</span>
                </p>
                <h1 style="margin:0;color:#f0f0f0;font-size:24px;line-height:1.25;">${escapeHtml(title)}</h1>
                <p style="margin:12px 0 0;color:#b8b8b8;font-size:15px;line-height:1.6;">${escapeHtml(intro)}</p>
              </td>
            </tr>
            <tr>
              <td style="padding:12px 24px 24px;color:#d8d8d8;font-size:14px;line-height:1.6;">
                ${children}
                ${
                  ctaLabel && ctaUrl
                    ? `<p style="margin:24px 0 0;"><a href="${escapeHtml(ctaUrl)}" style="display:inline-block;background:#4da63b;color:#ffffff;text-decoration:none;padding:11px 16px;border-radius:8px;font-weight:700;">${escapeHtml(ctaLabel)}</a></p>`
                    : ''
                }
                <p style="margin:24px 0 0;color:#777777;font-size:12px;line-height:1.5;">
                  If you were not expecting this email, you can ignore it.
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

/**
 * Local-development transport.
 *
 * Without RESEND_API_KEY there is no way to complete a signup or accept a team
 * invite, because both depend on a token that only ever leaves the system by
 * email. That made the two flows every new customer touches first completely
 * untestable on a developer machine.
 *
 * When email is unconfigured outside production, the message is written to the
 * server log with its action link extracted, and reported as delivered so the
 * calling flow proceeds exactly as it would in production. The token is still
 * a real single-use token and still has to be redeemed through the normal
 * endpoint -- nothing about the verification contract is bypassed.
 *
 * Hard-guarded: in production an unconfigured mailer still refuses, as before.
 * Set EMAIL_DEV_CONSOLE=false to opt out locally.
 */
const deliverToConsole = ({ to, subject, text, html }) => {
  const body = text || String(html || '').replace(/<[^>]+>/g, ' ');
  const link = (body.match(/https?:\/\/\S+/) || [])[0];
  console.warn(
    [
      '',
      '  ┌─ email not configured — delivering to console (development only) ─',
      `  │ to:      ${Array.isArray(to) ? to.join(', ') : to}`,
      `  │ subject: ${subject}`,
      link ? `  │ link:    ${link}` : '  │ (no action link found in this message)',
      '  └───────────────────────────────────────────────────────────────────',
      '',
    ].join('\n')
  );
  return { sent: true, transport: 'console' };
};

const canUseConsoleTransport = () =>
  process.env.NODE_ENV !== 'production' &&
  String(process.env.EMAIL_DEV_CONSOLE || 'true').toLowerCase() !== 'false';

const sendEmail = async ({ to, subject, html, text, tags }) => {
  const resend = getClient();
  if (!resend) {
    if (canUseConsoleTransport()) return deliverToConsole({ to, subject, text, html });
    return { skipped: true, reason: 'resend_not_configured' };
  }

  try {
    const payload = {
      from: process.env.RESEND_FROM_EMAIL,
      to: Array.isArray(to) ? to : [to],
      subject,
      html,
      text,
      ...(process.env.RESEND_REPLY_TO ? { replyTo: process.env.RESEND_REPLY_TO } : {}),
      ...(tags ? { tags } : {}),
    };
    const { data, error } = await resend.emails.send(payload);
    if (error) {
      console.error('[email] Resend send failed:', error);
      return { sent: false, error };
    }
    return { sent: true, data };
  } catch (error) {
    console.error('[email] Resend send failed:', error.message);
    return { sent: false, error };
  }
};

const sendWelcomeEmail = async ({ user, org, cafe }) => {
  const loginUrl = `${appUrl()}/login`;
  const orgName = org?.name || 'your organisation';
  const cafeName = cafe?.name || 'your first cafe';

  const html = baseHtml({
    title: 'Welcome to Your Guava',
    intro: `Hi ${user.name}, your workspace is ready.`,
    ctaLabel: 'Open Your Guava',
    ctaUrl: loginUrl,
    children: `
      <p style="margin:0 0 14px;">You created <strong>${escapeHtml(orgName)}</strong> with <strong>${escapeHtml(cafeName)}</strong> as the first cafe location.</p>
      <p style="margin:0 0 14px;">Next, upload your sales data from the Connect Data page so Your Guava can start building forecasts and insights for your cafe.</p>
      <p style="margin:0;">Sign in any time with <strong>${escapeHtml(user.email)}</strong>.</p>
    `,
  });

  const text = plainLines([
    `Hi ${user.name}, welcome to Your Guava.`,
    `Your workspace "${orgName}" is ready with "${cafeName}" as the first cafe location.`,
    'Next, upload your sales data from the Connect Data page so forecasts and insights can start working.',
    `Sign in: ${loginUrl}`,
  ]);

  return sendEmail({
    to: user.email,
    subject: 'Welcome to Your Guava',
    html,
    text,
    tags: [{ name: 'email_type', value: 'welcome' }],
  });
};

const sendVerificationEmail = async ({ registration, verificationToken }) => {
  if (!verificationToken) throw new Error('Verification token is required');
  const verificationUrl = `${appUrl()}/verify-email#token=${encodeURIComponent(verificationToken)}`;
  const html = baseHtml({
    title: 'Verify your email address',
    intro: `Hi ${registration.name}, confirm this email to finish creating your Your Guava workspace.`,
    ctaLabel: 'Verify email',
    ctaUrl: verificationUrl,
    children: `
      <p style="margin:0 0 14px;">Your workspace is not active yet. Verification prevents another person from registering with your email address.</p>
      <p style="margin:0;color:#b8b8b8;">This single-use link expires in 24 hours.</p>
    `,
  });
  const text = plainLines([
    `Hi ${registration.name},`,
    'Verify your email to finish creating your Your Guava workspace.',
    `Verify email: ${verificationUrl}`,
    'This single-use link expires in 24 hours.',
  ]);
  return sendEmail({
    to: registration.email,
    subject: 'Verify your Your Guava email',
    html,
    text,
    tags: [{ name: 'email_type', value: 'email_verification' }],
  });
};

const sendPasswordResetEmail = async ({ user, resetToken, expiresAt }) => {
  if (!resetToken) throw new Error('Password reset token is required');
  const resetUrl = `${appUrl()}/reset-password#token=${encodeURIComponent(resetToken)}`;
  const expiry = new Date(expiresAt).toLocaleString('en-ZA', {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
  const html = baseHtml({
    title: 'Reset your password',
    intro: `Hi ${user.name}, use this secure link to choose a new password.`,
    ctaLabel: 'Reset password',
    ctaUrl: resetUrl,
    children: `
      <p style="margin:0 0 14px;">This link expires at ${escapeHtml(expiry)} and works once.</p>
      <p style="margin:0;color:#b8b8b8;">If you did not request a reset, your password has not changed.</p>
    `,
  });
  const text = plainLines([
    `Hi ${user.name},`,
    `Reset your password: ${resetUrl}`,
    `This single-use link expires at ${expiry}.`,
    'If you did not request this, your password has not changed.',
  ]);
  return sendEmail({
    to: user.email,
    subject: 'Reset your Your Guava password',
    html,
    text,
    tags: [{ name: 'email_type', value: 'password_reset' }],
  });
};

const sendTeamInviteEmail = async ({ invitation, owner, cafes = [], invitationToken }) => {
  if (!invitationToken) throw new Error('Invitation token is required');
  const invitationUrl = `${appUrl()}/accept-invite#token=${encodeURIComponent(invitationToken)}`;
  const cafeNames = cafes.map((cafe) => cafe.name).filter(Boolean);
  const cafeList = cafeNames.length > 0 ? cafeNames.join(', ') : 'assigned cafe locations';
  const expiresAt = new Date(invitation.expiresAt).toLocaleString('en-ZA', {
    dateStyle: 'medium',
    timeStyle: 'short',
  });

  const html = baseHtml({
    title: 'You have been invited to Your Guava',
    intro: `${owner.name} invited you to join as a manager.`,
    ctaLabel: 'Accept invitation',
    ctaUrl: invitationUrl,
    children: `
      <p style="margin:0 0 14px;">You can now access <strong>${escapeHtml(cafeList)}</strong> in Your Guava.</p>
      <table role="presentation" cellspacing="0" cellpadding="0" style="margin:18px 0;width:100%;background:#111111;border:1px solid #2a2a2a;border-radius:8px;">
        <tr><td style="padding:14px;color:#888888;font-size:12px;">Email</td><td style="padding:14px;color:#f0f0f0;font-size:14px;">${escapeHtml(invitation.email)}</td></tr>
        <tr><td style="padding:14px;color:#888888;font-size:12px;border-top:1px solid #2a2a2a;">Expires</td><td style="padding:14px;color:#f0f0f0;font-size:14px;border-top:1px solid #2a2a2a;">${escapeHtml(expiresAt)}</td></tr>
      </table>
      <p style="margin:0;color:#b8b8b8;">Use the button above to choose your password. The link works once and expires automatically.</p>
    `,
  });

  const text = plainLines([
    `Hi ${invitation.name},`,
    `${owner.name} invited you to join Your Guava as a manager.`,
    `Cafe access: ${cafeList}`,
    `Email: ${invitation.email}`,
    `Invitation expires: ${expiresAt}`,
    `Accept invitation: ${invitationUrl}`,
    'Choose your password when you accept. The link works once.',
  ]);

  return sendEmail({
    to: invitation.email,
    subject: 'You have been invited to Your Guava',
    html,
    text,
    tags: [{ name: 'email_type', value: 'team_invite' }],
  });
};

const _resetClient = () => {
  client = null;
};

module.exports = {
  sendWelcomeEmail,
  sendVerificationEmail,
  sendPasswordResetEmail,
  sendTeamInviteEmail,
  sendEmail,
  isConfigured,
  _resetClient,
};
