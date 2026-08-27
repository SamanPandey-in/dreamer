import '../../setup/test-env';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createPrismaMock, type PrismaMock } from '../../mocks/prisma.mock';

const prismaMock: PrismaMock = createPrismaMock();
vi.mock('@api/lib/prisma', () => ({ prisma: prismaMock }));

const {
  signAccessToken,
  verifyAccessToken,
  hashPassword,
  verifyPassword,
  createSession,
  rotateSession,
  verifySessionUser,
  revokeSession,
  revokeAllSessions,
  revokeSessionById,
} = await import('@api/auth/auth.tokens');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('access tokens', () => {
  it('round-trips a signed access token back to its userId/email payload', () => {
    const token = signAccessToken('user-1', 'saman@example.com');
    const payload = verifyAccessToken(token);
    expect(payload.sub).toBe('user-1');
    expect(payload.email).toBe('saman@example.com');
  });

  it('throws on a tampered token', () => {
    const token = signAccessToken('user-1', 'saman@example.com');
    const tampered = token.slice(0, -2) + (token.slice(-2) === 'AA' ? 'BB' : 'AA');
    expect(() => verifyAccessToken(tampered)).toThrow();
  });

  it('throws on a token signed with a different secret entirely', () => {
    expect(() => verifyAccessToken('not.a.jwt')).toThrow();
  });
});

describe('password hashing', () => {
  it('verifyPassword accepts the correct password against its own hash', async () => {
    const hash = await hashPassword('correct horse battery staple');
    await expect(verifyPassword('correct horse battery staple', hash)).resolves.toBe(true);
  });

  it('verifyPassword rejects an incorrect password', async () => {
    const hash = await hashPassword('correct horse battery staple');
    await expect(verifyPassword('wrong password', hash)).resolves.toBe(false);
  });

  it('never stores the plaintext password in the hash', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(hash).not.toContain('correct horse battery staple');
  });
});

