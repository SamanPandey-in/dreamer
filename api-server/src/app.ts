import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { authRouter, requireAuth } from './auth';
import { buildConfigRouter } from './build-config';
import { deploymentsRouter } from './deployments';
import { envVariablesRouter } from './env-variables';
import { customDomainsRouter } from './domains'; // NEW
import { githubRepoRouter } from './integrations';
import { githubWebhookRouter } from './webhooks';
import { errorHandlerMiddleware } from './middleware/error-handler.middleware';
import { requestContextMiddleware } from './middleware/request-context.middleware';
import { projectsRouter } from './projects';
import { env } from './lib/env';
import { logger } from './lib/logger';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /**
       * The exact bytes of the request body, captured by express.json()'s
       * verify hook below. Needed ONLY by webhooks/github-webhook.controller.ts
       * to check GitHub's X-Hub-Signature-256 — an HMAC over the raw bytes
       * GitHub sent, which a re-serialized `JSON.stringify(req.body)` is not
       * guaranteed to reproduce byte-for-byte (key order, whitespace).
       */
      rawBody?: Buffer;
    }
  }
}

export const app = express();

// Render sits exactly one reverse-proxy hop in front of this app. Trusting
// only that one hop (not `true`, which trusts the whole X-Forwarded-For
// chain) is what lets req.ip resolve to the real visitor — and is what
// express-rate-limit needs to key the abuse-prone auth routes correctly.
app.set('trust proxy', 1); // Trust exactly the first proxy hop (e.g., load balancer) for correct client IP and secure cookie handling

// MUST be first — every downstream middleware/route/error-handler logs
// inside this request's correlation-ID context (see lib/logger.ts).
app.use(requestContextMiddleware);

// Baseline security headers (HSTS, X-Content-Type-Options, X-Frame-Options,
// Referrer-Policy, etc). CSP is off — this app only ever returns JSON, never
// HTML, so a content-security-policy header here restricts nothing and just
// adds noise; the frontend app is the one that should carry a CSP.
app.use(helmet({ contentSecurityPolicy: false }));

// CORS must allow exactly ONE known origin (never '*') AND credentials: true,
// or the browser silently refuses to send/receive the refresh cookie at all.

// NOTE: This is only required in the production environment, not here in local..
// app.use(cors({ origin: env.FRONTEND_URL, credentials: true }));


// NOTE: this will be the main cors configs for local-engine, since frontend will be running on localhost:3000
// CORS must allow exactly ONE known origin per request (never '*') AND
// credentials: true, or the browser silently refuses to send/receive the
// refresh cookie at all. FRONTEND_URL is the configured frontend origin;
// http://localhost:3000 is allowed alongside it so the Next.js dev server
// can be used for testing.
//
// FIX — this used to be a static array, which only ever matched a single
// fixed frontend URL. That breaks the moment the dashboard is opened from
// anywhere else with its own origin — most commonly a Vercel preview
// deployment, which gets a brand new subdomain
// (dreamer-<hash>-<team>.vercel.app) on every single deploy. A static list
// can never contain a URL that doesn't exist yet, so preflight requests
// from preview URLs fail CORS while the "real" FRONTEND_URL keeps working —
// which is exactly the "works sometimes" symptom this fixes. cors()'s
// `origin` option accepts a function precisely for this: it's called once
// per request with that request's Origin header, so the check can be
// dynamic instead of a fixed list.
const staticAllowedOrigins = new Set(
  [env.FRONTEND_URL, 'http://localhost:3000', 'http://127.0.0.1:3000', ...(env.CORS_EXTRA_ORIGINS?.split(',') ?? [])]
    .map((origin) => origin.trim())
    .filter(Boolean)
);

// Compiled once at startup, not per-request — CORS_ORIGIN_REGEX is trusted
// server config (not user input), so this is safe to build directly from it.
const originPattern = env.CORS_ORIGIN_REGEX ? new RegExp(env.CORS_ORIGIN_REGEX) : null;

function isAllowedOrigin(origin: string): boolean {
  if (staticAllowedOrigins.has(origin)) return true;
  if (originPattern && originPattern.test(origin)) return true;
  return false;
}

app.use(
  cors({
    origin: (origin, callback) => {
      // No Origin header at all — same-origin requests, curl, server-to-server
      // health checks, etc. Nothing to check against; let it through.
      if (!origin) return callback(null, true);

      if (isAllowedOrigin(origin)) return callback(null, true);

      logger.warn('Blocked cross-origin request', { origin });
      // Passing `false` (not an Error) here makes cors() omit the
      // Access-Control-Allow-Origin header for this request rather than
      // throwing — the browser then blocks it client-side with the usual
      // CORS error, and this app doesn't 500 just because some unrelated
      // origin tried to hit it.
      callback(null, false);
    },
    credentials: true,
  })
);

// verify: captures the exact request bytes onto req.rawBody as a side
// effect of parsing — applied globally (not just on the webhook route)
// because express.json() is already mounted once, for every route, and
// splitting it into "raw here, json everywhere else" would mean the
// webhook route stops receiving a parsed req.body too. The extra Buffer
// per request is negligible; every other route simply never reads it.
app.use(
  express.json({
    verify: (req, _res, buf) => {
      (req as express.Request).rawBody = Buffer.from(buf);
    },
  })
);
app.use(cookieParser());

app.use('/api/auth', authRouter);

// Auto-deploy on push — OFF by default at the network layer (see
// docs/architecture/local-engine-auth-and-networking.md Decision 4: nginx
// doesn't route ANY public hostname to api-server unless
// ENABLE_PUSH_DEPLOY=true is set, in which case only this one path is
// exposed). Mounted here regardless of that flag — this app-level mount
// point has no way to know how nginx is configured, and doesn't need to:
// GitHub calls this, not a logged-in user, so it's public at the Express
// level the same way it always was; signature verification (see
// webhooks/github-webhook.controller.ts) is this route's auth either way.
app.use('/api/webhooks/github', githubWebhookRouter);

// Everything under /api/projects and /api/deployments etc. requires a logged-in
// user — unlike /api/auth (where /register, /login, /github are
// intentionally public), nothing here ever is. requireAuth is applied ONCE,
// at the mount point, rather than route-by-route inside projects/deployments
// routers, since there's no per-route exception to handle.
app.use('/api/projects', requireAuth, projectsRouter);
app.use('/api/deployments', requireAuth, deploymentsRouter);
app.use('/api/env-variables', requireAuth, envVariablesRouter);
app.use('/api/domains', requireAuth, customDomainsRouter); // NEW
app.use('/api/build-config', requireAuth, buildConfigRouter);
app.use('/api/github', requireAuth, githubRepoRouter);

app.get('/health', (req, res) => res.json({ status: 'ok' }));

// MUST be the LAST app.use() call — Express only treats a 4-argument
// function as an error handler, and only catches errors from middleware/
// routes registered before it.
app.use(errorHandlerMiddleware);
