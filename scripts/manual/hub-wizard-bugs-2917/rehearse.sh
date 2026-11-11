#!/usr/bin/env bash
# Own disposable container only: no host mounts, published ports, privileged flags, systemd or external network.
set -euo pipefail
repo=$(git rev-parse --show-toplevel)
cd "$repo"
base=${WIZARD_BASE:-9c98307c938b77d8eaaebf5bcd3f20c5c27dce6f}
image=${WIZARD_IMAGE:-agend-rh-b16-bus-nobinfmt}
out=${1:-$repo/.artifacts/wizard-2917/pinned-rehearsal}
mkdir -p "$out"
out=$(realpath "$out")
scratch=$(mktemp -d /tmp/agend-wizard-2917.XXXXXX)
container="cairn-wizard-2917-$(basename "$scratch" | tr '[:upper:]' '[:lower:]')"
cleanup() {
  docker rm -f "$container" > "$out/container-cleanup.log" 2>&1 || true
  rm -rf "$scratch"
}
trap cleanup EXIT
python3 - "$out/host-before.json" <<'PY'
import json,os,sys
from pathlib import Path
Path(sys.argv[1]).write_text(json.dumps({'netns':os.readlink('/proc/self/ns/net'),'binfmt':sorted(os.listdir('/proc/sys/fs/binfmt_misc')))}))
PY
mkdir "$scratch/base"
git archive "$base" | tar -x -C "$scratch/base"
ln -s "$repo/node_modules" "$scratch/base/node_modules"
(cd "$scratch/base" && npm run build) > "$out/build-base.log" 2>&1
npm run build > "$out/build-candidate.log" 2>&1
python3 - "$out/inputs.json" "$scratch/base/dist" "$base" "$image" <<'PY'
import hashlib,json,subprocess,sys
from pathlib import Path
out,dist,base,image=sys.argv[1:]
def git(*args):return subprocess.check_output(['git',*args],text=True).strip()
def digesttree(root):
 rows=[(str(p.relative_to(root)),hashlib.sha256(p.read_bytes()).hexdigest()) for p in sorted(root.rglob('*')) if p.is_file()]
 return {'files':len(rows),'bindings':{hashlib.sha256(''.join(p+'\0'+d+'\n' for p,d in rows).encode()).hexdigest():['dist/']}}
files=['src/hub/init/wizard.ts','src/hub/init/prompt.ts','src/hub/init/text.ts','tests/hub-init-setup-bugs-2917.test.ts']+list(map(str,sorted(Path('scripts/manual/hub-wizard-bugs-2917').glob('*'))))
bindings={}
for f in files:bindings.setdefault(hashlib.sha256(Path(f).read_bytes()).hexdigest(),[]).append(f)
data={'baselineCommit':base,'candidateCommit':git('rev-parse','HEAD'),'candidateTree':git('rev-parse','HEAD^{tree}'),'trackedDirty':bool(git('status','--porcelain','--untracked-files=no')),'inputs':bindings,'baselineArtifacts':digesttree(Path(dist)),'candidateArtifacts':digesttree(Path('dist')),'imageId':subprocess.check_output(['docker','image','inspect',image,'--format','{{.Id}}'],text=True).strip()}
Path(out).write_text(json.dumps(data,indent=2)+'\n')
PY
docker run -d --name "$container" --network none --memory=2g --memory-swap=2g \
  --add-host hub.example.test:127.0.0.1 --add-host ad.example.test:127.0.0.1 \
  --add-host directory.example.test:127.0.0.1 --entrypoint /bin/sleep "$image" 3600 > "$out/container-created.log"
docker exec "$container" bash -c 'useradd -m -s /bin/bash wizard; chmod 700 /home/wizard; mkdir -p /opt/base /opt/candidate /opt/rh'
docker cp "$scratch/base/dist" "$container:/opt/base/dist"
docker cp "$repo/dist" "$container:/opt/candidate/dist"
for tree in base candidate; do
 docker cp "$repo/package.json" "$container:/opt/$tree/package.json"
 docker cp "$repo/launcher" "$container:/opt/$tree/launcher"
done
docker cp -L "$repo/node_modules" "$container:/opt/node_modules"
docker cp scripts/manual/hub-wizard-bugs-2917/setup.sh "$container:/opt/rh/setup.sh"
docker cp scripts/manual/hub-wizard-bugs-2917/fake-directory.mjs "$container:/opt/rh/fake-directory.mjs"
docker exec "$container" bash /opt/rh/setup.sh > "$out/setup.log" 2>&1
# Compare every compiled file in the container to the artifacts bound above, before the first PTY.
docker exec -i "$container" python3 - > "$out/container-artifacts.json" <<'PY'
import hashlib,json
from pathlib import Path
def digesttree(root):
 rows=[(str(p.relative_to(root)),hashlib.sha256(p.read_bytes()).hexdigest()) for p in sorted(root.rglob('*')) if p.is_file()]
 return {'files':len(rows),'bindings':{hashlib.sha256(''.join(p+'\0'+d+'\n' for p,d in rows).encode()).hexdigest():['dist/']}}
print(json.dumps({t:digesttree(Path('/opt')/t/'dist') for t in ['base','candidate']},indent=2))
PY
python3 - "$out" <<'PY'
import json,sys
from pathlib import Path
p=Path(sys.argv[1]);inputs=json.loads((p/'inputs.json').read_text());installed=json.loads((p/'container-artifacts.json').read_text())
assert installed['base']==inputs['baselineArtifacts'];assert installed['candidate']==inputs['candidateArtifacts']
PY
for tree in base candidate; do
 for locale in en zh-TW; do
  python3 scripts/manual/hub-wizard-bugs-2917/pty-wizard.py --container "$container" --tree "$tree" --locale "$locale" --out "$out/$tree-$locale" > "$out/$tree-$locale.log" 2>&1
 done
done
docker exec "$container" node --version > "$out/node-version.txt"
docker exec "$container" cat /etc/os-release > "$out/os-release.txt"
docker exec "$container" cat /opt/fixture/ad.log > "$out/fake-directory.log"
python3 - "$out" <<'PY'
import json,os,sys
from pathlib import Path
p=Path(sys.argv[1]);after={'netns':os.readlink('/proc/self/ns/net'),'binfmt':sorted(os.listdir('/proc/sys/fs/binfmt_misc'))}
assert after==json.loads((p/'host-before.json').read_text());(p/'host-after.json').write_text(json.dumps(after)+'\n')
rows=[json.loads((p/(t+'-'+l)/'receipt.json').read_text()) for t in ['base','candidate'] for l in ['en','zh-TW']]
assert all(len(r['cases'])==5 for r in rows)
(p/'summary.json').write_text(json.dumps({'journeys':rows,'cases':sum(len(r['cases']) for r in rows),'hostNamespacesUnchanged':True},indent=2)+'\n')
print('PASS: 20 PTY cases, baseline/candidate EN/zh-TW; host binfmt/netns unchanged')
PY
