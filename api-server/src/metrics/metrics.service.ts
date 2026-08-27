import { prisma } from '../lib/prisma';
import { assertProjectOwnership } from '../projects/project.service';
import type {
  MetricComparison,
  MetricsRange,
  MetricsSeriesPoint,
  MetricTotals,
  ProjectMetricsSummary,
} from './metrics.types';
import type { ProjectMetricInterval } from '../generated/prisma/client';

const RANGE_TO_MS: Record<MetricsRange, number> = {
  '1h': 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

// Chart bucket width per range — wider ranges get coarser buckets so the
// series response stays a reasonable size (1h: 12 points, 24h: 48, 7d: 56,
// 30d: 30). Raw storage granularity (ProjectMetricInterval, 5 min) never
// changes; only how many raw rows sum into each returned point.
const RANGE_TO_BUCKET_MS: Record<MetricsRange, number> = {
  '1h': 5 * 60 * 1000, // native — no downsampling
  '24h': 30 * 60 * 1000,
  '7d': 3 * 60 * 60 * 1000,
  '30d': 24 * 60 * 60 * 1000,
};

function emptyTotals(): MetricTotals {
  return {
    requests: 0,
    visitors: 0,
    status2xx: 0,
    status3xx: 0,
    status4xx: 0,
    status5xx: 0,
    errorRate: 0,
    avgResponseTimeMs: 0,
    maxResponseTimeMs: 0,
    bytesTransferred: 0,
  };
}

function sumTotals(rows: ProjectMetricInterval[]): MetricTotals {
  const totals = emptyTotals();
  let responseTimeSumMs = 0n;

  for (const row of rows) {
    totals.requests += row.requestCount;
    // SUM of each interval's independent approximate distinct count, NOT a
    // distinct count across the whole range — HyperLogLog cardinalities
    // aren't mergeable after the fact at this granularity. An upper bound on
    // unique visitors, not a verified distinct-visitor count.
    totals.visitors += row.visitorCount;
    totals.status2xx += row.status2xx;
    totals.status3xx += row.status3xx;
    totals.status4xx += row.status4xx;
    totals.status5xx += row.status5xx;
    totals.bytesTransferred += Number(row.bytesTransferred);
    totals.maxResponseTimeMs = Math.max(totals.maxResponseTimeMs, row.responseTimeMaxMs);
    responseTimeSumMs += row.responseTimeSumMs;
  }

  totals.errorRate = totals.requests > 0 ? (totals.status4xx + totals.status5xx) / totals.requests : 0;
  totals.avgResponseTimeMs = totals.requests > 0 ? Number(responseTimeSumMs) / totals.requests : 0;

  return totals;
}

function buildSeries(rows: ProjectMetricInterval[], since: Date, bucketMs: number): MetricsSeriesPoint[] {
  const buckets = new Map<number, ProjectMetricInterval[]>();

  for (const row of rows) {
    const offset = row.intervalStart.getTime() - since.getTime();
    const bucketStart = since.getTime() + Math.floor(offset / bucketMs) * bucketMs;
    const existing = buckets.get(bucketStart) ?? [];
    existing.push(row);
    buckets.set(bucketStart, existing);
  }

  return [...buckets.entries()]
    .sort(([a], [b]) => a - b)
    .map(([bucketStart, bucketRows]) => {
      const totals = sumTotals(bucketRows);
      return {
        timestamp: new Date(bucketStart).toISOString(),
        requests: totals.requests,
        visitors: totals.visitors,
        status2xx: totals.status2xx,
        status3xx: totals.status3xx,
        status4xx: totals.status4xx,
        status5xx: totals.status5xx,
        avgResponseTimeMs: Math.round(totals.avgResponseTimeMs),
        bytesTransferred: totals.bytesTransferred,
      };
    });
}

// null when the previous period's baseline was 0 — percent change against
// zero is undefined (not 0%, not +Infinity%), so the frontend renders "—"
// for null instead of a misleading number.
function percentChange(current: number, previous: number): number | null {
  if (previous === 0) return current === 0 ? 0 : null;
  return ((current - previous) / previous) * 100;
}

/**
 * Reads ONLY ProjectMetricInterval (Redis ingestion is metrics-aggregator.ts's
 * job). assertProjectOwnership 404s before any query runs if the project
 * doesn't exist or isn't this user's — same convention as every other
 * project-scoped read.
 *
 * Also computes a period-over-period comparison: the current range against
 * the immediately preceding range of equal length — what the frontend's
 * %inc/%dec badges read.
 */
export async function getProjectMetrics(
  projectId: string,
  userId: string,
  range: MetricsRange
): Promise<ProjectMetricsSummary> {
  await assertProjectOwnership(projectId, userId);

  const rangeMs = RANGE_TO_MS[range];
  const now = new Date();
  const since = new Date(now.getTime() - rangeMs);
  const previousSince = new Date(since.getTime() - rangeMs);

  const [currentRows, previousRows] = await Promise.all([
    prisma.projectMetricInterval.findMany({
      where: { projectId, intervalStart: { gte: since, lt: now } },
      orderBy: { intervalStart: 'asc' },
    }),
    prisma.projectMetricInterval.findMany({
      where: { projectId, intervalStart: { gte: previousSince, lt: since } },
    }),
  ]);

  const totals = sumTotals(currentRows);
  const previousTotals = sumTotals(previousRows);

  const comparedToPreviousPeriod: MetricComparison = {
    requests: percentChange(totals.requests, previousTotals.requests),
    visitors: percentChange(totals.visitors, previousTotals.visitors),
    errorRate: percentChange(totals.errorRate, previousTotals.errorRate),
    avgResponseTimeMs: percentChange(totals.avgResponseTimeMs, previousTotals.avgResponseTimeMs),
  };

  return {
    range,
    totals,
    comparedToPreviousPeriod,
    series: buildSeries(currentRows, since, RANGE_TO_BUCKET_MS[range]),
  };
}
