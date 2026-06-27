"use client";

import type { DeploymentStatus } from "@/lib/dashboard-types";

type DeploymentEnvironmentFilter = "PRODUCTION" | "PREVIEW";

export interface DeploymentFilters {
  branch: string;
  status: DeploymentStatus | "";
  environment: DeploymentEnvironmentFilter | "";
  dateFrom: string;
  dateTo: string;
}

const STATUS_OPTIONS: DeploymentStatus[] = [
  "QUEUED", "BUILDING", "UPLOADING", "STARTING", "RUNNING",
  "SLEEPING", "WAKING", "STOPPED", "FAILED", "CANCELLED", "ERROR",
];

export function DeploymentFilterBar({
  filters,
  onChange,
}: {
  filters: DeploymentFilters;
  onChange: (filters: DeploymentFilters) => void;
}) {
  function update<K extends keyof DeploymentFilters>(key: K, value: DeploymentFilters[K]) {
    onChange({ ...filters, [key]: value });
  }

  const hasActiveFilters = Boolean(
    filters.branch || filters.status || filters.environment || filters.dateFrom || filters.dateTo
  );

  return (
    <div className="flex flex-wrap items-center gap-2 mb-4">
      <input
        value={filters.branch}
        onChange={(e) => update("branch", e.target.value)}
        placeholder="Filter by branch"
        className="px-3 py-1.5 rounded-lg bg-zinc-900 border border-zinc-800 text-white text-sm font-mono placeholder:text-zinc-500 focus:outline-none focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/50 transition-colors w-44"
      />

      <select
        value={filters.status}
        onChange={(e) => update("status", e.target.value as DeploymentStatus | "")}
        className="px-3 py-1.5 rounded-lg bg-zinc-900 border border-zinc-800 text-white text-sm focus:outline-none focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/50 transition-colors"
      >
        <option value="">All statuses</option>
        {STATUS_OPTIONS.map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </select>

      <select
        value={filters.environment}
        onChange={(e) => update("environment", e.target.value as DeploymentEnvironmentFilter | "")}
        className="px-3 py-1.5 rounded-lg bg-zinc-900 border border-zinc-800 text-white text-sm focus:outline-none focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/50 transition-colors"
      >
        <option value="">All environments</option>
        <option value="PRODUCTION">Production</option>
        <option value="PREVIEW">Preview</option>
      </select>

      <input
        type="date"
        value={filters.dateFrom}
        onChange={(e) => update("dateFrom", e.target.value)}
        className="px-3 py-1.5 rounded-lg bg-zinc-900 border border-zinc-800 text-white text-sm focus:outline-none focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/50 transition-colors"
      />
      <span className="text-zinc-600 text-sm">to</span>
      <input
        type="date"
        value={filters.dateTo}
        onChange={(e) => update("dateTo", e.target.value)}
        className="px-3 py-1.5 rounded-lg bg-zinc-900 border border-zinc-800 text-white text-sm focus:outline-none focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/50 transition-colors"
      />

      {hasActiveFilters && (
        <button
          onClick={() => onChange({ branch: "", status: "", environment: "", dateFrom: "", dateTo: "" })}
          className="text-sm text-zinc-500 hover:text-zinc-300 transition-colors"
        >
          Clear filters
        </button>
      )}
    </div>
  );
}
