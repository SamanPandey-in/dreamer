#!/usr/bin/env bash
# Installs Docker Engine + the `docker compose` v2 plugin if missing.
# Idempotent — safe to re-run on a box that already has Docker.
set -euo pipefail
_INSTALL_DOCKER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./common.sh
source "${_INSTALL_DOCKER_DIR}/common.sh"

ensure_docker_installed() {
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    log_ok "Docker + Compose plugin already installed ($(docker --version))"
    return
  fi

  log_step "Installing Docker Engine (using Docker's official convenience script)"
  # get.docker.com is Docker's first-party install path; it installs the
  # compose PLUGIN (`docker compose`), which this repo's compose files
  # require throughout.
  curl -fsSL https://get.docker.com -o /tmp/get-docker.sh
  sh /tmp/get-docker.sh
  rm -f /tmp/get-docker.sh

  systemctl enable --now docker

  if [[ -n "${SUDO_USER:-}" ]]; then
    # Let the invoking user run docker without sudo afterwards.
    usermod -aG docker "${SUDO_USER}"
    log_warn "Added ${SUDO_USER} to the 'docker' group — log out and back in for this to take effect in your own shell."
  fi

  log_ok "Docker installed: $(docker --version)"
}

ensure_docker_installed
