#!/usr/bin/env bash
# Update a source checkout and optionally rebuild its Docker deployment.
set -euo pipefail

usage() {
  cat <<EOF
Usage: $0 [--rebuild] [--rebase] [--traefik]

  --rebuild  Build the image, then recreate the container in the background.
             Keeps .env and ./data; leaves the container running if build fails.
  --rebase   Rebase local commits onto the upstream branch instead of requiring
             a fast-forward. Resolve any conflicts manually before retrying.
  --traefik  Use the Traefik Compose overlay (requires --rebuild).
             Also detected automatically on an existing Traefik container.

Without --rebuild, only update Git. Requires a clean working tree and a branch
with an upstream. For source/Compose deployments, not the prebuilt-image setup.
EOF
}

# Parse the entire function before pulling, since the pull may update this file.
main() {
  local rebuild=0 rebase=0 traefik=0 arg
  for arg in "$@"; do
    case "$arg" in
      --rebuild) rebuild=1 ;;
      --rebase) rebase=1 ;;
      --traefik) traefik=1 ;;
      -h|--help) usage; return 0 ;;
      *) echo "Unknown argument: $arg" >&2; usage >&2; return 2 ;;
    esac
  done
  if [ "$traefik" = 1 ] && [ "$rebuild" != 1 ]; then
    echo "--traefik requires --rebuild." >&2
    return 2
  fi

  cd "$(dirname "${BASH_SOURCE[0]}")/.."
  if [ -n "$(git status --porcelain)" ]; then
    echo "Working tree is dirty. Commit or stash changes before pulling." >&2
    return 1
  fi
  if ! git rev-parse --verify '@{upstream}' >/dev/null 2>&1; then
    echo "The current branch needs an upstream before pulling." >&2
    return 1
  fi

  if [ "$rebase" = 1 ]; then
    git -c pull.ff=true pull --rebase --no-autostash
  else
    git pull --ff-only --no-rebase --no-autostash
  fi

  if [ "$rebuild" = 1 ]; then
    local run_args=(--no-build --detach)
    if [ "$traefik" = 1 ] || [ "$(docker inspect -f '{{index .Config.Labels "traefik.enable"}}' mailsluice 2>/dev/null || true)" = true ]; then
      run_args+=(--traefik)
    fi
    # Build first: docker-run.sh stops the old container before starting it.
    ./scripts/docker-build.sh
    ./scripts/docker-run.sh "${run_args[@]}"
  fi
}

main "$@"
