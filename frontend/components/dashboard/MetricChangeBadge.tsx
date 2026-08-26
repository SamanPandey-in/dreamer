import { Minus, TrendingDown, TrendingUp } from "lucide-react";

interface MetricChangeBadgeProps {
  /** Percent change vs. the previous period, or null when there's no baseline to compare against. */
  value: number | null;
  /**
   * Most metrics: up = good (green), down = bad (red). Set to true for
   * metrics where the opposite is true (error rate, response time) — an
   * increase there should read as a warning, not an improvement.
   */
  invert?: boolean;
}

/** "+12.4%", "-3.1%", or "—" when there's no previous-period baseline. */
export function MetricChangeBadge({ value, invert = false }: MetricChangeBadgeProps) {
  if (value === null) {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium text-zinc-600">
        <Minus className="w-3 h-3" />—
      </span>
    );
  }

  const isFlat = Math.abs(value) < 0.05;
  const isUp = value > 0;
  const isGood = isFlat ? null : invert ? !isUp : isUp;

  const colorClass = isFlat
    ? "text-zinc-500"
    : isGood
      ? "text-emerald-400"
      : "text-red-400";

  const Icon = isFlat ? Minus : isUp ? TrendingUp : TrendingDown;

  return (
    <span className={`inline-flex items-center gap-1 text-xs font-medium ${colorClass}`}>
      <Icon className="w-3 h-3" />
      {isFlat ? "0%" : `${isUp ? "+" : ""}${value.toFixed(1)}%`}
    </span>
  );
}
