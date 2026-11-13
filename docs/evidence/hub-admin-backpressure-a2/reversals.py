from pathlib import Path
import subprocess, os, json, hashlib
out=Path('.artifacts/admin-backpressure-a2'); files=['src/ui/hub-client.js','src/ui/hub-company-join.js','src/ui/hub-join-steps.js','src/ui/hub-enrolment-code.js']; original={p:Path(p).read_text() for p in files}
cmd=['node','node_modules/vitest/vitest.mjs','run','tests/hub-admin-backpressure-a2.test.ts','--no-file-parallelism']
results=[]
def run(label, pattern):
 if os.getloadavg()[0]>10: raise RuntimeError('Defer: host load above10')
 with (out/(label+'.log')).open('w') as log:r=subprocess.run(cmd+['-t',pattern],stdout=log,stderr=subprocess.STDOUT)
 text=(out/(label+'.log')).read_text(); semantic='AssertionError' in text and 'Test timed out' not in text
 results.append(dict(name=label,returncode=r.returncode,assertionCaught=semantic))
 return r.returncode,semantic
try:
 for p in files: Path(p).write_text(subprocess.check_output(['git','show','a11aa634:'+p],text=True))
 rc,semantic=run('baseline-final-tests','coalesces|backs off|a retry succeeds|session end cancels|aborting|a normal page|keeps known|initial group')
 assert rc and semantic
finally:
 for p,s in original.items():Path(p).write_text(s)
mutants=[
 ('M1-serial','src/ui/hub-client.js','const result = readTail.then(run, run);','const result = Promise.resolve().then(run);','coalesces'),
 ('M2-coalesce','src/ui/hub-client.js','if (!signal && pendingReads.has(path))','if (false && !signal && pendingReads.has(path))','coalesces'),
 ('M3-retry','src/ui/hub-client.js','attempt === 3','attempt === 0','backs off'),
 ('M4-session','src/ui/hub-client.js','if (mine !== generation) return retired();','','session end cancels'),
 ('M5-steps','src/ui/hub-join-steps.js','if (r?.code !== "backpressure") save(null);','save(null);','keeps known'),
 ('M6-company','src/ui/hub-company-join.js','typeof client.companyJoinSettings === "function"','false && typeof client.companyJoinSettings === "function"','a normal page'),
 ('M7-codes','src/ui/hub-enrolment-code.js','if (r.code !== "backpressure") setData(null);','setData(null);','backpressured code-list'),
]
for label,p,old,new,pattern in mutants:
 try:
  assert old in original[p];Path(p).write_text(original[p].replace(old,new))
  rc,semantic=run(label,pattern);assert rc and semantic,(label,rc,semantic)
 finally:Path(p).write_text(original[p])
assert all(Path(p).read_text()==s for p,s in original.items())
results.append({'exactRestore':True,'digests':{hashlib.sha256(Path(p).read_bytes()).hexdigest():p for p in files}})
(out/'reversals.json').write_text(json.dumps(results,indent=2)+'\n')
print(json.dumps(results))
