from pathlib import Path
import os,sys,subprocess,time,json,hashlib,tempfile,shutil
root=Path(sys.argv[1]).resolve();root.mkdir(parents=True,exist_ok=True);repo=Path(sys.argv[2]).resolve();binary=Path(os.environ['CODEX_BINARY']).resolve()
assert hashlib.sha256(binary.read_bytes()).hexdigest()=='cdcb45aaa01d0f14e298985e09465aebccd47f64ecd298aea44814af7b62bbda'
subprocess.run(['/usr/bin/ip','link','set','lo','up'],check=True)
tmp=Path(tempfile.mkdtemp(prefix='m3578-'));sock=tmp/'s';home=root.parent/('.c3578-'+tmp.name[-8:]);home.mkdir();work=tmp/'w';work.mkdir();frames=root/'frames';frames.mkdir(exist_ok=True)
base={'PATH':'/home/han/.nvm/versions/node/v22.22.2/bin:/usr/bin:/bin','HOME':str(home),'CODEX_HOME':str(home),'XDG_CONFIG_HOME':str(home/'.config'),'XDG_DATA_HOME':str(home/'.local/share'),'TERM':'xterm-256color','LANG':'C.UTF-8','LC_ALL':'C.UTF-8','IS_SANDBOX':'1'}
port=48889;(root/'mode').write_text('slow');(home/'config.toml').write_text(f'''model="gpt-5.4"
model_provider="mock"
check_for_update_on_startup=false
project_doc_max_bytes=0
[tui]
status_line=["context-remaining"]
[model_providers.mock]
name="mock"
base_url="http://127.0.0.1:{port}/v1"
wire_api="responses"
requires_openai_auth=false
[projects."{work}"]
trust_level="trusted"
''')
log=(root/'mock-stdio.log').open('w');mock=subprocess.Popen(['node',str(repo/'scripts/manual/codex-version-audit/mock.mjs')],env={**base,'PORT':str(port),'MOCK_MODE_FILE':str(root/'mode'),'MOCK_LOG':str(root/'mock.log'),'SLOW_MS':'45000','MOCK_TEXT':'Offline acceptance finished.'},stdout=log,stderr=subprocess.STDOUT)
T=lambda *a:subprocess.check_output(['/usr/bin/tmux','-f','/dev/null','-S',str(sock),*a],stderr=subprocess.STDOUT)
record={'binarySha256':hashlib.sha256(binary.read_bytes()).hexdigest(),'version':subprocess.check_output([str(binary),'--version'],env=base,text=True).strip(),'netns':os.readlink('/proc/self/ns/net'),'routes':json.loads(subprocess.check_output(['/usr/bin/ip','-j','route'])),'frames':[],'mockOnly':True}
try:
 for _ in range(100):
  if (root/'mock.log').exists() and 'listening' in (root/'mock.log').read_text():break
  if mock.poll() is not None:raise Exception('mock exited')
  time.sleep(.05)
 T('new-session','-d','-s','owned','-x','150','-y','42','-c',str(work),'/usr/bin/env','-i',*[k+'='+v for k,v in base.items()],str(binary),'--no-daemon','--no-alt-screen','--dangerously-bypass-approvals-and-sandbox')
 def pane():return T('capture-pane','-p','-t','owned').decode()
 for _ in range(300):
  p=pane()
  if 'Context' in p and 'Ask Codex to do anything' in p:break
  time.sleep(.05)
 else: (frames/'startup-failure.txt').write_text(p);raise Exception('no ready composer')
 (frames/'idle.txt').write_text(p)
 wire='[agend-human-id: hmsg-00000000-0000-4000-8000-000000003578]\n[user:Test person via discord, id:mock-person] Wait for the local mock response.\n(message_id: m3578-replay-message)'
 (root/'payload.txt').write_text(wire);T('load-buffer','-b','m3578',str(root/'payload.txt'));T('paste-buffer','-p','-b','m3578','-t','owned');time.sleep(.1);(frames/'pasted.txt').write_text(pane())
 before=time.monotonic();p=T('send-keys','-t','owned','Enter',';','capture-pane','-p','-t','owned').decode();(frames/'post-enter-immediate.txt').write_text(p);record['frames'].append({'file':'post-enter-immediate.txt','afterEnterMs':round((time.monotonic()-before)*1000)});prev=p;n=0
 while time.monotonic()-before<4:
  p=pane();at=round((time.monotonic()-before)*1000)
  if p!=prev:
   f=f'post-enter-{n:03d}.txt';(frames/f).write_text(p);record['frames'].append({'file':f,'afterEnterMs':at});prev=p;n+=1
  time.sleep(.025)
 record['uniqueMessageId']='m3578-replay-message';record['scope']='real audited Codex TUI + localhost mock; raw stream capture only, not reporter incident';record['ownedTmp']=str(tmp)
finally:
 try:T('kill-server');closed=True
 except Exception:closed=False
 mock.terminate()
 try:mock.wait(timeout=5)
 except subprocess.TimeoutExpired:mock.kill();mock.wait()
 log.close();shutil.rmtree(tmp);shutil.rmtree(home);record['cleanup']={'privateTmuxClosed':closed,'mockExited':mock.poll() is not None,'ownedHomeTempRemoved':not tmp.exists() and not home.exists()};(root/'receipt.json').write_text(json.dumps(record,indent=2))
print(json.dumps(record))
