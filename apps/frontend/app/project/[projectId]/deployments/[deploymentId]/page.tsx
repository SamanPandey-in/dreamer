"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { Copy, ExternalLink } from "lucide-react";
import { getDeployment, getDeploymentLogs } from "@/lib/dashboard-api";
import { TERMINAL_STATUSES } from "@/lib/dashboard-types";
import type { DeploymentDetail, DeploymentStatus, LogLine } from "@/lib/dashboard-types";
import { useDeploymentSocket } from "@/lib/use-deployment-socket";
import { BuildSummaryCard } from "@/components/dashboard/BuildSummaryCard";
import { DeploymentActions } from "@/components/dashboard/DeploymentActions";
import { LogPanel } from "@/components/dashboard/LogPanel";
import { StateTimeline } from "@/components/dashboard/StateTimeline";
import { StatusBadge } from "@/components/dashboard/StatusBadge";

export default function DeploymentDetailPage() {
  const { projectId, deploymentId } = useParams<{ projectId: string; deploymentId: string }>();

  const [deployment, setDeployment] = useState<DeploymentDetail | null>(null);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([getDeployment(deploymentId), getDeploymentLogs(deploymentId)])
      .then(([deploymentData, logData]) => {
        setDeployment(deploymentData);
        setLogs(logData);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load deployment"));
  }, [deploymentId]);

  const handleLog = useCallback((log: LogLine) => {
    setLogs((prev) => (prev.some((l) => l.sequence === log.sequence) ? prev : [...prev, log]));
  }, []);

  const handleStatus = useCallback((status: DeploymentStatus, url: string | null) => {
    setDeployment((prev) => (prev ? { ...prev, status, url: url ?? prev.url } : prev));
  }, []);

  const isTerminalOnLoad = deployment ? TERMINAL_STATUSES.includes(deployment.status) : false;

  useDeploymentSocket(deploymentId, {
    enabled: Boolean(deployment) && !isTerminalOnLoad,
    onLog: handleLog,
    onStatus: handleStatus,
  });

  if (error) {
    return <p className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-4 py-3">{error}</p>;
  }

  if (!deployment) {
    return <div className="h-64 rounded-2xl border border-zinc-800 bg-zinc-950/40 animate-pulse" />;
  }

  return (
    <div>
      <div className="flex items-center justify-between gap-3 mb-1 flex-wrap">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-bold font-mono">{deployment.slug}</h1>
          <StatusBadge status={deployment.status} />
        </div>
        <DeploymentActions
          deployment={deployment}
          projectId={projectId}
          onStopped={(updated) => setDeployment((prev) => (prev ? { ...prev, ...updated } : prev))}
        />
      </div>

      {deployment.url && (
        <div className="flex items-center gap-2 mb-6">
          <a
            href={deployment.url}
            target="_blank"
            rel="noreferrer"
            className="text-sm text-blue-400 hover:text-blue-300 flex items-center gap-1"
          >
            {deployment.url}
            <ExternalLink className="w-3.5 h-3.5" />
          </a>
          <button
            onClick={() => navigator.clipboard.writeText(deployment.url!)}
            className="text-zinc-500 hover:text-zinc-300"
            aria-label="Copy URL"
          >
            <Copy className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {deployment.errorMessage && (
        <div className="mb-6 text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-4 py-3">
          <p className="font-medium mb-0.5">{deployment.errorCode}</p>
          <p>{deployment.errorMessage}</p>
        </div>
      )}

      <BuildSummaryCard deployment={deployment} />

      <div className="bg-zinc-950/80 rounded-2xl border border-zinc-800 p-5 mb-6 overflow-x-auto">
        <h2 className="text-sm font-semibold text-zinc-400 uppercase tracking-wider mb-4">Timeline</h2>
        <StateTimeline transitions={deployment.stateTransitions} />
      </div>

      <h2 className="text-sm font-semibold text-zinc-400 uppercase tracking-wider mb-3 px-1">Build Logs</h2>
      <LogPanel logs={logs} isStreaming={!isTerminalOnLoad} />
    </div>
  );
}
