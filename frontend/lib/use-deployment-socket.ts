"use client";

import { useEffect, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import { getAccessToken, onAccessTokenChange } from "./api-client";
import { SOCKET_URL } from "./config";
import type { DeploymentStatus, LogLine } from "./dashboard-types";

interface UseDeploymentSocketOptions {
  /** Skip connecting entirely if the deployment was already terminal on first load — no event will ever arrive. */
  enabled: boolean;
  onLog: (log: LogLine) => void;
  onStatus: (status: DeploymentStatus, url: string | null) => void;
}

/**
 * One socket per mounted log panel, joined to exactly one
 * `deployment:{id}` room — see api-server/src/realtime/socket.server.ts.
 */
export function useDeploymentSocket(deploymentId: string, { enabled, onLog, onStatus }: UseDeploymentSocketOptions) {
  const [connected, setConnected] = useState(false);

  // Callbacks live in refs, not effect deps: log/status fire far more often
  // than this hook re-renders (each new log line is a state update on the
  // page, not here), and reading the latest callback through a ref keeps the
  // effect dependency array down to just [deploymentId, enabled].
  const onLogRef = useRef(onLog);
  const onStatusRef = useRef(onStatus);

  useEffect(() => {
    onLogRef.current = onLog;
    onStatusRef.current = onStatus;
  });

  useEffect(() => {
    if (!enabled) return;

    const socket: Socket = io(SOCKET_URL, { auth: { token: getAccessToken() } });

    socket.on("connect", () => {
      setConnected(true);
      socket.emit("subscribe", deploymentId);
    });
    socket.on("disconnect", () => setConnected(false));
    socket.on("log", (log: LogLine) => onLogRef.current(log));
    socket.on("status", (e: { status: DeploymentStatus; url: string | null }) => {
      onStatusRef.current(e.status, e.url);
    });

    // If the access token rotates while this panel is open (apiFetch's
    // silent refresh), update socket.auth — Socket.IO re-reads it on every
    // reconnect, so rotation recovers without forcing a disconnect
    // mid-stream.
    const unsubscribe = onAccessTokenChange((token) => {
      socket.auth = { token };
    });

    return () => {
      unsubscribe();
      socket.disconnect();
    };
  }, [deploymentId, enabled]);

  return { connected };
}
