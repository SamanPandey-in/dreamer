#!/usr/bin/env bash
# Requests a WILDCARD-ONLY cert (*.${DOMAIN}) — nothing on this box serves
# the apex, so requesting it would be pointless and would force the
# operator to prove control of a domain whose apex may point elsewhere.
#
# A wildcard SAN is only obtainable via DNS-01 (HTTP-01 can't prove
# ownership of a wildcard).
#
# --cert-name "${DOMAIN}" pins the on-disk lineage name so nginx's
# hardcoded /etc/letsencrypt/live/${DOMAIN}/ path is always correct.
#
# Certs land in a HOST bind mount (./certbot/letsencrypt), not a Docker
# named volume — same path whether written by this standalone `docker run`
# or by compose.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
# shellcheck source=./common.sh
source "${SCRIPT_DIR}/common.sh"

DOMAIN="${1:?issue-certificate.sh requires DOMAIN as \$1}"
EMAIL="${2:?issue-certificate.sh requires EMAIL as \$2}"
CLOUDFLARE_TOKEN="${3:-}"

CERT_DIR="${REPO_ROOT}/certbot/letsencrypt"
mkdir -p "${CERT_DIR}"

cert_already_issued() {
  [[ -f "${CERT_DIR}/live/${DOMAIN}/fullchain.pem" ]]
}

issue_via_cloudflare() {
  log_step "Requesting a wildcard-only certificate for *.${DOMAIN} via Cloudflare DNS-01"

  local cf_ini="${REPO_ROOT}/certbot/cloudflare.ini"
  printf 'dns_cloudflare_api_token = %s\n' "${CLOUDFLARE_TOKEN}" > "${cf_ini}"
  chmod 600 "${cf_ini}" # certbot refuses group/world-readable credentials

  docker run --rm \
    -v "${CERT_DIR}:/etc/letsencrypt" \
    -v "${cf_ini}:/etc/letsencrypt/cloudflare.ini:ro" \
    certbot/dns-cloudflare:latest \
    certonly \
    --dns-cloudflare \
    --dns-cloudflare-credentials /etc/letsencrypt/cloudflare.ini \
    --dns-cloudflare-propagation-seconds 30 \
    --cert-name "${DOMAIN}" \
    -d "*.${DOMAIN}" \
    --email "${EMAIL}" \
    --agree-tos \
    --non-interactive

  log_ok "Certificate issued for *.${DOMAIN}"
}

issue_via_manual_dns() {
  log_warn "No Cloudflare API token provided — falling back to MANUAL DNS-01."
  log_warn "This needs YOU to create a TXT record certbot shows you, mid-run, before it continues."
  log_warn "If you're on Cloudflare, re-run with --cloudflare-token instead for a fully unattended install."
  echo

  # Deliberately interactive — certbot prints the TXT record to create
  # and waits for Enter. Proving control of a domain without API creds
  # fundamentally requires this manual step.
  docker run --rm -it \
    -v "${CERT_DIR}:/etc/letsencrypt" \
    certbot/certbot:latest \
    certonly \
    --manual \
    --preferred-challenges dns \
    --cert-name "${DOMAIN}" \
    -d "*.${DOMAIN}" \
    --email "${EMAIL}" \
    --agree-tos
}

main() {
  if cert_already_issued; then
    log_ok "A certificate for ${DOMAIN} already exists at ${CERT_DIR}/live/${DOMAIN}/ — skipping issuance. (Delete that folder first if you need a fresh one, e.g. after adding a subdomain.)"
    return
  fi

  if [[ -n "${CLOUDFLARE_TOKEN}" ]]; then
    issue_via_cloudflare
  else
    issue_via_manual_dns
  fi
}

main
