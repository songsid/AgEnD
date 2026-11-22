#!/usr/bin/env python3
"""Reject known affected image blobs, including copies under different paths.
This is a duplicate/remediation guard, not a replacement for visual review.
"""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess

p = argparse.ArgumentParser(description=__doc__)
p.add_argument('--known', required=True, type=Path)
p.add_argument('--ref', help='Read a Git tree instead of the working files')
p.add_argument('--report', type=Path)
a = p.parse_args()
known = set(json.loads(a.known.read_text())['blobs'])
if not known:
    raise SystemExit('empty known-affected set')
images = []
if a.ref:
    tree = subprocess.check_output(['git', 'ls-tree', '-r', a.ref, 'docs/evidence'], text=True)
    for line in tree.splitlines():
        fields, path = line.split('\t', 1)
        if path.lower().endswith('.png'):
            images.append((path, fields.split()[2]))
else:
    for path in sorted(Path('docs/evidence').rglob('*.png')):
        data = path.read_bytes()
        blob = hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest()
        images.append((str(path), blob))
if not images:
    raise SystemExit('no PNG images checked')
hits = [path for path, blob in images if blob in known]
result = {'checked_png_paths': len(images), 'known_affected_blobs': len(known),
          'remaining_affected_paths': hits,
          'scope': 'Known-blob duplicate/remediation guard only; visual review is separate.'}
if a.report:
    a.report.parent.mkdir(parents=True, exist_ok=True)
    a.report.write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps({'checked_png_paths': len(images), 'remaining_affected_paths': len(hits)}))
raise SystemExit(1 if hits else 0)
