#!/usr/bin/env python3
"""Owned inert regression reversals; run without other tests/writers in this checkout."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys

root = Path(__file__).resolve().parents[3]
source = root / 'src/hub/settings-directory-save.ts'
original = source.read_bytes()
text = original.decode()
out = root / '.artifacts/hub-directory-save-refusal'
out.mkdir(parents=True, exist_ok=True)
mutations = [
    ('no-refusal-response', [('if (response && expected !== undefined) {', 'if (response && expected !== undefined && false) {')]),
    ('foreign-participant', [('current() && decision.hubId === deps.hubId && same(decision.inspect(), expected)', 'current() && same(decision.inspect(), expected)')]),
    ('unbounded-error', [('const bounded = refusal(error);', 'const bounded = { status: 503, code: String(error) };')]),
    ('final-response-fence', [('}, unchanged);', '}, () => true);')]),
    ('packet-builder-fence', [('if (!unchanged()) fail("revoked");', '// reversed final packet fence')]),
    # The individual comparisons overlap; reverse the composite promise, not an allegedly independent guard.
    ('both-stamp-comparisons', [
        ('expected !== undefined && same(old.decision.inspect(), expected)', 'expected !== undefined'),
        ('current() && decision.hubId === deps.hubId && same(decision.inspect(), expected)', 'current() && decision.hubId === deps.hubId'),
    ]),
]
selected = set(sys.argv[1:])
if selected and selected - {name for name, _ in mutations}:
    raise RuntimeError('unknown reversal name')
rows = []
try:
    for name, edits in mutations:
        if selected and name not in selected:
            continue
        changed = text
        for old, new in edits:
            if changed.count(old) != 1:
                raise RuntimeError(f'{name}: expected one source pattern')
            changed = changed.replace(old, new)
        source.write_text(changed)
        result_file = out / f'{name}.json'
        with (out / f'{name}.log').open('w') as log:
            run = subprocess.run(['npx', 'vitest', 'run', 'tests/hub-directory-save.test.ts', '-t', 'captured pre-decision',
                                  '--reporter=json', f'--outputFile={result_file}'], cwd=root, stdout=log, stderr=subprocess.STDOUT)
        report = json.loads(result_file.read_text())
        row = {'name': name, 'exit': run.returncode, 'passed': report['numPassedTests'], 'failed': report['numFailedTests'],
               'deselected': report['numPendingTests']}
        rows.append(row)
        print(json.dumps(row), flush=True)
        if run.returncode == 0 or row['failed'] == 0:
            raise RuntimeError(f'{name}: reversal was not assertion-caught')
finally:
    source.write_bytes(original)
    receipt = {'baseline': {hashlib.sha256(original).hexdigest(): 'src/hub/settings-directory-save.ts'},
               'rows': rows, 'restored': source.read_bytes() == original}
    suffix = '-' + '-'.join(sorted(selected)) if selected else ''
    (out / f'mutations{suffix}.json').write_text(json.dumps(receipt, indent=2) + '\n')
