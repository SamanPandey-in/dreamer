"use client";

import { useState } from "react";
import { Button } from "../ui/Button";

interface ConfirmModalProps {
  title: string;
  description: string;
  confirmLabel: string;
  destructive?: boolean;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}

export function ConfirmModal({ title, description, confirmLabel, destructive, onConfirm, onClose }: ConfirmModalProps) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleConfirm() {
    setSubmitting(true);
    setError(null);
    try {
      await onConfirm();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong. Please try again.");
      setSubmitting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 px-4"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-sm bg-zinc-950 border border-zinc-800 rounded-[10px] p-5 shadow-2xl shadow-black/50 animate-in"
      >
        <h2 className="text-base font-semibold text-zinc-100 mb-1.5">{title}</h2>
        <p className="text-sm text-zinc-400 mb-4">{description}</p>

        {error && (
          <p className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-md px-3 py-2 mb-4">
            {error}
          </p>
        )}

        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button variant={destructive ? "destructive" : "primary"} onClick={handleConfirm} loading={submitting}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}