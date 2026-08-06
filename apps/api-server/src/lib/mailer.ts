import { Resend } from 'resend';
import { env } from './env';
import { logger } from './logger';

// Single client for the process lifetime — same reasoning as prisma.ts's
// single PrismaClient: cheap to reuse, no reason to construct per-request.
const resend = new Resend(env.RESEND_API_KEY);

// I'm not fully certain "resend" package's exact current method signature —
// verify `resend.emails.send` against Resend's current docs when wiring
// this up for real; the shape below matches their SDK as of my training
// data, but their API has changed before.
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

export async function sendVerificationEmail(to: string, verifyUrl: string): Promise<void> {
  await sendMail(
    to,
    'Verify your email — Dreamer',
    `<p>Welcome to Dreamer! Click the link below to verify your email address:</p>
     <p><a href="${verifyUrl}">${verifyUrl}</a></p>
     <p>This link expires in 24 hours. If you didn't sign up for Dreamer, you can ignore this email.</p>`
  );
}

export async function sendPasswordResetEmail(to: string, resetUrl: string): Promise<void> {
  await sendMail(
    to,
    'Reset your password — Dreamer',
    `<p>We received a request to reset your Dreamer password. Click the link below to choose a new one:</p>
     <p><a href="${resetUrl}">${resetUrl}</a></p>
     <p>This link expires in 1 hour. If you didn't request this, you can safely ignore this email — your password will not be changed.</p>`
  );
}
