#!/usr/bin/env bash
# Stop and restart mailsluice. Clears everything that lives in process memory:
# rate-limit counters (login 5/15min per user+IP, 20/15min per IP, basic-auth
# 60/min per IP, per-route test/discover limits), active sessions, and
# destination token caches. The SQLite database is untouched.
#
# Handy when you get locked out by a 429 during testing -- the rate-limit
# plugin has no public API to evict a single user, so a restart is the
# quickest way to clear it.
#
# Mode is auto-detected: if a docker container named "mailsluice" is
# running, it is restarted. Otherwise the script expects a local run that
# wrote .mailsluice.pid (via ./scripts/run-local.sh).
#
# Usage:
#   ./scripts/restart.sh            -- auto-detect
#   ./scripts/restart.sh --docker   -- force docker restart mailsluice
#   ./scripts/restart.sh --local    -- force local restart via run-local.sh
set -euo pipefail

cd "$(dirname "$0")/.."

MODE=""
case "${1:-}" in
  --docker) MODE="docker" ;;
  --local) MODE="local" ;;
  "") MODE="" ;;
  -h|--help)
    sed -n '2,18p' "$0"
    exit 0
    ;;
  *)
    echo "Usage: $0 [--docker | --local]" >&2
    exit 2
    ;;
esac

docker_container_running() {
  command -v docker >/dev/null 2>&1 || return 1
  docker ps --format '{{.Names}}' 2>/dev/null | grep -Fxq mailsluice
}

if [ -z "$MODE" ]; then
  if docker_container_running; then
    MODE="docker"
  else
    MODE="local"
  fi
fi

if [ "$MODE" = "docker" ]; then
  if ! docker_container_running; then
    echo "No running docker container named 'mailsluice'." >&2
    echo "Start with ./scripts/docker-run.sh or drop --docker for a local restart." >&2
    exit 1
  fi
  echo "Restarting mailsluice container..."
  exec docker restart mailsluice
fi

PID_FILE=".mailsluice.pid"
LOG_FILE=".mailsluice.out"

read_env() {
  grep -E "^$1=" .env 2>/dev/null | tail -1 | cut -d= -f2- || true
}
APP_PORT=$(read_env APP_PORT); APP_PORT=${APP_PORT:-3000}

stop_tracked() {
  [ -f "$PID_FILE" ] || return 1
  local pid; pid=$(cat "$PID_FILE" 2>/dev/null || true)
  [ -n "${pid:-}" ] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  echo "Stopping mailsluice (pid $pid)..."
  kill -TERM "$pid" 2>/dev/null || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.3
  done
  kill -0 "$pid" 2>/dev/null && kill -KILL "$pid" 2>/dev/null || true
  rm -f "$PID_FILE"
  return 0
}

if ! stop_tracked; then
  echo "No $PID_FILE (or stale); looking for a listener on port $APP_PORT..."
  if command -v lsof >/dev/null 2>&1; then
    HOLDERS=$(lsof -iTCP:"$APP_PORT" -sTCP:LISTEN -t 2>/dev/null | tr '\n' ' ' || true)
    if [ -n "${HOLDERS:-}" ]; then
      echo "Port $APP_PORT is held by pid(s): $HOLDERS"
      echo "Not managed by this script; refusing to kill."
      echo "If this is your docker container, run: $0 --docker"
      exit 1
    fi
  fi
  if command -v docker >/dev/null 2>&1; then
    echo "Hint: no local process found. If you are running in docker: $0 --docker"
  fi
  echo "Nothing running locally. Start with ./scripts/run-local.sh"
  exit 0
fi

if [ ! -x ./scripts/run-local.sh ]; then
  echo "scripts/run-local.sh not executable" >&2
  exit 1
fi

echo "Restarting in the background (logs at $LOG_FILE)..."
# Do NOT pre-truncate LOG_FILE here; run-local.sh owns it and truncates on
# its own startup. Racing the truncate with the nohup'd child would blank
# the admin credentials banner if it had just landed.
nohup ./scripts/run-local.sh >/dev/null 2>&1 &
disown || true

for _ in $(seq 1 80); do
  if curl -sSf "http://127.0.0.1:${APP_PORT}/health" >/dev/null 2>&1; then
    echo "mailsluice is back up at http://localhost:${APP_PORT}/"
    exit 0
  fi
  sleep 0.25
done

echo "App did not become healthy in time; tail -f $LOG_FILE to investigate." >&2
exit 1
