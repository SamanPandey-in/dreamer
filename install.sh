#!/usr/bin/env bash
#
# ./install.sh --domain yourdomain.com [--email you@yourdomain.com] [--cloudflare-token TOKEN]
#
# Takes a fresh VPS to a running Dreamer Local Engine: installs Docker,
# generates all secrets, obtains a wildcard-only TLS cert, builds the
# build-engine image, and brings up the full stack.
#
# --domain covers ONLY *.yourdomain.com — the apex is deliberately left
# alone, so an existing site at the bare domain is never touched. Only
# add a DNS record for *.yourdomain.com pointing at this box.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
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

# --- 3. TLS certificate (before nginx: its config references the cert
# files unconditionally and fails to start without them) ------------------
log_step "Obtaining wildcard-only TLS certificate for *.${DOMAIN}"
bash "${SCRIPT_DIR}/scripts/lib/issue-certificate.sh" "${DOMAIN}" "${EMAIL}" "${CLOUDFLARE_TOKEN}"

# --- 4. Build the build-engine image --------------------------------------
# Not a compose service — DockerDeploymentEngine launches it on-demand
# per build with `docker run`. Built here so the first deploy just works.
log_step "Building the build-engine image"
docker build -t dreamer-build-engine:local "build-engine"

# --- 5. Build + start the stack -------------------------------------------
log_step "Building and starting the stack (this can take a few minutes on first run)"
docker compose --env-file .env.deploy up -d --build

# --- 6. Database migrations ------------------------------------------------
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
log_step "The dashboard is intentionally NOT public — it's loopback-only, reached over SSH:"
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
