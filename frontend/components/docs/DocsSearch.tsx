"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Search, X } from "lucide-react";
import type { DocSearchEntry } from "@/lib/docs/docs-search-index";

type Result = {
  href: string;
  title: string;
  group: string;
  matchLabel: string;
};

function buildResults(index: DocSearchEntry[], query: string): Result[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];

  const results: Result[] = [];

  for (const doc of index) {
    const docHref = doc.slug ? `/docs/${doc.slug}` : "/docs";
    const titleMatch = doc.title.toLowerCase().includes(q);
    const excerptMatch = doc.excerpt.toLowerCase().includes(q);

    if (titleMatch || excerptMatch) {
      results.push({ href: docHref, title: doc.title, group: doc.group, matchLabel: doc.title });
    }

    for (const heading of doc.headings) {
      if (heading.label.toLowerCase().includes(q)) {
        results.push({
          href: `${docHref}#${heading.id}`,
          title: doc.title,
          group: doc.group,
          matchLabel: heading.label,
        });
      }
    }
  }

  return results.slice(0, 8);
}

export function DocsSearch({ index }: { index: DocSearchEntry[] }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const router = useRouter();

  const results = useMemo(() => buildResults(index, query), [index, query]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.key === "k" && (e.metaKey || e.ctrlKey)) || e.key === "/") {
        const target = e.target as HTMLElement;
        if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") return;
        e.preventDefault();
        setOpen(true);
        requestAnimationFrame(() => inputRef.current?.focus());
      }
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    return () => document.removeEventListener("pointerdown", onPointer);
  }, [open]);

  const go = (href: string) => {
    setOpen(false);
    setQuery("");
    router.push(href);
  };

  const onInputKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter" && results[activeIndex]) {
      e.preventDefault();
      go(results[activeIndex].href);
    }
  };

  return (
    <div ref={rootRef} className="relative w-full">
      <div className="relative">
        <Search className="w-4 h-4 text-zinc-600 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActiveIndex(0);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onInputKeyDown}
          placeholder="Search docs..."
          className="w-full bg-zinc-950 border border-zinc-800 rounded-lg pl-9 pr-14 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-zinc-600 transition-colors"
        />
        {query ? (
          <button
            onClick={() => {
              setQuery("");
              inputRef.current?.focus();
            }}
            aria-label="Clear search"
            className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-600 hover:text-zinc-300"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        ) : (
          <kbd className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[10px] text-zinc-600 border border-zinc-800 rounded px-1.5 py-0.5 leading-none">
            /
          </kbd>
        )}
      </div>

      {open && query && (
        <div className="absolute left-0 right-0 mt-2 rounded-xl border border-zinc-800 bg-zinc-950 shadow-2xl overflow-hidden z-50 max-h-80 overflow-y-auto">
          {results.length === 0 ? (
            <p className="px-4 py-6 text-sm text-zinc-500 text-center">No results for &ldquo;{query}&rdquo;</p>
          ) : (
            <ul className="py-1.5">
              {results.map((r, i) => (
                <li key={r.href}>
                  <button
                    type="button"
                    onClick={() => go(r.href)}
                    onMouseEnter={() => setActiveIndex(i)}
                    className={`flex flex-col w-full text-left px-4 py-2 transition-colors ${
                      i === activeIndex ? "bg-white/5" : ""
                    }`}
                  >
                    <span className="text-sm text-zinc-200">{r.matchLabel}</span>
                    <span className="text-xs text-zinc-500">
                      {r.group} {r.matchLabel !== r.title ? `\u2022 ${r.title}` : ""}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
