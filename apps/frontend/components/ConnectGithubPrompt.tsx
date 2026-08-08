"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { GithubIcon } from "@/components/icons";
import { Button } from "@/components/ui/Button";
import { Alert } from "@/components/ui/Alert";
import { connectGithub } from "@/lib/auth";
import { describeApiError, getErrorRequestId } from "@/lib/dashboard-api";

interface ConnectGithubPromptProps {
  returnTo: "account" | "project";
  /** Shown above the CTA — tailored per call site (Settings vs. the import wizard). */
  description: string;
}

export function ConnectGithubPrompt({ returnTo, description }: ConnectGithubPromptProps) {
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [requestId, setRequestId] = useState<string | undefined>(undefined);

  async function handleConnect() {
    setConnecting(true);
    setError(null);
    try {
      const url = await connectGithub(returnTo);
      window.location.href = url;
      // Deliberately no setConnecting(false) here — the page is navigating
      // away, so the button staying disabled until then is correct, not a
      // bug: nothing should be clickable mid-redirect.
    } catch (err) {
      setError(describeApiError(err, "Failed to start GitHub connect. Please try again."));
      setRequestId(getErrorRequestId(err));
      setConnecting(false);
    }
  }

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4 flex flex-col gap-3">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-9 h-9 rounded-lg bg-zinc-900 border border-zinc-800 flex items-center justify-center shrink-0">
            <GithubIcon className="w-[18px] h-[18px] text-zinc-300" />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-medium text-zinc-100">Connect GitHub</p>
            <p className="text-xs text-zinc-500">{description}</p>
          </div>
        </div>
        <Button variant="secondary" onClick={handleConnect} disabled={connecting} className="shrink-0">
          {connecting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Connect"}
        </Button>
      </div>

      {error && (
        <Alert variant="error" requestId={requestId}>
          {error}
        </Alert>
      )}
    </div>
  );
}
