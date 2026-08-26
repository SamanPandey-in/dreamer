// Single validated config for environment variables: every other file imports
// `env`, never process.env directly, so a missing or malformed variable fails
// at startup instead of at runtime.

import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(8000),
  FRONTEND_URL: z.url(),

  // Optional CORS extras. FRONTEND_URL (+ localhost) alone isn't enough once
  // the dashboard is also served from preview deployments, which get a fresh
  // subdomain per build (dreamer-<hash>-<team>.vercel.app) — a static origin
  // list drifts out of date on every deploy and preflight fails intermittently.
  // CORS_EXTRA_ORIGINS: comma-separated additional exact origins to allow.
  // CORS_ORIGIN_REGEX: regex string (no slashes) checked against the request
  // Origin header, e.g. `^https://dreamer-[a-z0-9]+-saman-pandey\.vercel\.app$`.
  CORS_EXTRA_ORIGINS: z.string().optional(),
  CORS_ORIGIN_REGEX: z.string().optional(),

  // COOKIE_DOMAIN: the Domain attribute for the refresh-token and GitHub
  // state cookies. Strongly prefer setting it: serve frontend and API as
  // subdomains of ONE registrable domain (frontend on deploy.yourdomain.com,
  // API on api.yourdomain.com) and set COOKIE_DOMAIN=.yourdomain.com. Two
  // DIFFERENT registrable domains force SameSite=None third-party cookies,
  // which Safari/Firefox already block by default (and Chrome increasingly) —
  // the cookie gets set fine on GitHub's redirect but silently never sent on
  // the SPA's cross-site fetch('/api/auth/refresh'), so every refresh looks
  // like "no session". Cookies scoped to a shared registrable domain are
  // same-site regardless of subdomain, so they're sent as SameSite=Lax.
  // See auth.controller.ts's cookie helpers.
  COOKIE_DOMAIN: z.string().optional(),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  DATABASE_CA_CERT: z.string().min(1, 'DATABASE_CA_CERT is required (the PEM contents of your Postgres CA certificate)').optional(),
  REDIS_URL: z.string().min(1).default('redis://localhost:6379'),
  // Dedicated Redis instance for BullMQ only (queues + workers), separate
  // from REDIS_URL (route cache, metrics counters, pub/sub, Streams) so its
  // connection count, memory footprint, and eviction policy can be scaled
  // and tuned independently — see lib/queue.ts. Optional; falls back to
  // REDIS_URL.
  REDIS_BUILDER_URL: z.string().min(1).optional(),

  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
  JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be at least 32 characters'),
  ACCESS_TOKEN_TTL: z.string().default('15m'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().default(7),

  ENCRYPTION_KEY: z
    .string()
    .length(64, 'ENCRYPTION_KEY must be a 64-character hex string (32 bytes)'),

  // Shared secret pasted into each repo's own webhook settings AND here, used
  // to verify X-Hub-Signature-256 (webhooks/github-webhook.service.ts). Unset
  // by default: push-to-deploy stays inert until this AND ENABLE_PUSH_DEPLOY
  // are set. Manual "Redeploy" always works regardless.
  GITHUB_WEBHOOK_SECRET: z.string().optional(),

  // This api-server's own publicly reachable origin — only meaningful when
  // ENABLE_PUSH_DEPLOY is on (used to build the webhook URL you paste into
  // GitHub: `${API_PUBLIC_URL}/api/webhooks/github`). Defaults to
  // localhost so local dev boots without extra config.
  API_PUBLIC_URL: z.url().default('http://localhost:8000'),
  // Whether nginx is expected to expose /api/webhooks/github publicly at all.
  // Informational to api-server itself (nginx enforces it; the Express route
  // is mounted either way) — surfaced in Settings so the dashboard can show
  // whether push-deploy is reachable from the internet right now.
  ENABLE_PUSH_DEPLOY: z.coerce.boolean().default(false),

  // ── S3-compatible storage — MinIO (bundled in docker-compose.yml).
  // @aws-sdk/client-s3 is still the client because MinIO speaks the S3
  // protocol, but nothing here is a real AWS credential or endpoint — see
  // lib/s3-client.ts.
  AWS_REGION: z.string().default('us-east-1'),
  AWS_ACCESS_KEY_ID: z.string().min(1, 'AWS_ACCESS_KEY_ID is required (this is your MinIO root user, not a real AWS key)'),
  AWS_SECRET_ACCESS_KEY: z.string().min(1, 'AWS_SECRET_ACCESS_KEY is required (this is your MinIO root password, not a real AWS secret)'),
  S3_BUCKET: z.string().default('dreamer-outputs'),
  // MinIO's endpoint — the docker-compose service URL, never real AWS's
  // default endpoint resolution.
  S3_ENDPOINT_URL: z.string().min(1, 'S3_ENDPOINT_URL is required — point this at your MinIO endpoint, e.g. http://minio:9000'),
  // MinIO only supports path-style bucket addressing (`host/bucket/key`),
  // not virtual-hosted-style (`bucket.host/key`) — this must be true here.
  S3_FORCE_PATH_STYLE: z.coerce.boolean().default(true),

  // Custom domains. Same value reverse-proxy's BASE_DOMAIN env gets — needed
  // to build the CNAME target handed back in DNS instructions and to reject
  // a "custom" domain that IS just BASE_DOMAIN itself.
  BASE_DOMAIN: z.string().min(1, 'BASE_DOMAIN is required — the domain you own that install.sh set up TLS for'),

  // Optional: automatic TLS for verified custom domains via Render's Custom
  // Domains API — a separate integration, unrelated to where builds run.
  // Left unset by default (install.sh only issues a certificate for YOUR
  // wildcard domain): custom-domain.service.ts then leaves sslStatus at
  // 'pending' and logs once instead of failing — domains still verify and
  // route over plain HTTP, TLS for a user's own domain just stays manual
  // (scripts/lib/issue-certificate.sh).
  RENDER_API_KEY: z.string().optional(),
  RENDER_SERVICE_ID: z.string().optional(),

  // ── Local build/run engine ──────────────────────────────────────────
  // Local image tag for build-engine — built once with
  // `docker build -t <this> ./build-engine`, run via `docker run`.
  DOCKER_BUILD_ENGINE_IMAGE: z.string().min(1, 'DOCKER_BUILD_ENGINE_IMAGE is required — build it first: docker build -t dreamer-build-engine:local ./build-engine'),
  // The compose network build-engine and app containers must join (--network
  // at `docker run` time) to reach Postgres/Redis/MinIO by service name, and
  // to be reachable FROM reverse-proxy by container name in turn. App
  // containers publish NO host port at all — reverse-proxy reaches them
  // container-to-container; only nginx publishes a host port.
  DOCKER_NETWORK: z.string().default('dreamer-local'),
});

function loadEnv() {
  const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) {
    console.error('Invalid environment variables:');
    console.error(z.treeifyError(parsed.error));
    process.exit(1);
  }

  return parsed.data;
}

// Validated ONCE, at import time. Every other file imports `env`, not `process.env`,
// so a missing/malformed variable crashes the process at boot — not three requests
// into production when someone finally hits the code path that needed it.
export const env = loadEnv();
