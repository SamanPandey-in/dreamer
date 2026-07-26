#!/usr/bin/env bash
# Installs Docker Engine + the `docker compose` plugin if either is
# missing. Idempotent — safe to re-run install.sh on a box that already
# has Docker; this just no-ops past the check.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./common.sh
source "${SCRIPT_DIR}/common.sh"

ensure_docker_installed() {
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    log_ok "Docker + Compose plugin already installed ($(docker --version))"
    return
  fi

  log_step "Installing Docker Engine (using Docker's official convenience script)"
  # get.docker.com is Docker's own official install script — it detects
  # the distro itself and installs the right apt/dnf/yum repo + packages,
  # including the `docker compose` PLUGIN (not the old standalone
  # docker-compose binary — this project's compose files assume the `v2`
  # plugin syntax throughout, i.e. `docker compose`, not `docker-compose`).
  # Piping curl to sh is exactly the kind of thing to be suspicious of in
  # general — it's acceptable here specifically because it's Docker's own
  # first-party install path, documented at
  # https://docs.docker.com/engine/install/#install-using-the-convenience-script,
  # and is the same thing this repo's own README already pointed people at
  # before this script existed.
  curl -fsSL https://get.docker.com -o /tmp/get-docker.sh
  sh /tmp/get-docker.sh
  rm -f /tmp/get-docker.sh

  systemctl enable --now docker

  if [[ -n "${SUDO_USER:-}" ]]; then
    # So the invoking user can run `docker`/`docker compose` WITHOUT sudo
    # after this script finishes — otherwise every troubleshooting command
    # in docs/SELF-HOSTING.md would need a `sudo` this script itself didn't
    # need (it's already running as root).
    usermod -aG docker "${SUDO_USER}"
    log_warn "Added ${SUDO_USER} to the 'docker' group — log out and back in for this to take effect in your own shell (this script itself doesn't need it, it's already running as root)."
  fi

  log_ok "Docker installed: $(docker --version)"
}

ensure_docker_installed
