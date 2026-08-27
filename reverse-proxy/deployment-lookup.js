const { Pool } = require('pg')
const Redis = require('ioredis')
const dotenv = require('dotenv');

dotenv.config();

// Raw pg Pool, not Prisma — this is latency-critical infrastructure every
// request passes through, and it needs exactly one read-only query.
const pool = new Pool({ connectionString: process.env.DATABASE_URL })
const cache = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
  // Capped exponential backoff — hammering reconnects during an outage can
  // itself prolong a per-command quota exhaustion.
  retryStrategy: (attempt) => Math.min(attempt * 200, 5_000),
})

cache.on("error", (err) => {
  console.error("Redis error:", err);
});

cache.on("connect", () => {
  console.log("Connected to Redis");
});

const CACHE_TTL_SECONDS = 30
const CACHE_KEY_PREFIX = 'route:'

/**
 * L1: plain in-process cache checked BEFORE Redis (L2). Exists purely to
 * absorb bursts to the same hostname within a few seconds, so a hot
 * project doesn't cost one Redis command PER REQUEST forever. Deliberately
 * much shorter TTL than the Redis layer, which stays the source of truth
 * (and is actively invalidated by api-server's invalidateRouteCache).
 *
 * Keyed by FULL hostname — custom domains work through the same cache with
 * no separate code path ("polyglot.com" is just another key).
 *
 * Trade-off: a newly-RUNNING deployment may take up to an extra L1_TTL_MS
 * (~5s) to become visible on this process, on top of the existing 30s
 * eventual consistency. Accepted given burst traffic is where the command
 * savings matter.
 */
const L1_TTL_MS = 5_000
const L1_MAX_ENTRIES = 10_000 // bounds memory under hostname-scanning/abuse traffic
const l1Cache = new Map() // hostname -> { value, expiresAt }

function getFromL1(hostname) {
    const entry = l1Cache.get(hostname)
    if (!entry) return undefined
    if (Date.now() >= entry.expiresAt) {
        l1Cache.delete(hostname)
        return undefined
    }
    return entry.value
}

function setInL1(hostname, value) {
    // Evict oldest (Map iterates in insertion order) rather than grow
    // unboundedly under scans of many never-seen hostnames.
    if (l1Cache.size >= L1_MAX_ENTRIES && !l1Cache.has(hostname)) {
        const oldestKey = l1Cache.keys().next().value
        l1Cache.delete(oldestKey)
    }
    l1Cache.set(hostname, { value, expiresAt: Date.now() + L1_TTL_MS })
}

/**
 * Resolves a full hostname ("myapp.singularitydev.xyz" or a customer-owned
 * "polyglot.com") to how it should be proxied:
 *
 *   1. {slug}.${baseDomain} — match Project.slug against the first label.
 *   2. Anything else — exact match against CustomDomain.domain; only
 *      VERIFIED rows route (unverified would mean serving traffic for a
 *      domain nobody proved they own).
 *
 * Both paths resolve to the same Project.activeDeploymentId — a custom
 * domain always points wherever its project's subdomain points.
 *
 * Returns null for "no such project/domain" or "no RUNNING deployment" —
 * both legitimate 404s, not errors.
 *
 * Three tiers: L1 (in-process ~5s) -> L2 Redis (30s) -> Postgres. Without
 * caching every request would pay a DB round trip before proxying could
 * start; 30s bounds staleness for a newly-RUNNING deployment even without
 * active invalidation.
 */
async function resolveRoute(hostname, baseDomain) {
    const l1Hit = getFromL1(hostname)
    if (l1Hit !== undefined) return l1Hit

    const cacheKey = `${CACHE_KEY_PREFIX}${hostname}`

    const cached = await cache.get(cacheKey)
    if (cached !== null) {
        const route = cached === 'null' ? null : JSON.parse(cached)
        setInL1(hostname, route)
        return route
    }

    const isUnderBaseDomain = hostname === baseDomain || hostname.endsWith(`.${baseDomain}`)

    // projectId/slug are selected in BOTH branches — metrics attribution
    // and the STATIC output-prefix interpolation need them regardless of
    // which lookup matched.
    const result = isUnderBaseDomain
        ? await pool.query(
              `SELECT p.id AS "projectId", d.id AS "deploymentId", p.slug AS "slug",
                      d.type AS "type", d."outputPrefix" AS "outputPrefix", d."appUrl" AS "appUrl"
               FROM "Project" p
               JOIN "Deployment" d ON d.id = p."activeDeploymentId"
               WHERE p.slug = $1 AND p."deletedAt" IS NULL`,
              [hostname.split('.')[0]]
          )
        : await pool.query(
              `SELECT p.id AS "projectId", d.id AS "deploymentId", p.slug AS "slug",
                      d.type AS "type", d."outputPrefix" AS "outputPrefix", d."appUrl" AS "appUrl"
               FROM "CustomDomain" cd
               JOIN "Project" p ON p.id = cd."projectId"
               JOIN "Deployment" d ON d.id = p."activeDeploymentId"
               WHERE cd.domain = $1 AND cd.verified = true AND p."deletedAt" IS NULL`,
              [hostname]
          )

    const route = result.rows[0] ?? null

    // Cache misses too ('null' sentinel) — a typo'd or deleted hostname
    // shouldn't hit Postgres on every request either.
    await cache.set(cacheKey, route ? JSON.stringify(route) : 'null', 'EX', CACHE_TTL_SECONDS)
    setInL1(hostname, route)

    return route
}

module.exports = { resolveRoute }
