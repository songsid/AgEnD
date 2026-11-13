#!/usr/bin/env python3
"""Run one semantic reversal at a time. Always restore exact source bytes; stop above load10."""
import hashlib,json,os,pathlib,subprocess,sys,time
root=pathlib.Path.cwd(); out=pathlib.Path(os.environ.get('MUTATION_OUT','.artifacts/m3015/mutations'));out.mkdir(parents=True,exist_ok=True)
server='tests/hub-sharing-pause-m3015.test.ts';ui='tests/hub-sharing-pause-ui-m3015.test.ts'
mutants=[
 ('S1','src/hub/sharing.ts',' || row.owner !== me','',server,'requires the exact owner'),
 ('S2','src/hub/sharing.ts','.run(request.paused ? 1 : 0,','.run(0,',server,'pauses without changing'),
 ('S3','src/hub/sharing.ts','await this.core.sharingPermission(id, this.core.groupContext(ctx))','await Promise.resolve({ assertCurrent() {} })',server,'independent operational'),
 ('S4','src/hub/sharing.ts','db.prepare("DELETE FROM hub_leases WHERE message_id IN (SELECT id FROM hub_messages WHERE exposure_id=?)").run(id);','',server,'invalidates pre-pause release'),
 ('S5','src/hub/catalog.ts','DO UPDATE SET display_name=excluded.display_name','DO UPDATE SET sharing_paused=0, display_name=excluded.display_name',server,'retains an owner pause'),
 ('S6','src/hub/http/core.ts','if (!sharingChange) return JSON.stringify(e);','if (!sharingChange) { const { sharingEpoch: _omitted, ...rest } = e; return JSON.stringify(rest); }',server,'retires a pre-pause operation'),
 ('S7','src/hub/sharing.ts',' || (row.sharing_epoch ?? 0) !== request.sharingEpoch','',server,'requires the exact owner'),
 ('U1','src/ui/panel-hub.js','const resumable = session?.features?.includes("sharing-pause-v1") && client?.sharingPauseV1 === true && typeof client.sharing === "function";','const resumable = true;',ui,'retained client/server'),
 ('U2','src/ui/panel-hub.js','room.exposureState === "frozen" || paused','room.exposureState === "frozen"',ui,'a paused asker sees'),
 ('U3','src/ui/hub-chat-store.js','      if (!r.ok && r.code === "sharing-paused" && st.live) { st.room = { ...st.room, exposureState: "paused" }; emit(); schedule(0); return r; }\n','',ui,'a stale-tab question'),
]
chosen=set(sys.argv[1:]); entries=[]
for name,path,old,new,file,selector in mutants:
 if chosen and name not in chosen:continue
 if float(pathlib.Path('/proc/loadavg').read_text().split()[0])>10:print('DEFER load>10 before',name,flush=True);sys.exit(75)
 p=root/path;original=p.read_bytes();text=original.decode();assert text.count(old)==1,(name,text.count(old));log=out/(name+'.log')
 try:
  p.write_text(text.replace(old,new))
  type_log=out/(name+'.types.log')
  with type_log.open('w') as stream:typed=subprocess.run(['node','node_modules/@typescript/native/bin/tsc','--noEmit'],env={**os.environ,'GOMAXPROCS':'2'},stdout=stream,stderr=subprocess.STDOUT,timeout=120)
  assert typed.returncode==0,(name,'mutant must compile',type_log.read_text())
  with log.open('w') as stream:r=subprocess.run(['node','node_modules/vitest/vitest.mjs','run',file,'--maxWorkers=2','--no-file-parallelism','--no-color','-t',selector],stdout=stream,stderr=subprocess.STDOUT,timeout=90)
  body=log.read_text();caught=r.returncode!=0 and 'AssertionError' in body and all(s not in body for s in ['Transform failed','SyntaxError','Unhandled Error'])
 finally:p.write_bytes(original);assert p.read_bytes()==original
 entry={'id':name,'path':path,'test':file,'selector':selector,'caught':caught,'nativeCompilerExit':typed.returncode,'typeLogDigest':hashlib.sha256(type_log.read_bytes()).hexdigest(),'exit':r.returncode,'sourceDigest':hashlib.sha256(original).hexdigest(),'logDigest':hashlib.sha256(log.read_bytes()).hexdigest(),'restored':True}
 (out/(name+'.json')).write_text(json.dumps(entry,indent=2)+'\n');entries.append(entry);print(json.dumps(entry),flush=True)
 if not caught:sys.exit(1)
assert entries
