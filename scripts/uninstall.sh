#!/usr/bin/env bash
#
# ./scripts/uninstall.sh [--purge]
#
# Stops and removes every container from docker-compose.prod.yml.
# By default, LEAVES your data alone (the postgres_data/redis_data
# volumes, the generated .env files, and the issued TLS certificate) —
# so `./scripts/install.sh` again afterward picks up right where you left
# off, rather than treating a routine restart as data loss.
#
# --purge additionally deletes the Postgres/Redis volumes, every
# generated .env file, and the certbot/ directory (including the TLS
# private key) — genuinely irreversible, meant for "I want to start
# completely over," not for a routine stop.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
# shellcheck source=./lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"

PURGE=false
for arg in "$@"; do
  case "${arg}" in
    --purge) PURGE=true ;;
    *) fatal "Unknown argument: ${arg}" ;;
  esac
done

cd "${REPO_ROOT}"

log_step "Stopping the stack"
docker compose -f docker-compose.prod.yml --env-file .env.deploy down

if [[ "${PURGE}" == true ]]; then
  log_warn "Purging: Postgres/Redis data, generated .env files, and the TLS certificate/private key."
  read -r -p "This is irreversible. Type 'yes' to continue: " confirm
  if [[ "${confirm}" != "yes" ]]; then
    log_warn "Aborted — containers are stopped, but nothing was deleted."
    exit 0
  fi

  docker compose -f docker-compose.prod.yml --env-file .env.deploy down --volumes
  rm -rf "${REPO_ROOT}/certbot"
  rm -f "${REPO_ROOT}/.env.deploy" "${REPO_ROOT}/apps/api-server/.env" "${REPO_ROOT}/apps/reverse-proxy/.env"
  rm -f /etc/cron.d/dreamer-cert-renewal
  log_ok "Purged. A fresh ./scripts/install.sh run will regenerate everything from scratch."
else
  log_ok "Stopped. Data, secrets, and your certificate are untouched — re-run ./scripts/install.sh to bring it back up. Use --purge to wipe everything instead."
fi
