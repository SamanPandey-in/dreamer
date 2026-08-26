"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronRight } from "lucide-react";
import { docsGroups, docsManifest } from "@/lib/docs/docs-manifest";

// Groups that default to collapsed once the viewport drops below this width.
const AUTO_COLLAPSE_GROUPS = ["Core Concepts"];
const AUTO_COLLAPSE_BREAKPOINT = 1024;

export function DocsSidebar({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${AUTO_COLLAPSE_BREAKPOINT - 1}px)`);
    const apply = (matches: boolean) => {
      setCollapsed((prev) => {
        const next = { ...prev };
        for (const group of AUTO_COLLAPSE_GROUPS) {
          if (!(group in prev)) next[group] = matches;
        }
        return next;
      });
    };
    apply(mql.matches);
    const onChange = (e: MediaQueryListEvent) => apply(e.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  const toggleGroup = (group: string) => {
    setCollapsed((prev) => ({ ...prev, [group]: !prev[group] }));
  };

  return (
    <nav className="flex flex-col gap-6">
      {docsGroups.map((group) => {
        const isCollapsed = collapsed[group] ?? false;
        return (
          <div key={group}>
            <button
              type="button"
              onClick={() => toggleGroup(group)}
              className="flex items-center justify-between w-full px-3 mb-3 group"
            >
              <h3 className="text-xs font-semibold tracking-wider text-zinc-500 uppercase group-hover:text-zinc-300 transition-colors">
                {group}
              </h3>
              <ChevronRight
                className={`w-3.5 h-3.5 text-zinc-600 transition-transform ${isCollapsed ? "" : "rotate-90"}`}
              />
            </button>
            {!isCollapsed && (
              <div className="flex flex-col gap-0.5">
                {docsManifest
                  .filter((d) => d.group === group)
                  .map((doc) => {
                    const href = doc.slug ? `/docs/${doc.slug}` : "/docs";
                    const isActive = pathname === href;
                    return (
                      <Link
                        key={href}
                        href={href}
                        onClick={onNavigate}
                        className={`px-3 py-1.5 rounded-lg text-sm transition-colors ${
                          isActive
                            ? "bg-blue-500/10 text-blue-300 font-medium border border-blue-500/20"
                            : "text-zinc-400 hover:text-white hover:bg-white/5 border border-transparent"
                        }`}
                      >
                        {doc.title}
                      </Link>
                    );
                  })}
              </div>
            )}
          </div>
        );
      })}
    </nav>
  );
}
