# Wildcard Domains: One Certificate, Deliberately Narrow

Every deployed app lives at `{project.slug}.{yourdomain.com}`, and the
whole TLS story for this system is built around exactly one certificate:
a wildcard covering `*.yourdomain.com` — and, deliberately, **nothing
else**. This page covers why that narrowness is a feature, how the
certificate actually gets issued (wildcards are harder than ordinary
certs), and what changes if you want apps under a deeper namespace like
`*.apps.yourdomain.com`.

## Why the apex is left out — on purpose

The dashboard has no public hostname at all. Nothing on the box answers
for `yourdomain.com`, `www.yourdomain.com`, or
`api.yourdomain.com` — the control plane is loopback-only, reached via
SSH tunnel (see [`SELF-HOSTING.md`](../SELF-HOSTING.md) and the network
posture in [`auth/README.md`](../auth/README.md)).

That decision cascades straight into the certificate: it requests **only**
`*.yourdomain.com`. Requesting the apex too would be pointless — nothing
serves it — and would additionally require you to prove control of a
domain whose apex you may have deliberately pointed somewhere else.

And that's the practical payoff of the wildcard-only design: DNS
delegation is per-record, not per-domain. You point *only* the wildcard
record at your box:

```
yourdomain.com      A/CNAME  ->  (unchanged — wherever it already points)
*.yourdomain.com    A        ->  <VPS IP>   (new — wildcard only)
```

An existing site living at the apex keeps working untouched. Deploying a
project called `hello` gives you `hello.yourdomain.com` served by your
box while the bare domain still serves whatever it served before.

## How the certificate gets issued

A wildcard certificate **cannot** be issued via the common HTTP-01
challenge at all — there's no way to serve a challenge file that proves
you control every possible subdomain at once. The only mechanism is the
**DNS-01 challenge**: you publish a one-time TXT record under
`_acme-challenge.yourdomain.com` proving you control the domain's DNS,
and the certificate authority issues the cert.

`scripts/lib/issue-certificate.sh` runs this flow for you, two ways:

- **Unattended**: pass a Cloudflare API token (`--cloudflare-token` on
  `install.sh`) scoped to *Edit zone DNS* on your domain's zone. The
  script creates and cleans up the TXT record automatically — and, more
  importantly, the same token lets the renewal cron job renew unattended
  forever.
- **Interactive**: no token? The script pauses mid-flow and shows you
  the exact TXT record to create with whatever DNS provider you use;
  you add it by hand, press Enter once it's propagated, and continue.
  Works with any provider; the tradeoff is each renewal (~every 60 days,
  though the cron job handles remembering) needs the same manual step.

Either way the result is the same: one certificate covering every
possible single-label subdomain — `hello.yourdomain.com`,
`my-company.yourdomain.com`, anything a project slug can produce — plus,
covered by the same wildcard, `hooks.yourdomain.com` if you turn on
push-to-deploy. No per-subdomain certificates, ever; a new deployment
needs zero certificate work.

## Renewal

`install.sh` installs `/etc/cron.d/dreamer-local-engine-cert-renewal`,
running `scripts/renew-certs.sh daily`. The underlying client only
actually renews within 30 days of expiry, so most days this is a no-op —
harmless to run daily. With the Cloudflare-token path this is fully
hands-off; with the interactive path, re-run the issuance script by hand
when the cron job starts reporting an upcoming expiry.

## Two-level wildcards: `*.sub.yourdomain.com`

`*.yourdomain.com` and `*.sub.yourdomain.com` look like the same idea at
different depths. For TLS purposes they're different problems entirely:
proving you control `yourdomain.com` says nothing about whether you
intended to hand out certificates for an entire second-level namespace
underneath it, so a CA will happily issue the first via one DNS proof
but requires its own explicit validation for the second. Either can be
obtained through the same DNS-01 flow above — but nobody hands the
two-level case to you automatically; it's always yours to manage.

### Does the routing code need to understand two levels?

No — and this is worth knowing before reaching for a code change.
`reverse-proxy`'s routing assumes deployed apps live one label under
whatever `BASE_DOMAIN` is set to. If you want apps under
`*.apps.yourdomain.com` instead, the simplest fix isn't touching any
routing code — it's installing with `--domain apps.yourdomain.com`.
From the platform's perspective that string IS the "apex" it sets up
one-level automation for; the fact that it's also two levels below your
real registrar apex is a DNS/certificate detail that lives entirely
outside the application. You still need a certificate specifically
covering `*.apps.yourdomain.com` — but zero lines of routing change.

If you *also* want something else serving at the true apex
(`yourdomain.com`), remember that hostname now sits OUTSIDE the
certificate requested in step 1 — it needs its own separate certificate
and its own server block, managed however the rest of that site is
managed. The installer deliberately doesn't try to juggle both in one
pass; splitting namespaces is a manual extension, not a supported flag.

## The mental model, compressed

- **One certificate, one DNS record, one renewal cron** covers every app
  you'll ever deploy at `{slug}.yourdomain.com` and the optional webhook
  host.
- **The apex stays yours** — pointed wherever you want it, untouched by
  this system, unrequested by its certificate.
- **DNS-01 is non-negotiable** for wildcards; the Cloudflare-token path
  exists purely to automate the TXT-record dance, not because the
  certificate itself is special.
