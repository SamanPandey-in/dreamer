"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { RotateCcw, Square } from "lucide-react";
import { rollbackDeployment, stopDeployment } from "@/lib/dashboard-api";
import { NON_STOPPABLE_STATUSES, ROLLBACK_TARGET_STATUSES } from "@/lib/dashboard-types";
import type { Deployment } from "@/lib/dashboard-types";
import { ConfirmModal } from "./ConfirmModal";

type ActiveModal = "rollback" | "stop" | null;

export function DeploymentActions({
  deployment,
  projectId,
  onStopped,
}: {
  deployment: Deployment;
  projectId: string;
  onStopped: (updated: Deployment) => void;
}) {
  const router = useRouter();
  const [activeModal, setActiveModal] = useState<ActiveModal>(null);

  const canRollback = ROLLBACK_TARGET_STATUSES.includes(deployment.status) && Boolean(deployment.commitHash);
  const canStop = !NON_STOPPABLE_STATUSES.includes(deployment.status);

  async function handleRollback() {
    const rolledBack = await rollbackDeployment(deployment.id);
    router.push(`/project/${projectId}/deployments/${rolledBack.id}`);
  }

  async function handleStop() {
    const stopped = await stopDeployment(deployment.id);
    onStopped(stopped);
    setActiveModal(null);
  }

  if (!canRollback && !canStop) return null;

  return (
    <>
      <div className="flex items-center gap-2">
        {canRollback && (
          <button
            onClick={() => setActiveModal("rollback")}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-zinc-800 bg-zinc-900/60 text-xs font-medium text-zinc-300 hover:bg-zinc-900 hover:text-white transition-colors"
          >
            <RotateCcw className="w-3 h-3" />
            Rollback
          </button>
        )}
        {canStop && (
          <button
            onClick={() => setActiveModal("stop")}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-red-500/20 bg-red-500/5 text-xs font-medium text-red-400 hover:bg-red-500/10 hover:text-red-300 transition-colors"
          >
            <Square className="w-3 h-3" />
            Stop
          </button>
        )}
      </div>

      {activeModal === "rollback" && (
        <ConfirmModal
          title="Roll back to this deployment?"
          description={`This rebuilds commit ${deployment.commitHash?.slice(0, 7)} as a brand-new deployment with fresh build logs — it doesn't reuse this deployment's old build output.`}
          confirmLabel="Roll back"
          onConfirm={handleRollback}
          onClose={() => setActiveModal(null)}
        />
      )}

      {activeModal === "stop" && (
        <ConfirmModal
          title="Stop this deployment?"
          description="This takes it down immediately. You can redeploy or roll back again afterward, but visitors will see it go offline right away."
          confirmLabel="Stop deployment"
          destructive
          onConfirm={handleStop}
          onClose={() => setActiveModal(null)}
        />
      )}
    </>
  );
}
