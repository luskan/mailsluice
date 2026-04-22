#!/usr/bin/env bash
# Reset any user's password by rewriting the hash in the DB directly.
# Usage:
#   ./scripts/reset-password.sh <username>          -- local run (tsx, uses .env)
#   ./scripts/reset-password.sh <username> --docker -- run inside the container
set -euo pipefail

cd "$(dirname "$0")/.."

if [ $# -lt 1 ]; then
  echo "Usage: $0 <username> [--docker]" >&2
  exit 2
fi

USERNAME="$1"
MODE="local"
if [ "${2:-}" = "--docker" ]; then
  MODE="docker"
fi

if [ "$MODE" = "docker" ]; then
  exec docker exec -it mailsluice node --env-file-if-exists=.env dist/scripts/reset_password.js "$USERNAME"
fi

# Local: use the checked-out source via tsx so no build is needed.
command -v npx >/dev/null 2>&1 || { echo "npx not found" >&2; exit 1; }
exec node --env-file-if-exists=.env --import tsx src/scripts/reset_password.ts "$USERNAME"
