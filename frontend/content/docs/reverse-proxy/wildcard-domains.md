# Wildcard Domains: Two Different Problems Wearing the Same Syntax

`*.yourdomain.com` and `*.sub.yourdomain.com` look like the same idea at
different depths. For TLS purposes, they're not the same problem at all —
one of them gets a free, automatic certificate from almost any host or
CDN; the other one doesn't, ever, from anyone, and needs you to obtain
that certificate yourself. This page covers both, using a real production
setup as the worked example, and closes with the one question that
actually matters if you're self-hosting: what changes when there's no
PaaS doing any of this for you.

## Category 1: `*.yourdomain.com` — one level

This is what Dreamer's own routing logic assumes throughout — see
[`reverse-proxy/README.md`](./README.md): every deployed app lives at
`{project.slug}.{BASE_DOMAIN}`, exactly one label under whatever
`BASE_DOMAIN` is set to.

**Why this is the easy case:** a certificate authority issuing
`*.yourdomain.com` only has to prove you control `yourdomain.com`
itself — one DNS TXT record, one proof of ownership, and the resulting
certificate covers every possible single-label subdomain for free.
Cloudflare's free **Universal SSL**, and most PaaS "custom domain"
features (Render, Railway, Fly.io, and others), issue and auto-renew
this tier of certificate for you, with no certbot, no cron job, no
manual renewal, ever.

If deploying `reverse-proxy` on render, refer [Render's official doc](https://render.com/docs/custom-domains#advanced-dns-configuration) first

## Category 2: `*.sub.yourdomain.com` — two (or more) levels

This is a genuinely different, harder problem — and it's the exact same
root cause as **Problem 1** discussed in my blog
[JioFiber IPv6 post](https://www.samanp.xyz/blog/jiofibre-ipv6), just showing
up again in a different deployment.

**Why the free tier stops here:** proving you control `yourdomain.com`
says nothing about whether you specifically intended to hand out
certificates for an entire second-level namespace underneath it. Almost
no free/automatic product will auto-issue this depth of wildcard for
you — Cloudflare's Universal SSL explicitly does not, and in practice
neither do most PaaS custom-domain integrations (see the worked example
below, where a two-level wildcard genuinely needed a separate, self-
managed certificate).

This doesn't mean it's impossible — Let's Encrypt (and the ACME DNS-01
challenge specifically) can issue a certificate for `*.local.yourdomain.com`
just as validly as for `*.yourdomain.com`. It means **nobody hands it to
you automatically** — you have to run the DNS-01 challenge yourself,
the same way `scripts/lib/issue-certificate.sh` already does for this
project's own self-hosting path (see below).

## Does Dreamer's own code need to understand two-level wildcards?

No — and this is worth knowing before you reach for a code change.
`reverse-proxy`'s routing (`hostname.split('.')[0]`) and every doc in
this project assume deployed apps live one label under `BASE_DOMAIN`.
If you want deployed apps to live under a namespace like
`*.apps.yourdomain.com` instead of directly under `*.yourdomain.com`,
the simplest fix isn't touching the routing code at all — it's setting
`BASE_DOMAIN=apps.yourdomain.com`. From Dreamer's own perspective that
IS a one-level wildcard (`*.apps.yourdomain.com`); the fact that it's
*also* two levels below the real apex is a DNS/certificate detail that
lives entirely outside the application. You still need a certificate
that specifically covers `*.apps.yourdomain.com` (Category 2's problem,
not Category 1's), but zero lines of `reverse-proxy` change.

## Worked example: this project's own production setup

The references below are from an actual deployment: `reverse-proxy`
hosted on **Render**, with Cloudflare as the DNS provider — the same
Cloudflare account referenced throughout the JioFiber post, now doing a
second, unrelated job.

### The Category 1 case, fully automated by Render

Render's dashboard → the service → **Custom Domains** → **Add Custom
Domain** → enter `*.singularitydev.xyz`. Render responds with a
**"Custom Domain DNS Records"** panel listing three CNAME records to
create:

| # | Hostname | Target | Purpose |
|---|---|---|---|
| 1 | `*` | `dreamer-reverse-proxy.onrender...` | The actual traffic record — every subdomain request routes here |
| 2 | `_acme-challenge` | `dreamer-reverse-proxy.verify...` | **ACME DNS-01 delegation** — see below |
| 3 | `_cf-custom-hostname` | `dreamer-reverse-proxy.hostname...` | **Cloudflare for SaaS delegation** — see below |

All three get added in Cloudflare's DNS tab, set to **DNS only** (grey
cloud) — for the exact same reason established in the JioFiber post:
a proxied CNAME here would route the ACME challenge and the actual
traffic through Cloudflare's edge instead of letting Render's
infrastructure see and respond to them directly.

**Record #2 is the interesting one, and it's a genuinely reusable technique beyond just Render.** Normally, obtaining a Let's Encrypt certificate via DNS-01 means *you* 
create a TXT record at `_acme-challenge.yourdomain.com` with a specific, 
single-use value the CA gives you, every time a certificate is issued or renewed. 
Pointing `_acme-challenge` at a CNAME under Render's own domain instead means
Render's ACME client can publish and rotate that challenge value on
**their** infrastructure, indefinitely, without ever needing your
Cloudflare API token or any further manual action from you — this is
how a certificate for **your** domain gets fully automated renewal by a
**third party**, without handing that third party your DNS credentials.
Any host offering a "custom domain" feature with automatic HTTPS is
almost certainly using this same delegation pattern under the hood.

**Record #3** is specific to Render's own architecture — Render's
custom-domain product is itself built on **Cloudflare for SaaS**
("Cloudflare for Platforms"), which is a different Cloudflare product
from the plain DNS/CDN most people use it for: it lets Render provision
and terminate TLS for *your* custom hostname at Cloudflare's edge on
its own customers' behalf. This CNAME is what proves to Cloudflare that
Render is authorized to do that for this specific hostname.

Once both records propagate, Render's panel shows **"We've verified `*.singularitydev.xyz`"**  and **"We've issued a certificate for `*.singularitydev.xyz`"** — no certbot, no renewal cron, nothing to maintain going forward. This is Category 1's whole appeal: pay the setup cost once, in DNS records, get indefinite automatic renewal.

### The Category 2 case, NOT automated by Render

The same DNS zone also has a completely separate record:
```
*.local.singularitydev.xyz   CNAME   local.singularitydev.xyz
```
This is the two-level wildcard from the JioFiber post — a home-lab box
on JioFiber, reached over native IPv6, with its **own** nginx doing its
**own** TLS termination using a certificate obtained by running certbot
directly (DNS-01 against Cloudflare, requesting `local.singularitydev.xyz`
+ `*.local.singularitydev.xyz` together — the same "apex and wildcard
have to be requested together in one certificate" requirement covered in
the top-level [`install.sh`](../../../install.sh)).
Render's automatic Category 1 flow never touches this at all — this
namespace was never registered as a Render custom domain in the first
place, specifically because Render's own automation (like most PaaS
custom-domain products) stops at one level of wildcard.

