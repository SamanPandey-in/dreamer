import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { authRouter, requireAuth } from './auth';
import { buildConfigRouter } from './build-config';
import { deploymentsRouter } from './deployments';
import { envVariablesRouter } from './env-variables';
import { customDomainsRouter } from './domains';
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
       * to verify GitHub's X-Hub-Signature-256 — an HMAC over the raw bytes
       * GitHub sent, which re-serialized `JSON.stringify(req.body)` isn't
       * guaranteed to reproduce byte-for-byte.
       */
      rawBody?: Buffer;
    }
  }
}

export const app = express();

// Exactly one trusted reverse-proxy hop (nginx). Trusting only that hop —
// not `true`, which trusts the whole X-Forwarded-For chain — is what lets
// req.ip resolve to the real visitor and express-rate-limit key the
// abuse-prone auth routes correctly.
app.set('trust proxy', 1);

// MUST be first — every downstream middleware/route/error-handler logs
// inside this request's correlation-ID context (see lib/logger.ts).
app.use(requestContextMiddleware);

// Baseline security headers (HSTS, X-Content-Type-Options, X-Frame-Options,
// Referrer-Policy, etc). CSP is off — this app only ever returns JSON, never
// HTML, so a content-security-policy header here restricts nothing and just
// adds noise; the frontend app is the one that should carry a CSP.
app.use(helmet({ contentSecurityPolicy: false }));

// CORS must allow exactly ONE known origin per request (never '*') AND
// credentials: true, or the browser silently refuses to send/receive the
// refresh cookie at all. FRONTEND_URL plus localhost:3000 (Next.js dev
// server) are always allowed; CORS_EXTRA_ORIGINS/CORS_ORIGIN_REGEX cover
// origins that can't be enumerated statically — e.g. preview deployments,
// which get a brand-new subdomain on every single deploy.
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
      // Passing `false` (not an Error) makes cors() omit the
      // Access-Control-Allow-Origin header rather than throw — the browser
      // blocks it client-side, and this app doesn't 500 just because some
      // unrelated origin probed it.
      callback(null, false);
    },
    credentials: true,
  })
);

// Captures request bytes onto req.rawBody as a side effect of parsing,
// applied globally because express.json() is mounted once for every route —
// splitting it into "raw here, json everywhere else" would cost the webhook
// route its parsed req.body too. The extra Buffer per request is negligible;
// other routes simply never read it.
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
// routes no public hostname to api-server unless ENABLE_PUSH_DEPLOY=true).
// Mounted here regardless of that flag: GitHub calls this, not a logged-in
// user, so signature verification (webhooks/github-webhook.controller.ts)
// is this route's auth either way.
app.use('/api/webhooks/github', githubWebhookRouter);

// Everything under /api/projects, /api/deployments, etc. requires a logged-in
// user — unlike /api/auth (where /register, /login, /github are intentionally
// public), nothing here ever is. requireAuth is applied ONCE at each mount
// point rather than route-by-route, since there are no per-route exceptions.
app.use('/api/projects', requireAuth, projectsRouter);
app.use('/api/deployments', requireAuth, deploymentsRouter);
app.use('/api/env-variables', requireAuth, envVariablesRouter);
app.use('/api/domains', requireAuth, customDomainsRouter);
app.use('/api/build-config', requireAuth, buildConfigRouter);
app.use('/api/github', requireAuth, githubRepoRouter);

app.get('/health', (req, res) => res.json({ status: 'ok' }));

// MUST be the LAST app.use() call — Express only treats a 4-argument
// function as an error handler, and only feeds it errors from middleware/
// routes registered before it.
app.use(errorHandlerMiddleware);
