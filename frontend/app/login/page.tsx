"use client";

import Image from "next/image";
import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowRight, Eye, EyeOff, Loader2 } from "lucide-react";
import { useAuth } from "../providers";
import { describeApiError, getErrorRequestId } from "@/lib/dashboard-api";
import { Alert } from "@/components/ui/Alert";

const ERROR_MESSAGES: Record<string, string> = {
  session_failed: "We couldn't restore your session. Please sign in again.",
};

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { login, user, loading, setupStatusLoaded, setupComplete } = useAuth();

  const redirectTo = searchParams.get("redirect") || "/dashboard";
  const queryError = searchParams.get("error");

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(
    queryError ? ERROR_MESSAGES[queryError] ?? "Something went wrong. Please try again." : null
  );
  const [submitting, setSubmitting] = useState(false);
  const [errorRequestId, setErrorRequestId] = useState<string | undefined>(undefined);

  // Already signed in (e.g. hit the back button after logging in) — skip the form.
  useEffect(() => {
    if (!loading && user) router.replace(redirectTo);
  }, [loading, user, router, redirectTo]);

  // No admin account exists yet — this is a fresh install. See
  // docs/architecture/local-engine-auth-and-networking.md Decision 1.
  useEffect(() => {
    if (setupStatusLoaded && !setupComplete) router.replace("/setup");
  }, [setupStatusLoaded, setupComplete, router]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setErrorRequestId(undefined);
    setSubmitting(true);

    try {
      await login(email, password);
      router.push(redirectTo);
    } catch (err) {
      setError(describeApiError(err, "Something went wrong. Please try again."));
      setErrorRequestId(getErrorRequestId(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={{ width: "100%", maxWidth: "24rem" }}>
      <div className="flex flex-col items-center mb-8">
        <Link href="/login" className="flex items-center gap-3 mb-6">
          <Image src="/logo-dark.svg" alt="Dreamer" width={32} height={32} className="w-8 h-8" />
          <span className="text-xl font-bold tracking-tight bg-clip-text text-transparent bg-gradient-to-r from-white via-blue-100 to-indigo-200">
            Dreamer
          </span>
        </Link>
        <h1 className="text-2xl font-bold text-white">Welcome back</h1>
        <p className="text-zinc-400 text-sm mt-1">Sign in to your console</p>
      </div>

      <div className="bg-zinc-950/80 backdrop-blur-md rounded-2xl border border-zinc-800 shadow-2xl shadow-blue-500/5 p-6">
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div>
            <label htmlFor="email" className="block text-xs font-medium text-zinc-400 mb-1.5">
              Email
            </label>
            <input
              id="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full px-3 py-2.5 rounded-lg bg-zinc-900 border border-zinc-800 text-white text-sm placeholder:text-zinc-500 focus:outline-none focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/50 transition-colors"
              placeholder="you@example.com"
            />
          </div>

          <div>
            <label htmlFor="password" className="block text-xs font-medium text-zinc-400 mb-1.5">
              Password
            </label>
            <div className="relative">
              <input
                id="password"
                type={showPassword ? "text" : "password"}
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full px-3 py-2.5 pr-10 rounded-lg bg-zinc-900 border border-zinc-800 text-white text-sm placeholder:text-zinc-500 focus:outline-none focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/50 transition-colors"
                placeholder="••••••••"
              />
              <button
                type="button"
                aria-label={showPassword ? "Hide password" : "Show password"}
                onClick={() => setShowPassword((prev) => !prev)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-200"
              >
                {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>

          {error && (
            <Alert variant="error" requestId={errorRequestId}>
              {error}
            </Alert>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="flex items-center justify-center gap-2 w-full py-2.5 mt-1 bg-white hover:bg-zinc-100 disabled:opacity-60 text-zinc-950 font-medium rounded-lg border border-zinc-300 shadow-sm transition-all"
          >
            {submitting ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <>
                Sign in
                <ArrowRight className="w-4 h-4" />
              </>
            )}
          </button>
        </form>
      </div>

      <p className="text-center text-xs text-zinc-600 mt-6">
        Forgot your password?{" "}
        <code className="text-zinc-500">scripts/reset-admin-password.ts</code> from the server — see the README&apos;s
        troubleshooting section.
      </p>
    </div>
  );
}

// Same outer shape as the real form (logo, heading, card, button) so
// hydration swaps content in-place with zero layout shift — a blank
// fallback would otherwise flash for a frame on every static page load,
// per Next's own guidance on useSearchParams + Suspense.
function LoginSkeleton() {
  return (
    <div style={{ width: "100%", maxWidth: "24rem" }}>
      <div className="flex flex-col items-center mb-8">
        <div className="flex items-center gap-3 mb-6">
          <Image src="/logo-dark.svg" alt="Dreamer" width={32} height={32} className="w-8 h-8" />
          <span className="text-xl font-bold tracking-tight bg-clip-text text-transparent bg-gradient-to-r from-white via-blue-100 to-indigo-200">
            Dreamer
          </span>
        </div>
        <h1 className="text-2xl font-bold text-white">Welcome back</h1>
        <p className="text-zinc-400 text-sm mt-1">Sign in to your console</p>
      </div>

      <div className="bg-zinc-950/80 backdrop-blur-md rounded-2xl border border-zinc-800 shadow-2xl shadow-blue-500/5 p-6">
        <div className="flex flex-col gap-4">
          <div className="h-[60px] rounded-lg bg-zinc-900 border border-zinc-800 animate-pulse" />
          <div className="h-[60px] rounded-lg bg-zinc-900 border border-zinc-800 animate-pulse" />
          <div className="h-[42px] rounded-lg bg-zinc-800 animate-pulse mt-1" />
        </div>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <main className="min-h-screen bg-black px-6 py-12 flex items-center justify-center">
      <Suspense fallback={<LoginSkeleton />}>
        <LoginForm />
      </Suspense>
    </main>
  );
}
