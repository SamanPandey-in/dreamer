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
 * `deployment:{id}` room — see api-server's src/realtime/socket.server.ts.
 * Mirrors the connect/subscribe pattern already proven out in
 * apps/frontend/app/demo/page.tsx, plus the access-token handshake that
 * page never needed (it predates auth entirely).
 */
export function useDeploymentSocket(deploymentId: string, { enabled, onLog, onStatus }: UseDeploymentSocketOptions) {
  const [connected, setConnected] = useState(false);

  // Refs, not dependencies — this hook re-renders far less than the
  // deployment detail page does (every new log line is a state update on
  // the PAGE, not here). Reading the latest callback through a ref instead
  // of re-subscribing the whole socket on every render is what keeps this
  // hook's effect dependency array down to just [deploymentId, enabled].
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

    // If the in-memory access token rotates (apiFetch's silent refresh)
    // while this panel is open, update what the NEXT reconnect attempt
    // sends — Socket.IO re-reads socket.auth on every reconnect, so this is
    // enough to recover from a token rotation without forcing a disconnect
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
