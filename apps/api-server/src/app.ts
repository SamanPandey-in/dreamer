import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { authRouter, requireAuth } from './auth';
import { deploymentsRouter } from './deployments';
import { envVariablesRouter } from './env-variables'; // NEW
import { errorHandlerMiddleware } from './middleware/error-handler.middleware';
import { projectsRouter } from './projects';
import { env } from './lib/env';

export const app = express();

// Render sits exactly one reverse-proxy hop in front of this app. Trusting
// only that one hop (not `true`, which trusts the whole X-Forwarded-For
// chain) is what lets req.ip resolve to the real visitor — and is what
// express-rate-limit needs to key the abuse-prone auth routes correctly.
app.set('trust proxy', true); // Trust the first proxy (e.g., load balancer) for correct client IP and secure cookie handling

// CORS must allow exactly ONE known origin (never '*') AND credentials: true,
// or the browser silently refuses to send/receive the refresh cookie at all.
app.use(cors({ origin: env.FRONTEND_URL, credentials: true }));
app.use(express.json());
app.use(cookieParser());

app.use('/api/auth', authRouter);

// Everything under /api/projects and /api/deployments requires a logged-in
// user — unlike /api/auth (where /register, /login, /github are
// intentionally public), nothing here ever is. requireAuth is applied ONCE,
// at the mount point, rather than route-by-route inside projects/deployments
// routers, since there's no per-route exception to handle.
app.use('/api/projects', requireAuth, projectsRouter);
app.use('/api/deployments', requireAuth, deploymentsRouter);
app.use('/api/env-variables', requireAuth, envVariablesRouter); // ★ NEW

app.get('/health', (req, res) => res.json({ status: 'ok' }));

// MUST be the LAST app.use() call — Express only treats a 4-argument
// function as an error handler, and only catches errors from middleware/
// routes registered before it.
app.use(errorHandlerMiddleware);
