#!/usr/bin/env bash
# One hard-capped, private systemd container. No host fleet/tmux or real providers.
set -euo pipefail
repo=$(cd "$(dirname "$0")/../../.." && pwd)
baseline=${1:?Usage: run.sh /absolute/path/to/baseline/dist}
test -f "$baseline/fleet-manager.js"
free -m
mkdir -p "$repo/.artifacts"
output=$(mktemp -d "$repo/.artifacts/startup-memory-XXXXXX")
nonce=$(basename "$output")
container="sentinel-$nonce"
cleanup() {
  docker cp "$container:/opt/rehearsal/results.json" "$output/results.json" 2>/dev/null || true
  docker cp "$container:/opt/rehearsal/candidate-replies.json" "$output/candidate-replies.json" 2>/dev/null || true
  for leg in baseline candidate nonmemory; do
    docker cp "$container:/opt/rehearsal/$leg-journal.log" "$output/$leg-journal.log" 2>/dev/null || true
    docker cp "$container:/opt/rehearsal/$leg-daemon.log" "$output/$leg-daemon.log" 2>/dev/null || true
  done
  docker logs "$container" > "$output/container.log" 2>&1 || true
  if [ "$(docker inspect -f '{{index .Config.Labels "agend.startup-memory"}}' "$container" 2>/dev/null)" = "$nonce" ]; then
    docker rm -f "$container" > /dev/null
  fi
  echo "Evidence: $output"
}
trap cleanup EXIT
docker run -d --privileged --cgroupns=private --memory=1536m --memory-swap=1536m --cpus=2 \
  --network=none --tmpfs /run --tmpfs /run/lock --label "agend.startup-memory=$nonce" \
  --name "$container" "${STARTUP_MEMORY_IMAGE:-agend-rh-b16-bus}" > "$output/container-id"
docker exec "$container" mkdir -p /opt/rehearsal/pkg /opt/rehearsal/baseline-dist
(cd "$repo" && tar -chf - dist src launcher templates e2e/mock-servers node_modules package.json) |
  docker exec -i "$container" tar -xf - -C /opt/rehearsal/pkg
tar -C "$baseline" -cf - . | docker exec -i "$container" tar -xf - -C /opt/rehearsal/baseline-dist
"$repo/node_modules/.bin/esbuild" "$repo/e2e/mock-servers/telegram-mock.ts" --bundle --platform=node --format=esm --outfile="$output/telegram-mock.mjs"
docker cp "$output/telegram-mock.mjs" "$container:/opt/rehearsal/telegram-mock.mjs"
docker cp "$repo/scripts/manual/startup-memory/driver.py" "$container:/opt/rehearsal/driver.py"
git -C "$repo" rev-parse HEAD > "$output/revision"
docker cp "$output/revision" "$container:/opt/rehearsal/revision"
docker exec -e AGEND_STARTUP_MEMORY_REHEARSAL=1 "$container" python3 /opt/rehearsal/driver.py | tee "$output/driver.log"
