#!/usr/bin/env bash
# local-engine — see docs/architecture/local-engine-auth-and-networking.md
# "The samanp.xyz example, concretely". Requests a WILDCARD-ONLY cert
# (*.${DOMAIN}) — deliberately NOT the apex domain anymore, unlike the
# cloud engine's version of this script. Nothing on this box serves the
# apex (nginx has no ${DOMAIN} server block at all — see
# nginx/templates/dreamer.conf.template): only *.${DOMAIN} (deployed apps,
# custom domains) and, optionally, hooks.${DOMAIN}. Requesting the apex
# too would be pointless and would need the operator to prove control of a
# domain whose apex they may have deliberately left pointed elsewhere
# (e.g. an existing Vercel/Netlify site at the bare domain).
#
# A wildcard SAN is only obtainable via DNS-01 (HTTP-01 can't prove
# ownership of a wildcard — there's no single file path that answers for
# every possible subdomain).
#
# --cert-name "${DOMAIN}" pins the on-disk lineage name explicitly (not
# left to certbot's own default-from-first-domain logic, which is murkier
# for a wildcard-only request than a documented, load-bearing path should
# rely on) — this is what makes nginx's hardcoded
# /etc/letsencrypt/live/${DOMAIN}/ path always correct regardless of
# certbot version behavior.
#
# Certs land in a HOST bind mount (./certbot/letsencrypt), not a Docker
# named volume — this is deliberate: a bind mount path is identical
# whether it's written by this standalone `docker run` or by
# docker-compose.prod.yml's own service definitions, with no dependency on
# Compose's project-name-based volume naming lining up between the two.
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
  chmod 600 "${cf_ini}" # certbot itself refuses to run with a group/world-readable credentials file

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

  # Deliberately interactive (-it, no --non-interactive) — certbot will
  # print the exact TXT record name/value to create and wait for Enter.
  # This is the one part of install.sh that CAN'T be made fully autonomous
  # without a supported DNS provider's API — proving control of a domain
  # you haven't given this script any credentials for fundamentally
  # requires a manual step somewhere.
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
