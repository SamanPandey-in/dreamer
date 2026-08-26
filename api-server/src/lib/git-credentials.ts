import { prisma } from './prisma';
import { decryptFromStorage } from './crypto';

/**
 * local-engine's entire replacement for lib/github-app.ts (App JWT signing +
 * per-installation token minting/caching). There's one operator, one PAT,
 * stored encrypted on the single User row (see
 * docs/architecture/local-engine-auth-and-networking.md Decision 2) — no
 * token minting, no expiry, no cache to invalidate. This is deliberately
 * this small.
 *
 * Returns undefined (never throws) when no token is set — callers decide
 * for themselves whether that's fatal. It's fine for browsing/cloning a
 * PUBLIC repo (see integrations/github-repo.service.ts's searchPublicRepos
 * doc comment, unchanged from before this migration) and only a problem
 * once something tries to touch a private one.
 */
export async function getGitAccessToken(userId: string): Promise<string | undefined> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { personalAccessToken: true } });
  return user?.personalAccessToken ? decryptFromStorage(user.personalAccessToken) : undefined;
}

/**
 * Single-tenant convenience: local-engine has exactly one admin account in
 * normal operation (see auth.service.ts#setupAdmin), so build.worker.ts and
 * anywhere else running outside a request's req.user context can resolve
 * "the operator's token" without a userId in hand at all. Returns undefined
 * if setup hasn't run yet or no token has been set — same as
 * getGitAccessToken.
 */
export async function getSingleOperatorGitAccessToken(): Promise<string | undefined> {
  const user = await prisma.user.findFirst({ select: { personalAccessToken: true }, orderBy: { createdAt: 'asc' } });
  return user?.personalAccessToken ? decryptFromStorage(user.personalAccessToken) : undefined;
}
