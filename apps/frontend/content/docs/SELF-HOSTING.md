# Self-hosting Dreamer on a VPS/EC2 box

This covers running the Dreamer **platform itself** — the dashboard,
`api-server`, `reverse-proxy`, and its own Postgres/Redis — on a single
box you control, with no managed cloud database or cache required. It's
a separate concern from [deploying user apps](./AWS-Console-Setup-Guide.md),
which still goes out to AWS (ECS + Lambda) regardless of where this
control plane runs — you can self-host the dashboard here and still have
it deploy user projects to AWS, that's the normal, expected setup.

## Prerequisites

- A VPS or EC2 instance running Ubuntu or Debian, with a public IP.
- Root (or `sudo`) access.
- Ports **80** and **443** open and not already in use by another web
  server (if something else is already bound to port 80, stop it first —
  the installer doesn't try to detect or work around this for you).
- A domain you control the DNS for. Any registrar/DNS provider works for
  the manual fallback; **Cloudflare specifically** gets you a fully
  unattended install (see below).

## Quick start

```bash
git clone <your-fork-of-dreamer>
cd dreamer
sudo ./scripts/install.sh --domain yourdomain.com --cloudflare-token YOUR_CF_TOKEN
```

That's the whole thing. One command, and by the end of it you'll have:
Docker installed, every secret this stack needs generated, a real
wildcard TLS certificate issued, and Postgres/Redis/api-server/frontend/
reverse-proxy/nginx all running as containers on this box.

**No Cloudflare?** Drop `--cloudflare-token` and the script falls back to
an interactive manual DNS-01 flow — it'll pause partway through and show
you a TXT record to create with whatever DNS provider you use, then
continue once you've added it. Works with any provider; the tradeoff is
it can't auto-renew unattended the way the Cloudflare path can (see
**Renewal** below).

### Getting a Cloudflare API token

Cloudflare dashboard → **My Profile → API Tokens → Create Token** → use
the **Edit zone DNS** template, scoped to the specific zone for your
domain. That scoped token, not your Global API Key, is what
`--cloudflare-token` wants.

## What the script actually does, in order

1. Installs Docker Engine + the Compose plugin, if not already present.
2. Generates `.env.deploy` (compose-level config) and per-service `.env`
   files (`apps/api-server/.env`, `apps/reverse-proxy/.env`) — random
   secrets for JWT signing and token encryption, Postgres/Redis wired to
   the internal container network, and clearly-marked `TODO` placeholders
   for the two things it genuinely can't generate for you (see below).
3. Issues one TLS certificate covering **both** `yourdomain.com` and
   `*.yourdomain.com` — a plain wildcard cert alone doesn't cover the bare
   apex, and the dashboard lives at the apex, so both have to be in the
   same certificate, via a DNS-01 challenge (the only challenge type that
   can prove ownership of a wildcard at all).
4. Builds and starts everything with
   `docker compose -f docker-compose.prod.yml up -d --build`.
5. Runs database migrations.
6. Installs a daily cron job for certificate renewal.
7. Prints exactly what's left for you to do (steps below).

## Finish the setup

The script prints these at the end too — repeated here for reference.

**1. DNS.** Point both of these at your box's public IP (the script
detects and prints it):
```
A     yourdomain.com      -> <your box's IP>
A     *.yourdomain.com    -> <your box's IP>
```

**If you're on Cloudflare, both records need to be "DNS only" (grey
cloud), not proxied (orange cloud).** This isn't optional — Cloudflare's
proxy terminates TLS at *their* edge using *their* certificate, which
means it never forwards the raw handshake through to the certificate this
script just issued for you on your own box. If you've read the
[JioFiber IPv6 post](/blog/jiofibre-ipv6) on this same portfolio, this is
the exact same failure mode as Problem 1 in that post, just showing up in
a different project — a proxied record silently redirects traffic
somewhere other than your own server before TLS is even negotiated.

