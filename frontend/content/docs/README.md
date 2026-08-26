# Dreamer Local Engine Docs

Dreamer is a backend-heavy Vercel clone — GitHub import, automatic framework
detection, a real build pipeline, and two independent deployment runtimes
(static assets on MinIO, server-rendered apps as long-lived containers),
all fronted by a routing-aware reverse proxy. This is the self-hosted
version: everything below runs on your own VPS via Docker — no cloud
provider account needed anywhere in the stack.

This isn't a marketing site. It's the same documentation style you'd expect
from Vite, Next.js, or Vercel's own docs — how each piece actually works,
why it's built the way it is, and enough detail that you could rebuild it
yourself from these pages alone.

## Start here

If you're new to the codebase, read these in order:

1. **[Architecture Overview](./architecture/overview.md)** — the whole
   system in one page: every service, how they talk to each other, and the
   full lifecycle of a request from `git push` to a live URL.
2. **[Authentication](./auth/README.md)** — email/password and GitHub OAuth,
   JWT access tokens, rotating refresh tokens, session management.
3. **[Projects & the Import Wizard](./projects/README.md)** — turning a
   GitHub repo into a Project row: slugs, ownership, settings.
4. **[Framework Detection](./framework-detection/README.md)** — how a repo
   gets turned into a build config: lazy directory fetching, the preset
   table, the detection algorithm, and how a user overrides what was
   auto-detected.
5. **[Deployments](./deployments/overview.md)** — the shared pipeline both
   deployment types run through, then split into two from-scratch deep
   dives:
   - **[Static deployments](./deployments/static-deployments.md)** — MinIO
     storage, how `reverse-proxy` serves it.
   - **[Dynamic (SSR) deployments](./deployments/dynamic-deployments.md)** —
     the local Docker build/run pipeline, staged health-checked redeploys.
6. **[reverse-proxy](./reverse-proxy/README.md)** — the single ingress point
   for every deployed app, request by request.

## Other references

- **[Getting your own instance running](../../../README.md)** — the
  actual setup guide: `install.sh`, what it generates, what's manual
  (a GitHub App, mainly), and the Phase 5 verification checklist.

## The services, at a glance

| Service | What it does | Where it runs |
|---|---|---|
| `frontend` | The dashboard — Next.js | This VPS, behind nginx |
| `api-server` | REST API + Socket.IO realtime gateway. The only thing that talks to Postgres directly. | This VPS |
| `build-engine` | Clones a repo, builds it, and either uploads to MinIO (static) or `docker build`s a container image (dynamic). One container per build — launched on-demand with `docker run`, not a long-running service. | This VPS's own Docker daemon |
| `reverse-proxy` | The single hostname every deployed app is reached through — routes each request to MinIO or to an app container based on what the database says. | This VPS |
| Deployed apps | User code, either static files served from MinIO or a running container. | This VPS's own Docker daemon |

Postgres, Redis, and MinIO are shared infrastructure every service above
talks to — all just containers on this same box, brought up by the
top-level `docker-compose.yml`.
