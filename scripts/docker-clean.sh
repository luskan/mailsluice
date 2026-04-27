#!/usr/bin/env bash
# Wipe every mailsluice container, image, and volume on this host.
# Useful for testing the prebuilt-image quickstart from a clean slate.
# Refuses to do anything until you type CONFIRM.
set -euo pipefail

containers=$(docker ps -aq --filter name=mailsluice 2>/dev/null || true)
images=$(docker images --format '{{.Repository}}:{{.Tag}}' \
  | grep -E '(^|/)mailsluice(:|$)' || true)
volumes=$(docker volume ls --filter name=mailsluice -q 2>/dev/null || true)

if [ -z "$containers" ] && [ -z "$images" ] && [ -z "$volumes" ]; then
  echo "Nothing to clean."
  exit 0
fi

echo "About to remove:"
[ -n "$containers" ] && { echo "  containers:"; docker ps -a --filter name=mailsluice --format '{{.Names}} ({{.Image}}, {{.Status}})' | sed 's/^/    /'; }
[ -n "$images" ]     && { echo "  images:";     printf '    %s\n' $images; }
[ -n "$volumes" ]    && { echo "  volumes:";    printf '    %s\n' $volumes; }
echo
read -r -p "Type CONFIRM to proceed: " answer
if [ "$answer" != "CONFIRM" ]; then
  echo "Aborted."
  exit 1
fi

# docker stop/rm fails with "permission denied" on snap docker + AppArmor
# when the container runs as a non-root user. Killing the host PID is the
# documented workaround (see scripts/docker-run.sh).
for c in $containers; do
  pid=$(docker inspect -f '{{if eq .State.Status "running"}}{{.State.Pid}}{{end}}' "$c" 2>/dev/null || true)
  docker stop "$c" >/dev/null 2>&1 || true
  if [ -n "${pid:-}" ] && [ "$pid" != "0" ] && kill -0 "$pid" 2>/dev/null; then
    sudo kill -9 "$pid" 2>/dev/null || kill -9 "$pid" 2>/dev/null || true
  fi
  docker rm -f "$c" >/dev/null 2>&1 || true
done

for i in $images; do
  docker rmi -f "$i" >/dev/null 2>&1 || true
done

for v in $volumes; do
  docker volume rm -f "$v" >/dev/null 2>&1 || true
done

echo "Done. Remaining mailsluice references:"
docker ps -a --filter name=mailsluice --format '  container: {{.Names}} ({{.Status}})' || true
docker images --format '{{.Repository}}:{{.Tag}}' | grep -E '(^|/)mailsluice(:|$)' | sed 's/^/  image: /' || true
docker volume ls --filter name=mailsluice -q | sed 's/^/  volume: /' || true
echo "(empty above means clean.)"
