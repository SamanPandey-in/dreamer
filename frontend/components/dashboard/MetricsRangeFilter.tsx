"use client";

import type { MetricsRange } from "@/lib/dashboard-types";

const RANGES: { label: string; value: MetricsRange }[] = [
  { label: "1h", value: "1h" },
  { label: "24h", value: "24h" },
  { label: "7d", value: "7d" },
  { label: "30d", value: "30d" },
];

export function MetricsRangeFilter({
  value,
  onChange,
}: {
  value: MetricsRange;
  onChange: (range: MetricsRange) => void;
}) {
  return (
    <div className="inline-flex items-center gap-0.5 rounded-lg border border-zinc-800 bg-zinc-950/60 p-0.5">
      {RANGES.map((range) => (
        <button
          key={range.value}
          onClick={() => onChange(range.value)}
          className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
            value === range.value ? "bg-zinc-800 text-zinc-100" : "text-zinc-500 hover:text-zinc-300"
          }`}
        >
          {range.label}
        </button>
      ))}
    </div>
  );
}
