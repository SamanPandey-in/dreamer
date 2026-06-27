"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { LogOut, Monitor, Plus, Settings, Zap } from "lucide-react";
import { useAuth } from "../../app/providers";
import * as authApi from "../../lib/auth";

export function DashboardShell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const { user, logout } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

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

  return (
    <div className="min-h-screen bg-black text-zinc-100">
      <header className="border-b border-white/10 sticky top-0 bg-black/80 backdrop-blur-md z-20">
        <div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between">
          <Link href="/dashboard" className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center shadow-lg shadow-blue-500/25">
              <Zap className="w-4 h-4 text-white" />
            </div>
            <span className="text-lg font-bold tracking-tight">Dreamer</span>
          </Link>

          <div className="flex items-center gap-4">
            <Link
              href="/dashboard/new"
              className="flex items-center gap-1.5 text-sm font-medium px-3 py-1.5 rounded-lg bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white shadow-lg shadow-blue-500/20 transition-all"
            >
              <Plus className="w-4 h-4" />
              New Project
            </Link>

            <div className="relative">
              <button
                onClick={() => setMenuOpen((open) => !open)}
                className="w-8 h-8 rounded-full bg-zinc-800 border border-zinc-700 flex items-center justify-center text-xs font-medium text-zinc-300 hover:border-zinc-600 transition-colors"
              >
                {user?.name?.[0]?.toUpperCase() ?? "?"}
              </button>

              {menuOpen && (
                <div className="absolute right-0 mt-2 w-56 bg-zinc-950 border border-zinc-800 rounded-xl shadow-2xl shadow-black/50 py-1.5 z-30">
                  <div className="px-3 py-2 border-b border-zinc-800">
                    <p className="text-sm font-medium text-zinc-200 truncate">{user?.name}</p>
                    <p className="text-xs text-zinc-500 truncate">{user?.email}</p>
                  </div>
                  <Link
                    href="/dashboard/account"
                    onClick={() => setMenuOpen(false)}
                    className="w-full flex items-center gap-2 px-3 py-2 text-sm text-zinc-300 hover:bg-zinc-900 transition-colors"
                  >
                    <Settings className="w-4 h-4" />
                    Account settings
                  </Link>
                  <button
                    onClick={handleLogout}
                    disabled={signingOut}
                    className="w-full flex items-center gap-2 px-3 py-2 text-sm text-zinc-300 hover:bg-zinc-900 transition-colors disabled:opacity-50"
                  >
                    <LogOut className="w-4 h-4" />
                    Sign out
                  </button>
                  <button
                    onClick={handleLogoutAll}
                    disabled={signingOut}
                    className="w-full flex items-center gap-2 px-3 py-2 text-sm text-zinc-400 hover:bg-zinc-900 hover:text-red-400 transition-colors disabled:opacity-50"
                  >
                    <Monitor className="w-4 h-4" />
                    Sign out of all devices
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-6 py-10">{children}</main>
    </div>
  );
}
