from pathlib import Path
import subprocess,hashlib,json,os,re
root=Path.cwd();alpha='allowInference = true' in (root/'src/claude-model-observation.ts').read_text();out=root/'.artifacts'/('model-switch-alpha' if alpha else 'model-switch');out.mkdir(parents=True,exist_ok=True)
# Run only from a clean disposable checkout; three source files are restored in finally.
old='4c6d8de0f2a9efa5649441334c40414553aaf14d' if alpha else '3591e7c32bebff3240c65ff3a59a3e0380c0d873'
paths=['src/claude-model-observation.ts','src/log-steps.ts','src/transcript-monitor.ts']
original={p:(root/p).read_bytes() for p in paths}
assert all(subprocess.check_output(['git','show','HEAD:'+p])==data for p,data in original.items()), 'source must be committed/clean'
before={p:subprocess.check_output(['git','show',old+':'+p]) for p in paths}
sources={'tests/r2-before-model.fixture.test.ts':(root/'tests/claude-model-checkpoint-tail.test.ts').read_text().replace('readStartupTailRecords','readTailRecords'),'tests/r2-before-daemon.fixture.test.ts':(root/'tests/claude-model-switch-daemon.test.ts').read_text()}
assert all(not (root/p).exists() for p in sources)
assert os.getloadavg()[0]<=10
h=lambda b:hashlib.sha256(b).hexdigest()
command=['./node_modules/.bin/vitest','run',*sources,'-t','definite recovery|actual LogService|legacy quiet','--maxWorkers=2']
try:
 for p,data in before.items():(root/p).write_bytes(data)
 for p,data in sources.items():(root/p).write_text(data)
 r=subprocess.run(command,cwd=root,capture_output=True,text=True);log=r.stdout+r.stderr
 (out/'r2-exact-before.log').write_text(log)
 assert r.returncode!=0 and 'AssertionError' in log and re.search(r'Tests\s+6 failed',log),log
finally:
 for p,data in original.items():(root/p).write_bytes(data);assert (root/p).read_bytes()==data
 for p in sources:(root/p).unlink(missing_ok=True)
for p,data in sources.items():(out/(Path(p).name+'.txt')).write_text(data)
(out/'r2-exact-before.json').write_text(json.dumps({'priorHead':old,'currentHead':subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip(),'command':command,'semanticReds':6,'otherTests':'deliberately excluded by targeted filter, not counted as pass','priorInputs':[{'path':p,'digest':h(b)} for p,b in before.items()],'testInputs':[{'path':p,'savedAs':Path(p).name+'.txt','digest':h(s.encode())} for p,s in sources.items()],'restoredInputs':[{'path':p,'digest':h(b)} for p,b in original.items()],'allRestored':True},indent=2)+'\n')
print('exact prior-head6semanticreds;source restored')
