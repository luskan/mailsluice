#!/usr/bin/env bash
# Bootstrap a local .env with fresh secrets, build, and run mailsluice.
# --clear: wipe the SQLite database and start fresh (new admin credentials).
set -euo pipefail

cd "$(dirname "$0")/.."

PID_FILE=".mailsluice.pid"
LOG_FILE=".mailsluice.out"
CLEAR=0
STOP_ONLY=0

usage() {
  cat <<EOF
Usage: $0 [--clear] [--stop]

  --clear   Delete the SQLite database (APP_DATABASE_PATH from .env, default
            data/mailsluice.db) before starting, so the admin bootstrap runs
            again and you see a fresh admin username/password.
  --stop    Stop a running local mailsluice started by this script, then exit.
            Uses $PID_FILE; if absent, falls back to whatever is listening on
            APP_PORT from .env.
EOF
}

for arg in "$@"; do
  case "$arg" in
    --clear) CLEAR=1 ;;
    --stop) STOP_ONLY=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown arg: $arg" >&2; usage; exit 2 ;;
  esac
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
  grep -E "^$1=" .env | tail -1 | cut -d= -f2- || true
}
APP_PORT=$(read_env APP_PORT);             APP_PORT=${APP_PORT:-3000}
APP_HOST=$(read_env APP_HOST);             APP_HOST=${APP_HOST:-0.0.0.0}
DB_PATH=$(read_env APP_DATABASE_PATH);     DB_PATH=${DB_PATH:-data/mailsluice.db}

STOPPED_ONE=0
stop_previous() {
  STOPPED_ONE=0
  if [ -f "$PID_FILE" ]; then
    local pid; pid=$(cat "$PID_FILE" 2>/dev/null || true)
    if [ -n "${pid:-}" ] && kill -0 "$pid" 2>/dev/null; then
      echo "Stopping mailsluice (pid $pid)..."
      kill -TERM "$pid" 2>/dev/null || true
      for _ in 1 2 3 4 5 6 7 8 9 10; do
        kill -0 "$pid" 2>/dev/null || break
        sleep 0.3
      done
      kill -0 "$pid" 2>/dev/null && kill -KILL "$pid" 2>/dev/null || true
      STOPPED_ONE=1
    fi
    rm -f "$PID_FILE"
  fi
}

if [ "$STOP_ONLY" = "1" ]; then
  stop_previous
  if [ "$STOPPED_ONE" = "1" ]; then
    echo "Stopped."
  else
    echo "No running mailsluice tracked by $PID_FILE."
    APP_PORT_GUESS=$(grep -E "^APP_PORT=" .env 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '\r"'"'" || true)
    APP_PORT_GUESS=${APP_PORT_GUESS:-3000}
    if command -v lsof >/dev/null 2>&1 \
       && lsof -iTCP:"$APP_PORT_GUESS" -sTCP:LISTEN -t >/dev/null 2>&1; then
      HOLDERS=$(lsof -iTCP:"$APP_PORT_GUESS" -sTCP:LISTEN -t | tr '\n' ' ')
      echo "Note: port $APP_PORT_GUESS is held by pid(s): $HOLDERS (not started by this script)." >&2
    fi
  fi
  exit 0
fi
stop_previous

if [ "$CLEAR" = "1" ]; then
  if [ -f "$DB_PATH" ]; then
    rm -f "$DB_PATH" "${DB_PATH}-journal" "${DB_PATH}-wal" "${DB_PATH}-shm"
    echo "Cleared database at $DB_PATH"
  else
    echo "No database at $DB_PATH -- nothing to clear"
  fi
  rm -f "$LOG_FILE"
fi

if command -v lsof >/dev/null 2>&1 \
   && lsof -iTCP:"$APP_PORT" -sTCP:LISTEN -t >/dev/null 2>&1; then
  HOLDERS=$(lsof -iTCP:"$APP_PORT" -sTCP:LISTEN -t | tr '\n' ' ')
  echo "Port $APP_PORT is already in use by pid(s): $HOLDERS" >&2
  echo "Stop those processes (or change APP_PORT in .env) and try again." >&2
  exit 1
fi

npm run build

cleanup() {
  if [ -f "$PID_FILE" ]; then
    local pid; pid=$(cat "$PID_FILE" 2>/dev/null || true)
    if [ -n "${pid:-}" ] && kill -0 "$pid" 2>/dev/null; then
      kill -TERM "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
    fi
    rm -f "$PID_FILE"
  fi
}
trap cleanup EXIT INT TERM

: > "$LOG_FILE"
node --env-file=.env dist/index.js >"$LOG_FILE" 2>&1 &
NODE_PID=$!
echo "$NODE_PID" > "$PID_FILE"

HEALTH_URL="http://127.0.0.1:${APP_PORT}/health"
UP=0
for _ in $(seq 1 80); do
  if curl -sSf "$HEALTH_URL" >/dev/null 2>&1; then
    UP=1; break
  fi
  if ! kill -0 "$NODE_PID" 2>/dev/null; then break; fi
  sleep 0.25
done

if [ "$UP" != "1" ]; then
  echo "mailsluice did not become healthy. Last lines of $LOG_FILE:" >&2
  tail -50 "$LOG_FILE" >&2 || true
  exit 1
fi

LAN_IP=$(hostname -I 2>/dev/null | awk '{print $1}' || true)

ADMIN_BLOCK=""
if grep -q "MAILSLUICE FIRST-RUN ADMIN CREDENTIALS" "$LOG_FILE"; then
  USERNAME=$(grep -E "^[[:space:]]+username:" "$LOG_FILE" | head -1 | sed -E 's/^[[:space:]]+username:[[:space:]]*//')
  PASSWORD=$(grep -E "^[[:space:]]+password:" "$LOG_FILE" | head -1 | sed -E 's/^[[:space:]]+password:[[:space:]]*//')
  ADMIN_BLOCK="
  ADMIN CREDENTIALS (shown once -- save them now):
    username: ${USERNAME}
    password: ${PASSWORD}
"
fi

BOLD=""; DIM=""; RESET=""
if [ -t 1 ] && command -v tput >/dev/null 2>&1; then
  BOLD=$(tput bold || true); DIM=$(tput dim || true); RESET=$(tput sgr0 || true)
fi

printf '\n'
printf '%s============================================================%s\n' "$BOLD" "$RESET"
printf '%s Mailsluice is up.%s\n' "$BOLD" "$RESET"
printf '   Local:   http://localhost:%s/\n' "$APP_PORT"
if [ -n "$LAN_IP" ] && [ "$APP_HOST" = "0.0.0.0" ]; then
  printf '   LAN:     http://%s:%s/\n' "$LAN_IP" "$APP_PORT"
fi
printf '   Health:  http://localhost:%s/health\n' "$APP_PORT"
if [ -n "$ADMIN_BLOCK" ]; then
  printf '%s%s%s' "$BOLD" "$ADMIN_BLOCK" "$RESET"
else
  printf '   %sAdmin already bootstrapped; run with --clear to reset the DB and reveal a fresh admin password.%s\n' "$DIM" "$RESET"
fi
printf '\n Press Ctrl+C to stop. Logs follow:\n'
printf '%s============================================================%s\n\n' "$BOLD" "$RESET"

tail -n +1 -F --pid="$NODE_PID" "$LOG_FILE"
wait "$NODE_PID" 2>/dev/null || true
