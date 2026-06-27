"use client";

import { useState } from "react";
import { Eye, EyeOff, Loader2, Pencil, Trash2 } from "lucide-react";
import { revealEnvVariable } from "@/lib/dashboard-api";
import type { EnvVariable } from "@/lib/dashboard-types";

export function EnvVariableRow({
  envVariable,
  onEdit,
  onDelete,
}: {
  envVariable: EnvVariable;
  onEdit: () => void;
  onDelete: () => Promise<void>;
}) {
  const [revealedValue, setRevealedValue] = useState<string | null>(null);
  const [revealing, setRevealing] = useState(false);
  const [deleting, setDeleting] = useState(false);

  async function handleToggleReveal() {
    if (revealedValue !== null) {
      setRevealedValue(null);
      return;
    }
    setRevealing(true);
    try {
      const value = await revealEnvVariable(envVariable.id);
      setRevealedValue(value);
    } finally {
      setRevealing(false);
    }
  }

  async function handleDelete() {
    setDeleting(true);
    try {
      await onDelete();
    } catch {
      setDeleting(false);
    }
  }

  const displayValue = !envVariable.isSecret ? envVariable.value : revealedValue ?? envVariable.maskedValue;

  return (
    <div className="flex items-center justify-between gap-3 px-4 py-3 rounded-xl border border-zinc-800 bg-zinc-950/40">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="text-sm font-mono text-zinc-200 truncate">{envVariable.key}</p>
          <div className="flex gap-1">
            {envVariable.environments.map((env) => (
              <span
                key={env}
                className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400 uppercase tracking-wide"
              >
                {env.slice(0, 4)}
              </span>
            ))}
          </div>
        </div>
        <p className="text-sm font-mono text-zinc-500 truncate">{displayValue}</p>
        {envVariable.description && (
          <p className="text-xs text-zinc-600 truncate mt-0.5">{envVariable.description}</p>
        )}
      </div>

      <div className="flex items-center gap-1 shrink-0">
        {envVariable.isSecret && (
          <button
            onClick={handleToggleReveal}
            disabled={revealing}
            className="p-1.5 text-zinc-500 hover:text-zinc-200 transition-colors disabled:opacity-50"
            aria-label={revealedValue !== null ? "Hide value" : "Reveal value"}
          >
            {revealing ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : revealedValue !== null ? (
              <EyeOff className="w-4 h-4" />
            ) : (
              <Eye className="w-4 h-4" />
            )}
          </button>
        )}
        <button onClick={onEdit} className="p-1.5 text-zinc-500 hover:text-zinc-200 transition-colors" aria-label="Edit">
          <Pencil className="w-4 h-4" />
        </button>
        <button
          onClick={handleDelete}
          disabled={deleting}
          className="p-1.5 text-zinc-500 hover:text-red-400 transition-colors disabled:opacity-50"
          aria-label="Delete"
        >
          {deleting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
        </button>
      </div>
    </div>
  );
}
