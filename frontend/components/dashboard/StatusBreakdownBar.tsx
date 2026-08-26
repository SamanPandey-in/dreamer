import type { MetricTotals } from "@/lib/dashboard-types";
import { formatCompactNumber } from "@/lib/format";

const SEGMENTS: { key: keyof Pick<MetricTotals, "status2xx" | "status3xx" | "status4xx" | "status5xx">; label: string; color: string }[] = [
  { key: "status2xx", label: "2xx Success", color: "bg-emerald-500" },
  { key: "status3xx", label: "3xx Redirect", color: "bg-blue-500" },
  { key: "status4xx", label: "4xx Client error", color: "bg-amber-500" },
  { key: "status5xx", label: "5xx Server error", color: "bg-red-500" },
];

export function StatusBreakdownBar({ totals }: { totals: MetricTotals }) {
  const total = totals.status2xx + totals.status3xx + totals.status4xx + totals.status5xx;

  return (
    <div className="rounded-2xl border border-zinc-800 bg-zinc-950/40 px-5 py-4">
      <span className="text-xs font-medium text-zinc-500">Response status breakdown</span>

      <div className="mt-3 h-2.5 w-full rounded-full overflow-hidden flex bg-zinc-900">
        {total === 0 ? (
          <div className="w-full h-full bg-zinc-800" />
        ) : (
          SEGMENTS.map((segment) => {
            const value = totals[segment.key];
            if (value === 0) return null;
            return (
              <div
                key={segment.key}
                className={segment.color}
                style={{ width: `${(value / total) * 100}%` }}
                title={`${segment.label}: ${value}`}
              />
            );
          })
        )}
      </div>

      <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2">
        {SEGMENTS.map((segment) => (
          <div key={segment.key} className="flex items-center gap-1.5 text-xs text-zinc-400">
            <span className={`w-2 h-2 rounded-full ${segment.color}`} />
            {segment.label}
            <span className="font-mono text-zinc-300">{formatCompactNumber(totals[segment.key])}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
