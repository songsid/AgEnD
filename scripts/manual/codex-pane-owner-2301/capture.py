import os,pathlib,subprocess,time,json,hashlib,socket,shutil,signal,shlex
REPO=pathlib.Path(__file__).resolve().parents[3]
ROOT=pathlib.Path(os.environ['OUT']).resolve()
RUN=pathlib.Path(os.environ['RUN_ROOT']).resolve()
if not (RUN.is_relative_to(REPO/'.ca') or RUN.is_relative_to(REPO/'.artifacts')):raise SystemExit('RUN_ROOT must be an owned scratch path in this checkout')
RUN.mkdir(parents=True,exist_ok=False);OUT=ROOT;OUT.mkdir(parents=True,exist_ok=True)
assert {name for _,name in socket.if_nameindex()}=={'lo'},'loopback namespace required'
subprocess.run(['ip','link','set','lo','up'],check=True)
for n in ['home','codex','work']:(RUN/n).mkdir(exist_ok=True)
subprocess.run(['git','init','-q',str(RUN/'work')],check=True)
binary=pathlib.Path(os.environ['CODEX_AUDIT_BIN']).resolve()
assert hashlib.sha256(binary.read_bytes()).hexdigest()=='cdcb45aaa01d0f14e298985e09465aebccd47f64ecd298aea44814af7b62bbda'
sock=str(RUN/'tmux.sock')
def tmux(*args):return subprocess.check_output(['/usr/bin/tmux','-f','/dev/null','-S',sock,*args],text=True)
def pane():return tmux('capture-pane','-p','-t','cx')
def wait(pred,seconds=20):
 end=time.monotonic()+seconds
 while time.monotonic()<end:
  p=pane()
  if pred(p):return p
  time.sleep(.1)
 raise RuntimeError('pane wait expired: '+pane())
config='''model="mock-model"
model_provider="mock"
check_for_update_on_startup=false
[model_providers.mock]
name="mock"
base_url="http://127.0.0.1:18882/v1"
wire_api="responses"
requires_openai_auth=false
[tui]
status_line=ITEMS
'''
mock=subprocess.Popen([shutil.which('node'),str(pathlib.Path(__file__).with_name('mock.mjs'))],env={'PATH':'/usr/bin:/bin','MOCK_LOG':str(RUN/'http.log')})
try:
 time.sleep(.3)
 def launch(items,resume=None):
  (RUN/'codex/config.toml').write_text(config.replace('ITEMS',json.dumps(items))+'\n[projects.'+json.dumps(str(RUN/'work'))+']\ntrust_level="trusted"\n')
  env='env -i '+' '.join(shlex.quote(k+'='+str(v)) for k,v in {'HOME':RUN/'home','CODEX_HOME':RUN/'codex','PATH':'/usr/bin:/bin','TERM':'xterm-256color','LANG':'C.UTF-8'}.items())+' '
  cmd=env+shlex.quote(str(binary))+' --dangerously-bypass-approvals-and-sandbox --no-alt-screen'+(' resume '+shlex.quote(resume) if resume else '')
  tmux('new-session','-d','-s','cx','-x','120','-y','24','-c',str(RUN/'work'),cmd+'; sleep 60')
  return wait(lambda p:'Ask Codex to do anything' in p and 'Context ' in p)
 before=launch(['context-remaining','model-with-reasoning','current-dir'])
 (OUT/'before-ready.pane.txt').write_text(before)
 tmux('set-buffer','--','private footer capture: print inert diagnostic rows');tmux('paste-buffer','-p','-t','cx');time.sleep(.3);tmux('send-keys','-t','cx','Enter')
 wait(lambda p:'Inert mock diagnostic row 80:' in p)
 files=list((RUN/'codex/sessions').rglob('rollout-*.jsonl'));assert len(files)==1
 meta=json.loads(files[0].read_text().splitlines()[0]);sid=meta['payload']['id']
 tmux('kill-session','-t','cx')
 after=launch(['session-id','context-remaining','model-with-reasoning','current-dir'],sid)
 (OUT/'after-ready-120.pane.txt').write_text(after)
 text='[quiet-heartbeat-2301] Check the inert task board; if nothing changed, stay silent.'
 tmux('set-buffer','--',text);tmux('paste-buffer','-p','-t','cx');time.sleep(.3)
 (OUT/'after-pasted.pane.txt').write_text(pane());tmux('send-keys','-t','cx','Enter')
 time.sleep(2);(OUT/'after-fast.pane.txt').write_text(pane());shutil.copyfile(files[0],OUT/'rollout.jsonl')
 for width in [100,80,45,30]:
  tmux('resize-window','-t','cx','-x',str(width),'-y','24');time.sleep(.5);(OUT/f'after-ready-{width}.pane.txt').write_text(pane())
 (OUT/'receipt.json').write_text(json.dumps({'version':'0.167.0','binarySha256':hashlib.sha256(binary.read_bytes()).hexdigest(),'sessionId':sid,'rawText':text,'isolated':'unshare user+network namespace; loopback only','account':False,'ownedSocket':sock,'launches':2,'requestsLog':str(RUN/'http.log')},indent=2)+'\n')
 print('captured',sid,flush=True)
finally:
 try:tmux('kill-server')
 except:pass
 mock.terminate();mock.wait(timeout=5)
 for f in sorted((RUN/'codex/app-server-daemon').glob('*.pid'),key=lambda p:0 if 'updater' in p.name else 1):
  pid=json.loads(f.read_text()).get('pid');p=pathlib.Path(f'/proc/{pid}')
  try:
   if b'CODEX_HOME='+str(RUN/'codex').encode() in (p/'environ').read_bytes().split(b'\0') and (p/'exe').resolve().is_relative_to(RUN/'codex/packages'):os.kill(pid,signal.SIGTERM)
  except FileNotFoundError:pass

 shutil.rmtree(RUN)
 if (OUT/'receipt.json').exists():
  receipt=json.loads((OUT/'receipt.json').read_text());receipt['cleanup']={'ownedTmuxStopped':True,'ownedDaemonsSignalled':True,'scratchHomeRemoved':not RUN.exists()};(OUT/'receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
