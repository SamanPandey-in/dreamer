# local-engine: auth, git access, and network exposure

Status: implemented (backend core) — see "What's actually done" at the bottom.
Scope: `local-engine/` only. `apps/` (the cloud engine) is untouched and stays
closed-source/private — nothing here changes its auth model.

## The question

The cloud engine was built as a real multi-tenant SaaS: email+password with
mandatory email verification, GitHub OAuth login, a GitHub App with its own
installation flow for repo access, per-account session management, a public
marketing landing page. All of that is correct for a product with strangers
signing up.

local-engine has exactly one operator, running on hardware they own. The
question was whether that entire apparatus is still justified, or whether
it's solving a problem that doesn't exist in this deployment shape — and if
not, what a self-hosted-first design should look like instead, including
where the dashboard and the deployed apps should each live on the network.

## What self-hosted PaaS peers actually do

Checked against Coolify, CapRover, and Dokploy (the direct OSS comparables —
"turn a VPS into a Heroku-style deploy target"), current as of 2026:

- **Auth**: none of them do open self-registration or SaaS-style OAuth
  login. Coolify and CapRover both provision a single admin account on
  first install (CapRover via a CLI-set default password you're forced to
  change on first login; Coolify via a first-run setup screen). There is
  no concept of "sign up" — you either are the admin or you don't have an
  account.
- **Git access**: Coolify explicitly supports connecting a git provider via
  either an OAuth App *or* a plain personal access token — PAT is a
  first-class, fully supported path, not a workaround. CapRover mostly
  works off a manually-configured deploy webhook + token. Nobody in this
  space requires a full GitHub App (App registration, private key,
  installation flow, per-installation token minting) for a single-operator
  install.
- **Network**: the more common default is actually to expose the dashboard
  publicly on its own port/subdomain, gated by the admin login (Coolify:
  `http://server-ip:8000`). Binding it to loopback-only and reaching it over
  SSH tunnel/VPN is *stricter* than the ecosystem default, not the norm —
  worth naming explicitly since it's a real trade-off (no browser access
  without a tunnel), not a "correct" configuration that everyone else is
  missing.

This lines up with the plan below on auth and git access. On network
exposure, the plan below follows the user's explicit stricter preference
rather than the more common "public + login" default — noted as a
deliberate deviation, not a correction.

## Decision 1 — Auth: single admin, not multi-tenant

**Verdict: mostly right, with one correction.** Dropping registration,
GitHub OAuth login, and mandatory email verification is correct — none of
that serves a single trusted operator, and mandatory email verification
specifically requires a transactional email provider (Resend) to be
configured just to finish installing the app, which is a real setup-cost
tax for zero benefit here.

**Where "no auth at all" goes wrong**: the dashboard and API being
loopback-only *today* is a network-layer control, not an auth-layer one.
It's the right primary control, but it's also the kind of thing that gets
silently undone later — a firewall rule change, a `docker-compose.override.yml`
that publishes a port to `0.0.0.0` instead of `127.0.0.1`, a home-server NAT
rule added for some other reason. If that ever happens with zero auth
behind it, anyone who finds the port can create deployments, read
decrypted env vars, and read the stored git PAT. A password check costs a
few hundred bytes of session middleware that's already built and working
in this codebase — there's no real reason to remove it, only to remove
what made it *heavy* (email verification, OAuth, self-registration).

**What changed**:
- Self-registration (`POST /api/auth/register`) is gone. In its place,
  `POST /api/auth/setup` creates the one admin account — and only works
  while zero users exist in the database; it 409s permanently the instant
  an admin has been created. This is the standard Coolify/CapRover
  first-run pattern. The frontend's setup wizard calls this once.
- Email verification is gone entirely — `emailVerified` is no longer
  gated on anywhere. There's one operator; there's nothing to verify
  against.
- GitHub OAuth login/signup/account-linking is gone (`/api/auth/github`,
  `/api/auth/github/connect`, `auth/github.service.ts`).
- Forgot/reset-password by email is gone (it depended on the email
  provider being configured, which nothing else needs anymore). Password
  reset for a forgotten single-admin password is a documented direct DB
  step (`scripts/reset-admin-password.ts`) instead of an email flow — see
  that script's own comment for why a CLI/DB reset is actually a *better*
  fit than email here: it requires host access, which is the same trust
  boundary as everything else on a single-operator box.
- Session mechanics (JWT access + rotating refresh session, `/me`,
  `/sessions`, `/logout-all`, `/change-password`) are kept as-is — this
  part was never SaaS-specific, it's just "a login system," and rebuilding
  it worse would be pure churn.
- `RESEND_API_KEY`/`EMAIL_FROM` are no longer required env vars. Nothing
  in local-engine sends email anymore.

## Decision 2 — Git access: PAT instead of a GitHub App

**Verdict: correct.** A GitHub App exists to solve "many different users'
repos need scoped, revocable, per-installation access, and the App's
identity should be distinct from any one user's." That problem doesn't
exist when there's one operator authenticating against their own repos —
a PAT is the same mechanism every `git clone https://TOKEN@github.com/...`
workflow has used for over a decade, and it's what Coolify itself supports
as a first-class option.

**What changed**:
- `GithubInstallation` model, `lib/github-app.ts` (App JWT signing,
  installation token minting/caching), `integrations/github-app-install.*`
  (the install/callback flow) are all removed.
- `User.githubToken` (previously: OAuth login token, explicitly *not* used
  for repo access) is repurposed as `User.personalAccessToken` — same
  column, same AES-256-GCM-encrypted-at-rest pattern
  (`lib/crypto.ts#encryptForStorage`/`decryptFromStorage`), now the one
  and only credential used for both listing repos and cloning private ones.
  Set from Settings once; nothing per-project to manage.
