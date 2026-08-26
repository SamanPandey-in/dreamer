"use client";

import { useState } from "react";
import { Eye, EyeOff, Plus, Upload, X } from "lucide-react";
import type { EnvironmentTarget } from "@/lib/dashboard-types";
import { Button } from "@/components/ui/Button";
import { Alert } from "@/components/ui/Alert";
import { DeployButton } from "@/components/ui/DeployButton";

const ALL_ENVIRONMENTS: EnvironmentTarget[] = ["PRODUCTION", "PREVIEW", "DEVELOPMENT"];

export interface StagedEnvVar {
  key: string;
  value: string;
  environments: EnvironmentTarget[];
}

/**
 * Parses pasted .env file contents into staged rows — `KEY=value` per
 * line, skipping blank lines and full-line comments. Doesn't attempt to
 * handle every shell-quoting edge case a real `.env` parser (like dotenv's)
 * would, since this only feeds a form the user can still review and edit
 * before submitting — a slightly-wrong parse is correctable here in a way
 * it wouldn't be if this fed straight into storage.
 */
function parseEnvFileContents(raw: string): StagedEnvVar[] {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => {
      const eqIndex = line.indexOf("=");
      if (eqIndex === -1) return null;
      const key = line.slice(0, eqIndex).trim();
      let value = line.slice(eqIndex + 1).trim();
      // Strip a single matching pair of surrounding quotes — common in
      // .env files (KEY="value with spaces") but not part of the actual value.
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      return key ? { key, value, environments: [...ALL_ENVIRONMENTS] } : null;
    })
    .filter((row): row is StagedEnvVar => row !== null);
}

function EnvVarRow({
  row,
  onChange,
  onRemove,
}: {
  row: StagedEnvVar;
  onChange: (next: StagedEnvVar) => void;
  onRemove: () => void;
}) {
  const [revealed, setRevealed] = useState(false);

  return (
    <div className="flex items-start gap-2">
      <input
        value={row.key}
        onChange={(e) => onChange({ ...row, key: e.target.value })}
        placeholder="EXAMPLE_NAME"
        className="flex-1 px-3 py-2 rounded-lg bg-zinc-900 border border-zinc-800 text-white text-sm font-mono placeholder:text-zinc-500 focus:outline-none focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/50 transition-colors"
      />
      <div className="relative flex-1">
        <input
          value={row.value}
          onChange={(e) => onChange({ ...row, value: e.target.value })}
          type={revealed ? "text" : "password"}
          placeholder="Value"
          className="w-full px-3 py-2 pr-9 rounded-lg bg-zinc-900 border border-zinc-800 text-white text-sm font-mono placeholder:text-zinc-500 focus:outline-none focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/50 transition-colors"
        />
        <button
          type="button"
          onClick={() => setRevealed((v) => !v)}
          className="absolute right-2.5 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300"
        >
          {revealed ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
        </button>
      </div>
      <button
        type="button"
        onClick={onRemove}
        className="p-2 text-zinc-500 hover:text-red-400 transition-colors"
        aria-label="Remove variable"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}

export function NewProjectEnvVarsForm({
  onDeploy,
  onBack,
  deploying,
  error,
}: {
  onDeploy: (envVars: StagedEnvVar[]) => void;
  onBack: () => void;
  deploying: boolean;
  error: string | null;
}) {
  const [rows, setRows] = useState<StagedEnvVar[]>([{ key: "", value: "", environments: [...ALL_ENVIRONMENTS] }]);

  function updateRow(index: number, next: StagedEnvVar) {
    setRows((prev) => prev.map((row, i) => (i === index ? next : row)));
  }

  function removeRow(index: number) {
    setRows((prev) => prev.filter((_, i) => i !== index));
  }

  function addRow() {
    setRows((prev) => [...prev, { key: "", value: "", environments: [...ALL_ENVIRONMENTS] }]);
  }

  function handleImportEnvFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    file.text().then((text) => {
      const parsed = parseEnvFileContents(text);
      if (parsed.length === 0) return;
      // Replaces any still-empty starter row rather than appending after
      // it — a fresh wizard always starts with one blank row, and leaving
      // it there after an import just adds visual clutter the user has to
      // manually delete.
      setRows((prev) => {
        const nonEmpty = prev.filter((r) => r.key.trim() || r.value.trim());
        return [...nonEmpty, ...parsed];
      });
    });

    e.target.value = ""; // allow importing the same file again if needed
  }

  function handleDeploy() {
    // Only rows with a real key are sent — an entirely blank starter row
    // left untouched shouldn't become a request to create an env var with
    // an empty name.
    onDeploy(rows.filter((row) => row.key.trim()));
  }

  return (
    <div className="max-w-2xl">
      <div className="border border-zinc-800 rounded-xl p-4 mb-4">
        <button type="button" className="text-sm font-medium text-zinc-200 mb-3 block">
          Environment Variables
        </button>

        <div className="flex flex-col gap-2.5 mb-3">
          {rows.map((row, i) => (
            <EnvVarRow key={i} row={row} onChange={(next) => updateRow(i, next)} onRemove={() => removeRow(i)} />
          ))}
        </div>

        <div className="flex items-center gap-2">
          <label className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium border border-zinc-800 text-zinc-200 hover:border-zinc-700 hover:bg-zinc-900 transition-colors cursor-pointer">
            <Upload className="w-3.5 h-3.5" />
            Import .env
            <input type="file" accept=".env,text/plain" onChange={handleImportEnvFile} className="hidden" />
          </label>
          <Button variant="secondary" onClick={addRow}>
            <Plus className="w-3.5 h-3.5" />
            Add More
          </Button>
        </div>
      </div>

      {error && (
        <Alert variant="error" className="mb-4">
          {error}
        </Alert>
      )}

      <div className="flex items-center justify-between">
        <Button variant="ghost" onClick={onBack} disabled={deploying}>
          Back
        </Button>
        <DeployButton onClick={handleDeploy} deploying={deploying} />
      </div>
    </div>
  );
}
