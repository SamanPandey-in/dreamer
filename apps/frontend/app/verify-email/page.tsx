"use client";

import Image from "next/image";
import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Loader2, MailCheck, XCircle } from "lucide-react";
import { verifyEmail } from "@/lib/auth";
import { describeApiError } from "@/lib/dashboard-api";

type Status = "verifying" | "success" | "error";

function VerifyEmailContent() {
  const searchParams = useSearchParams();
  const token = searchParams.get("token");

  const [status, setStatus] = useState<Status>(token ? "verifying" : "error");
  const [error, setError] = useState<string | null>(
    token ? null : "This verification link is missing its token."
  );

  useEffect(() => {
    if (!token) {
      return;
    }

    let cancelled = false;
    verifyEmail(token)
      .then(() => {
        if (!cancelled) setStatus("success");
      })
      .catch((err) => {
        if (!cancelled) {
          setStatus("error");
          setError(describeApiError(err, "This verification link is invalid or has expired."));
        }
      });
    return () => {
      cancelled = true;
    };
    // Runs once on mount for whatever token is in the URL at that point —
    // this page never has a reason to re-verify mid-visit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div style={{ width: "100%", maxWidth: "24rem" }}>
      <div className="flex flex-col items-center mb-8">
        <Link href="/" className="flex items-center gap-3 mb-6">
          <Image src="/logo-dark.svg" alt="Dreamer" width={32} height={32} className="w-8 h-8" />
          <span className="text-xl font-bold tracking-tight bg-clip-text text-transparent bg-gradient-to-r from-white via-blue-100 to-indigo-200">
            Dreamer
          </span>
        </Link>
      </div>

      <div className="bg-zinc-950/80 backdrop-blur-md rounded-2xl border border-zinc-800 shadow-2xl shadow-blue-500/5 p-6 flex flex-col items-center text-center gap-3 py-8">
        {status === "verifying" && (
          <>
            <Loader2 className="w-8 h-8 text-blue-400 animate-spin" />
            <p className="text-sm text-zinc-400">Verifying your email…</p>
          </>
        )}

        {status === "success" && (
          <>
            <div className="w-12 h-12 rounded-full bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center">
              <MailCheck className="w-6 h-6 text-emerald-400" />
            </div>
            <h2 className="text-white font-semibold">Email verified</h2>
            <p className="text-sm text-zinc-400">Your account is ready. You can sign in now.</p>
            <Link
              href="/login"
              className="inline-flex items-center justify-center gap-2 mt-2 px-4 py-2 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white text-sm font-medium rounded-lg shadow-lg shadow-blue-500/20 transition-all"
            >
              Go to sign in
            </Link>
          </>
        )}

        {status === "error" && (
          <>
            <div className="w-12 h-12 rounded-full bg-red-500/10 border border-red-500/20 flex items-center justify-center">
              <XCircle className="w-6 h-6 text-red-400" />
            </div>
            <h2 className="text-white font-semibold">Verification failed</h2>
            <p className="text-sm text-zinc-400">{error}</p>
            <Link href="/login" className="text-sm text-blue-400 hover:text-blue-300 font-medium mt-2">
              Back to sign in
            </Link>
          </>
        )}
      </div>
    </div>
  );
}

export default function VerifyEmailPage() {
  return (
    <main className="min-h-screen bg-black px-6 py-12 flex items-center justify-center">
      <Suspense fallback={<Loader2 className="w-8 h-8 text-blue-400 animate-spin" />}>
        <VerifyEmailContent />
      </Suspense>
    </main>
  );
}
