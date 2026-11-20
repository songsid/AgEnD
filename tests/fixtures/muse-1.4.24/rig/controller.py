import os,json,subprocess,time,shlex
from pathlib import Path
R=Path('/home/u');A=R/'audit';W=R/'work';O=R/'out';S='/tmp/muse-m3396.sock'
for p in [A,W,O]:p.mkdir(parents=True,exist_ok=True)
(A/'mockcatalog').write_text('{"data":[{"id":"mock-model"}]}')
(A/'mockmode').write_text('text')
mock=subprocess.Popen(['python3','/harness/mock.py'],stdout=(O/'mock.stderr').open('w'),stderr=subprocess.STDOUT)
H=None
META=['--provider','meta','--base-url','http://127.0.0.1:18800','--model','mock-model'];PROD=['--disable-approval','--trust-workspace']
rows=[]
launch_seq=0
def tm(*args,check=True):
 p=subprocess.run(['tmux','-S',S,'-f','/dev/null',*args],text=True,capture_output=True,timeout=5)
 if check and p.returncode:raise RuntimeError(p.stderr)
 return p.stdout

def pane():return tm('capture-pane','-p','-t','m')
def cap(name):
 s='\n'.join(x.rstrip() for x in pane().splitlines())+'\n'
 if not s.strip():raise RuntimeError('blank capture '+name)
 (O/(name+'.pane.txt')).write_text(s);rows.append(name)
 (O/'captures.json').write_text(json.dumps(rows));return s

def wait(pred,label,timeout=18):
 end=time.monotonic()+timeout
 while time.monotonic()<end:
  s=pane()
  if pred(s):return s
  time.sleep(.1)
 cap('FAILED-'+label);raise RuntimeError('timeout '+label)
def has(s):return wait(lambda x:s in x,s.replace('/','_')[:35])
def keys(*args):tm('send-keys','-t','m',*args)
def paste(s):
 tm('set-buffer','--',s);tm('paste-buffer','-p','-d','-t','m');time.sleep(.12);keys('Enter')
def mode(s,args=None):
 (A/'mockmode').write_text(s)
 if args is not None:(A/'mockargs').write_text(json.dumps(args))
def start(label,args,key=True,width=120):
 global H,launch_seq
 launch_seq+=1
 tm('kill-session','-t','m',check=False)
 H=R/('h-'+label);H.mkdir(exist_ok=True)
 env={'HOME':str(H),'XDG_CONFIG_HOME':str(H/'.config'),'PATH':'/usr/bin:/bin','TERM':'xterm-256color','LANG':'C.UTF-8','MUSE_UPDATE_INTERVAL_SECONDS':'31536000'}
 if key:env['META_API_KEY']='offline-dummy-key'
 command=shlex.join(['env','-i',*[k+'='+v for k,v in env.items()],'/audit-muse',*args])
 gate='launch-'+str(launch_seq)
 command=shlex.join(['tmux','-S',S,'wait-for',gate])+'; exec '+command
 tm('new-session','-d','-s','m','-x',str(width),'-y','36','-c',str(W),command)
 tm('set-option','-t','m','remain-on-exit','on')
 tm('wait-for','-S',gate)
def idle():return wait(lambda s: 'Muse Code' in s and '\n❯\n' in s and ('mock-model' in s or 'echo' in s) and 'Thinking (' not in s,'idle')
def sid():
 p=H/'.local/share/muse/sessions'
 fs=list(p.glob('*/*/*/*/session.jsonl'))
 if len(fs)!=1:raise RuntimeError('ambiguous session')
 return fs[0].parent.name
