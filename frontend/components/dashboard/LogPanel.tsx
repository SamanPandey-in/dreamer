"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, AlertTriangle, Bug, Terminal } from "lucide-react";
import type { LogLine } from "../../lib/dashboard-types";

const LEVEL_CONFIG: Record<LogLine["level"], { color: string; icon: typeof AlertCircle | null }> = {
  ERROR: { color: "text-red-400", icon: AlertCircle },
  WARN: { color: "text-yellow-400", icon: AlertTriangle },
  SYSTEM: { color: "text-blue-400", icon: Terminal },
  DEBUG: { color: "text-zinc-500", icon: Bug },
  // INFO is the overwhelming majority of lines (raw build-tool stdout) — no
  // icon, so the eye isn't drawn to every single line, only the ones that
  // actually deviate from "normal."
  INFO: { color: "text-zinc-300", icon: null },
};

const LEVEL_FILTERS: Array<LogLine["level"] | "ALL"> = ["ALL", "ERROR", "WARN", "SYSTEM", "INFO", "DEBUG"];

export function LogPanel({ logs, isStreaming }: { logs: LogLine[]; isStreaming: boolean }) {
  const [textFilter, setTextFilter] = useState("");
  const [levelFilter, setLevelFilter] = useState<LogLine["level"] | "ALL">("ALL");
  const [autoScroll, setAutoScroll] = useState(true);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!autoScroll) return;
    containerRef.current?.scrollTo({ top: containerRef.current.scrollHeight, behavior: "smooth" });
  }, [logs, autoScroll]);

  const filteredLogs = useMemo(() => {
    return logs.filter((log) => {
      if (levelFilter !== "ALL" && log.level !== levelFilter) return false;
      if (textFilter && !log.message.toLowerCase().includes(textFilter.toLowerCase())) return false;
      return true;
    });
  }, [logs, levelFilter, textFilter]);

  const errorCount = useMemo(() => logs.filter((l) => l.level === "ERROR").length, [logs]);

  return (
    <div className="flex flex-col h-[480px] bg-black/40 border border-zinc-800 rounded-xl overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-zinc-800 bg-zinc-950/60">
        <input
          placeholder="Filter logs..."
          value={textFilter}
          onChange={(e) => setTextFilter(e.target.value)}
          className="flex-1 bg-transparent text-sm outline-none text-zinc-200 placeholder:text-zinc-600 min-w-0"
        />
        {isStreaming && (
          <span className="flex items-center gap-1.5 text-xs text-emerald-400 shrink-0">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
            Live
          </span>
        )}
        {errorCount > 0 && (
          <span className="text-xs text-red-400 shrink-0">
            {errorCount} error{errorCount === 1 ? "" : "s"}
          </span>
        )}
        <span className="text-xs text-zinc-500 shrink-0">{filteredLogs.length} lines</span>
      </div>

      {/* Level filter chips — the direct payoff of `level` being a real
          structured field instead of buried in free-text: narrowing to just
          ERROR lines after a failed build is one click, not a scroll. */}
      <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-zinc-800/60 overflow-x-auto">
        {LEVEL_FILTERS.map((level) => (
          <button
            key={level}
            onClick={() => setLevelFilter(level)}
            className={`text-[11px] px-2 py-0.5 rounded-full border whitespace-nowrap transition-colors ${
              levelFilter === level
                ? "bg-zinc-100 text-zinc-900 border-zinc-100"
                : "text-zinc-400 border-zinc-800 hover:border-zinc-700"
            }`}
          >
            {level}
          </button>
        ))}
      </div>

      <div
        ref={containerRef}
        className="flex-1 overflow-y-auto p-3 font-mono text-[13px] scrollbar-visible"
        onScroll={(e) => {
          const el = e.currentTarget;
          const isAtBottom = el.scrollHeight - el.scrollTop <= el.clientHeight + 24;
          setAutoScroll(isAtBottom);
        }}
      >
        {filteredLogs.length === 0 && (
          <p className="text-zinc-600 text-sm">
            {logs.length === 0 ? "Waiting for logs..." : "No lines match the current filter."}
          </p>
        )}
        {filteredLogs.map((log) => {
          const { color, icon: Icon } = LEVEL_CONFIG[log.level];
          return (
            <div key={log.id} className={`flex items-start gap-3 py-0.5 ${color}`}>
              <span className="text-zinc-600 select-none w-12 shrink-0 text-right">{log.sequence}</span>
              <span className="text-zinc-600 select-none w-20 shrink-0">
                {new Date(log.timestamp).toLocaleTimeString()}
              </span>
              {Icon ? <Icon className="w-3.5 h-3.5 shrink-0 mt-0.5" /> : <span className="w-3.5 shrink-0" />}
              {log.source && (
                <span className="shrink-0 px-1.5 rounded bg-zinc-800/80 text-[10px] uppercase tracking-wide text-zinc-400 h-fit leading-[1.4]">
                  {log.source}
                </span>
              )}
              <span className="break-all whitespace-pre-wrap">{log.message}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
