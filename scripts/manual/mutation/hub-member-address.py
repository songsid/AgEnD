#!/usr/bin/env python3
"""Run from an owned checkout with dependencies installed. Each mutation restores its exact original bytes in finally."""
from pathlib import Path
import subprocess
out=Path('.artifacts/hub-member-address-3429'); out.mkdir(parents=True, exist_ok=True)
cases=[
 ('generation','src/hub/settings-member-address-decision.ts','f.generation++;','','tests/hub-member-address-decision-3429.test.ts','revokes exactly retained'),
 ('final-owner','src/hub/settings-member-address-decision.ts','// Required audit runs inside mutate. Its callbacks cannot revoke authority or alter the stage/material unnoticed.\n        proof(current);','// Mutation: omit the post-audit owner fence.','tests/hub-member-address-decision-3429.test.ts','post-audit proof'),
 ('floor','src/hub/settings-member-address-decision.ts','head: () => { transport.read(); return readHubMemberAddressHead(db); }','head: () => { return readHubMemberAddressHead(db); }','tests/hub-member-address-decision-3429.test.ts','required audit failure'),
 ('notice-owner','src/hub/settings-member-address-decision.ts','f => all || personKeyString(f.owner) === target','f => true','tests/hub-member-address-decision-3429.test.ts','revokes exactly retained'),
 ('stage-bytes','src/hub/settings-member-address.ts','|| s.operation.after.certificateSha !== sha(read(s.certificateFile, 65536))','','tests/hub-member-address-writer-3429.test.ts','even another valid same-key'),
 ('ancestor-flush','src/hub/settings-member-address.ts','fsyncSync(fd);','void fd;','tests/hub-member-address-writer-3429.test.ts','strict ancestor flush'),
 ('owner-object','src/hub/settings-member-address-control.ts','p.ownerKey !== ctx.ownerKey || ','','tests/hub-member-address-writer-3429.test.ts','async control retires a replaced owner'),
 ('tls-selection','src/hub/tls.ts','metadata.v === 1 ? "hub/keys/tls-cert.pem" : metadata.certificateFile','"hub/keys/tls-cert.pem"','tests/hub-member-identity-3429.test.ts','hostname reissue'),
]
for label,name,old,new,test,title in cases:
 p=Path(name);before=p.read_text();assert old in before,label
 try:
  p.write_text(before.replace(old,new))
  r=subprocess.run(['node_modules/.bin/vitest','run',test,'-t',title],text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
  (out/f'mutant-{label}.log').write_text(r.stdout)
  assert r.returncode and ('AssertionError' in r.stdout or ' FAIL ' in r.stdout),f'{label} survived or failed to execute'
  print(label,'caught',flush=True)
 finally:p.write_text(before)
