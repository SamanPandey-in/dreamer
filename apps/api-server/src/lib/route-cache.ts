import { redis } from './redis';
import { logger } from './logger';

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
export async function invalidateRouteCache(slug: string): Promise<void> {
  try {
    await redis.del(`${ROUTE_CACHE_KEY_PREFIX}${slug}`);
  } catch (err) {
    logger.error('Failed to invalidate route cache', { slug, err });
  }
}
