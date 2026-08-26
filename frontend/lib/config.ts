export const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:8000";

// Socket.IO server — see api-server's src/realtime/index.ts. It shares the
// SAME http.Server (and therefore the same port/origin) as the REST API, not
// a separate port — that separation used to break in production (Render,
// and most single-port PaaS hosts, only expose one port per service).
// NEXT_PUBLIC_SOCKET_URL is kept as an escape hatch for anyone running the
// realtime gateway on a genuinely different host, but the default is now
// API_BASE_URL, not a hardcoded second port.
export const SOCKET_URL = process.env.NEXT_PUBLIC_SOCKET_URL || API_BASE_URL;