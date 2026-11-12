#!/usr/bin/env bash
# PREPARE ONLY until a separately delivered, verified Leader GO. No operation runs by default.
set -euo pipefail
root="$(cd "$(dirname "$0")/../../.." && pwd)"
if [[ $# -eq 0 || ${1:-} == --help ]]; then
  echo 'Usage: run.sh --plan | --run <verified-go-plan.json>'
  exit 0
fi
if [[ ${1:-} == --plan && $# -eq 1 ]]; then
  node --input-type=module - "$root" <<'JS'
import {execFileSync} from 'node:child_process';
console.log(JSON.stringify({explicitGo:false,goReference:'PENDING explicit GO after alpha.15 rehearsal',source:execFileSync('git',['rev-parse','HEAD'],{cwd:process.argv[2],encoding:'utf8'}).trim(),from:null,until:null,version:'2.3.5-alpha.16'},null,2));
JS
  exit 0
fi
[[ ${1:-} == --run && $# -eq 2 ]] || { echo 'Refused: use --plan or an explicit --run plan' >&2; exit 2; }
plan="$(realpath "$2")"
sha="$(git -C "$root" rev-parse HEAD)"
node --input-type=module - "$root" "$plan" "$sha" <<'JS'
import {readFileSync} from 'node:fs';
const {requireWindow}=await import(process.argv[2]+'/scripts/manual/hub-enrolment-code-campaign/guard.mjs');
requireWindow(JSON.parse(readFileSync(process.argv[3],'utf8')),process.argv[4],Date.now());
JS
uptime
free -m
node --input-type=module - "$root" <<'JS'
const {hostSample}=await import(process.argv[2]+'/scripts/manual/hub-enrolment-code-campaign/host-watch.mjs');
const {requireHostBudget}=await import(process.argv[2]+'/scripts/manual/hub-enrolment-code-campaign/guard.mjs');
const sample=hostSample();requireHostBudget(sample.load1,sample.availableMiB);console.log(JSON.stringify({hostPreflight:sample}));
JS
git -C "$root" diff --exit-code --quiet
git -C "$root" diff --cached --exit-code --quiet
# A private per-attempt lock and CID ensure cleanup can never stop a pre-existing container.
base="$root/.artifacts/hub-enrolment-code-campaign"
mkdir -p "$base"
nonce="$(node -e 'process.stdout.write(require("node:crypto").randomUUID())')"
out="$base/$nonce"
mkdir "$base/ACTIVE" || { echo 'Another owned campaign is active' >&2; exit 2; }
watch_pid=""
cleanup() {
  if [[ -s "$out/cid" ]]; then
    local cid label
    cid="$(cat "$out/cid")"
    label="$(docker --config "$out/docker-config" inspect --format '{{index .Config.Labels "agend.owned-campaign"}}' "$cid" 2>/dev/null || true)"
    if [[ $label == "$nonce" ]]; then docker --config "$out/docker-config" stop --time 10 "$cid" >/dev/null 2>&1 || true; fi
  fi
  if [[ -n "$watch_pid" ]]; then touch "$out/control/WATCH_DONE"; wait "$watch_pid" || true; fi
  local image_label
  image_label="$(docker --config "$out/docker-config" image inspect --format '{{index .Config.Labels "agend.owned-campaign"}}' "ridge-code-campaign:$nonce" 2>/dev/null || true)"
  if [[ $image_label == "$nonce" ]]; then docker --config "$out/docker-config" image rm "ridge-code-campaign:$nonce" >/dev/null 2>&1 || true; fi
  rm -f "$base/ACTIVE/output"
  rmdir "$base/ACTIVE" 2>/dev/null || true
}
trap cleanup EXIT
trap 'touch "$out/control/STOP"; exit 130' INT TERM
mkdir -p "$out/control" "$out/evidence" "$out/docker-config" "$out/source" "$out/legacy"
cp "$plan" "$out/control/plan.json"
node "$root/scripts/manual/hub-enrolment-code-campaign/host-watch.mjs" "$out" &
watch_pid=$!
printf '%s\n' "$out" > "$base/ACTIVE/output"
# Only committed, exact-source bytes; neither another worktree nor an uncommitted mutation enters this snapshot.
git -C "$root" archive "$sha" | tar -x -C "$out/source"
legacy=d2440106a2805187eb50a13c2385144192261f9a
git -C "$root" archive "$legacy" src tests/support tests/helpers package.json tsconfig.json launcher | tar -x -C "$out/legacy"
mkdir -p "$out/source/node_modules" "$out/legacy/node_modules"
mkdir -p "$out/build-context"
cp "$out/source/scripts/manual/hub-enrolment-code-campaign/Dockerfile" "$out/build-context/Dockerfile"
export source_sha="$sha" output_root="$out"
python3 - <<'PY'
import hashlib,json,os
from pathlib import Path
root=Path(os.environ['output_root']);source=root/'source'
files={str(p.relative_to(source)):hashlib.sha256(p.read_bytes()).hexdigest() for p in source.rglob('*') if p.is_file()}
(root/'evidence'/'source.json').write_text(json.dumps({'sha':os.environ['source_sha'],'legacy':'d2440106a2805187eb50a13c2385144192261f9a','files':files},indent=2)+'\n')
PY
# No image pulls or package installs. Pinned base images must already be cached.
docker --config "$out/docker-config" image inspect node:22-bookworm-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d >/dev/null
docker --config "$out/docker-config" image inspect mcr.microsoft.com/playwright:v1.64.0-noble@sha256:06a9939e57531807f8d5fd76ce44b53165ffb7d7501d87ab10e285c20b1e971f >/dev/null
docker --config "$out/docker-config" build --network none --label "agend.owned-campaign=$nonce" -t "ridge-code-campaign:$nonce" -f "$out/build-context/Dockerfile" "$out/build-context"
# Stop before container start if the allocated time expired while preparing/building.
node --input-type=module - "$root" "$plan" "$sha" "$out/control/STOP" <<'JS'
import {readFileSync,existsSync} from 'node:fs';
const {requireWindow,requireHostBudget}=await import(process.argv[2]+'/scripts/manual/hub-enrolment-code-campaign/guard.mjs');
const {hostSample}=await import(process.argv[2]+'/scripts/manual/hub-enrolment-code-campaign/host-watch.mjs');
requireWindow(JSON.parse(readFileSync(process.argv[3],'utf8')),process.argv[4],Date.now(),existsSync(process.argv[5]));
const sample=hostSample();requireHostBudget(sample.load1,sample.availableMiB);
JS
docker --config "$out/docker-config" run --rm --name "ridge-code-$nonce" --cidfile "$out/cid" \
 --label "agend.owned-campaign=$nonce" --user "$(id -u):$(id -g)" --network none \
 --cap-drop ALL --security-opt no-new-privileges --read-only --memory 3g --memory-swap 3g --cpus 2 --pids-limit 256 \
 --tmpfs /tmp:rw,nosuid,nodev,size=1536m --shm-size 256m \
 --mount "type=bind,src=$out/source,dst=/work,readonly" \
 --mount "type=bind,src=$(realpath "$root/node_modules"),dst=/work/node_modules,readonly" \
 --mount "type=bind,src=$out/legacy,dst=/legacy,readonly" \
 --mount "type=bind,src=$(realpath "$root/node_modules"),dst=/legacy/node_modules,readonly" \
 --mount "type=bind,src=$out/control,dst=/control,readonly" --mount "type=bind,src=$out/evidence,dst=/evidence" \
 -e SAFE_RUN=1 -e AGEND_OWNED_CONTAINER=hub-enrolment-code-campaign -e CAMPAIGN_SHA="$sha" \
 -e REPO=/work -e OUT=/evidence -e HOME=/tmp/home -e AGEND_HOME=/tmp/home -e XDG_CACHE_HOME=/tmp/cache \
 "ridge-code-campaign:$nonce" node --import tsx scripts/manual/hub-enrolment-code-campaign/entry.mts
# All data remains private until reviewed. STOP is operator-controlled and can be touched as soon as overlap is reported.
echo "Campaign receipt: $out/evidence/receipt.json"
