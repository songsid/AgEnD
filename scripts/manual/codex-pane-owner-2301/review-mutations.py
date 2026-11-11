import pathlib,subprocess,json,os
repo=pathlib.Path(os.environ['REPO']).resolve();out=pathlib.Path(os.environ['OUT']);out.mkdir(exist_ok=True)
files=['src/daemon.ts','src/transcript-delta-reader.ts','src/codex-pane-ownership.ts'];saved={p:(repo/p).read_text() for p in files}
mutants=[]
def add(name,p,old,new):
 assert saved[p].count(old)==1,(name,saved[p].count(old));mutants.append((name,p,saved[p].replace(old,new)))
add('R1-normal-reader-retirement',files[0],', checkpoint.ownedCodex?.retire)',')')
add('R2-fallback-reader-retirement',files[0],', bound.retire)',')')
add('R3-reader-no-revival',files[1],'    if (this.lostIdentity) return "unavailable";','')
add('R4-discovery-cancel',files[2],'() => { active = false; }','() => {}')
add('R5-discovery-entry-cap',files[2],'if (++entries > DISCOVERY_ENTRIES || entry.isSymbolicLink())','entries++; if (entry.isSymbolicLink())')
add('R6-discovery-directory-cap',files[2],' || queue.length >= DISCOVERY_DIRS','')
add('R7-discovery-depth-cap',files[2],'item.depth >= DISCOVERY_DEPTH','false')
add('R8-discovery-overlap',files[2],'  if (discovering.has(sessionsDir)) return null;','')
add('R9-discovery-yield',files[2],'await new Promise<void>(resolve => setImmediate(resolve));','await Promise.resolve();')
add('R10-local-diagnostic-skip',files[0],'if (!(rawPaste && backend === "codex"))','if (true)')
# Retain the original three fallback settlement pins on this source.
s=saved[files[0]];start=s.index('  private async proveDeliveryFromTranscript(');end=s.index('  private deferDurableDelivery(',start);scope=s[start:end]
for name,old in [('F1-before-look','        if (bound && (!bound.current() || !await bound.validate())) break;\n'),('F2-after-look','        if (bound && (!await bound.validate() || !bound.current())) break;\n'),('F3-before-settlement','      if (bound && (!await bound.validate() || !bound.current())) {\n        outcome = "uncertain";\n        evidence = "raw-paste-submit-proof:codex-session-binding-lost; not re-pasted";\n      }\n')]:
 assert scope.count(old)==1;mutants.append((name,files[0],s[:start]+scope.replace(old,'')+s[end:]))
only=os.environ.get('ONLY')
if only: mutants=[m for m in mutants if m[0] in only.split(',')]
rows=[]
try:
 for name,p,changed in mutants:
  (repo/p).write_text(changed)
  t=subprocess.run(['node','node_modules/@typescript/native/bin/tsc','--noEmit'],cwd=repo,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True);(out/(name+'-types.log')).write_text(t.stdout);assert t.returncode==0,(name,t.stdout)
  t=subprocess.run(['node','node_modules/vitest/vitest.mjs','run','tests/codex-pane-discovery-2301.test.ts','tests/codex-pane-ownership-2301.test.ts','tests/codex-pane-read-race-2301.test.ts','--maxWorkers=3'],cwd=repo,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True);(out/(name+'.log')).write_text(t.stdout)
  caught=t.returncode!=0 and 'AssertionError' in t.stdout and 'timed out' not in t.stdout
  rows.append(dict(name=name,compiled=True,caughtByAssertion=caught));print(rows[-1],flush=True)
  (repo/p).write_text(saved[p]);assert caught,t.stdout
finally:
 for p,s in saved.items():(repo/p).write_text(s)
 (out/'receipt.json').write_text(json.dumps(rows,indent=2)+'\n')
