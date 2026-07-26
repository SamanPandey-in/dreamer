# Dreamer Docs

Dreamer is a backend-heavy Vercel clone — GitHub import, automatic framework
detection, a real build pipeline, and two independent deployment runtimes
(static assets on S3, server-rendered apps on Lambda), all fronted by a
routing-aware reverse proxy.

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
   - **[Static deployments](./deployments/static-deployments.md)** — S3
     storage, how `reverse-proxy` serves it.
   - **[Dynamic (SSR) deployments](./deployments/dynamic-deployments.md)** —
     Kaniko, ECR, Lambda, Function URLs.
6. **[reverse-proxy](./reverse-proxy/README.md)** — the single ingress point
   for every deployed app, request by request.

## Other references

- **[Self-Hosting Guide](./SELF-HOSTING.md)** — running the Dreamer
  platform itself on a VPS/EC2 box.
- **[AWS Console Setup Guide](./AWS-Console-Setup-Guide.md)** — provisioning
  the AWS side (ECR, Lambda IAM) that dynamic deployments need.
- **[How I Built SSR Engine](./Implementation_docs/DEPLOYMENTS/HOW_I_BUILT_SSR_ENGINE.md)** — the build log for the
  Lambda-based SSR runtime specifically, written step-by-step as it was
  built, including the real debugging trail.

## The five services, at a glance

| Service | What it does | Where it runs |
|---|---|---|
| `frontend` | The dashboard — Next.js | Wherever you host the platform (VPS, or any Node host) |
| `api-server` | REST API + Socket.IO realtime gateway. The only thing that talks to Postgres directly. | Same |
| `build-engine` | Clones a repo, builds it, and either uploads to S3 (static) or builds+pushes a container image (dynamic). One ECS Fargate task per build — not a long-running service. | AWS ECS Fargate, launched on-demand |
| `reverse-proxy` | The single hostname every deployed app is reached through — routes each request to S3 or to a Lambda Function URL based on what the database says. | Wherever you host the platform |
| Deployed apps | User code, either static files or a Lambda function. | AWS S3 / AWS Lambda |

Postgres and Redis are shared infrastructure every service above talks to —
either a managed provider or, if you're self-hosting, containers on the same
box as everything else (see the Self-Hosting Guide).
