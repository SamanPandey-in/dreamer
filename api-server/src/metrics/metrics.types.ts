import { z } from 'zod';

// Shaped { params }/{ query } for validate.middleware.ts, same convention as
// project.types.ts; `range` bounds how far back to aggregate/chart.
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
  visitors: number; // sum of per-interval approx unique visitors — an upper bound, not exact across the range (see metrics.service.ts)
  status2xx: number;
  status3xx: number;
  status4xx: number;
  status5xx: number;
  errorRate: number; // (status4xx + status5xx) / requests, 0 when requests is 0
  avgResponseTimeMs: number; // true mean (total response-time-ms / total requests) — no p95/p99 recoverable from aggregated sum+count+max
  maxResponseTimeMs: number; // exact peak in range (max-of-per-interval-maxes)
  bytesTransferred: number;
}

// Percent change vs the immediately preceding period of the SAME length.
// null on a zero previous baseline — percent change against zero is
// undefined, so callers should render "—" rather than a number.
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
