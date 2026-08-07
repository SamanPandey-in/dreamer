import { prisma } from '../lib/prisma';
import { encryptForStorage } from '../lib/crypto';
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError, UnauthorizedError } from '../lib/errors';
import {
  hashPassword,
  verifyPassword,
  signAccessToken,
  createSession,
  rotateSession,
  revokeSession,
  revokeAllSessions,
  listSessionsForUser,
  revokeSessionById,
  createVerificationToken,
  consumeVerificationToken,
  EMAIL_VERIFY_TTL_MS,
  PASSWORD_RESET_TTL_MS,
  type SessionMeta,
} from './auth.tokens';
import {
  sendVerificationEmail,
  sendPasswordResetEmail,
  sendPasswordChangedEmail,
  sendPasswordResetConfirmationEmail,
  sendNewSignInEmail,
} from '../lib/mailer';
import { env } from '../lib/env';
import type { GithubProfile } from './github.service';
import type {
  ChangePasswordInput,
  ForgotPasswordInput,
  LoginInput,
  PublicUser,
  RegisterInput,
  ResendVerificationInput,
  ResetPasswordInput,
  VerifyEmailInput,
} from './auth.types';
import type { Prisma, User } from '../generated/prisma/client';
import { VerificationTokenType } from '../generated/prisma/client';

// A real bcrypt hash of a string nobody will ever type as a password.
// Used so failed-login timing is identical whether the email exists or not —
// without this, an attacker can use response time alone to enumerate which
// emails are registered.
const DUMMY_PASSWORD_HASH = '$2b$12$ScfAwMBjElP/t9LDXIjNZuBTpu1OoHwB8Y5mIsjxquQk6t8xOd0da';

// The DUMMY_PASSWORD_HASH constant is worth understanding. 
// Without it, login() would only call bcrypt.compare when a user with that email exists — meaning a request 
// for a non-existent email returns faster than one for a real email with a wrong password. 
// That timing difference is a real, exploitable side-channel for enumerating which emails have accounts. 
// Running the same bcrypt comparison unconditionally (against a hash of a string that will never be a real password) 
// makes both cases take the same amount of time.

export function toPublicUser(user: User): PublicUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    avatarUrl: user.avatarUrl,
    githubUsername: user.githubUsername,
    emailVerified: user.emailVerified,
  };
}

async function audit(
  userId: string | null,
  action: string,
  meta: SessionMeta,
  metadata?: Prisma.InputJsonValue
) {
  await prisma.auditLog.create({
    data: { userId, action, ipAddress: meta.ipAddress, userAgent: meta.userAgent, metadata },
  });
}

// Email + password

// Builds the link embedded in verification/reset emails. Points at the
// FRONTEND (not the API) — the frontend page reads the token from the query
// string and POSTs it to the API itself, same convention as the existing
// GitHub OAuth /auth/callback page.
function buildFrontendUrl(path: string, token: string): string {
  return `${env.FRONTEND_URL}${path}?token=${encodeURIComponent(token)}`;
}

async function issueAndSendVerificationEmail(user: User): Promise<void> {
  const token = await createVerificationToken(user.id, VerificationTokenType.EMAIL_VERIFY, EMAIL_VERIFY_TTL_MS);
  await sendVerificationEmail(user.email, buildFrontendUrl('/verify-email', token));
}

// Notification emails (new sign-in / password changed / password reset
// confirmation) are informational — the user-facing action has already
// succeeded by the time they're sent. A failed send must never turn a
// successful login or password change into a 500, so these are best-effort:
// mailer.ts already logs the failure loudly, and we swallow it here.
async function sendSecurityNotification(send: Promise<void>): Promise<void> {
  try {
    await send;
  } catch {
    // logged inside mailer.ts — intentionally swallowed here
  }
}

