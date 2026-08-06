import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { prisma } from '../lib/prisma';
import { env } from '../lib/env';
import type { AccessTokenPayload } from './auth.types';
import type { VerificationTokenType } from '../generated/prisma/client';

const REFRESH_SECRET_BYTES = 64;
const BCRYPT_SALT_ROUNDS = 12; // matches the cost factor documented on User.passwordHash in schema.prisma

// Access token
// Short-lived (15 min), stateless, signed JWT. Never written to the DB —
// verifying it is just a signature check, which is what makes it fast enough
// to run on every single request without hitting Postgres.

export function signAccessToken(userId: string, email: string): string {
  const payload: Pick<AccessTokenPayload, 'sub' | 'email'> = { sub: userId, email };
  return jwt.sign(payload, env.JWT_ACCESS_SECRET, {
    expiresIn: env.ACCESS_TOKEN_TTL as jwt.SignOptions['expiresIn'],
    algorithm: 'HS256',
  });
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  return jwt.verify(token, env.JWT_ACCESS_SECRET) as AccessTokenPayload;
}

// Password hashing

export function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_SALT_ROUNDS);
}

export function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

// ── Refresh tokens (long-lived, stateful — one UserSession row per device) ─
//
// The raw token handed to the browser is `${sessionId}.${secret}`.
// We persist only bcrypt(secret) as UserSession.tokenHash — never the raw
// secret. Encoding the sessionId in the token lets /refresh do a single
// indexed lookup by id instead of bcrypt-comparing against every session in
// the table (bcrypt is deliberately slow; that doesn't scale past one row).

export interface SessionMeta {
  ipAddress?: string;
  userAgent?: string;
}

function packRefreshToken(sessionId: string, secret: string): string {
  return `${sessionId}.${secret}`;
}

function unpackRefreshToken(raw: string): { sessionId: string; secret: string } | null {
  const dotIndex = raw.indexOf('.');
  if (dotIndex === -1) return null;

  const sessionId = raw.slice(0, dotIndex);
  const secret = raw.slice(dotIndex + 1);
  if (!sessionId || !secret) return null;

  return { sessionId, secret };
}

/** Creates a brand new session row and returns the raw token to hand to the client. */
export async function createSession(userId: string, meta: SessionMeta) {
  const secret = crypto.randomBytes(REFRESH_SECRET_BYTES).toString('hex');
  const tokenHash = await bcrypt.hash(secret, BCRYPT_SALT_ROUNDS);
  const expiresAt = new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);

  const session = await prisma.userSession.create({
    data: {
      userId,
      tokenHash,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      expiresAt,
    },
  });

  return { rawToken: packRefreshToken(session.id, secret), session };
}

/**
 * Validates a raw refresh token against the DB, rotates it (delete old row,
 * create a new one), and returns a fresh access + refresh token pair.
 * Returns null for ANY failure — the caller always responds with the same
 * generic 401, never leaking *why* it failed.
 */
export async function rotateSession(rawToken: string, meta: SessionMeta) {
  const unpacked = unpackRefreshToken(rawToken);
  if (!unpacked) return null;

  const session = await prisma.userSession.findUnique({
    where: { id: unpacked.sessionId },
    include: { user: true },
  });

  if (!session || session.expiresAt < new Date()) return null;

  const isValid = await bcrypt.compare(unpacked.secret, session.tokenHash);
  if (!isValid) return null;

  if (!session.user.isActive) return null;

  // Rotate: the old refresh token must never work again, even for a
  // legitimate request that's still in flight with the old value cached.
  await prisma.userSession.delete({ where: { id: session.id } });

  const { rawToken: newRawToken } = await createSession(session.userId, meta);
  const accessToken = signAccessToken(session.userId, session.user.email);

  return { accessToken, refreshToken: newRawToken, user: session.user };
}

/** Revokes exactly one session — used by POST /auth/logout. */
export async function revokeSession(rawToken: string): Promise<void> {
  const unpacked = unpackRefreshToken(rawToken);
  if (!unpacked) return;

  await prisma.userSession.deleteMany({ where: { id: unpacked.sessionId } });
}

/** Revokes every session for a user — "sign out everywhere" / forced logout on suspension. */
export async function revokeAllSessions(userId: string): Promise<void> {
  await prisma.userSession.deleteMany({ where: { userId } });
}

/** Lists all active sessions for a user. */
export async function listSessionsForUser(userId: string) {
  return prisma.userSession.findMany({
    where: { userId, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: 'desc' },
    select: { id: true, userAgent: true, ipAddress: true, lastUsedAt: true, createdAt: true, expiresAt: true },
  });
}

/** Deletes a specific session by ID (only if it belongs to the given user). */
export async function revokeSessionById(userId: string, sessionId: string): Promise<boolean> {
  const result = await prisma.userSession.deleteMany({ where: { id: sessionId, userId } });
  return result.count > 0;
}

// ── Verification tokens (email-verify / password-reset) ────────────────────
//
// Exact same raw-token-vs-hash shape as refresh tokens above: the raw token
// handed to the client (embedded in the email link) is `${id}.${secret}`,
// only bcrypt(secret) is ever persisted. Reusing this pattern instead of
// storing a plain random token means a DB read alone can never be replayed
// as a valid token — the same property refresh tokens already have.

const VERIFICATION_SECRET_BYTES = 32;

export const EMAIL_VERIFY_TTL_MS = 24 * 60 * 60 * 1000; // 24h
export const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000; // 1h

/**
 * Creates a new verification/reset token row and returns the raw token to
 * embed in the email link. Any previous unconsumed token of the same type
 * for this user is invalidated first, so clicking an old email link never
 * works alongside a freshly requested one.
 */
export async function createVerificationToken(
  userId: string,
  type: VerificationTokenType,
  ttlMs: number
): Promise<string> {
  const secret = crypto.randomBytes(VERIFICATION_SECRET_BYTES).toString('hex');
  const tokenHash = await bcrypt.hash(secret, BCRYPT_SALT_ROUNDS);
  const expiresAt = new Date(Date.now() + ttlMs);

  await prisma.verificationToken.deleteMany({ where: { userId, type, consumedAt: null } });
  const token = await prisma.verificationToken.create({ data: { userId, type, tokenHash, expiresAt } });

  // packRefreshToken is a generic "${id}.${secret}" packer despite the name
  // (shared with refresh-token creation above) — reused here rather than
  // duplicated.
  return packRefreshToken(token.id, secret);
}

/**
 * Validates a raw verification/reset token, marks it consumed (single-use),
 * and returns the userId it belongs to — or null for ANY failure (expired,
 * already used, garbage input, wrong type). Callers should surface a single
 * generic error either way, same reasoning as rotateSession() above.
 */
export async function consumeVerificationToken(
  rawToken: string,
  type: VerificationTokenType
): Promise<string | null> {
  const unpacked = unpackRefreshToken(rawToken);
  if (!unpacked) return null;
  const { sessionId: tokenId, secret } = unpacked; // generic id.secret packer, reused from refresh tokens

  const token = await prisma.verificationToken.findUnique({ where: { id: tokenId } });
  if (!token || token.type !== type || token.consumedAt || token.expiresAt < new Date()) return null;

  const isValid = await bcrypt.compare(secret, token.tokenHash);
  if (!isValid) return null;

  await prisma.verificationToken.update({
    where: { id: token.id },
    data: { consumedAt: new Date() },
  });

  return token.userId;
}