import Link from "next/link";
import { GitCommitHorizontal } from "lucide-react";
import { formatRelativeTime } from "../../lib/format";
import type { Deployment } from "../../lib/dashboard-types";
import { StatusBadge } from "./StatusBadge";

export function DeploymentRow({ projectId, deployment }: { projectId: string; deployment: Deployment }) {
  return (
    <Link
      href={`/project/${projectId}/deployments/${deployment.id}`}
      className="flex items-center justify-between px-4 py-3 rounded-xl hover:bg-zinc-900/60 transition-colors border border-transparent hover:border-zinc-800"
    >
      <div className="flex items-center gap-3 min-w-0">
        <StatusBadge status={deployment.status} />
        <div className="min-w-0">
          <p className="text-sm text-zinc-200 truncate">{deployment.commitMessage ?? deployment.slug}</p>
          <div className="flex items-center gap-2 text-xs text-zinc-500 font-mono">
            <GitCommitHorizontal className="w-3 h-3" />
            {deployment.commitHash ? deployment.commitHash.slice(0, 7) : deployment.branch}
          </div>
        </div>
      </div>
      <span className="text-xs text-zinc-500 shrink-0">{formatRelativeTime(deployment.createdAt)}</span>
    </Link>
  );
}
