from pathlib import Path
import subprocess,json,hashlib
p=Path('src/ui/agent-details-settings.js'); original=p.read_text(); out=Path('.artifacts/split-chat-ownership'); results=[]
for name,old,new,file,pattern in [
 ('coherent-state','    setStaged(empty);','', 'tests/web-chat-pane-ownership-3637.test.ts','keeps A discarded'),
 ('draft-reset','    setEpoch((n) => n + 1);','', 'tests/web-details-n2.test.ts','an edit is staged at once'),
]:
 assert original.count(old)==1,(name,original.count(old))
 try:
  p.write_text(original.replace(old,new,1))
  r=subprocess.run(['npx','--no-install','vitest','run','--maxWorkers=1',file,'-t',pattern],stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True)
  (out/f'r1-mutant-{name}.log').write_text(r.stdout)
  caught=r.returncode!=0 and 'AssertionError' in r.stdout
  results.append({'name':name,'assertionCaught':caught,'exit':r.returncode,'file':file,'pattern':pattern})
  print(name,'ASSERTION-CAUGHT' if caught else 'NOT-CAUGHT',flush=True)
 finally:p.write_text(original)
(out/'r1-mutations.json').write_text(json.dumps({'inputs':{hashlib.sha256(original.encode()).hexdigest():[str(p)]},'results':results},indent=2)+'\n')
assert all(r['assertionCaught'] for r in results)
