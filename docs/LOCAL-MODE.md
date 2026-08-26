# Running Dreamer Local Engine on your own machine (macOS / Windows / Linux)

This is a different use case from [self-hosting on a VPS](./SELF-HOSTING.md).
That guide covers putting the platform on a public box with a real domain,
so it stays online and anyone can deploy to `*.yourdomain.com`. Use it
when you actually want a live, always-on instance.

This page is for trying Dreamer out, developing against it, or demoing it
— entirely on your own laptop, no domain, no TLS, no VPS bill.

## Prerequisites

- Docker Desktop (macOS/Windows) or Docker Engine + the Compose plugin
  (Linux) — https://docs.docker.com/get-docker/
- Node.js 18+ (only to run the CLI itself — everything Dreamer runs stays
  inside containers)

## Quick start

From the root directory:

```bash
node cli/bin/dreamer-local.js up
```

This will:
1. Check Docker is installed and running, with OS-specific instructions
   if not.
2. Generate `.env.local`, `api-server/.env`, and `reverse-proxy/.env`
   with random secrets — idempotent, it never overwrites files that
   already exist.
3. Build the `build-engine` image.
4. Bring up the stack with `docker-compose.local.yml`.
5. Run database migrations, retrying while Postgres finishes starting.
6. Print the dashboard URL and the domain your deployed apps will live
   under.

Open **http://localhost:3000** — the first load is the one-time admin
setup screen.

## Why no domain setup is needed

Deployed apps still need host-based routing (`myapp.<domain>`), the same
way they do in production. Local mode defaults `DOMAIN` to
`localtest.me` — a domain whose own DNS records already resolve
`localtest.me` and every subdomain to `127.0.0.1`. So
`http://myapp.localtest.me:8080` reaches your own machine with nothing
to configure. Override `--domain` on `up` if you'd rather point at a
domain you actually control.

## What's different from the VPS install

| | VPS (`install.sh`) | Local (`dreamer-local`) |
|---|---|---|
| Compose file | `docker-compose.yml` | `docker-compose.local.yml` |
| Public edge | nginx, ports 80/443, real TLS | `reverse-proxy` on a plain host port (default 8080) |
| Domain | one you control, wildcard DNS | `localtest.me` (or any domain, no DNS needed) |
| Cert renewal | daily cron + certbot | none — no TLS in local mode |
| Access | SSH tunnel to loopback ports | already on localhost |

`install.sh` and `docker-compose.yml` are untouched — this is a parallel
path, not a replacement.

## Other commands

```bash
node cli/bin/dreamer-local.js logs [service]   # tail logs
node cli/bin/dreamer-local.js ps               # container status
node cli/bin/dreamer-local.js down             # stop the stack
node cli/bin/dreamer-local.js down --volumes   # stop and wipe all data
node cli/bin/dreamer-local.js doctor           # just check Docker
```
