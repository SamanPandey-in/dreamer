import type { DeploymentStatus } from "../../lib/dashboard-types";

interface StatusConfig {
  label: string;
  color: string;
  bg: string;
  dot: string;
  pulse: boolean;
}

const STATUS_CONFIG: Record<DeploymentStatus, StatusConfig> = {
  QUEUED: { label: "Queued", color: "text-blue-400", bg: "bg-blue-400/10", dot: "bg-blue-400", pulse: false },
  LAUNCHING: { label: "Launching", color: "text-sky-400", bg: "bg-sky-400/10", dot: "bg-sky-400", pulse: true },
  BUILDING: { label: "Building", color: "text-amber-400", bg: "bg-amber-400/10", dot: "bg-amber-400", pulse: true },
  UPLOADING: { label: "Uploading", color: "text-purple-400", bg: "bg-purple-400/10", dot: "bg-purple-400", pulse: true },
  STARTING: { label: "Starting", color: "text-cyan-400", bg: "bg-cyan-400/10", dot: "bg-cyan-400", pulse: true },
  RUNNING: { label: "Running", color: "text-emerald-400", bg: "bg-emerald-400/10", dot: "bg-emerald-400", pulse: false },
  SLEEPING: { label: "Sleeping", color: "text-zinc-400", bg: "bg-zinc-400/10", dot: "bg-zinc-400", pulse: false },
  WAKING: { label: "Waking", color: "text-amber-400", bg: "bg-amber-400/10", dot: "bg-amber-400", pulse: true },
  STOPPED: { label: "Stopped", color: "text-zinc-500", bg: "bg-zinc-500/10", dot: "bg-zinc-500", pulse: false },
  FAILED: { label: "Failed", color: "text-red-400", bg: "bg-red-400/10", dot: "bg-red-400", pulse: false },
  CANCELLED: { label: "Cancelled", color: "text-zinc-500", bg: "bg-zinc-500/10", dot: "bg-zinc-500", pulse: false },
  ERROR: { label: "Error", color: "text-red-400", bg: "bg-red-400/10", dot: "bg-red-400", pulse: false },
};

const FALLBACK_STATUS_CONFIG: StatusConfig = {
  label: "Unknown",
  color: "text-zinc-400",
  bg: "bg-zinc-400/10",
  dot: "bg-zinc-400",
  pulse: false,
};

export function StatusBadge({ status }: { status: DeploymentStatus | string }) {
  const config = STATUS_CONFIG[status as DeploymentStatus] ?? FALLBACK_STATUS_CONFIG;
  const label = STATUS_CONFIG[status as DeploymentStatus]?.label ?? status;

  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium ${config.color} ${config.bg}`}
    >
      <span className={`w-1.5 h-1.5 rounded-full ${config.dot} ${config.pulse ? "animate-pulse" : ""}`} />
      {label}
    </span>
  );
}
