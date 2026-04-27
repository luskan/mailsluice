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
# when the container runs as a non-root user. Fall back to killing the
# host PID via sudo (see scripts/docker-run.sh for the same workaround).
for c in $containers; do
  pid=$(docker inspect -f '{{if eq .State.Status "running"}}{{.State.Pid}}{{end}}' "$c" 2>/dev/null || true)
  docker stop "$c" >/dev/null 2>&1 || true
  if docker rm -f "$c" >/dev/null 2>&1; then
    continue
  fi
  if [ -n "${pid:-}" ] && [ "$pid" != "0" ]; then
    echo "Container $c stuck. Killing host pid $pid (needs sudo)..."
    sudo kill -9 "$pid" || true
    sleep 1
    docker rm -f "$c" >/dev/null 2>&1 || true
  fi
done

for i in $images; do
  docker rmi -f "$i" >/dev/null 2>&1 || true
done

for v in $volumes; do
  docker volume rm -f "$v" >/dev/null 2>&1 || true
done

left_containers=$(docker ps -a --filter name=mailsluice --format '{{.Names}} ({{.Status}})' || true)
left_images=$(docker images --format '{{.Repository}}:{{.Tag}}' | grep -E '(^|/)mailsluice(:|$)' || true)
left_volumes=$(docker volume ls --filter name=mailsluice -q || true)

if [ -z "$left_containers" ] && [ -z "$left_images" ] && [ -z "$left_volumes" ]; then
  echo "Done. Clean."
  exit 0
fi

echo "Done, but some references remain:"
[ -n "$left_containers" ] && printf '  container: %s\n' $left_containers
[ -n "$left_images" ]     && printf '  image:     %s\n' $left_images
[ -n "$left_volumes" ]    && printf '  volume:    %s\n' $left_volumes
exit 1
