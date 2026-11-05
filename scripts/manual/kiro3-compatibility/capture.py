#!/usr/bin/env python3
"""Offline real-binary capture. Requires network-none container, scratch HOME and private tmux; never a real login."""
import os,sys,subprocess,json,sqlite3,shutil,time,shlex
from pathlib import Path
assert os.geteuid()!=0, 'Run as an unprivileged container user'
assert all(row.split()[0]=='lo' for row in Path('/proc/net/route').read_text().splitlines()[1:] if row.split()), 'Requires network-none isolation'
root=Path(os.environ['PROOF_ROOT']);root.mkdir(parents=True,exist_ok=True)
binary=os.environ['KIRO_BINARY'];socket='sol-kiro3-'+str(os.getpid());seed=root/'seed';cwd=root/'work';cwd.mkdir(exist_ok=True)
# Constrain only this scratch process tree, including libraries that count CPU affinity for worker pools.
os.sched_setaffinity(0,{min(os.sched_getaffinity(0))})
def command(home,flags):
 env={'HOME':str(home),'XDG_DATA_HOME':str(home/'.local/share'),'XDG_CONFIG_HOME':str(home/'.config'),'XDG_STATE_HOME':str(home/'.local/state'),'XDG_CACHE_HOME':str(home/'.cache'),'PATH':'/usr/local/bin:/usr/bin:/bin','TERM':'xterm-256color','KIRO_NO_AUTO_UPDATE':'1'}
 return shlex.join(['env','-i',*[k+'='+v for k,v in env.items()],binary,'chat',*flags])
def launch(name,home,flags,width=120):
 home.mkdir(parents=True,exist_ok=True)
 subprocess.run(['tmux','-L',socket,'new-session','-d','-s',name,'-x',str(width),'-y','40','-c',str(cwd),command(home,flags)],check=True)
def stop(name):subprocess.run(['tmux','-L',socket,'kill-session','-t',name],check=False,stderr=subprocess.DEVNULL)
def capture(name,needle):
 end=time.monotonic()+15
 while time.monotonic()<end:
  p=subprocess.check_output(['tmux','-L',socket,'capture-pane','-p','-t',name],text=True)
  if needle in p:return p
  time.sleep(.1)
 raise RuntimeError('Capture deadline: '+name)
try:
 launch('init',seed,['--legacy-ui','--agent-engine=v1'])
 capture('init','You are not logged in. Login now?');stop('init')
 db=sqlite3.connect(seed/'.local/share/kiro-cli/data.sqlite3')
 db.execute('INSERT OR REPLACE INTO auth_kv VALUES (?,?)',('kirocli:social:token',json.dumps({'access_token':'offline-dummy-never-valid','refresh_token':'offline-dummy-never-valid','expires_at':'2099-01-01T00:00:00Z','provider':'google','profile_arn':'arn:aws:codewhisperer:us-east-1:000000000000:profile/OFFLINEONLY','region':'us-east-1'})));db.commit();db.close()
 for name,flags,width,saved,needle in [
  ('classic-120',['--legacy-ui','--agent-engine=v1'],120,False,'Continue with V3'),
  ('classic-80',['--legacy-ui','--agent-engine=v1'],80,False,'Continue with V3'),
  ('v2-notice',['--legacy-ui','--agent-engine=v1'],120,True,'Keep V2'),
  ('tui-explicit-saved-v2',['--tui','--agent-engine=v2'],120,True,'Yes, I accept')]:
  home=root/name;shutil.copytree(seed,home)
  if saved:
   settings=home/'.kiro/settings';settings.mkdir(parents=True,exist_ok=True);(settings/'cli.json').write_text(json.dumps({'chat.agentEngine':'v2'}))
  launch(name,home,[*flags,'--trust-all-tools'],width)
  p=capture(name,needle);(root/(name+'.pane.txt')).write_text(p);stop(name)
finally:
 subprocess.run(['tmux','-L',socket,'kill-server'],check=False,stderr=subprocess.DEVNULL)
(root/'capture-receipt.json').write_text(json.dumps({'network':'none (required by invocation)','privateSocket':socket,'realAccount':False,'choicesAnswered':0,'explicitTuiWithSavedV2ReachedTrust':True,'passed':True},indent=2))
