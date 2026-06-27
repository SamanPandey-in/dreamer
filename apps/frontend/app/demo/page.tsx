"use client";

import { useState, useEffect, useRef } from "react";
import { io, type Socket } from "socket.io-client";
import { apiFetch } from "../../lib/api-client";
import {
  listProjects,
  createDeployment,
  listDeployments,
  getDeployment,
  getDeploymentLogs,
} from "../../lib/dashboard-api";
import type { Project, Deployment, DeploymentStatus, LogLine } from "../../lib/dashboard-types";

const SOCKET_URL = process.env.NEXT_PUBLIC_SOCKET_URL || "http://localhost:9002";

function StatusBadge({ status }: { status: DeploymentStatus }) {
  const colors: Record<DeploymentStatus, string> = {
    QUEUED: "#6b7280",
    BUILDING: "#f59e0b",
    UPLOADING: "#3b82f6",
    STARTING: "#8b5cf6",
    RUNNING: "#10b981",
    SLEEPING: "#6366f1",
    WAKING: "#a855f7",
    STOPPED: "#ef4444",
    FAILED: "#dc2626",
    CANCELLED: "#9ca3af",
    ERROR: "#b91c1c",
  };
  return (
    <span
      style={{
        display: "inline-block",
        padding: "2px 8px",
        borderRadius: 4,
        fontSize: 12,
        fontWeight: 600,
        color: "#fff",
        backgroundColor: colors[status] || "#6b7280",
      }}
    >
      {status}
    </span>
  );
}

async function postRollback(deploymentId: string): Promise<Deployment> {
  const res = await apiFetch(`/api/deployments/${deploymentId}/rollback`, { method: "POST" });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error ?? "Rollback failed");
  return data.deployment;
}

async function postStop(deploymentId: string): Promise<Deployment> {
  const res = await apiFetch(`/api/deployments/${deploymentId}/stop`, { method: "POST" });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error ?? "Stop failed");
  return data.deployment;
}

