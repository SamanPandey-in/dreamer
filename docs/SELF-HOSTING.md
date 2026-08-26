# Self-hosting Dreamer on your VPS/EC2 box

This covers running the entire platform — the dashboard, `api-server`,
`build-worker`, the reverse proxy, and its own Postgres/Redis/MinIO — on
a single box you control, with no external services required anywhere in
the setup: no GitHub App to register, no email provider account, nothing
to sign up for beyond owning your domain. Builds run in throwaway Docker
containers, static output lands in MinIO, server-rendered apps run as
Docker containers — all local to this machine.

## Prerequisites

- **A VPS** you have root SSH access to. Ubuntu/Debian assumed (the
  installer uses `apt`). 2 vCPU / 4 GB RAM is a reasonable floor —
  Postgres, Redis, MinIO, and the control-plane services all run
  continuously; each build and each running dynamic app adds to that on
  top.
- **A domain you control**, with access to its DNS. You'll point *only*
  `*.yourdomain.com` (the wildcard) at the box's IP — the bare apex is
  left alone, so an existing site there keeps working untouched. See
  [Wildcard Domains](./reverse-proxy/wildcard-domains.md) for why.
- **Ports 80 and 443 open** to the internet on that box. Check your
  provider's firewall/security-group rules, not just the OS firewall
  (this trips people up more often than the OS side does).
- Optional but strongly recommended: **a Cloudflare-managed zone** for
  your domain, so TLS issuance can be fully unattended (see below).
  Without it, you do one interactive step during install.

## Quick start

```bash
git clone https://github.com/SamanPandey-in/dreamer.git
cd dreamer
sudo chmod +x ./install.sh
sudo ./install.sh --domain yourdomain.com --cloudflare-token YOUR_CF_TOKEN
```

Make sure to point your given domain's DNS record A (IPv4) or AAAA (IPv6) for *.yourdomain.com at your VPS/EC2 box's IP address, else this won't work.

No Cloudflare token? Drop the flag — `install.sh` falls back to an
interactive certificate flow: it pauses partway through and shows you a
DNS TXT record to create by hand, then continues once you've added it.
Either way, when it finishes the whole stack is up and ready to deploy.
Continue to "Reaching the dashboard" below.

### Getting a Cloudflare API token

Cloudflare dashboard → **My Profile → API Tokens → Create Token** → use
the **Edit zone DNS** template, scoped to the specific zone for your
domain. That scoped token, not your Global API Key, is what
`--cloudflare-token` wants.

## What `install.sh` actually does

Worth understanding before you run it as root:

1. **Installs Docker** if it isn't already present.
2. **Generates every secret** the stack needs — Postgres password,
   MinIO root password, JWT signing keys, the token-encryption key —
   and writes `.env.deploy`, `api-server/.env`, `reverse-proxy/.env`.
   This step **refuses to overwrite** any of those three files if they
   already exist (see "Re-running the installer" below for why).
3. **Obtains a wildcard-only TLS certificate** for `*.yourdomain.com`
   via a DNS-01 challenge (the only challenge type that can prove
   ownership of a wildcard at all) — deliberately NOT including the bare
   apex, since nothing on this box serves it. With `--cloudflare-token`
   this is fully unattended; without one, certbot runs interactively and
   waits for you to create the TXT record it shows you.
4. **Builds the `build-engine` image** (`dreamer-build-engine:local`).
   This is deliberately not a long-running compose service — it's
   launched fresh per build, and exits when done.
5. **Brings up the full stack** — nine containers via
   `docker compose up -d --build`. Only nginx publishes public ports.
6. **Runs database migrations**, retrying up to 5 times in case Postgres
   is still starting.
7. **Installs a daily cron job** (`/etc/cron.d/...`) that runs
   `scripts/renew-certs.sh` — a no-op most days; renewal only actually
   happens within 30 days of expiry.
8. **Prints a summary**: the SSH tunnel command to reach the dashboard,
   plus reminders that the git token and push-to-deploy webhook are
   both optional, in-app next steps.

## Reaching the dashboard (it's not public)

The dashboard has **no public hostname at all** — deliberate, not an
oversight: the control plane is where deployments get created/deleted
and credentials live, so it's bound to loopback only. From your own
machine:

```bash
ssh -L 3000:localhost:3000 -L 8000:localhost:8000 root@your-vps-ip
```

