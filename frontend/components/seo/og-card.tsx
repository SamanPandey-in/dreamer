// Shared by app/opengraph-image.tsx and app/twitter-image.tsx so the two
// link-preview surfaces (OG vs X) never drift apart. Returns JSX only —
// each route file wraps it in its own next/og ImageResponse call, which is
// what Next.js's file-based metadata system looks for.
//
// Styles are limited to what satori renders reliably: flexbox, absolute
// positioning, solid/gradient backgrounds, borders. `filter: blur()` and
// `background-clip: text` fail silently instead of loudly, so they're avoided.
import { SITE_URL } from "@/lib/site";

export function OgCard() {
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        padding: "72px",
        background: "linear-gradient(135deg, #030712 0%, #060a17 55%, #0a1224 100%)",
        fontFamily: "sans-serif",
      }}
    >
      {/* Top row — wordmark */}
      <div style={{ display: "flex", alignItems: "center", gap: "14px" }}>
        <div
          style={{
            width: "40px",
            height: "40px",
            borderRadius: "10px",
            background: "linear-gradient(135deg, #3b82f6, #6366f1)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: "22px",
            fontWeight: 800,
            color: "white",
          }}
        >
          D
        </div>
        <div style={{ fontSize: "26px", fontWeight: 700, color: "#f4f4f5" }}>Dreamer</div>
      </div>

      {/* Middle — headline, mirrors the landing page hero */}
      <div style={{ display: "flex", flexDirection: "column" }}>
        <div style={{ fontSize: "76px", fontWeight: 800, color: "#fafafa", lineHeight: 1.05 }}>
          Your Own Vercel,
        </div>
        <div style={{ fontSize: "60px", fontWeight: 800, color: "#60a5fa", lineHeight: 1.1 }}>
          Deployed in Seconds, Owned Forever
        </div>
      </div>

      {/* Bottom row — free-hosting badge + url */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            padding: "10px 20px",
            borderRadius: "999px",
            background: "rgba(59, 130, 246, 0.12)",
            border: "1px solid rgba(59, 130, 246, 0.4)",
            color: "#93c5fd",
            fontSize: "22px",
            fontWeight: 600,
          }}
        >
          Self-Hosted — Open Source at Heart
        </div>
        <div style={{ fontSize: "22px", color: "#71717a" }}>{SITE_URL.replace(/^https?:\/\//, "")}</div>
      </div>
    </div>
  );
}

export const OG_IMAGE_SIZE = { width: 1200, height: 630 };