This is the pattern worth internalizing: **Category 1 subdomains can be handed off to whatever's hosting `reverse-proxy` and forgotten about. Category 2 subdomains are yours to manage, on whatever box is actually terminating TLS for them, indefinitely** — there's no PaaS feature to reach for.

## Self-hosting on a VPS: there's no Render here — what changes

This is the real question if you're following
the local engine's own `install.sh` instead of using a PaaS: there's
no "Custom Domains" panel, no `_acme-challenge` delegation to a third
party, no Cloudflare for SaaS. On a VPS, **you are the origin** — the box
`scripts/install.sh` sets up is simultaneously what Render was AND what
the JioFiber home-lab box was, for every domain it serves.

Concretely, this means the self-hosting installer's certificate step (`scripts/lib/issue-certificate.sh`) is **already doing the Category 2 flow, even for what looks like a Category 1 domain**:

```bash
docker run --rm \
  -v "${CERT_DIR}:/etc/letsencrypt" \
  -v "${cf_ini}:/etc/letsencrypt/cloudflare.ini:ro" \
  certbot/dns-cloudflare:latest \
  certonly --dns-cloudflare \
  --dns-cloudflare-credentials /etc/letsencrypt/cloudflare.ini \
  -d "${DOMAIN}" \
  -d "*.${DOMAIN}" \
  --email "${EMAIL}" --agree-tos --non-interactive
```

There's no Render-style automation to lean on here — the installer runs
DNS-01 itself, using a Cloudflare API token you provide, exactly the
same mechanism as the JioFiber post's home-lab setup, exactly the same
mechanism Render was running *for* you behind its own CNAME delegation.
Self-hosting doesn't remove this step; it just means **you're the one holding the API token and running the renewal cron job** (`scripts/renew-certs.sh`) instead of a PaaS holding it on your behalf.

### Extending self-hosting to a two-level wildcard namespace

If you want deployed apps under a Category 2 namespace on a self-hosted
box (e.g. `*.apps.yourdomain.com`, with the dashboard staying at the
bare `yourdomain.com`), remember the earlier point: **set
`BASE_DOMAIN`/`DOMAIN` to `apps.yourdomain.com` directly** rather than
trying to make the tooling understand two levels at once. Concretely,
that means:

1. Requesting the certificate for `apps.yourdomain.com` +
   `*.apps.yourdomain.com` together (edit the `-d` flags in
   `issue-certificate.sh` accordingly — or simply run
   `./scripts/install.sh --domain apps.yourdomain.com ...`, since from
   the installer's perspective that string IS the "apex" it's setting up
   Category 1 automation for).
2. The dashboard itself then needs its own separate certificate/nginx
   server block for the true apex `yourdomain.com`, since that's now
   OUTSIDE the wildcard cert issued in step 1 — two separate `certbot`
   invocations, two separate nginx `server_name` blocks, rather than one
   of each.

This is a manual extension of the existing scripts, not something
`install.sh` does automatically today — the installer's current design
assumes the dashboard and every deployed app share one Category 1
wildcard, which covers the common case cleanly but doesn't generalize to
a split namespace without editing `nginx/templates/dreamer.conf.template`
and the certbot `-d` flags by hand.
