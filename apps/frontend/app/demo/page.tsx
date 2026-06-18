"use client";

import { useState, useEffect, useRef } from "react";
import { io } from "socket.io-client";

export default function Demo() {
  const [gitUrl, setGitUrl] = useState("");
  const [slug, setSlug] = useState("");
  const [loading, setLoading] = useState(false);
  const [messages, setMessages] = useState<string[]>([]);
  const [connected, setConnected] = useState(false);
  const socketRef = useRef<ReturnType<typeof io> | null>(null);
  const subscribedSlugRef = useRef<string | null>(null);

  useEffect(() => {
    const socket = io("http://localhost:9002");
    socketRef.current = socket;

    socket.on("connect", () => setConnected(true));
    socket.on("disconnect", () => setConnected(false));

    socket.on("message", (data: any) => {
      setMessages((prev) => [...prev, typeof data === "string" ? data : JSON.stringify(data)]);
    });

    return () => { socket.disconnect(); };
  }, []);

  useEffect(() => {
    const socket = socketRef.current;
    if (!socket || !slug) return;

    const prev = subscribedSlugRef.current;
    if (prev) socket.emit("unsubscribe", prev);

    socket.emit("subscribe", `logs:${slug}`);
    subscribedSlugRef.current = `logs:${slug}`;
  }, [slug]);

  const submit = async () => {
    setLoading(true);
    await fetch("http://localhost:3000/project", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ gitUrl, slug: slug || undefined }),
    });
    setLoading(false);
  };

  return (
    <div style={{ padding: 40, fontFamily: "monospace" }}>
      <h1>Create Project</h1>
      <input
        type="text"
        placeholder="Git URL (required)"
        value={gitUrl}
        onChange={(e) => setGitUrl(e.target.value)}
        style={{ display: "block", marginBottom: 8, width: 400 }}
      />
      <input
        type="text"
        placeholder="Slug (optional)"
        value={slug}
        onChange={(e) => setSlug(e.target.value)}
        style={{ display: "block", marginBottom: 8, width: 400 }}
      />
      <button onClick={submit} disabled={loading || !gitUrl}>
        {loading ? "Creating..." : "Create"}
      </button>

      <div style={{ marginTop: 20 }}>
        Socket: {connected ? "🟢 Connected" : "🔴 Disconnected"}
        {slug && <span style={{ marginLeft: 20 }}>Subscribed: logs:{slug}</span>}
      </div>

      <h2>Logs</h2>
      <div style={{ background: "#111", color: "#0f0", padding: 16, maxHeight: 400, overflow: "auto", fontSize: 12 }}>
        {messages.length === 0 && <div style={{ color: "#666" }}>Waiting for messages...</div>}
        {messages.map((msg, i) => (
          <div key={i} style={{ borderBottom: "1px solid #333", padding: "4px 0" }}>{msg}</div>
        ))}
      </div>
    </div>
  );
}
