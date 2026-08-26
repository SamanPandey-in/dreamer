const Redis = require('ioredis')

// Separate Redis connection from deployment-lookup.js's `cache` client —
// same reasoning api-server's lib/queue.ts documents for keeping BullMQ's
// connection apart from ordinary one-shot commands: this module now writes
// to Redis only once per FLUSH_INTERVAL_MS (see below), but keeping it off
// the route-cache connection still means a slow flush can never
// head-of-line-block a route lookup, or vice versa.
const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
    // Exponential backoff, capped — see apps/api-server/src/lib/redis.ts's
    // createResilientRedisClient for the full reasoning (same fix, same
    // file's worth of comment, ported here since apps/reverse-proxy is a
    // separate plain-Node app and can't import that TS module directly).
    // Short version: some Redis providers (Upstash, notably) bill/limit
    // per COMMAND, not per round-trip, so hammering reconnect attempts
    // during an outage can itself prolong a quota-exhaustion incident —
    // this backs off instead of retrying as fast as possible.
    retryStrategy: (attempt) => Math.min(attempt * 200, 5_000),
})

// FIX — this is the ENTIRE difference between "a Redis blip logs an
// error and ioredis reconnects on its own" and "a Redis blip crashes the
// whole reverse-proxy process, taking down every deployed site behind it."
// ioredis Redis instances are EventEmitters; Node's EventEmitter contract
// THROWS (process-fatal, unconditionally) when an 'error' event fires
// with zero listeners attached. This line is that listener.
redis.on('error', (err) => {
    console.error('[metrics-recorder] Redis error:', err)
})

// Keep in sync with apps/api-server/src/metrics/metrics-aggregator.ts's
// METRICS_INTERVAL_MS. This is the DURABLE storage granularity — how wide
// a bucket api-server ends up with one Postgres row per. It is NOT how
// often this module talks to Redis; see FLUSH_INTERVAL_MS below for that.
const INTERVAL_MS = 5 * 60 * 1000

// Redis keys are given a TTL well past one interval width as a safety net —
// if api-server's flush job is down for a while, these still self-expire
// instead of growing forever, at the cost of losing that window's metrics
// (acceptable: metrics are observability, not billing-critical data).
const KEY_TTL_SECONDS = 60 * 60 // 1 hour

/**
 * CHANGED — this used to fire up to ~14 Redis commands PER PROXIED
 * REQUEST (a pipeline is one network round-trip, but most Redis providers
 * — Upstash confirmed, see https://upstash.com/docs/redis/troubleshooting/max_requests_limit
 * — bill/limit every command inside a pipeline individually, not the
 * pipeline as one unit). At any real traffic volume that burns through a
 * request-based quota fast and, worse, ties Redis command cost directly to
 * site traffic with no way to bound it.
 *
 * Now: every request only mutates this in-process Map — zero Redis calls,
 * zero I/O, on the hot path. A timer (startFlushLoop, below) drains it to
 * Redis every FLUSH_INTERVAL_MS with a small, ~fixed number of commands
 * PER ACTIVE PROJECT-INTERVAL, regardless of how many requests occurred —
 * a project doing 1,000 req/s costs the same handful of Redis commands per
 * flush as one doing 10 req/s. Command volume now scales with (number of
 * projects with traffic) × (flushes per hour), not with request count.
 *
 * Trade-off, stated plainly: up to FLUSH_INTERVAL_MS of metrics are only
 * in this process's memory, not yet in Redis — a reverse-proxy crash or
 * restart in that window loses them. Accepted for the same reason the TTL
 * above is: this is observability data, not billing-critical data.
 */
let buckets = new Map() // "{projectId}:{intervalStart}" -> accumulator

// FIX — Tracks which "{projectId}:{intervalStart}" members have already had
// EXPIRE sent for their Redis keys — deliberately module-level and NEVER
// swapped/cleared by flush() the way `buckets` is, so this survives across
// flush cycles for as long as a given 5-minute interval stays open. A
// per-bucket flag living INSIDE the accumulator object wouldn't work here:
// flush() discards the old bucket objects on every swap (that's what makes
// the swap race-free), so anything about "have I done X for this bucket
// before" has to live somewhere that survives the swap — this Set is that
// somewhere. Pruned in flushSnapshot() once an interval's 5-minute window
// has definitely closed — a member's EXPIRE only needs sending once in its
// entire ~5-minute life, and a closed interval's member string is never
// reused (the next interval gets a new intervalStart, hence a new member).
const expirySentFor = new Set()

