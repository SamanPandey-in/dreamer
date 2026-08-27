import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { prisma } from '../lib/prisma';
import { env } from '../lib/env';
import type { AccessTokenPayload } from './auth.types';

const REFRESH_SECRET_BYTES = 64;
const BCRYPT_SALT_ROUNDS = 12; // matches the cost factor documented on User.passwordHash in schema.prisma

// Access token
// Short-lived, stateless, signed JWT — never written to the DB. Verifying
// it is just a signature check, so it's cheap enough for every request.

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
// The raw token handed to the browser is `${sessionId}.${secret}`; only
// bcrypt(secret) is persisted. Encoding the sessionId in the token lets
// /refresh do a single indexed lookup instead of bcrypt-comparing against
// every session row (bcrypt is deliberately slow).

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

  // Rotate: the old refresh token must never work again. deleteMany (not
  // delete) because two refreshes for the same session can race — the loser
  // finds zero rows and returns the same generic null, instead of Prisma's
  // delete() throwing P2025 and surfacing an unhandled 500.
  const { count } = await prisma.userSession.deleteMany({ where: { id: session.id } });
  if (count === 0) return null;

  const { rawToken: newRawToken } = await createSession(session.userId, meta);
  const accessToken = signAccessToken(session.userId, session.user.email);

  return { accessToken, refreshToken: newRawToken, user: session.user };
}

/**
 * Same validation as rotateSession (raw token -> DB row -> bcrypt compare ->
 * active-user check) but WITHOUT rotating anything. For callers that only
 * need "who owns this cookie" on a plain GET they can't protect with a CSRF
 * token — minting a fresh session as a side effect of a forgeable cross-site
 * request would itself be the vulnerability. Returns null for ANY failure,
 * same generic-401 reason as rotateSession.
 */
export async function verifySessionUser(rawToken: string) {
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

  return session.user;
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
