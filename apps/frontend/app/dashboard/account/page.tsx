"use client";

import { useEffect, useState } from "react";
import * as authApi from "@/lib/auth";
import { Button } from "@/components/ui/Button";
import type { AuthSession } from "@/lib/auth";
import { SessionRow } from "@/components/dashboard/SessionRow";

export default function AccountPage() {
  const [sessions, setSessions] = useState<AuthSession[] | null>(null);
  const [sessionsError, setSessionsError] = useState<string | null>(null);

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [savingPassword, setSavingPassword] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [passwordSaved, setPasswordSaved] = useState(false);

  useEffect(() => {
    authApi
      .listSessions()
      .then(setSessions)
      .catch((err) => setSessionsError(err instanceof Error ? err.message : "Failed to load sessions"));
  }, []);

  async function handleRevoke(sessionId: string) {
    await authApi.revokeSession(sessionId);
    setSessions((prev) => prev?.filter((s) => s.id !== sessionId) ?? null);
  }

  async function handleChangePassword(e: React.FormEvent) {
    e.preventDefault();
    if (newPassword !== confirmPassword) {
      setPasswordError("Passwords don't match");
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
      setPasswordError(err instanceof Error ? err.message : "Failed to change password. Please try again.");
    } finally {
      setSavingPassword(false);
    }
  }

  return (
    <div className="max-w-2xl flex flex-col gap-6">
      <h1 className="text-2xl font-bold tracking-tight">Account</h1>

      <form
        onSubmit={handleChangePassword}
        className="bg-zinc-950/80 rounded-2xl border border-zinc-800 p-5 flex flex-col gap-4"
      >
        <h2 className="text-sm font-semibold text-zinc-400 uppercase tracking-wider">Password</h2>

        <div>
          <label className="block text-xs font-medium text-zinc-400 mb-1.5">
            Current Password{" "}
            <span className="text-zinc-600">(leave blank if you signed up with GitHub and never set one)</span>
          </label>
          <input
            type="password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            className="w-full px-3 py-2 rounded-lg bg-zinc-900 border border-zinc-800 text-white text-sm focus:outline-none focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/50 transition-colors"
          />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-medium text-zinc-400 mb-1.5">New Password</label>
            <input
              type="password"
              required
              minLength={8}
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              className="w-full px-3 py-2 rounded-lg bg-zinc-900 border border-zinc-800 text-white text-sm focus:outline-none focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/50 transition-colors"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-zinc-400 mb-1.5">Confirm New Password</label>
            <input
              type="password"
              required
              minLength={8}
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              className="w-full px-3 py-2 rounded-lg bg-zinc-900 border border-zinc-800 text-white text-sm focus:outline-none focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/50 transition-colors"
            />
          </div>
        </div>

        {passwordError && <p className="text-sm text-red-400">{passwordError}</p>}

        <div className="flex items-center justify-between gap-3">
          <p className="text-xs text-zinc-600">Changing your password signs out every other device.</p>
          <Button variant="primary" type="submit" loading={savingPassword} className="shrink-0">
            {savingPassword ? "Saving..." : passwordSaved ? "Saved" : "Change Password"}
          </Button>
        </div>
      </form>

      <div className="bg-zinc-950/80 rounded-2xl border border-zinc-800 p-5">
        <h2 className="text-sm font-semibold text-zinc-400 uppercase tracking-wider mb-4">Active Sessions</h2>

        {sessionsError && <p className="text-sm text-red-400">{sessionsError}</p>}

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
