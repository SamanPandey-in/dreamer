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
  type SessionMeta,
} from './auth.tokens';
import type { GithubProfile } from './github.service';
import type { ChangePasswordInput, LoginInput, PublicUser, RegisterInput } from './auth.types';
import type { Prisma, User } from '../generated/prisma/client';

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

  const accessToken = signAccessToken(user.id, user.email);
  const { rawToken: refreshToken } = await createSession(user.id, meta);

  await audit(user.id, existing ? 'user.password_added' : 'user.register', meta);

  return { accessToken, refreshToken, user: toPublicUser(user) };
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

  const accessToken = signAccessToken(user.id, user.email);
  const { rawToken: refreshToken } = await createSession(user.id, meta);

  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
  await audit(user.id, 'user.login', meta);

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

  const accessToken = signAccessToken(user.id, user.email);
  const { rawToken: refreshToken } = await createSession(user.id, meta);

  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
  await audit(user.id, 'user.login_github', meta);

  return { accessToken, refreshToken, user: toPublicUser(user) };
}