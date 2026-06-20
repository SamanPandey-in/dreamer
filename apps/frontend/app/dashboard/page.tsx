"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Zap, LogOut, Monitor, CheckCircle2, CircleDashed } from "lucide-react";
import { GithubIcon } from "../../components/icons";
import { useAuth } from "../providers";
import { RequireAuth } from "../require-auth";
import { apiFetch } from "../../lib/api-client";
import type { AuthUser } from "../../lib/auth";
import * as authApi from "../../lib/auth";

function DashboardContent() {
  const router = useRouter();
  const { user, logout } = useAuth();
  const [verifiedUser, setVerifiedUser] = useState<AuthUser | null>(null);
  const [signingOut, setSigningOut] = useState(false);

  // Proves the Bearer-token path end-to-end: this hits a route protected by
  // requireAuth on the API, using the access token apiFetch already holds —
  // separate from the cookie-based check RequireAuth just did to get here.
  useEffect(() => {
    apiFetch("/api/auth/me")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => data && setVerifiedUser(data.user));
  }, []);

  async function handleLogout() {
    setSigningOut(true);
    await logout();
    router.push("/login");
  }

  async function handleLogoutAll() {
    setSigningOut(true);
    await authApi.logoutAll();
    router.push("/login");
  }

  if (!user) return null;

  return (
    <main className="min-h-screen bg-black text-zinc-100">
      <header className="border-b border-white/10">
        <div className="max-w-3xl mx-auto px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center shadow-lg shadow-blue-500/25">
              <Zap className="w-4 h-4 text-white" />
            </div>
            <span className="text-lg font-bold tracking-tight">Dreamer</span>
          </div>
          <button
            onClick={handleLogout}
            disabled={signingOut}
            className="flex items-center gap-2 text-sm text-zinc-400 hover:text-white transition-colors disabled:opacity-50"
          >
            <LogOut className="w-4 h-4" />
            Sign out
          </button>
        </div>
      </header>

      <div className="max-w-3xl mx-auto px-6 py-12">
        <h1 className="text-2xl font-bold mb-1">Welcome, {user.name}</h1>
        <p className="text-zinc-400 text-sm mb-8">You&apos;re signed in to your Dreamer console.</p>

        <div className="bg-zinc-950/80 rounded-2xl border border-zinc-800 p-6 mb-6">
          <h2 className="text-sm font-semibold text-zinc-400 uppercase tracking-wider mb-4">Account</h2>
          <dl className="grid grid-cols-[120px_1fr] gap-y-3 text-sm">
            <dt className="text-zinc-500">Email</dt>
            <dd className="text-zinc-200">{user.email}</dd>

            <dt className="text-zinc-500">Verified</dt>
            <dd className="flex items-center gap-1.5">
              {user.emailVerified ? (
                <>
                  <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                  <span className="text-zinc-200">Yes</span>
                </>
              ) : (
                <>
                  <CircleDashed className="w-4 h-4 text-zinc-500" />
                  <span className="text-zinc-400">Not verified</span>
                </>
              )}
            </dd>

            <dt className="text-zinc-500">GitHub</dt>
            <dd className="flex items-center gap-1.5">
              {user.githubUsername ? (
                <>
                  <GithubIcon className="w-4 h-4 text-zinc-300" />
                  <span className="text-zinc-200">{user.githubUsername}</span>
                </>
              ) : (
                <span className="text-zinc-500">Not connected</span>
              )}
            </dd>
          </dl>
        </div>

        <div className="bg-zinc-950/80 rounded-2xl border border-zinc-800 p-6 mb-6">
          <h2 className="text-sm font-semibold text-zinc-400 uppercase tracking-wider mb-2">
            Live from GET /api/auth/me
          </h2>
          <p className="text-xs text-zinc-500 mb-3">
            Fetched separately via <code className="text-zinc-400">apiFetch</code> using the in-memory
            access token, to confirm the Bearer-token + <code className="text-zinc-400">requireAuth</code>{" "}
            path works end-to-end from this page, not just the cookie-based refresh that got you here.
          </p>
          <pre className="text-xs text-emerald-300/90 bg-black/40 rounded-lg p-3 overflow-x-auto">
            {verifiedUser ? JSON.stringify(verifiedUser, null, 2) : "loading..."}
          </pre>
        </div>

        <button
          onClick={handleLogoutAll}
          disabled={signingOut}
          className="flex items-center gap-2 text-sm text-zinc-400 hover:text-red-400 transition-colors disabled:opacity-50"
        >
          <Monitor className="w-4 h-4" />
          Sign out of all devices
        </button>
      </div>
    </main>
  );
}

export default function DashboardPage() {
  return (
    <RequireAuth>
      <DashboardContent />
    </RequireAuth>
  );
}
