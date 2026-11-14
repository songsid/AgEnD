from pathlib import Path
import subprocess,hashlib,json,os
s=Path('src/hub/invitations.ts');raw=s.read_bytes();text=raw.decode();out=Path('.artifacts/room-invitations-track-c/r1/mutations');out.mkdir(exist_ok=True)
supersede='db.prepare("UPDATE hub_room_invitations SET state=\'cancelled\' WHERE room_id=? AND exposure_id=? AND owner=? AND state=\'expired\'")\n          .run(roomId, id, exposure.owner.id);'
cases=[('R1-expired-clear','const expired = row.state === "expired";','const expired = false;','clears an expired'),('R2-supersede',supersede,'','re-inviting after expiry'),('R3-inbox-skew','const now = this.now(); if (now < row.created_at) return [];','const now = this.now();','one future-dated')]
rows=[]
try:
 for name,before,after,selected in cases:
  assert os.getloadavg()[0]<=10,'load gate';assert text.count(before)==1,(name,text.count(before));s.write_text(text.replace(before,after))
  try:
   with (out/(name+'-types.log')).open('w') as f:types=subprocess.run(['ionice','-c3','nice','-n','10','node_modules/@typescript/typescript-linux-x64/lib/tsc','--noEmit','--pretty','false'],stdout=f,stderr=subprocess.STDOUT).returncode
   with (out/(name+'.log')).open('w') as f:code=subprocess.run(['ionice','-c3','nice','-n','10','node_modules/.bin/vitest','run','--no-file-parallelism','tests/hub-room-consent-track-c.test.ts','-t',selected],stdout=f,stderr=subprocess.STDOUT).returncode
   row={'name':name,'types':types,'exit':code,'assertionRed':'AssertionError:' in (out/(name+'.log')).read_text(),'mutantSha256':hashlib.sha256(s.read_bytes()).hexdigest(),'selected':selected};rows.append(row);(out/'summary.json').write_text(json.dumps(rows,indent=2)+'\n');print(row,flush=True);assert types==0 and code==1 and row['assertionRed']
  finally:s.write_bytes(raw)
finally:
 s.write_bytes(raw);assert s.read_bytes()==raw;(out/'restored.json').write_text(json.dumps({'restored':True,'sourceSha256':hashlib.sha256(raw).hexdigest()},indent=2)+'\n')
with (out/'restored-positive.log').open('w') as f:code=subprocess.run(['ionice','-c3','nice','-n','10','node_modules/.bin/vitest','run','--no-file-parallelism','tests/hub-room-consent-track-c.test.ts','-t','clears an expired|re-inviting after expiry|one future-dated'],stdout=f,stderr=subprocess.STDOUT).returncode
print({'restoredSelectedExit':code});assert code==0
