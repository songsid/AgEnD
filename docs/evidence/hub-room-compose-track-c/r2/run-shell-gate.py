import os, signal, subprocess, sys, time, json
from pathlib import Path
label=sys.argv[1]
repo=Path.cwd()
out=repo/'.artifacts/room-compose-track-c'/label
out.mkdir(parents=True, exist_ok=True)
env=os.environ.copy()
env.update(PW_DIR='/home/han/.cache/wt-hubdto',REPO=str(repo),OUT=str(out),GATE='ci',CHROME='/home/han/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome',FONTCONFIG_FILE='/etc/fonts/fonts.conf')
loads=[]
if os.getloadavg()[0]>10: raise SystemExit('load gate refused')
with (out/'run.log').open('w') as log:
 p=subprocess.Popen(['ionice','-c3','nice','-n','10',str(repo/'node_modules/.bin/tsx'),'scripts/manual/smoke/smoke-hub-shell-gate.mts'],env=env,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
 try:
  while p.poll() is None:
   value=os.getloadavg()[0]; loads.append({'at':time.time(),'load1':value})
   if value>10: os.killpg(p.pid,signal.SIGTERM); p.wait(timeout=15); raise RuntimeError('load stop')
   time.sleep(2)
 finally:
  if p.poll() is None: os.killpg(p.pid,signal.SIGTERM); p.wait(timeout=15)
  (out/'execution.json').write_text(json.dumps({'exit':p.returncode,'loads':loads,'command':'tsx scripts/manual/smoke/smoke-hub-shell-gate.mts','env':{k:env[k] for k in ['PW_DIR','REPO','OUT','GATE','CHROME','FONTCONFIG_FILE']}},indent=2)+'\n')
print((out/'run.log').read_text())
raise SystemExit(p.returncode)
