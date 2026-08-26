// Single source of truth for the production origin — every piece of SEO
// metadata (layout.tsx, sitemap.ts, robots.ts, opengraph-image.tsx,
// twitter-image.tsx) reads from here instead of hardcoding the domain
// separately, the same "one manifest, everything else derives from it"
// pattern docs-manifest.ts already uses for the docs site structure.
//
// Reads NEXT_PUBLIC_SITE_URL (set it to your own domain in .env — see
// .env.deploy.example) rather than hardcoding any particular domain,
// since this is the self-hosted build anyone can run on their own VPS
// under their own domain.
export const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000";
export const SITE_NAME = "Dreamer";

export const SITE_TAGLINE = "Your own Vercel — deployed in seconds, owned forever";

// Kept short and factual on purpose: this exact string is reused in
// metadata descriptions, the OG/Twitter image, and llms.txt, so it's the
// one sentence every surface (search results, link unfurls, and AI
// crawlers/answer engines alike) agrees on.
export const SITE_DESCRIPTION =
  "Dreamer is a Vercel/Railway-style PaaS. Connect a GitHub repo and get a live URL in minutes — self-hosted entirely on your own infrastructure, no cloud provider account required. Auto-detects your framework, builds static or dynamic apps, and redeploys automatically on every push.";
