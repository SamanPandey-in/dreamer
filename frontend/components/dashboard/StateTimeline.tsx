import type { StateTransition } from "../../lib/dashboard-types";
import { formatDuration } from "../../lib/format";

export function StateTimeline({ transitions }: { transitions: StateTransition[] }) {
  return (
    <div className="flex items-stretch overflow-x-auto pb-2">
      {transitions.map((transition, i) => {
        const next = transitions[i + 1];
        const durationMs = next
          ? new Date(next.createdAt).getTime() - new Date(transition.createdAt).getTime()
          : null;
        const isCurrent = !next;

        return (
          <div key={transition.id} className="flex items-center shrink-0">
            <div className="flex flex-col items-center px-3">
              <span
                className={`w-2.5 h-2.5 rounded-full ${
                  isCurrent ? "bg-blue-400 animate-pulse" : "bg-zinc-600"
                }`}
              />
              <span className="text-xs font-medium text-zinc-300 mt-2 whitespace-nowrap">
                {transition.toStatus}
              </span>
              <span className="text-[11px] text-zinc-500 whitespace-nowrap">
                {new Date(transition.createdAt).toLocaleTimeString()}
              </span>
            </div>
            {next && (
              <div className="flex flex-col items-center px-1 -mt-4">
                <div className="w-12 h-px bg-zinc-700" />
                {durationMs !== null && (
                  <span className="text-[10px] text-zinc-600 mt-1">{formatDuration(durationMs)}</span>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
