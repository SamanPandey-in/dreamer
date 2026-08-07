"use client";

import Image from "next/image";
import { useState } from "react";
import Link from "next/link";
import { ArrowRight, Loader2, MailCheck } from "lucide-react";
import { forgotPassword } from "@/lib/auth";
import { describeApiError, getErrorRequestId } from "@/lib/dashboard-api";
import { Alert } from "@/components/ui/Alert";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [errorRequestId, setErrorRequestId] = useState<string | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      await forgotPassword(email);
      // Always show the same success state, whether or not the email
      // exists — see the backend's requestPasswordReset().
      setSent(true);
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
          <h1 className="text-2xl font-bold text-white">Reset your password</h1>
          <p className="text-zinc-400 text-sm mt-1">We&apos;ll email you a link to choose a new one</p>
        </div>

        <div className="bg-zinc-950/80 backdrop-blur-md rounded-2xl border border-zinc-800 shadow-2xl shadow-blue-500/5 p-6">
          {sent ? (
            <div className="flex flex-col items-center text-center gap-3 py-4">
              <div className="w-12 h-12 rounded-full bg-blue-500/10 border border-blue-500/20 flex items-center justify-center">
                <MailCheck className="w-6 h-6 text-blue-400" />
              </div>
              <h2 className="text-white font-semibold">Check your email</h2>
              <p className="text-sm text-zinc-400">
                If an account exists for <span className="text-zinc-200">{email}</span>, we sent a password reset
                link to it.
              </p>
              <Link href="/login" className="text-sm text-blue-400 hover:text-blue-300 font-medium mt-2">
                Back to sign in
              </Link>
            </div>
          ) : (
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
                    Send reset link
                    <ArrowRight className="w-4 h-4" />
                  </>
                )}
              </button>
            </form>
          )}
        </div>

        <p className="text-center text-sm text-zinc-500 mt-6">
          Remembered it?{" "}
          <Link href="/login" className="text-blue-400 hover:text-blue-300 font-medium">
            Sign in
          </Link>
        </p>
      </div>
    </main>
  );
}
