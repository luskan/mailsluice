#!/usr/bin/env bash
# Rebuild and restart Mailsluice in Docker.
# Uses Traefik when .env has MAILSLUICE_DOMAIN.
set -euo pipefail

cd "$(dirname "$0")"

read_env() {
  [ -f .env ] || return 0
  grep -E "^$1=" .env | tail -1 | cut -d= -f2- \
    | tr -d '\r' \
    | sed -E -e 's/^"(.*)"$/\1/' -e "s/^'(.*)'\$/\1/"
}

args=(--detach)
domain="$(read_env MAILSLUICE_DOMAIN || true)"
if [ -n "$domain" ]; then
  args=(--traefik "${args[@]}")
fi

exec ./scripts/docker-run.sh "${args[@]}"
