"use client";

import { useEffect, useState } from "react";
import { GitBranch, Lock, Search } from "lucide-react";
import { listUserRepos } from "@/lib/dashboard-api";
import type { UserRepoSummary } from "@/lib/dashboard-types";
import { Button } from "@/components/ui/Button";

/** Renders "6h ago" / "Jun 21" the same way the actual screenshot does — recent
 * activity gets a relative time, older activity gets a short absolute date,
 * since "3 months ago" is less useful than just seeing the date at that point. */
function formatRepoUpdatedAt(iso: string): string {
  const date = new Date(iso);
  const hoursAgo = (Date.now() - date.getTime()) / (1000 * 60 * 60);

  if (hoursAgo < 24) {
    const hours = Math.max(1, Math.round(hoursAgo));
    return `${hours}h ago`;
  }
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function RepoPicker({ onSelect }: { onSelect: (repo: UserRepoSummary) => void }) {
  const [repos, setRepos] = useState<UserRepoSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    listUserRepos()
      .then(setRepos)
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load your repositories"));
  }, []);

  if (error) {
    return (
      <div className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-4 py-3">
        {error}
      </div>
    );
  }

  const filtered = repos?.filter((r) => r.name.toLowerCase().includes(query.toLowerCase())) ?? null;

  return (
    <div className="max-w-2xl">
      <h1 className="text-2xl font-bold mb-5">Import Git Repository</h1>

      <div className="relative mb-4">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search…"
          className="w-full pl-9 pr-3 py-2 rounded-lg bg-zinc-900 border border-zinc-800 text-white text-sm placeholder:text-zinc-500 focus:outline-none focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/50 transition-colors"
        />
      </div>

      <div className="border border-zinc-800 rounded-xl divide-y divide-zinc-800 overflow-hidden">
        {!repos &&
          [...Array(4)].map((_, i) => (
            <div key={i} className="h-14 bg-zinc-950/40 animate-pulse" />
          ))}

        {filtered?.length === 0 && (
          <p className="text-sm text-zinc-500 px-4 py-6 text-center">No repositories match &quot;{query}&quot;</p>
        )}

        {filtered?.map((repo) => (
          <div key={repo.fullName} className="flex items-center justify-between px-4 py-3.5 hover:bg-zinc-900/40 transition-colors">
            <div className="flex items-center gap-2.5 min-w-0">
              <GitBranch className="w-4 h-4 text-zinc-500 shrink-0" />
              <span className="text-sm font-medium text-zinc-100 truncate">{repo.name}</span>
              {repo.isPrivate && <Lock className="w-3 h-3 text-zinc-500 shrink-0" />}
              <span className="text-xs text-zinc-500 shrink-0">· {formatRepoUpdatedAt(repo.updatedAt)}</span>
            </div>
            <Button variant="secondary" onClick={() => onSelect(repo)} className="shrink-0">
              Import
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}
