#!/usr/bin/env bash
# Shared helpers, sourced (not executed) by every other script in this
# directory — `source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"`.
# Nothing in here touches the network or the filesystem beyond stdout —
# it's pure bash utility, kept in one place so a formatting change (colors,
# a log prefix) doesn't need editing in five different scripts.

set -euo pipefail

# --- logging -----------------------------------------------------------
# Colored, prefixed output — install.sh runs a LOT of steps in sequence
# (OS check, Docker install, secret generation, cert issuance, compose up,
# migrations), and a wall of unprefixed `echo` output makes it genuinely
# hard to tell "this line is informational" from "this line means it broke"
# when something DOES go wrong three steps in.
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

require_root() {
  # Installing Docker, writing to /etc/cron.d, and binding ports 80/443
  # all need root. Failing fast with a clear message here beats a
  # confusing "permission denied" forty lines into the Docker install step.
  if [[ "${EUID}" -ne 0 ]]; then
    fatal "This script needs root — re-run it as: sudo ./scripts/install.sh ..."
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

# A deliberately permissive check — this is a sanity check against typos
# ("exmaple.com", a stray "https://" left in), not a full RFC 1035
# validator. A real DNS lookup failing later is a much clearer signal of
# an actually-wrong domain than a regex could ever give.
validate_domain() {
  local domain="$1"
  if [[ -z "${domain}" ]]; then
    fatal "No domain provided. Usage: ./scripts/install.sh --domain yourdomain.com"
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
  # $1 = number of bytes. JWT secrets need >=32 chars per env.ts's own
  # validation; ENCRYPTION_KEY needs EXACTLY 64 hex chars (32 bytes) — see
  # that file's comment on why (it's an AES-256 key, not an arbitrary
  # secret string).
  openssl rand -hex "$1"
}

detect_public_ip() {
  # Best-effort — used only for the friendly "point your DNS at THIS IP"
  # message at the end, never for anything the install depends on
  # functioning correctly. Falls back to a placeholder rather than failing
  # the whole install over a convenience lookup.
  curl -fsSL --max-time 5 https://ifconfig.me 2>/dev/null \
    || curl -fsSL --max-time 5 https://api.ipify.org 2>/dev/null \
    || echo "<could-not-detect-fetch-manually-with-curl-ifconfig.me>"
}
