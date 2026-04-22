#!/usr/bin/env bash
# Build (unless --no-build) and run mailsluice in Docker via docker compose.
# --clear      Wipe the ./data volume before starting (new admin credentials).
# --no-build   Skip the image build step.
# --detach     Run container in background, do not tail logs.
set -euo pipefail

cd "$(dirname "$0")/.."

CLEAR=0
NO_BUILD=0
DETACH=0
TRAEFIK=0

usage() {
  cat <<EOF
Usage: $0 [--clear] [--no-build] [--detach] [--traefik]

  --clear      Delete ./data (mounted as /app/data) before starting, so the
               admin bootstrap runs again and prints a fresh username/password.
  --no-build   Skip 'docker compose build' and run the existing image.
  --detach, -d Leave the container running in the background instead of
               tailing its logs in the foreground.
  --traefik    Overlay docker-compose.traefik.yml: no host port publish, add
               Traefik labels, join the Traefik network. Requires
               MAILSLUICE_DOMAIN in .env (see .env.example).
EOF
}

for arg in "$@"; do
  case "$arg" in
    --clear) CLEAR=1 ;;
    --no-build) NO_BUILD=1 ;;
    --detach|-d) DETACH=1 ;;
    --traefik) TRAEFIK=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown arg: $arg" >&2; usage; exit 2 ;;
  esac
done

pick_compose() {
  local ver
  if ver=$(docker compose version --short 2>/dev/null) && [ -n "$ver" ]; then
    DC=(docker compose)
    return 0
  fi
  if command -v docker-compose >/dev/null 2>&1 \
     && ver=$(docker-compose version --short 2>/dev/null) \
     && [ "${ver%%.*}" -ge 2 ] 2>/dev/null; then
    DC=(docker-compose)
    return 0
  fi
  return 1
}
if ! pick_compose; then
  echo "Need 'docker compose' or 'docker-compose' v2+ on PATH." >&2
  exit 1
fi

# --traefik overlay uses `ports: !reset null`, which requires Compose >= 2.24.0.
# Older versions silently merge the base ports list and publish 3000:3000 anyway,
# which defeats the point and can collide with an existing port holder.
version_ge() {
  local have=$1 want=$2
  [ "$(printf '%s\n%s\n' "$want" "$have" | sort -V | head -1)" = "$want" ]
}
if [ "$TRAEFIK" = "1" ]; then
  DC_VER=$("${DC[@]}" version --short 2>/dev/null || true)
  if [ -z "$DC_VER" ] || ! version_ge "$DC_VER" "2.24.0"; then
    echo "--traefik needs Docker Compose >= 2.24.0 (you have ${DC_VER:-unknown})." >&2
    echo "Upgrade Compose (the 'ports: !reset' overlay syntax is required)." >&2
    exit 1
  fi
  DC+=(-f docker-compose.yml -f docker-compose.traefik.yml)
  # Surface misconfigured overlay (missing MAILSLUICE_DOMAIN etc.) BEFORE we
  # touch any state; compose renders a specific error from the ${VAR:?...} guard.
  if ! "${DC[@]}" config -q; then
    echo "docker-compose.traefik.yml failed validation (see error above)." >&2
    exit 1
  fi
fi
CONTAINER=mailsluice

for cmd in openssl curl; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "$cmd not found on PATH" >&2; exit 1; }
done

if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created .env from .env.example"
fi

add_if_missing() {
  local key="$1" value="$2"
  if grep -qE "^${key}=.+" .env; then return 0; fi
  if grep -qE "^${key}=$" .env; then
    sed -i "s|^${key}=$|${key}=${value}|" .env
  else
    echo "${key}=${value}" >> .env
  fi
  echo "Set ${key}"
}

add_if_missing APP_ENCRYPTION_KEY "$(openssl rand -base64 32)"
add_if_missing APP_SESSION_SECRET "$(openssl rand -hex 32)"

read_env() {
  grep -E "^$1=" .env | tail -1 | cut -d= -f2- \
    | tr -d '\r' \
    | sed -E -e 's/^"(.*)"$/\1/' -e "s/^'(.*)'\$/\1/"
}
APP_PORT=$(read_env APP_PORT); APP_PORT=${APP_PORT:-3000}

if [ "$TRAEFIK" != "1" ] && [ "$APP_PORT" != "3000" ]; then
  echo "Note: APP_PORT=$APP_PORT in .env, but docker-compose.yml publishes 3000:3000." >&2
  echo "      The container will not be reachable on $APP_PORT unless you edit docker-compose.yml." >&2
fi

"${DC[@]}" down --remove-orphans >/dev/null 2>&1 || true
"${DC[@]}" rm -sf "$CONTAINER" >/dev/null 2>&1 || true

if [ "$CLEAR" = "1" ]; then
  if [ -d data ]; then
    if ! rm -rf data 2>/dev/null; then
      # Files inside the container are owned by the in-container uid for `app`,
      # which may not match the host user. Wipe from inside the app image itself
      # so we don't need to pull alpine just to chown-around the mismatch.
      echo "Wiping ./data via throwaway container (host user cannot remove files)..."
      wipe_err=$(docker run --rm -v "$PWD/data:/d" --entrypoint sh mailsluice:local \
        -c 'find /d -mindepth 1 -delete' 2>&1) || {
        echo "Throwaway wipe failed. Docker said:" >&2
        echo "$wipe_err" >&2
        echo "Remove ./data manually (may need sudo) and retry." >&2
        exit 1
      }
      rm -rf data 2>/dev/null || true
    fi
    if [ -d data ]; then
      echo "Failed to clear ./data. Remove it manually (may need sudo) and retry." >&2
      exit 1
    fi
    echo "Cleared ./data"
  else
    echo "No ./data directory -- nothing to clear"
  fi
