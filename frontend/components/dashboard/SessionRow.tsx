"use client";

import { useState } from "react";
import { Loader2, Monitor } from "lucide-react";
import { formatRelativeTime } from "@/lib/format";
import type { AuthSession } from "@/lib/auth";

function describeDevice(userAgent: string | null): string {
  if (!userAgent) return "Unknown device";
  if (/iphone/i.test(userAgent)) return "iPhone";
  if (/android/i.test(userAgent)) return "Android device";
  if (/macintosh/i.test(userAgent)) return "Mac";
  if (/windows/i.test(userAgent)) return "Windows PC";
  return "Browser";
}

export function SessionRow({ session, onRevoke }: { session: AuthSession; onRevoke: () => Promise<void> }) {
  const [revoking, setRevoking] = useState(false);

  async function handleRevoke() {
    setRevoking(true);
    try {
      await onRevoke();
    } catch {
      setRevoking(false);
    }
  }

  return (
    <div className="flex items-center justify-between gap-3 px-4 py-3 rounded-xl border border-zinc-800 bg-zinc-950/40">
      <div className="flex items-center gap-3 min-w-0">
        <div className="w-8 h-8 rounded-lg bg-zinc-900 border border-zinc-800 flex items-center justify-center shrink-0">
          <Monitor className="w-4 h-4 text-zinc-500" />
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <p className="text-sm text-zinc-200 truncate">{describeDevice(session.userAgent)}</p>
            {session.isCurrent && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-400 border border-blue-500/20">
                This device
              </span>
            )}
          </div>
          <p className="text-xs text-zinc-500">
            {session.ipAddress ?? "Unknown IP"} · last active {formatRelativeTime(session.lastUsedAt)}
          </p>
        </div>
      </div>

      {!session.isCurrent && (
        <button
          onClick={handleRevoke}
          disabled={revoking}
          className="text-sm text-red-400 hover:text-red-300 transition-colors disabled:opacity-50 shrink-0"
        >
          {revoking ? <Loader2 className="w-4 h-4 animate-spin" /> : "Revoke"}
        </button>
      )}
    </div>
  );
}
