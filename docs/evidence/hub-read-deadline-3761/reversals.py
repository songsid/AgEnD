from pathlib import Path
import os,subprocess,json,hashlib
root=Path('.artifacts/hub-read-deadline-3761');rows=[]
mutants=[
 ('D1-deadline','src/ui/hub-client.js','setTimeout(() => { timedOut = true; cancel(); }, readBudget)','setTimeout(() => {}, readBudget)','tests/hub-read-deadline-3761.test.ts','held fetch|body that never'),
 ('D2-abort-transport','src/ui/hub-client.js','const cancel = () => controller.abort();','const cancel = () => stop();','tests/hub-read-deadline-3761.test.ts','aborts a held fetch'),
 ('D3-body-late401','src/ui/hub-client.js','if (method === "GET" && signal?.aborted) return unreachable();','','tests/hub-read-deadline-3761.test.ts','late timed-out 401'),
 ('D4-release-queue','src/ui/hub-client.js','await Promise.race([request(method, path, body, controller.signal), stopped])','await request(method, path, body, controller.signal)','tests/hub-read-deadline-3761.test.ts','held fetch'),
 ('D5-queued-cancel','src/ui/hub-client.js','const result = Promise.race([queued, stopped]);','const result = queued;','tests/hub-read-deadline-3761.test.ts','queued caller abort'),
 ('D6-retire','src/ui/hub-client.js','for (const controller of readControllers) controller.abort();','','tests/hub-read-deadline-3761.test.ts','retires active and queued'),
 ('D7-backoff-cleanup','src/ui/hub-client.js','signal.addEventListener("abort", wake, { once: true });','','tests/hub-read-deadline-3761.test.ts','abort during429'),
 ('D8-release-owner','src/ui/hub-client.js','readControllers.delete(controller);','','tests/hub-read-deadline-3761.test.ts','normal response just before'),
 ('D9-known-steps','src/ui/hub-join-steps.js',' && r?.timedOut !== true','','tests/hub-admin-backpressure-a2.test.ts','timeout refresh'),
 ('D10-known-codes','src/ui/hub-enrolment-code.js',' && r.timedOut !== true','','tests/hub-admin-backpressure-a2.test.ts','timeout code-list'),
]
for name,path,old,new,test,pattern in mutants:
 source=Path(path).read_text()
 try:
  assert os.getloadavg()[0]<=10,'DEFER load above10'
  assert old in source
  Path(path).write_text(source.replace(old,new))
  with (root/(name+'.log')).open('w') as out:
   r=subprocess.run(['node','node_modules/vitest/vitest.mjs','run',test,'--no-file-parallelism','-t',pattern],stdout=out,stderr=subprocess.STDOUT)
  text=(root/(name+'.log')).read_text();caught=r.returncode!=0 and 'AssertionError' in text and 'Test timed out' not in text
  rows.append({'name':name,'exit':r.returncode,'assertionCaught':caught});assert caught,name
 finally:Path(path).write_text(source)
 assert Path(path).read_text()==source
rows.append({'exactRestore':True})
(root/'reversals.json').write_text(json.dumps(rows,indent=2)+'\n');print(json.dumps(rows))
