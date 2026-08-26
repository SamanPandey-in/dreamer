#!/usr/bin/env bash
#
# ./install.sh --domain yourdomain.com [--email you@yourdomain.com] [--cloudflare-token TOKEN]
#
# Single command that takes a fresh VPS to a running Dreamer Local Engine:
# installs Docker if missing, generates every secret this stack needs,
# obtains a wildcard-only TLS certificate, builds the build-engine image,
# and brings up Postgres, Redis, MinIO, api-server, build-worker,
# frontend, reverse-proxy, and nginx — all as containers on THIS box.
# No AWS account, no managed cloud Postgres/Redis/S3 needed anywhere.
#
# --domain covers ONLY *.yourdomain.com — the apex is deliberately left
# alone (see docs/architecture/local-engine-auth-and-networking.md's
# samanp.xyz walkthrough): if you already have a site at the bare domain
# (Vercel, Netlify, whatever), this never touches it. Only add a DNS
# record for *.yourdomain.com pointing at this box.
#
# No external accounts needed at all to finish this script — no GitHub
# App, no email provider (see Decision 1 & 2: single-admin login + a git
# Personal Access Token, both set up in-app after first login, not here).
#
# Deliberately mirrors the repo root's own scripts/install.sh step-for-step
# (same flag names, same ordering, same cert-before-nginx / migrate-after-up
# reasoning) — anyone who's already self-hosted the cloud version's control
# plane will recognize this immediately.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Anchor every later relative path (build-engine, .env.deploy,
# docker-compose.yml) to this script's own directory, not the caller's
# shell CWD — so `sudo ./install.sh` and
# `bash /somewhere/local-engine/install.sh` behave identically.
cd "${SCRIPT_DIR}"
# shellcheck source=./scripts/lib/common.sh
source "${SCRIPT_DIR}/scripts/lib/common.sh"

DOMAIN=""
EMAIL=""
CLOUDFLARE_TOKEN=""

usage() {
  cat <<EOF
Usage: $0 --domain yourdomain.com [--email you@yourdomain.com] [--cloudflare-token TOKEN]

  --domain            Required. The domain whose WILDCARD you're pointing
                       at this box, e.g. yourdomain.com (no "https://", no
                       leading "*."). Only *.yourdomain.com is touched —
                       the bare apex is left alone; see this script's own
                       header comment.
  --email              Optional. Used for Let's Encrypt expiry notices.
                       Defaults to admin@<domain>.
  --cloudflare-token   Optional. A Cloudflare API token (Zone:DNS:Edit
                       scope, on the zone for --domain) — enables a fully
                       unattended wildcard certificate via DNS-01.
                       Omit this and the script falls back to an
                       INTERACTIVE manual DNS-01 flow instead.
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
log_step "Installing Dreamer Local Engine on this box for domain: ${DOMAIN}"
echo

# --- 1. Docker -----------------------------------------------------------
source "${SCRIPT_DIR}/scripts/lib/install-docker.sh"

# --- 2. Secrets + env files ------------------------------------------------
log_step "Generating secrets and .env files"
POSTGRES_PASSWORD="$(random_hex 24)"
MINIO_ROOT_PASSWORD="$(random_hex 24)"
bash "${SCRIPT_DIR}/scripts/lib/generate-env.sh" "${DOMAIN}" "${POSTGRES_PASSWORD}" "${MINIO_ROOT_PASSWORD}"

# --- 3. TLS certificate (BEFORE bringing nginx up — same reasoning as the
# repo root's own install.sh: nginx's config already references cert
# files unconditionally and fails to start without them) -----------------
log_step "Obtaining wildcard-only TLS certificate for *.${DOMAIN}"
bash "${SCRIPT_DIR}/scripts/lib/issue-certificate.sh" "${DOMAIN}" "${EMAIL}" "${CLOUDFLARE_TOKEN}"

# --- 4. Build the build-engine image --------------------------------------
# NOT a compose service (see docker-compose.yml's own comment) —
# DockerDeploymentEngine runs it on-demand per build with `docker run`,
# same role ECS RunTask plays in the cloud version. Has to exist before
# the first deploy is attempted, so build it here rather than leaving it
# as a manual step someone forgets.
log_step "Building the build-engine image"
docker build -t dreamer-build-engine:local "build-engine"

# --- 5. Build + start the stack -------------------------------------------
log_step "Building and starting the stack (this can take a few minutes on first run)"
docker compose --env-file .env.deploy up -d --build

# --- 6. Database migrations ------------------------------------------------
# `docker compose run` (not `exec`), same reasoning as the repo root's own
# install.sh: a fresh one-off container from the api-server image, not the
# long-running service — which boots fine now with no external creds
# required at all (Decision 1 & 2: no GitHub App, no Resend account; a git
# PAT is set later, in-app, from Settings — see summary this script prints).
log_step "Running database migrations"
attempt=0
until docker compose --env-file .env.deploy run --rm --entrypoint sh api-server -c "npx prisma migrate deploy"; do
  attempt=$((attempt + 1))
  if [[ "${attempt}" -ge 5 ]]; then
    fatal "Migrations failed after 5 attempts — check 'docker compose logs postgres'"
  fi
  log_warn "Migration attempt ${attempt} failed (Postgres may still be starting) — retrying in 5s..."
  sleep 5
done
log_ok "Migrations applied"

# --- 7. Certificate auto-renewal --------------------------------------------
log_step "Installing a daily renewal cron job"
CRON_FILE="/etc/cron.d/dreamer-local-engine-cert-renewal"
echo "0 3 * * * root ${SCRIPT_DIR}/scripts/renew-certs.sh ${DOMAIN} >> /var/log/dreamer-local-engine-cert-renewal.log 2>&1" > "${CRON_FILE}"
chmod 644 "${CRON_FILE}"
log_ok "Wrote ${CRON_FILE} (runs daily at 03:00; certbot itself only actually renews within 30 days of expiry)"

# --- 8. Summary --------------------------------------------------------------
PUBLIC_IP="$(detect_public_ip)"
echo
log_ok "Install complete."
echo
echo "  Deployed apps live under: https://<project-slug>.${DOMAIN}"
echo
log_warn "Point *.${DOMAIN} (wildcard) at this box's IP (${PUBLIC_IP}) if you haven't already — the bare ${DOMAIN} is untouched, point it wherever it already goes."
echo
log_step "The dashboard is intentionally NOT public — see"
log_step "docs/architecture/local-engine-auth-and-networking.md Decision 4."
echo "  From THIS machine (or over SSH):"
echo "    ssh -L 3000:localhost:3000 -L 8000:localhost:8000 $(whoami)@${PUBLIC_IP}"
echo "  then open http://localhost:3000 in your own browser — that first load"
echo "  is the one-time admin setup screen (name/email/password)."
echo
log_step "Optional next steps, both done from Settings after you log in — not required to start deploying:"
echo "  - Add a git Personal Access Token (Settings > Git) to deploy private repos."
echo "  - Turn on push-to-deploy: set GITHUB_WEBHOOK_SECRET + ENABLE_PUSH_DEPLOY=true"
echo "    in api-server/.env and docker-compose.yml, then"
echo "    docker compose --env-file .env.deploy up -d nginx api-server build-worker"
echo "    — see api-server/.env.example for the exact vars."
