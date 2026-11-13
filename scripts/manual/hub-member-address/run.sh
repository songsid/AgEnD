#!/usr/bin/env bash
# Own source snapshot + loopback-only browser/Hub/member rehearsal. No systemd or host lifecycle.
set -euo pipefail
task_root="$(cd "$(dirname "$0")/../../.." && pwd)"
output_dir="${OUT:-$task_root/.artifacts/hub-member-address-3429}"
if [ -n "$(ls -A "$output_dir/container-evidence" 2>/dev/null)" ]; then echo "refused: $output_dir/container-evidence is not empty (use a fresh OUT)" >&2; exit 1; fi
mkdir -p "$output_dir/docker-config" "$output_dir/container-evidence" "$output_dir/node_modules"
# The executed source is exactly `git archive HEAD`: a modified or untracked file refuses the run (ALLOW_DIRTY=1 overlays
# them for a local try only; such a receipt lists every overlaid file and its digest and is never evidence).
base_ref="${BASE_REF:-$(git -C "$task_root" merge-base HEAD origin/release/2.3.5-alpha)}"
export task_root output_dir base_ref
python3 - <<'PY'
import hashlib,io,json,os,shutil,subprocess,tarfile
from pathlib import Path
root=Path(os.environ['task_root']);out=Path(os.environ['output_dir']);dest=out/'node_modules/container-source';base=os.environ['base_ref']
git=lambda *a:subprocess.check_output(['git',*a],cwd=root)
sha=lambda b:hashlib.sha256(b).hexdigest()
dirty=[n for n in git('ls-files','--modified','--others','--exclude-standard','-z').decode().split('\0') if n and (root/n).is_file()]
if dirty and os.environ.get('ALLOW_DIRTY')!='1':raise SystemExit('refused: modified or untracked files (the receipt must name exactly HEAD): '+' '.join(dirty[:8]))
if dest.exists():shutil.rmtree(dest)
dest.mkdir()
with tarfile.open(fileobj=io.BytesIO(git('archive','HEAD'))) as a:a.extractall(dest,filter='data')
for n in dirty:
 target=dest/n;target.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(root/n,target)
# The base's own UI modules, for the before and SKEW captures (served by route in place of this tree's).
BASE_UI=['src/ui/settings-hub-section.js','src/ui/settings-hub-connection.js','src/ui/hub-join-one-strings.js','src/ui/settings-confirm.js','src/ui/settings-hub-web-address.js','src/ui/shared/ui-states.js','src/ui/shared/app.css']
for n in BASE_UI:
 body=git('show',f'{base}:{n}');target=dest/'.base'/n;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(body)
(dest/'node_modules').mkdir(exist_ok=True)
nm=Path(os.path.realpath(root/'node_modules'))
inputs={'sourceHead':git('rev-parse','HEAD').decode().strip(),'sourceTree':git('rev-parse','HEAD^{tree}').decode().strip(),'baseRef':base,
 'script':{'path':'scripts/manual/hub-member-address/'+os.environ.get('SCRIPT','accept.mts'),'sha256':sha((root/'scripts/manual/hub-member-address'/os.environ.get('SCRIPT','accept.mts')).read_bytes())},
 'runSh':sha((root/'scripts/manual/hub-member-address/run.sh').read_bytes()),
 'packageLock':sha((root/'package-lock.json').read_bytes()),
 'installedDependencies':{'lockSha256':sha((nm/'.package-lock.json').read_bytes()),'note':'node_modules/.package-lock.json of the mounted (read-only) dependency tree'},
 'baseUi':[{'path':n,'sha256':sha((dest/'.base'/n).read_bytes())} for n in BASE_UI],
 'overlay':[{'path':n,'sha256':sha((root/n).read_bytes())} for n in dirty]}
(out/'inputs.json').write_text(json.dumps(inputs,indent=2))
PY
cat > "$output_dir/Dockerfile" <<'DOCKERFILE'
FROM node:22-bookworm-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d AS node22
FROM mcr.microsoft.com/playwright:v1.64.0-noble@sha256:06a9939e57531807f8d5fd76ce44b53165ffb7d7501d87ab10e285c20b1e971f
COPY --from=node22 /usr/local/bin/node /usr/local/bin/node
WORKDIR /work
DOCKERFILE
docker --config "$output_dir/docker-config" build --network none -t ridge-hub-member-address-3429-browser -f "$output_dir/Dockerfile" "$output_dir"
# No inherited Docker credentials, no network except the container's own loopback, no host write mounts.
docker --config "$output_dir/docker-config" run --rm --name ridge-hub-member-address-3429-rehearsal \
 --user "$(id -u):$(id -g)" --network none --cap-drop ALL --security-opt no-new-privileges \
 --read-only --tmpfs /tmp:rw,nosuid,nodev,size=512m --shm-size 256m \
 --mount "type=bind,src=$output_dir/node_modules/container-source,dst=/work,readonly" \
 --mount "type=bind,src=$(realpath "$task_root/node_modules"),dst=/work/node_modules,readonly" \
 --mount "type=bind,src=$output_dir/container-evidence,dst=/evidence" \
 -e AGEND_OWNED_CONTAINER=hub-member-address-3429 -e OUT=/evidence -e HOME=/tmp/home -e XDG_CACHE_HOME=/tmp/cache \
 ridge-hub-member-address-3429-browser node --import tsx "scripts/manual/hub-member-address/${SCRIPT:-accept.mts}"
# Bind the receipt to what ran: the inputs above, the image that ran it, and every picture's digest.
image_id="$(docker --config "$output_dir/docker-config" image inspect --format '{{.Id}}' ridge-hub-member-address-3429-browser)"
export image_id
python3 - <<'PY'
import hashlib,json,os
from pathlib import Path
out=Path(os.environ['output_dir']);ev=out/'container-evidence';r=json.loads((ev/'receipt.json').read_text())
r['inputs']=json.loads((out/'inputs.json').read_text())
r['inputs']['image']={'id':os.environ['image_id'],'dockerfile':hashlib.sha256((out/'Dockerfile').read_bytes()).hexdigest()}
r['artifacts']=sorted(({'path':str(p.relative_to(ev)),'sha256':hashlib.sha256(p.read_bytes()).hexdigest()} for p in ev.rglob('*.png')),key=lambda a:a['path'])
(ev/'receipt.json').write_text(json.dumps(r,indent=2))
print('receipt bound:',r['inputs']['sourceHead'],len(r['artifacts']),'pictures')
PY
