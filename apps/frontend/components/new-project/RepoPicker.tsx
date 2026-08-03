"use client";

import { useEffect, useState } from "react";
import { Globe, GitBranch, Loader2, Lock, Search } from "lucide-react";
import { listUserRepos, searchPublicRepos, describeApiError } from "@/lib/dashboard-api";
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

/** One repo row — shared by both "Your Repositories" and the public-repo
 * search results, since the two lists behave identically once a repo is
 * chosen (same onSelect, same wizard steps that follow). */
function RepoRow({ repo, onSelect }: { repo: UserRepoSummary; onSelect: (repo: UserRepoSummary) => void }) {
  return (
    <div className="flex items-center justify-between px-4 py-3.5 hover:bg-zinc-900/40 transition-colors">
      <div className="flex items-center gap-2.5 min-w-0">
        <GitBranch className="w-4 h-4 text-zinc-500 shrink-0" />
        <span className="text-sm font-medium text-zinc-100 truncate">{repo.fullName}</span>
        {repo.isPrivate && <Lock className="w-3 h-3 text-zinc-500 shrink-0" />}
        <span className="text-xs text-zinc-500 shrink-0">· {formatRepoUpdatedAt(repo.updatedAt)}</span>
      </div>
      <Button variant="secondary" onClick={() => onSelect(repo)} className="shrink-0">
        Import
      </Button>
    </div>
  );
}

/**
 * NEW — the "any other publicly available GitHub repo" search bar. Sits
 * above "Your Repositories" and follows the exact same onSelect contract, so
 * a repo found here drops into the same pick-root-directory /
 * configure-build / env-vars-and-deploy steps a user's own repo would.
 *
 * Debounced rather than searching on every keystroke — GitHub's search
 * endpoint is both rate-limited and relatively slow, so firing a request per
 * keystroke would waste calls on queries the user hasn't finished typing.
 * Doesn't search below 2 characters — a 1-character query against GitHub's
 * global repo index returns noise, not a useful narrowing.
 */
/**
 * Extracts "owner/repo" from a GitHub URL like:
 *   https://github.com/owner/repo
 *   https://github.com/owner/repo.git
 * Falls back to the raw input for "owner/repo" or plain name searches.
 */
function normalizeRepoInput(input: string): string {
  const match = input.match(/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?$/);
  return match ? `${match[1]}/${match[2]}` : input;
}

function PublicRepoSearch({ onSelect }: { onSelect: (repo: UserRepoSummary) => void }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<UserRepoSummary[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hasValidQuery = query.trim().length >= 2;
  const visibleResults = hasValidQuery ? results : null;
  const visibleError = hasValidQuery ? error : null;
  const isSearching = hasValidQuery && searching;

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      return;
    }

    let cancelled = false;
    const timer = setTimeout(() => {
      if (cancelled) return;

      setSearching(true);
      setError(null);

      searchPublicRepos(normalizeRepoInput(trimmed))
        .then((repos) => {
          if (!cancelled) setResults(repos);
        })
        .catch((err) => {
          if (cancelled) return;
          setError(describeApiError(err, "Failed to search GitHub"));
          setResults(null);
        })
        .finally(() => {
          if (!cancelled) setSearching(false);
        });
    }, 400);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

  return (
    <div className="mb-6">
      <div className="relative mb-3">
        <Globe className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="any other publicly available Github repo"
          className="w-full pl-9 pr-9 py-2 rounded-lg bg-zinc-900 border border-zinc-800 text-white text-sm placeholder:text-zinc-500 focus:outline-none focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/50 transition-colors"
        />
        {isSearching && (
          <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500 animate-spin" />
        )}
      </div>

      {visibleError && (
        <p className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-4 py-3 mb-3">
          {visibleError}
        </p>
      )}

      {visibleResults && (
        <div className="border border-zinc-800 rounded-xl divide-y divide-zinc-800 overflow-hidden mb-1">
          {visibleResults.length === 0 ? (
            <p className="text-sm text-zinc-500 px-4 py-6 text-center">
              No public repositories match &quot;{query.trim()}&quot;
            </p>
          ) : (
            visibleResults.map((repo) => <RepoRow key={repo.fullName} repo={repo} onSelect={onSelect} />)
          )}
        </div>
      )}
    </div>
  );
}

export function RepoPicker({ onSelect }: { onSelect: (repo: UserRepoSummary) => void }) {
  const [repos, setRepos] = useState<UserRepoSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    listUserRepos()
      .then(setRepos)
      .catch((err) => setError(describeApiError(err, "Failed to load your repositories")));
  }, []);

  const filtered = repos?.filter((r) => r.name.toLowerCase().includes(query.toLowerCase())) ?? null;

  return (
    <div className="max-w-2xl">
      <h1 className="text-2xl font-bold mb-5">Import Git Repository</h1>

      <PublicRepoSearch onSelect={onSelect} />

      <h2 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-2.5">Your Repositories</h2>

      {error ? (
        <div className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-4 py-3">
          {error}
        </div>
      ) : (
        <>
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
        </>
      )}
    </div>
  );
}