// A "new sign-in" means a successful login from a device/location we haven't
// seen before. Compare the incoming request against the user's existing
// active sessions; a match on both IP and user-agent means we've seen this
// device before and there's no need to alarm them.
async function isUnrecognizedSignIn(userId: string, meta: SessionMeta): Promise<boolean> {
  const sessions = await listSessionsForUser(userId);
  return !sessions.some((s) => s.ipAddress === meta.ipAddress && s.userAgent === meta.userAgent);
}

export async function register(input: RegisterInput, meta: SessionMeta) {
  const existing = await prisma.user.findUnique({ where: { email: input.email } });

  if (existing?.passwordHash) {
    throw new ConflictError('An account with this email already exists', 'EMAIL_TAKEN');
  }

  const passwordHash = await hashPassword(input.password);

  // If a GitHub-only account already exists for this email, "upgrade" it by
  // attaching a password instead of creating a duplicate user row.
  const user = existing
    ? await prisma.user.update({ where: { id: existing.id }, data: { passwordHash } })
    : await prisma.user.create({ data: { email: input.email, passwordHash, name: input.name } });

  await audit(user.id, existing ? 'user.password_added' : 'user.register', meta);

  // No accessToken/session here anymore — email/password accounts must
  // verify before they can log in. A GitHub-linked account being upgraded
  // with a password may already be emailVerified (verified GitHub email) —
  // skip re-sending in that case.
  if (!user.emailVerified) {
    await issueAndSendVerificationEmail(user);
  }

  return { user: toPublicUser(user) };
}

export async function login(input: LoginInput, meta: SessionMeta) {
  const user = await prisma.user.findUnique({ where: { email: input.email } });

  // Always run a bcrypt comparison — even for a non-existent user or a
  // GitHub-only account with no passwordHash — so response timing can't be
  // used to enumerate registered emails by hackers. See DUMMY_PASSWORD_HASH above for details.
  const isValid = await verifyPassword(input.password, user?.passwordHash ?? DUMMY_PASSWORD_HASH);

  if (!user || !user.passwordHash || !isValid) {
    await audit(user?.id ?? null, 'user.login_failed', meta, { email: input.email });
    throw new UnauthorizedError('Invalid email or password', 'INVALID_CREDENTIALS');
  }

  if (!user.isActive) {
    throw new ForbiddenError('This account has been suspended', 'ACCOUNT_SUSPENDED');
  }

  // Gate only applies to email/password accounts (passwordHash != null,
  // already established above). GitHub-only accounts never hit this branch.
  if (!user.emailVerified) {
    throw new ForbiddenError('Please verify your email before signing in', 'EMAIL_NOT_VERIFIED');
  }

  const isNewSignIn = await isUnrecognizedSignIn(user.id, meta);
  const accessToken = signAccessToken(user.id, user.email);
  const { rawToken: refreshToken } = await createSession(user.id, meta);

  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
  await audit(user.id, 'user.login', meta);

  if (isNewSignIn) {
    await sendSecurityNotification(sendNewSignInEmail(user.email, meta));
  }

  return { accessToken, refreshToken, user: toPublicUser(user) };
}

export async function verifyEmail(input: VerifyEmailInput, meta: SessionMeta): Promise<void> {
  const userId = await consumeVerificationToken(input.token, VerificationTokenType.EMAIL_VERIFY);
  if (!userId) throw new BadRequestError('This verification link is invalid or has expired', 'INVALID_TOKEN');

  await prisma.user.update({ where: { id: userId }, data: { emailVerified: true } });
  await audit(userId, 'user.email_verified', meta);
}

export async function resendVerification(input: ResendVerificationInput, meta: SessionMeta): Promise<void> {
  const user = await prisma.user.findUnique({ where: { email: input.email } });

  // Same enumeration-avoidance principle as login()'s DUMMY_PASSWORD_HASH:
  // this function returns void either way — the controller always sends an
  // identical generic response, so a caller can't tell whether the email
  // exists, already has a password, or is already verified.
  if (user?.passwordHash && !user.emailVerified) {
    await issueAndSendVerificationEmail(user);
    await audit(user.id, 'user.verification_resent', meta);
  }
}

