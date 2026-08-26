"use client";

import { useEffect, useState } from "react";
import { Plus, Globe } from "lucide-react";
import { listCustomDomains, createCustomDomain, deleteCustomDomain, describeApiError } from "@/lib/dashboard-api";
import type { CustomDomain } from "@/lib/dashboard-types";
import { useProject } from "@/lib/project-context";
import { Button } from "@/components/ui/Button";
import { AddDomainForm } from "@/components/dashboard/AddDomainForm";
import { DomainRow } from "@/components/dashboard/DomainRow";
import { ComingSoonStub } from "@/components/dashboard/ComingSoonStub";

const CUSTOM_DOMAINS_ENABLED = process.env.NEXT_PUBLIC_CUSTOM_DOMAINS_ENABLED === "true";

export default function DomainsPage() {
  const { project } = useProject();

  const [domains, setDomains] = useState<CustomDomain[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);

  function loadDomains() {
    listCustomDomains(project.id)
      .then(setDomains)
      .catch((err) => setError(describeApiError(err, "Failed to load custom domains")));
  }

  useEffect(loadDomains, [project.id]);

  async function handleCreate(domain: string) {
    const created = await createCustomDomain(project.id, domain);
    setDomains((prev) => (prev ? [...prev, created] : [created]));
    setShowAddForm(false);
  }

  function handleVerified(updated: CustomDomain) {
    setDomains((prev) => prev?.map((d) => (d.id === updated.id ? updated : d)) ?? null);
  }

  async function handleDelete(id: string) {
    await deleteCustomDomain(id);
    setDomains((prev) => prev?.filter((d) => d.id !== id) ?? null);
  }

  if (error) {
    return <p className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-4 py-3">{error}</p>;
  }

  if (!domains) {
    return <div className="h-64 rounded-2xl border border-zinc-800 bg-zinc-950/40 animate-pulse" />;
  }

  return (
    // now when CUSTOM_DOMAINS_ENABLED is false, we show a stub instead of the actual domain management UI
    !CUSTOM_DOMAINS_ENABLED ? (
      <CustomDomainsDisabled />
    ) : (
    <div>
      <div className="flex items-center justify-between mb-4">
        <p className="text-sm text-zinc-400 max-w-lg">
          Point your own domain at this project&apos;s active deployment — deploys stay live at{" "}
          <span className="font-mono text-zinc-300">{project.slug}.singularitydev.xyz</span> either way.
        </p>
        {!showAddForm && (
          <Button variant="primary" onClick={() => setShowAddForm(true)}>
            <Plus className="w-4 h-4" />
            Add Domain
          </Button>
        )}
      </div>

      {showAddForm && (
        <div className="mb-4">
          <AddDomainForm onSubmit={handleCreate} onCancel={() => setShowAddForm(false)} />
        </div>
      )}

      <div className="flex flex-col gap-2">
        {domains.length === 0 && !showAddForm && (
          <p className="text-sm text-zinc-500 px-1">No custom domains yet.</p>
        )}
        {domains.map((domain) => (
          <DomainRow key={domain.id} domain={domain} onVerified={handleVerified} onDelete={() => handleDelete(domain.id)} />
        ))}
      </div>
    </div>
    )
  );
}

function CustomDomainsDisabled() {
  return (
    <ComingSoonStub
      icon={Globe}
      title="Custom domains coming soon"
      description="Attaching your own domain to a project is under development and will be available in a future release. In the meantime, you can still access your project at its default URL."
    />
  )
};