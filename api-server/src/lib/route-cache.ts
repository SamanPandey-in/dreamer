import { redis } from './redis';
import { logger } from './logger';
import { prisma } from './prisma';

// MUST match apps/reverse-proxy/deployment-lookup.js's CACHE_KEY_PREFIX
// exactly — this and that file are the only two places this string exists,
// and they're two different Node processes with no shared import, so
// there's nothing enforcing that other than this comment.
const ROUTE_CACHE_KEY_PREFIX = 'route:';

/**
 * Call this the moment a project's activeDeploymentId changes (set OR
 * cleared) — deployment.service.ts's transitionDeploymentStatus (on ->
 * RUNNING) and stopDeployment (on clearing a stopped RUNNING deployment)
 * both do. Without this, a project going live (or going down) is invisible
 * to the reverse-proxy for up to CACHE_TTL_SECONDS (30s) — including the
 * negative-cache case: hit the subdomain once while a deploy is still
 * finishing, get a cached "no deployment" 404, and it keeps 404ing for up
 * to 30 more seconds even after the deploy actually succeeds.
 *
 * ★ NEW — also invalidates every VERIFIED custom domain pointed at this
 * project, not just its {slug}.BASE_DOMAIN entry. deployment-lookup.js
 * caches a custom domain's route under its own hostname as the Redis key
 * (see resolveRoute) — a request to "polyglot.com" was never going to
 * find anything under "route:polyglot" (the slug key this function used
 * to delete exclusively), so without this a custom domain's cache would
 * only ever self-heal by waiting out CACHE_TTL_SECONDS, same stale window
 * this function exists to close for the subdomain case. Reverse-proxy's L1
 * in-process cache (deployment-lookup.js's l1Cache, ~5s) is NOT reachable
 * from here at all — it lives in a different process — so a custom
 * domain can still lag up to L1_TTL_MS behind this call even after Redis
 * is correctly cleared; accepted for the same reason index.js's own
 * comment accepts it for the subdomain case.
 *
 * Deliberately swallows its own errors (logged, never thrown) — both
 * callers invoke this AFTER already committing the real state change
 * (activeDeploymentId / deployment status) to Postgres. A `redis.del`
 * failure here is a stale cache for up to CACHE_TTL_SECONDS, which is
 * recoverable; letting it throw would abort transitionDeploymentStatus's
 * caller (log-relay.ts, which never emits the status to connected sockets
 * if this throws) or leave stopDeployment having cleared activeDeploymentId
 * without ever reaching its own transitionDeploymentStatus(..., 'STOPPED')
 * call — i.e. a Redis blip turning into a stuck/incorrect DB status, which
 * is much worse than a stale cache.
 */
export async function invalidateRouteCache(slug: string, projectId?: string): Promise<void> {
  try {
    const keys = [`${ROUTE_CACHE_KEY_PREFIX}${slug}`];

    // projectId is optional only so existing call sites that predate custom
    // domains still compile without an audit of every caller — but every
    // caller in this codebase DOES have it available (see both call sites
    // in deployment.service.ts), so in practice this is never skipped.
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
