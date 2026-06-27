"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { listDeployments } from "@/lib/dashboard-api";
import type { Deployment } from "@/lib/dashboard-types";
import { useProject } from "@/lib/project-context";
import { DeploymentFilterBar, type DeploymentFilters } from "@/components/dashboard/DeploymentFilterBar";
import { DeploymentListRow } from "@/components/dashboard/DeploymentListRow";

const EMPTY_FILTERS: DeploymentFilters = { branch: "", status: "", environment: "", dateFrom: "", dateTo: "" };

export default function DeploymentsListPage() {
  const { project } = useProject();

  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState<DeploymentFilters>(EMPTY_FILTERS);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); // eslint-disable-line react-hooks/set-state-in-effect -- must reset before async
    setError(null);
    listDeployments(project.id, {
      limit: 20,
      branch: filters.branch || undefined,
      status: filters.status || undefined,
      environment: filters.environment || undefined,
      dateFrom: filters.dateFrom || undefined,
      dateTo: filters.dateTo || undefined,
    })
      .then(({ deployments, nextCursor }) => {
        if (!controller.signal.aborted) {
          setDeployments(deployments);
          setNextCursor(nextCursor);
        }
      })
      .catch((err) => {
        if (!controller.signal.aborted) setError(err instanceof Error ? err.message : "Failed to load deployments");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [project.id, filters]);

  async function handleLoadMore() {
    if (!nextCursor) return;
    setLoadingMore(true);
    try {
      const { deployments: more, nextCursor: newCursor } = await listDeployments(project.id, {
        cursor: nextCursor,
        limit: 20,
        branch: filters.branch || undefined,
        status: filters.status || undefined,
        environment: filters.environment || undefined,
        dateFrom: filters.dateFrom || undefined,
        dateTo: filters.dateTo || undefined,
      });
      setDeployments((prev) => [...prev, ...more]);
      setNextCursor(newCursor);
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <div>
      <DeploymentFilterBar filters={filters} onChange={setFilters} />

      {error && (
        <p className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-4 py-3 mb-4">
          {error}
        </p>
      )}

      {loading ? (
        <div className="h-64 rounded-2xl border border-zinc-800 bg-zinc-950/40 animate-pulse" />
      ) : deployments.length === 0 ? (
        <p className="text-sm text-zinc-500 px-1">No deployments match these filters.</p>
      ) : (
        <>
          <div className="flex flex-col gap-1">
            {deployments.map((deployment) => (
              <DeploymentListRow key={deployment.id} projectId={project.id} deployment={deployment} />
            ))}
          </div>

          {nextCursor && (
            <button
              onClick={handleLoadMore}
              disabled={loadingMore}
              className="w-full mt-4 flex items-center justify-center gap-1.5 py-2 rounded-lg border border-zinc-800 bg-zinc-900/60 text-sm font-medium text-zinc-300 hover:bg-zinc-900 hover:text-white transition-colors disabled:opacity-50"
            >
              {loadingMore && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              Load more
            </button>
          )}
        </>
      )}
    </div>
  );
}
