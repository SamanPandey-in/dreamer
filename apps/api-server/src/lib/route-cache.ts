import { redis } from './redis';

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
 */
export async function invalidateRouteCache(slug: string): Promise<void> {
  await redis.del(`${ROUTE_CACHE_KEY_PREFIX}${slug}`);
}
