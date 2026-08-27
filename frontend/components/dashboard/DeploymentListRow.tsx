import Link from "next/link";
import { GitBranch, GitCommitHorizontal } from "lucide-react";
import { formatDuration, formatRelativeTime } from "@/lib/format";
import type { Deployment } from "@/lib/dashboard-types";
import { StatusBadge } from "./StatusBadge";
import { DeploymentMenu } from "./DeploymentMenu";

const ENVIRONMENT_LABELS: Record<string, string> = { PRODUCTION: "Production", PREVIEW: "Preview" };
const TRIGGER_LABELS: Record<string, string> = {
  manual: "Manual",
  api: "API",
  rollback: "Rollback",
  webhook: "Webhook",
};

export function DeploymentListRow({ projectId, deployment }: { projectId: string; deployment: Deployment }) {
  return (
    <Link
      href={`/project/${projectId}/deployments/${deployment.id}`}
      className="flex items-center gap-4 px-4 py-3 rounded-xl hover:bg-zinc-900/60 transition-colors border border-transparent hover:border-zinc-800"
    >
      <StatusBadge status={deployment.status} />

      <div className="min-w-0 flex-1">
        <p className="text-sm text-zinc-200 truncate">{deployment.commitMessage ?? deployment.slug}</p>
        <div className="flex items-center gap-3 text-xs text-zinc-500 font-mono">
          <span className="flex items-center gap-1">
            <GitCommitHorizontal className="w-3 h-3" />
            {deployment.commitHash ? deployment.commitHash.slice(0, 7) : "—"}
          </span>
          <span className="flex items-center gap-1">
            <GitBranch className="w-3 h-3" />
            {deployment.branch}
          </span>
        </div>
      </div>

      <span className="hidden sm:inline-flex text-[11px] px-2 py-0.5 rounded-full bg-zinc-800 text-zinc-400 shrink-0">
        {ENVIRONMENT_LABELS[deployment.environment] ?? deployment.environment}
      </span>

      <span className="hidden md:inline-flex text-[11px] px-2 py-0.5 rounded-full border border-zinc-800 text-zinc-500 shrink-0">
        {TRIGGER_LABELS[deployment.triggeredBy] ?? deployment.triggeredBy}
      </span>

      <span className="hidden lg:block text-xs text-zinc-500 w-16 text-right shrink-0">
        {deployment.buildDurationMs ? formatDuration(deployment.buildDurationMs) : "—"}
      </span>

      <span className="hidden sm:block text-xs text-zinc-500 w-20 truncate shrink-0">
        {deployment.commitAuthor ?? "—"}
      </span>

      <span className="text-xs text-zinc-500 w-16 text-right shrink-0">{formatRelativeTime(deployment.createdAt)}</span>

      <DeploymentMenu projectId={projectId} deployment={deployment} />
    </Link>
  );
}