- `Project.installationId`/`Project.installation` are gone.
  `Project.repositoryId` (GitHub's stable numeric repo ID) stays — it's
  still the webhook lookup key, just no longer paired with an
  installation.
- `build.worker.ts` no longer mints anything short-lived before a build —
  it decrypts the admin's stored PAT straight from `User.personalAccessToken`
  and hands it to `launchBuildTask` exactly like before. One less moving
  part (no token cache, no "installation was suspended between enqueue and
  dequeue" edge case — a PAT doesn't get suspended out from under a running
  job the way an App installation could).
- `integrations/github-repo.*` (the new-project wizard's repo picker) now
  lists repos via GitHub's plain `GET /user/repos` using the stored PAT,
  instead of walking an installation's repo list. Public-repo search is
  unchanged (it was already installation-independent, per its own
  original comment).

**Deferred, not done in this pass** — see the checklist at the bottom.

## Decision 3 — Webhooks / auto-deploy-on-push

Kept, simplified. The HMAC signature verification
(`webhooks/github-webhook.service.ts#verifyGithubSignature`) was already
correct and has nothing to do with GitHub Apps specifically — GitHub signs
any webhook delivery with whatever secret is configured, App-backed or not.
What's App-specific and now removed: the `installation` and
`installation_repositories` event types (App lifecycle events; a plain repo
webhook never sends these), and the "one App-wide secret automatically
covers every installation" framing — replaced by one operator-chosen
secret (`GITHUB_WEBHOOK_SECRET`) that gets pasted into each repo's webhook
settings by hand, same as any classic GitHub webhook setup. `push` event
handling, the branch-matching/skip-reason logic, and `WebhookDelivery`
logging are untouched.

Auto-deploy-on-push is **optional**, off by default at the network layer
(see Decision 4) — it needs a public endpoint, and not everyone running
this wants that. Manual "Redeploy" from the dashboard always works
regardless.

## Decision 4 — Network exposure

This is the part with real security weight, and the user's instinct here
was specific and correct: **the dashboard is not the same trust surface as
a deployed app, and shouldn't be reachable the same way.**

Three logical destinations, three different postures:

| Destination | Reachability | Why |
|---|---|---|
| Dashboard (frontend + api-server's REST/dashboard API) | **loopback only** on the VPS (`127.0.0.1:3000`, `127.0.0.1:8000`) | This is where deployments get created/deleted, env vars and the git PAT get read/written, and every other project lives. No public hostname routes here at all — not even behind auth. Reached via `ssh -L 3000:localhost:3000 -L 8000:localhost:8000 user@your-vps`, or a VPN/Tailscale if the operator has one. |
| Deployed apps + custom domains | **public**, via `*.${BASE_DOMAIN}` and any verified `CustomDomain` | This is the actual product surface — it's supposed to be reachable by anyone on the internet, same as any deployed website. Unchanged from the existing reverse-proxy design (wildcard subdomain + custom domain routing, scale-to-zero, etc.) |
| GitHub webhook receiver (`/api/webhooks/github`) | **public, but only that one path** — opt-in via `ENABLE_PUSH_DEPLOY=true` | The only reason api-server would ever need a public hostname at all: GitHub's servers need to reach it to deliver push events. Everything else on api-server (auth, projects, env vars, the PAT) stays unreachable through this path — nginx proxies *only* `/api/webhooks/github` to `api-server:8000`; every other path 404s at the edge before it ever reaches the app. Off by default — a fresh install has no public api-server surface at all until this is explicitly turned on. |

**Why the dashboard doesn't just live behind auth on a public subdomain**
(the more common Coolify-style default): it would work and would still be
reasonably safe — but the user's stated threat model was specifically
"don't expose the control plane to the internet at all," which loopback+
tunnel satisfies more completely than auth-behind-a-public-port does. This
doc names that as a deliberate, stricter-than-default choice so it's an
informed one, not an accidental gap.

### The samanp.xyz example, concretely

The operator's portfolio already lives at `samanp.xyz` on Vercel. They want
to deploy a project called `hello` on their own local-engine VPS, reachable
at `hello.samanp.xyz`, **without disturbing the existing Vercel site.**

This works because DNS delegation is per-record, not per-domain:

```
samanp.xyz        A/CNAME  -> (unchanged — stays pointed at Vercel)
*.samanp.xyz       A       -> <VPS IP>   (new — wildcard only)
```

`BASE_DOMAIN=samanp.xyz` on local-engine. The wildcard cert
(`scripts/lib/issue-certificate.sh`, DNS-01 via Cloudflare or manual TXT)
now requests **only** `*.samanp.xyz` — not the apex — since nothing on
this box serves the apex anymore (the old design served the dashboard
there; that's gone per Decision 4). Requesting the apex in the cert would
be pointless and would need the operator to prove control of a domain
whose apex they've deliberately left pointed elsewhere.

`nginx`'s only public `server_name` blocks become `*.${BASE_DOMAIN}` (→
reverse-proxy) and, only if `ENABLE_PUSH_DEPLOY=true`, a `hooks.${BASE_DOMAIN}`
block whose sole location is `/api/webhooks/github`. Nothing answers for
bare `${BASE_DOMAIN}` or `api.${BASE_DOMAIN}` anymore.

Result: `hello.samanp.xyz` deploys and resolves through local-engine,
`samanp.xyz` keeps serving the Vercel portfolio untouched, and the
local-engine dashboard itself has no public hostname at all.
