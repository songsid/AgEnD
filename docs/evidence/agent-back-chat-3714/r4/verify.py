"""Verify original capture bindings, geometry and desktop comparison scope."""
from functools import lru_cache
from pathlib import Path
import hashlib, json, subprocess
from PIL import Image, ImageChops
root = Path(__file__).resolve().parents[4]
e = Path(__file__).resolve().parent
sha = lambda b: hashlib.sha256(b).hexdigest()
@lru_cache(maxsize=None)
def blob(ref, path):
    return subprocess.check_output(['git', 'show', ref + ':' + path], cwd=root)
result = dict(runs=0, inputs=0, assets=0, retained=0, checkpoints=0, pngs=0, desktopComparisons=[])
receipts = sorted((e / 'browser').glob('*/receipt.json'))
assert len(receipts) == 7
for p in receipts:
    r = json.loads(p.read_text())
    assert r['completed'] and not r['dirty'] and not r['errors'] and not r['effects'] and not r['external'] and not r.get('omitted'), p
    assert r['head'] == '1629f5c5808c75c488ca6e9194c17b3552239dd3'
    assert r['tree'] == subprocess.check_output(['git', 'rev-parse', r['head'] + '^{tree}'], cwd=root, text=True).strip()
    for digest, paths in r['inputs'].items():
        for path in paths:
            src = 'scripts/manual/smoke/smoke-agent-back-chat-phone-3714.mts' if path == 'harness' else path
            assert sha(blob(r['head'], src)) == digest, (p, path)
            assert sha((root / src).read_bytes()) == digest, (p, 'current source changed', path)
            result['inputs'] += 1
    for digest, paths in r['assets'].items():
        for path in paths:
            src = 'src/ui/shared/' + path[8:] if path.startswith('/assets/') else 'src/ui/' + path[7:]
            ref = r['oldRef'] if src in r['substitutions'].get(digest, []) else r['head']
            assert sha(blob(ref, src)) == digest, (p, path)
            result['assets'] += 1
    for paths in r['substitutions'].values():
        result['retained'] += len(paths)
    for case in r['cases']:
        if 'geometry' in case:
            assert not case['geometry']['overflow'] and case['geometry']['streams'] == dict(active=1, max=1)
            if r['phone']:
                assert all(b['width'] >= 44 and b['height'] >= 44 for b in case['geometry']['buttons'] if b['visible'])
        if case['label'] == 'single-phone-heading':
            h = case['value']; assert len(h['titles']) == 1 and h['oldSectionLabels'] == 0
            assert abs(h['title']['center'] - h['close']['center']) < 1
            if h['back']:
                assert h['back']['width'] >= 44 and h['back']['height'] >= 44
                assert abs(h['back']['center'] - h['close']['center']) < 1
    if r['phone'] and not r['retain']:
        assert sum(c['label'] == 'single-phone-heading' for c in r['cases']) == 2
    result['runs'] += 1; result['checkpoints'] += len(r['cases'])
    result['pngs'] += len(list(p.parent.glob('*.png')))
for theme in ['light', 'dark']:
    old = root / 'docs/evidence/agent-back-chat-3714/r3/browser' / f'after-desktop-{theme}-zh-TW'
    new = e / 'browser' / f'desktop-{theme}-zh-TW'
    before_cases = {c['label']: c for c in json.loads((old / 'receipt.json').read_text())['cases']}
    after_cases = {c['label']: c for c in json.loads((new / 'receipt.json').read_text())['cases']}
    for name in ['settings', 'split-settings']:
        assert before_cases[name]['geometry']['buttons'] == after_cases[name]['geometry']['buttons']
        filename = f'{theme}-zh-TW-{name}.png'
        a = Image.open(old / filename).convert('RGB'); b = Image.open(new / filename).convert('RGB')
        assert a.size == b.size
        diff = ImageChops.difference(a, b)
        pixels = sum(px != (0, 0, 0) for px in diff.getdata())
        result['desktopComparisons'].append(dict(file=filename, changedPixels=pixels))
assert result == json.loads((e / 'browser-verification.json').read_text())
manifest = e / 'manifest.json'
if manifest.exists():
    for digest, paths in json.loads(manifest.read_text()).items():
        for path in paths:
            assert sha((e / path).read_bytes()) == digest, path
print(json.dumps(result))
