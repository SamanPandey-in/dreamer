"use client";

import { useState } from "react";
import { Check, Loader2, Trash2 } from "lucide-react";
import { GithubIcon } from "@/components/icons";
import { Button } from "@/components/ui/Button";
import { Alert } from "@/components/ui/Alert";
import { setGitToken, clearGitToken } from "@/lib/auth";
import { describeApiError, getErrorRequestId } from "@/lib/dashboard-api";

interface GitTokenPromptProps {
  /** Whether a token is already stored — from AuthUser.hasGitToken. The token itself is never sent back to the client, so this is all there is to show for "already set." */
  hasToken: boolean;
  /** Called after a successful save/remove, so the caller can refetch the user (hasGitToken changed) rather than this component owning that state. */
  onChange: () => void;
  /** Shown above the form — tailored per call site (Settings vs. the import wizard). */
  description: string;
}

/**
 * local-engine's replacement for the old GitHub OAuth "Connect" redirect —
 * see docs/architecture/local-engine-auth-and-networking.md Decision 2. No
 * redirect, no consent screen: paste a PAT, save it, done. The token is
 * write-only from here on — AuthUser only ever reports hasGitToken, so
 * there's nothing to prefill; "Update" just overwrites whatever's stored.
 */
export function GitTokenPrompt({ hasToken, onChange, description }: GitTokenPromptProps) {
  const [editing, setEditing] = useState(!hasToken);
  const [token, setToken] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [requestId, setRequestId] = useState<string | undefined>(undefined);

  async function handleSave() {
    if (!token.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      await setGitToken(token.trim());
      setToken("");
      setEditing(false);
      onChange();
    } catch (err) {
      setError(describeApiError(err, "Failed to save the token. Please try again."));
      setRequestId(getErrorRequestId(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleRemove() {
    setSubmitting(true);
    setError(null);
    try {
      await clearGitToken();
      onChange();
    } catch (err) {
      setError(describeApiError(err, "Failed to remove the token. Please try again."));
      setRequestId(getErrorRequestId(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4 flex flex-col gap-3">
      <div className="flex items-center gap-3 min-w-0">
        <div className="w-9 h-9 rounded-lg bg-zinc-900 border border-zinc-800 flex items-center justify-center shrink-0">
          <GithubIcon className="w-[18px] h-[18px] text-zinc-300" />
        </div>
        <div className="min-w-0">
          <p className="text-sm font-medium text-zinc-100">Git Personal Access Token</p>
          <p className="text-xs text-zinc-500">{description}</p>
        </div>
      </div>

      {!editing && hasToken ? (
        <div className="flex items-center justify-between gap-3 pl-12">
          <span className="flex items-center gap-1.5 text-xs text-emerald-400">
            <Check className="w-3.5 h-3.5" /> Token set
          </span>
          <div className="flex items-center gap-2">
            <Button variant="secondary" onClick={() => setEditing(true)} disabled={submitting} className="text-xs">
              Update
            </Button>
            <Button variant="secondary" onClick={handleRemove} disabled={submitting} className="text-xs text-red-400">
              {submitting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-2 pl-12">
          <input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="github_pat_… or ghp_…"
            className="flex-1 px-3 py-2 rounded-lg bg-zinc-900 border border-zinc-800 text-white text-sm placeholder:text-zinc-500 focus:outline-none focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/50 transition-colors"
          />
          <Button variant="secondary" onClick={handleSave} disabled={submitting || !token.trim()} className="shrink-0">
            {submitting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Save"}
          </Button>
          {hasToken && (
            <Button variant="secondary" onClick={() => { setEditing(false); setToken(""); }} disabled={submitting} className="shrink-0">
              Cancel
            </Button>
          )}
        </div>
      )}

      {error && (
        <Alert variant="error" requestId={requestId}>
          {error}
        </Alert>
      )}
    </div>
  );
}
