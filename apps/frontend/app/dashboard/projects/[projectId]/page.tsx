"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { ExternalLink, GitBranch, Rocket } from "lucide-react";
import { createDeployment, getProject, listDeployments } from "@/lib/dashboard-api";
import type { Deployment, Project } from "@/lib/dashboard-types";
import { DeploymentRow } from "@/components/dashboard/DeploymentRow";
import { StatusBadge } from "@/components/dashboard/StatusBadge";

export default function ProjectOverviewPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const router = useRouter();

  const [project, setProject] = useState<Project | null>(null);
  const [deployments, setDeployments] = useState<Deployment[] | null>(null);
  const [deploying, setDeploying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([getProject(projectId), listDeployments(projectId, { limit: 10 })])
      .then(([projectData, { deployments }]) => {
        setProject(projectData);
        setDeployments(deployments);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load project"));
  }, [projectId]);

  async function handleDeploy() {
    setDeploying(true);
    try {
      const deployment = await createDeployment(projectId);
      router.push(`/dashboard/projects/${projectId}/deployments/${deployment.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start deployment");
      setDeploying(false);
    }
  }

  if (error) {
    return <p className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-4 py-3">{error}</p>;
  }

  if (!project || !deployments) {
    return <div className="h-64 rounded-2xl border border-zinc-800 bg-zinc-950/40 animate-pulse" />;
  }

  const activeDeployment = deployments.find((d) => d.id === project.activeDeploymentId);

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <h1 className="text-2xl font-bold">{project.name}</h1>
        <button
          onClick={handleDeploy}
          disabled={deploying}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white text-sm font-medium shadow-lg shadow-blue-500/20 transition-all disabled:opacity-60"
        >
          <Rocket className="w-3.5 h-3.5" />
          {deploying ? "Queuing..." : "Redeploy"}
        </button>
      </div>
      <a
        href={project.repoUrl}
        target="_blank"
        rel="noreferrer"
        className="flex items-center gap-1.5 text-sm text-zinc-500 hover:text-zinc-300 mb-8 font-mono"
      >
        {project.repoFullName ?? project.repoUrl}
        <ExternalLink className="w-3 h-3" />
      </a>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2">
          <div className="bg-zinc-950/80 rounded-2xl border border-zinc-800 p-5 mb-6">
            <h2 className="text-sm font-semibold text-zinc-400 uppercase tracking-wider mb-3">
              Active Deployment
            </h2>
            {activeDeployment ? (
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <StatusBadge status={activeDeployment.status} />
                  {activeDeployment.url && (
                    <a
                      href={activeDeployment.url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-sm text-blue-400 hover:text-blue-300"
                    >
                      {activeDeployment.url.replace(/^https?:\/\//, "")}
                    </a>
                  )}
                </div>
                {activeDeployment.buildDurationMs && (
                  <span className="text-xs text-zinc-500">
                    Built in {Math.round(activeDeployment.buildDurationMs / 1000)}s
                  </span>
                )}
              </div>
            ) : (
              <p className="text-sm text-zinc-500">No deployment is live yet.</p>
            )}
          </div>

          <h2 className="text-sm font-semibold text-zinc-400 uppercase tracking-wider mb-3 px-1">
            Recent Deployments
          </h2>
          <div className="flex flex-col gap-1">
            {deployments.length === 0 && (
              <p className="text-sm text-zinc-500 px-1">No deployments yet. Click Redeploy to get started.</p>
            )}
            {deployments.map((deployment) => (
              <DeploymentRow key={deployment.id} projectId={project.id} deployment={deployment} />
            ))}
          </div>
        </div>

        <div>
          <div className="bg-zinc-950/80 rounded-2xl border border-zinc-800 p-5">
            <h2 className="text-sm font-semibold text-zinc-400 uppercase tracking-wider mb-3">Repository</h2>
            <dl className="text-sm flex flex-col gap-2.5">
              <div className="flex items-center justify-between">
                <dt className="text-zinc-500">Branch</dt>
                <dd className="flex items-center gap-1.5 font-mono text-zinc-300">
                  <GitBranch className="w-3.5 h-3.5" />
                  {project.defaultBranch}
                </dd>
              </div>
              <div className="flex items-center justify-between">
                <dt className="text-zinc-500">Total deploys</dt>
                <dd className="text-zinc-300">{deployments.length}</dd>
              </div>
            </dl>
          </div>
        </div>
      </div>
    </div>
  );
}
