"use client";

import { useState } from "react";
import type { EnvironmentTarget, EnvVariable } from "@/lib/dashboard-types";
import { Button } from "../ui/Button";

const ALL_ENVIRONMENTS: EnvironmentTarget[] = ["PRODUCTION", "PREVIEW", "DEVELOPMENT"];

export interface EnvVariableFormValues {
  key: string;
  value: string;
  environments: EnvironmentTarget[];
  isSecret: boolean;
  description: string;
}

export function EnvVariableForm({
  initial,
  onSubmit,
  onCancel,
}: {
  initial?: EnvVariable;
  onSubmit: (values: EnvVariableFormValues) => Promise<void>;
  onCancel: () => void;
}) {
  const isEditing = Boolean(initial);

  const [key, setKey] = useState(initial?.key ?? "");
  const [value, setValue] = useState(initial?.value ?? "");
  const [environments, setEnvironments] = useState<EnvironmentTarget[]>(initial?.environments ?? ALL_ENVIRONMENTS);
  const [isSecret, setIsSecret] = useState(initial?.isSecret ?? true);
  const [description, setDescription] = useState(initial?.description ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function toggleEnvironment(env: EnvironmentTarget) {
    setEnvironments((prev) => (prev.includes(env) ? prev.filter((e) => e !== env) : [...prev, env]));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (environments.length === 0) {
      setError("Select at least one environment");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit({ key, value, environments, isSecret, description });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong. Please try again.");
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="bg-zinc-950/80 rounded-2xl border border-zinc-800 p-5 flex flex-col gap-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-medium text-zinc-400 mb-1.5">Key</label>
          <input
            required
            disabled={isEditing}
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="DATABASE_URL"
            className="w-full px-3 py-2 rounded-lg bg-zinc-900 border border-zinc-800 text-white text-sm font-mono placeholder:text-zinc-500 focus:outline-none focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/50 disabled:opacity-60 transition-colors"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-zinc-400 mb-1.5">
            Value{" "}
            {isEditing && <span className="text-zinc-600">(leave blank to keep the current value)</span>}
          </label>
          <input
            required={!isEditing}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            type={isSecret ? "password" : "text"}
            className="w-full px-3 py-2 rounded-lg bg-zinc-900 border border-zinc-800 text-white text-sm font-mono focus:outline-none focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/50 transition-colors"
          />
        </div>
      </div>

      <div>
        <label className="block text-xs font-medium text-zinc-400 mb-1.5">Environments</label>
        <div className="flex gap-3">
          {ALL_ENVIRONMENTS.map((env) => (
            <label key={env} className="flex items-center gap-1.5 text-sm text-zinc-300 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={environments.includes(env)}
                onChange={() => toggleEnvironment(env)}
                className="w-4 h-4 rounded border-zinc-700 bg-zinc-900 text-blue-500 focus:ring-blue-500/50 focus:ring-offset-0"
              />
              {env[0] + env.slice(1).toLowerCase()}
            </label>
          ))}
        </div>
      </div>

      <label className="flex items-center gap-2.5 cursor-pointer select-none">
        <input
          type="checkbox"
          checked={isSecret}
          onChange={(e) => setIsSecret(e.target.checked)}
          className="w-4 h-4 rounded border-zinc-700 bg-zinc-900 text-blue-500 focus:ring-blue-500/50 focus:ring-offset-0"
        />
        <span className="text-sm text-zinc-300">Secret (mask this value in the dashboard)</span>
      </label>

      <div>
        <label className="block text-xs font-medium text-zinc-400 mb-1.5">
          Description <span className="text-zinc-600">(optional)</span>
        </label>
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className="w-full px-3 py-2 rounded-lg bg-zinc-900 border border-zinc-800 text-white text-sm focus:outline-none focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/50 transition-colors"
        />
      </div>

      {error && (
        <p className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">{error}</p>
      )}

      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          disabled={submitting}
          className="px-3 py-1.5 text-sm text-zinc-400 hover:text-zinc-200 transition-colors disabled:opacity-50"
        >
          Cancel
        </button>
        <Button variant="primary" type="submit" loading={submitting}>
          {isEditing ? "Save changes" : "Add variable"}
        </Button>
      </div>
    </form>
  );
}
