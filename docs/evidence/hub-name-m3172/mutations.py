import pathlib,subprocess,os,json,hashlib,time
root=pathlib.Path.cwd(); out=root/'.artifacts/hub-name-m3172/mutations';out.mkdir(exist_ok=True)
cases=[
 ('M1-pairing-name','src/hub/member/pairing-api.ts','name: readHubDisplayName(deps.home, p)','name: null','tests/hub-pairing-api-s3c.test.ts','projects the known Hub display name'),
 ('M2-factory-name','src/hub/compose/server.ts','        displayName: settings.name,\n','','tests/hub-compose.test.ts','composes S1 \\+ S2 \\+ S3 \\+ DB \\+ audit'),
 ('M3-live-name-getters','src/hub/compose/member.ts','get hubName() { return hubName(); }','hubName: hubName()','tests/hub-display-name-m3172.test.ts','does not gate member startup'),
 ('M4-cached-advice-name','src/hub/member/recommendations.ts','this.current() && this.cached ? { ...this.cached, hubName: this.options.hubName } : null','this.current() ? this.cached : null','tests/hub-member-recommendations-m3138.test.ts','refreshes a cached recommendation'),
 ('M5-binding-check','src/hub/display-name.ts',' && saved.binding === binding(profile)','','tests/hub-display-name-m3172.test.ts',"learns a code-only pairing")
]
sha=lambda b:hashlib.sha256(b).hexdigest()
results=[]
for label,file,old,new,suite,test in cases:
 if os.getloadavg()[0]>10: raise RuntimeError('load above10; no source mutation active')
 p=root/file;original=p.read_bytes();s=original.decode();n=s.count(old)
 if n!=(2 if label=='M3-live-name-getters' else 1):raise RuntimeError((label,'wrong occurrence count',n))
 changed=s.replace(old,new).encode();command=['nice','-n','10',str(root/'../../node_modules/.bin/vitest'),'run',suite,'-t',test,'--maxWorkers=2']
 try:
  p.write_bytes(changed)
  (out/(label+'.patch')).write_bytes(subprocess.check_output(['git','diff','--',file]))
  with (out/(label+'.log')).open('w') as log:
   r=subprocess.run(command,stdout=log,stderr=subprocess.STDOUT,timeout=100)
 finally:
  p.write_bytes(original)
 result={'id':label,'file':file,'command':command,'exit':r.returncode,'originalSha256':sha(original),'mutantSha256':sha(changed),'restoredSha256':sha(p.read_bytes()),'load1':os.getloadavg()[0]}
 text=(out/(label+'.log')).read_text()
 result['assertionFailure']='AssertionError:' in text
 results.append(result);(out/'results.json').write_text(json.dumps(results,indent=2)+'\n')
 print(label,r.returncode,result['assertionFailure'],flush=True)
 if r.returncode==0 or not result['assertionFailure']: raise RuntimeError('mutant did not fail semantically')
# Exact restored source selected tests, plus latest native test program.
if os.getloadavg()[0]>10:raise RuntimeError('load above10')
command=['nice','-n','10',str(root/'../../node_modules/.bin/vitest'),'run','tests/hub-pairing-api-s3c.test.ts','tests/hub-display-name-m3172.test.ts','tests/hub-member-recommendations-m3138.test.ts','--maxWorkers=2']
with (out/'restored.log').open('w') as log:r=subprocess.run(command,stdout=log,stderr=subprocess.STDOUT,timeout=150)
print('restored',r.returncode,flush=True)
if r.returncode:raise RuntimeError('restored failed')
command=['nice','-n','10',str(root/'../../node_modules/@typescript/native/bin/tsc'),'--noEmit','-p','tsconfig.test.json']
with (out/'test-types-final.log').open('w') as log:r=subprocess.run(command,stdout=log,stderr=subprocess.STDOUT,timeout=150)
(out/'test-types-final.json').write_text(json.dumps({'command':command,'exit':r.returncode},indent=2)+'\n')
print('test-types-final',r.returncode,flush=True)
if r.returncode:raise RuntimeError('test types failed')
