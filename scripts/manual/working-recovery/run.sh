#!/usr/bin/env bash
# Packaged candidate; one private, hard-capped, networkless systemd container.
set -euo pipefail
repo=$(cd "$(dirname "$0")/../../.." && pwd)
free -m
test -f "$repo/dist/working-recovery.js"
mkdir -p "$repo/.artifacts"
output=$(mktemp -d "$repo/.artifacts/working-recovery-XXXXXX")
nonce=$(basename "$output")
container="sentinel-$nonce"
cleanup() {
  for evidence in results.json timeline.jsonl physical-input.jsonl telegram-calls.json final-unit.json outbox-snapshot.db scheduler-snapshot.db; do
    docker cp "$container:/opt/rehearsal/$evidence" "$output/$evidence" 2>/dev/null || true
  done
  for leg in manual main-oom boot-loop ambiguous; do
    docker cp "$container:/opt/rehearsal/$leg-journal.log" "$output/$leg-journal.log" 2>/dev/null || true
    docker cp "$container:/opt/rehearsal/$leg-daemon.log" "$output/$leg-daemon.log" 2>/dev/null || true
  done
  docker logs "$container" > "$output/container.log" 2>&1 || true
  if [ "$(docker inspect -f '{{index .Config.Labels "agend.working-recovery"}}' "$container" 2>/dev/null)" = "$nonce" ]; then
    docker rm -f "$container" > /dev/null
  fi
  echo "Evidence: $output"
}
trap cleanup EXIT
(cd "$repo" && npm pack --ignore-scripts --json --pack-destination "$output") > "$output/pack.json"
package=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))[0]["filename"])' "$output/pack.json")
sha256sum "$output/$package" > "$output/package.sha256"
docker run -d --privileged --cgroupns=private --memory=1536m --memory-swap=1536m --cpus=2 \
  --network=none --tmpfs /run --tmpfs /run/lock --label "agend.working-recovery=$nonce" \
  --name "$container" "${WORKING_RECOVERY_IMAGE:-agend-rh-b16-bus}" > "$output/container-id"
docker exec "$container" mkdir -p /opt/rehearsal/pkg
docker cp "$output/$package" "$container:/opt/rehearsal/candidate.tgz"
docker exec "$container" tar -xzf /opt/rehearsal/candidate.tgz --strip-components=1 -C /opt/rehearsal/pkg
# Dependencies and the mock fixture are local test assets, never downloaded in the container.
(cd "$repo" && tar -chf - node_modules e2e/mock-servers) | docker exec -i "$container" tar -xf - -C /opt/rehearsal/pkg
"$repo/node_modules/.bin/esbuild" "$repo/e2e/mock-servers/telegram-mock.ts" --bundle --platform=node --format=esm --outfile="$output/telegram-mock.mjs"
docker cp "$output/telegram-mock.mjs" "$container:/opt/rehearsal/telegram-mock.mjs"
docker cp "$repo/scripts/manual/working-recovery/driver.py" "$container:/opt/rehearsal/driver.py"
docker cp "$repo/scripts/manual/working-recovery/bootstrap.mjs" "$container:/opt/rehearsal/bootstrap.mjs"
git -C "$repo" rev-parse HEAD > "$output/revision"
git -C "$repo" diff --binary > "$output/uncommitted.patch"
docker cp "$output/revision" "$container:/opt/rehearsal/revision"
docker exec -e AGEND_WORKING_REHEARSAL=1 "$container" python3 /opt/rehearsal/driver.py | tee "$output/driver.log"
