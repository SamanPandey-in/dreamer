"use client";

import Image from "next/image";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, Eye, EyeOff, Loader2, MailCheck } from "lucide-react";
import { GithubIcon } from "../../components/icons";
import { useAuth } from "../providers";
import { describeApiError, getErrorRequestId } from "@/lib/dashboard-api";
import { Alert } from "@/components/ui/Alert";

export default function RegisterPage() {
  const router = useRouter();
  const { register, githubLoginUrl, user, loading } = useAuth();

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorRequestId, setErrorRequestId] = useState<string | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);
  // Set once registration succeeds — registering no longer logs the user
  // in, so instead of redirecting to /dashboard we show a "check your
  // email" screen in place of the form.
  const [registeredEmail, setRegisteredEmail] = useState<string | null>(null);

  useEffect(() => {
    if (!loading && user) router.replace("/dashboard");
  }, [loading, user, router]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      await register(name, email, password);
      setRegisteredEmail(email);
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
          <Link href="/" className="flex items-center gap-3 mb-6">
            <Image src="/logo-dark.svg" alt="Dreamer" width={32} height={32} className="w-8 h-8" />
            <span className="text-xl font-bold tracking-tight bg-clip-text text-transparent bg-gradient-to-r from-white via-blue-100 to-indigo-200">
              Dreamer
            </span>
          </Link>
          <h1 className="text-2xl font-bold text-white">Create your account</h1>
          <p className="text-zinc-400 text-sm mt-1">Start deploying in minutes</p>
        </div>

        <div className="bg-zinc-950/80 backdrop-blur-md rounded-2xl border border-zinc-800 shadow-2xl shadow-blue-500/5 p-6">
          {registeredEmail ? (
            <div className="flex flex-col items-center text-center gap-3 py-4">
              <div className="w-12 h-12 rounded-full bg-blue-500/10 border border-blue-500/20 flex items-center justify-center">
                <MailCheck className="w-6 h-6 text-blue-400" />
              </div>
              <h2 className="text-white font-semibold">Check your email</h2>
              <p className="text-sm text-zinc-400">
                We sent a verification link to <span className="text-zinc-200">{registeredEmail}</span>. Click it to
                activate your account, then sign in.
              </p>
              <Link
                href="/login"
                className="text-sm text-blue-400 hover:text-blue-300 font-medium mt-2"
              >
                Go to sign in
              </Link>
            </div>
          ) : (
            <>
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
                  Create account
                  <ArrowRight className="w-4 h-4" />
                </>
              )}
            </button>
          </form>
          </>
          )}
        </div>

        {!registeredEmail && (
          <p className="text-center text-sm text-zinc-500 mt-6">
            Already have an account?{" "}
            <Link href="/login" className="text-blue-400 hover:text-blue-300 font-medium">
              Sign in
            </Link>
          </p>
        )}
      </div>
    </main>
  );
}
