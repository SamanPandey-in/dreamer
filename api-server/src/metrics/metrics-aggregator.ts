import { prisma } from '../lib/prisma';
import { redis } from '../lib/redis';
import { logger } from '../lib/logger';

export const METRICS_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes — keep in sync with metrics-recorder.js

/**
 * NEW. This is the ONLY consumer of the Redis keys apps/reverse-proxy's
 * metrics-recorder.js writes on every proxied request. Key layout (must
 * stay in sync with metrics-recorder.js):
 *
 *   metrics:active-intervals                           Set<"{projectId}:{intervalStart}">
 *   metrics:{projectId}:{intervalStart}:requests        INCR counter
 *   metrics:{projectId}:{intervalStart}:visitors        PFADD HyperLogLog (approx unique client IPs)
 *   metrics:{projectId}:{intervalStart}:status:2xx..5xx INCR counters
 *   metrics:{projectId}:{intervalStart}:bytes           INCRBY (response Content-Length)
 *   metrics:{projectId}:{intervalStart}:rt_sum          INCRBY (response time ms, summed)
 *   metrics:{projectId}:{intervalStart}:rt_max          plain SET, replaced when a slower request is seen this interval
 *
 * `intervalStart` is `Math.floor(Date.now() / METRICS_INTERVAL_MS) * METRICS_INTERVAL_MS`
 * — the epoch-ms start of the 5-minute window the request landed in. A
 * plain integer (not an ISO string) specifically so splitting a member on
 * the LAST ':' is unambiguous — an ISO timestamp has colons in it too, a
 * UUID projectId never does.
 *
 * Run on an interval from src/index.ts (same pattern as
 * reconcileOrphanedQueuedDeployments — see that file's own comment for why
 * this codebase prefers a plain setInterval over a BullMQ repeatable job
 * for this kind of "sweep something periodically" task).
 */
export async function flushMetrics(): Promise<void> {
  const members = await redis.smembers('metrics:active-intervals');
  if (members.length === 0) return;

  const now = Date.now();

  for (const member of members) {
    const separatorIndex = member.lastIndexOf(':');
    if (separatorIndex === -1) continue;

    const projectId = member.slice(0, separatorIndex);
    const intervalStartMs = Number(member.slice(separatorIndex + 1));
    if (!projectId || Number.isNaN(intervalStartMs)) continue;

    const base = `metrics:${member}`;

    try {
      // Plain additive counters: safe to read-then-delete every flush cycle
      // and INCREMENT the Postgres row, because a counter's value since the
      // last flush is exactly what got added to Redis since the last flush.
      const results = (await redis
        .multi()
        .getdel(`${base}:requests`)
        .getdel(`${base}:status:2xx`)
        .getdel(`${base}:status:3xx`)
        .getdel(`${base}:status:4xx`)
        .getdel(`${base}:status:5xx`)
        .getdel(`${base}:bytes`)
        .getdel(`${base}:rt_sum`)
        .getdel(`${base}:rt_max`)
        .exec()) as [Error | null, string | null][];

      const [requests, s2xx, s3xx, s4xx, s5xx, bytes, rtSum, rtMax] = results.map(([, v]) => Number(v) || 0);

      // visitors is NOT a plain counter — HyperLogLog cardinality doesn't
      // add up across time-sliced samples of the same set (a visitor who
      // makes requests in two different flush windows within the same
      // interval would get double-counted if we incremented per-flush
      // PFCOUNT deltas the way we do for requests above). So instead: read
      // the CURRENT cumulative cardinality non-destructively (PFCOUNT
      // doesn't delete the key), and SET (not increment) the Postgres
      // column to that absolute value every flush. Only delete the HLL key
      // once the interval has fully elapsed, after one final read.
      const intervalHasClosed = now >= intervalStartMs + METRICS_INTERVAL_MS;
      const visitorCount = await redis.pfcount(`${base}:visitors`);

      const intervalStart = new Date(intervalStartMs);

      await prisma.projectMetricInterval.upsert({
        where: { projectId_intervalStart: { projectId, intervalStart } },
        create: {
          projectId,
          intervalStart,
          requestCount: requests,
          visitorCount,
          status2xx: s2xx,
          status3xx: s3xx,
          status4xx: s4xx,
          status5xx: s5xx,
          bytesTransferred: BigInt(bytes),
          responseTimeSumMs: BigInt(rtSum),
          responseTimeMaxMs: rtMax,
        },
        update: {
          requestCount: { increment: requests },
          visitorCount: { set: visitorCount },
          status2xx: { increment: s2xx },
          status3xx: { increment: s3xx },
          status4xx: { increment: s4xx },
          status5xx: { increment: s5xx },
          bytesTransferred: { increment: BigInt(bytes) },
          responseTimeSumMs: { increment: BigInt(rtSum) },
          // NOT incremented and NOT blindly set here — a later flush's max
          // could legitimately be lower than an earlier flush's max within
          // the SAME interval, and overwriting would silently lose the
          // true peak. The GREATEST() raw update right below is what
          // actually reconciles this correctly for both the create and
          // update branch of this upsert.
        },
      });

      if (rtMax > 0) {
        await prisma.$executeRaw`
          UPDATE "ProjectMetricInterval"
          SET "responseTimeMaxMs" = GREATEST("responseTimeMaxMs", ${rtMax})
          WHERE "projectId" = ${projectId}::uuid AND "intervalStart" = ${intervalStart}
        `;
      }

      if (intervalHasClosed) {
        await redis.del(`${base}:visitors`);
        await redis.srem('metrics:active-intervals', member);
      }
    } catch (err) {
      // One bad interval (e.g. a project deleted mid-flush, FK violation on
      // upsert) must never stop the rest of the sweep.
      logger.error('Failed to flush metrics interval', { member, err });
    }
  }
}