try:
 # Server is ready before a CLI can make its first local request.
 import socket
 end=time.monotonic()+5
 while True:
  try:
   with socket.create_connection(('127.0.0.1',18800),timeout=.2):break
  except OSError:
   if time.monotonic()>end:raise
   time.sleep(.05)
 if os.environ.get('AUDIT_PHASE')=='full':
  start('echo',['--provider','echo',*PROD,'--echo-delay-ms','1600'],False);idle();cap('echo-idle')
  paste('hello echo');has('Thinking');cap('echo-busy');has('hello echo');wait(lambda s:'Thinking (' not in s and '◆' in s,'echo-done');cap('echo-done')
  paste('cancel me');has('Thinking');keys('Escape');wait(lambda s:'Thinking (' not in s,'cancel');cap('echo-after-escape');keys('C-u');paste('/quit');has('To continue this session');cap('echo-quit');session=sid()
  start('echo',['--provider','echo',*PROD,'resume',session],False);idle();cap('echo-resumed')
 if os.environ.get('AUDIT_PHASE') in ['full','after-echo']:
  # Fast error paths restore the alternate screen before a dead-pane capture.
  # Keep the exact process output separately, rather than fabricate a pane.
  missinghome=R/'h-missing';missinghome.mkdir(exist_ok=True)
  menv={'HOME':str(missinghome),'PATH':'/usr/bin:/bin','TERM':'xterm-256color','LANG':'C.UTF-8'}
  result=subprocess.run(['/audit-muse','--provider','echo',*PROD,'resume','01a00000-0000-7000-8000-000000000000'],cwd=W,env=menv,capture_output=True,timeout=8)
  (O/'resume-missing.stdout').write_bytes(result.stdout);(O/'resume-missing.stderr').write_bytes(result.stderr)
  (O/'resume-missing.exit').write_text(str(result.returncode))
  version=subprocess.run(['/audit-muse','--version'],env=menv,capture_output=True,timeout=8)
  (O/'version.txt').write_bytes(version.stdout+version.stderr)
  start('trust',META);has('Do you trust this workspace');cap('first-run-trust-dialog')
  start('logged-out',['--trust-workspace'],False);wait(lambda s:'Log in' in s or 'Set an API key' in s,'logged-out');cap('logged-out')
 if os.environ.get('AUDIT_PHASE') not in ['rates','untrusted']:
  mode('text');start('meta',META+PROD);idle();cap('meta-idle');paste('say something');has('mock reply ok');wait(lambda s:'Thinking (' not in s,'meta-done');cap('meta-done')
  mode('tool',{'command':'echo hi','sandbox_permissions':'require_escalated','justification':'audit'})
  start('escalated',META+PROD);idle();paste('do it');wait(lambda s:'denied' in s.lower() or 'not allowed' in s.lower(),'denied');cap('prod-escalation-denied')
  start('approval',META+['--trust-workspace']);idle();paste('do it');wait(lambda s:'Would you like' in s or 'Allow this' in s or 'Approve' in s,'approval');cap('approval-escalated');keys('Escape');wait(lambda s:'Would you like' not in s,'after-esc');cap('approval-escalated-after-esc')
 if os.environ.get('AUDIT_PHASE')!='rates':
  mode('tool',{'command':'ls -la'})
  start('untrusted',META+['--trust-workspace','--approval-mode','untrusted']);idle();paste('do it');wait(lambda s:'Would you like' in s or 'Allow this' in s or 'Approve' in s,'untrusted');cap('approval-untrusted-staged');wait(lambda s:'Would you like to run the following command?' in s,'untrusted-active');cap('approval-untrusted-active');keys('1');has('mock reply ok');cap('approval-untrusted-after-1')
 for width in [int(v) for v in os.environ.get('WIDTHS','120,80').split(',')]:
  mode('429');start('rate-'+str(width),META+PROD,width=width);idle();paste('do it');has('retrying');cap('rate-retrying-'+str(width))
  wait(lambda s:'model failed:' in s,'rate-exhausted',45);cap('rate-exhausted-'+str(width))
  mode('402');start('quota-'+str(width),META+PROD,width=width);idle();paste('do it');has('Usage limit reached');cap('quota-'+str(width))
 (O/'result.json').write_text(json.dumps({'complete':True,'captures':len(rows)}))
finally:
 tm('kill-server',check=False);mock.terminate();mock.wait(timeout=5)
