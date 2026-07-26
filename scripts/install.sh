#!/usr/bin/env bash
#
# ./scripts/install.sh --domain yourdomain.com [--email you@yourdomain.com] [--cloudflare-token TOKEN]
#
# Single command that takes a fresh VPS/EC2 box to a running Dreamer
# platform: installs Docker if missing, generates every secret this stack
# needs, obtains a wildcard TLS certificate, and brings up Postgres,
# Redis, api-server, frontend, reverse-proxy, and nginx — all as
# containers on THIS box, no managed cloud Postgres/Redis required.
#
# What this does NOT do for you (can't — these require accounts/apps only
# you can create): a GitHub OAuth App, and — only if you plan to actually
# deploy user apps, which is a separate concern from hosting this
# dashboard — AWS credentials. Both get clearly-marked TODO placeholders
# in the generated apps/api-server/.env; see the final summary this
# script prints, and docs/SELF-HOSTING.md.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
# shellcheck source=./lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"

DOMAIN=""
EMAIL=""
CLOUDFLARE_TOKEN=""

usage() {
  cat <<EOF
Usage: $0 --domain yourdomain.com [--email you@yourdomain.com] [--cloudflare-token TOKEN]

  --domain            Required. The apex domain you control, e.g. singularitydev.xyz
                       (no "https://", no leading "*.", no subdomain).
  --email              Optional. Used for Let's Encrypt expiry notices.
                       Defaults to admin@<domain>.
  --cloudflare-token   Optional. A Cloudflare API token (Zone:DNS:Edit
                       scope, on the zone for --domain) — enables a fully
                       unattended wildcard certificate via DNS-01.
                       Omit this and the script falls back to an
                       INTERACTIVE manual DNS-01 flow instead (it'll pause
                       and show you a TXT record to create by hand).
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain) DOMAIN="$2"; shift 2 ;;
    --email) EMAIL="$2"; shift 2 ;;
    --cloudflare-token) CLOUDFLARE_TOKEN="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) log_error "Unknown argument: $1"; usage; exit 1 ;;
  esac
done

validate_domain "${DOMAIN}"
EMAIL="${EMAIL:-admin@${DOMAIN}}"

require_root
require_command curl
require_command openssl

echo
log_step "Installing Dreamer on this box for domain: ${DOMAIN}"
echo

# --- 1. Docker -------------------------------------------------------
source "${SCRIPT_DIR}/lib/install-docker.sh"

# --- 2. Secrets + env files -------------------------------------------
log_step "Generating secrets and .env files"
POSTGRES_PASSWORD="$(random_hex 24)"
bash "${SCRIPT_DIR}/lib/generate-env.sh" "${DOMAIN}" "${POSTGRES_PASSWORD}"

# --- 3. TLS certificate (BEFORE bringing nginx up — it fails to start
# without cert files that its own config already references) -----------
log_step "Obtaining wildcard TLS certificate for ${DOMAIN} and *.${DOMAIN}"
bash "${SCRIPT_DIR}/lib/issue-certificate.sh" "${DOMAIN}" "${EMAIL}" "${CLOUDFLARE_TOKEN}"

# --- 4. Build + start the stack -----------------------------------------
log_step "Building and starting the stack (this can take a few minutes on first run)"
cd "${REPO_ROOT}"
docker compose -f docker-compose.prod.yml --env-file .env.deploy up -d --build

# --- 5. Database migrations ---------------------------------------------
# `docker compose run` (not `exec`) deliberately — this starts a fresh,
# independent one-off container from the api-server image rather than
# piggybacking on the long-running `api-server` SERVICE container, which
# may well be crash-looping right now (env.ts fails fast on the still-
# empty GITHUB_CLIENT_ID/SECRET placeholders — expected at this point in
# the install, not a bug). `prisma migrate deploy` only needs
# DATABASE_URL, which IS already set correctly, so it succeeds
# independently of that.
log_step "Running database migrations"
attempt=0
until docker compose -f docker-compose.prod.yml --env-file .env.deploy run --rm --entrypoint sh api-server -c "npx prisma migrate deploy"; do
  attempt=$((attempt + 1))
  if [[ "${attempt}" -ge 5 ]]; then
    fatal "Migrations failed after 5 attempts — check 'docker compose -f docker-compose.prod.yml logs postgres'"
  fi
  log_warn "Migration attempt ${attempt} failed (Postgres may still be starting) — retrying in 5s..."
  sleep 5
done
log_ok "Migrations applied"

# --- 6. Certificate auto-renewal ----------------------------------------
log_step "Installing a daily renewal cron job"
CRON_FILE="/etc/cron.d/dreamer-cert-renewal"
echo "0 3 * * * root ${REPO_ROOT}/scripts/renew-certs.sh ${DOMAIN} >> /var/log/dreamer-cert-renewal.log 2>&1" > "${CRON_FILE}"
chmod 644 "${CRON_FILE}"
log_ok "Wrote ${CRON_FILE} (runs daily at 03:00; certbot itself only actually renews within 30 days of expiry)"

# --- 7. Summary -----------------------------------------------------
PUBLIC_IP="$(detect_public_ip)"
echo
log_ok "Stack is up. Here's what's left:"
cat <<EOF

1. Point DNS at this box's public IP (${PUBLIC_IP}):
     A     ${DOMAIN}         ->  ${PUBLIC_IP}
     A     *.${DOMAIN}       ->  ${PUBLIC_IP}
   (If you're on Cloudflare: set BOTH records to "DNS only" / grey cloud,
   not proxied — Cloudflare's proxy doesn't forward the raw TLS handshake
   your own nginx+certbot cert is terminating. See docs/SELF-HOSTING.md
   if you've hit this exact issue before.)

2. Create a GitHub OAuth App at https://github.com/settings/developers
     Homepage URL:              https://${DOMAIN}
     Authorization callback URL: https://api.${DOMAIN}/api/auth/github/callback
   Then edit apps/api-server/.env — fill in GITHUB_CLIENT_ID and
   GITHUB_CLIENT_SECRET (already-generated secrets like JWT/ENCRYPTION_KEY
   are untouched, don't regenerate those).

3. Restart api-server to pick up what you just pasted in:
     docker compose -f docker-compose.prod.yml --env-file .env.deploy restart api-server

4. Visit https://${DOMAIN} — once DNS has propagated, that's your Dreamer
   dashboard, running entirely on this box.

Deploying actual user apps (the AWS/ECS/Lambda side) is a separate,
unrelated setup — see docs/AWS-Console-Setup-Guide.md for that whenever
you're ready for it. This install only covers hosting the Dreamer
platform itself.
EOF
