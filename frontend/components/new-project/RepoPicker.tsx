"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { GitBranch, Lock, Search, KeyRound, ArrowRight } from "lucide-react";
import { listGithubRepos, describeApiError, getErrorRequestId } from "@/lib/dashboard-api";
import type { GithubRepoSummary } from "@/lib/dashboard-types";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { PublicRepoSearch } from "./PublicRepoSearch";

/** Renders "6h ago" / "Jun 21" — recent activity gets a relative time, older
 * activity gets a short absolute date, since "3 months ago" is less useful
 * than just seeing the date at that point. */
function formatRepoUpdatedAt(iso: string): string {
  const date = new Date(iso);
  const hoursAgo = (Date.now() - date.getTime()) / (1000 * 60 * 60);

  if (hoursAgo < 24) {
    const hours = Math.max(1, Math.round(hoursAgo));
    return `${hours}h ago`;
  }
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function RepoRow({ repo, onSelect }: { repo: GithubRepoSummary; onSelect: (repo: GithubRepoSummary) => void }) {
  return (
    <button
      onClick={() => onSelect(repo)}
      className="w-full flex items-center justify-between px-4 py-3.5 hover:bg-zinc-900/40 transition-colors text-left"
    >
      <div className="flex items-center gap-2.5 min-w-0">
        <GitBranch className="w-4 h-4 text-zinc-500 shrink-0" />
        <span className="text-sm font-medium text-zinc-100 truncate">{repo.fullName}</span>
        {repo.isPrivate && <Lock className="w-3 h-3 text-zinc-500 shrink-0" />}
        <span className="text-xs text-zinc-500 shrink-0">· {formatRepoUpdatedAt(repo.updatedAt)}</span>
      </div>
    </button>
  );
}

/**
 * No git PAT set yet — see
 * docs/architecture/local-engine-auth-and-networking.md Decision 2. Public
 * repos still work with no token at all, so this isn't a hard stop — just
 * a pointer to Settings, alongside the public-repo search that works
 * regardless.
 *
 * The two paths get deliberate visual hierarchy: setting up the token is
 * the highlighted callout with its own CTA (it unlocks the full flow —
 * your own repos, private ones included), while public-repo search stays
 * visually quiet below as the zero-setup fallback.
 */
function NoGitToken({ onSelect }: { onSelect: (repo: GithubRepoSummary) => void }) {
  return (
    <div className="max-w-2xl">
      <h1 className="text-2xl font-bold mb-5">Import Git Repository</h1>

      {/* Primary path — set up the PAT. Icon-tile layout mirrors
          GitTokenPrompt on the destination page, so Settings feels familiar
          when you land there; #git scrolls straight to that form. */}
      <div className="rounded-xl border border-blue-500/20 bg-blue-500/[0.05] p-4 flex items-start gap-3">
        <div className="w-9 h-9 rounded-lg bg-blue-500/10 border border-blue-500/20 flex items-center justify-center shrink-0">
          <KeyRound className="w-[18px] h-[18px] text-blue-400" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-zinc-100">Connect GitHub to import your own repositories</p>
          <p className="text-sm text-zinc-400 mt-1">
            No git Personal Access Token is set yet. Add one and your repos — including private ones — show up here to pick from.
          </p>
          <Link href="/dashboard/account#git" className="mt-3 inline-block">
            <Button variant="primary">
              Set up in Settings
              <ArrowRight className="w-4 h-4" />
            </Button>
          </Link>
        </div>
      </div>

      {/* Secondary path — works with zero setup. */}
      <PublicRepoSearch onSelect={onSelect} />
    </div>
  );
}

export function RepoPicker({ onSelect }: { onSelect: (repo: GithubRepoSummary) => void }) {
  const [repos, setRepos] = useState<GithubRepoSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorRequestId, setErrorRequestId] = useState<string | undefined>(undefined);
  const [query, setQuery] = useState("");

  useEffect(() => {
    listGithubRepos()
      .then(setRepos)
      .catch((err) => {
        setError(describeApiError(err, "Failed to load repositories"));
        setErrorRequestId(getErrorRequestId(err));
      });
  }, []);

  const filtered = repos?.filter((r) => r.name.toLowerCase().includes(query.toLowerCase())) ?? null;

  if (repos && repos.length === 0) {
    return <NoGitToken onSelect={onSelect} />;
  }

  return (
    <div className="max-w-2xl">
      <h1 className="text-2xl font-bold mb-5">Import Git Repository</h1>

      {error ? (
        <>
          <Alert variant="error" requestId={errorRequestId}>
            {error}
          </Alert>
          <PublicRepoSearch onSelect={onSelect} />
        </>
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
              [...Array(4)].map((_, i) => <div key={i} className="h-14 bg-zinc-950/40 animate-pulse" />)}

            {filtered?.length === 0 && (
              <p className="text-sm text-zinc-500 px-4 py-6 text-center">No repositories match &quot;{query}&quot;</p>
            )}

            {filtered?.map((repo) => <RepoRow key={repo.repositoryId} repo={repo} onSelect={onSelect} />)}
          </div>

          <PublicRepoSearch onSelect={onSelect} />
        </>
      )}
    </div>
  );
}
