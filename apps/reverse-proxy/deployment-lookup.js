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
const cache = new Redis(process.env.REDIS_URL || 'redis://localhost:6379')  // Fallback to localhost for local dev

cache.on("error", (err) => {
  console.error("Redis error:", err);
});

cache.on("connect", () => {
  console.log("Connected to Redis");
});

const CACHE_TTL_SECONDS = 30
const CACHE_KEY_PREFIX = 'route:'

/**
 * Resolves a subdomain (e.g. "my-project" from "my-project.singularitydev.xyz")
 * to how it should be proxied. Returns null for "no such project" or "no
 * RUNNING deployment" — both are legitimate 404s, not errors, so the caller
 * doesn't need to distinguish them.
 *
 * Redis-cached for CACHE_TTL_SECONDS: without this, EVERY request to EVERY
 * deployed app would be a Postgres round trip before it could even start
 * proxying — a tax the STATIC path (which had zero DB dependency before
 * this change) never paid. 30s means a newly-RUNNING deployment starts
 * resolving correctly within 30s of going live, with no separate
 * cache-invalidation plumbing needed back in api-server.
 */
async function resolveRoute(subdomain) {
    const cacheKey = `${CACHE_KEY_PREFIX}${subdomain}`

    const cached = await cache.get(cacheKey)
    if (cached !== null) {
        return cached === 'null' ? null : JSON.parse(cached)
    }

    const result = await pool.query(
        `SELECT d.type AS "type", d."s3Prefix" AS "s3Prefix", d."lambdaFunctionUrl" AS "lambdaFunctionUrl"
         FROM "Project" p
         JOIN "Deployment" d ON d.id = p."activeDeploymentId"
         WHERE p.slug = $1 AND p."deletedAt" IS NULL`,
        [subdomain]
    )

    const route = result.rows[0] ?? null

    // Cache the miss too (as the literal string 'null', disambiguated from
    // JSON.stringify(null) === 'null' by the ternary above being identical
    // either way) — a typo'd or long-deleted subdomain shouldn't get a
    // fresh Postgres query on every single request either.
    await cache.set(cacheKey, route ? JSON.stringify(route) : 'null', 'EX', CACHE_TTL_SECONDS)

    return route
}

module.exports = { resolveRoute }
