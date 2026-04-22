#!/usr/bin/env bash
# Create a fresh .env with random secrets.
# Usage:
#   ./scripts/create_env.sh                       -- plain docker (no traefik)
#   ./scripts/create_env.sh mail.example.com      -- traefik-ready for that domain
#   ./scripts/create_env.sh mail.example.com --http-auth
#   ./scripts/create_env.sh <...> --force         -- overwrite existing .env
set -euo pipefail

cd "$(dirname "$0")/.."

DOMAIN=""
HTTP_AUTH=0
FORCE=0

for arg in "$@"; do
  case "$arg" in
    --http-auth) HTTP_AUTH=1 ;;
    --force) FORCE=1 ;;
    -h|--help)
      sed -n '2,8p' "$0"
      exit 0
      ;;
    -*)
      echo "Unknown flag: $arg" >&2
      exit 2
      ;;
    *)
      if [ -z "$DOMAIN" ]; then
        DOMAIN="$arg"
      else
        echo "Unexpected extra argument: $arg" >&2
        exit 2
      fi
      ;;
  esac
done

command -v openssl >/dev/null 2>&1 || { echo "openssl not found on PATH" >&2; exit 1; }

if [ ! -f .env.example ]; then
  echo ".env.example not found; run this from the repo root." >&2
  exit 1
fi

if [ -e .env ] && [ "$FORCE" != "1" ]; then
  echo ".env already exists. Pass --force to overwrite, or delete it first." >&2
  exit 1
fi

cp .env.example .env

# Replace KEY= (empty value) line in place if present, else append.
set_env() {
  local key="$1" value="$2"
  if grep -qE "^${key}=" .env; then
    # Escape separators that would break sed's s|||.
    local safe_value
    safe_value=$(printf '%s' "$value" | sed -e 's/[\\|&]/\\&/g')
    sed -i "s|^${key}=.*|${key}=${safe_value}|" .env
  else
    echo "${key}=${value}" >> .env
  fi
}

set_env APP_ENCRYPTION_KEY "$(openssl rand -base64 32)"
set_env APP_SESSION_SECRET "$(openssl rand -hex 32)"

BASIC_AUTH_PASS=""
if [ "$HTTP_AUTH" = "1" ]; then
  BASIC_AUTH_PASS=$(openssl rand -base64 24 | tr -d '\n')
  set_env APP_HTTP_AUTH "gate:${BASIC_AUTH_PASS}"
fi

TRAEFIK_HINT=""
if [ -n "$DOMAIN" ]; then
  set_env MAILSLUICE_DOMAIN "$DOMAIN"
  set_env APP_PUBLIC_BASE_URL "https://${DOMAIN}"
  TRAEFIK_HINT="--traefik "
fi

chmod 600 .env

BOLD=""; DIM=""; RESET=""
if [ -t 1 ] && command -v tput >/dev/null 2>&1; then
  BOLD=$(tput bold || true); DIM=$(tput dim || true); RESET=$(tput sgr0 || true)
fi

printf '\n%s.env created (chmod 600).%s\n' "$BOLD" "$RESET"
if [ -n "$DOMAIN" ]; then
  printf '  Domain:  %s\n' "$DOMAIN"
fi
if [ -n "$BASIC_AUTH_PASS" ]; then
  printf '  Basic Auth: gate / %s\n' "$BASIC_AUTH_PASS"
  printf '  %sSave the Basic Auth password now -- it is only shown here.%s\n' "$DIM" "$RESET"
fi
printf '\nNext:\n  ./scripts/docker-run.sh %s--detach\n\n' "$TRAEFIK_HINT"
