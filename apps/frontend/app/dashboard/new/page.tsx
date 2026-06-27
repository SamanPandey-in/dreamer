"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight } from "lucide-react";
import { GithubIcon as Github } from "@/components/icons"
import { createDeployment, createProject } from "@/lib/dashboard-api";
import { repoNameFromUrl, slugPreview } from "@/lib/format";
import { API_BASE_URL } from "@/lib/config";
import { Button } from "@/components/ui/Button";

export default function NewProjectPage() {
  const router = useRouter();
  const [repoUrl, setRepoUrl] = useState("");
  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [defaultBranch, setDefaultBranch] = useState("main");
  const [description, setDescription] = useState("");
  const [isPrivate, setIsPrivate] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsGithubConnect, setNeedsGithubConnect] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  function handleRepoUrlChange(value: string) {
    setRepoUrl(value);
    // Auto-suggest a name from the URL until the user types their own —
    // mirrors Vercel's own "Import" screen, where the project name field
    // pre-fills from the repo but is always yours to override.
    if (!nameTouched) setName(repoNameFromUrl(value));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNeedsGithubConnect(false);
    setSubmitting(true);

    try {
      const project = await createProject({
        name,
        repoUrl,
        defaultBranch,
        description: description || undefined,
        isPrivate,
      });
      const deployment = await createDeployment(project.id);
      router.push(`/project/${project.id}/deployments/${deployment.id}`);
    } catch (err) {
      // GITHUB_NOT_CONNECTED isn't really an "error to read," it's a missing
      // step — surfacing it as a direct fix (a link, not just red text) is
      // worth special-casing this one code rather than treating it like any
      // other failed request. apiFetch's thrown Error only ever carries
      // `message`, not the original `code`, so this matches on the message
      // text the backend sends for that specific case (deployment.service.ts
      // §3.7) — slightly stringly-typed, but it's one string in one place.
      const message = err instanceof Error ? err.message : "Something went wrong. Please try again.";
      if (message.includes("Connect your GitHub account")) {
        setNeedsGithubConnect(true);
      } else {
        setError(message);
      }
      setSubmitting(false);
    }
  }

  return (
    <div className="max-w-lg mx-auto">
      <h1 className="text-2xl font-bold mb-1">Import Git Repository</h1>
      <p className="text-zinc-400 text-sm mb-8">Dreamer will clone, build, and deploy it for you.</p>

      <form onSubmit={handleSubmit} className="bg-zinc-950/80 rounded-2xl border border-zinc-800 p-6 flex flex-col gap-4">
        <div>
          <label htmlFor="repoUrl" className="block text-xs font-medium text-zinc-400 mb-1.5">
            Repository URL
          </label>
          <input
            id="repoUrl"
            type="url"
            required
            value={repoUrl}
            onChange={(e) => handleRepoUrlChange(e.target.value)}
            placeholder="https://github.com/you/your-app"
            className="w-full px-3 py-2.5 rounded-lg bg-zinc-900 border border-zinc-800 text-white text-sm placeholder:text-zinc-500 focus:outline-none focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/50 transition-colors font-mono"
          />
        </div>

        <div>
          <label htmlFor="name" className="block text-xs font-medium text-zinc-400 mb-1.5">
            Project Name
          </label>
          <input
            id="name"
            required
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setNameTouched(true);
            }}
            className="w-full px-3 py-2.5 rounded-lg bg-zinc-900 border border-zinc-800 text-white text-sm focus:outline-none focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/50 transition-colors"
          />
          {name && (
            <p className="text-xs text-zinc-500 mt-1.5 font-mono">
              {slugPreview(name)} <span className="text-zinc-600">— exact match if available, otherwise +random suffix</span>
            </p>
          )}
        </div>

        <div>
          <label htmlFor="branch" className="block text-xs font-medium text-zinc-400 mb-1.5">
            Production Branch
          </label>
          <input
            id="branch"
            value={defaultBranch}
            onChange={(e) => setDefaultBranch(e.target.value)}
            className="w-full px-3 py-2.5 rounded-lg bg-zinc-900 border border-zinc-800 text-white text-sm font-mono focus:outline-none focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/50 transition-colors"
          />
        </div>

        <div>
          <label htmlFor="description" className="block text-xs font-medium text-zinc-400 mb-1.5">
            Description <span className="text-zinc-600">(optional)</span>
          </label>
          <textarea
            id="description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            className="w-full px-3 py-2.5 rounded-lg bg-zinc-900 border border-zinc-800 text-white text-sm placeholder:text-zinc-500 focus:outline-none focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/50 transition-colors resize-none"
          />
        </div>

        <label className="flex items-center gap-2.5 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={isPrivate}
            onChange={(e) => setIsPrivate(e.target.checked)}
            className="w-4 h-4 rounded border-zinc-700 bg-zinc-900 text-blue-500 focus:ring-blue-500/50 focus:ring-offset-0"
          />
          <span className="text-sm text-zinc-300">This is a private repository</span>
        </label>

        {needsGithubConnect && (
          <div className="flex items-center justify-between gap-3 text-sm bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2.5">
            <span className="text-amber-200">Connect your GitHub account to deploy private repositories.</span>
            {/* Full page navigation, not apiFetch — this is the existing
                redirect-based OAuth flow (auth/auth.routes.ts's GET
                /api/auth/github), the same button login/page.tsx already
                uses. Re-running it also transparently upgrades an
                already-connected account to the wider `repo` scope from
                backend guide §3.7, if it was connected before that change. */}
            <a
              href={`${API_BASE_URL}/auth/github`}
              className="shrink-0 flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-zinc-100 text-zinc-900 text-xs font-medium hover:bg-white transition-colors"
            >
              <Github className="w-3.5 h-3.5" />
              Connect GitHub
            </a>
          </div>
        )}

        {error && (
          <p className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">{error}</p>
        )}

        <Button variant="primary" type="submit" loading={submitting} className="w-full mt-1">
          {!submitting && (
            <>
              Deploy
              <ArrowRight className="w-4 h-4" />
            </>
          )}
        </Button>
      </form>
    </div>
  );
}
