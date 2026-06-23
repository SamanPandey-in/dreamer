"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Loader2 } from "lucide-react";
import { createDeployment, createProject } from "../../../lib/dashboard-api";
import { repoNameFromUrl } from "../../../lib/format";

export default function NewProjectPage() {
  const router = useRouter();
  const [repoUrl, setRepoUrl] = useState("");
  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [defaultBranch, setDefaultBranch] = useState("main");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
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
    setSubmitting(true);

    try {
      const project = await createProject({
        name,
        repoUrl,
        defaultBranch,
        description: description || undefined,
      });
      const deployment = await createDeployment(project.id);
      router.push(`/dashboard/projects/${project.id}/deployments/${deployment.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong. Please try again.");
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

        {error && (
          <p className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">{error}</p>
        )}

        <button
          type="submit"
          disabled={submitting}
          className="flex items-center justify-center gap-2 w-full py-2.5 mt-1 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 disabled:opacity-60 text-white font-medium rounded-lg shadow-lg shadow-blue-500/20 transition-all"
        >
          {submitting ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <>
              Deploy
              <ArrowRight className="w-4 h-4" />
            </>
          )}
        </button>
      </form>
    </div>
  );
}
