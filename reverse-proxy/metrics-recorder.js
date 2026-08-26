const Redis = require('ioredis')

// Separate connection from deployment-lookup.js's route-cache client, so a
// slow flush can never head-of-line-block a lookup (or vice versa).
const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
    // Capped exponential backoff — hammering reconnects during an outage
    // can itself prolong a per-command quota exhaustion.
    retryStrategy: (attempt) => Math.min(attempt * 200, 5_000),
})

// Without this listener, Node's EventEmitter contract makes any 'error'
// event THROW and kill the whole process — taking every deployed site down.
redis.on('error', (err) => {
    console.error('[metrics-recorder] Redis error:', err)
})

// Durable storage granularity: api-server ends up with one Postgres row per
// bucket. Keep in sync with its METRICS_INTERVAL_MS. NOT the Redis flush
// frequency — that's FLUSH_INTERVAL_MS below.
const INTERVAL_MS = 5 * 60 * 1000

// TTL well past one interval width as a safety net: if api-server's flush
// job is down, keys self-expire instead of growing forever. Metrics are
// observability data — losing a window is acceptable.
const KEY_TTL_SECONDS = 60 * 60 // 1 hour

/**
 * Requests only mutate this in-process Map — zero I/O on the hot path. A
 * timer drains it to Redis with a small, ~fixed number of commands PER
 * ACTIVE PROJECT-INTERVAL regardless of request count: command volume
 * scales with projects-with-traffic × flushes-per-hour, not requests.
 *
 * Trade-off: a crash loses up to FLUSH_INTERVAL_MS of buffered metrics.
 */
let buckets = new Map() // "{projectId}:{intervalStart}" -> accumulator

// Tracks which members have already had EXPIRE sent. Must be module-level
// and survive flush()'s Map swap (buckets are discarded each cycle, so a
// flag on the bucket object wouldn't persist). Pruned once an interval's
// window has closed — a member is never reused after that.
const expirySentFor = new Set()

function statusClass(statusCode) {
    if (statusCode >= 200 && statusCode < 300) return '2xx'
    if (statusCode >= 300 && statusCode < 400) return '3xx'
    if (statusCode >= 400 && statusCode < 500) return '4xx'
    return '5xx'
}

/**
 * Records one proxied request against its project. Purely in-memory; never
 * allowed to throw into the request cycle it observes.
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
 * Drains accumulated buckets into Redis. Swaps in a fresh Map BEFORE any
 * await so requests landing mid-flush accumulate into the new map instead
 * of racing writes into one being drained — no lock needed.
 */
async function flush() {
    if (buckets.size === 0) return

    const toFlush = buckets
    buckets = new Map()

    return flushSnapshot(toFlush)
}

async function flushSnapshot(snapshot) {
    if (snapshot.size === 0) return

    const pipeline = redis.pipeline()
    const nowMaxCandidates = [] // [{ base, rtMax }] — read-compare-write after the pipeline

    for (const [member, bucket] of snapshot) {
        const base = `metrics:${member}`

        pipeline.sadd('metrics:active-intervals', member)
        if (bucket.requests > 0) pipeline.incrby(`${base}:requests`, bucket.requests)
        if (bucket.status2xx > 0) pipeline.incrby(`${base}:status:2xx`, bucket.status2xx)
        if (bucket.status3xx > 0) pipeline.incrby(`${base}:status:3xx`, bucket.status3xx)
        if (bucket.status4xx > 0) pipeline.incrby(`${base}:status:4xx`, bucket.status4xx)
        if (bucket.status5xx > 0) pipeline.incrby(`${base}:status:5xx`, bucket.status5xx)
        if (bucket.visitorIps.size > 0) pipeline.pfadd(`${base}:visitors`, ...bucket.visitorIps)
        if (bucket.bytes > 0) pipeline.incrby(`${base}:bytes`, bucket.bytes)
        if (bucket.rtSum > 0) pipeline.incrby(`${base}:rt_sum`, bucket.rtSum)

        // EXPIRE sent exactly once per member for the interval's life —
        // see expirySentFor. One hour comfortably outlives the 5-minute
        // window without refreshes.
        if (!expirySentFor.has(member)) {
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

    // rt_max has no single INCR-style equivalent — GET + conditional SET.
    // A lost race would at worst undercount a peak; exact counters above
    // are unaffected.
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

/** Drops members whose interval has closed — they'd never be seen again. */
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

/** Graceful shutdown: one last flush before exit. */
async function stopFlushLoop() {
    if (flushTimer) clearInterval(flushTimer)
    await flush().catch((err) => console.error('[metrics-recorder] final flush failed:', err))
}

module.exports = { recordRequest, startFlushLoop, stopFlushLoop }
