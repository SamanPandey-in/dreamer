export const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:8000";

// Socket.IO gateway shares the REST API's http.Server (same port/origin) by
// default — see api-server/src/realtime/index.ts; most single-port PaaS hosts
// expose only one port per service. NEXT_PUBLIC_SOCKET_URL is an escape hatch
// for running the realtime gateway on a genuinely different host.
export const SOCKET_URL = process.env.NEXT_PUBLIC_SOCKET_URL || API_BASE_URL;