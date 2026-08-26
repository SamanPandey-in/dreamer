"use client";

import { useEffect, useMemo, useState } from "react";
import { useProject } from "@/lib/project-context";
import { getProjectMetrics, describeApiError } from "@/lib/dashboard-api";
import type { MetricsRange, ProjectMetricsSummary } from "@/lib/dashboard-types";
import { formatBytes, formatCompactNumber } from "@/lib/format";
import { MetricsRangeFilter } from "@/components/dashboard/MetricsRangeFilter";
import { MetricStatCard } from "@/components/dashboard/MetricStatCard";
import { MetricsLineChart } from "@/components/dashboard/MetricsLineChart";
import { StatusBreakdownBar } from "@/components/dashboard/StatusBreakdownBar";

const CHART_METRICS = [
  { key: "requests" as const, label: "Requests", color: "#3b82f6" },
  { key: "visitors" as const, label: "Visitors", color: "#8b5cf6" },
  { key: "errors" as const, label: "Errors (4xx + 5xx)", color: "#ef4444" },
  { key: "avgResponseTimeMs" as const, label: "Avg response time", color: "#f59e0b" },
];

// api-server flushes Redis into Postgres every 2 minutes (see
// src/index.ts's METRICS_FLUSH_INTERVAL_MS) — polling faster than that
// would just re-fetch the same rows.
const POLL_INTERVAL_MS = 120_000;

function formatTimestampForRange(iso: string, range: MetricsRange): string {
  const date = new Date(iso);
  if (range === "1h" || range === "24h") {
    return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export default function MetricsPage() {
  const { project } = useProject();

  const [range, setRange] = useState<MetricsRange>("24h");
  const [metrics, setMetrics] = useState<ProjectMetricsSummary | null>(null);
  const [chartMetric, setChartMetric] = useState<(typeof CHART_METRICS)[number]>(CHART_METRICS[0]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); // eslint-disable-line react-hooks/set-state-in-effect -- must reset before async
    setError(null);

    function load() {
      getProjectMetrics(project.id, range)
        .then((data) => {
          if (!controller.signal.aborted) setMetrics(data);
        })
        .catch((err) => {
          if (!controller.signal.aborted) setError(describeApiError(err, "Failed to load metrics"));
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }

    load();
    const interval = setInterval(load, POLL_INTERVAL_MS);
    return () => {
      controller.abort();
      clearInterval(interval);
    };
  }, [project.id, range]);

  const formatValueForChart = useMemo(() => {
    if (chartMetric.key === "avgResponseTimeMs") return (value: number) => `${Math.round(value)}ms`;
    return (value: number) => formatCompactNumber(value);
  }, [chartMetric]);

  if (loading && !metrics) {
    return <div className="h-96 rounded-2xl border border-zinc-800 bg-zinc-950/40 animate-pulse" />;
  }

  if (error && !metrics) {
    return (
      <p className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-4 py-3">{error}</p>
    );
  }

  if (!metrics) return null;

  const { totals, comparedToPreviousPeriod, series } = metrics;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <p className="text-sm text-zinc-500">
          Traffic and performance for <span className="text-zinc-300 font-medium">{project.name}</span>, compared to
          the previous equivalent period.
        </p>
        <MetricsRangeFilter value={range} onChange={setRange} />
      </div>

      {error && (
        <p className="text-sm text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded-lg px-4 py-3">
          {error} — showing last loaded data.
        </p>
      )}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <MetricStatCard label="Requests" value={formatCompactNumber(totals.requests)} change={comparedToPreviousPeriod.requests} />
        <MetricStatCard label="Visitors (approx.)" value={formatCompactNumber(totals.visitors)} change={comparedToPreviousPeriod.visitors} />
        <MetricStatCard
          label="Error rate"
          value={`${(totals.errorRate * 100).toFixed(2)}%`}
          change={comparedToPreviousPeriod.errorRate}
          invert
        />
        <MetricStatCard
          label="Avg response time"
          value={`${Math.round(totals.avgResponseTimeMs)}ms`}
          change={comparedToPreviousPeriod.avgResponseTimeMs}
          invert
        />
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="rounded-2xl border border-zinc-800 bg-zinc-950/40 px-5 py-4">
          <span className="text-xs font-medium text-zinc-500">Peak response time</span>
          <div className="mt-1.5 text-xl font-bold text-zinc-100">{totals.maxResponseTimeMs}ms</div>
        </div>
        <div className="rounded-2xl border border-zinc-800 bg-zinc-950/40 px-5 py-4">
          <span className="text-xs font-medium text-zinc-500">Bandwidth transferred</span>
          <div className="mt-1.5 text-xl font-bold text-zinc-100">{formatBytes(totals.bytesTransferred)}</div>
        </div>
        <div className="rounded-2xl border border-zinc-800 bg-zinc-950/40 px-5 py-4">
          <span className="text-xs font-medium text-zinc-500">Successful responses</span>
          <div className="mt-1.5 text-xl font-bold text-zinc-100">{formatCompactNumber(totals.status2xx)}</div>
        </div>
        <div className="rounded-2xl border border-zinc-800 bg-zinc-950/40 px-5 py-4">
          <span className="text-xs font-medium text-zinc-500">Errors</span>
          <div className="mt-1.5 text-xl font-bold text-zinc-100">
            {formatCompactNumber(totals.status4xx + totals.status5xx)}
          </div>
        </div>
      </div>

      <div className="rounded-2xl border border-zinc-800 bg-zinc-950/40 px-5 py-4">
        <div className="flex items-center justify-between flex-wrap gap-3 mb-2">
          <span className="text-xs font-medium text-zinc-500">Traffic over time</span>
          <div className="inline-flex items-center gap-0.5 rounded-lg border border-zinc-800 bg-zinc-950/60 p-0.5">
            {CHART_METRICS.map((m) => (
              <button
                key={m.key}
                onClick={() => setChartMetric(m)}
                className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors ${
                  chartMetric.key === m.key ? "bg-zinc-800 text-zinc-100" : "text-zinc-500 hover:text-zinc-300"
                }`}
              >
                {m.label}
              </button>
            ))}
          </div>
        </div>
        <MetricsLineChart
          series={series}
          metricKey={chartMetric.key}
          color={chartMetric.color}
          formatValue={formatValueForChart}
          formatTimestamp={(iso) => formatTimestampForRange(iso, range)}
        />
      </div>

      <StatusBreakdownBar totals={totals} />
    </div>
  );
}
