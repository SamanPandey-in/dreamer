"use client";

import { useEffect, useState } from "react";
import { Plus } from "lucide-react";
import { createEnvVariable, deleteEnvVariable, listEnvVariables, updateEnvVariable } from "@/lib/dashboard-api";
import type { EnvironmentTarget, EnvVariable } from "@/lib/dashboard-types";
import { useProject } from "@/lib/project-context";
import { Button } from "@/components/ui/Button";
import { EnvVariableForm, type EnvVariableFormValues } from "@/components/dashboard/EnvVariableForm";
import { EnvVariableRow } from "@/components/dashboard/EnvVariableRow";

const TABS: EnvironmentTarget[] = ["PRODUCTION", "PREVIEW", "DEVELOPMENT"];

export default function EnvVariablesPage() {
  const { project } = useProject();

  const [envVariables, setEnvVariables] = useState<EnvVariable[] | null>(null);
  const [activeTab, setActiveTab] = useState<EnvironmentTarget>("PRODUCTION");
  const [error, setError] = useState<string | null>(null);
  const [formMode, setFormMode] = useState<string>("none");

  function loadEnvVariables() {
    listEnvVariables(project.id)
      .then(setEnvVariables)
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load environment variables"));
  }

  useEffect(loadEnvVariables, [project.id]);

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

        {formMode === "none" && (
          <Button variant="primary" onClick={() => setFormMode("create")}>
            <Plus className="w-4 h-4" />
            Add Variable
          </Button>
        )}
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
            onEdit={() => setFormMode(envVariable.id)}
            onDelete={() => handleDelete(envVariable.id)}
          />
        ))}
      </div>
    </div>
  );
}
