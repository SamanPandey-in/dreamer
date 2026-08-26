"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "./providers";

/**
 * local-engine: no public marketing landing page — see
 * docs/architecture/local-engine-auth-and-networking.md Decision 1. This
 * dashboard is loopback-only and single-operator; the root route just
 * routes straight to whichever real screen applies, same as CapRover/
 * Coolify's own dashboards do at "/".
 */
export default function Home() {
  const router = useRouter();
  const { user, loading, setupStatusLoaded, setupComplete } = useAuth();

  useEffect(() => {
    if (loading || !setupStatusLoaded) return;
    if (!setupComplete) router.replace("/setup");
    else if (user) router.replace("/dashboard");
    else router.replace("/login");
  }, [loading, setupStatusLoaded, setupComplete, user, router]);

  return <main className="min-h-screen bg-black" />;
}
