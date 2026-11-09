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
 ('shared-pool',recovery,'policy.withDirectoryRead(person, work).then(resolve, reject)','work().then(resolve, reject)',lib),
 ('physical-reads',recovery,'          await Promise.allSettled([...active]);','          // reversed physical read drain',lib),
 ('driver-close',recovery,'          await (acceptedDirectory as HubDirectory & { close?(): Promise<void> }).close?.();','          void (acceptedDirectory as HubDirectory & { close?(): Promise<void> }).close?.();',lib),
 ('database-close',recovery,'          state.close();','          // reversed database close',lib),
 ('replacement-drain',runtime,'if (this.coldDirectoryCleanup || this.coldDirectory && (obj(config.hub)?.enabled === true || !this.coldDirectory.current())) await this.drainColdDirectory();','if (this.coldDirectoryCleanup || this.coldDirectory && (obj(config.hub)?.enabled === true || !this.coldDirectory.current())) void this.drainColdDirectory();',flow),
 ('stop-drain',runtime,'await this.coldDirectoryInit?.catch(() => {});\n      await this.drainColdDirectory();','await this.coldDirectoryInit?.catch(() => {});\n      void this.drainColdDirectory();',flow),
 ('admission-ticket',runtime,'ticket === this.directoryAdmissionTicket && admissionTicket === this.admissionTicket','admissionTicket === this.admissionTicket',flow),
 ('refresh-ticket',runtime,'ticket === this.directoryAdmissionTicket && admissionTicket === this.admissionTicket','ticket === this.directoryAdmissionTicket',flow),
 ('construction-drain',runtime,'    if (this.coldDirectoryBuild) await this.coldDirectoryBuild.catch(() => {});','    // reversed construction drain',flow),
 ('construction-registration',runtime,'      this.coldDirectoryBuild = build;','      // reversed construction registration',flow),
 ('post-build-admission',runtime,'        if (!current()) { await this.drainColdDirectory(); throw Error("Directory settings admission changed"); }','        // reversed post-build admission',flow),
 ('participant-owner',runtime,'this.recoveryDirectory ?? this.coldDirectory?.decision ?? this.mountedDirectory?.decision ?? null','this.recoveryDirectory ?? this.mountedDirectory?.decision ?? this.coldDirectory?.decision ?? null',flow),
 ('off-view-revocation',runtime,'    this.observeDirectoryAdmission(config.hub);','    // reversed off-state incarnation observation',flow),
 ('member-isolation',runtime,'await this.mount.closeServer();','await this.mount.holdServer(snapshot);',flow),
 ('off-writer','src/hub/settings-commit.ts','(hub.enabled !== true && !(directory && hub.enabled === false))','(hub.enabled !== true)',lib),
 ('held-not-ready','src/hub/settings-directory-save.ts',' || mounted.recoveryMode === "held"','',flow),
 ('host-acquisition','src/fleet-manager.ts','    await runtime.acquireDirectorySettings();','    // reversed local cold acquisition',['tests/hub-web-init-http.test.ts','-t','replaces an unreachable AD']),
]
r1_names={
 'cached-reacquisition','cached-stop','cached-runtime','reentrant-read',
 'constructor-retention','constructor-adoption','constructor-drain','constructor-run',
}
rows += [
 ('cached-reacquisition','src/fleet-manager.ts',
  '    await runtime.acquireDirectorySettings();',
  '    if (!this.hubDirectoryInit) await runtime.acquireDirectorySettings();',
  ['tests/hub-web-init-http.test.ts','-t','replaces an unreachable AD.*off']),
 ('cached-stop','src/fleet-manager.ts',
  'if (this.shuttingDown || runtime !== this.hubRuntime) throw Error("The Hub directory changed");',
  'if (runtime !== this.hubRuntime) throw Error("The Hub directory changed");',
  ['tests/hub-settings-fleet-m2682.test.ts','-t','a cached controller cannot escape Stop']),
 ('cached-runtime','src/fleet-manager.ts',
  'if (this.shuttingDown || runtime !== this.hubRuntime) throw Error("The Hub directory changed");',
  'if (this.shuttingDown) throw Error("The Hub directory changed");',
  ['tests/hub-settings-fleet-m2682.test.ts','-t','a cached controller cannot escape runtime replacement']),
 ('reentrant-read',recovery,
  '        // Register ownership before dispatch: the callback may synchronously re-enter close().\n'
  '        let resolve!: (value: T | PromiseLike<T>) => void, reject!: (error: unknown) => void;\n'
  '        const pending = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); active.add(pending);\n'
  '        void pending.finally(() => active.delete(pending)).catch(() => {});\n'
  '        void policy.withDirectoryRead(person, work).then(resolve, reject); return pending;',
  '        const pending = policy.withDirectoryRead(person, work); active.add(pending);\n'
  '        void pending.finally(() => active.delete(pending)).catch(() => {}); return pending;',
  ['tests/hub-directory-settings-decision.test.ts','-t','registers physical ownership']),
 ('constructor-retention',recovery,
  '    catch { throw new HubDirectoryColdCleanupError(cleanup); }',
  '    catch { state.close(); throw error; }',
  ['tests/hub-compose.test.ts','-t','retains a failed constructor cleanup']),
 ('constructor-adoption',runtime,
  'if (error instanceof HubDirectoryColdCleanupError) this.coldDirectoryCleanup = error;',
  '// reversed construction cleanup adoption',
  ['tests/hub-compose.test.ts','-t','retains a failed constructor cleanup.*replacement']),
 ('constructor-drain',runtime,'      await cleanup.close();','      void cleanup.close();',
  ['tests/hub-compose.test.ts','-t','retains a failed constructor cleanup']),
 ('constructor-run',runtime,
  'if (this.coldDirectoryCleanup || this.coldDirectory && (obj(config.hub)?.enabled === true || !this.coldDirectory.current()))',
  'if (this.coldDirectory && (obj(config.hub)?.enabled === true || !this.coldDirectory.current()))',
  ['tests/hub-compose.test.ts','-t','retains a failed constructor cleanup.*Run']),
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
 file=out/('mutations-r1.json' if selected and selected <= r1_names else 'mutations-selected.json' if selected else 'mutations.json')
 file.write_text(json.dumps({'v':1,'baseline':{hashlib.sha256(value).hexdigest():path for path,value in original.items()},'rows':result,'restored':True},indent=2)+'\n')
