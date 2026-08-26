"use client";

import { useEffect, useRef, useState } from "react";
import { Copy, Check, ChevronDown, FileText } from "lucide-react";

export function CopyPageButton({ source, slug }: { source: string; slug: string }) {
  const [copied, setCopied] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onPointer = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    return () => document.removeEventListener("pointerdown", onPointer);
  }, [menuOpen]);

  const copyPage = async () => {
    await navigator.clipboard.writeText(source);
    setCopied(true);
    setMenuOpen(false);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div ref={rootRef} className="relative inline-flex">
      <div className="inline-flex items-stretch rounded-lg border border-zinc-800 bg-zinc-950/60 overflow-hidden">
        <button
          type="button"
          onClick={copyPage}
          className="flex items-center gap-2 px-3 py-1.5 text-sm text-zinc-300 hover:bg-white/5 hover:text-white transition-colors"
        >
          {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
          {copied ? "Copied" : "Copy page"}
        </button>
        <button
          type="button"
          onClick={() => setMenuOpen((v) => !v)}
          aria-label="More copy options"
          className="flex items-center px-2 border-l border-zinc-800 text-zinc-400 hover:bg-white/5 hover:text-white transition-colors"
        >
          <ChevronDown className="w-3.5 h-3.5" />
        </button>
      </div>

      {menuOpen && (
        <div className="absolute right-0 top-full mt-2 w-56 rounded-lg border border-zinc-800 bg-zinc-950 shadow-xl overflow-hidden z-10">
          <button
            type="button"
            onClick={copyPage}
            className="flex items-center gap-2.5 w-full px-3 py-2.5 text-sm text-zinc-300 hover:bg-white/5 hover:text-white transition-colors text-left"
          >
            <Copy className="w-4 h-4 shrink-0" />
            <span>
              <span className="block">Copy page</span>
              <span className="block text-xs text-zinc-500">Copy this page as Markdown</span>
            </span>
          </button>
          <a
            href={slug ? `/docs/raw/${slug}` : "/docs/raw"}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => setMenuOpen(false)}
            className="flex items-center gap-2.5 w-full px-3 py-2.5 text-sm text-zinc-300 hover:bg-white/5 hover:text-white transition-colors text-left"
          >
            <FileText className="w-4 h-4 shrink-0" />
            <span>
              <span className="block">View as Markdown</span>
              <span className="block text-xs text-zinc-500">Open the raw .md source</span>
            </span>
          </a>
        </div>
      )}
    </div>
  );
}
