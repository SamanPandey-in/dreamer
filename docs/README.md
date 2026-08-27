# Dreamer Docs

Dreamer is a self-hosted PaaS that runs entirely on one box you
own — GitHub import, automatic framework detection, a real build pipeline,
and two independent deployment runtimes (static files on a MinIO object
store, server-rendered apps as Docker containers), all fronted by a
routing-aware reverse proxy behind nginx.

This isn't a marketing site. It's the same documentation style you'd expect
from Vite, Next.js, or Vercel's own docs — how each piece actually works,
why it's built the way it is, and enough detail that you could rebuild it
yourself from these pages alone.

## Start here

If you're new to this system, read these in order:

1. **[Architecture Overview](./architecture/overview.md)** — the whole
   system in one page: every container, how they talk to each other, and
   the full lifecycle of a request from `git push` to a live URL.
2. **[Authentication](./auth/README.md)** — the single-admin model, the
   one-time setup endpoint, JWT access tokens, rotating refresh tokens,
   session management.
3. **[Projects & the Import Wizard](./projects/README.md)** — turning a
   GitHub repo into a Project row: slugs, ownership, settings.
4. **[Framework Detection](./framework-detection/README.md)** — how a repo
   gets turned into a build config: lazy directory fetching, the preset
   table, the detection algorithm, and how you override what was
   auto-detected.
5. **[Deployments](./deployments/overview.md)** — the shared pipeline both
   deployment types run through, then split into two from-scratch deep
   dives:
   - **[Static deployments](./deployments/static-deployments.md)** — MinIO
     storage, how `reverse-proxy` serves it.
   - **[Dynamic (SSR) deployments](./deployments/dynamic-deployments.md)** —
     local image builds, health-checked container swaps.
6. **[reverse-proxy](./reverse-proxy/README.md)** — the single ingress point
   for every deployed app, request by request.

## Other references

- **[Self-Hosting Guide](./SELF-HOSTING.md)** — installing and operating
  the whole stack on your own VPS, from `install.sh` to day-2 operations.

## The nine containers, at a glance

| Service | What it does | Reachable from |
|---|---|---|
| `nginx` | TLS termination for deployed apps + custom domains | The internet, `*.yourdomain.com` only |
| `frontend` | The dashboard — Next.js | `127.0.0.1:3000` on the box only |
| `api-server` | REST API + realtime gateway; owns the Docker build/run engine | `127.0.0.1:8000` on the box only |
| `build-worker` | Dequeues build jobs, launches `build-engine` containers | Nothing external |
| `build-engine` | *Not* a long-running service — launched fresh per build, exits when done | Nothing external |
| `reverse-proxy` | Routes every deployed app's traffic to MinIO or to its app container | Nothing external (nginx proxies to it) |
| `postgres` | Every Project, Deployment, User row | Nothing external |
| `redis` | Build queue, log pub/sub, routing cache | Nothing external |
| `minio` | Object storage for static deployment output | Nothing external |

The dashboard being loopback-only — reachable via an SSH tunnel, not a
public hostname — is deliberate, not an oversight. See the
[Architecture Overview](./architecture/overview.md) for why each surface
of the system gets exactly the network exposure it needs and no more.
