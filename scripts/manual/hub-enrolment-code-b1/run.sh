#!/usr/bin/env bash
# Own source snapshot + loopback-only browser/Hub/member rehearsal. No systemd or host lifecycle.
set -euo pipefail
case "${B1_LEG:-accept}" in accept|rollback) ;; *) exit 2 ;; esac
task_root="$(cd "$(dirname "$0")/../../.." && pwd)"
output_dir="${OUT:-$task_root/.artifacts/hub-enrolment-code-b1}"
mkdir -p "$output_dir/docker-config" "$output_dir/container-evidence" "$output_dir/node_modules"
export task_root output_dir
python3 - <<'PY'
import io,os,shutil,subprocess,tarfile
from pathlib import Path
root=Path(os.environ['task_root']);dest=Path(os.environ['output_dir'])/'node_modules/container-source'
if dest.exists():shutil.rmtree(dest)
dest.mkdir()
with tarfile.open(fileobj=io.BytesIO(subprocess.check_output(['git','archive','HEAD'],cwd=root))) as a:a.extractall(dest,filter='data')
for n in subprocess.check_output(['git','ls-files','--modified','--others','--exclude-standard','-z'],cwd=root).decode().split('\0'):
 if n and (root/n).is_file():
  target=dest/n;target.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(root/n,target)
(dest/'node_modules').mkdir(exist_ok=True)
legacy=Path(os.environ['output_dir'])/'node_modules/legacy-source'
if legacy.exists():shutil.rmtree(legacy)
legacy.mkdir()
with tarfile.open(fileobj=io.BytesIO(subprocess.check_output(['git','archive','d2440106a2805187eb50a13c2385144192261f9a','src','tests/support','tests/helpers','package.json','tsconfig.json','launcher'],cwd=root))) as a:a.extractall(legacy,filter='data')
(legacy/'node_modules').mkdir(exist_ok=True)

PY
cat > "$output_dir/Dockerfile" <<'DOCKERFILE'
FROM node:22-bookworm-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d AS node22
FROM mcr.microsoft.com/playwright:v1.64.0-noble@sha256:06a9939e57531807f8d5fd76ce44b53165ffb7d7501d87ab10e285c20b1e971f
COPY --from=node22 /usr/local/bin/node /usr/local/bin/node
WORKDIR /work
DOCKERFILE
docker --config "$output_dir/docker-config" build --network none -t ridge-hub-enrolment-code-b1-browser -f "$output_dir/Dockerfile" "$output_dir"
# No inherited Docker credentials, no network except the container's own loopback, no host write mounts.
docker --config "$output_dir/docker-config" run --rm --name ridge-hub-enrolment-code-b1-rehearsal \
 --user "$(id -u):$(id -g)" --network none --cap-drop ALL --security-opt no-new-privileges \
 --read-only --tmpfs /tmp:rw,nosuid,nodev,size=512m --shm-size 256m \
 --mount "type=bind,src=$output_dir/node_modules/container-source,dst=/work,readonly" \
 --mount "type=bind,src=$(realpath "$task_root/node_modules"),dst=/work/node_modules,readonly" \
 --mount "type=bind,src=$output_dir/container-evidence,dst=/evidence" \
 --mount "type=bind,src=$output_dir/node_modules/legacy-source,dst=/legacy,readonly" \
 --mount "type=bind,src=$(realpath "$task_root/node_modules"),dst=/legacy/node_modules,readonly" \
 -e B1_LEG="${B1_LEG:-accept}" -e SAFE_RUN=1 -e AGEND_OWNED_CONTAINER=hub-enrolment-code-b1 -e OUT=/evidence -e HOME=/tmp/home -e XDG_CACHE_HOME=/tmp/cache \
 ridge-hub-enrolment-code-b1-browser sh -c 'ln -s /work/node_modules /tmp/node_modules && ln -s /work/launcher /tmp/launcher && ln -s /work/package.json /tmp/package.json && node node_modules/@typescript/native/bin/tsc --outDir /tmp/b1-dist --declaration false --sourceMap false && cp -r /work/src/ui /tmp/b1-dist/ && node --import tsx scripts/manual/hub-enrolment-code-b1/${B1_LEG}.mts'
