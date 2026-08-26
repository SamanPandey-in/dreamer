"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Pencil, Trash2 } from "lucide-react";
import {
  createDeployment,
  deleteProject,
  listRepoBranches,
  updateProject,
  describeApiError,
} from "@/lib/dashboard-api";
import type { RepoBranch } from "@/lib/dashboard-types";
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
  const [buildEditing, setBuildEditing] = useState(false);
  const [showRedeployPopup, setShowRedeployPopup] = useState(false);
  const [redeploying, setRedeploying] = useState(false);
  const redeployTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [buildSnapshot, setBuildSnapshot] = useState({
    buildCommand: project.buildCommand ?? "",
    installCommand: project.installCommand ?? "",
    outputDirectory: project.outputDirectory ?? "",
    rootDirectory: project.rootDirectory ?? "",
  });

  const buildHasChanges =
    buildCommand !== buildSnapshot.buildCommand ||
    installCommand !== buildSnapshot.installCommand ||
    outputDirectory !== buildSnapshot.outputDirectory ||
    rootDirectory !== buildSnapshot.rootDirectory;

  const dismissRedeployPopup = useCallback(() => {
    if (redeployTimerRef.current) {
      clearTimeout(redeployTimerRef.current);
      redeployTimerRef.current = null;
    }
    setShowRedeployPopup(false);
  }, []);

  useEffect(() => {
    return () => {
      if (redeployTimerRef.current) clearTimeout(redeployTimerRef.current);
    };
  }, []);

  // Git
  const [defaultBranch, setDefaultBranch] = useState(project.defaultBranch);
  const [autoDeployEnabled, setAutoDeployEnabled] = useState(project.autoDeployEnabled);
  const [savingGit, setSavingGit] = useState(false);
  const [savedGit, setSavedGit] = useState(false);
  const [gitError, setGitError] = useState<string | null>(null);
  const [gitEditing, setGitEditing] = useState(false);

  const [gitSnapshot, setGitSnapshot] = useState({
    defaultBranch: project.defaultBranch,
    autoDeployEnabled: project.autoDeployEnabled,
  });

  const gitHasChanges =
    defaultBranch !== gitSnapshot.defaultBranch ||
    autoDeployEnabled !== gitSnapshot.autoDeployEnabled;

  // NEW — branches fetched directly from GitHub, so "Production Branch"
  // is a dropdown of what actually exists on the repo rather than a free-text
  // field the user could typo. Falls back to the existing text input if the
  // list can't be fetched (repo not linked, GitHub call fails, etc.) so this
  // panel never becomes unusable because of a GitHub hiccup.
  const [branches, setBranches] = useState<RepoBranch[] | null>(null);
  const [branchesLoading, setBranchesLoading] = useState(false);
  const [branchesError, setBranchesError] = useState<string | null>(null);
  const hasRequestedBranches = useRef(false);

  useEffect(() => {
    if (hasRequestedBranches.current || !project.repoFullName) return;
    hasRequestedBranches.current = true;

    setBranchesLoading(true);
    listRepoBranches(project.repoFullName, project.defaultBranch)
      .then(setBranches)
      .catch((err) => setBranchesError(describeApiError(err, "Failed to load branches")))
      .finally(() => setBranchesLoading(false));
  }, [project.repoFullName, project.defaultBranch]);

  // The currently-saved branch is always selectable even if it's somehow
  // missing from what GitHub returned (renamed/deleted upstream) — the
  // dropdown shouldn't silently swap the project's stored branch just
  // because the fetched list doesn't happen to include it.
  const branchOptions =
    branches && !branches.some((b) => b.name === defaultBranch)
      ? [{ name: defaultBranch, isDefault: false }, ...branches]
      : branches;

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
      setGeneralError(describeApiError(err, "Failed to save. Please try again."));
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
      setBuildSnapshot({
        buildCommand,
        installCommand,
        outputDirectory,
        rootDirectory,
      });
      setBuildEditing(false);
      setSavedBuild(true);
      setTimeout(() => setSavedBuild(false), 2000);

      setShowRedeployPopup(true);
      if (redeployTimerRef.current) clearTimeout(redeployTimerRef.current);
      redeployTimerRef.current = setTimeout(() => {
        setShowRedeployPopup(false);
        redeployTimerRef.current = null;
      }, 10000);
    } catch (err) {
      setBuildError(describeApiError(err, "Failed to save. Please try again."));
    } finally {
      setSavingBuild(false);
    }
  }

  async function handleRedeploy() {
    dismissRedeployPopup();
    setRedeploying(true);
    try {
      const deployment = await createDeployment(project.id);
      router.push(`/project/${project.id}/deployments/${deployment.id}`);
    } catch {
      setBuildError("Failed to start redeploy. Please try again.");
      setRedeploying(false);
    }
  }

  async function handleSaveGit(e: React.FormEvent) {
    e.preventDefault();
    setSavingGit(true);
    setGitError(null);
    try {
      await updateProject(project.id, { defaultBranch, autoDeployEnabled });
      await refreshProject();
      setGitSnapshot({
        defaultBranch,
        autoDeployEnabled,
      });
      setGitEditing(false);
      setSavedGit(true);
      setTimeout(() => setSavedGit(false), 2000);

      if (defaultBranch !== gitSnapshot.defaultBranch) {
        setShowRedeployPopup(true);
        if (redeployTimerRef.current) clearTimeout(redeployTimerRef.current);
        redeployTimerRef.current = setTimeout(() => {
          setShowRedeployPopup(false);
          redeployTimerRef.current = null;
        }, 10000);
      }
    } catch (err) {
      setGitError(describeApiError(err, "Failed to save. Please try again."));
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
          <h2 className="text-sm font-semibold text-zinc-400 uppercase tracking-wider mb-2">
            Build &amp; Development Settings
          </h2>
          <p className="text-xs text-zinc-500 mb-3">
            These values are passed to the build pipeline as environment variables and override the
            defaults for install command, build command, output directory, and root directory.
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-medium text-zinc-400 mb-1.5">Build Command</label>
            <input
              value={buildCommand}
              onChange={(e) => setBuildCommand(e.target.value)}
              placeholder="npm run build"
              readOnly={!buildEditing}
              className="w-full px-3 py-2 rounded-lg bg-zinc-900 border border-zinc-800 text-white text-sm font-mono placeholder:text-zinc-500 focus:outline-none focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/50 transition-colors read-only:opacity-60 read-only:cursor-not-allowed"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-zinc-400 mb-1.5">Install Command</label>
            <input
              value={installCommand}
              onChange={(e) => setInstallCommand(e.target.value)}
              placeholder="npm ci"
              readOnly={!buildEditing}
              className="w-full px-3 py-2 rounded-lg bg-zinc-900 border border-zinc-800 text-white text-sm font-mono placeholder:text-zinc-500 focus:outline-none focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/50 transition-colors read-only:opacity-60 read-only:cursor-not-allowed"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-zinc-400 mb-1.5">Output Directory</label>
            <input
              value={outputDirectory}
              onChange={(e) => setOutputDirectory(e.target.value)}
              placeholder="dist"
              readOnly={!buildEditing}
              className="w-full px-3 py-2 rounded-lg bg-zinc-900 border border-zinc-800 text-white text-sm font-mono placeholder:text-zinc-500 focus:outline-none focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/50 transition-colors read-only:opacity-60 read-only:cursor-not-allowed"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-zinc-400 mb-1.5">Root Directory</label>
            <input
              value={rootDirectory}
              onChange={(e) => setRootDirectory(e.target.value)}
              placeholder="."
              readOnly={!buildEditing}
              className="w-full px-3 py-2 rounded-lg bg-zinc-900 border border-zinc-800 text-white text-sm font-mono placeholder:text-zinc-500 focus:outline-none focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/50 transition-colors read-only:opacity-60 read-only:cursor-not-allowed"
            />
          </div>
        </div>

        {buildError && <p className="text-sm text-red-400">{buildError}</p>}

        <div className="flex justify-end gap-2">
          {buildEditing ? (
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setBuildEditing(false);
                setBuildCommand(buildSnapshot.buildCommand);
                setInstallCommand(buildSnapshot.installCommand);
                setOutputDirectory(buildSnapshot.outputDirectory);
                setRootDirectory(buildSnapshot.rootDirectory);
              }}
            >
              Cancel
            </Button>
          ) : (
            <Button type="button" variant="ghost" onClick={() => setBuildEditing(true)}>
              <Pencil className="w-3.5 h-3.5" />
              Edit
            </Button>
          )}
          <Button
            variant="primary"
            type="submit"
            loading={savingBuild}
            disabled={!buildEditing || !buildHasChanges}
          >
            {savingBuild ? "Saving..." : savedBuild ? "Saved" : "Save"}
          </Button>
        </div>
      </form>

      <form onSubmit={handleSaveGit} className="bg-zinc-950/80 rounded-2xl border border-zinc-800 p-5 flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-zinc-400 uppercase tracking-wider">Git</h2>
        </div>

        <div>
          <label className="block text-xs font-medium text-zinc-400 mb-1.5">Production Branch</label>

          {branchOptions ? (
            <select
              value={defaultBranch}
              onChange={(e) => setDefaultBranch(e.target.value)}
              disabled={!gitEditing}
              className="w-full px-3 py-2 rounded-lg bg-zinc-900 border border-zinc-800 text-white text-sm font-mono focus:outline-none focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/50 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {branchOptions.map((b) => (
                <option key={b.name} value={b.name}>
                  {b.name}
                  {b.isDefault ? " (default)" : ""}
                </option>
              ))}
            </select>
          ) : (
            <div className="relative">
              <input
                value={defaultBranch}
                onChange={(e) => setDefaultBranch(e.target.value)}
                required
                readOnly={!gitEditing}
                className="w-full px-3 py-2 rounded-lg bg-zinc-900 border border-zinc-800 text-white text-sm font-mono focus:outline-none focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/50 transition-colors read-only:opacity-60 read-only:cursor-not-allowed"
              />
              {branchesLoading && (
                <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500 animate-spin" />
              )}
            </div>
          )}

          {branchesError && (
            <p className="text-xs text-amber-400/80 mt-1.5">
              Couldn&apos;t fetch branches from GitHub — you can still type a branch name directly.
            </p>
          )}

          <p className="text-xs text-zinc-600 mt-1.5">
            Deploys of this branch are tagged Production; every other branch is tagged Preview.
          </p>
        </div>

        <label className="flex items-center gap-2.5 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={autoDeployEnabled}
            disabled={!gitEditing}
            onChange={(e) => setAutoDeployEnabled(e.target.checked)}
            className="w-4 h-4 rounded border-zinc-700 bg-zinc-900 text-blue-500 focus:ring-blue-500/50 focus:ring-offset-0 disabled:opacity-60 disabled:cursor-not-allowed"
          />
          <span className="text-sm text-zinc-300">Automatically deploy on push</span>
          {project.autoDeployReady ? (
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 font-medium uppercase tracking-wide">
              Connected
            </span>
          ) : (
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-500/10 text-amber-400 font-medium uppercase tracking-wide">
              Not connected
            </span>
          )}
        </label>

        {project.autoDeployReady ? (
          <p className="text-xs text-zinc-500 -mt-2">
            A push to <span className="font-mono text-zinc-400">{defaultBranch}</span> redeploys this project automatically,
            pinned to the exact commit pushed — once push-to-deploy is configured (see the README&apos;s
            &quot;Optional: push-to-deploy on git push&quot; section).
          </p>
        ) : (
          <p className="text-xs text-zinc-500 -mt-2">
            This project isn&apos;t linked to a repository ID, so a push can never trigger a deploy for it — that
            normally only happens for a project created outside the Import wizard. Manual deploys still work
            regardless.
          </p>
        )}

        {gitError && <p className="text-sm text-red-400">{gitError}</p>}

        <div className="flex justify-end gap-2">
          {gitEditing ? (
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setGitEditing(false);
                setDefaultBranch(gitSnapshot.defaultBranch);
                setAutoDeployEnabled(gitSnapshot.autoDeployEnabled);
              }}
            >
              Cancel
            </Button>
          ) : (
            <Button type="button" variant="ghost" onClick={() => setGitEditing(true)}>
              <Pencil className="w-3.5 h-3.5" />
              Edit
            </Button>
          )}
          <Button
            variant="primary"
            type="submit"
            loading={savingGit}
            disabled={!gitEditing || !gitHasChanges}
          >
            {savingGit ? "Saving..." : savedGit ? "Saved" : "Save"}
          </Button>
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
          confirmationPhrase={`permanently delete ${project.name}`}
          onConfirm={handleDelete}
          onClose={() => setConfirmingDelete(false)}
        />
      )}

      {showRedeployPopup && (
        <div className="fixed bottom-5 right-5 z-50 animate-in slide-in-from-bottom-5 fade-in duration-300">
          <div className="bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl p-4 flex flex-col gap-3 w-80">
            <p className="text-sm text-zinc-200">Want to redeploy with the updated settings?</p>
            <div className="flex gap-2">
              <Button
                variant="primary"
                loading={redeploying}
                onClick={handleRedeploy}
                className="flex-1"
              >
                Redeploy
              </Button>
              <Button variant="ghost" onClick={dismissRedeployPopup} className="flex-1">
                Dismiss
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
