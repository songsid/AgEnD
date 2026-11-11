"""Each reversal compiles and fails a semantic assertion; restores exact bytes in finally."""
from pathlib import Path
import subprocess,sys
root=Path(__file__).resolve().parents[3];out=root/'.artifacts/hub-group-search-s2'
cases=[
 ('literal','src/hub/directory/directory.ts','const literal = escapeFilterValue(q);','const literal = q;','tests/hub-group-search-s2.test.ts','filter metacharacters'),
 ('size','src/hub/directory/directory.ts','sizeLimit: 20, timeLimit: 5','sizeLimit: 21, timeLimit: 5','tests/hub-group-search-s2.test.ts','caps 21'),
 ('time','src/hub/directory/directory.ts','sizeLimit: 20, timeLimit: 5','sizeLimit: 20, timeLimit: 6','tests/hub-group-search-s2.test.ts','finds Owners'),
 ('pool','src/hub/group-policy/admin-search.ts','selected.withDirectoryRead(actor.person, () => lookup.call(directory, request.q))','lookup.call(directory, request.q)','tests/hub-group-search-boundary-s2.test.ts','existing pool'),
 ('same-session','src/hub/group-policy/admin-search.ts','fresh.sessionId !== actor.sessionId || ','','tests/hub-group-search-boundary-s2.test.ts','SAME fresh'),
 ('generation','src/hub/group-policy/admin-search.ts','|| JSON.stringify(binding()) !== generation','', 'tests/hub-group-search-boundary-s2.test.ts','fences generation'),
 ('rate','src/hub/group-policy/admin-search.ts','bucket.count >= 30','bucket.count >= 31','tests/hub-group-search-boundary-s2.test.ts','30/session'),
 ('physical-close','src/hub/directory/directory.ts','await service?.close(true);','void service?.close(true);','tests/hub-group-search-close-s2.test.ts','does not settle'),
]
for name,file,old,new,test,pattern in cases:
 if len(sys.argv)>1 and name not in sys.argv[1:]:continue
 path=root/file;source=path.read_text();assert source.count(old)==1,(name,source.count(old))
 try:
  path.write_text(source.replace(old,new,1))
  typed=subprocess.run([str(root/'node_modules/.bin/tsc'),'--noEmit'],cwd=root,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
  (out/f'mutant-{name}-types.log').write_bytes(typed.stdout);assert typed.returncode==0,f'{name}: compile failed'
  run=subprocess.run([str(root/'node_modules/.bin/vitest'),'run',test,'-t',pattern],cwd=root,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
  log=run.stdout.decode();(out/f'mutant-{name}.log').write_text(log)
  assert run.returncode!=0 and 'AssertionError' in log,f'{name}: no semantic assertion failure'
  print(f'{name}: compiled, intended assertion caught',flush=True)
 finally:path.write_text(source)
