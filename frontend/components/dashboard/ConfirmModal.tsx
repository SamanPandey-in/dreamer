"use client";

import { useState } from "react";
import { Button } from "../ui/Button";
import { describeApiError } from "@/lib/dashboard-api";

interface ConfirmModalProps {
  title: string;
  description: string;
  confirmLabel: string;
  destructive?: boolean;
  confirmationPhrase?: string;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}

export function ConfirmModal({
  title,
  description,
  confirmLabel,
  destructive,
  confirmationPhrase,
  onConfirm,
  onClose,
}: ConfirmModalProps) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmInput, setConfirmInput] = useState("");

  const inputEnabled = confirmationPhrase
    ? confirmInput === confirmationPhrase
    : true;

  async function handleConfirm() {
    setSubmitting(true);
    setError(null);
    try {
      await onConfirm();
    } catch (err) {
      setError(describeApiError(err, "Something went wrong. Please try again."));
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

        {confirmationPhrase && (
          <div className="mb-4">
            <label className="block text-xs text-zinc-500 mb-1.5">
              Type <span className="font-mono text-zinc-300">{confirmationPhrase}</span> to confirm:
            </label>
            <input
              value={confirmInput}
              onChange={(e) => setConfirmInput(e.target.value)}
              placeholder={confirmationPhrase}
              className="w-full px-3 py-2 rounded-lg bg-zinc-900 border border-zinc-800 text-white text-sm font-mono placeholder:text-zinc-600 focus:outline-none focus:border-red-500/50 focus:ring-1 focus:ring-red-500/50 transition-colors"
            />
          </div>
        )}

        {error && (
          <p className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-md px-3 py-2 mb-4">
            {error}
          </p>
        )}

        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button
            variant={destructive ? "destructive" : "primary"}
            onClick={handleConfirm}
            loading={submitting}
            disabled={!inputEnabled}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}