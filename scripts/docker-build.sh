#!/usr/bin/env bash
# Build the mailsluice Docker image (tagged mailsluice:local via docker compose).
set -euo pipefail

cd "$(dirname "$0")/.."

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

"${DC[@]}" build "$@"
echo "Built mailsluice:local"
