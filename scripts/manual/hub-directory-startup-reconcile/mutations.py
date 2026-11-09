"""Run only isolated authority/effect reversals; restore bytes before moving on."""
import json,os,pathlib,subprocess
root=pathlib.Path.cwd();runtime='src/hub/runtime.ts'
cases=[
 ('startup-call',runtime,'if (reconcile) await this.reconcileDirectoryStartup(structuredClone(config), view, admissionTicket);','', 'closes an exact pending intent'),
 ('close-exact-intent',runtime,'mounted.decision.completeMount(intent.operation.id, (this.options.now ?? Date.now)(), () => current() && mounted.current());','', 'closes an exact pending intent'),
 ('late-stop-proof',runtime,'operation => current()\n          && canonicalArguments(operation)','operation => canonicalArguments(operation)', 'Stop inside the final writer'),
 ('captured-operation',runtime,'canonicalArguments(operation) === canonicalArguments(intent.operation)','true', 'changed intent between cold'),
 ('startup-only',runtime,'!this.directoryStartupAttempted && obj(config.hub)?.enabled === true','obj(config.hub)?.enabled === true', 'live Save remount leaves its pending intent'),
 ('accepted-image',runtime,'hubPlanDigest(next.hub) !== restored.after.configDigest','false', 'stale accepted-config reader'),
 ('queue-restoration',runtime,'this.pending = next; this.lastConfig = next; this.admit(effectiveHubView(next)); this.view = null;','this.view = null;', 'refused replacement mount consumes'),
 ('owning-cold-participant',runtime,'        this.recoveryDirectory = decision;\n        try { return work(decision); }','        try { return work(decision); }', 'refused replacement mount consumes'),
 ('admission-ticket',runtime,'admissionTicket === this.admissionTicket && ','','A-Off-A during startup import'),
 ('advance-admission',runtime,'this.admitted = view; this.admissionTicket++;','this.admitted = view;','A-Off-A during startup import'),
 ('capture-before-await',runtime,'this.reconcileDirectoryStartup(structuredClone(config), view, admissionTicket);','this.reconcileDirectoryStartup(structuredClone(config), view, this.admissionTicket);','A-Off-A during startup import 1'),
 ('fleet-config-reader','src/fleet-manager.ts','        readConfig: () => this.rawFleetConfig as { hub?: unknown; hub_member?: unknown },','', 'runtime is handed the writer', 'tests/hub-settings-fleet-m2682.test.ts'),
]
output=root/'.artifacts/startup-mutations.json'
only=set(filter(None,os.environ.get('NAMES','').split(',')))
results=json.loads(output.read_text()) if only and output.exists() else []
try:
 for entry in cases:
  if only and entry[0] not in only:continue
  name,path,old,new,test=entry[:5];suite=entry[5] if len(entry)>5 else 'tests/hub-compose.test.ts'
  p=root/path;original=p.read_bytes();text=original.decode();assert text.count(old)==1,(name,text.count(old));p.write_text(text.replace(old,new))
  try:
   run=subprocess.run(['npx','vitest','run',suite,'-t',test,'--reporter=json'],capture_output=True,text=True)
   data=json.loads(run.stdout);messages=[m for f in data['testResults'] for a in f['assertionResults'] if a['status']=='failed' for m in a.get('failureMessages',[])]
   caught=run.returncode!=0 and bool(messages) and all('AssertionError' in m for m in messages)
   results=[r for r in results if r['name'] != name]
   results.append({'name':name,'caughtByAssertion':caught,'failures':len(messages)});print(name,caught,len(messages),flush=True)
   if not caught:raise RuntimeError(name+': '+run.stderr[-1000:]+str(messages)[:1500])
  finally:p.write_bytes(original)
finally:
 out=root/'.artifacts/startup-mutations.json';out.parent.mkdir(exist_ok=True);out.write_text(json.dumps(results,indent=2)+'\n')
