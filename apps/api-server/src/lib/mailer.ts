import { Resend } from 'resend';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { env } from './env';
import { logger } from './logger';
import type { SessionMeta } from '../auth/auth.tokens';

// Single client for the process lifetime — same reasoning as prisma.ts's
// single PrismaClient: cheap to reuse, no reason to construct per-request.
const resend = new Resend(env.RESEND_API_KEY);

// Email templates live as static HTML files in assets/ (same directory the
// Dockerfile copies wholesale), rendered at send time by simple {{PLACEHOLDER}}
// substitution. Keeping them out of code makes copy/design edits possible
// without a redeploy touching logic.
const ASSETS_DIR = fileURLToPath(new URL('../../assets', import.meta.url));
const templateCache = new Map<string, string>();

function loadTemplate(name: string): string {
  let html = templateCache.get(name);
  if (!html) {
    html = readFileSync(`${ASSETS_DIR}/${name}.html`, 'utf8');
    templateCache.set(name, html);
  }
  return html;
}

type TemplateVars = Record<string, string>;

function render(name: string, vars: TemplateVars): string {
  return loadTemplate(name).replace(/\{\{(\w+)\}\}/g, (match, key) => vars[key] ?? match);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatTimestamp(date: Date): string {
  return date.toUTCString().replace('GMT', 'UTC');
}

// Cheap, dependency-free user-agent sniffing for the security emails' "Device"
// row. Good enough to tell "Chrome on Windows" from "Safari on macOS" — the
// purpose is to let a user recognize their own login, not to enumerate every
// obscure browser in existence.
function describeDevice(userAgent?: string): string {
  if (!userAgent) return 'Unknown device';

  const ua = userAgent;
  let browser = 'Browser';
  if (/edg/i.test(ua)) browser = 'Microsoft Edge';
  else if (/opr|opera/i.test(ua)) browser = 'Opera';
  else if (/firefox/i.test(ua)) browser = 'Firefox';
  else if (/chrome|crios/i.test(ua)) browser = 'Chrome';
  else if (/safari/i.test(ua)) browser = 'Safari';
  else if (/msie|trident/i.test(ua)) browser = 'Internet Explorer';

  let os = 'Unknown OS';
  if (/windows nt/i.test(ua)) os = 'Windows';
  else if (/android/i.test(ua)) os = 'Android';
  else if (/iphone|ipad|ipod/i.test(ua)) os = 'iOS';
  else if (/mac os x|macintosh/i.test(ua)) os = 'macOS';
  else if (/linux/i.test(ua)) os = 'Linux';

  return `${browser} on ${os}`;
}

// Security emails (password changed / new sign-in) share the same three
// contextual rows, so build them once here.
function securityContextVars(meta: SessionMeta): TemplateVars {
  return {
    IP_ADDRESS: escapeHtml(meta.ipAddress || 'Unknown'),
    DEVICE_INFO: escapeHtml(describeDevice(meta.userAgent)),
  };
}

async function sendMail(to: string, subject: string, html: string): Promise<void> {
  const { error } = await resend.emails.send({
    from: env.EMAIL_FROM,
    to,
    subject,
    html,
  });

  if (error) {
    // Don't leak provider errors to the client — a failed send shouldn't
    // block register()/forgotPassword() from returning its generic success
    // response (see auth.service.ts), but it must be loud in the logs since
    // silently dropping a verification email is a real support headache.
    logger.error('Failed to send email', { to, subject, err: error });
    throw new Error('Failed to send email');
  }
}

function baseVars(): TemplateVars {
  return { APP_URL: escapeHtml(env.FRONTEND_URL) };
}

export async function sendVerificationEmail(to: string, verifyUrl: string): Promise<void> {
  await sendMail(
    to,
    'Verify your email — Dreamer',
    render('verify-email', {
      ...baseVars(),
      ACTION_URL: verifyUrl,
    })
  );
}

export async function sendPasswordResetEmail(to: string, resetUrl: string): Promise<void> {
  await sendMail(
    to,
    'Reset your password — Dreamer',
    render('password-reset', {
      ...baseVars(),
      ACTION_URL: resetUrl,
    })
  );
}

export async function sendPasswordChangedEmail(to: string, meta: SessionMeta): Promise<void> {
  const changedAt = new Date();
  await sendMail(
    to,
    'Your password was changed — Dreamer',
    render('password-changed', {
      ...baseVars(),
      CHANGED_AT: escapeHtml(formatTimestamp(changedAt)),
      SECURE_URL: `${env.FRONTEND_URL}/forgot-password`,
      ...securityContextVars(meta),
    })
  );
}

export async function sendPasswordResetConfirmationEmail(to: string, meta: SessionMeta): Promise<void> {
  await sendMail(
    to,
    'Your password was reset — Dreamer',
    render('password-reset-confirmation', {
      ...baseVars(),
      SECURE_URL: `${env.FRONTEND_URL}/forgot-password`,
    })
  );
}

export async function sendNewSignInEmail(to: string, meta: SessionMeta): Promise<void> {
  const signedInAt = new Date();
  await sendMail(
    to,
    'New sign-in detected — Dreamer',
    render('new-sign-in', {
      ...baseVars(),
      SIGNED_IN_AT: escapeHtml(formatTimestamp(signedInAt)),
      SECURE_URL: `${env.FRONTEND_URL}/forgot-password`,
      ...securityContextVars(meta),
    })
  );
}
