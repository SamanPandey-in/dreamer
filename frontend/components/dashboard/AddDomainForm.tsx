"use client";

import { useState } from "react";
import { Button } from "../ui/Button";
import { describeApiError } from "@/lib/dashboard-api";

export function AddDomainForm({
  onSubmit,
  onCancel,
}: {
  onSubmit: (domain: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [domain, setDomain] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit(domain.trim());
      setDomain("");
    } catch (err) {
      setError(describeApiError(err, "Something went wrong. Please try again."));
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="bg-zinc-950/80 rounded-2xl border border-zinc-800 p-5 flex flex-col gap-3">
      <div>
        <label className="text-xs text-zinc-500 mb-1 block">Domain</label>
        <input
          autoFocus
          value={domain}
          onChange={(e) => setDomain(e.target.value)}
          placeholder="myapp.com or www.myapp.com"
          className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-sm font-mono text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-zinc-600"
        />
      </div>
      {error && <p className="text-xs text-red-400">{error}</p>}
      <div className="flex items-center gap-2">
        <Button type="submit" variant="primary" loading={submitting} disabled={!domain.trim()}>
          Add Domain
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
