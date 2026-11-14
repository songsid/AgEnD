from pathlib import Path
import hashlib,json,os,subprocess
source=Path('src/hub/invitations.ts');raw=source.read_bytes();text=raw.decode();out=Path('.artifacts/room-invitations-track-c/mutations');out.mkdir(exist_ok=True)
audit='this.core.audit(tx, { requestId: ctx.requestId, actor: { kind: "person", person: actor.person }, action: "room.invitation-accepted", result: "completed", roomId: row.room_id, exposureId: row.exposure_id });'
cases=[
 ('I1-owner-decline','if (row.owner !== owner) throw new HubProtocolError("denied");','', 'invites only through'),
 ('I2-audit-rollback',audit,'', 'rolls membership and invitation'),
 ('I3-seven-days','export const ROOM_INVITATION_TTL = 7 * 86_400_000;','export const ROOM_INVITATION_TTL = 14 * 86_400_000;', 'keeps duplicate pending'),
 ('I4-final-row','this.sameRow(db, { ...row, state: "accepted" });','', 'changed invitation during audit'),
 ('I6-session-fence','if (ctx.isCurrent?.() !== true) throw new HubProtocolError("revoked");','', "actual browser session"),
 ('I5-postcommit','return { invited: result.map(invited), changes };','this.publish(changes); return { invited: result.map(invited), changes: [] };', 'publishes refresh events'),
]
results=[]
try:
 for name,before,after,selected in cases:
  if os.getloadavg()[0]>10:raise RuntimeError('load gate refused')
  assert text.count(before)==1,(name,text.count(before));source.write_text(text.replace(before,after))
  try:
   with (out/(name+'-types.log')).open('w') as f:types=subprocess.run(['ionice','-c3','nice','-n','10','node_modules/@typescript/typescript-linux-x64/lib/tsc','--noEmit','--pretty','false'],stdout=f,stderr=subprocess.STDOUT).returncode
   with (out/(name+'.log')).open('w') as f:test=subprocess.run(['ionice','-c3','nice','-n','10','node_modules/.bin/vitest','run','--no-file-parallelism','tests/hub-room-consent-track-c.test.ts','-t',selected],stdout=f,stderr=subprocess.STDOUT).returncode
   semantic='AssertionError' in (out/(name+'.log')).read_text()
   row={'name':name,'selected':selected,'mutantSha256':hashlib.sha256(source.read_bytes()).hexdigest(),'types':types,'testExit':test,'assertionRed':semantic};results.append(row);(out/'summary.json').write_text(json.dumps(results,indent=2)+'\n');print(row,flush=True)
   assert types==0 and test!=0 and semantic,name
  finally:source.write_bytes(raw)
finally:
 source.write_bytes(raw);assert source.read_bytes()==raw
 (out/'restored.json').write_text(json.dumps({'restored':True,'sourceSha256':hashlib.sha256(raw).hexdigest()},indent=2)+'\n')
