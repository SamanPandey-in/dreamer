"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";
import { deleteProject, updateProject } from "@/lib/dashboard-api";
import { Button } from "@/components/ui/Button";
import { useProject } from "@/lib/project-context";
import { ConfirmModal } from "@/components/dashboard/ConfirmModal";

function SaveButton({ saving, saved }: { saving: boolean; saved: boolean }) {
  return (
    <Button variant="primary" type="submit" loading={saving}>
      {saving ? "Saving..." : saved ? "Saved" : "Save"}
    </Button>
  );
}

export default function ProjectSettingsPage() {
  const { project, refreshProject } = useProject();
  const router = useRouter();

  // General
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description ?? "");
  const [savingGeneral, setSavingGeneral] = useState(false);
  const [savedGeneral, setSavedGeneral] = useState(false);
  const [generalError, setGeneralError] = useState<string | null>(null);

  // Build & Development Settings
  const [buildCommand, setBuildCommand] = useState(project.buildCommand ?? "");
  const [installCommand, setInstallCommand] = useState(project.installCommand ?? "");
  const [outputDirectory, setOutputDirectory] = useState(project.outputDirectory ?? "");
  const [rootDirectory, setRootDirectory] = useState(project.rootDirectory ?? "");
  const [savingBuild, setSavingBuild] = useState(false);
  const [savedBuild, setSavedBuild] = useState(false);
  const [buildError, setBuildError] = useState<string | null>(null);

  // Git
  const [defaultBranch, setDefaultBranch] = useState(project.defaultBranch);
  const [autoDeployEnabled, setAutoDeployEnabled] = useState(project.autoDeployEnabled);
  const [savingGit, setSavingGit] = useState(false);
  const [savedGit, setSavedGit] = useState(false);
  const [gitError, setGitError] = useState<string | null>(null);

  // Danger zone
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  async function handleSaveGeneral(e: React.FormEvent) {
    e.preventDefault();
    setSavingGeneral(true);
    setGeneralError(null);
    try {
      await updateProject(project.id, { name, description: description || undefined });
      await refreshProject();
      setSavedGeneral(true);
      setTimeout(() => setSavedGeneral(false), 2000);
    } catch (err) {
      setGeneralError(err instanceof Error ? err.message : "Failed to save. Please try again.");
    } finally {
      setSavingGeneral(false);
    }
  }

  async function handleSaveBuild(e: React.FormEvent) {
    e.preventDefault();
    setSavingBuild(true);
    setBuildError(null);
    try {
      await updateProject(project.id, {
        buildCommand: buildCommand || undefined,
        installCommand: installCommand || undefined,
        outputDirectory: outputDirectory || undefined,
        rootDirectory: rootDirectory || undefined,
      });
      await refreshProject();
      setSavedBuild(true);
      setTimeout(() => setSavedBuild(false), 2000);
    } catch (err) {
      setBuildError(err instanceof Error ? err.message : "Failed to save. Please try again.");
    } finally {
      setSavingBuild(false);
    }
  }

  async function handleSaveGit(e: React.FormEvent) {
    e.preventDefault();
    setSavingGit(true);
    setGitError(null);
    try {
      await updateProject(project.id, { defaultBranch, autoDeployEnabled });
      await refreshProject();
      setSavedGit(true);
      setTimeout(() => setSavedGit(false), 2000);
    } catch (err) {
      setGitError(err instanceof Error ? err.message : "Failed to save. Please try again.");
    } finally {
      setSavingGit(false);
    }
  }

  async function handleDelete() {
    await deleteProject(project.id);
    router.push("/dashboard");
  }

  return (
    <div className="max-w-2xl flex flex-col gap-6">
      <form
        onSubmit={handleSaveGeneral}
        className="bg-zinc-950/80 rounded-2xl border border-zinc-800 p-5 flex flex-col gap-4"
      >
        <h2 className="text-sm font-semibold text-zinc-400 uppercase tracking-wider">General</h2>

        <div>
          <label className="block text-xs font-medium text-zinc-400 mb-1.5">Project Name</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            className="w-full px-3 py-2 rounded-lg bg-zinc-900 border border-zinc-800 text-white text-sm focus:outline-none focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/50 transition-colors"
          />
        </div>

        <div>
          <label className="block text-xs font-medium text-zinc-400 mb-1.5">Description</label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            className="w-full px-3 py-2 rounded-lg bg-zinc-900 border border-zinc-800 text-white text-sm focus:outline-none focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/50 transition-colors resize-none"
          />
        </div>

        {generalError && <p className="text-sm text-red-400">{generalError}</p>}

        <div className="flex justify-end">
          <SaveButton saving={savingGeneral} saved={savedGeneral} />
        </div>
      </form>

      <form
        onSubmit={handleSaveBuild}
        className="bg-zinc-950/80 rounded-2xl border border-zinc-800 p-5 flex flex-col gap-4"
      >
        <div>
          <div className="flex items-center gap-2 mb-2">
            <h2 className="text-sm font-semibold text-zinc-400 uppercase tracking-wider">
              Build &amp; Development Settings
            </h2>
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-500/10 text-amber-400 font-medium uppercase tracking-wide">
              Under development
            </span>
          </div>
          <p className="text-xs text-zinc-500 mb-3">
            These fields are saved to the database, but the build pipeline doesn&apos;t read them yet — every build still
            runs <code className="font-mono">npm ci &amp;&amp; npm run build</code> against the
            repo root.
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-medium text-zinc-400 mb-1.5">Build Command</label>
            <input
              value={buildCommand}
              onChange={(e) => setBuildCommand(e.target.value)}
              placeholder="npm run build"
              className="w-full px-3 py-2 rounded-lg bg-zinc-900 border border-zinc-800 text-white text-sm font-mono placeholder:text-zinc-500 focus:outline-none focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/50 transition-colors"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-zinc-400 mb-1.5">Install Command</label>
            <input
              value={installCommand}
              onChange={(e) => setInstallCommand(e.target.value)}
              placeholder="npm ci"
              className="w-full px-3 py-2 rounded-lg bg-zinc-900 border border-zinc-800 text-white text-sm font-mono placeholder:text-zinc-500 focus:outline-none focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/50 transition-colors"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-zinc-400 mb-1.5">Output Directory</label>
            <input
              value={outputDirectory}
              onChange={(e) => setOutputDirectory(e.target.value)}
              placeholder="dist"
              className="w-full px-3 py-2 rounded-lg bg-zinc-900 border border-zinc-800 text-white text-sm font-mono placeholder:text-zinc-500 focus:outline-none focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/50 transition-colors"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-zinc-400 mb-1.5">Root Directory</label>
            <input
              value={rootDirectory}
              onChange={(e) => setRootDirectory(e.target.value)}
              placeholder="."
              className="w-full px-3 py-2 rounded-lg bg-zinc-900 border border-zinc-800 text-white text-sm font-mono placeholder:text-zinc-500 focus:outline-none focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/50 transition-colors"
            />
          </div>
        </div>

        {buildError && <p className="text-sm text-red-400">{buildError}</p>}

        <div className="flex justify-end">
          <SaveButton saving={savingBuild} saved={savedBuild} />
        </div>
      </form>

      <form onSubmit={handleSaveGit} className="bg-zinc-950/80 rounded-2xl border border-zinc-800 p-5 flex flex-col gap-4">
        <h2 className="text-sm font-semibold text-zinc-400 uppercase tracking-wider">Git</h2>

        <div>
          <label className="block text-xs font-medium text-zinc-400 mb-1.5">Production Branch</label>
          <input
            value={defaultBranch}
            onChange={(e) => setDefaultBranch(e.target.value)}
            required
            className="w-full px-3 py-2 rounded-lg bg-zinc-900 border border-zinc-800 text-white text-sm font-mono focus:outline-none focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/50 transition-colors"
          />
          <p className="text-xs text-zinc-600 mt-1.5">
            Deploys of this branch are tagged Production; every other branch is tagged Preview.
          </p>
        </div>

        <label className="flex items-center gap-2.5 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={autoDeployEnabled}
            onChange={(e) => setAutoDeployEnabled(e.target.checked)}
            className="w-4 h-4 rounded border-zinc-700 bg-zinc-900 text-blue-500 focus:ring-blue-500/50 focus:ring-offset-0"
          />
          <span className="text-sm text-zinc-300">Automatically deploy on push</span>
          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-500/10 text-amber-400 font-medium uppercase tracking-wide">
            Under development
          </span>
        </label>
        <p className="text-xs text-zinc-500 -mt-2">
          No GitHub webhook listener yet — this toggle is stored for when push-triggered deploys ship.
        </p>

        {gitError && <p className="text-sm text-red-400">{gitError}</p>}

        <div className="flex justify-end">
          <SaveButton saving={savingGit} saved={savedGit} />
        </div>
      </form>

      <div className="bg-red-500/5 rounded-2xl border border-red-500/20 p-5">
        <h2 className="text-sm font-semibold text-red-400 uppercase tracking-wider mb-2">Danger Zone</h2>
        <p className="text-xs text-zinc-500 mb-3">
          Deletes the project and takes down its live deployment. This can&apos;t be undone.
        </p>
        <button
          onClick={() => setConfirmingDelete(true)}
          className="flex items-center gap-1.5 text-sm text-red-400 hover:text-red-300 font-medium"
        >
          <Trash2 className="w-3.5 h-3.5" />
          Delete Project
        </button>
      </div>

      {confirmingDelete && (
        <ConfirmModal
          title={`Delete "${project.name}"?`}
          description="This deletes the project and takes down its live deployment immediately. This can't be undone."
          confirmLabel="Delete project"
          destructive
          onConfirm={handleDelete}
          onClose={() => setConfirmingDelete(false)}
        />
      )}
    </div>
  );
}