fi
mkdir -p data

if [ "$TRAEFIK" != "1" ] \
   && command -v lsof >/dev/null 2>&1 \
   && lsof -iTCP:"$APP_PORT" -sTCP:LISTEN -t >/dev/null 2>&1; then
  HOLDERS=$(lsof -iTCP:"$APP_PORT" -sTCP:LISTEN -t | tr '\n' ' ')
  echo "Port $APP_PORT is already in use by pid(s): $HOLDERS" >&2
  echo "Stop those processes (or change the compose port mapping) and try again." >&2
  exit 1
fi

if [ "$NO_BUILD" != "1" ]; then
  "${DC[@]}" build
fi

# Pass the host user's UID/GID into compose so the container runs as the
# mount owner (prevents EACCES on /app/data with a bind-mounted ./data).
export APP_UID="$(id -u)"
export APP_GID="$(id -g)"
"${DC[@]}" up -d

HEALTH_URL="http://127.0.0.1:${APP_PORT}/health"
UP=0
for _ in $(seq 1 180); do
  state=$(docker inspect -f '{{.State.Status}}' "$CONTAINER" 2>/dev/null || echo missing)
  case "$state" in
    running)
      if [ "$TRAEFIK" = "1" ]; then
        # No host port published; use the Dockerfile HEALTHCHECK state.
        hstate=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$CONTAINER" 2>/dev/null || echo missing)
        if [ "$hstate" = "healthy" ]; then UP=1; break; fi
        if [ "$hstate" = "none" ]; then
          # Image has no HEALTHCHECK: fall back to running-state only.
          UP=1; break
        fi
      else
        if curl -sf "$HEALTH_URL" >/dev/null 2>&1; then UP=1; break; fi
      fi
      ;;
    restarting)
      echo "Container $CONTAINER is restarting (crash-looping)." >&2
      break
      ;;
    *)
      echo "Container $CONTAINER is in state: $state" >&2
      break
      ;;
  esac
  sleep 0.5
done

if [ "$UP" != "1" ]; then
  echo "mailsluice did not become healthy. Recent container logs:" >&2
  "${DC[@]}" logs --tail=80 "$CONTAINER" >&2 || true
  exit 1
fi

LAN_IP=$(hostname -I 2>/dev/null | awk '{print $1}' || true)

# Extract first-run admin credentials from the bounded header block only, so we
# do not accidentally match unrelated log lines that happen to contain
# "username:" or "password:". Retry briefly in case the bootstrap block is
# printed slightly after /health goes green.
ADMIN_BLOCK=""
for _ in 1 2 3 4 5 6 7 8; do
  LOGS=$(docker logs "$CONTAINER" 2>/dev/null || true)
  if printf '%s' "$LOGS" | grep -q "MAILSLUICE FIRST-RUN ADMIN CREDENTIALS"; then
    BLOCK=$(printf '%s\n' "$LOGS" \
      | sed -n '/MAILSLUICE FIRST-RUN ADMIN CREDENTIALS/,/^[[:space:]]*$/p')
    USERNAME=$(printf '%s\n' "$BLOCK" | grep -E "^[[:space:]]+username:" | head -1 | sed -E 's/^[[:space:]]+username:[[:space:]]*//' | tr -d '\r')
    PASSWORD=$(printf '%s\n' "$BLOCK" | grep -E "^[[:space:]]+password:" | head -1 | sed -E 's/^[[:space:]]+password:[[:space:]]*//' | tr -d '\r')
    if [ -n "$USERNAME" ] && [ -n "$PASSWORD" ]; then
      ADMIN_BLOCK="
  ADMIN CREDENTIALS (shown once -- save them now):
    username: ${USERNAME}
    password: ${PASSWORD}
"
      break
    fi
  fi
  sleep 0.5
done

BOLD=""; DIM=""; RESET=""
if [ -t 1 ] && command -v tput >/dev/null 2>&1; then
  BOLD=$(tput bold || true); DIM=$(tput dim || true); RESET=$(tput sgr0 || true)
fi

printf '\n'
printf '%s============================================================%s\n' "$BOLD" "$RESET"
printf '%s Mailsluice (docker) is up.%s\n' "$BOLD" "$RESET"
if [ "$TRAEFIK" = "1" ]; then
  DOMAIN=$(read_env MAILSLUICE_DOMAIN)
  if [ -n "$DOMAIN" ]; then
    printf '   Public:  https://%s/\n' "$DOMAIN"
  fi
  printf '   %sContainer is on the Traefik network; no host port is published.%s\n' "$DIM" "$RESET"
else
  printf '   Local:   http://localhost:%s/\n' "$APP_PORT"
  if [ -n "$LAN_IP" ]; then
    printf '   LAN:     http://%s:%s/\n' "$LAN_IP" "$APP_PORT"
  fi
  printf '   Health:  http://localhost:%s/health\n' "$APP_PORT"
fi
if [ -n "$ADMIN_BLOCK" ]; then
  printf '%s%s%s' "$BOLD" "$ADMIN_BLOCK" "$RESET"
else
  printf '   %sAdmin already bootstrapped; run with --clear to reset and reveal a fresh admin password.%s\n' "$DIM" "$RESET"
fi
printf '\n Stop with: %s down\n' "${DC[*]}"
printf '%s============================================================%s\n\n' "$BOLD" "$RESET"

if [ "$DETACH" = "1" ]; then
  exit 0
fi

printf ' Tailing container logs. Press Ctrl+C to detach (container keeps running).\n\n'
exec "${DC[@]}" logs -f --tail=0 "$CONTAINER"