export default function Demo() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [selectedDeployment, setSelectedDeployment] = useState<Deployment | null>(null);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [socketConnected, setSocketConnected] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const socketRef = useRef<Socket | null>(null);
  const subscribedDeploymentRef = useRef<string | null>(null);

  useEffect(() => {
    listProjects()
      .then(setProjects)
      .catch((err) => setError(err.message));
  }, []);

  useEffect(() => {
    if (!selectedProjectId) return;
    let cancelled = false;
    listDeployments(selectedProjectId, { limit: 20 })
      .then((data) => { if (!cancelled) setDeployments(data.deployments); })
      .catch((err) => setError(err.message));
    return () => { cancelled = true; };
  }, [selectedProjectId]);

  useEffect(() => {
    const socket = io(SOCKET_URL);
    socketRef.current = socket;

    socket.on("connect", () => setSocketConnected(true));
    socket.on("disconnect", () => setSocketConnected(false));

    socket.on("log", (log: LogLine) => {
      setLogs((prev) => {
        if (prev.some((l) => l.id === log.id)) return prev;
        return [...prev, log];
      });
    });

    socket.on("status", (e: { status: DeploymentStatus; url: string | null }) => {
      setSelectedDeployment((prev) => {
        if (!prev) return prev;
        return { ...prev, status: e.status, url: e.url ?? prev.url };
      });
    });

    return () => { socket.disconnect(); };
  }, []);

  useEffect(() => {
    const socket = socketRef.current;
    if (!socket || !selectedDeployment) return;

    const prev = subscribedDeploymentRef.current;
    if (prev) socket.emit("unsubscribe", prev);

    socket.emit("subscribe", selectedDeployment.id);
    subscribedDeploymentRef.current = selectedDeployment.id;

    return () => {
      socket.emit("unsubscribe", selectedDeployment.id);
      subscribedDeploymentRef.current = null;
    };
  }, [selectedDeployment?.id]);

  const handleCreateDeployment = async () => {
    if (!selectedProjectId) return;
    setLoading(true);
    setError(null);
    try {
      const deployment = await createDeployment(selectedProjectId);
      setDeployments((prev) => [deployment, ...prev]);
      setSelectedDeployment(deployment);
      setLogs([]);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to create deployment");
    } finally {
      setLoading(false);
    }
  };

  const handleStopDeployment = async (deploymentId: string) => {
    setActionLoading(deploymentId);
    setError(null);
    try {
      const updated = await postStop(deploymentId);
      setDeployments((prev) => prev.map((d) => (d.id === deploymentId ? updated : d)));
      if (selectedDeployment?.id === deploymentId) setSelectedDeployment(updated);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to stop deployment");
    } finally {
      setActionLoading(null);
    }
  };

  const handleRollbackDeployment = async (deploymentId: string) => {
    setActionLoading(deploymentId);
    setError(null);
    try {
      const newDeployment = await postRollback(deploymentId);
      setDeployments((prev) => [newDeployment, ...prev]);
      setSelectedDeployment(newDeployment);
      setLogs([]);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to rollback deployment");
    } finally {
      setActionLoading(null);
    }
  };

  const handleRefreshDeployment = async (deploymentId: string) => {
    try {
      const updated = await getDeployment(deploymentId);
      setDeployments((prev) => prev.map((d) => (d.id === deploymentId ? updated : d)));
      if (selectedDeployment?.id === deploymentId) setSelectedDeployment(updated);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to refresh deployment");
    }
  };

  const canStop = (status: DeploymentStatus) =>
    ["QUEUED", "BUILDING", "UPLOADING", "STARTING", "RUNNING"].includes(status);

  const canRollback = (status: DeploymentStatus, hasCommitHash: boolean) =>
    ["RUNNING", "STOPPED"].includes(status) && hasCommitHash;

  return (
    <div style={{ padding: 40, fontFamily: "monospace", maxWidth: 1200 }}>
      <h1>Deployment Test Console</h1>

      <div style={{ marginBottom: 16, padding: 12, background: "#f3f4f6", borderRadius: 8 }}>
        <strong>Socket:</strong> {socketConnected ? "Connected" : "Disconnected"}
      </div>

      {error && (
        <div style={{ marginBottom: 16, padding: 12, background: "#fef2f2", color: "#dc2626", borderRadius: 8 }}>
          {error}
          <button onClick={() => setError(null)} style={{ marginLeft: 12, cursor: "pointer" }}>Dismiss</button>
        </div>
      )}

      <section style={{ marginBottom: 24 }}>
        <h2>1. Select Project</h2>
        <select
          value={selectedProjectId || ""}
          onChange={(e) => {
            const val = e.target.value || null;
            setSelectedProjectId(val);
            setSelectedDeployment(null);
            setLogs([]);
            if (val) {
              listDeployments(val, { limit: 20 }).then((d) => setDeployments(d.deployments)).catch(() => {});
            } else {
              setDeployments([]);
            }
          }}
          style={{ padding: 8, width: 400, fontSize: 14 }}
        >
          <option value="">-- Choose a project --</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>{p.name} ({p.slug})</option>
          ))}
        </select>
      </section>

      <section style={{ marginBottom: 24 }}>
        <h2>2. Create Deployment</h2>
        <button
          onClick={handleCreateDeployment}
          disabled={!selectedProjectId || loading}
          style={{
            padding: "8px 16px", fontSize: 14,
            cursor: selectedProjectId && !loading ? "pointer" : "not-allowed",
            backgroundColor: selectedProjectId && !loading ? "#2563eb" : "#9ca3af",
            color: "#fff", border: "none", borderRadius: 4,
          }}
        >
          {loading ? "Creating..." : "Deploy Latest"}
        </button>
      </section>

      <section style={{ marginBottom: 24 }}>
        <h2>3. Deployments</h2>
        {deployments.length === 0 ? (
          <p style={{ color: "#6b7280" }}>No deployments yet.</p>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: "2px solid #e5e7eb", textAlign: "left" }}>
                <th style={{ padding: 8 }}>Slug</th>
                <th style={{ padding: 8 }}>Status</th>
                <th style={{ padding: 8 }}>Branch</th>
                <th style={{ padding: 8 }}>Commit</th>
                <th style={{ padding: 8 }}>Created</th>
                <th style={{ padding: 8 }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {deployments.map((d) => (
                <tr
                  key={d.id}
                  style={{
                    borderBottom: "1px solid #e5e7eb",
                    backgroundColor: selectedDeployment?.id === d.id ? "#eff6ff" : "transparent",
                    cursor: "pointer",
                  }}
                  onClick={() => {
                    setSelectedDeployment(d);
                    setLogs([]);
                    getDeploymentLogs(d.id).then(setLogs).catch(() => {});
                  }}
                >
                  <td style={{ padding: 8 }}>{d.slug}</td>
                  <td style={{ padding: 8 }}><StatusBadge status={d.status} /></td>
                  <td style={{ padding: 8 }}>{d.branch}</td>
                  <td style={{ padding: 8, maxWidth: 120, overflow: "hidden", textOverflow: "ellipsis" }}>
                    {d.commitHash?.slice(0, 8) || "-"}
                  </td>
                  <td style={{ padding: 8 }}>{new Date(d.createdAt).toLocaleTimeString()}</td>
                  <td style={{ padding: 8 }} onClick={(e) => e.stopPropagation()}>
                    <button
                      onClick={() => handleRefreshDeployment(d.id)}
                      style={{ marginRight: 8, padding: "4px 8px", fontSize: 12, cursor: "pointer" }}
                    >Refresh</button>
                    {canStop(d.status) && (
                      <button
                        onClick={() => handleStopDeployment(d.id)}
                        disabled={actionLoading === d.id}
                        style={{
                          marginRight: 8, padding: "4px 8px", fontSize: 12, cursor: "pointer",
                          backgroundColor: "#ef4444", color: "#fff", border: "none", borderRadius: 4,
                        }}
                      >{actionLoading === d.id ? "..." : "Stop"}</button>
                    )}
                    {canRollback(d.status, !!d.commitHash) && (
                      <button
                        onClick={() => handleRollbackDeployment(d.id)}
                        disabled={actionLoading === d.id}
                        style={{
                          padding: "4px 8px", fontSize: 12, cursor: "pointer",
                          backgroundColor: "#f59e0b", color: "#fff", border: "none", borderRadius: 4,
                        }}
                      >{actionLoading === d.id ? "..." : "Rollback"}</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {selectedDeployment && (
        <section style={{ marginBottom: 24 }}>
          <h2>4. Deployment Detail: {selectedDeployment.slug}</h2>
          <div style={{ padding: 16, background: "#f9fafb", borderRadius: 8, marginBottom: 16, fontSize: 13 }}>
            <div><strong>ID:</strong> {selectedDeployment.id}</div>
            <div><strong>Status:</strong> <StatusBadge status={selectedDeployment.status} /></div>
            <div><strong>URL:</strong> {selectedDeployment.url || "N/A"}</div>
            <div><strong>Branch:</strong> {selectedDeployment.branch}</div>
            <div><strong>Commit Hash:</strong> {selectedDeployment.commitHash || "N/A"}</div>
            <div><strong>Commit Message:</strong> {selectedDeployment.commitMessage || "N/A"}</div>
            <div><strong>Commit Author:</strong> {selectedDeployment.commitAuthor || "N/A"}</div>
            <div><strong>Error:</strong> {selectedDeployment.errorMessage || "N/A"}</div>
            <div><strong>Build Duration:</strong> {selectedDeployment.buildDurationMs ? `${selectedDeployment.buildDurationMs}ms` : "N/A"}</div>
            <div><strong>Triggered By:</strong> {selectedDeployment.triggeredBy}</div>
          </div>
        </section>
      )}

      <section>
        <h2>5. Logs {selectedDeployment ? `(${selectedDeployment.slug})` : ""}</h2>
        <div style={{ background: "#111", color: "#0f0", padding: 16, maxHeight: 500, overflow: "auto", fontSize: 12, borderRadius: 8 }}>
          {logs.length === 0 && <div style={{ color: "#666" }}>No logs yet. Select a deployment to view its logs.</div>}
          {logs.map((log) => (
            <div
              key={log.id}
              style={{
                borderBottom: "1px solid #333", padding: "4px 0",
                color: log.level === "ERROR" ? "#ef4444" : log.level === "WARN" ? "#f59e0b" : "#0f0",
              }}
            >
              <span style={{ color: "#666" }}>[{log.level}]</span>{" "}
              <span style={{ color: "#888" }}>[{log.source || "build"}]</span>{" "}
              {log.message}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
