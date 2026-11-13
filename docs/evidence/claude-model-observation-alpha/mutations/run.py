from pathlib import Path
import subprocess, json, os, hashlib, sys
root=Path.cwd(); out=root/'.artifacts/model-switch-alpha/mutations';out.mkdir(exist_ok=True)
core='src/claude-model-observation.ts'; monitor='src/transcript-monitor.ts'; daemon='src/daemon.ts'; hub='src/needs-you-hub.ts'
cases=[
 ('M1-sidechain',core,'e.isSidechain !== true','true',['tests/claude-model-switch.test.ts']),
 ('M2-apierror',core,'e.isApiErrorMessage !== true','true',['tests/claude-model-switch.test.ts']),
 ('M3-dedupe',core,'if (this.seen.has(key)) return false;','if (false) return false;',['tests/claude-model-switch.test.ts']),
 ('M4-recovery',core,'this.state.active = null;\n    else if (allowInference && !this.state.active && expected', '{}\n    else if (allowInference && !this.state.active && expected',['tests/claude-model-switch.test.ts']),
 ('M5-concrete',core,'this.expected = claudeModelId(launch);','this.expected = null;',['tests/claude-model-switch.test.ts']),
 ('M6-hookowner',monitor,'hook._agendLaunchId === launch.id','true',['tests/claude-model-switch.test.ts']),
 ('M7-launchtime',monitor,'observation.at >= launch.startedAt','true',['tests/claude-model-switch.test.ts']),
 ('M8-daemonfence',daemon,'owner !== launchIdentity(this.interactionOwner())','false',['tests/claude-model-switch-daemon.test.ts']),
 ('M9-resumequiet',hub,'!i.quiet && !seen.has(i.id)','!seen.has(i.id)',['tests/needs-you-hub-1386.test.ts']),
 ('M11-commandprefix',core,'/^(?:<command-name>\\/|<command-message>)/','/^<command-name>\\//',['tests/claude-model-switch.test.ts']),
 ('M12-logpair','src/ui/log-row.js','${text(modelSwitchText(x.modelSwitch))}','${null}',['tests/web-log-tab-1218.test.ts']),
 ('M13-officeshare','src/ui/fleet-office-card.js','modelSwitch: !share ? modelSwitchText(it.model_observation?.active) : ""','modelSwitch: modelSwitchText(it.model_observation?.active)',['tests/office-card-2661.test.ts']),
 ('M14-nofallback',core,'e.subtype === "model_refusal_fallback" || e.subtype === "model_fallback"','e.subtype === "model_refusal_fallback" || e.subtype === "model_fallback" || e.subtype === "model_refusal_no_fallback"',['tests/claude-model-switch.test.ts']),
 ('M15-intent-session',core,'&& normalizeClaudeModel(session) === normalizeClaudeModel(record.served)','',['tests/claude-model-switch.test.ts']),
 ('M10-original',core,'original = claudeModelId(e.originalModel)','original = claudeModelId(e.fallbackModel)',['tests/claude-model-switch.test.ts']),
 ('A1-native-session','src/runtime-transcript-source.ts','model.sessionId === before.cursor.sessionId','true',['tests/claude-model-runtime-observation.test.ts']),
 ('A2-native-owner','src/runtime-transcript-source.ts','&& !this.stopped && this.port.isTranscriptObservationCurrent(this.reference) ? this.reference.cursor.sessionId','? this.reference.cursor.sessionId',['tests/claude-model-runtime-observation.test.ts']),
 ('A3-native-daemon',daemon,'const modelCurrent = () => !nativeModel || this.nativePaneLifecycle?.current() === true;','const modelCurrent = () => true;',['tests/claude-model-switch-daemon.test.ts']),
 ('A4-native-gap',core,'else if (allowInference &&','else if (',['tests/claude-model-runtime-observation.test.ts']),
 ('A5-native-context',monitor,'if (generation !== this.generation || this.source!.modelObservationSession?.() !== session) continue;','if (false) continue;',['tests/claude-model-runtime-observation.test.ts']),
]
cases += [('C1-checkpoint-intent', 'src/claude-model-observation.ts', 'intent: this.intent === undefined ? { kind: "none" } : this.intent === null ? { kind: "unresolved" } : { kind: "concrete", model: this.intent }', 'intent: { kind: "none" }', ['tests/claude-model-checkpoint-tail.test.ts', 'tests/claude-model-switch-daemon.test.ts']), ('C2-restore-intent', 'src/claude-model-observation.ts', 'this.intent = intent?.kind === "none" ? undefined\n        : intent?.kind === "concrete" && claudeModelId(intent.model) ? claudeModelId(intent.model) : null;', 'this.intent = undefined;', ['tests/claude-model-checkpoint-tail.test.ts']), ('C3-legacy-conservative', 'src/claude-model-observation.ts', 'intent?.kind === "concrete" && claudeModelId(intent.model) ? claudeModelId(intent.model) : null;', 'intent?.kind === "concrete" && claudeModelId(intent.model) ? claudeModelId(intent.model) : undefined;', ['tests/claude-model-checkpoint-tail.test.ts']), ('T1-cursor', 'src/log-steps.ts', 'Math.min(opts.end, size)', 'Math.min(size, size)', ['tests/claude-model-checkpoint-tail.test.ts']), ('T2-shared-budget', 'src/log-steps.ts', 'readTailAtBoundary(path, fh, end, maxBytes - read, maxLines)', 'readTailAtBoundary(path, fh, end, maxBytes, maxLines)', ['tests/claude-model-checkpoint-tail.test.ts']), ('T3-boundary-budget', 'src/log-steps.ts', 'Math.min(read === 0 ? 1 : BACKFILL_CHUNK, boundary, maxBytes - read)', 'Math.min(read === 0 ? 1 : BACKFILL_CHUNK, boundary)', ['tests/claude-model-checkpoint-tail.test.ts'])]
cases += [('C4-pending-recovery', 'src/claude-model-observation.ts', '      if (returned) this.state.active = null;', '      if (false) this.state.active = null;', ['tests/claude-model-checkpoint-tail.test.ts', 'tests/claude-model-switch-daemon.test.ts']), ('L1-log-cursor', 'src/log-steps.ts', 'if (end === 0) return { records: [], truncated: false, end };', 'if (end === 0 || (await stat(path)).size - end > maxBytes) return { records: [], truncated: true, end: 0 };', ['tests/claude-model-checkpoint-tail.test.ts']), ('T4-startup-lane', 'src/transcript-monitor.ts', 'readStartupTailRecords', 'readTailRecords', ['tests/claude-model-checkpoint-tail.test.ts'])]
selected=set(sys.argv[1:])
results=json.loads((out/'results.json').read_text()) if selected else []
for name,file,before,after,tests in cases:
 if selected and name not in selected: continue
 results=[r for r in results if r['name']!=name]
 if os.getloadavg()[0]>10: raise SystemExit('load over10; resume remaining mutations later')
 p=root/file; original=p.read_text(); assert before in original,(name,'targetmissing')
 changed=original.replace(before,after)
 try:
  p.write_text(changed)
  if file.endswith('.js'):
   syntax=subprocess.run(['node','--check',file],capture_output=True,text=True)
   if syntax.returncode: raise RuntimeError(name+' invalid JS')
  tc=subprocess.run(['./node_modules/.bin/tsc','--noEmit','--pretty','false'],capture_output=True,text=True)
  (out/(name+'-types.log')).write_text(tc.stdout+tc.stderr)
  if tc.returncode: raise RuntimeError(name+' fails compilation')
  r=subprocess.run(['./node_modules/.bin/vitest','run',*tests,'--maxWorkers=2'],capture_output=True,text=True)
  log=r.stdout+r.stderr;(out/(name+'.log')).write_text(log)
  if r.returncode==0 or 'AssertionError' not in log: raise RuntimeError(name+' not semantic red')
  results.append({'name':name,'file':file,'before':before,'after':after,'baseDigest':hashlib.sha256(original.encode()).hexdigest(),'mutantDigest':hashlib.sha256(changed.encode()).hexdigest(),'types':tc.returncode,'testExit':r.returncode,'semanticRed':True})
 finally:
  p.write_text(original)
  assert p.read_text()==original
 (out/'results.json').write_text(json.dumps(results,indent=2)+'\n')
 print(name+' caught, source restored',flush=True)
