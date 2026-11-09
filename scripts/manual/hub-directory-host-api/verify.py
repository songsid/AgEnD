#!/usr/bin/env python3
"""Focused guard reversals; source restored after every case. Never run beside tests/types/source edits."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys
root = Path(__file__).resolve().parents[3]
source = root / 'src/hub/settings-directory-host-http.ts'
original = source.read_bytes()
rows = [
 ('host-proof', 'try { owner = deps.hubSetupSession(req); } catch { owner = null; }', 'owner = { sessionId: "forged", requestId: "forged", current: () => true } as HubInitHostOwner;', 'refuses other admin'),
 ('query-method', 'if (url.search || req.method !== (action ? "POST" : "GET"))', 'if (false)', 'refuses other admin'),
 ('media-type', 'if (req.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !== "application/json" || req.headers["content-encoding"] !== undefined)', 'if (false)', 'refuses other admin'),
 ('disconnect', '!abort.signal.aborted && ownerCurrent() === true', 'ownerCurrent() === true', 'a held factory'),
 ('session-epoch', '!abort.signal.aborted && ownerCurrent() === true', '!abort.signal.aborted', 'a held factory'),
 ('post-body', 'if (!current()) throw new HubProtocolError("revoked");\n    const control = await create();', 'const control = await create();', 'during a held body'),
 ('post-factory', 'const control = await create();\n    if (!current()) throw new HubProtocolError("revoked");', 'const control = await create();', 'a held factory'),
 ('host-actor', 'kind: "host-owner" as const', 'kind: "hub-administrator" as const', 'AD settings from the local host session'),
 ('restored-status', 'action === "/save" && "state" in result && result.state === "restored" ? 503 : 200', '200', 'routes save through'),
 ('retry-after', '...(status === 429 ? { "Retry-After": "10" } : {})', '...{}', 'reports only a bounded error'),
]
selected = set(sys.argv[1:])
assert not selected - {row[0] for row in rows}
out = root / '.artifacts/hub-directory-host-api'
out.mkdir(parents=True, exist_ok=True)
results = []
try:
 for name, old, new, pattern in rows:
  if selected and name not in selected: continue
  text = original.decode()
  assert text.count(old) == 1, name
  source.write_text(text.replace(old,new))
  report = out / f'{name}.json'
  try:
   with (out / f'{name}.log').open('w') as log:
    run = subprocess.run(['npx','vitest','run','tests/hub-web-init-http.test.ts','-t',pattern,'--reporter=json',f'--outputFile={report}'],cwd=root,stdout=log,stderr=subprocess.STDOUT,timeout=90)
   data = json.loads(report.read_text())
   row = {'name':name,'exit':run.returncode,'passed':data['numPassedTests'],'failed':data['numFailedTests'],'deselected':data['numPendingTests']}
   failures = [t for suite in data['testResults'] for t in suite['assertionResults'] if t['status'] == 'failed']
   assert failures and all('AssertionError' in '\n'.join(t['failureMessages']) for t in failures), row
   results.append(row)
   print(json.dumps(row),flush=True)
  finally: source.write_bytes(original)
finally:
 source.write_bytes(original)
 suffix = '-'+'-'.join(sorted(selected)) if selected else ''
 (out / f'mutations{suffix}.json').write_text(json.dumps({'baseline':{hashlib.sha256(original).hexdigest():str(source.relative_to(root))},'rows':results,'restored':source.read_bytes()==original},indent=2)+'\n')
assert results
