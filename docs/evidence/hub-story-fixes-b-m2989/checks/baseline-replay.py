from pathlib import Path
import subprocess,json,hashlib,os
base='a6557a6b3e328b1586de0f853390aabb8f0ad99f'
source=['src/fleet-manager.ts','src/hub/catalog.ts','src/hub/init/text.ts','src/hub/init/web.ts','src/ui/panel-hub.js','src/ui/settings-hub-setup.js']
tests=['tests/hub-grant-recipient-3370.test.ts','tests/hub-init-setup-bugs-2917.test.ts','tests/hub-web-init.test.ts','tests/hub-web-setup-ui.test.ts','tests/hub-ui-s3.test.ts','tests/hub-web-init-http.test.ts']
original={p:Path(p).read_bytes() for p in source}
record={'candidate':subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip(),'baseProduct':base,'testInputs':{},'baseProductInputs':{}}
for p in tests:record['testInputs'].setdefault(hashlib.sha256(Path(p).read_bytes()).hexdigest(),[]).append(p)
try:
 if os.getloadavg()[0]>10:raise SystemExit('Paused: load above 10')
 for p in source:
  body=subprocess.check_output(['git','show',base+':'+p]);Path(p).write_bytes(body);record['baseProductInputs'].setdefault(hashlib.sha256(body).hexdigest(),[]).append(p)
 with Path('.artifacts/m2989/baseline-replay.log').open('w') as log:
  run=subprocess.run(['npx','vitest','run','--maxWorkers=2',*tests,'--reporter=json','--outputFile=.artifacts/m2989/baseline-replay-tests.json'],stdout=log,stderr=subprocess.STDOUT)
 r=json.loads(Path('.artifacts/m2989/baseline-replay-tests.json').read_text());record.update(exit=run.returncode,failed=r['numFailedTests'],passed=r['numPassedTests'])
 assert run.returncode and r['numFailedTests']>0
finally:
 for p,body in original.items():Path(p).write_bytes(body)
 record['restored']=all(Path(p).read_bytes()==body for p,body in original.items())
 Path('.artifacts/m2989/baseline-replay.json').write_text(json.dumps(record,indent=2))
print(json.dumps(record))
