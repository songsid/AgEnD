"""Bind the bounded before/current/retained UI matrix to captured Git objects."""
import hashlib
import json
import pathlib
import subprocess
import sys
from functools import lru_cache

root = pathlib.Path(__file__).resolve().parents[2]
evidence = root / 'docs/evidence/agent-back-chat-3714'
sha = lambda value: hashlib.sha256(value).hexdigest()

@lru_cache(maxsize=None)
def blob(ref, path):
    return subprocess.check_output(['git', 'show', f'{ref}:{path}'], cwd=root)

def source(path):
    if path.startswith('/assets/'):
        return 'src/ui/shared/' + path[8:]
    if path.startswith('/ui/js/'):
        return 'src/ui/' + path[7:]
    raise AssertionError(path)

expected = {f'{kind}-{device}-{theme}-{lang}' for kind in ['before', 'after']
            for device in ['desktop', 'phone'] for theme in ['light', 'dark'] for lang in ['en', 'zh-TW']}
expected |= {'skew-' + name for name in ['sidebar', 'details', 'workspace', 'popup']}
receipts = sorted((evidence / 'browser').glob('*/receipt.json'))
assert {p.parent.name for p in receipts} == expected, 'incomplete browser matrix'
result = dict(runs=0, inputs=0, assets=0, retained=0, checkpoints=0, pngs=0)
for p in receipts:
    r = json.loads(p.read_text())
    assert r['completed'] and not r['dirty'], p
    assert r['tree'] == subprocess.check_output(['git', 'rev-parse', r['head'] + '^{tree}'], cwd=root, text=True).strip(), p
    for digest, paths in r['inputs'].items():
        for path in paths:
            path = 'scripts/manual/smoke/smoke-agent-back-chat-3714.mts' if path == 'harness' else path
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
    screenshots = [case for case in r['cases'] if 'file' in case]
    assert {case['file'] for case in screenshots} == {x.name for x in p.parent.glob('*.png')}, p
    assert not r['errors'] and not r['effects'] and not r['external'] and not r.get('omitted'), p
    assert all(path == '/api/settings/status-emojis/preview' for path in r['previews']), p
    for case in screenshots:
        assert (p.parent / case['file']).read_bytes().startswith(b'\x89PNG\r\n\x1a\n'), p
        assert not case['geometry']['overflow'], p
        assert case['geometry']['streams'] == dict(active=1, max=1), p
        if r['phone'] and not r['retain']:
            assert all(b['width'] >= 44 and b['height'] >= 44 for b in case['geometry']['buttons'] if b['visible']), p
    if not r['retain']:
        labels = {case['label'] for case in r['cases']}
        assert {'native-enter', 'second-click', 'cancel-preserves-draft', 'returned-chat'} <= labels, p
        if not r['phone']:
            assert {'split-back', 'split-settings', 'split-returned-chat'} <= labels, p
    result['runs'] += 1
    result['checkpoints'] += len(r['cases'])
    result['pngs'] += len(screenshots)
print(json.dumps(result, indent=2))
if len(sys.argv) > 1:
    pathlib.Path(sys.argv[1]).write_text(json.dumps(result, indent=2) + '\n')
