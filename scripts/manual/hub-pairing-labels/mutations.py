#!/usr/bin/env python3
"""Reverse each corrected label; restore source after each assertion probe."""
import json
from pathlib import Path
import subprocess

root = Path(__file__).resolve().parents[3]
out = root / '.artifacts/hub-labels/mutations'
out.mkdir(parents=True, exist_ok=True)
cases = [
    ('quick-en-address', 'hub-quick-strings.js', 'address: "Hub address"', 'address: "Member address"'),
    ('quick-zh-address', 'hub-quick-strings.js', 'address: "Hub 位址"', 'address: "成員位址"'),
    ('compare-en-card', 'hub-quick-strings.js', '→ Waiting for approval.', '→ pending pairing.'),
    ('compare-zh-card', 'hub-quick-strings.js', '→ 等待核准」', '→ 等待配對」'),
    ('admin-en-address', 'hub-owner-strings.js', 'memberAddress: "Hub address"', 'memberAddress: "Member address"'),
    ('admin-zh-address', 'hub-owner-strings.js', 'memberAddress: "Hub 位址"', 'memberAddress: "成員連線位址"'),
]
results = []
for name, file, before, after in cases:
    path = root / 'src/ui' / file
    original = path.read_bytes()
    report = out / (name + '.json')
    try:
        text = original.decode()
        assert text.count(before) == 1
        path.write_text(text.replace(before, after))
        run = subprocess.run(['npx', 'vitest', 'run', 'tests/hub-pairing-labels.test.ts', '--reporter=json', '--outputFile=' + str(report)], cwd=root, capture_output=True, text=True)
        (out / (name + '.log')).write_text(run.stdout + run.stderr)
        data = json.loads(report.read_text()) if report.exists() else {}
        failures = [a['fullName'] for s in data.get('testResults', []) for a in s.get('assertionResults', []) if a['status'] == 'failed']
        killed = run.returncode != 0 and data.get('numTotalTests') == 12 and bool(failures)
        results.append({'name': name, 'killed': killed, 'failures': failures})
        print(name, 'KILLED' if killed else 'SURVIVED/INVALID', flush=True)
    finally:
        path.write_bytes(original)
(out / 'summary.json').write_text(json.dumps(results, indent=2))
assert len(results) == len(cases) and all(r['killed'] for r in results)
