"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "./providers";


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
