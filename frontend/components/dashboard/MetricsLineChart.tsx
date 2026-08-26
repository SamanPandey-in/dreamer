"use client";

import { useMemo, useState } from "react";
import type { MetricsSeriesPoint } from "@/lib/dashboard-types";

type MetricKey = "requests" | "visitors" | "avgResponseTimeMs" | "errors";

interface MetricsLineChartProps {
  series: MetricsSeriesPoint[];
  metricKey: MetricKey;
  color: string; // a Tailwind-compatible hex, e.g. "#3b82f6" — used directly in SVG attrs, which don't understand Tailwind class names
  formatValue: (value: number) => string;
  formatTimestamp: (iso: string) => string;
}

function valueFor(point: MetricsSeriesPoint, key: MetricKey): number {
  if (key === "errors") return point.status4xx + point.status5xx;
  return point[key];
}

const WIDTH = 800;
const HEIGHT = 220;
const PADDING_LEFT = 44;
const PADDING_RIGHT = 12;
const PADDING_TOP = 16;
const PADDING_BOTTOM = 28;

/**
 * A deliberately simple hand-rolled SVG line chart rather than pulling in a
 * charting library — this app has zero chart-library dependencies today
 * (see package.json), and one metric line graph doesn't earn adding one.
 * If more chart types are needed later (stacked areas, multi-series
 * overlays), that's the point to reconsider bringing in recharts/visx —
 * not before.
 */
export function MetricsLineChart({ series, metricKey, color, formatValue, formatTimestamp }: MetricsLineChartProps) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  const { points, maxValue, path, areaPath } = useMemo(() => {
    const values = series.map((point) => valueFor(point, metricKey));
    const max = Math.max(...values, 1); // avoid a degenerate 0-height chart when every value is 0
    const innerWidth = WIDTH - PADDING_LEFT - PADDING_RIGHT;
    const innerHeight = HEIGHT - PADDING_TOP - PADDING_BOTTOM;

    const pts = values.map((value, i) => {
      const x = series.length === 1 ? PADDING_LEFT : PADDING_LEFT + (i / (series.length - 1)) * innerWidth;
      const y = PADDING_TOP + innerHeight - (value / max) * innerHeight;
      return { x, y, value };
    });

    const linePath = pts.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ");
    const area =
      pts.length > 0
        ? `${linePath} L ${pts[pts.length - 1].x.toFixed(1)} ${PADDING_TOP + innerHeight} L ${pts[0].x.toFixed(1)} ${PADDING_TOP + innerHeight} Z`
        : "";

    return { points: pts, maxValue: max, path: linePath, areaPath: area };
  }, [series, metricKey]);

  if (series.length === 0) {
    return (
      <div className="h-[220px] flex items-center justify-center text-sm text-zinc-600">
        No traffic recorded for this range yet.
      </div>
    );
  }

  const gradientId = `metric-gradient-${metricKey}`;
  const hovered = hoverIndex !== null ? points[hoverIndex] : null;
  const hoveredPoint = hoverIndex !== null ? series[hoverIndex] : null;

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="w-full h-[220px]"
        onMouseLeave={() => setHoverIndex(null)}
        preserveAspectRatio="none"
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.25" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>

        {/* Horizontal gridlines at 0%, 50%, 100% */}
        {[0, 0.5, 1].map((fraction) => {
          const y = PADDING_TOP + fraction * (HEIGHT - PADDING_TOP - PADDING_BOTTOM);
          return (
            <line
              key={fraction}
              x1={PADDING_LEFT}
              x2={WIDTH - PADDING_RIGHT}
              y1={y}
              y2={y}
              stroke="rgb(39 39 42)" // zinc-800
              strokeWidth={1}
            />
          );
        })}

        {/* Y axis labels */}
        <text x={4} y={PADDING_TOP + 4} className="fill-zinc-600 text-[10px]">
          {formatValue(maxValue)}
        </text>
        <text x={4} y={HEIGHT - PADDING_BOTTOM + 4} className="fill-zinc-600 text-[10px]">
          0
        </text>

        {areaPath && <path d={areaPath} fill={`url(#${gradientId})`} />}
        <path d={path} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />

        {hovered && (
          <line
            x1={hovered.x}
            x2={hovered.x}
            y1={PADDING_TOP}
            y2={HEIGHT - PADDING_BOTTOM}
            stroke="rgb(63 63 70)" // zinc-700
            strokeWidth={1}
            strokeDasharray="3 3"
          />
        )}
        {hovered && <circle cx={hovered.x} cy={hovered.y} r={3.5} fill={color} />}

        {/* Invisible hover targets — one per point, wide enough to be easy to hit even with many points */}
        {points.map((p, i) => (
          <rect
            key={i}
            x={i === 0 ? 0 : (p.x + points[i - 1].x) / 2}
            y={0}
            width={
              (i === points.length - 1 ? WIDTH : (p.x + points[Math.min(i + 1, points.length - 1)].x) / 2) -
              (i === 0 ? 0 : (p.x + points[i - 1].x) / 2)
            }
            height={HEIGHT}
            fill="transparent"
            onMouseEnter={() => setHoverIndex(i)}
          />
        ))}
      </svg>

      {hovered && hoveredPoint && (
        <div
          className="absolute pointer-events-none -translate-x-1/2 rounded-lg border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-xs shadow-lg"
          style={{
            left: `${(hovered.x / WIDTH) * 100}%`,
            top: 0,
          }}
        >
          <div className="text-zinc-400">{formatTimestamp(hoveredPoint.timestamp)}</div>
          <div className="font-semibold text-zinc-100">{formatValue(valueFor(hoveredPoint, metricKey))}</div>
        </div>
      )}
    </div>
  );
}
