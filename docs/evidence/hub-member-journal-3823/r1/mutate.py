"""Run each reversal alone; restore exact source even on failure. No network, Fleet or browser."""
from pathlib import Path
import hashlib, json, os, subprocess, sys
root=Path.cwd(); out=root/'.artifacts/repair-3823-r1-mutants'; out.mkdir(parents=True,exist_ok=True)
j=root/'src/hub/member-journal.ts'; c=root/'src/hub/compose/member.ts'
cases=[
 ('K2-prefer-legacy',c,'const candidates = inspectStateSet(home, scoped) === "complete" ? [scoped] : [memberSet(hubId), scoped];','const candidates = [memberSet(hubId), scoped];'),
 ('K8-ignore-S4-digest',j,' || r.digest !== this.row(e.messageId)!.contextDigest',''),
 ('K10-missing-pairing-success',c,'throw new HubStateError("hub-member-pairing", "the saved member state has no pairing");','return 0;'),
 ('K13-ignore-representative-revision',j,' || r.revision !== e.exposureRevision',''),
 ('K5-no-decrypt-pairing-check',j,'      this.checkPairing(payload.question);',''),
 ('K11-no-offline-profile-fence',c,'current: () => profiles.profileDigest() === digest','current: () => true'),
 ('K12-no-post-bind-fence',c,'if (!options.current()) throw new HubStateError("hub-member-pairing", "the pairing changed while opening its state");',''),
]
selected=set(sys.argv[1:])
base={p:p.read_bytes() for p in (j,c)}
results=json.loads((out/'results.json').read_text()) if selected and (out/'results.json').exists() else []
results=[r for r in results if r['name'] not in selected]
if selected: cases=[case for case in cases if case[0] in selected]
def run(args,path):
 with path.open('w') as f: return subprocess.run(args,stdout=f,stderr=subprocess.STDOUT).returncode
try:
 for name,path,old,new in cases:
  if os.getloadavg()[0]>10: raise SystemExit('host load above 10; stop before next mutant')
  for p,b in base.items(): p.write_bytes(b)
  source=path.read_text(); assert source.count(old)==1,(name,source.count(old))
  path.write_text(source.replace(old,new)); digest=hashlib.sha256(path.read_bytes()).hexdigest()
  typed=run(['node_modules/.bin/tsc','--noEmit'],out/(name+'-types.log'))
  rc=run(['node_modules/.bin/vitest','run','tests/hub-member-repair-3823.test.ts','tests/hub-member-journal.test.ts','--maxWorkers=2'],out/(name+'.log')) if typed==0 else None
  log=(out/(name+'.log')).read_text() if rc is not None else ''
  item={'name':name,'file':str(path.relative_to(root)),'sha256':digest,'typesExit':typed,'testExit':rc,'caught':typed==0 and rc!=0 and 'AssertionError' in log}; results.append(item)
  (out/'results.json').write_text(json.dumps(results,indent=2)+'\n'); print(json.dumps(item),flush=True)
  if not item['caught']: raise SystemExit('non-semantic or surviving mutant: '+name)
finally:
 for p,b in base.items(): p.write_bytes(b)
 (out/'restored.json').write_text(json.dumps([{'file':str(p.relative_to(root)),'sha256':hashlib.sha256(p.read_bytes()).hexdigest(),'restored':p.read_bytes()==b} for p,b in base.items()],indent=2)+'\n')
