#!/usr/bin/env python3
# M-3398: does kiro's "chat.defaultModel ... is not available" warning reach the pane under AgEnD's launch args?
# Run inside `unshare -cn` (no network). Scratch HOME, dummy never-valid token, private tmux socket, SIGINT only.
import os,sys,json,sqlite3,subprocess,time,shlex
from pathlib import Path
assert all(r.split()[0]=='lo' for r in Path('/proc/net/route').read_text().splitlines()[1:] if r.split()), 'network present'
Path('/proc/self/coredump_filter').write_text('0')
R=Path(sys.argv[1]); ver=sys.argv[2]; model=sys.argv[3]
binary=str(R/'kx'/ver/'kirocli/bin/kiro-cli')
home=R/('home-'+ver); cwd=R/'work'; cwd.mkdir(exist_ok=True); out=R/'caps'/ver; out.mkdir(parents=True,exist_ok=True)
sock='m3398-'+str(os.getpid())
def tm(*a,check=True): return subprocess.run(['tmux','-L',sock,*a],check=check,capture_output=True,text=True).stdout
def env(): return {'HOME':str(home),'XDG_DATA_HOME':str(home/'.local/share'),'XDG_CONFIG_HOME':str(home/'.config'),'XDG_STATE_HOME':str(home/'.local/state'),'XDG_CACHE_HOME':str(home/'.cache'),'PATH':str(Path(binary).parent)+':/usr/bin:/bin','TERM':'xterm-256color','KIRO_NO_AUTO_UPDATE':'1'}
def launch(name,flags):
  cmd=shlex.join(['env','-i',*[k+'='+v for k,v in env().items()],binary,'chat',*flags])
  tm('new-session','-d','-s',name,'-x','120','-y','40','-c',str(cwd),cmd); tm('set-option','-t',name,'remain-on-exit','on')
def cap(name): return tm('capture-pane','-p','-J','-S','-300','-t',name)
def stop(name):
  pid=tm('display','-p','-t',name,'#{pane_pid}',check=False).strip()
  if pid.isdigit():
    try: os.kill(int(pid),2)
    except ProcessLookupError: pass
  time.sleep(2); tm('kill-session','-t',name,check=False)
try:
  if not (home/'.local/share/kiro-cli/data.sqlite3').exists():
    home.mkdir(exist_ok=True); launch('boot',['--tui'])
    end=time.monotonic()+40
    while time.monotonic()<end and "signed in" not in cap('boot'): time.sleep(.5)
    (out/'boot.txt').write_text(cap('boot')); stop('boot')
    db=sqlite3.connect(home/'.local/share/kiro-cli/data.sqlite3')
    db.execute('INSERT OR REPLACE INTO auth_kv VALUES (?,?)',('kirocli:social:token',json.dumps({'access_token':'offline-dummy-never-valid','refresh_token':'offline-dummy-never-valid','expires_at':'2099-01-01T00:00:00Z','provider':'google','profile_arn':'arn:aws:codewhisperer:us-east-1:000000000000:profile/OFFLINEONLY','region':'us-east-1'})));db.commit();db.close()
  s=home/'.kiro/settings'; s.mkdir(parents=True,exist_ok=True)
  (s/'cli.json').write_text(json.dumps({'chat.defaultModel':model} if model!='-' else {}))
  for label,flags in json.loads(sys.argv[4]):
    launch(label,flags)
    for i in range(8):
      time.sleep(5); c=cap(label); t='\n'.join(c.splitlines()[-22:])
      if '\u276f Trust, continue' in t: tm('send-keys','-t',label,'Enter')
      elif '\u276f No, exit' in t and 'Yes, I accept' in t: tm('send-keys','-t',label,'Down'); time.sleep(.5); tm('send-keys','-t',label,'Enter')
      else: continue
      (out/(label+'-'+model+'-pre'+str(i)+'.txt')).write_text(c)
    time.sleep(5)
    c=cap(label); (out/(label+'-'+model+'.txt')).write_text(c)
    print('=====',ver,label,model,flags); print('\n'.join(l for l in c.splitlines() if l.strip())[-2500:])
    stop(label)
finally:
  tm('kill-server',check=False)
