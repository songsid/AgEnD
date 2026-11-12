"""Serial assertion reversals for the R2 contract updates; restores source exactly."""
from pathlib import Path
import hashlib,json,os,subprocess,sys
root=Path(__file__).resolve().parents[4];out=Path(sys.argv[1]).resolve();out.mkdir(parents=True,exist_ok=True)
git=lambda *a:subprocess.check_output(['git',*a],cwd=root,text=True).strip()
r={'head':git('rev-parse','HEAD'),'tree':git('rev-parse','HEAD^{tree}'),'runner':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),'cases':[]}
cases=[('selected','src/ui/shared/instance-nav.js','!viewOnly && name === active','false','tests/sidebar-instance-identity.test.ts'),('other','src/ui/shared/instance-nav.js','!viewOnly && name === active','!viewOnly','tests/sidebar-instance-identity.test.ts'),('settings-x','src/ui/panel-details.js','<a class="icon-btn agent-back-chat" href=${backToChat.path} aria-label=${backToChat.label} title=${backToChat.label}><${Icon} name="close" /></a>','','tests/web-usage-rail-1673.test.ts')]
for label,path,before,after,test in cases:
 assert os.getloadavg()[0]<=10
 p=root/path;original=p.read_bytes();assert original==subprocess.check_output(['git','show','HEAD:'+path],cwd=root)
 text=original.decode();assert text.count(before)==1
 try:
  p.write_text(text.replace(before,after,1));subprocess.run(['node','--check',str(p)],cwd=root,check=True,capture_output=True)
  done=subprocess.run(['npx','vitest','run',test,'--maxWorkers=1'],cwd=root,text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
  (out/(label+'.log')).write_text(done.stdout)
  caught=done.returncode!=0 and 'AssertionError' in done.stdout and 'Transform failed' not in done.stdout
  r['cases'].append({'label':label,'test':test,'exit':done.returncode,'assertionCaught':caught});print(label,done.returncode,caught,flush=True)
 finally:
  p.write_bytes(original);assert p.read_bytes()==original
  (out/'receipt.json').write_text(json.dumps(r,indent=2)+'\n')
assert len(r['cases'])==3 and all(x['assertionCaught'] for x in r['cases'])
