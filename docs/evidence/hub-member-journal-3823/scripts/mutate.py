"""Run each reversal alone; restore exact source even on failure. No network, Fleet or browser."""
from pathlib import Path
import hashlib, json, os, subprocess, sys
root=Path.cwd(); out=root/'.artifacts/repair-3823-mutants'; out.mkdir(parents=True,exist_ok=True)
j=root/'src/hub/member-journal.ts'; c=root/'src/hub/compose/member.ts'
cases=[
 ('M1-ignore-set-binding',c,'if (!db.transaction(() => journal.bindPairing(profile, exposures.list())).immediate()) {','if (false && !db.transaction(() => journal.bindPairing(profile, exposures.list())).immediate()) {'),
 ('M2-relabel-legacy',j,'const binding = observed ?? target;','const binding = target;'),
 ('M3-ignore-staged',j,'[row.committed, row.staged]','[row.committed]'),
 ('M4-ignore-stored-identity',j,'return bindingKey(validated(pairingBindingSchema, parseStrictJson(raw))) === bindingKey(target);','return true;'),
 ('M5-accept-other-fleet-question',j,'    this.checkPairing(q);',''),
 ('M6-orphan-is-empty',j,'["hub_representative_questions", "hub_representative_consents", "hub_execution_queue", "hub_execution_contexts", "hub_execution_operations", "hub_execution_attention"]','[]'),
 ('M7-no-adoption-floor',j,'this.change(() => { this.db.prepare("UPDATE hub_member_meta SET binding=? WHERE singleton=1").run(JSON.stringify(binding)); });','this.db.prepare("UPDATE hub_member_meta SET binding=? WHERE singleton=1").run(JSON.stringify(binding));'),
 ('M8-path-ignores-fleet',c,'    profile.fleetId, profile.owner.realm, profile.owner.objectId','    "", profile.owner.realm, profile.owner.objectId'),
 ('M9-orphan-representative-with-known-owner',j,'if (observed && has("hub_representative_questions")) {','if (observed && has("absent_representative_questions")) {'),
 ('M10-empty-receipt-history',j,'if (this.meta().receipt_sequence !== 0) throw new HubProtocolError("uncertain");','if (this.meta().receipt_sequence < 0) throw new HubProtocolError("uncertain");'),
 ('M11-ignore-execution-floor',c,'if ((executionMeta?.revision ?? 0) !== executionFloor!.read())','if ((executionMeta?.revision ?? 0) < 0)'),
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