export async function requestPasswordReset(input: ForgotPasswordInput, meta: SessionMeta): Promise<void> {
  const user = await prisma.user.findUnique({ where: { email: input.email } });

  // Same enumeration-avoidance principle — void return, generic response
  // regardless of whether the account exists or has a password set.
  if (user?.passwordHash) {
    const token = await createVerificationToken(user.id, VerificationTokenType.PASSWORD_RESET, PASSWORD_RESET_TTL_MS);
    await sendPasswordResetEmail(user.email, buildFrontendUrl('/reset-password', token));
    await audit(user.id, 'user.password_reset_requested', meta);
  }
}

export async function resetPassword(input: ResetPasswordInput, meta: SessionMeta): Promise<void> {
  const userId = await consumeVerificationToken(input.token, VerificationTokenType.PASSWORD_RESET);
  if (!userId) throw new BadRequestError('This reset link is invalid or has expired', 'INVALID_TOKEN');

  const passwordHash = await hashPassword(input.newPassword);
  await prisma.user.update({ where: { id: userId }, data: { passwordHash } });

  // A password reset (unlike changePassword() below, which trusts the
  // caller already proved they know the current password) happened because
  // someone couldn't log in — sign out every existing session as a
  // precaution in case the account was compromised.
  await revokeAllSessions(userId);
  await audit(userId, 'user.password_reset', meta);

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (user) {
    await sendSecurityNotification(sendPasswordResetConfirmationEmail(user.email, meta));
  }
}

// Session lifecycle

export async function refresh(rawRefreshToken: string, meta: SessionMeta) {
  const result = await rotateSession(rawRefreshToken, meta);
  if (!result) throw new UnauthorizedError('Invalid or expired session', 'SESSION_INVALID');

  return {
    accessToken: result.accessToken,
    refreshToken: result.refreshToken,
    user: toPublicUser(result.user),
  };
}

export async function logout(rawRefreshToken: string | undefined): Promise<void> {
  if (rawRefreshToken) await revokeSession(rawRefreshToken);
}

export async function logoutAll(userId: string, meta: SessionMeta): Promise<void> {
  await revokeAllSessions(userId);
  await audit(userId, 'user.logout_all', meta);
}

export async function getMe(userId: string): Promise<PublicUser> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new UnauthorizedError('User no longer exists', 'USER_NOT_FOUND');
  return toPublicUser(user);
}

// Sessions & password management

export async function listSessions(userId: string, currentSessionId?: string) {
  const sessions = await listSessionsForUser(userId);
  return sessions.map((s) => ({
    ...s,
    isCurrent: currentSessionId ? s.id === currentSessionId : false,
  }));
}

export async function revokeSessionByIdForUser(userId: string, sessionId: string, meta: SessionMeta) {
  const deleted = await revokeSessionById(userId, sessionId);
  if (!deleted) throw new NotFoundError('Session not found', 'SESSION_NOT_FOUND');
  await audit(userId, 'user.session_revoked', meta, { sessionId });
}

export async function changePassword(userId: string, input: ChangePasswordInput, meta: SessionMeta) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new UnauthorizedError('User no longer exists', 'USER_NOT_FOUND');

  // If user has an existing password, the current password must be provided and correct
  if (user.passwordHash) {
    if (!input.currentPassword) {
      throw new BadRequestError('Current password is required', 'CURRENT_PASSWORD_REQUIRED');
    }
    const isValid = await verifyPassword(input.currentPassword, user.passwordHash);
    if (!isValid) {
      throw new UnauthorizedError('Current password is incorrect', 'INVALID_PASSWORD');
    }
  }

  const passwordHash = await hashPassword(input.newPassword);
  await prisma.user.update({ where: { id: userId }, data: { passwordHash } });
  await audit(userId, 'user.password_changed', meta);

  await sendSecurityNotification(sendPasswordChangedEmail(user.email, meta));
}

// GitHub OAuth

interface GithubLoginParams {
  profile: GithubProfile;
  verifiedEmail: string | null;
  githubAccessToken: string;
  meta: SessionMeta;
}