**2. A GitHub OAuth App.** The installer can't create this for you — go
to https://github.com/settings/developers → **New OAuth App**:
- Homepage URL: `https://yourdomain.com`
- Authorization callback URL: `https://api.yourdomain.com/api/auth/github/callback`

Paste the generated Client ID/Secret into `apps/api-server/.env`
(`GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`) — everything else in that
file the installer already generated correctly; don't touch the
JWT/ENCRYPTION_KEY lines.

**3. Restart api-server** to pick up what you just pasted in:
```bash
docker compose -f docker-compose.prod.yml --env-file .env.deploy restart api-server
```

Until you do this, `api-server` will be crash-looping — that's expected,
not a bug. `env.ts` deliberately fails fast on a missing required
variable at boot rather than letting the app start in a half-configured
state (check with `docker compose -f docker-compose.prod.yml logs
api-server` if you want to see it happen).

**4. Visit `https://yourdomain.com`.** Once DNS has propagated (can take
a few minutes, sometimes longer depending on your registrar/previous TTL
values), that's your dashboard.

**5. (Only if you plan to deploy user apps.)** Fill in the `AWS_*` /
`ECS_*` / `ECR_*` / `LAMBDA_*` section of `apps/api-server/.env` — see
[docs/AWS-Console-Setup-Guide.md](./AWS-Console-Setup-Guide.md). This is
entirely unrelated to where the platform itself runs; user app builds and
deployments go through AWS regardless.

## Renewal

`scripts/install.sh` installs `/etc/cron.d/dreamer-cert-renewal`, running
`scripts/renew-certs.sh` daily at 03:00. `certbot renew` itself only
actually renews within 30 days of expiry, so most days this is a no-op —
harmless to run daily.

If you used the manual DNS-01 fallback (no `--cloudflare-token`), this
cron job can't renew unattended — it needs a fresh interactive TXT record
each time, the same as the initial issuance did. Either switch to a
supported DNS provider's API-based challenge, or re-run
`./scripts/lib/issue-certificate.sh yourdomain.com you@yourdomain.com`
by hand roughly every 60 days.

## Re-running the installer

Safe to run again — every generated `.env` file is written once and never
overwritten on a later run (regenerating `ENCRYPTION_KEY` would make
every already-encrypted GitHub token in your database undecryptable, and
regenerating `JWT_ACCESS_SECRET` would invalidate every active login
session). If you genuinely want a specific file regenerated, delete that
one file yourself first, then re-run.

## Uninstalling

```bash
./scripts/uninstall.sh          # stops containers, keeps your data/secrets/certificate
./scripts/uninstall.sh --purge  # also deletes Postgres/Redis volumes, .env files, and the TLS certificate — irreversible
```

## Troubleshooting

**Cert issuance hangs or fails with a Cloudflare token provided** — double
check the token's scope is **Zone → DNS → Edit** on the specific zone for
your domain, not a token scoped to a different zone or a read-only scope.

**`docker compose ... up` fails immediately on nginx** — nginx's config
references certificate files that don't exist yet; this means step 3
(cert issuance) didn't actually complete before step 4 ran. Check
`certbot/letsencrypt/live/yourdomain.com/fullchain.pem` exists; if not,
re-run `./scripts/lib/issue-certificate.sh yourdomain.com you@yourdomain.com [cf-token]` by hand and look at its output directly.

**Dashboard loads but shows an API/connection error** — almost always
either DNS for `api.yourdomain.com` hasn't propagated yet, or `api-server`
is still crash-looping on the GitHub OAuth placeholders (step 2 above).
`docker compose -f docker-compose.prod.yml logs api-server` tells you
which.

**Build logs / realtime updates don't show up on the deployment detail
page, but the rest of the dashboard works fine** — `curl -I
https://api.yourdomain.com/socket.io/` should come back with something
other than a plain 404 HTML page. api-server serves REST and Socket.IO
from the same port (8000) now, so there's no second port to mis-route to
— if this still 404s, check `NEXT_PUBLIC_SOCKET_URL` on the frontend
actually points at `api.yourdomain.com` and not a stale `:9002` value
left over from an old `.env`.
