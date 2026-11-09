#!/usr/bin/env python3
"""Focused, one-at-a-time guard reversals. Never run beside tests, types or edits."""
from pathlib import Path
import hashlib,json,subprocess,sys
root=Path(__file__).resolve().parents[3]
out=root/'.artifacts/hub-directory-cold-settings';out.mkdir(parents=True,exist_ok=True)
recovery='src/hub/settings-directory-recovery.ts';runtime='src/hub/runtime.ts'
lib=['tests/hub-directory-settings-decision.test.ts','-t','cold settings source']
flow=['tests/hub-compose.test.ts','-t','local directory settings while off or held']
rows=[
 ('final-material',recovery,'    barrier.assertCurrent(); // Construction callbacks cannot publish changed material.','    // reversed final material fence',lib),
 ('source-material',recovery,'const stamp = barrier.capture();','const stamp = {epoch:0,image:"a".repeat(64)};',lib),
 ('shared-pool',recovery,'const pending = policy.withDirectoryRead(person, work);','const pending = work();',lib),
 ('physical-reads',recovery,'          await Promise.allSettled([...active]);','          // reversed physical read drain',lib),
 ('driver-close',recovery,'          await (acceptedDirectory as HubDirectory & { close?(): Promise<void> }).close?.();','          void (acceptedDirectory as HubDirectory & { close?(): Promise<void> }).close?.();',lib),
 ('database-close',recovery,'          state.close();','          // reversed database close',lib),
 ('replacement-drain',runtime,'if (this.coldDirectory && (obj(config.hub)?.enabled === true || !this.coldDirectory.current())) await this.drainColdDirectory();','if (this.coldDirectory && (obj(config.hub)?.enabled === true || !this.coldDirectory.current())) void this.drainColdDirectory();',flow),
 ('stop-drain',runtime,'await this.coldDirectoryInit?.catch(() => {});\n      await this.drainColdDirectory();','await this.coldDirectoryInit?.catch(() => {});\n      void this.drainColdDirectory();',flow),
 ('admission-ticket',runtime,'!this.stopped && ticket === this.directoryAdmissionTicket && canonicalArguments(read().hub) === view','!this.stopped && canonicalArguments(read().hub) === view',flow),
 ('off-view-revocation',runtime,'    this.observeDirectoryAdmission(config.hub);','    // reversed off-state incarnation observation',flow),
 ('member-isolation',runtime,'await this.mount.closeServer();','await this.mount.holdServer(snapshot);',flow),
 ('off-writer','src/hub/settings-commit.ts','(hub.enabled !== true && !(directory && hub.enabled === false))','(hub.enabled !== true)',lib),
 ('held-not-ready','src/hub/settings-directory-save.ts',' || mounted.recoveryMode === "held"','',flow),
 ('host-acquisition','src/fleet-manager.ts','      await runtime.acquireDirectorySettings();','      // reversed local cold acquisition',['tests/hub-web-init-http.test.ts','-t','replaces an unreachable AD']),
]
selected=set(sys.argv[1:]);result=[]
original={p:(root/p).read_bytes() for p in {row[1] for row in rows}}
try:
 for name,path,before,after,tests in rows:
  if selected and name not in selected:continue
  p=root/path;source=original[path].decode();assert source.count(before)==1,(name,source.count(before))
  p.write_text(source.replace(before,after,1))
  try:
   report=out/(name+'.json')
   r=subprocess.run(['npx','vitest','run',*tests,'--reporter=json','--outputFile='+str(report)],cwd=root,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,timeout=90)
   (out/(name+'.log')).write_text(r.stdout)
   data=json.loads(report.read_text())
   failures=[x for suite in data['testResults'] for x in suite.get('assertionResults',[]) if x['status']=='failed']
   assertions=[x for x in failures if any('AssertionError:' in text for text in x['failureMessages'])]
   assert r.returncode!=0 and assertions,(name,r.returncode,data.get('numFailedTests'))
   result.append({'name':name,'path':path,'pattern':before,'passed':data['numPassedTests'],'failed':data['numFailedTests'],'assertionFailures':len(assertions)})
   print(name,len(assertions),'assertion failures',flush=True)
  finally:p.write_bytes(original[path])
finally:
 for p,value in original.items():assert (root/p).read_bytes()==value,p
 file=out/('mutations-selected.json' if selected else 'mutations.json')
 file.write_text(json.dumps({'v':1,'baseline':{hashlib.sha256(value).hexdigest():path for path,value in original.items()},'rows':result,'restored':True},indent=2)+'\n')
