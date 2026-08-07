"use client";

import { Suspense, useEffect, useState } from "react";
import * as authApi from "@/lib/auth";
import { Button } from "@/components/ui/Button";
import { Alert } from "@/components/ui/Alert";
import type { AuthSession } from "@/lib/auth";
import { SessionRow } from "@/components/dashboard/SessionRow";
import { describeApiError, getErrorRequestId } from "@/lib/dashboard-api";
import { useAuth } from "@/app/providers";
import { ConnectGithubPrompt } from "@/components/ConnectGithubPrompt";
import { useGithubConnectStatus } from "@/lib/useGithubConnectStatus";
import { GithubIcon } from "@/components/icons";

function AccountPageContent() {
  const { user } = useAuth();
  const githubStatus = useGithubConnectStatus();

  const [sessions, setSessions] = useState<AuthSession[] | null>(null);
  const [sessionsError, setSessionsError] = useState<string | null>(null);
  const [sessionsErrorRef, setSessionsErrorRef] = useState<string | undefined>(undefined);

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [savingPassword, setSavingPassword] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [passwordErrorRef, setPasswordErrorRef] = useState<string | undefined>(undefined);
  const [passwordSaved, setPasswordSaved] = useState(false);

  useEffect(() => {
    authApi
      .listSessions()
      .then(setSessions)
      .catch((err) => {
        setSessionsError(describeApiError(err, "Failed to load sessions"));
        setSessionsErrorRef(getErrorRequestId(err));
      });
  }, []);

  async function handleRevoke(sessionId: string) {
    await authApi.revokeSession(sessionId);
    setSessions((prev) => prev?.filter((s) => s.id !== sessionId) ?? null);
  }

  async function handleChangePassword(e: React.FormEvent) {
    e.preventDefault();
    if (newPassword !== confirmPassword) {
      setPasswordError("Passwords don't match");
      setPasswordErrorRef(undefined);
      return;
    }
    setSavingPassword(true);
    setPasswordError(null);
    try {
      await authApi.changePassword({ currentPassword: currentPassword || undefined, newPassword });
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setPasswordSaved(true);
      setTimeout(() => setPasswordSaved(false), 2000);
    } catch (err) {
      setPasswordError(describeApiError(err, "Failed to change password. Please try again."));
      setPasswordErrorRef(getErrorRequestId(err));
    } finally {
      setSavingPassword(false);
    }
  }

  return (
    <div className="max-w-2xl flex flex-col gap-6">
      <h1 className="text-2xl font-bold tracking-tight">Account</h1>

      {githubStatus && (
        <Alert variant={githubStatus.variant}>{githubStatus.message}</Alert>
      )}

      <div className="bg-zinc-950/80 rounded-2xl border border-zinc-800 p-5 flex flex-col gap-4">
        <h2 className="text-sm font-semibold text-zinc-400 uppercase tracking-wider">GitHub</h2>

        {user?.githubUsername ? (
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-zinc-900 border border-zinc-800 flex items-center justify-center shrink-0">
              <GithubIcon className="w-[18px] h-[18px] text-zinc-300" />
            </div>
            <div>
              <p className="text-sm font-medium text-zinc-100">Connected</p>
              <p className="text-xs text-zinc-500">@{user.githubUsername}</p>
            </div>
          </div>
        ) : (
          <ConnectGithubPrompt
            returnTo="account"
            description="Link your GitHub account to import and deploy your repositories."
          />
        )}
      </div>

      <form
        onSubmit={handleChangePassword}
        className="bg-zinc-950/80 rounded-2xl border border-zinc-800 p-5 flex flex-col gap-4"
      >
        <h2 className="text-sm font-semibold text-zinc-400 uppercase tracking-wider">Password</h2>

        <div>
          <label htmlFor="current-password" className="block text-xs font-medium text-zinc-400 mb-1.5">
            Current Password{" "}
            <span className="text-zinc-600">(leave blank if you signed up with GitHub and never set one)</span>
          </label>
          <input
            id="current-password"
            type="password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            className="w-full px-3 py-2 rounded-lg bg-zinc-900 border border-zinc-800 text-white text-sm focus:outline-none focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/50 transition-colors"
          />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label htmlFor="new-password" className="block text-xs font-medium text-zinc-400 mb-1.5">New Password</label>
            <input
              id="new-password"
              type="password"
              required
              minLength={8}
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              className="w-full px-3 py-2 rounded-lg bg-zinc-900 border border-zinc-800 text-white text-sm focus:outline-none focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/50 transition-colors"
            />
          </div>
          <div>
            <label htmlFor="confirm-new-password" className="block text-xs font-medium text-zinc-400 mb-1.5">Confirm New Password</label>
            <input
              id="confirm-new-password"
              type="password"
              required
              minLength={8}
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              className="w-full px-3 py-2 rounded-lg bg-zinc-900 border border-zinc-800 text-white text-sm focus:outline-none focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/50 transition-colors"
            />
          </div>
        </div>

        {passwordError && (
          <Alert variant="error" requestId={passwordErrorRef}>
            {passwordError}
          </Alert>
        )}

        <div className="flex items-center justify-between gap-3">
          <p className="text-xs text-zinc-600">Changing your password signs out every other device.</p>
          <Button variant="primary" type="submit" loading={savingPassword} className="shrink-0">
            {savingPassword ? "Saving..." : passwordSaved ? "Saved" : "Change Password"}
          </Button>
        </div>
      </form>

      <div className="bg-zinc-950/80 rounded-2xl border border-zinc-800 p-5">
        <h2 className="text-sm font-semibold text-zinc-400 uppercase tracking-wider mb-4">Active Sessions</h2>

        {sessionsError && (
          <Alert variant="error" requestId={sessionsErrorRef} className="mb-4">
            {sessionsError}
          </Alert>
        )}

        {!sessions && !sessionsError ? (
          <div className="h-32 rounded-xl bg-zinc-900/60 animate-pulse" />
        ) : (
          <div className="flex flex-col gap-2">
            {sessions?.map((session) => (
              <SessionRow key={session.id} session={session} onRevoke={() => handleRevoke(session.id)} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default function AccountPage() {
  return (
    <Suspense fallback={null}>
      <AccountPageContent />
    </Suspense>
  );
}
