from pathlib import Path
import subprocess, json, hashlib
root=Path.cwd(); out=root/'.artifacts/m2995/mutations'; out.mkdir(parents=True,exist_ok=True)
cases=[
 ('live-cap','src/hub/enrolment-code.ts','throw new HubEnrolmentCodeLimit("live-code-limit")','throw new HubProtocolError("backpressure")','tests/hub-enrolment-code-store-b1.test.ts','identifies the live-code cap'),
 ('hourly-cap','src/hub/enrolment-code.ts','throw new HubEnrolmentCodeLimit("hourly-code-limit")','throw new HubProtocolError("backpressure")','tests/hub-enrolment-code-store-b1.test.ts','identifies the live-code cap'),
 ('http-reason','src/hub/http/compose.ts','{ code: "backpressure", reason: e.reason }','{ code: "backpressure" }','tests/hub-enrolment-code-http-b1.test.ts','distinct protected HTTP reasons'),
 ('client-reason','src/ui/hub-client.js','? { reason: json.reason } : {})','? {} : {})','tests/hub-enrolment-code-ui-b2.test.ts','creation limit names'),
 ('pending-labels','src/hub/join/service.ts','inFlight: inFlight.length, inFlightLabels: inFlight.slice(0, 3).map(r => r.label)','inFlight: this.codeReservations(code.id), inFlightLabels: []','tests/hub-enrolment-code-http-b1.test.ts','real revoke retires'),
 ('revoke-reason','src/hub/join/service.ts','for (const row of rows) this.endCode(this.records.get(row.id));','for (const row of rows) this.end(this.records.get(row.id), "authority");','tests/hub-enrolment-code-http-b1.test.ts','real revoke retires'),
 ('exhausted-reason','src/hub/join/service.ts','!== "live") this.endCode(r);','!== "live") this.end(r, "authority");','tests/hub-enrolment-code-http-b1.test.ts','code exhausted by another join'),
 ('end-confirm','src/ui/hub-enrolment-code.js','onClick=${() => setEnding({ client, id: row.id })}','onClick=${() => mutate("revoke", row.id)}','tests/hub-enrolment-code-ui-b2.test.ts','end-code confirmation names'),
 ('end-result','src/ui/hub-enrolment-code.js','if (kind === "revoke") setSuccess(he("ended"));','if (false) setSuccess(he("ended"));','tests/hub-enrolment-code-ui-b2.test.ts','end-code confirmation names'),
 ('queue-attempt','src/ui/hub-join-approval.js','? phase.attempts : null','? null : null','tests/hub-join-approval-ui-b2.test.ts','queue shows the current retry'),
 ('signin-progress','src/ui/panel-hub.js','queueMessage(approval.retryAttempt)','queueMessage(null)','tests/hub-join-approval-ui-b2.test.ts','approval after company sign-in shows retry'),
]
results=[]
for name,file,old,new,test,pattern in cases:
 p=root/file; original=p.read_bytes(); source=original.decode(); assert source.count(old)==1,(name,source.count(old))
 try:
  p.write_text(source.replace(old,new));
  cmd=['node_modules/.bin/vitest','run',test,'-t',pattern,'--exclude','**/.artifacts/**','--maxWorkers=1','--cache=false','--configLoader','runner']
  run=subprocess.run(cmd,cwd=root,capture_output=True,text=True,timeout=90)
  log=run.stdout+run.stderr; (out/(name+'.log')).write_text(log)
  caught=run.returncode!=0 and 'AssertionError' in log and 'Test Files' in log
  results.append(dict(name=name,file=file,exit=run.returncode,semanticFailure=caught,source=hashlib.sha256(original).hexdigest()))
  print(name,run.returncode,'semantic' if caught else 'NOT CAUGHT',flush=True)
 finally:
  p.write_bytes(original); assert p.read_bytes()==original
(out/'receipt.json').write_text(json.dumps(results,indent=2)+'\n')
assert all(x['semanticFailure'] for x in results), 'A mutation survived or failed outside an assertion'
