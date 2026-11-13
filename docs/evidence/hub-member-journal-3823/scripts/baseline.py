"""Reproduce with final fixture against exact pre-fix source, restoring both files afterward."""
from pathlib import Path
import hashlib,json,os,subprocess
root=Path.cwd(); out=root/'.artifacts/repair-3823-final-baseline'; out.mkdir(parents=True,exist_ok=True)
paths=['src/hub/member-journal.ts','src/hub/compose/member.ts']; original={p:(root/p).read_bytes() for p in paths}
base='17e0b50633e374a13662214d21e6e28b468f3d98'
if os.getloadavg()[0]>10: raise SystemExit('load above 10')
try:
 for p in paths: (root/p).write_bytes(subprocess.check_output(['git','show',base+':'+p]))
 with (out/'baseline.log').open('w') as f:
  rc=subprocess.run(['node_modules/.bin/vitest','run','tests/hub-member-repair-3823.test.ts','--maxWorkers=2','-t',r'#3823 \(bound\)|^same-Fleet restart'],stdout=f,stderr=subprocess.STDOUT).returncode
 text=(out/'baseline.log').read_text()
 (out/'receipt.json').write_text(json.dumps({'base':base,'testExit':rc,'semanticRed':rc!=0 and 'AssertionError' in text,'fixtureSha256':hashlib.sha256((root/'tests/hub-member-repair-3823.test.ts').read_bytes()).hexdigest()},indent=2)+'\n')
 if not (rc and 'AssertionError' in text): raise SystemExit('baseline did not reproduce semantically')
finally:
 for p,b in original.items(): (root/p).write_bytes(b)
 (out/'restored.json').write_text(json.dumps([{'file':p,'sha256':hashlib.sha256((root/p).read_bytes()).hexdigest(),'restored':(root/p).read_bytes()==b} for p,b in original.items()],indent=2)+'\n')
