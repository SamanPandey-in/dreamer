"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "./providers";
import { motion } from 'framer-motion';

function FullPageSpinner() {
  return (
    <div className="min-h-screen bg-black flex items-center flex-col gap-2 justify-center">
      <InfinityPath />
      <span className="ml-2 text-lg font-bold text-white">Dreaming</span>
    </div>
  );
}

export function RequireAuth({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!loading && !user) router.replace("/login");
  }, [loading, user, router]);

  if (loading || !user) return <FullPageSpinner />;

  return <>{children}</>;
}

const InfinityPath = () => {
  return (
    <svg className="w-12 h-6 overflow-visible" viewBox="0 0 60 30">
      <path
        d="M 15 15 C 15 5, 25 5, 30 15 C 35 25, 45 25, 45 15 C 45 5, 35 5, 30 15 C 25 25, 15 25, 15 15"
        className="stroke-zinc-200 dark:stroke-zinc-800 fill-none"
        strokeWidth="4"
        strokeLinecap="round"
      />
      <motion.path
        d="M 15 15 C 15 5, 25 5, 30 15 C 35 25, 45 25, 45 15 C 45 5, 35 5, 30 15 C 25 25, 15 25, 15 15"
        className="stroke-zinc-800 dark:stroke-white fill-none"
        strokeWidth="4"
        strokeLinecap="round"
        strokeDasharray="100"
        animate={{ strokeDashoffset: [100, -100] }}
        transition={{ duration: 2, repeat: Infinity, ease: "linear" }}
      />
    </svg>
  );
};
