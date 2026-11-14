import os,subprocess,signal,time,json,sys
from pathlib import Path
root=Path.cwd();out=root/'.artifacts/room-invitations-track-c'/sys.argv[1];out.mkdir(parents=True,exist_ok=True)
assert not subprocess.check_output(['git','status','--porcelain'],text=True),'capture requires clean tree'
assert os.getloadavg()[0]<=10,'load gate'
env=os.environ.copy();env.update(PW_DIR='/home/han/.cache/wt-hubdto',CHROME='/home/han/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome',FONTCONFIG_FILE='/etc/fonts/fonts.conf',OUT=str(out))
loads=[]
with (out/'run.log').open('w') as f:
 p=subprocess.Popen(['ionice','-c3','nice','-n','10','node_modules/.bin/tsx','scripts/manual/hub-room-consent/browser.mts'],env=env,stdout=f,stderr=subprocess.STDOUT,start_new_session=True)
 try:
  while p.poll() is None:
   load=os.getloadavg()[0];loads.append({'at':time.time(),'load1':load})
   if load>10:os.killpg(p.pid,signal.SIGTERM);p.wait(timeout=15);raise RuntimeError('load stop')
   time.sleep(2)
 finally:
  if p.poll() is None:os.killpg(p.pid,signal.SIGTERM);p.wait(timeout=15)
  (out/'execution.json').write_text(json.dumps({'head':subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip(),'command':'ionice -c3 nice -n 10 tsx scripts/manual/hub-room-consent/browser.mts','exit':p.returncode,'loads':loads,'env':{k:env[k] for k in ['PW_DIR','CHROME','FONTCONFIG_FILE','OUT']}},indent=2)+'\n')
print((out/'run.log').read_text());raise SystemExit(p.returncode)
