# Contributing to Dreamer

Thanks for taking a look. Dreamer is a self-hosted PaaS built from scratch, so there's a
lot of surface area (build orchestration, container lifecycle, real-time log streaming,
routing), so there's plenty of room to contribute whether that's a bug fix, a new
framework detector, better docs, or test coverage.

This repo covers the the self-hosted, open-source part of the project. 
The hosted dashboard at [dreamer.samanp.xyz](dreamer.samanp.xyz) runs additional
proprietary code (billing, multi-tenant auth) that isn't in here.

## Before you start

- **Small fixes and clear bugs**: just open a PR.
- **New features or anything touching the deployment state machine, routing, or auth**: open an issue first to talk it through. Some of these have non-obvious constraints (see [Design Decisions](README.md#design-decisions) in the README), and it's better to align before you spend time on an implementation.
- **Questions**: GitHub Discussions/Issues, or email dreamer@samanp.xyz.

## Project structure

```
dreamer/
├── api-server/           # Express API + BullMQ build worker (same image, two entrypoints)
│   ├── prisma/           # Schema + migrations
│   └── src/workers/      # build.worker.ts — claims jobs, launches build-engine
├── build-engine/         # Per-build container: clone → detect → install/build → upload / docker build
├── reverse-proxy/        # Hostname router: MinIO stream (static) vs app container (dynamic)
├── frontend/             # Next.js dashboard
├── nginx/templates/      # Edge routing template for VPS deployments
├── cli/                  # dreamer-local — the local dev/self-host orchestrator
├── scripts/               # TLS cert renewal + install helpers
├── docs/                 # Architecture, auth, deployments, framework-detection docs
├── tests/                # Vitest suite — imports api-server/src directly
└── docker-compose.yml    # postgres, redis ×2, minio, api-server, build-worker, frontend, reverse-proxy, nginx
```

Figure out which of these your change actually touches before you start; most
contributions live entirely inside one directory.

## Getting set up

The supported path is the CLI, which generates real secrets for you instead of you
hand-rolling an `.env.local`:

```bash
npx dreamer-local up
```

This runs `docker-compose.local.yml`: Postgres, Redis, MinIO, the API server, the
build worker, the frontend, and the reverse proxy, all on your machine, routed through
`*.localtest.me` (a public DNS name whose records already resolve to `127.0.0.1`, so
host-based routing works immediately with no `/etc/hosts` editing).

If you'd rather run `docker compose` directly, see `.env.local.example` for what
`dreamer-local` generates and `docker-compose.local.yml`'s header comment for how it
differs from the production compose file.

### Working on a single service without Docker

Once the stack above is up for its infra (Postgres/Redis/MinIO), you can run an
individual service natively against it for a faster edit loop:

**api-server**
```bash
cd api-server
npm install
npx prisma generate
npm run dev          # tsx watch src/index.ts
npm run worker:dev    # separately, if you're touching build/deploy logic
```

**frontend**
```bash
cd frontend
npm install
npm run dev
```

**reverse-proxy**
```bash
cd reverse-proxy
npm install
npm run dev           # nodemon index.js
```

**build-engine** doesn't have a dev server, it's a container image invoked per build.
Validate changes with `docker build -t build-engine:test build-engine/`.

## Before opening a PR

Run whatever the CI workflow for the directory you touched runs, locally, first:

| Directory | Check |
|---|---|
| `api-server/` | `npm run typecheck` (`tsc --noEmit`) and `npm run build`, plus `cd tests && npm test` if you touched build/deploy logic |
| `frontend/` | `npm run lint` and `npm run build` |
| `reverse-proxy/` | `node --check index.js` and `npm test` |
| `build-engine/` | `docker build -t build-engine:test .` must succeed |

These are exactly what `.github/workflows/` runs on your PR — matching them locally
means no surprises after you push.

A few conventions the existing code follows that are worth keeping:
- TypeScript everywhere it's an option (api-server, frontend); plain Node for
  reverse-proxy and build-engine.
- Zod validation at API boundaries rather than trusting request bodies.
- Comments explain **why**, not what — especially around anything that looks like it
  could be simplified but isn't (race conditions, ordering guarantees, things that
  broke once already). If you're fixing a subtle bug, a comment explaining the failure
  mode saves the next person from reintroducing it.
- Match the file's existing patterns before introducing a new one. If you think an
  existing pattern should change platform-wide, raise it in an issue rather than doing
  it incidentally inside an unrelated PR.

## Commit / PR process

1. Fork, branch off `main`.
2. Keep PRs scoped to one thing — a mixed "fix bug + reformat file + add feature" PR is
   harder to review and more likely to get stuck.
3. Reference the issue you're addressing, if there is one.
4. Make sure the relevant CI check (table above) passes.
5. Describe what changed and why in the PR body — for anything non-obvious, the reasoning
   matters more than the diff.

## Reporting bugs

Open a GitHub issue with: what you expected, what happened instead, and how to
reproduce it (a specific repo/framework combination that fails to deploy is the most
useful report you can file, since framework detection edge cases are one of the more
common sources of bugs here). Logs from the failing deployment help a lot if you have
them.

## License

By contributing, you agree your contribution is licensed under the project's
[MIT License](LICENSE).
