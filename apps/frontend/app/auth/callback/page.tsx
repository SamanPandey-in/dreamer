"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "../../providers";

/**
 * The API's /api/auth/github/callback redirects the browser HERE on success,
 * after setting the httpOnly refreshToken cookie — deliberately without an
 * access token in the URL (see the API-side write-up for why).
 *
 * This page does NOT call refresh() itself. <Providers> already runs that
 * exact exchange once on every fresh page load (this redirect is a full page
 * navigation, so Providers mounts fresh here too) — calling it a second time
 * here would race the server's refresh-token ROTATION and could intermittently
 * fail. Instead this page just waits for that one shared call to resolve.
 */
export default function GithubCallbackPage() {
  const router = useRouter();
  const { user, loading } = useAuth();

  useEffect(() => {
    if (loading) return;
    router.replace(user ? "/dashboard" : "/login?error=session_failed");
  }, [loading, user, router]);

  return (
    <main className="min-h-screen bg-black flex items-center justify-center">
      <div className="flex flex-col items-center gap-4">
        <div className="w-8 h-8 border-2 border-white/20 border-t-blue-500 rounded-full animate-spin" />
        <p className="text-zinc-400 text-sm">Finishing sign-in...</p>
      </div>
    </main>
  );
}
