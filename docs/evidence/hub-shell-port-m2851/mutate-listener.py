from pathlib import Path
import subprocess,json
p=Path('scripts/manual/smoke-fixture/listen-loopback.mts');original=p.read_text();results=[]
mutations=[
 ('M1-fixed-port','server.listen(0,','server.listen(48748,','binds port zero'),
 ('M2-wrong-port','resolve(address.port);','resolve(address.port + 1);','binds port zero'),
 ('M3-released-reservation','const address = server.address();','server.close(); const address = server.address();','binds port zero'),
 ('M4-swallowed-bind-error','reject(error); };','resolve(0); };','asynchronous bind errors'),
 ('M5-sync-listener-leak','} catch (error) { server.removeListener("error", failed); reject(error); }','} catch (error) { reject(error); }','synchronous refusal'),
]
try:
 for name,old,new,pattern in mutations:
  assert original.count(old)==1,name;p.write_text(original.replace(old,new))
  out=Path('.artifacts')/(name+'.json')
  r=subprocess.run(['npx','vitest','run','tests/hub-shell-listener-2851.test.ts','-t',pattern,'--reporter=json','--outputFile='+str(out)],capture_output=True,text=True,timeout=30)
  Path('.artifacts',name+'.log').write_text(r.stdout+r.stderr)
  x=json.loads(out.read_text());assert r.returncode!=0 and x['numFailedTests']>0,name
  results.append({'id':name,'exit':r.returncode,'failed':x['numFailedTests'],'passed':x['numPassedTests'],'deselected':x['numPendingTests']})
  print(name,x['numFailedTests'],'failed',flush=True)
finally:
 p.write_text(original);Path('.artifacts/mutations.json').write_text(json.dumps(results,indent=2)+'\n')