Leave that running, then open **http://localhost:3000** in your own
browser. The first thing you'll see is the one-time setup screen — name,
email, password — which creates the single admin account. It only ever
works once: reload after and you'll get the normal login screen instead
(see [Authentication](./auth/README.md) for the whole model).

Want the dashboard reachable without an SSH tunnel every time (a
Tailscale/VPN address, or you've decided the stricter default isn't
worth it for your setup)? That's a deliberate deviation from what ships
by default — add your own nginx server block or compose port binding,
with the understanding that you're putting the control plane on the
network behind nothing but its login form.

## Set your git Personal Access Token

Optional, and only needed to deploy **private** repos — public repos
clone and deploy with no token at all.

1. GitHub → Settings → Developer settings → Personal access tokens →
   **Fine-grained tokens** (or classic, either works) → Generate new
   token.
2. Scope: **Contents: Read-only** is enough (plus **Metadata:
   Read-only**, which fine-grained tokens require automatically). If you
   also want [push-to-deploy](#optional-push-to-deploy-on-git-push) to
   auto-register its webhook for you later, add **Webhooks: Read and
   write** too — otherwise you'll add the webhook by hand, which needs
   no extra scope.
3. In the dashboard: **Settings → Git** → paste the token → Save. It's
   encrypted at rest (AES-256-GCM) the same way env vars are.

That's the whole credential model — see
[Authentication](./auth/README.md#git-access-one-personal-access-token-no-github-app)
for how it's stored and used.

## Optional: push-to-deploy on `git push`

Off by default — manual **Redeploy** from the dashboard always works
regardless. Turn this on only if you want a push to automatically
trigger a build. It's the one feature that needs a public endpoint
(GitHub's servers have to reach yours), which is why it's opt-in:

1. Generate a shared secret: `openssl rand -hex 32`.
2. Add it to `api-server/.env`:
   ```
   GITHUB_WEBHOOK_SECRET=<the value you just generated>
   ENABLE_PUSH_DEPLOY=true
   API_PUBLIC_URL=https://hooks.yourdomain.com
   ```
3. Add the matching line to `.env.deploy` (read by `docker-compose.yml`
   directly, not by the app):
   ```
   ENABLE_PUSH_DEPLOY=true
   ```
4. Restart the containers that need to pick this up:
   ```bash
   docker compose --env-file .env.deploy up -d nginx api-server build-worker
   ```
5. On GitHub → repo Settings → Webhooks → Add webhook:
   - Payload URL: `https://hooks.yourdomain.com/api/webhooks/github`
   - Content type: `application/json`
   - Secret: the same value from step 1
   - Events: just **Pushes**

`hooks.yourdomain.com` is covered by the wildcard certificate you
already have — nothing extra to issue. nginx proxies *only* that exact
path; every other route 404s at the edge before ever reaching
`api-server`, whether or not push-to-deploy is enabled.

## Verify the install

```bash
docker compose --env-file .env.deploy ps
```

All nine services should show `Up` (or `Up (healthy)` for postgres,
redis, minio). Then do the real end-to-end check — containers being up
isn't the same thing as the platform working:

- With the SSH tunnel open, visit `http://localhost:3000` — the setup
  screen (first run) or login screen should load.
- Log in, connect a repository (set the PAT first if it's private), and
  deploy it. For a static site, once `RUNNING`, check the objects landed
  in MinIO:
  ```bash
  docker compose --env-file .env.deploy exec minio \
    mc ls local/dreamer-outputs/__outputs/<your-project-slug>/
  ```
- For an SSR deploy, confirm a container came up:
  ```bash
  docker ps --filter "name=dreamer-app-"
  ```
  and that `https://<project-slug>.yourdomain.com` actually renders —
  publicly, over the internet, no tunnel needed (this is the one thing
  that's SUPPOSED to be public).

## Day-2 operations

**Logs** (any service):
```bash
docker compose --env-file .env.deploy logs -f api-server
docker compose --env-file .env.deploy logs -f build-worker
```

**Restart a service** after changing its `.env`:
```bash
docker compose --env-file .env.deploy restart api-server build-worker
```

**Update to a new version of the code**:
```bash
git pull
docker compose --env-file .env.deploy up -d --build
docker compose --env-file .env.deploy run --rm --entrypoint sh api-server \
  -c "npx prisma migrate deploy"   # only if the update includes a schema migration
```

**Rebuild the build-engine image** (if `build-engine/` itself changed):
```bash
docker build -t dreamer-build-engine:local build-engine
```

**Back up Postgres**:
```bash
docker compose --env-file .env.deploy exec postgres \
  pg_dump -U dreamer dreamer > backup-$(date +%F).sql
```

**Back up MinIO** (deployment output — regenerable by redeploying, but
faster to restore than to rebuild everything):
```bash
docker run --rm -v <this-repo>/local-engine_minio_data:/data -v "$(pwd)":/backup \
  alpine tar czf /backup/minio-backup-$(date +%F).tar.gz -C /data .
```

**Rotate a secret** (e.g. you suspect `ENCRYPTION_KEY` leaked): edit
`api-server/.env` directly, restart `api-server`/`build-worker`.
Rotating `ENCRYPTION_KEY` specifically makes the stored git token
undecryptable — you'll need to re-enter it in Settings.

## Renewal

The cron job from step 7 runs `scripts/renew-certs.sh daily at 03:00`;
renewal itself only fires within 30 days of expiry, so most days it's a
no-op. If you used the manual DNS-01 fallback (no Cloudflare token),
this can't renew unattended — re-run
`./scripts/lib/issue-certificate.sh yourdomain.com you@yourdomain.com`
by hand roughly every 60 days, creating the TXT record it asks for.

## Re-running the installer

Safe to run again — every generated `.env` file is written once and
never overwritten on a later run. This matters more than it looks:
regenerating `JWT_ACCESS_SECRET` would invalidate every active login
session, and regenerating `ENCRYPTION_KEY` would make every
already-encrypted secret in the database undecryptable. If you genuinely
want a specific file regenerated, delete that one file yourself first,
then re-run.

## Uninstalling

```bash
cd local-engine
docker compose --env-file .env.deploy down -v   # -v also removes named volumes (Postgres/Redis/MinIO data — irreversible)
rm -rf certbot/letsencrypt
rm /etc/cron.d/dreamer-local-engine-cert-renewal
```

Omit `-v` if you might come back — that flag deletes every database,
deployment output, and running app's data permanently.

## Troubleshooting

**Dashboard won't load through the tunnel** — confirm the tunnel is
actually up (`ssh -L 3000:localhost:3000 -L 8000:localhost:8000 ...`)
and that you're opening `http://localhost:3000`, not a public hostname —
there isn't one for the dashboard by design.

**TLS issuance fails / times out** — almost always DNS: the DNS-01
challenge needs your domain's nameservers to actually be Cloudflare's
(for the token path), or the TXT record correctly created *before*
pressing Enter (for the interactive path) with a minute to propagate.

**Forgot the admin password** — no email-based reset exists (nothing in
this stack sends email); reset it directly from the server:
```bash
docker compose --env-file .env.deploy exec api-server \
  npx tsx scripts/reset-admin-password.ts your-new-password
```
This also signs out every existing session for the account, same as an
in-app password change does.

**"Set a git Personal Access Token in Settings" when deploying a private
repo** — expected. Public repos need no token at all.

**A push doesn't trigger a redeploy** — check `ENABLE_PUSH_DEPLOY=true`
is set in BOTH `api-server/.env` AND `.env.deploy` (nginx reads the
latter), that you restarted `nginx`/`api-server`/`build-worker` after
setting them, then check **Webhook → Recent Deliveries** on the repo's
own settings page — a non-2xx response there tells you exactly what was
rejected (usually a secret mismatch between `GITHUB_WEBHOOK_SECRET` and
what you pasted into GitHub's form).

**A deploy is stuck in `BUILDING` forever** —
```bash
docker ps -a --filter "name=dreamer-build-"
docker logs dreamer-build-<deployment-id>
```
The build container's own logs (not `api-server`'s) show what actually
failed inside the build — a bad install/build command, a missing
`output: 'standalone'` for a dynamic Next.js app, etc.

**A dynamic app deploy failed but the previous version is still live** —
that's by design: a new container that never passes its health check is
discarded and the previous one keeps serving (see
[dynamic deployments](./deployments/dynamic-deployments.md)). Check
`docker logs dreamer-app-<slug>-staging-*` for why the new one didn't
come up (most commonly: the app doesn't bind to `0.0.0.0:3000`, or
crashes on a missing env var).

**Ran out of disk space** — old build containers and unused images
accumulate. Clean up with:
```bash
docker system prune -f
docker image prune -af
```
