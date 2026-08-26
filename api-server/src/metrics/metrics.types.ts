import { z } from 'zod';

// NEW. Matches project.types.ts's projectIdParamSchema convention (a
// schema shaped { params: {...} } for validate.middleware.ts), plus a
// `range` query param bounding how far back to aggregate/chart.
export const projectMetricsQuerySchema = z.object({
  params: z.object({ projectId: z.uuid() }),
  query: z.object({
    range: z.enum(['1h', '24h', '7d', '30d']).default('24h'),
  }),
});

export type MetricsRange = z.infer<typeof projectMetricsQuerySchema>['query']['range'];

export interface MetricsSeriesPoint {
  timestamp: string; // ISO — the start of this chart bucket (bucket width varies by range, see metrics.service.ts)
  requests: number;
  visitors: number;
  status2xx: number;
  status3xx: number;
  status4xx: number;
  status5xx: number;
  avgResponseTimeMs: number;
  bytesTransferred: number;
}

export interface MetricTotals {
  requests: number;
  visitors: number; // sum of per-interval approximate unique visitors — see metrics.service.ts's doc comment for why this is an upper-bound estimate, not an exact distinct count across the whole range
  status2xx: number;
  status3xx: number;
  status4xx: number;
  status5xx: number;
  errorRate: number; // (status4xx + status5xx) / requests, 0 when requests is 0
  avgResponseTimeMs: number; // true mean: total response-time-ms / total requests, both exact sums — no percentile estimation attempted, since a real p95/p99 isn't recoverable from aggregated sum+count+max (would need storing raw latency samples or a histogram, which this table doesn't)
  maxResponseTimeMs: number; // exact peak observed in the range (per-interval max, then max-of-maxes)
  bytesTransferred: number;
}

// Percent change of every comparable total vs. the immediately preceding
// period of the SAME length (e.g. range=24h compares to the 24h before
// that). null when the previous period had a zero baseline (e.g. 0
// requests) — a percent change against zero is undefined, not 0% or
// infinite, so callers (the frontend badge) should render "—" for null
// rather than a number.
export interface MetricComparison {
  requests: number | null;
  visitors: number | null;
  errorRate: number | null;
  avgResponseTimeMs: number | null;
}

export interface ProjectMetricsSummary {
  range: MetricsRange;
  totals: MetricTotals;
  comparedToPreviousPeriod: MetricComparison;
  series: MetricsSeriesPoint[];
}