function statusClass(statusCode) {
    if (statusCode >= 200 && statusCode < 300) return '2xx'
    if (statusCode >= 300 && statusCode < 400) return '3xx'
    if (statusCode >= 400 && statusCode < 500) return '4xx'
    return '5xx'
}

/**
 * Records one proxied request/response against the project it belonged
 * to. Purely in-memory — see this module's own comment above. Never
 * allowed to throw into the request/response cycle it's observing (there
 * is no I/O left in here to fail, but the try/catch stays as insurance
 * against a caller passing a malformed argument).
 *
 * @param {string} projectId
 * @param {string} clientIp
 * @param {number} statusCode
 * @param {number} responseTimeMs
 * @param {number} bytesTransferred
 */
function recordRequest(projectId, clientIp, statusCode, responseTimeMs, bytesTransferred) {
    if (!projectId) return

    try {
        const intervalStart = Math.floor(Date.now() / INTERVAL_MS) * INTERVAL_MS
        const member = `${projectId}:${intervalStart}`

        let bucket = buckets.get(member)
        if (!bucket) {
            bucket = {
                requests: 0,
                visitorIps: new Set(),
                status2xx: 0,
                status3xx: 0,
                status4xx: 0,
                status5xx: 0,
                bytes: 0,
                rtSum: 0,
                rtMax: 0,
            }
            buckets.set(member, bucket)
        }

        bucket.requests += 1
        bucket.visitorIps.add(clientIp || 'unknown')
        bucket[`status${statusClass(statusCode)}`] += 1
        if (bytesTransferred > 0) bucket.bytes += bytesTransferred
        if (responseTimeMs >= 0) {
            const rt = Math.round(responseTimeMs)
            bucket.rtSum += rt
            if (rt > bucket.rtMax) bucket.rtMax = rt
        }
    } catch (err) {
        console.error('[metrics-recorder] failed to record request:', err)
    }
}

/**
 * Drains every bucket accumulated since the last flush into Redis, then
 * clears them. Swaps `buckets` for a fresh empty Map FIRST (synchronous,
 * before any `await`) specifically so a request landing WHILE this flush
 * is in flight accumulates into the NEW map instead of racing writes into
 * a bucket that's mid-drain — no lock needed, just "the old and new
 * accumulation periods never share a mutable object."
 */
async function flush() {
    if (buckets.size === 0) return

    const toFlush = buckets
    buckets = new Map() // module-level rebind — see the comment above for why a swap, not a .clear()

    return flushSnapshot(toFlush)
}

