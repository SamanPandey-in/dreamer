const { Pool } = require('pg')
const Redis = require('ioredis')
const dotenv = require('dotenv');

dotenv.config();

// A separate, minimal Postgres connection — NOT Prisma. This service is a
// tiny, latency-critical piece of infrastructure that every single request
// to every deployed app passes through; pulling in the full Prisma client
// (and its generated types, its query engine, its connection pooling
// assumptions) for one read-only lookup query would be a heavy dependency
// for what this needs. Pool (not a single Client) because this process
// handles many concurrent requests, same reasoning api-server already
// applies to its own DB access.
const pool = new Pool({ connectionString: process.env.DATABASE_URL })
const cache = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
  // Same reasoning as metrics-recorder.js's identical option — see that
  // file's comment. Kept consistent across every raw Redis client in this
  // app rather than just the one that happened to cause an incident.
  retryStrategy: (attempt) => Math.min(attempt * 200, 5_000),
})  // Fallback to localhost for local dev

cache.on("error", (err) => {
  console.error("Redis error:", err);
});

cache.on("connect", () => {
  console.log("Connected to Redis");
});

const CACHE_TTL_SECONDS = 30
const CACHE_KEY_PREFIX = 'route:'

/**
 * NEW — L1: a plain in-process cache, checked BEFORE Redis (L2). This is
 * the fix for the other real Redis-command driver in this app besides
 * log-relay.ts's polling loop (see that file's own comment for the bigger
 * one): every proxied request used to cost at least one Redis GET here,
 * unconditionally — for a project getting real traffic, that's one billed
 * Redis command PER REQUEST, forever, with no way to reduce it as long as
 * every request has to ask Redis "is this still the right route?"
 *
 * L1_TTL_MS is deliberately much shorter than CACHE_TTL_SECONDS (30s) —
 * this cache exists purely to absorb BURSTS of requests to the same
 * hostname within a few seconds (many concurrent visitors, or one
 * visitor's page loading several sub-resources back to back), not to
 * replace Redis as the source of truth. Every request still defers to
 * Redis (and, transitively, to invalidateRouteCache's active invalidation
 * — see api-server's lib/route-cache.ts) within L1_TTL_MS regardless of
 * whether it happens to hit L1 or not.
 *
 * Keyed by the FULL hostname (not just the subdomain label) — this is
 * exactly what makes L1/L2 automatically work for custom domains too, with
 * no separate cache instance or code path: "polyglot.com" and
 * "polyglot.singularitydev.xyz" are just two different cache keys that
 * happen to resolve to the same underlying project via two different
 * resolveRoute() query branches below.
 *
 * Trade-off, stated plainly: a newly-RUNNING deployment can now take up to
 * an EXTRA L1_TTL_MS to become visible on THIS specific process on top of
 * whatever Redis/active-invalidation already provides — worst case ~5s
 * added to a change that was already eventually-consistent within 30s.
 * Accepted given the command-volume reduction is proportional to
 * (requests per hostname per L1_TTL_MS window), which for any genuinely
 * "hot" hostname — the case that actually matters for cost — is large.
 */
const L1_TTL_MS = 5_000
const L1_MAX_ENTRIES = 10_000 // bounds memory under hostname-scanning/abuse traffic — see pruneL1's own comment
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
    // Simple size cap: if we're at capacity and this is a genuinely new
    // key, evict the oldest entry (Map iteration order is insertion
    // order, so the first key is the oldest) rather than let a burst of
    // requests to many distinct never-seen-before hostnames (typo'd
    // domains, scanning bots) grow this unboundedly. Not a real LRU —
    // doesn't need to be, this is a 5-second cache; approximate eviction
    // under a pathological load is a fine trade for staying a single
    // Map with no extra dependency.
    if (l1Cache.size >= L1_MAX_ENTRIES && !l1Cache.has(hostname)) {
        const oldestKey = l1Cache.keys().next().value
        l1Cache.delete(oldestKey)
    }
    l1Cache.set(hostname, { value, expiresAt: Date.now() + L1_TTL_MS })
}

/**
 * Resolves a HOSTNAME (the full Host header — "myapp.singularitydev.xyz"
 * OR a customer-owned domain like "polyglot.com") to how it should be
 * proxied. Two lookup paths, tried by hostname shape:
 *
 *   1. {slug}.${baseDomain} — the free URL every project already has.
 *      Exactly the original lookup, unchanged: match Project.slug against
 *      the hostname's first label.
 *   2. Anything else — an exact match against CustomDomain.domain. Only a
 *      VERIFIED row routes (see api-server's custom-domain.service.ts for
 *      why: unverified would mean routing traffic for a domain nobody's
 *      proven they actually own). CNAMEs to `cname.${baseDomain}` per that
 *      same service's DNS instructions, so it arrives here with its own
 *      hostname intact, not rewritten to ours.
 *
 * Both paths resolve to the SAME project's activeDeploymentId — a custom
 * domain always points at whatever the subdomain already points at
 * ("the user's most active deployment"), never a separately-chosen one.
 *
 * Returns null for "no such project/domain" or "no RUNNING deployment" —
 * both are legitimate 404s, not errors, so the caller doesn't need to
 * distinguish them.
 *
 * Three-tier lookup: L1 (in-process, ~5s) -> L2 (Redis, 30s) -> Postgres.
 * Without ANY caching, every request to every deployed app would be a
 * Postgres round trip before it could even start proxying — a tax the
 * STATIC path (which had zero DB dependency before DYNAMIC support
 * existed) never paid. 30s (Redis) means a newly-RUNNING deployment starts
 * resolving correctly within 30s of going live even without active
 * invalidation; api-server's invalidateRouteCache makes the common case
 * near-instant instead of waiting out that TTL — and, as of custom
 * domains, invalidates BOTH the slug key and every verified custom domain
 * key for the project, not just the slug's.
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

    // p.id/d.id (projectId/deploymentId) and p.slug are selected in BOTH
    // branches — the former so index.js can attribute metrics regardless
    // of which hostname shape the request came in as, the latter so the
    // STATIC branch's output-prefix interpolation (which has always been
    // keyed by slug, not hostname — see index.js) works identically for a
    // custom domain, whose hostname has no relationship to the project's
    // slug at all.
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

    // Cache the miss too (as the literal string 'null', disambiguated from
    // JSON.stringify(null) === 'null' by the ternary above being identical
    // either way) — a typo'd or long-deleted hostname shouldn't get a
    // fresh Postgres query on every single request either.
    await cache.set(cacheKey, route ? JSON.stringify(route) : 'null', 'EX', CACHE_TTL_SECONDS)
    setInL1(hostname, route)

    return route
}

module.exports = { resolveRoute }
