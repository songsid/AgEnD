"""Verify published hashes and bounded assertions; never runs a CLI or makes network requests."""
from pathlib import Path
import hashlib,json
root=Path(__file__).resolve().parent.parent
manifest=json.loads((root/'manifest.json').read_text())
count=0
for digest,paths in manifest['files'].items():
 for name in paths:
  path=root/name
  assert path.is_file(),name
  assert hashlib.sha256(path.read_bytes()).hexdigest()==digest,name
  count+=1
for cli,levels in [('codex',['low','high']),('opencode',['low','high']),('muse',['low','max'])]:
 rows=json.loads((root/cli/(cli+'-live-proof.json')).read_text())
 actual=[x['reasoning_effort'] if cli=='opencode' else x['wire']['effort'] for x in rows]
 assert actual==levels,(cli,actual)
 if cli=='muse':assert len({x['panePid'] for x in rows})==1
 else:assert len({x['children'] for x in rows})==1
assert len(json.loads((root/'codex/codex-model-levels.json').read_text()))==12
models=json.loads((root/'opencode/opencode-bundled-model-variants.json').read_text())
assert len(models)==140 and sum(bool(x['variants']) for x in models)==109
assert json.loads((root/'catalog-search.json').read_text())['vendorAccountCalls']==0
cleanup=json.loads((root/'cleanup.json').read_text())
assert cleanup['ownedRunningAfter']==[] and cleanup['tmuxAfterExitCode']!=0
print(f'PASS: {count} file digests; 3 unchanged-process wire controls; 12/140 model metadata; catalog limits; physical cleanup')
