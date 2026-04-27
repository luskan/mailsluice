#!/usr/bin/env bash
# Bump version in package.json, tag, and push so the publish workflow runs.
# Usage: ./scripts/release.sh patch|minor|major
set -euo pipefail

cd "$(dirname "$0")/.."

LEVEL="${1:-}"
case "$LEVEL" in
  patch|minor|major) ;;
  *) echo "Usage: $0 patch|minor|major" >&2; exit 2 ;;
esac

if [ -n "$(git status --porcelain)" ]; then
  echo "Working tree is dirty. Commit or stash first." >&2
  exit 1
fi

BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [ "$BRANCH" != "main" ]; then
  echo "Not on main (current: $BRANCH). Refusing." >&2
  exit 1
fi

git fetch origin main --quiet
LOCAL=$(git rev-parse @)
REMOTE=$(git rev-parse origin/main)
if [ "$LOCAL" != "$REMOTE" ]; then
  echo "Local main is not in sync with origin/main. Pull or push first." >&2
  exit 1
fi

# npm version commits and tags as v<x.y.z> by default.
NEW_TAG=$(npm version "$LEVEL" -m "release %s")
echo "Bumped to $NEW_TAG"

git push --follow-tags origin main
echo "Pushed. Watch: github.com/luskan/mailsluice/actions"
