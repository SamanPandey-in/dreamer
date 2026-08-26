"use client";

import Image from "next/image";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, Eye, EyeOff, Loader2, ShieldCheck } from "lucide-react";
import { useAuth } from "../providers";
import { describeApiError, getErrorRequestId } from "@/lib/dashboard-api";
import { Alert } from "@/components/ui/Alert";

/**
 * The ONE-TIME admin-account creation screen — replaces the old open
 * /register. See docs/architecture/local-engine-auth-and-networking.md
 * Decision 1: this is the whole "sign up" story for local-engine. Once
 * POST /api/auth/setup succeeds here, it can never succeed again — the
 * effect below sends anyone who lands here afterward (including a second
 * browser tab mid-setup) straight to /login instead.
 */
export default function SetupPage() {
  const router = useRouter();
  const { setup, user, loading, setupStatusLoaded, setupComplete } = useAuth();

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorRequestId, setErrorRequestId] = useState<string | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!loading && user) router.replace("/dashboard");
  }, [loading, user, router]);

  // Setup already happened (someone else's tab finished it, or this is a
  // reload after a successful first run) — there's no form to show.
  useEffect(() => {
    if (setupStatusLoaded && setupComplete && !user) router.replace("/login");
  }, [setupStatusLoaded, setupComplete, user, router]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      await setup(name, email, password);
      router.push("/dashboard");
    } catch (err) {
      setError(describeApiError(err, "Something went wrong. Please try again."));
      setErrorRequestId(getErrorRequestId(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="min-h-screen bg-black px-6 py-12 flex items-center justify-center">
      <div style={{ width: "100%", maxWidth: "24rem" }}>
        <div className="flex flex-col items-center mb-8">
          <Link href="/setup" className="flex items-center gap-3 mb-6">
            <Image src="/logo-dark.svg" alt="Dreamer" width={32} height={32} className="w-8 h-8" />
            <span className="text-xl font-bold tracking-tight bg-clip-text text-transparent bg-gradient-to-r from-white via-blue-100 to-indigo-200">
              Dreamer
            </span>
          </Link>
          <h1 className="text-2xl font-bold text-white">Set up your admin account</h1>
          <p className="text-zinc-400 text-sm mt-1 text-center max-w-xs">
            This runs once, for this install. There&apos;s no separate sign-up — whoever fills this in owns this
            server.
          </p>
        </div>

        <div className="bg-zinc-950/80 backdrop-blur-md rounded-2xl border border-zinc-800 shadow-2xl shadow-blue-500/5 p-6">
          <div className="flex items-start gap-2.5 mb-5 px-1">
            <ShieldCheck className="w-4 h-4 text-blue-400 mt-0.5 shrink-0" />
            <p className="text-xs text-zinc-500 leading-relaxed">
              You&apos;re reaching this over an SSH tunnel, not a public URL — this dashboard is intentionally not
              exposed to the internet.
            </p>
          </div>

          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <div>
              <label htmlFor="name" className="block text-xs font-medium text-zinc-400 mb-1.5">
                Name
              </label>
              <input
                id="name"
                type="text"
                autoComplete="name"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full px-3 py-2.5 rounded-lg bg-zinc-900 border border-zinc-800 text-white text-sm placeholder:text-zinc-500 focus:outline-none focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/50 transition-colors"
                placeholder="Saman Pandey"
              />
            </div>

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
                  autoComplete="new-password"
                  required
                  minLength={8}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full px-3 py-2.5 pr-10 rounded-lg bg-zinc-900 border border-zinc-800 text-white text-sm placeholder:text-zinc-500 focus:outline-none focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/50 transition-colors"
                  placeholder="At least 8 characters"
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
                  Create admin account
                  <ArrowRight className="w-4 h-4" />
                </>
              )}
            </button>
          </form>
        </div>
      </div>
    </main>
  );
}
