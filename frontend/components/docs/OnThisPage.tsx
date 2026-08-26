"use client";

import { useEffect, useState } from "react";
import type { DocHeading } from "@/lib/docs/docs-headings";

export function OnThisPage({ headings }: { headings: DocHeading[] }) {
  const [activeId, setActiveId] = useState<string | undefined>(headings[0]?.id);

  useEffect(() => {
    if (headings.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setActiveId(visible[0].target.id);
      },
      { rootMargin: "-96px 0px -70% 0px", threshold: 0 }
    );

    headings.forEach((h) => {
      const el = document.getElementById(h.id);
      if (el) observer.observe(el);
    });

    return () => observer.disconnect();
  }, [headings]);

  if (headings.length === 0) return null;

  return (
    <nav aria-label="On this page" className="text-sm">
      <h4 className="text-xs font-semibold tracking-wider text-zinc-500 uppercase mb-3">On this page</h4>
      <ul className="flex flex-col gap-0.5 border-l border-zinc-900">
        {headings.map((h) => {
          const isActive = h.id === activeId;
          return (
            <li key={h.id} style={{ paddingLeft: h.depth === 3 ? "1.5rem" : "0.75rem" }} className="-ml-px">
              <a
                href={`#${h.id}`}
                className={`block py-1 border-l -ml-px pl-3 transition-colors leading-snug ${
                  isActive
                    ? "border-blue-400 text-white font-medium"
                    : "border-transparent text-zinc-500 hover:text-zinc-300"
                }`}
              >
                {h.label}
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
