from pathlib import Path
import subprocess,os,json,hashlib
out=Path('.artifacts/admin-backpressure-a2'); results=[]
mutants=[
('B6','src/ui/hub-client.js','const result = await request(method, path, body, signal);\n        if (mine !== generation) return retired();','const result = await request(method, path, body, signal);','B6:'),
('J3','src/ui/hub-company-join.js','if (!live.current || busy || !view) return; readEpoch.current++;','if (!live.current || busy || !view) return;','J3:'),
('S3','src/ui/hub-join-steps.js','pending=${!view || reading || readError}','pending=${false}','S3:'),
('B9','src/ui/hub-client.js','result.code !== "backpressure" || ','','B9:'),
]
for label,path,old,new,pattern in mutants:
 source=Path(path).read_text()
 try:
  assert os.getloadavg()[0]<=10,'DEFER: host load above10'
  assert source.count(old)==1
  Path(path).write_text(source.replace(old,new))
  with (out/('r1-'+label+'.log')).open('w') as log:
   r=subprocess.run(['node','node_modules/vitest/vitest.mjs','run','tests/hub-admin-backpressure-a2.test.ts','--no-file-parallelism','-t',pattern],stdout=log,stderr=subprocess.STDOUT)
  text=(out/('r1-'+label+'.log')).read_text();assert r.returncode!=0 and 'AssertionError' in text and 'Test timed out' not in text,label
  results.append({'name':label,'exit':r.returncode,'assertionCaught':True,'scope':pattern})
 finally:
  Path(path).write_text(source)
 assert Path(path).read_text()==source
results.append({'exactRestore':True})
(out/'r1-reversals.json').write_text(json.dumps(results,indent=2)+'\n')
print(json.dumps(results))
