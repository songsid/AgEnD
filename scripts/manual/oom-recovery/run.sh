#!/usr/bin/env bash
# Private Docker/systemd-only rehearsal. Never runs an AgEnD CLI on the host.
set -euo pipefail
repo=$(cd "$(dirname "$0")/../../.." && pwd)
mkdir -p "$repo/.artifacts"
output=$(mktemp -d "$repo/.artifacts/oom-rehearsal-XXXXXX")
nonce=$(basename "$output")
container="sentinel-$nonce"
image=${OOM_REHEARSAL_IMAGE:-agend-rh-b16-bus}
cleanup() {
  docker cp "$container:/opt/rehearsal/results.json" "$output/results.json" 2>/dev/null || true
  docker cp "$container:/opt/rehearsal/guard-tests.log" "$output/guard-tests.log" 2>/dev/null || true
  docker cp "$container:/opt/rehearsal/native-tests.log" "$output/native-tests.log" 2>/dev/null || true
  docker cp "$container:/opt/rehearsal/journal.log" "$output/journal.log" 2>/dev/null || true
  docker cp "$container:/home/rh/oom/home/daemon.log" "$output/daemon.log" 2>/dev/null || true
  for evidence in telegram-calls.json final-unit.json telegram.log; do
    docker cp "$container:/opt/rehearsal/$evidence" "$output/$evidence" 2>/dev/null || true
  done
  docker logs "$container" > "$output/container.log" 2>&1 || true
  if [ "$(docker inspect -f '{{index .Config.Labels "agend.oom-rehearsal"}}' "$container" 2>/dev/null)" = "$nonce" ]; then
    docker rm -f "$container" > /dev/null
  fi
  echo "Evidence: $output"
}
trap cleanup EXIT
# The outer cap and zero swap contain even a misconfigured inner unit. Private
# PID/cgroup/network namespaces; no host mounts, account/provider or npm traffic.
docker run -d --privileged --cgroupns=private --memory=1536m --memory-swap=1536m --cpus=2 \
  --network=none --tmpfs /run --tmpfs /run/lock --label "agend.oom-rehearsal=$nonce" \
  --name "$container" "$image" > "$output/container-id"
docker exec "$container" mkdir -p /opt/rehearsal/pkg
# Build beforehand in a capped unit; copy only this checkout's assets/deps.
(cd "$repo" && tar -chf - dist src launcher templates e2e/mock-servers node_modules package.json vitest.config.ts vitest.config.integration.ts tsconfig.json tests/session-oom-stop-2035.test.ts tests/oom-policy-loaded-2015.test.ts tests/child-stdio-errors-2374.test.ts tests/tmux-manager.test.ts tests/tmux-control-native-1401.test.ts tests/setup-process-guard.ts tests/setup-process-guard-global.ts tests/support) |
  docker exec -i "$container" tar -xf - -C /opt/rehearsal/pkg
"$repo/node_modules/.bin/esbuild" "$repo/e2e/mock-servers/telegram-mock.ts" --bundle --platform=node --format=esm --outfile="$output/telegram-mock.mjs"
docker cp "$output/telegram-mock.mjs" "$container:/opt/rehearsal/telegram-mock.mjs"
docker cp "$repo/scripts/manual/oom-recovery/driver.py" "$container:/opt/rehearsal/driver.py"
git -C "$repo" rev-parse HEAD > "$output/revision"
docker cp "$output/revision" "$container:/opt/rehearsal/revision"
docker exec -e AGEND_OOM_REHEARSAL=1 "$container" python3 /opt/rehearsal/driver.py | tee "$output/driver.log"
