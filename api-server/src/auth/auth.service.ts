import { prisma } from '../lib/prisma';
import { encryptForStorage } from '../lib/crypto';
import { BadRequestError, ForbiddenError, NotFoundError, UnauthorizedError } from '../lib/errors';
import {
  hashPassword,
  verifyPassword,
  signAccessToken,
  createSession,
  rotateSession,
  verifySessionUser,
  revokeSession,
  revokeAllSessions,
  listSessionsForUser,
  revokeSessionById,
  type SessionMeta,
} from './auth.tokens';
import type {
  ChangePasswordInput,
  LoginInput,
  PublicUser,
  SetupInput,
} from './auth.types';
import type { Prisma, User } from '../generated/prisma/client';

// A real bcrypt hash of a string nobody will ever type as a password.
// Used so failed-login timing is identical whether the email exists or not —
// without this, an attacker can use response time alone to enumerate which
// emails are registered. Kept even in single-admin mode: there's still
// exactly one real account, and this costs nothing to keep.
const DUMMY_PASSWORD_HASH = '$2b$12$ScfAwMBjElP/t9LDXIjNZuBTpu1OoHwB8Y5mIsjxquQk6t8xOd0da';

export function toPublicUser(user: User): PublicUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    avatarUrl: user.avatarUrl,
    hasGitToken: user.personalAccessToken !== null,
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

// A "new sign-in" means a successful login from a device/location we haven't
// seen before. Compare the incoming request against the user's existing
// active sessions; a match on both IP and user-agent means we've seen this
// device before. (No email notification sent for this anymore — see
// docs/architecture/local-engine-auth-and-networking.md Decision 1: nothing
// in local-engine sends email. Kept as an audit-log signal only.)
async function isUnrecognizedSignIn(userId: string, meta: SessionMeta): Promise<boolean> {
  const sessions = await listSessionsForUser(userId);
  return !sessions.some((s) => s.ipAddress === meta.ipAddress && s.userAgent === meta.userAgent);
}

// Single-admin setup — local-engine only. See
// docs/architecture/local-engine-auth-and-networking.md Decision 1. Refuses
// to run a second time: once any User row exists, this is permanently a
// 409, and the ONLY way to create more users would be a direct DB
// operation nobody is meant to script for a single-operator box.
export async function setupAdmin(input: SetupInput, meta: SessionMeta) {
  const existingCount = await prisma.user.count();
  if (existingCount > 0) {
    throw new ForbiddenError('Setup has already been completed', 'SETUP_ALREADY_DONE');
  }

  const passwordHash = await hashPassword(input.password);
  const user = await prisma.user.create({
    data: { email: input.email, passwordHash, name: input.name },
  });

  await audit(user.id, 'user.setup', meta);

  const accessToken = signAccessToken(user.id, user.email);
  const { rawToken: refreshToken } = await createSession(user.id, meta);
  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });

  return { accessToken, refreshToken, user: toPublicUser(user) };
}

export async function isSetupComplete(): Promise<boolean> {
  return (await prisma.user.count()) > 0;
}

export async function login(input: LoginInput, meta: SessionMeta) {
  const user = await prisma.user.findUnique({ where: { email: input.email } });

  // Always run a bcrypt comparison — even for a non-existent user — so
  // response timing can't be used to enumerate registered emails. See
  // DUMMY_PASSWORD_HASH above.
  const isValid = await verifyPassword(input.password, user?.passwordHash ?? DUMMY_PASSWORD_HASH);

  if (!user || !isValid) {
    await audit(user?.id ?? null, 'user.login_failed', meta, { email: input.email });
    throw new UnauthorizedError('Invalid email or password', 'INVALID_CREDENTIALS');
  }

  if (!user.isActive) {
    throw new ForbiddenError('This account has been suspended', 'ACCOUNT_SUSPENDED');
  }

  const isNewSignIn = await isUnrecognizedSignIn(user.id, meta);
  const accessToken = signAccessToken(user.id, user.email);
  const { rawToken: refreshToken } = await createSession(user.id, meta);

  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
  await audit(user.id, isNewSignIn ? 'user.login_new_device' : 'user.login', meta);

  return { accessToken, refreshToken, user: toPublicUser(user) };
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

/**
 * Identity-only lookup from the refresh cookie — no rotation, no new
 * session, no new cookie to set. For call sites that need "who is this"
 * on a request they can't put a CSRF token on (a plain top-level GET),
 * where refresh()'s side effect of minting a fresh session is exactly
 * what a forged cross-site request could otherwise abuse.
 */
export async function resolveUserFromRefreshToken(rawRefreshToken: string): Promise<PublicUser> {
  const user = await verifySessionUser(rawRefreshToken);
  if (!user) throw new UnauthorizedError('Invalid or expired session', 'SESSION_INVALID');
  return toPublicUser(user);
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

  if (!input.currentPassword) {
    throw new BadRequestError('Current password is required', 'CURRENT_PASSWORD_REQUIRED');
  }
  const isValid = await verifyPassword(input.currentPassword, user.passwordHash);
  if (!isValid) {
    throw new UnauthorizedError('Current password is incorrect', 'INVALID_PASSWORD');
  }

  const passwordHash = await hashPassword(input.newPassword);
  await prisma.user.update({ where: { id: userId }, data: { passwordHash } });
  await audit(userId, 'user.password_changed', meta);
}

// Git PAT — local-engine's replacement for the GitHub App installation
// flow. See docs/architecture/local-engine-auth-and-networking.md
// Decision 2, and lib/git-credentials.ts for how this is read back at
// build/browse time.

export async function setGitToken(userId: string, personalAccessToken: string, meta: SessionMeta): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: { personalAccessToken: encryptForStorage(personalAccessToken) },
  });
  await audit(userId, 'user.git_token_set', meta);
}

export async function clearGitToken(userId: string, meta: SessionMeta): Promise<void> {
  await prisma.user.update({ where: { id: userId }, data: { personalAccessToken: null } });
  await audit(userId, 'user.git_token_cleared', meta);
}
