"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { label: "Overview", href: "" },
  { label: "Deployments", href: "/deployments" },
  { label: "Env Vars", href: "/env" },
  { label: "Domains", href: "/domains" },
  { label: "Settings", href: "/settings" },
] as const;

export function ProjectTabs({ projectId }: { projectId: string }) {
  const pathname = usePathname();
  const base = `/project/${projectId}`;

  return (
    <nav className="flex gap-1 border-b border-white/10 -mb-px overflow-x-auto">
      {TABS.map((tab) => {
        const href = `${base}${tab.href}`;
        const isActive = tab.href === "" ? pathname === base : pathname.startsWith(href);

        return (
          <Link
            key={tab.label}
            href={href}
            className={`px-4 py-3 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${
              isActive ? "border-blue-500 text-zinc-100" : "border-transparent text-zinc-500 hover:text-zinc-300"
            }`}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
