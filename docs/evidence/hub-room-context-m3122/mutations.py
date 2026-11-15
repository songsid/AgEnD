from pathlib import Path
import subprocess,hashlib,json,os
root=Path.cwd();out=root/'.artifacts/room-context-m3122/mutations';out.mkdir(parents=True,exist_ok=True)
cases=[
('M1-repeat-context','src/hub/rooms/context.ts','.all(post.room_id, post.sequence, floor, after, floor)','.all(post.room_id, post.sequence, floor, 0, floor)','tests/hub-room-context-m3122.test.ts','sends only posts after'),
('M2-stale-generation','src/hub/rooms/context-cursor.ts',' || this.generation(exposure,binding) !== generation','','tests/hub-room-context-m3122.test.ts','keeps cursors across reconnect'),
('M3-IPC-is-not-input','src/hub/member/room-ask.ts','      if (this.closed) return;\n      const latest = this.row(id);','      if (saved.generation) this.inputHandoff(saved.cid,saved.local.agent,saved.generation);\n      if (this.closed) return;\n      const latest = this.row(id);','tests/hub-room-context-member-m3122.test.ts','IPC acceptance never advances'),
('M4-reset-write-fence','src/daemon.ts','      || (!!opts?.roomContextGeneration && opts.roomContextGeneration !== this.roomConversationGeneration());',';','tests/hub-room-context-daemon-m3122.test.ts','a reset during a readiness'),
('M5-frozen-answer-reset','src/hub/member/room-ask.ts','if (this.current(saved, false)) await this.send(saved, source);','if (this.current(saved)) await this.send(saved, source);','tests/hub-room-context-member-m3122.test.ts','keeps a frozen answer'),
('M6-local-opt-in','src/hub/client.ts','this.options.roomContext && features.has(HUB_ROOM_ASK_CAPABILITY)','features.has(HUB_ROOM_ASK_CAPABILITY)','tests/hub-room-context-link-m3122.test.ts','keeps legacy hello16'),
('M7-consumed-marker','src/daemon.ts',': roomContextInputMarker(track.meta);',': null;','tests/hub-room-context-daemon-m3122.test.ts','a real busy Hub delivery')]
sha=lambda b:hashlib.sha256(b).hexdigest();results=[]
for name,file,before,after,suite,test in cases:
 if os.getloadavg()[0]>10:raise RuntimeError('load above10')
 p=root/file;original=p.read_bytes();s=original.decode();count=s.count(before)
 if count!=(2 if name=='M3-IPC-is-not-input' else 1):raise RuntimeError((name,count))
 changed=s.replace(before,after,1).encode()
 cmd=['nice','-n','10','../../node_modules/.bin/vitest','run',suite,'-t',test,'--maxWorkers=2']
 try:
  p.write_bytes(changed);(out/(name+'.patch')).write_bytes(subprocess.check_output(['git','diff','--',file]))
  with (out/(name+'.log')).open('w') as f:r=subprocess.run(cmd,stdout=f,stderr=subprocess.STDOUT,timeout=90)
 finally:p.write_bytes(original)
 result={'id':name,'path':file,'command':cmd,'exit':r.returncode,'assertionFailure':'AssertionError:' in (out/(name+'.log')).read_text(),'originalSha256':sha(original),'mutantSha256':sha(changed),'restoredSha256':sha(p.read_bytes()),'load1':os.getloadavg()[0]}
 results.append(result);(out/'results.json').write_text(json.dumps(results,indent=2)+'\n');print(name,r.returncode,result['assertionFailure'],flush=True)
 if r.returncode==0 or not result['assertionFailure']:raise RuntimeError('not an assertion failure')
commands=[('restored',['../../node_modules/.bin/vitest','run','tests/hub-room-context-m3122.test.ts','tests/hub-room-context-member-m3122.test.ts','tests/hub-room-context-http-m3122.test.ts','tests/hub-room-context-daemon-m3122.test.ts','tests/hub-room-context-link-m3122.test.ts','tests/hub-room-context-fleet-m3122.test.ts','--maxWorkers=2']),('source-types',['../../node_modules/.bin/tsc','--noEmit','-p','tsconfig.json']),('test-types',['../../node_modules/.bin/tsc','--noEmit','-p','tsconfig.test.json'])]
last=[]
for label,cmd in commands:
 if os.getloadavg()[0]>10:raise RuntimeError('load above10')
 with (out/(label+'.log')).open('w') as f:r=subprocess.run(['nice','-n','10',*cmd],stdout=f,stderr=subprocess.STDOUT,timeout=150)
 last.append({'label':label,'command':cmd,'exit':r.returncode});(out/'final-results.json').write_text(json.dumps(last,indent=2)+'\n');print(label,r.returncode,flush=True)
 if r.returncode:raise RuntimeError('restored verification failed')
