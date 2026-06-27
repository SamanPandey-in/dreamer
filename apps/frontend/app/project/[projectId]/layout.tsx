"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, ExternalLink, GitBranch } from "lucide-react";
import { RequireAuth } from "@/app/require-auth";
import { DashboardShell } from "@/components/dashboard/DashboardShell";
import { ProjectTabs } from "@/components/dashboard/ProjectTabs";
import { ProjectProvider } from "@/lib/project-context";
import { getProject } from "@/lib/dashboard-api";
import type { Project } from "@/lib/dashboard-types";

export default function ProjectLayout({ children }: { children: React.ReactNode }) {
  const { projectId } = useParams<{ projectId: string }>();
  const [project, setProject] = useState<Project | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadProject = useCallback(async () => {
    try {
      const data = await getProject(projectId);
      setProject(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load project");
    }
  }, [projectId]);

  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      try {
        const data = await getProject(projectId);
        if (!controller.signal.aborted) {
          setProject(data);
          setError(null);
        }
      } catch (err) {
        if (!controller.signal.aborted) {
          setError(err instanceof Error ? err.message : "Failed to load project");
        }
      }
    })();
    return () => controller.abort();
  }, [projectId]);

  return (
    <RequireAuth>
      <DashboardShell>
        <div className="flex flex-col gap-6">
          <div>
            <Link
              href="/dashboard"
              className="inline-flex items-center gap-1.5 text-sm text-zinc-500 hover:text-zinc-300 transition-colors mb-3"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              All projects
            </Link>

            {error ? (
              <p className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-4 py-3">
                {error}
              </p>
            ) : !project ? (
              <div className="h-8 w-48 bg-zinc-900 rounded-md animate-pulse" />
            ) : (
              <div className="flex items-center justify-between flex-wrap gap-3">
                <h1 className="text-2xl font-bold tracking-tight">{project.name}</h1>
                <a
                  href={project.repoUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-1.5 text-sm text-zinc-500 hover:text-zinc-300 transition-colors font-mono"
                >
                  <GitBranch className="w-3.5 h-3.5" />
                  {project.repoFullName ?? project.repoUrl}
                  <ExternalLink className="w-3 h-3" />
                </a>
              </div>
            )}
          </div>

          {project && <ProjectTabs projectId={projectId} />}

          {project ? (
            <ProjectProvider project={project} refreshProject={loadProject}>
              {children}
            </ProjectProvider>
          ) : !error ? (
            <div className="h-64 rounded-2xl border border-zinc-800 bg-zinc-950/40 animate-pulse" />
          ) : null}
        </div>
      </DashboardShell>
    </RequireAuth>
  );
}
