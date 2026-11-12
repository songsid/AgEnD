"""Verify exact capture inputs, served current/retained assets and screenshot inventory."""
import hashlib
import json
import pathlib
import subprocess
import sys
from functools import lru_cache

root = pathlib.Path(__file__).resolve().parents[2]
evidence = root / 'docs/evidence/chat-menus-m2959'
sha = lambda b: hashlib.sha256(b).hexdigest()

@lru_cache(maxsize=None)
def blob(ref, path):
    return subprocess.check_output(['git', 'show', f'{ref}:{path}'], cwd=root)

def source(path):
    if path.startswith('/assets/'):
        return 'src/ui/shared/' + path[8:]
    if path.startswith('/ui/js/'):
        return 'src/ui/' + path[7:]
    raise AssertionError(path)

result = {'runs': 0, 'inputs': 0, 'assets': 0, 'retained': 0, 'checkpoints': 0, 'pngs': 0}
for p in sorted((evidence / 'browser').glob('*/receipt.json')):
    r = json.loads(p.read_text())
    assert not r['dirty'], p
    assert r['tree'] == subprocess.check_output(['git', 'rev-parse', r['head'] + '^{tree}'], cwd=root, text=True).strip(), p
    for digest, paths in r['inputs'].items():
        for path in paths:
            path = 'scripts/manual/smoke/smoke-chat-menus-2959.mts' if path == 'harness' else path
            assert sha(blob(r['head'], path)) == digest, (p, path)
            assert sha((root / path).read_bytes()) == digest, (p, 'input changed', path)
            result['inputs'] += 1
    for digest, paths in r['substitutions'].items():
        for path in paths:
            assert sha(blob(r['oldRef'], path)) == digest, (p, path)
            result['retained'] += 1
    for digest, paths in r['assets'].items():
        for path in paths:
            src = source(path)
            assert sha(blob(r['head'], src)) == digest or src in r['substitutions'].get(digest, []), (p, path)
            result['assets'] += 1
    for case in r['cases']:
        if 'file' in case:
            assert (p.parent / case['file']).is_file(), (p, case['file'])
    assert not r['errors'] and not r['effects'] and not r['external'], p
    assert all(keys == ['nav.favorites'] for keys in r['preferences']), p
    result['runs'] += 1
    result['checkpoints'] += len(r['cases'])
    result['pngs'] += len(list(p.parent.glob('*.png')))
assert result['runs'] > 0 and result['pngs'] > 0, 'no capture evidence'
print(json.dumps(result, indent=2))
if len(sys.argv) > 1:
    pathlib.Path(sys.argv[1]).write_text(json.dumps(result, indent=2) + '\n')
