# Run only in the documented disposable, network-disabled container.
import pathlib,subprocess,time,json,os,socket
if not pathlib.Path('/.dockerenv').is_file() or os.environ.get('AGEND_CODEX_429_REPRO') != 'private-container':
 raise SystemExit('Use the dedicated network-disabled audit container; never run this on the host')
if {name for _,name in socket.if_nameindex()} != {'lo'}:
 raise SystemExit('This reproduction requires --network none')
r=pathlib.Path('/home/rh/cx');s=str(r/'t.sock')
def t(*args):return subprocess.run(['tmux','-S',s,*args],text=True,capture_output=True,check=True).stdout
(r/'mode').write_text('e429')
(r/'code/config.toml').write_text('''model = "mock-model"
model_provider = "mock"
check_for_update_on_startup = false
[model_providers.mock]
name = "mock"
base_url = "http://127.0.0.1:18882/v1"
wire_api = "responses"
requires_openai_auth = false
request_max_retries = 1
stream_max_retries = 1
[tui]
status_line = ["context-remaining"]
''')
t('new-session','-d','-s','cx','-x','140','-y','38','-c',str(r/'work'),f'env -i HOME={r}/home CODEX_HOME={r}/code PATH=/usr/local/bin:/usr/bin:/bin TERM=xterm-256color LANG=C.UTF-8 /opt/codex-audit/bin/codex --dangerously-bypass-approvals-and-sandbox --no-alt-screen')
def cap(label):
 p=t('capture-pane','-p','-t','cx');(r/(label+'.pane.txt')).write_text(p);return p
for _ in range(40):
 time.sleep(.25);p=cap('idle')
 if '›' in p:break
else:raise RuntimeError(p)
for label,prompt,mode in [('exhausted429','please reply to this audit request','e429'),('repeated429','please try again','e429'),('recovered','Continue only if the last request is unfinished; if it is done, reply that it is done.','ok'),('insufficient-quota','test exhausted quota','insufficient')]:
 previous=cap('before-'+label)
 (r/'mode').write_text(mode);t('set-buffer','--',prompt);t('paste-buffer','-p','-t','cx');time.sleep(.4);t('send-keys','-t','cx','Enter')
 for _ in range(120):
  time.sleep(.25);p=cap(label)
  if mode=='e429' and p.count('exceeded retry limit')>previous.count('exceeded retry limit') and 'esc to interrupt' not in p:break
  if mode=='ok' and '• ok' in p and 'esc to interrupt' not in p:break
  if mode=='insufficient' and 'Quota exceeded. Check your plan and billing details.' in p and 'esc to interrupt' not in p:break
 else:raise RuntimeError('Expected terminal result missing: '+label)
 print(label,p,flush=True)
 time.sleep(.5)
print('version',subprocess.check_output(['/opt/codex-audit/bin/codex','--version'],text=True))
