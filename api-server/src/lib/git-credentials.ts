import { prisma } from './prisma';
import { decryptFromStorage } from './crypto';

/**
 * The operator's PAT, stored encrypted on the User row and decrypted here on
 * demand — resolved right before the docker run call (or GitHub API call)
 * that needs it. Returns undefined (never throws) when no token is set:
 * fine for browsing/cloning PUBLIC repos, only a problem once something
 * touches a private one. Callers decide whether that's fatal.
 */
export async function getGitAccessToken(userId: string): Promise<string | undefined> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { personalAccessToken: true } });
  return user?.personalAccessToken ? decryptFromStorage(user.personalAccessToken) : undefined;
}

/**
 * Single-tenant convenience: resolves the operator's token without a userId
 * in hand — build.worker.ts and anything running outside a request context.
 * Undefined if setup hasn't run yet or no token is set, same as
 * getGitAccessToken.
 */
export async function getSingleOperatorGitAccessToken(): Promise<string | undefined> {
  const user = await prisma.user.findFirst({ select: { personalAccessToken: true }, orderBy: { createdAt: 'asc' } });
  return user?.personalAccessToken ? decryptFromStorage(user.personalAccessToken) : undefined;
}
