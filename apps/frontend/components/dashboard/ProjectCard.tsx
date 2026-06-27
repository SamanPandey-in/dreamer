"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ExternalLink, GitBranch, Rocket } from "lucide-react";
import { createDeployment } from "../../lib/dashboard-api";
import { formatRelativeTime } from "../../lib/format";
import type { ProjectWithLatestDeployment } from "../../lib/dashboard-types";
import { StatusBadge } from "./StatusBadge";
import { Button } from "../ui/Button";

export function ProjectCard({ project }: { project: ProjectWithLatestDeployment }) {
  const router = useRouter();
  const [deploying, setDeploying] = useState(false);
  const { latestDeployment } = project;

  async function handleQuickDeploy(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    setDeploying(true);
    try {
      const deployment = await createDeployment(project.id);
      router.push(`/project/${project.id}/deployments/${deployment.id}`);
    } catch {
      setDeploying(false);
    }
  }

  return (
    <div
      onClick={() => router.push(`/project/${project.id}`)}
      className="block bg-zinc-950/80 rounded-[10px] border border-zinc-800 p-5 hover:border-zinc-700 hover:-translate-y-0.5 hover:shadow-lg hover:shadow-black/40 transition-all duration-150 cursor-pointer animate-in"
    >
      <div className="flex items-start justify-between mb-3">
        <div>
          <h3 className="font-semibold text-zinc-100">{project.name}</h3>
          <p className="text-xs text-zinc-500 font-mono">{project.slug}</p>
        </div>
        {latestDeployment ? (
          <StatusBadge status={latestDeployment.status} />
        ) : (
          <span className="text-xs text-zinc-500">No deploys yet</span>
        )}
      </div>

      {latestDeployment?.url && (
        <a
          href={latestDeployment.url}
          target="_blank"
          rel="noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="flex items-center gap-1.5 text-sm text-[var(--accent)] hover:underline mb-3 truncate"
        >
          <ExternalLink className="w-3.5 h-3.5 shrink-0" />
          <span className="truncate">{latestDeployment.url.replace(/^https?:\/\//, "")}</span>
        </a>
      )}

      <div className="flex items-center justify-between text-xs text-zinc-500">
        <div className="flex items-center gap-1.5">
          <GitBranch className="w-3.5 h-3.5" />
          {project.defaultBranch}
        </div>
        <div className="flex items-center gap-3">
          <span>{project.deploymentCount} deploys</span>
          {latestDeployment && <span>{formatRelativeTime(latestDeployment.createdAt)}</span>}
        </div>
      </div>

      <Button variant="secondary" onClick={handleQuickDeploy} loading={deploying} className="w-full mt-4">
        <Rocket className="w-3.5 h-3.5" />
        {deploying ? "Queuing..." : "Deploy"}
      </Button>
    </div>
  );
}