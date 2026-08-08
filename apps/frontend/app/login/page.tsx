"use client";

import Image from "next/image";
import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowRight, Eye, EyeOff, Loader2 } from "lucide-react";
import { GithubIcon } from "../../components/icons";
import { useAuth } from "../providers";
import { describeApiError, getErrorRequestId } from "@/lib/dashboard-api";
import { resendVerification } from "@/lib/auth";
import { ApiError } from "@/lib/api-error";
import { Alert } from "@/components/ui/Alert";

const ERROR_MESSAGES: Record<string, string> = {
  github_state_mismatch: "Your GitHub sign-in session expired before it could finish. Please try again.",
  github_auth_failed: "GitHub sign-in didn't go through. Please try again.",
  session_failed: "We couldn't restore your session. Please sign in again.",
};

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { login, githubLoginUrl, user, loading } = useAuth();

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
  // True when login failed specifically because the email isn't verified
  // yet — shows a "resend verification email" action instead of a plain error.
  const [needsVerification, setNeedsVerification] = useState(false);
  const [resendState, setResendState] = useState<"idle" | "sending" | "sent">("idle");

  // Already signed in (e.g. hit the back button after logging in) — skip the form.
  useEffect(() => {
    if (!loading && user) router.replace(redirectTo);
  }, [loading, user, router, redirectTo]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setErrorRequestId(undefined);
    setNeedsVerification(false);
    setResendState("idle");
    setSubmitting(true);

    try {
      await login(email, password);
      router.push(redirectTo);
    } catch (err) {
      if (err instanceof ApiError && err.code === "EMAIL_NOT_VERIFIED") {
        setNeedsVerification(true);
        setError("Please verify your email before signing in.");
      } else {
        setError(describeApiError(err, "Something went wrong. Please try again."));
        setErrorRequestId(getErrorRequestId(err));
      }
    } finally {
      setSubmitting(false);
    }
  }

  async function handleResend() {
    setResendState("sending");
    try {
      await resendVerification(email);
      setResendState("sent");
    } catch (err) {
      // Distinct from the enumeration-safe backend response: this is a
      // genuine failure to send (network, rate limit, etc.), so allow
      // retry instead of falsely claiming success.
      setResendState("idle");
      setError(describeApiError(err, "Unable to resend the verification email. Please try again."));
    }
  }

  return (
    <div style={{ width: "100%", maxWidth: "24rem" }}>
      <div className="flex flex-col items-center mb-8">
        <Link href="/" className="flex items-center gap-3 mb-6">
          <Image src="/logo-dark.svg" alt="Dreamer" width={32} height={32} className="w-8 h-8" />
          <span className="text-xl font-bold tracking-tight bg-clip-text text-transparent bg-gradient-to-r from-white via-blue-100 to-indigo-200">
            Dreamer
          </span>
        </Link>
        <h1 className="text-2xl font-bold text-white">Welcome back</h1>
        <p className="text-zinc-400 text-sm mt-1">Sign in to your console</p>
      </div>

      <div className="bg-zinc-950/80 backdrop-blur-md rounded-2xl border border-zinc-800 shadow-2xl shadow-blue-500/5 p-6">
        <a
          href={githubLoginUrl}
          className="flex items-center justify-center gap-2 w-full py-2.5 rounded-lg border border-white/10 bg-white/5 text-sm font-medium text-zinc-200 hover:bg-white/10 hover:text-white transition-colors"
        >
          <GithubIcon className="w-4 h-4" />
          Continue with GitHub
        </a>

        <div className="flex items-center gap-3 my-5">
          <div className="h-px flex-1 bg-zinc-800" />
          <span className="text-xs text-zinc-500">OR</span>
          <div className="h-px flex-1 bg-zinc-800" />
        </div>

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
            <div className="text-right mt-1.5">
              <Link href="/forgot-password" className="text-xs text-zinc-500 hover:text-zinc-300">
                Forgot password?
              </Link>
            </div>
          </div>

          {error && needsVerification && (
            <Alert variant="warning">
              <p>{error}</p>
              <button
                type="button"
                onClick={handleResend}
                disabled={resendState !== "idle"}
                className="mt-1.5 text-amber-200 hover:text-amber-100 font-medium underline underline-offset-2 disabled:no-underline disabled:opacity-70"
              >
                {resendState === "sending"
                  ? "Sending…"
                  : resendState === "sent"
                  ? "Verification email sent — check your inbox"
                  : "Resend verification email"}
              </button>
            </Alert>
          )}

          {error && !needsVerification && (
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

      <p className="text-center text-sm text-zinc-500 mt-6">
        Don&apos;t have an account?{" "}
        <Link href="/register" className="text-blue-400 hover:text-blue-300 font-medium">
          Sign up
        </Link>
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
        <div className="h-[42px] rounded-lg border border-white/10 bg-white/5 animate-pulse" />
        <div className="flex items-center gap-3 my-5">
          <div className="h-px flex-1 bg-zinc-800" />
          <span className="text-xs text-zinc-500">OR</span>
          <div className="h-px flex-1 bg-zinc-800" />
        </div>
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
