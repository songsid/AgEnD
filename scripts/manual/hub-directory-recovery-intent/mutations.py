"""Focused, isolated private-authority reversals; each must fail an assertion, never collection. Restore bytes."""
import json,os,pathlib,subprocess
root=pathlib.Path.cwd();decision='src/hub/settings-directory-decision.ts';writer='src/hub/settings-commit.ts';helper='src/hub/settings-directory-recovery-intent.ts'
# Canonical issuer authentication supersedes the old receipt-hash tampering reversal; that raw hash
# remains a SQL byte-consistency check, not the authority anchor. Do not count it as independent.
cases=[
 ('initial-clock',decision,'if (input.recovery) assertHubDirectoryRecoveryClock(input, initialProof);','', 'out-of-window initial clock'),
 ('final-clock',decision,'assertHubDirectoryRecoveryClock(saved, finalProof);','', 'audit crosses the clock'),
 ('late-mounted-proof',decision,'        proof();\n        const after = inspect()', '        const after = inspect()', 'late mounted-proof refusal'),
 ('exact-head',decision,'expected.operationId !== id || !intent','!intent', 'retained older intent'),
 ('root-completion',decision,'if (db.inTransaction || !Number.isSafeInteger(at))','if (!Number.isSafeInteger(at))', 'nested and asynchronous'),
 ('row-deadline',helper,'row.expires_at !== operation.recovery.expiresAt','false', 'changed recovery row after completion'),
 ('receipt-metadata',writer,' || !same(receipt.recovery, original.recovery)','', 'database-only extension'),
 ('signed-receipt',writer,'image().confirmationId !== sha(canonical(receipt)).slice(0, 32)','false','coherent receipt/SQL/hash'),
 ('writer-deadline-cap',writer,'Math.min(p.expiresAt, recoveryDeadline)','recoveryDeadline', 'caps an orchestration deadline'),
 ('cold-intent-table','src/hub/settings-directory-recovery.ts','SELECT operation_id,expires_at,state,completed_at FROM hub_settings_mount_recovery LIMIT 0','SELECT 1','refuses mount-intent before callback'),
 ('no-recursive-intent',decision,'if (compensation && input.recovery) throw new HubProtocolError("invalid");','', 'recursive recovery intent'),
 ('server-deadline','src/hub/settings-directory-save.ts','return at + 300_000;','return;','captures before the synchronous decision','tests/hub-directory-save.test.ts'),
 ('deadline-forwarding','src/hub/settings-directory-proof.ts','writer.commit(prepared.ref, ctx.actor, proof, rotation, effect)','writer.commit(prepared.ref, ctx.actor, proof, rotation)','propagates the bounded server deadline','tests/hub-directory-settings-proof.test.ts'),
 ('durable-before-cookie','src/hub/settings-directory-save.ts','if (intent.state === "pending") settled.decision.completeMount','if (false) settled.decision.completeMount','closes the durable mount intent before releasing','tests/hub-directory-save.test.ts'),
]
output=root/'.artifacts/recovery-intent-mutations.json'
only=os.environ.get("ONLY")
results=json.loads(output.read_text()) if only and output.exists() else []
try:
 for entry in cases:
  if only and entry[0] != only:continue
  name,path,old,new,test=entry[:5];suite=entry[5] if len(entry)>5 else "tests/hub-directory-settings-decision.test.ts"
  p=root/path;original=p.read_bytes();s=original.decode();assert s.count(old)==1,(name,s.count(old));p.write_text(s.replace(old,new))
  try:
   run=subprocess.run(['npx','vitest','run',suite,'-t',test,'--reporter=json'],capture_output=True,text=True)
   data=json.loads(run.stdout);messages=[m for f in data['testResults'] for a in f['assertionResults'] if a['status']=='failed' for m in a.get('failureMessages',[])]
   caught=run.returncode!=0 and bool(messages) and all('AssertionError' in m or ('promise rejected' in m and 'instead of resolving' in m) for m in messages)
   results=[r for r in results if r['name'] != name]
   results.append({'name':name,'caughtByAssertion':caught,'failures':len(messages)});print(name,caught,len(messages),flush=True)
   if not caught:raise RuntimeError(name+': '+run.stderr[-1000:]+str(messages)[:1500])
  finally:p.write_bytes(original)
finally:
 out=root/'.artifacts/recovery-intent-mutations.json';out.parent.mkdir(exist_ok=True);out.write_text(json.dumps(results,indent=2)+'\n')