// Actual implementation, split out so `flush()`'s swap logic above stays
// simple to read. Called with a Map that nothing else will ever write to
// again (see flush()'s swap).
async function flushSnapshot(snapshot) {
    // Re-check: flush() already guarded on size, but keep this function
    // independently safe to call.
    if (snapshot.size === 0) return

    const pipeline = redis.pipeline()
    const nowMaxCandidates = [] // [{ base, rtMax }] — handled after the pipeline, see below

    for (const [member, bucket] of snapshot) {
        const base = `metrics:${member}`

        pipeline.sadd('metrics:active-intervals', member)
        if (bucket.requests > 0) pipeline.incrby(`${base}:requests`, bucket.requests)
        if (bucket.status2xx > 0) pipeline.incrby(`${base}:status:2xx`, bucket.status2xx)
        if (bucket.status3xx > 0) pipeline.incrby(`${base}:status:3xx`, bucket.status3xx)
        if (bucket.status4xx > 0) pipeline.incrby(`${base}:status:4xx`, bucket.status4xx)
        if (bucket.status5xx > 0) pipeline.incrby(`${base}:status:5xx`, bucket.status5xx)
        if (bucket.visitorIps.size > 0) pipeline.pfadd(`${base}:visitors`, ...bucket.visitorIps) // ONE command regardless of how many IPs — PFADD is variadic
        if (bucket.bytes > 0) pipeline.incrby(`${base}:bytes`, bucket.bytes)
        if (bucket.rtSum > 0) pipeline.incrby(`${base}:rt_sum`, bucket.rtSum)

        if (!expirySentFor.has(member)) {
            // Only ever sent ONCE per bucket for the life of this
            // interval, not every flush — see expirySentFor's own comment
            // for why this Set (not a flag on the bucket object) is what
            // makes that possible across flush()'s Map swap. A 1-hour TTL
            // sent once comfortably outlives the interval's own 5-minute
            // real-time window without needing a refresh.
            pipeline.expire('metrics:active-intervals', KEY_TTL_SECONDS)
            pipeline.expire(`${base}:requests`, KEY_TTL_SECONDS)
            pipeline.expire(`${base}:status:2xx`, KEY_TTL_SECONDS)
            pipeline.expire(`${base}:status:3xx`, KEY_TTL_SECONDS)
            pipeline.expire(`${base}:status:4xx`, KEY_TTL_SECONDS)
            pipeline.expire(`${base}:status:5xx`, KEY_TTL_SECONDS)
            pipeline.expire(`${base}:visitors`, KEY_TTL_SECONDS)
            pipeline.expire(`${base}:bytes`, KEY_TTL_SECONDS)
            pipeline.expire(`${base}:rt_sum`, KEY_TTL_SECONDS)
            expirySentFor.add(member)
        }

        if (bucket.rtMax > 0) nowMaxCandidates.push({ base, rtMax: bucket.rtMax })
    }

    try {
        await pipeline.exec()
    } catch (err) {
        console.error('[metrics-recorder] flush pipeline failed (this flush cycle\'s counts are lost, next cycle continues normally):', err)
        return // don't attempt rt_max below against a pipeline that may not have applied
    }

    pruneExpirySentFor()

    // rt_max needs read-compare-write, not a single INCR-style command —
    // one GET+conditional-SET per active bucket per flush (not per
    // request, per the design change above). Losing a race here under
    // concurrent flushes (there's only ever one, this process is
    // single-threaded for this purpose, so in practice this can't race
    // against itself) would just mean an occasional undercount of the
    // peak — never affects requests/status/bytes, which stay exact via
    // the pipeline above regardless.
    for (const { base, rtMax } of nowMaxCandidates) {
        try {
            const rtMaxKey = `${base}:rt_max`
            const current = Number(await redis.get(rtMaxKey)) || 0
            if (rtMax > current) {
                await redis.set(rtMaxKey, rtMax, 'EX', KEY_TTL_SECONDS)
            }
        } catch (err) {
            console.error('[metrics-recorder] rt_max update failed for', base, err)
        }
    }
}

const FLUSH_INTERVAL_MS = Number(process.env.METRICS_FLUSH_INTERVAL_MS) || 10_000

/**
 * Drops entries from expirySentFor whose interval has definitely closed
 * (intervalStart + INTERVAL_MS is in the past) — that member string will
 * never be seen again (the next request for that project generates a new
 * intervalStart, hence a new member), so tracking it forever would just be
 * an unbounded memory leak keyed by every project-interval this process
 * has ever seen traffic for. Cheap: parses the same `{projectId}:{ts}`
 * shape metrics-aggregator.ts's flush does, called once per flush (every
 * FLUSH_INTERVAL_MS), not once per request.
 */
function pruneExpirySentFor() {
    const now = Date.now()
    for (const member of expirySentFor) {
        const intervalStart = Number(member.slice(member.lastIndexOf(':') + 1))
        if (now >= intervalStart + INTERVAL_MS) {
            expirySentFor.delete(member)
        }
    }
}

let flushTimer = null

/** Called once from index.js at process boot. */
function startFlushLoop() {
    if (flushTimer) return
    flushTimer = setInterval(() => {
        flush().catch((err) => console.error('[metrics-recorder] flush failed:', err))
    }, FLUSH_INTERVAL_MS)
    flushTimer.unref?.() // don't hold the process open just for this timer
}

/**
 * Called from index.js's SIGTERM/SIGINT handler — a graceful shutdown
 * (deploy, scale-down) gets one last flush instead of silently dropping
 * whatever's still buffered. A hard crash still loses it — see this
 * module's own trade-off comment above — this only covers the graceful
 * path.
 */
async function stopFlushLoop() {
    if (flushTimer) clearInterval(flushTimer)
    await flush().catch((err) => console.error('[metrics-recorder] final flush failed:', err))
}

module.exports = { recordRequest, startFlushLoop, stopFlushLoop }