/**
 * Find-or-create-or-link logic for "Continue with GitHub":
 *
 *  1. githubId already linked to a user       -> log that user in
 *  2. no link, but a VERIFIED email matches
 *     an existing password account             -> link GitHub to it, then log in
 *  3. neither                                  -> create a brand new account
 *
 * Linking only ever happens on a verified email (see github.service.ts) —
 * this is the line that prevents account takeover via a spoofed email.
 */
export async function connectGithubAccount(
  userId: string,
  params: { profile: GithubProfile; verifiedEmail: string | null; githubAccessToken: string },
  meta: SessionMeta
): Promise<void> {
  const { profile, verifiedEmail, githubAccessToken } = params;

  const conflictingUser = await prisma.user.findUnique({ where: { githubId: profile.id } });
  if (conflictingUser && conflictingUser.id !== userId) {
    throw new ConflictError('This GitHub account is already connected to a different Dreamer account', 'GITHUB_ALREADY_LINKED');
  }

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new NotFoundError('User no longer exists', 'USER_NOT_FOUND');

  const encryptedToken = encryptForStorage(githubAccessToken);

  await prisma.user.update({
    where: { id: userId },
    data: {
      githubId: profile.id,
      githubUsername: profile.login,
      githubToken: encryptedToken,
      avatarUrl: user.avatarUrl ?? profile.avatar_url,
      // Connecting GitHub only proves something about the account's email
      // if GitHub's own verified email happens to match it — otherwise
      // leave emailVerified exactly as it was.
      ...(verifiedEmail && verifiedEmail === user.email && !user.emailVerified ? { emailVerified: true } : {}),
    },
  });

  await audit(userId, 'user.github_linked', meta);
}

export async function loginOrRegisterWithGithub({
  profile,
  verifiedEmail,
  githubAccessToken,
  meta,
}: GithubLoginParams) {
  const encryptedToken = encryptForStorage(githubAccessToken);

  let user = await prisma.user.findUnique({ where: { githubId: profile.id } });

  if (user) {
    user = await prisma.user.update({
      where: { id: user.id },
      data: { githubUsername: profile.login, githubToken: encryptedToken, avatarUrl: profile.avatar_url },
    });
  } else if (verifiedEmail) {
    const existingByEmail = await prisma.user.findUnique({ where: { email: verifiedEmail } });

    if (existingByEmail) {
      user = await prisma.user.update({
        where: { id: existingByEmail.id },
        data: {
          githubId: profile.id,
          githubUsername: profile.login,
          githubToken: encryptedToken,
          avatarUrl: existingByEmail.avatarUrl ?? profile.avatar_url,
          emailVerified: true,
        },
      });
      await audit(user.id, 'user.github_linked', meta);
    }
  }

  if (!user) {
    user = await prisma.user.create({
      data: {
        // GitHub accounts without a public email get a guaranteed-unique
        // placeholder so `email` (NOT NULL UNIQUE) is always satisfiable.
        email: verifiedEmail ?? `${profile.id}+${profile.login}@users.noreply.github.com`,
        passwordHash: null,
        name: profile.name ?? profile.login,
        avatarUrl: profile.avatar_url,
        githubId: profile.id,
        githubUsername: profile.login,
        githubToken: encryptedToken,
        emailVerified: Boolean(verifiedEmail),
      },
    });
    await audit(user.id, 'user.register_github', meta);
  }

  if (!user.isActive) {
    throw new ForbiddenError('This account has been suspended', 'ACCOUNT_SUSPENDED');
  }

  const isNewSignIn = await isUnrecognizedSignIn(user.id, meta);
  const accessToken = signAccessToken(user.id, user.email);
  const { rawToken: refreshToken } = await createSession(user.id, meta);

  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
  await audit(user.id, 'user.login_github', meta);

  if (isNewSignIn) {
    await sendSecurityNotification(sendNewSignInEmail(user.email, meta));
  }

  return { accessToken, refreshToken, user: toPublicUser(user) };
}
