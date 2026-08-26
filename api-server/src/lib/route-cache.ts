import { redis } from './redis';
import { logger } from './logger';
import { prisma } from './prisma';

// MUST match reverse-proxy/deployment-lookup.js's CACHE_KEY_PREFIX exactly —
// this and that file are the only two places this string exists, and they're
// two different Node processes with no shared import to enforce it.
const ROUTE_CACHE_KEY_PREFIX = 'route:';

/**
 * Call the moment a project's activeDeploymentId changes (set OR cleared) —
 * otherwise the change is invisible to the reverse-proxy for up to
 * CACHE_TTL_SECONDS, including a cached "no deployment" 404 persisting long
 * after a deploy actually succeeds. Deletes the {slug}.BASE_DOMAIN entry AND
 * every VERIFIED custom domain pointed at the project (each is cached under
 * its own hostname key). Reverse-proxy's ~5s in-process L1 cache lives in a
 * different process and isn't reachable from here, so a hostname can still
 * lag briefly behind Redis being correctly cleared — accepted.
 *
 * Deliberately swallows its own errors (logged, never thrown): both callers
 * invoke this AFTER committing the real state change (activeDeploymentId /
 * deployment status) to Postgres. A redis.del failure here is a stale cache
 * that self-heals within CACHE_TTL_SECONDS; letting it throw would abort
 * status transitions mid-flight — much worse than staleness.
 */
export async function invalidateRouteCache(slug: string, projectId?: string): Promise<void> {
  try {
    const keys = [`${ROUTE_CACHE_KEY_PREFIX}${slug}`];

    // Optional only defensively — every current caller passes it.
    if (projectId) {
      const customDomains = await prisma.customDomain.findMany({
        where: { projectId, verified: true },
        select: { domain: true },
      });
      keys.push(...customDomains.map((d) => `${ROUTE_CACHE_KEY_PREFIX}${d.domain}`));
    }

    if (keys.length > 0) await redis.del(...keys);
  } catch (err) {
    logger.error('Failed to invalidate route cache', { slug, projectId, err });
  }
}
