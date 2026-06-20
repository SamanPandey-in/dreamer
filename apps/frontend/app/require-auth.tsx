"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "./providers";

function FullPageSpinner() {
  return (
    <div className="min-h-screen bg-black flex items-center justify-center">
      <div className="w-8 h-8 border-2 border-white/20 border-t-blue-500 rounded-full animate-spin" />
    </div>
  );
}

/**
 * Wrap any page that requires a logged-in user with this. It's a CLIENT-side
 * check on purpose — see Section 0 for why a proxy.ts cookie check would not
 * actually work for this architecture (the refresh cookie is scoped to the
 * API's own host, not the frontend's).
 */
export function RequireAuth({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!loading && !user) router.replace("/login");
  }, [loading, user, router]);

  if (loading || !user) return <FullPageSpinner />;

  return <>{children}</>;
}
