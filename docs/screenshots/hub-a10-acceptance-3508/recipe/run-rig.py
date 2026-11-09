from pathlib import Path
import subprocess,os,sys,time,json,tempfile,shutil
root=Path(__file__).resolve().parent;repo=root.parents[1]/'.worktrees/a10-acceptance';name=sys.argv[1];script=sys.argv[2];extras=dict(x.split('=',1)for x in sys.argv[3:]);out=root/name;out.mkdir(exist_ok=True);home=root/'homes'/name;home.mkdir(parents=True,exist_ok=True);tmp=Path(tempfile.mkdtemp(prefix='a10qa-'))
env={'PATH':'/home/han/.nvm/versions/node/v22.22.2/bin:/usr/bin:/bin','HOME':str(home),'TMPDIR':str(tmp),'LANG':'C.UTF-8','FONTCONFIG_FILE':str(root.parents[1]/'.artifacts/a9-acceptance/fontconfig.xml'),'REPO':str(repo),'OUT':str(out),'PW_DIR':str(root.parents[1]/'.artifacts/ux-3322/browser'),'CHROME':'/home/han/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome','MATRIX':'desk-light-zh-TW,phone-dark-zh-TW','ART':str(out),'CANDIDATE':'da70c790f774b1f6b0d32559aa70065f7e8485d3','CANDIDATE_VERIFIED':'1',**extras}
log=(root/'logs'/f'{name}.log').open('w');cmd=['unshare','-Urn','/bin/bash','--noprofile','--norc','-c','ip link set lo up\nexec "$@"','a10-owned','node','--import',str(repo/'node_modules/tsx/dist/loader.mjs'),str(repo/script)]
p=subprocess.Popen(cmd,cwd=repo,env=env,stdout=log,stderr=subprocess.STDOUT);known={p.pid};identities={}
while True:
 for pid in list(known):
  try:
   stat=Path(f'/proc/{pid}/stat').read_text().split(') ',1)[1].split();identities.setdefault(pid,stat[19]);
   for children in Path(f'/proc/{pid}/task').glob('*/children'):
    known.update(map(int,children.read_text().split()))
  except (FileNotFoundError,ProcessLookupError,PermissionError):pass
 if p.poll()is not None:break
 time.sleep(.15)
time.sleep(.3);alive=[]
for pid,start in identities.items():
 try:
  stat=Path(f'/proc/{pid}/stat').read_text().split(') ',1)[1].split()
  if stat[19]==start and stat[0]!='Z':alive.append(pid)
 except FileNotFoundError:pass
receipt={'case':name,'head':subprocess.check_output(['git','rev-parse','HEAD'],cwd=repo,text=True).strip(),'commandScript':script,'extras':extras,'exitCode':p.returncode,'trackedPids':len(identities),'liveOwnedPids':alive,'ownedTemp':str(tmp),'noExternalRoutes':'unshare-Urn;only-loopback-enabled','at':time.time()};(root/'receipts'/f'{name}-cleanup.json').write_text(json.dumps(receipt,indent=2));log.close();
if not alive:shutil.rmtree(tmp);receipt['ownedTempRemoved']=not tmp.exists();(root/'receipts'/f'{name}-cleanup.json').write_text(json.dumps(receipt,indent=2))
print(json.dumps(receipt));sys.exit(p.returncode if p.returncode else bool(alive))
