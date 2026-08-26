"use client";

import Image from "next/image";
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Menu, X } from "lucide-react";
import { GithubIcon as Github } from "@/components/icons";
import { useAuth } from "@/app/providers";
import { DocsSidebar } from "./DocsSidebar";
import { DocsSearch } from "./DocsSearch";
import type { DocSearchEntry } from "@/lib/docs/docs-search-index";

export function DocsHeader({ searchIndex }: { searchIndex: DocSearchEntry[] }) {
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const router = useRouter();
  const { user, loading } = useAuth();

  const goToConsole = () => {
    setMobileNavOpen(false);
    router.push(loading ? "/login" : user ? "/dashboard" : "/login");
  };

  return (
    <header className="fixed top-0 left-0 right-0 z-50 bg-black/70 backdrop-blur-md border-b border-white/10">
      <div className="max-w-[1400px] mx-auto px-6 h-16 flex items-center gap-6">
        <div className="flex items-center gap-6 shrink-0">
          <Link href="/" className="flex items-center gap-3">
            <Image src="/logo-dark.svg" alt="Dreamer" width={28} height={28} className="w-7 h-7" />
            <span className="text-lg font-bold tracking-tight text-white">Dreamer</span>
          </Link>
          <span className="hidden md:inline-block text-sm text-zinc-600">/</span>
          <span className="hidden md:inline-block text-sm text-zinc-400">Docs</span>
        </div>

        <div className="hidden md:flex flex-1 justify-center">
          <div className="w-full max-w-xs">
            <DocsSearch index={searchIndex} />
          </div>
        </div>

        <div className="hidden md:flex items-center gap-3 shrink-0">
          <a
            href="https://github.com/SamanPandey-in/dreamer"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2 px-3 py-1.5 rounded-full border border-white/10 bg-white/5 text-sm text-zinc-300 hover:bg-white/10 hover:text-white transition-colors"
          >
            <Github className="w-4 h-4" />
            <span>Star</span>
          </a>
          <button
            className="relative group overflow-hidden rounded-full p-[1px] focus:outline-none"
            onClick={goToConsole}
          >
            <span className="absolute inset-0 bg-gradient-to-r from-blue-500 to-indigo-500 rounded-full group-hover:opacity-100 transition duration-500" />
            <span className="relative block px-4 py-1.5 bg-black rounded-full text-sm font-medium text-white transition duration-200 group-hover:bg-transparent">
              Open dashboard
            </span>
          </button>
        </div>

        <button className="md:hidden ml-auto text-zinc-400 hover:text-white" onClick={() => setMobileNavOpen(!mobileNavOpen)}>
          {mobileNavOpen ? <X className="w-6 h-6" /> : <Menu className="w-6 h-6" />}
        </button>
      </div>

      {mobileNavOpen && (
        <div className="md:hidden border-t border-white/10 bg-black/95 backdrop-blur-lg px-6 py-6 max-h-[75vh] overflow-y-auto">
          <div className="mb-6">
            <DocsSearch index={searchIndex} />
          </div>
          <DocsSidebar onNavigate={() => setMobileNavOpen(false)} />
          <div className="h-[1px] bg-white/10 my-6" />
          <div className="flex flex-col gap-3">
            <a
              href="https://github.com/SamanPandey-in/dreamer"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center justify-center gap-2 py-2.5 rounded-lg border border-white/10 bg-white/5 text-zinc-300"
            >
              <Github className="w-5 h-5" />
              <span>Star on GitHub</span>
            </a>
            <button
              className="w-full py-2.5 rounded-lg bg-gradient-to-r from-blue-600 to-indigo-600 font-medium text-white shadow-lg shadow-blue-500/20 text-center"
              onClick={goToConsole}
            >
              Open dashboard
            </button>
          </div>
        </div>
      )}
    </header>
  );
}
