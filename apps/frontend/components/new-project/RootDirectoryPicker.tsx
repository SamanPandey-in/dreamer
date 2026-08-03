"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Folder, GitBranch, Loader2 } from "lucide-react";
import { listGithubRepoContents, listRepoBranches, describeApiError } from "@/lib/dashboard-api";
import type { RepoBranch, RepoEntry } from "@/lib/dashboard-types";
import { Button } from "@/components/ui/Button";

interface DirectoryNode {
  entry: RepoEntry;
  expanded: boolean;
  loading: boolean;
  error: string | null;
  children: DirectoryNode[] | null; // null = not yet fetched
}

/**
 * One row in the tree — recursive, since a directory can itself contain
 * directories. Only ever renders `dir` entries (files don't matter for a
 * root-directory picker, and aren't navigable further), matching what
 * screenshot 1 shows: every visible row is a folder.
 */
function DirectoryRow({
  node,
  depth,
  selectedPath,
  onSelect,
  onToggle,
}: {
  node: DirectoryNode;
  depth: number;
  selectedPath: string;
  onSelect: (path: string) => void;
  onToggle: (path: string) => void;
}) {
  const isSelected = selectedPath === node.entry.path;

  return (
    <div>
      <button
        type="button"
        onClick={() => onSelect(node.entry.path)}
        className={`w-full flex items-center gap-2 px-3 py-2.5 text-left transition-colors ${
          isSelected ? "bg-blue-500/10" : "hover:bg-zinc-900/60"
        }`}
        style={{ paddingLeft: `${12 + depth * 20}px` }}
      >
        <span
          role="button"
          tabIndex={-1}
          onClick={(e) => {
            e.stopPropagation();
            onToggle(node.entry.path);
          }}
          className="shrink-0 text-zinc-500 hover:text-zinc-300"
        >
          {node.loading ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : node.expanded ? (
            <ChevronDown className="w-3.5 h-3.5" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5" />
          )}
        </span>

        <input
          type="radio"
          checked={isSelected}
          onChange={() => onSelect(node.entry.path)}
          className="w-3.5 h-3.5 text-blue-500 focus:ring-blue-500/50 focus:ring-offset-0"
        />

        <Folder className="w-4 h-4 text-zinc-500 shrink-0" />
        <span className="text-sm text-zinc-200 truncate">{node.entry.name}</span>
      </button>

      {node.error && (
        <p className="text-xs text-red-400 px-3 py-1" style={{ paddingLeft: `${44 + depth * 20}px` }}>
          {node.error}
        </p>
      )}

      {node.expanded && node.children && (
        <div>
          {node.children.length === 0 ? (
            <p className="text-xs text-zinc-600 py-1.5" style={{ paddingLeft: `${44 + depth * 20}px` }}>
              No subfolders
            </p>
          ) : (
            node.children.map((child) => (
              <DirectoryRow
                key={child.entry.path}
                node={child}
                depth={depth + 1}
                selectedPath={selectedPath}
                onSelect={onSelect}
                onToggle={onToggle}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}

/** Finds a node by path anywhere in the tree, for updating it immutably after an async fetch resolves. */
function updateNodeByPath(
  nodes: DirectoryNode[],
  path: string,
  update: (node: DirectoryNode) => DirectoryNode
): DirectoryNode[] {
  return nodes.map((node) => {
    if (node.entry.path === path) return update(node);
    if (node.children) return { ...node, children: updateNodeByPath(node.children, path, update) };
    return node;
  });
}

export function RootDirectoryPicker({
  repoFullName,
  branch,
  onContinue,
  onCancel,
}: {
  repoFullName: string;
  /** The repo's actual default branch (from GitHub) — used to flag which
   * option in the branch dropdown is "(default)" and as the initial
   * selection, but the branch the user ends up building from is whatever
   * they pick, not necessarily this one. */
  branch: string;
  onContinue: (rootDirectory: string, branch: string) => void;
  onCancel: () => void;
}) {
  const [roots, setRoots] = useState<DirectoryNode[] | null>(null);
  const [rootError, setRootError] = useState<string | null>(null);
  // "" means the repo root itself — selectable from the start, matching
  // screenshot 1's "apps" row being pre-selected by default rather than
  // requiring the user to explicitly pick the top level first.
  const [selectedPath, setSelectedPath] = useState("");

  // NEW — which branch to deploy. Starts on the repo's default branch and
  // is fetched directly from GitHub so the user can pick any branch that
  // actually exists, not just type one in.
  const [selectedBranch, setSelectedBranch] = useState(branch);
  const [branches, setBranches] = useState<RepoBranch[] | null>(null);
  const [branchesError, setBranchesError] = useState<string | null>(null);
  const [branchesLoading, setBranchesLoading] = useState(true);

  const hasRequestedRoot = useRef(false);
  const hasRequestedBranches = useRef(false);

  async function loadRoot(forBranch: string) {
    setRootError(null);
    try {
      const entries = await listGithubRepoContents(repoFullName, forBranch, "");
      setRoots(
        entries
          .filter((e) => e.type === "dir")
          .map((entry) => ({ entry, expanded: false, loading: false, error: null, children: null }))
      );
    } catch (err) {
      setRootError(describeApiError(err, "Failed to load repository contents"));
    }
  }

  // Fires exactly once on mount — the ref (not just the `roots === null`
  // state check) is what prevents a second concurrent fetch firing during
  // the window where the first request is still in flight and `roots` is
  // still null.
  useEffect(() => {
    if (hasRequestedRoot.current) return;
    hasRequestedRoot.current = true;
    loadRoot(branch);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (hasRequestedBranches.current) return;
    hasRequestedBranches.current = true;
    listRepoBranches(repoFullName, branch)
      .then(setBranches)
      .catch((err) => setBranchesError(describeApiError(err, "Failed to load branches")))
      .finally(() => setBranchesLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Switching branches re-fetches the root listing for the new ref and
  // resets any selected/expanded folder state — a path selected on one
  // branch isn't guaranteed to exist on another.
  function handleBranchChange(nextBranch: string) {
    if (nextBranch === selectedBranch) return;
    setSelectedBranch(nextBranch);
    setSelectedPath("");
    setRoots(null);
    loadRoot(nextBranch);
  }

  async function toggleNode(path: string) {
    function findNode(nodes: DirectoryNode[]): DirectoryNode | null {
      for (const node of nodes) {
        if (node.entry.path === path) return node;
        if (node.children) {
          const found = findNode(node.children);
          if (found) return found;
        }
      }
      return null;
    }

    if (!roots) return;
    const node = findNode(roots);
    if (!node) return;

    // Collapsing never needs a fetch — just flip the flag.
    if (node.expanded) {
      setRoots((prev) => prev && updateNodeByPath(prev, path, (n) => ({ ...n, expanded: false })));
      return;
    }

    // Already fetched once — re-expand without hitting the API again.
    if (node.children !== null) {
      setRoots((prev) => prev && updateNodeByPath(prev, path, (n) => ({ ...n, expanded: true })));
      return;
    }

    setRoots((prev) => prev && updateNodeByPath(prev, path, (n) => ({ ...n, loading: true, error: null })));

    try {
      const entries = await listGithubRepoContents(repoFullName, selectedBranch, path);
      const children: DirectoryNode[] = entries
        .filter((e) => e.type === "dir")
        .map((entry) => ({ entry, expanded: false, loading: false, error: null, children: null }));

      setRoots(
        (prev) =>
          prev &&
          updateNodeByPath(prev, path, (n) => ({ ...n, loading: false, expanded: true, children }))
      );
    } catch (err) {
      const message = describeApiError(err, "Failed to load this folder");
      setRoots((prev) => prev && updateNodeByPath(prev, path, (n) => ({ ...n, loading: false, error: message })));
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4">
      <div className="w-full max-w-lg bg-zinc-950 border border-zinc-800 rounded-2xl shadow-2xl max-h-[85vh] flex flex-col">
        <div className="px-6 pt-6 pb-4 border-b border-zinc-800">
          <h2 className="text-xl font-bold mb-2">Root Directory</h2>
          <p className="text-sm text-zinc-400 mb-4">
            Select the directory containing your source code. For monorepos, create a separate project
            for each directory you want to deploy.
          </p>

          <label className="block text-xs font-medium text-zinc-400 mb-1.5">Branch to Deploy</label>
          <div className="relative">
            <GitBranch className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-zinc-500 pointer-events-none" />
            <select
              value={selectedBranch}
              onChange={(e) => handleBranchChange(e.target.value)}
              disabled={branchesLoading || !branches}
              className="w-full pl-8 pr-3 py-2 rounded-lg bg-zinc-900 border border-zinc-800 text-white text-sm font-mono focus:outline-none focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/50 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {branches
                ? branches.map((b) => (
                    <option key={b.name} value={b.name}>
                      {b.name}
                      {b.isDefault ? " (default)" : ""}
                    </option>
                  ))
                : (
                    <option value={selectedBranch}>{selectedBranch}</option>
                  )}
            </select>
            {branchesLoading && (
              <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-zinc-500 animate-spin" />
            )}
          </div>
          {branchesError && (
            <p className="text-xs text-amber-400/80 mt-1.5">
              Couldn&apos;t fetch branches from GitHub — deploying from &quot;{selectedBranch}&quot;.
            </p>
          )}
        </div>

        <div className="flex-1 overflow-y-auto py-2">
          {rootError && (
            <p className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg mx-4 my-2 px-3 py-2">
              {rootError}
            </p>
          )}

          {!roots && !rootError && (
            <div className="px-4 py-6 flex justify-center">
              <Loader2 className="w-4 h-4 animate-spin text-zinc-500" />
            </div>
          )}

          {/* The repo root itself — always selectable, listed above the folder tree. */}
          {roots && (
            <button
              type="button"
              onClick={() => setSelectedPath("")}
              className={`w-full flex items-center gap-2 px-3 py-2.5 text-left transition-colors ${
                selectedPath === "" ? "bg-blue-500/10" : "hover:bg-zinc-900/60"
              }`}
            >
              <span className="w-3.5 shrink-0" />
              <input
                type="radio"
                checked={selectedPath === ""}
                onChange={() => setSelectedPath("")}
                className="w-3.5 h-3.5 text-blue-500 focus:ring-blue-500/50 focus:ring-offset-0"
              />
              <Folder className="w-4 h-4 text-zinc-500 shrink-0" />
              <span className="text-sm text-zinc-200">/ (repository root)</span>
            </button>
          )}

          {roots?.map((node) => (
            <DirectoryRow
              key={node.entry.path}
              node={node}
              depth={1}
              selectedPath={selectedPath}
              onSelect={setSelectedPath}
              onToggle={toggleNode}
            />
          ))}
        </div>

        <div className="flex items-center justify-end gap-2 px-6 py-4 border-t border-zinc-800">
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => onContinue(selectedPath, selectedBranch)} disabled={!roots}>
            Continue
          </Button>
        </div>
      </div>
    </div>
  );
}
