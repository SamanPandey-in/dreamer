// single validate config file for env variables
// this is done so every other file imports env, never process.env directly
// due to this, a missing or malformed variable will throw an error on startup instead of at runtime
// we are following a LLD pattern here and avoiding/solving runtime bugs beforehand

import 'dotenv/config';
import { z } from 'zod';

// here we are defining the schema for validation from zod, which is a TypeScript-first schema declaration and validation library
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(8000),
  FRONTEND_URL: z.url(),

  // Optional: CORS. FRONTEND_URL alone (plus a hardcoded localhost pair) isn't
  // enough once the dashboard is also opened from Vercel preview
  // deployments — every PR/preview build gets its own subdomain
  // (dreamer-<hash>-<team>.vercel.app), so a static origin list drifts out
  // of date on every single preview deploy and the browser's CORS
  // preflight fails intermittently, exactly matching "works sometimes."
  // CORS_EXTRA_ORIGINS: comma-separated list of additional exact origins to
  // allow (e.g. a staging frontend URL) — optional, on top of FRONTEND_URL
  // and localhost, which are always allowed.
  CORS_EXTRA_ORIGINS: z.string().optional(),
  // CORS_ORIGIN_REGEX: an optional regex (as a string, no slashes) checked
  // against the request Origin header — this is how a whole class of
  // origins (e.g. every Vercel preview URL for this project) is allowed
  // without hardcoding or updating a list on every deploy. Example for a
  // Vercel project named "dreamer" under team "saman-pandey":
  // `^https://dreamer-[a-z0-9]+-saman-pandey\.vercel\.app$`
  CORS_ORIGIN_REGEX: z.string().optional(),

  // COOKIE_DOMAIN: the Domain attribute for the refresh-token and GitHub
  // state cookies. Leave unset only for genuinely cross-site deployments
  // (frontend and API on different registrable domains) or local dev.
  //
  // Strongly prefer setting this. Cookies shared across two DIFFERENT
  // registrable domains only work as SameSite=None third-party cookies,
  // and Safari and Firefox already block third-party cookies by default —
  // Chrome blocks them by default in Incognito and a growing share of
  // regular-mode users opt in to blocking them too. That's the actual
  // cause of "logs in, then immediately bounced to /login?error=session_failed":
  // the refreshToken cookie gets set fine on GitHub's redirect (a top-level
  // navigation), but the SPA's own follow-up `fetch('/api/auth/refresh',
  // {credentials:'include'})` is a cross-site subresource request, and
  // that's exactly the request third-party-cookie blocking targets — the
  // cookie silently never gets sent, every refresh looks like "no session."
  //
  // The fix is DNS/hosting, not code: put the API on a SUBDOMAIN of the
  // same registrable domain as the frontend (e.g. frontend on
  // deploy.yourdomain.com, API on api.yourdomain.com — both under
  // `yourdomain.com`), then set COOKIE_DOMAIN=.yourdomain.com here. Cookies scoped to a shared
  // registrable domain are same-site regardless of subdomain, so they're
  // sent as SameSite=Lax and are NOT subject to third-party-cookie
  // blocking by any browser. See auth.controller.ts's cookie helpers for
  // how this changes SameSite/Secure.
  COOKIE_DOMAIN: z.string().optional(),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  DATABASE_CA_CERT: z.string().min(1, 'DATABASE_CA_CERT is required (the PEM contents of your Postgres CA certificate)').optional(),
  REDIS_URL: z.string().min(1).default('redis://localhost:6379'),
  // NEW — dedicated Redis instance for BullMQ only (queues + workers).
  // Kept separate from REDIS_URL (ordinary commands: route cache, metrics
  // counters, pub/sub, Streams) specifically so BullMQ's connection count,
  // memory footprint, and eviction policy can be scaled/tuned independently
  // of everything else that touches Redis — see lib/queue.ts's own comment
  // for exactly what "BullMQ work" covers. Optional and falls back to
  // REDIS_URL so existing single-Redis deployments keep working unchanged
  // until REDIS_BUILDER_URL is actually set to something different.
  REDIS_BUILDER_URL: z.string().min(1).optional(),

  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
  JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be at least 32 characters'),
  ACCESS_TOKEN_TTL: z.string().default('15m'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().default(7),

  ENCRYPTION_KEY: z
    .string()
    .length(64, 'ENCRYPTION_KEY must be a 64-character hex string (32 bytes)'),

  // Optional — the shared secret pasted into each repo's own webhook
  // settings AND here, so webhooks/github-webhook.service.ts can verify
  // X-Hub-Signature-256. Unset by default: a fresh local-engine install has
  // NO working push-to-deploy webhook until the operator both sets this
  // AND turns on ENABLE_PUSH_DEPLOY (see docs/architecture/
  // local-engine-auth-and-networking.md Decision 3 & 4). Manual "Redeploy"
  // from the dashboard always works regardless of whether this is set.
  GITHUB_WEBHOOK_SECRET: z.string().optional(),

  // This api-server's own publicly reachable origin — only meaningful when
  // ENABLE_PUSH_DEPLOY is on (used to build the webhook URL you paste into
  // GitHub: `${API_PUBLIC_URL}/api/webhooks/github`). Defaults to
  // localhost so local dev boots without extra config.
  API_PUBLIC_URL: z.url().default('http://localhost:8000'),
  // Whether nginx is expected to expose /api/webhooks/github publicly at
  // all — see docs/architecture/local-engine-auth-and-networking.md
  // Decision 4. Purely informational to api-server itself (nginx is what
  // actually enforces this; this app-level route is always mounted either
  // way, see app.ts) — surfaced in Settings so the dashboard can show
  // whether push-deploy is reachable from the internet right now.
  ENABLE_PUSH_DEPLOY: z.coerce.boolean().default(false),

  // ── S3-compatible storage — MinIO (bundled in docker-compose.yml),
  // not AWS S3. @aws-sdk/client-s3 is still the client (MinIO speaks the
  // same protocol), but nothing here is a real AWS credential or talks
  // to any real AWS endpoint — see lib/s3-client.ts.
  AWS_REGION: z.string().default('us-east-1'),
  AWS_ACCESS_KEY_ID: z.string().min(1, 'AWS_ACCESS_KEY_ID is required (this is your MinIO root user, not a real AWS key)'),
  AWS_SECRET_ACCESS_KEY: z.string().min(1, 'AWS_SECRET_ACCESS_KEY is required (this is your MinIO root password, not a real AWS secret)'),
  S3_BUCKET: z.string().default('dreamer-outputs'),
  // MinIO's endpoint — always set locally (docker-compose.yml's
  // service name), never real AWS's default endpoint resolution.
  S3_ENDPOINT_URL: z.string().min(1, 'S3_ENDPOINT_URL is required — point this at your MinIO endpoint, e.g. http://minio:9000'),
  // MinIO doesn't support virtual-hosted-style bucket addressing
  // (`bucket.host/key`) — only path-style (`host/bucket/key`) — so this
  // is always true here, unlike the cloud schema this was forked from.
  S3_FORCE_PATH_STYLE: z.coerce.boolean().default(true),

  // ★ NEW — custom domains (domains/custom-domain.service.ts). Same value
  // reverse-proxy's own BASE_DOMAIN env is set to — api-server needs it too
  // now, to build the CNAME target it hands back in DNS instructions and to
  // reject a "custom" domain that's actually just BASE_DOMAIN itself.
  BASE_DOMAIN: z.string().min(1, 'BASE_DOMAIN is required — the domain you own that install.sh set up TLS for'),

  // Optional: automatic TLS for verified custom domains via Render's own
  // Custom Domains API. Not related to build/run at all — this is a
  // separate integration for the case where a USER adds their own custom
  // domain to a project (docs/reverse-proxy/wildcard-domains.md), and has
  // nothing to do with DEPLOYMENT_MODE or where builds run. Left unset on
  // this self-hosted install by default: `install.sh` only issues a
  // certificate for YOUR wildcard domain, not for arbitrary custom
  // domains users add later. When unset, custom-domain.service.ts leaves
  // sslStatus at 'pending' and logs once instead of failing — a domain
  // still verifies and routes correctly over plain HTTP either way, TLS
  // for a customer's own domain is just left manual (issue it yourself
  // with scripts/lib/issue-certificate.sh, the same script install.sh
  // itself uses).
  RENDER_API_KEY: z.string().optional(),
  RENDER_SERVICE_ID: z.string().optional(),

  // ── Local build/run engine ──────────────────────────────────────────
  // Local image tag for build-engine — built once with
  // `docker build -t <this> ./build-engine`. DockerDeploymentEngine's
  // launchBuildTask runs this image with `docker run`.
  DOCKER_BUILD_ENGINE_IMAGE: z.string().min(1, 'DOCKER_BUILD_ENGINE_IMAGE is required — build it first: docker build -t dreamer-build-engine:local ./build-engine'),
  // The compose network build-engine and app containers must join to
  // reach Postgres/Redis/MinIO by service name, and to be reachable FROM
  // reverse-proxy by container name in turn — read at `docker run` time
  // (--network). Deployed app containers publish NO host port at all
  // (see deployDynamicApp): reverse-proxy reaches them container-to-
  // container over this network, same "only nginx publishes a host
  // port" posture as every other service in docker-compose.yml.
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
