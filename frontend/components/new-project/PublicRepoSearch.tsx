"use client";

import { useState } from "react";
import { GitBranch, Lock, Search, Loader2 } from "lucide-react";
import { searchPublicRepos, describeApiError, getErrorRequestId } from "@/lib/dashboard-api";
import type { GithubRepoSummary } from "@/lib/dashboard-types";
import { Button } from "@/components/ui/Button";
import { Alert } from "@/components/ui/Alert";

/**
 * Search ANY public GitHub repo by name — deliberately separate from the
 * PAT-backed repo list above it (RepoPicker.tsx), not a filter on top of
 * it. Works even with no PAT set at all — useful for a repo the operator
 * doesn't own/collaborate on, so it wouldn't show up in that list. See
 * docs/architecture/local-engine-auth-and-networking.md Decision 2.
 *
 * This is a plain text query, not a URL paste — matches how the PAT-backed
 * list above it works (pick from a list of names, not paste a link), and
 * means the same repositoryId ends up on the project either way.
 */
export function PublicRepoSearch({ onSelect }: { onSelect: (repo: GithubRepoSummary) => void }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<GithubRepoSummary[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorRequestId, setErrorRequestId] = useState<string | undefined>(undefined);

  async function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    if (!query.trim()) return;

    setSearching(true);
    setError(null);
    try {
      setResults(await searchPublicRepos(query.trim()));
    } catch (err) {
      setError(describeApiError(err, "Failed to search GitHub repositories"));
      setErrorRequestId(getErrorRequestId(err));
      setResults(null);
    } finally {
      setSearching(false);
    }
  }

  return (
    <div className="mt-8">
      <h2 className="text-sm font-medium text-zinc-300 mb-1">Import any public repository</h2>
      <p className="text-xs text-zinc-500 mb-3">
        Not yours, or no git token set? Search any public GitHub repo by name — you can deploy and redeploy it right
        away.
      </p>

      <form onSubmit={handleSearch} className="relative mb-3">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search public repositories by name…"
          className="w-full pl-9 pr-24 py-2 rounded-lg bg-zinc-900 border border-zinc-800 text-white text-sm placeholder:text-zinc-500 focus:outline-none focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/50 transition-colors"
        />
        <Button
          type="submit"
          variant="secondary"
          disabled={searching || !query.trim()}
          className="absolute right-1.5 top-1/2 -translate-y-1/2 px-3 py-1"
        >
          {searching ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Search"}
        </Button>
      </form>

      {error && (
        <Alert variant="error" requestId={errorRequestId} className="mb-3">
          {error}
        </Alert>
      )}

      {results && (
        <div className="border border-zinc-800 rounded-xl divide-y divide-zinc-800 overflow-hidden">
          {results.length === 0 && (
            <p className="text-sm text-zinc-500 px-4 py-6 text-center">No public repositories match &quot;{query}&quot;</p>
          )}
          {results.map((repo) => (
            <div key={repo.repositoryId} className="flex items-center justify-between px-4 py-3.5 hover:bg-zinc-900/40 transition-colors">
              <div className="flex items-center gap-2.5 min-w-0">
                <GitBranch className="w-4 h-4 text-zinc-500 shrink-0" />
                <span className="text-sm font-medium text-zinc-100 truncate">{repo.fullName}</span>
                {repo.isPrivate && <Lock className="w-3 h-3 text-zinc-500 shrink-0" />}
              </div>
              <Button variant="secondary" onClick={() => onSelect(repo)} className="shrink-0">
                Import
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
