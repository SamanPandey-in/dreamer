"use client";

import { useState } from "react";
import { Check, Copy, Eye, EyeOff, Loader2, Pencil, Trash2 } from "lucide-react";
import { revealEnvVariable } from "@/lib/dashboard-api";
import type { EnvVariable } from "@/lib/dashboard-types";

export function EnvVariableRow({
  envVariable,
  onEdit,
  onDelete,
}: {
  envVariable: EnvVariable;
  onEdit?: () => void;
  onDelete?: () => Promise<void>;
}) {
  const [revealedValue, setRevealedValue] = useState<string | null>(null);
  const [isRevealed, setIsRevealed] = useState(false);
  const [isCopied, setIsCopied] = useState(false);
  const [revealing, setRevealing] = useState(false);
  const [deleting, setDeleting] = useState(false);

  function handleCopy() {
    navigator.clipboard.writeText(envVariable.value || "");
    setIsCopied(true);
    setTimeout(() => setIsCopied(false), 2000);
  }

  async function handleToggleReveal() {
    if (envVariable.isSecret) {
      if (revealedValue !== null) {
        setRevealedValue(null);
      } else {
        setRevealing(true);
        try {
          const value = await revealEnvVariable(envVariable.id);
          setRevealedValue(value);
        } finally {
          setRevealing(false);
        }
      }
    } else {
      setIsRevealed((prev) => !prev);
    }
  }

  async function handleDelete() {
    if (!onDelete) return;
    setDeleting(true);
    try {
      await onDelete();
    } catch {
      setDeleting(false);
    }
  }

  const displayValue = !envVariable.isSecret
    ? (isRevealed ? envVariable.value : "********")
    : revealedValue ?? envVariable.maskedValue;

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
        {envVariable.isSecret ? (
          <span className="text-xs text-zinc-500 italic">Secret Key</span>
        ) : (
          <>
            <button
              onClick={handleCopy}
              className="p-1.5 text-zinc-500 hover:text-zinc-200 transition-colors"
              aria-label="Copy value"
            >
              {isCopied ? <Check className="w-4 h-4 text-emerald-500" /> : <Copy className="w-4 h-4" />}
            </button>
            <button
              onClick={handleToggleReveal}
              className="p-1.5 text-zinc-500 hover:text-zinc-200 transition-colors"
              aria-label={
                envVariable.isSecret
                  ? revealedValue !== null
                    ? "Hide value"
                    : "Reveal value"
                  : isRevealed
                  ? "Hide value"
                  : "View value"
              }
            >
              {revealing ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (envVariable.isSecret ? revealedValue !== null : isRevealed) ? (
                <EyeOff className="w-4 h-4" />
              ) : (
                <Eye className="w-4 h-4" />
              )}
            </button>
          </>
        )}
        {onEdit && (
          <button onClick={onEdit} className="p-1.5 text-zinc-500 hover:text-zinc-200 transition-colors" aria-label="Edit">
            <Pencil className="w-4 h-4" />
          </button>
        )}
        {onDelete && (
          <button
            onClick={handleDelete}
            disabled={deleting}
            className="p-1.5 text-zinc-500 hover:text-red-400 transition-colors disabled:opacity-50"
            aria-label="Delete"
          >
            {deleting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
          </button>
        )}
      </div>
    </div>
  );
}
