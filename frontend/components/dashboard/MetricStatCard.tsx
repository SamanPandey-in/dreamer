import { MetricChangeBadge } from "./MetricChangeBadge";

interface MetricStatCardProps {
  label: string;
  value: string;
  change: number | null;
  invert?: boolean;
}

export function MetricStatCard({ label, value, change, invert }: MetricStatCardProps) {
  return (
    <div className="rounded-2xl border border-zinc-800 bg-zinc-950/40 px-5 py-4 flex flex-col gap-1.5">
      <span className="text-xs font-medium text-zinc-500">{label}</span>
      <div className="flex items-baseline gap-2 flex-wrap">
        <span className="text-2xl font-bold tracking-tight text-zinc-100">{value}</span>
        <MetricChangeBadge value={change} invert={invert} />
      </div>
    </div>
  );
}
