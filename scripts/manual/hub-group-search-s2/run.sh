#!/usr/bin/env bash
set -euo pipefail
task_root="$(cd "$(dirname "$0")/../../.." && pwd)"
output_dir="${OUT:-$task_root/.artifacts/hub-group-search-s2}"
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
PY
cat > "$output_dir/Dockerfile" <<'DOCKERFILE'
FROM node:22-bookworm-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d AS node22
FROM mcr.microsoft.com/playwright:v1.64.0-noble@sha256:06a9939e57531807f8d5fd76ce44b53165ffb7d7501d87ab10e285c20b1e971f
COPY --from=node22 /usr/local/bin/node /usr/local/bin/node
WORKDIR /work
DOCKERFILE
docker --config "$output_dir/docker-config" build --network none -t ridge-hub-group-search-s2 -f "$output_dir/Dockerfile" "$output_dir"
docker --config "$output_dir/docker-config" run --rm --name ridge-hub-group-search-s2 \
 --user "$(id -u):$(id -g)" --network none --cap-drop ALL --security-opt no-new-privileges \
 --read-only --tmpfs /tmp:rw,nosuid,nodev,size=256m \
 --mount "type=bind,src=$output_dir/node_modules/container-source,dst=/work,readonly" \
 --mount "type=bind,src=$(realpath "$task_root/node_modules"),dst=/work/node_modules,readonly" \
 --mount "type=bind,src=$output_dir/container-evidence,dst=/evidence" \
 -e SAFE_RUN=1 -e AGEND_OWNED_CONTAINER=hub-group-search-s2 -e OUT=/evidence -e HOME=/tmp/home -e AGEND_HOME=/tmp/agend \
 ridge-hub-group-search-s2 node --import tsx scripts/manual/hub-group-search-s2/accept.mts
