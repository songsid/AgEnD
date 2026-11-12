from pathlib import Path
import subprocess,json,os
out=Path('.artifacts/m2989/mutations');out.mkdir(exist_ok=True)
mutations=[
 ('witness','src/hub/catalog.ts','subjectSignedIn: !!db.prepare("SELECT 1 FROM hub_people WHERE person=?").get(personKeyString(grant.subject.person))','subjectSignedIn: true','tests/hub-grant-recipient-3370.test.ts'),
 ('legacy-dto','src/ui/panel-hub.js','g.subjectSignedIn === false','!g.subjectSignedIn','tests/hub-ui-s3.test.ts'),
 ('hub-id','src/ui/settings-hub-setup.js','v.runtime?.hubId === created.hubId','true','tests/hub-web-setup-ui.test.ts'),
 ('origin','src/ui/settings-hub-setup.js','v.runtime?.webOrigin === created.webOrigin','true','tests/hub-web-setup-ui.test.ts'),
 ('ready-state','src/ui/settings-hub-setup.js','if (same && v.runtime.state === "ready")','if (same)','tests/hub-web-setup-ui.test.ts'),
 ('handoff','src/hub/init/text.ts','管理 → 讓同仁加入','管理 → 允許的群組與人員','tests/hub-init-setup-bugs-2917.test.ts')]
results=[]
for label,file,old,new,test in mutations:
 if os.getloadavg()[0]>10: raise SystemExit('Paused: host load above 10')
 p=Path(file);original=p.read_text();assert old in original,label
 try:
  p.write_text(original.replace(old,new,1))
  with (out/(label+'.log')).open('w') as log:
   run=subprocess.run(['npx','vitest','run','--maxWorkers=1',test,'--reporter=json','--outputFile='+str(out/(label+'.json'))],stdout=log,stderr=subprocess.STDOUT)
  r=json.loads((out/(label+'.json')).read_text())
  result={'label':label,'exit':run.returncode,'failed':r['numFailedTests'],'passed':r['numPassedTests']}
  results.append(result);print(json.dumps(result),flush=True)
  assert run.returncode and r['numFailedTests']>0, 'not assertion-caught: '+label
 finally:p.write_text(original)
(out/'summary.json').write_text(json.dumps(results,indent=2))
