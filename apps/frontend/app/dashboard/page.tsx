"use client";

import { useEffect, useState } from "react";
import { listProjects } from "../../lib/dashboard-api";
import type { ProjectWithLatestDeployment } from "../../lib/dashboard-types";
import { ProjectCard } from "../../components/dashboard/ProjectCard";
import { EmptyProjectsState } from "../../components/dashboard/EmptyState";

export default function DashboardPage() {
  const [projects, setProjects] = useState<ProjectWithLatestDeployment[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listProjects()
      .then(setProjects)
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load projects"));
  }, []);

  if (error) {
    return <p className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-4 py-3">{error}</p>;
  }

  if (!projects) {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {[...Array(3)].map((_, i) => (
          <div key={i} className="h-44 rounded-2xl border border-zinc-800 bg-zinc-950/40 animate-pulse" />
        ))}
      </div>
    );
  }

  if (projects.length === 0) return <EmptyProjectsState />;

  return (
    <div>
      <h1 className="text-2xl font-bold mb-6">Projects</h1>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {projects.map((project) => (
          <ProjectCard key={project.id} project={project} />
        ))}
      </div>
    </div>
  );
}
