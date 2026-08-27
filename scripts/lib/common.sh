#!/usr/bin/env bash
# Shared helpers, sourced (not executed) by every other script here.

set -euo pipefail

if [[ -n "${_DREAMER_COMMON_SOURCED:-}" ]]; then
  return 0
fi
_DREAMER_COMMON_SOURCED=1

# --- logging -----------------------------------------------------------
readonly _C_BLUE='\033[0;34m'
readonly _C_GREEN='\033[0;32m'
readonly _C_YELLOW='\033[1;33m'
readonly _C_RED='\033[0;31m'
readonly _C_RESET='\033[0m'

log_step()  { echo -e "${_C_BLUE}==>${_C_RESET} $*"; }
log_ok()    { echo -e "${_C_GREEN}✓${_C_RESET} $*"; }
log_warn()  { echo -e "${_C_YELLOW}!${_C_RESET} $*"; }
log_error() { echo -e "${_C_RED}✗${_C_RESET} $*" >&2; }

fatal() {
  log_error "$*"
  exit 1
}

# --- environment checks --------------------------------------------------

# Docker install, /etc/cron.d writes, and ports 80/443 all need root.
require_root() {
  if [[ "${EUID}" -ne 0 ]]; then
    fatal "This script needs root — re-run it as: sudo ./install.sh ..."
  fi
}

require_command() {
  local cmd="$1"
  local hint="${2:-}"
  if ! command -v "${cmd}" >/dev/null 2>&1; then
    fatal "Required command '${cmd}' not found.${hint:+ ${hint}}"
  fi
}

# --- validation ----------------------------------------------------------

# Sanity check against typos, not a full RFC validator — a real DNS lookup
# failing later is a much clearer signal of an actually-wrong domain.
validate_domain() {
  local domain="$1"
  if [[ -z "${domain}" ]]; then
    fatal "No domain provided. Usage: ./install.sh --domain yourdomain.com"
  fi
  if [[ "${domain}" == http* ]]; then
    fatal "Pass a bare domain (e.g. singularitydev.xyz), not a URL — got: ${domain}"
  fi
  if [[ "${domain}" == *"*"* ]]; then
    fatal "Pass the apex domain only (e.g. singularitydev.xyz) — this script adds the wildcard itself, don't include '*.' yourself."
  fi
}

# --- misc ------------------------------------------------------------

random_hex() {
  # $1 = number of bytes. ENCRYPTION_KEY needs exactly 64 hex chars
  # (an AES-256 key), JWT secrets need >=32 chars.
  openssl rand -hex "$1"
}

# Best-effort — only used for the "point your DNS at this IP" message,
# never fails the install.
detect_public_ip() {
  curl -fsSL --max-time 5 https://ifconfig.me 2>/dev/null \
    || curl -fsSL --max-time 5 https://api.ipify.org 2>/dev/null \
    || echo "<could-not-detect-fetch-manually-with-curl-ifconfig.me>"
}
