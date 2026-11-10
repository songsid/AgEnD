import pathlib,subprocess,json
root=pathlib.Path('.')
helper=root/'tests/support/probe-worker-default.ts'
setup=root/'tests/setup-probe-worker.ts'
fake=root/'tests/helpers/probe-worker.ts'
originals={p:p.read_text() for p in [helper,setup,fake]}
mutations=[
 ('M1-compiled-probe-default',helper,r'(?:ts|js)$',r'(?:ts)$'),
 ('M2-ts-bootstrap-entry',helper,'options?.eval ? options.workerData?.entry : file','file'),
 ('M3-other-worker-passthrough',helper,'if (!probeEntry(file, options)) return Reflect.construct(target, args, newTarget);','if (false) return Reflect.construct(target, args, newTarget);'),
 ('M4-explicit-native-opt-in',helper,'const worker = realProbes ?','const worker = false ?'),
 ('M5-shared-beforeEach-reset',setup,'beforeEach(resetProbeWorkerDefault);',''),
 ('M6-shared-afterEach-drain',setup,'afterEach(drainProbeWorkers);',''),
 ('M7-acknowledged-termination',helper,'await Promise.race([termination.catch(() => worker.exited), worker.exited]);','void termination.catch(() => {});'),
 ('M8-late-answer-disposal',helper,'worker.dispose();',''),
 ('M9-owned-worker-registration',helper,'owned.add(worker);',''),
]
results=[]
try:
 for name,p,old,new in mutations:
  for path,value in originals.items():path.write_text(value)
  assert originals[p].count(old)==1,(name,old)
  p.write_text(originals[p].replace(old,new))
  out=root/'.artifacts'/f'{name}.json'
  cmd=['npx','vitest','run','tests/probe-worker-default.test.ts','-t','fakes|unrelated|same TS|opts in|resets opt|real process guard|drains','--reporter=json','--outputFile='+str(out)]
  run=subprocess.run(cmd,text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,timeout=45)
  (root/'.artifacts'/f'{name}.log').write_text(run.stdout)
  x=json.loads(out.read_text())
  failed=[a['fullName'] for s in x['testResults'] for a in s['assertionResults'] if a['status']=='failed']
  row={'id':name,'exit':run.returncode,'passed':x['numPassedTests'],'failed':x['numFailedTests'],'skipped':x['numPendingTests'],'failedCases':failed}
  assert run.returncode!=0 and row['failed']>0,name
  results.append(row)
  print(name,row['failed'],'failed',flush=True)
finally:
 for path,value in originals.items():path.write_text(value)
 (root/'.artifacts/mutations.json').write_text(json.dumps(results,indent=2)+'\n')
