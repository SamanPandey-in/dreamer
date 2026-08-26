#!/usr/bin/env bash
# Run by cron (see install.sh's step 7), and safe to run by hand any time.
# `certbot renew` itself is a no-op unless a certificate is within 30 days
# of expiry — running this daily costs nothing on the days it doesn't
# actually renew anything.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOCAL_ENGINE_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
CERT_DIR="${LOCAL_ENGINE_ROOT}/certbot/letsencrypt"
CF_INI="${LOCAL_ENGINE_ROOT}/certbot/cloudflare.ini"

log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"; }

if [[ ! -f "${CF_INI}" ]]; then
  log "No certbot/cloudflare.ini found — this install used the manual DNS-01 fallback, which this script can't renew unattended (manual DNS-01 needs a fresh interactive TXT record each time). Renew by hand: ./scripts/lib/issue-certificate.sh ${1:-<your-domain>} <your-email>"
  exit 0
fi

log "Attempting certificate renewal..."
docker run --rm \
  -v "${CERT_DIR}:/etc/letsencrypt" \
  -v "${CF_INI}:/etc/letsencrypt/cloudflare.ini:ro" \
  certbot/dns-cloudflare:latest \
  renew \
  --dns-cloudflare \
  --dns-cloudflare-credentials /etc/letsencrypt/cloudflare.ini \
  --dns-cloudflare-propagation-seconds 30 \
  --quiet

log "Reloading nginx..."
cd "${LOCAL_ENGINE_ROOT}"
if docker compose --env-file .env.deploy exec -T nginx nginx -s reload; then
  log "nginx reloaded"
else
  log "nginx reload failed (is the stack running? 'docker compose ps')"
fi