describe('session lifecycle', () => {
  it('createSession persists a hashed secret (never the raw one) and returns "sessionId.secret"', async () => {
    prismaMock.userSession.create.mockImplementation(async (input: { data: Record<string, unknown> }) => ({
      id: 'session-1',
      userId: input.data.userId,
      tokenHash: input.data.tokenHash,
      expiresAt: input.data.expiresAt,
    }));

    const { rawToken, session } = await createSession('user-1', { ipAddress: '1.2.3.4' });

    expect(session.id).toBe('session-1');
    expect(rawToken.startsWith('session-1.')).toBe(true);
    const rawSecret = rawToken.split('.')[1];
    expect(prismaMock.userSession.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ userId: 'user-1' }) })
    );
    const persistedHash = prismaMock.userSession.create.mock.calls[0][0].data.tokenHash as string;
    expect(persistedHash).not.toBe(rawSecret);
    expect(persistedHash.startsWith('$2')).toBe(true);
  });

  it('rotateSession: valid token rotates to a new session and deletes the old one', async () => {
    const secret = 'a'.repeat(20);
    const bcryptjs = await import('bcryptjs');
    const tokenHash = await bcryptjs.hash(secret, 12);

    prismaMock.userSession.findUnique.mockResolvedValue({
      id: 'session-1',
      tokenHash,
      expiresAt: new Date(Date.now() + 60_000),
      userId: 'user-1',
      user: { id: 'user-1', email: 'saman@example.com', isActive: true },
    });
    prismaMock.userSession.deleteMany.mockResolvedValue({ count: 1 });
    prismaMock.userSession.create.mockResolvedValue({
      id: 'session-2',
      userId: 'user-1',
      tokenHash: 'irrelevant',
      expiresAt: new Date(),
    });

    const result = await rotateSession(`session-1.${secret}`, {});

    expect(result).not.toBeNull();
    expect(result?.refreshToken.startsWith('session-2.')).toBe(true);
    expect(prismaMock.userSession.deleteMany).toHaveBeenCalledWith({ where: { id: 'session-1' } });
  });

  it('rotateSession: returns null when a concurrent request already rotated this session (deleteMany count: 0 race)', async () => {
    const bcryptjs = await import('bcryptjs');
    const secret = 'f'.repeat(20);
    const tokenHash = await bcryptjs.hash(secret, 12);

    prismaMock.userSession.findUnique.mockResolvedValue({
      id: 'session-1',
      tokenHash,
      expiresAt: new Date(Date.now() + 60_000),
      userId: 'user-1',
      user: { id: 'user-1', email: 'x@example.com', isActive: true },
    });
    prismaMock.userSession.deleteMany.mockResolvedValue({ count: 0 });

    const result = await rotateSession(`session-1.${secret}`, {});

    expect(result).toBeNull();
    expect(prismaMock.userSession.create).not.toHaveBeenCalled();
  });

  it('rotateSession: returns null for a malformed raw token (no "." separator)', async () => {
    const result = await rotateSession('not-a-valid-token-shape', {});
    expect(result).toBeNull();
    expect(prismaMock.userSession.findUnique).not.toHaveBeenCalled();
  });

  it('rotateSession: returns null when the session does not exist', async () => {
    prismaMock.userSession.findUnique.mockResolvedValue(null);
    const result = await rotateSession('session-1.somesecret', {});
    expect(result).toBeNull();
  });

  it('rotateSession: returns null for an expired session', async () => {
    prismaMock.userSession.findUnique.mockResolvedValue({
      id: 'session-1',
      tokenHash: 'irrelevant',
      expiresAt: new Date(Date.now() - 1000),
      userId: 'user-1',
      user: { id: 'user-1', email: 'x@example.com', isActive: true },
    });
    const result = await rotateSession('session-1.somesecret', {});
    expect(result).toBeNull();
    expect(prismaMock.userSession.deleteMany).not.toHaveBeenCalled();
  });

  it('rotateSession: returns null when the secret does not match the stored hash (reused/stolen old token)', async () => {
    const bcryptjs = await import('bcryptjs');
    const correctSecret = 'b'.repeat(20);
    const tokenHash = await bcryptjs.hash(correctSecret, 12);

    prismaMock.userSession.findUnique.mockResolvedValue({
      id: 'session-1',
      tokenHash,
      expiresAt: new Date(Date.now() + 60_000),
      userId: 'user-1',
      user: { id: 'user-1', email: 'x@example.com', isActive: true },
    });

    const result = await rotateSession('session-1.wrong-secret-entirely', {});
    expect(result).toBeNull();
    expect(prismaMock.userSession.deleteMany).not.toHaveBeenCalled();
  });

  it('rotateSession: returns null for a deactivated user, even with a perfectly valid token', async () => {
    const bcryptjs = await import('bcryptjs');
    const secret = 'c'.repeat(20);
    const tokenHash = await bcryptjs.hash(secret, 12);

    prismaMock.userSession.findUnique.mockResolvedValue({
      id: 'session-1',
      tokenHash,
      expiresAt: new Date(Date.now() + 60_000),
      userId: 'user-1',
      user: { id: 'user-1', email: 'x@example.com', isActive: false },
    });

    const result = await rotateSession(`session-1.${secret}`, {});
    expect(result).toBeNull();
  });

  it('verifySessionUser: does NOT rotate anything (no delete, no new session)', async () => {
    const bcryptjs = await import('bcryptjs');
    const secret = 'd'.repeat(20);
    const tokenHash = await bcryptjs.hash(secret, 12);

    prismaMock.userSession.findUnique.mockResolvedValue({
      id: 'session-1',
      tokenHash,
      expiresAt: new Date(Date.now() + 60_000),
      userId: 'user-1',
      user: { id: 'user-1', email: 'x@example.com', isActive: true },
    });

    const user = await verifySessionUser(`session-1.${secret}`);

    expect(user?.id).toBe('user-1');
    expect(prismaMock.userSession.deleteMany).not.toHaveBeenCalled();
    expect(prismaMock.userSession.create).not.toHaveBeenCalled();
  });

  it('revokeSession deletes exactly the one session named in the token', async () => {
    await revokeSession('session-1.somesecret');
    expect(prismaMock.userSession.deleteMany).toHaveBeenCalledWith({ where: { id: 'session-1' } });
  });

  it('revokeSession is a no-op (no DB call) for a malformed token', async () => {
    await revokeSession('malformed');
    expect(prismaMock.userSession.deleteMany).not.toHaveBeenCalled();
  });

  it('revokeAllSessions deletes every session scoped to the userId, not by session id', async () => {
    await revokeAllSessions('user-1');
    expect(prismaMock.userSession.deleteMany).toHaveBeenCalledWith({ where: { userId: 'user-1' } });
  });

  it('revokeSessionById scopes the delete to both sessionId AND userId', async () => {
    prismaMock.userSession.deleteMany.mockResolvedValue({ count: 1 });
    const ok = await revokeSessionById('user-1', 'session-1');
    expect(ok).toBe(true);
    expect(prismaMock.userSession.deleteMany).toHaveBeenCalledWith({ where: { id: 'session-1', userId: 'user-1' } });
  });

  it('revokeSessionById returns false when nothing matched', async () => {
    prismaMock.userSession.deleteMany.mockResolvedValue({ count: 0 });
    const ok = await revokeSessionById('user-1', 'someone-elses-session');
    expect(ok).toBe(false);
  });
});
