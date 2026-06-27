"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { MoreVertical, RotateCcw, Rocket } from "lucide-react";
import { createDeployment, rollbackDeployment } from "@/lib/dashboard-api";
import { ROLLBACK_TARGET_STATUSES } from "@/lib/dashboard-types";
import type { Deployment } from "@/lib/dashboard-types";
import { ConfirmModal } from "./ConfirmModal";

export function DeploymentMenu({ projectId, deployment }: { projectId: string; deployment: Deployment }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [confirmingRollback, setConfirmingRollback] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const canRollback = ROLLBACK_TARGET_STATUSES.includes(deployment.status) && Boolean(deployment.commitHash);

  async function handleRedeploy(e: React.MouseEvent) {
    e.stopPropagation();
    setOpen(false);
    const created = await createDeployment(projectId, deployment.branch);
    router.push(`/project/${projectId}/deployments/${created.id}`);
  }

  async function handleRollback() {
    const created = await rollbackDeployment(deployment.id);
    router.push(`/project/${projectId}/deployments/${created.id}`);
  }

  return (
    <div ref={ref} className="relative" onClick={(e) => e.stopPropagation()}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="p-1.5 text-zinc-500 hover:text-zinc-200 transition-colors"
        aria-label="More actions"
      >
        <MoreVertical className="w-4 h-4" />
      </button>

      {open && (
        <div className="absolute right-0 mt-1 w-44 bg-zinc-950 border border-zinc-800 rounded-xl shadow-2xl shadow-black/50 py-1.5 z-20">
          <button
            onClick={handleRedeploy}
            className="w-full flex items-center gap-2 px-3 py-2 text-sm text-zinc-300 hover:bg-zinc-900 transition-colors"
          >
            <Rocket className="w-3.5 h-3.5" />
            Redeploy
          </button>
          {canRollback && (
            <button
              onClick={() => {
                setOpen(false);
                setConfirmingRollback(true);
              }}
              className="w-full flex items-center gap-2 px-3 py-2 text-sm text-zinc-300 hover:bg-zinc-900 transition-colors"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              Roll back to this
            </button>
          )}
        </div>
      )}

      {confirmingRollback && (
        <ConfirmModal
          title="Roll back to this deployment?"
          description={`This rebuilds commit ${deployment.commitHash?.slice(0, 7)} as a brand-new deployment with fresh build logs.`}
          confirmLabel="Roll back"
          onConfirm={handleRollback}
          onClose={() => setConfirmingRollback(false)}
        />
      )}
    </div>
  );
}
