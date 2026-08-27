"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Pencil, Plus, Upload } from "lucide-react";
import {
  createEnvVariable,
  createDeployment,
  deleteEnvVariable,
  listEnvVariables,
  updateEnvVariable,
  describeApiError,
} from "@/lib/dashboard-api";
import type { EnvironmentTarget, EnvVariable } from "@/lib/dashboard-types";
import { useProject } from "@/lib/project-context";
import { Button } from "@/components/ui/Button";
import { EnvVariableForm, type EnvVariableFormValues } from "@/components/dashboard/EnvVariableForm";
import { EnvVariableRow } from "@/components/dashboard/EnvVariableRow";

const ALL_ENVIRONMENTS: EnvironmentTarget[] = ["PRODUCTION", "PREVIEW", "DEVELOPMENT"];

function parseEnvFileContents(raw: string): { key: string; value: string; environments: EnvironmentTarget[] }[] {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => {
      const eqIndex = line.indexOf("=");
      if (eqIndex === -1) return null;
      const key = line.slice(0, eqIndex).trim();
      let value = line.slice(eqIndex + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      return key ? { key, value, environments: [...ALL_ENVIRONMENTS] } : null;
    })
    .filter((row): row is { key: string; value: string; environments: EnvironmentTarget[] } => row !== null);
}

const TABS: EnvironmentTarget[] = ["PRODUCTION", "PREVIEW", "DEVELOPMENT"];

export default function EnvVariablesPage() {
  const { project } = useProject();
  const router = useRouter();
  const [envVariables, setEnvVariables] = useState<EnvVariable[] | null>(null);
  const [activeTab, setActiveTab] = useState<EnvironmentTarget>("PRODUCTION");
  const [error, setError] = useState<string | null>(null);
  const [formMode, setFormMode] = useState<string>("none");
  const [isEditing, setIsEditing] = useState(false);
  const [showRedeployPopup, setShowRedeployPopup] = useState(false);
  const [redeploying, setRedeploying] = useState(false);
  const redeployTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const dismissRedeployPopup = useCallback(() => {
    if (redeployTimerRef.current) {
      clearTimeout(redeployTimerRef.current);
      redeployTimerRef.current = null;
    }
    setShowRedeployPopup(false);
  }, []);

  function loadEnvVariables() {
    listEnvVariables(project.id)
      .then(setEnvVariables)
      .catch((err) => setError(describeApiError(err, "Failed to load environment variables")));
  }

  useEffect(loadEnvVariables, [project.id]);

  async function triggerRedeployPopup() {
    setShowRedeployPopup(true);
    if (redeployTimerRef.current) clearTimeout(redeployTimerRef.current);
    redeployTimerRef.current = setTimeout(() => {
      setShowRedeployPopup(false);
      redeployTimerRef.current = null;
    }, 10000);
  }

  async function handleCreate(values: EnvVariableFormValues) {
    const created = await createEnvVariable(project.id, {
      ...values,
      description: values.description || undefined,
    });
    setEnvVariables((prev) => (prev ? [...prev, created].sort((a, b) => a.key.localeCompare(b.key)) : [created]));
    setFormMode("none");
  }

  async function handleUpdate(id: string, values: EnvVariableFormValues) {
    const updated = await updateEnvVariable(id, {
      ...(values.value ? { value: values.value } : {}),
      environments: values.environments,
      isSecret: values.isSecret,
      description: values.description || undefined,
    });
    setEnvVariables((prev) => prev?.map((v) => (v.id === id ? updated : v)) ?? null);
    setFormMode("none");
  }

  async function handleDelete(id: string) {
    await deleteEnvVariable(id);
    setEnvVariables((prev) => prev?.filter((v) => v.id !== id) ?? null);
  }

  function handleImportEnvFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    file.text().then(async (text) => {
      const parsed = parseEnvFileContents(text);
      if (parsed.length === 0) return;
      for (const envVar of parsed) {
        await createEnvVariable(project.id, envVar);
      }
      loadEnvVariables();
    });

    e.target.value = "";
  }

  if (error) {
    return <p className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-4 py-3">{error}</p>;
  }

  if (!envVariables) {
    return <div className="h-64 rounded-2xl border border-zinc-800 bg-zinc-950/40 animate-pulse" />;
  }

  const visible = envVariables.filter((v) => v.environments.includes(activeTab));
  const editingVariable =
    formMode !== "none" && formMode !== "create" ? envVariables.find((v) => v.id === formMode) : undefined;

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div className="flex gap-1">
          {TABS.map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                activeTab === tab ? "bg-zinc-900 text-white" : "text-zinc-500 hover:text-zinc-300"
              }`}
            >
              {tab[0] + tab.slice(1).toLowerCase()}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2">
          {formMode === "none" && (
            <Button
              variant="ghost"
              onClick={() => {
                if (isEditing) {
                  setIsEditing(false);
                  triggerRedeployPopup();
                } else {
                  setIsEditing(true);
                }
              }}
            >
              <Pencil className="w-4 h-4 mr-1.5" />
              {isEditing ? "Finish Editing" : "Edit"}
            </Button>
          )}

          {isEditing && formMode === "none" && (
            <>
              <label className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium border border-zinc-800 text-zinc-200 hover:border-zinc-700 hover:bg-zinc-900 transition-colors cursor-pointer">
                <Upload className="w-3.5 h-3.5" />
                Import Env
                <input type="file" accept=".env,text/plain" onChange={handleImportEnvFile} className="hidden" />
              </label>
              <Button variant="primary" onClick={() => setFormMode("create")}>
                <Plus className="w-4 h-4" />
                Add Variable
              </Button>
            </>
          )}
        </div>
      </div>

      {formMode === "create" && (
        <div className="mb-4">
          <EnvVariableForm onSubmit={handleCreate} onCancel={() => setFormMode("none")} />
        </div>
      )}

      {editingVariable && (
        <div className="mb-4">
          <EnvVariableForm
            initial={editingVariable}
            onSubmit={(values) => handleUpdate(editingVariable.id, values)}
            onCancel={() => setFormMode("none")}
          />
        </div>
      )}

      <div className="flex flex-col gap-2">
        {visible.length === 0 && (
          <p className="text-sm text-zinc-500 px-1">No variables set for {activeTab.toLowerCase()} yet.</p>
        )}
        {visible.map((envVariable) => (
          <EnvVariableRow
            key={envVariable.id}
            envVariable={envVariable}
            onEdit={isEditing ? () => setFormMode(envVariable.id) : undefined}
            onDelete={isEditing ? () => handleDelete(envVariable.id) : undefined}
          />
        ))}
      </div>

      {showRedeployPopup && (
        <div className="fixed bottom-5 right-5 z-50 animate-in slide-in-from-bottom-5 fade-in duration-300">
          <div className="bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl p-4 flex flex-col gap-3 w-80">
            <p className="text-sm text-zinc-200">Want to redeploy with the updated env vars?</p>
            <div className="flex gap-2">
              <Button
                variant="primary"
                loading={redeploying}
                onClick={async () => {
                  dismissRedeployPopup();
                  setRedeploying(true);
                  try {
                    const deployment = await createDeployment(project.id);
                    router.push(`/project/${project.id}/deployments/${deployment.id}`);
                  } catch {
                    setRedeploying(false);
                  }
                }}
                className="flex-1"
              >
                Redeploy
              </Button>
              <Button variant="ghost" onClick={dismissRedeployPopup} className="flex-1">
                Dismiss
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
