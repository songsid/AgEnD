from pathlib import Path
from http.server import ThreadingHTTPServer,BaseHTTPRequestHandler
import subprocess,threading,time,json,os,re
root=Path('/rig');out=root/'out';out.mkdir(exist_ok=True)
(Path('/home/rig/.grok')/'models_cache.json').unlink(missing_ok=True)
class H(BaseHTTPRequestHandler):
 def log_message(self,*a):pass
 def do_GET(self):self.answer()
 def do_POST(self):self.rfile.read(int(self.headers.get('Content-Length',0)));self.answer()
 def answer(self):
  with (out/'paths.jsonl').open('a') as f:f.write(json.dumps({'path':self.path})+'\n')
  obj={'object':'list','data':[{'id':x,'object':'model','owned_by':'mock','supports_reasoning_effort':True,'reasoning_efforts':['low','medium','high','xhigh'],'reasoning_effort_server_default':'medium'} for x in ['grok-code-fast-1','grok-4','grok-4-fast']]}
  raw=json.dumps(obj if 'models' in self.path else {}).encode();self.send_response(200);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(raw)));self.end_headers();self.wfile.write(raw)
version = subprocess.run(['/rig/bin/grok', '--version'], capture_output=True, text=True, timeout=10)
(out/'version.txt').write_text(version.stdout + version.stderr)
found=re.search(r'\b(\d+\.\d+\.\d+)\b',version.stdout+version.stderr)
if not found or found.group(1)!=os.environ['RIG_VERSION']:raise RuntimeError('Binary version differs from capture label')
server=ThreadingHTTPServer(('127.0.0.1',18080),H);threading.Thread(target=server.serve_forever,daemon=True).start()
def tm(*a):return subprocess.run(['/usr/bin/tmux','-L','grok3180',*a],capture_output=True,text=True,timeout=5)
try:
 tm('new-session','-d','-s','rig','-x','140','-y','44','-c','/work','/rig/bin/grok --no-auto-update --model grok-code-fast-1');tm('set-option','-t','rig','remain-on-exit','on')
 for i in range(40):
  time.sleep(.5);pane=tm('capture-pane','-p','-t','rig','-S','-120').stdout;(out/'before.txt').write_text(pane)
  if 'trust' in pane.lower() and ('Yes' in pane or 'Trust' in pane):tm('send-keys','-t','rig','Enter')
  if 'Help improve Grok' in pane:tm('send-keys','-t','rig','Escape')
  if 'Ctrl+x:shortcuts' in pane or 'for shortcuts' in pane or 'Type a message' in pane:break
 print(pane,flush=True)
 for i,cmd in enumerate(['/model grok-4 high','/effort low','/model definitely-unknown']):
  tm('set-buffer','-b','rig',cmd);tm('paste-buffer','-p','-d','-b','rig','-t','rig');time.sleep(.3);tm('send-keys','-t','rig','Enter');time.sleep(2)
  pane=tm('capture-pane','-p','-t','rig','-S','-160').stdout;(out/f'switch-{i}.txt').write_text(pane);print(pane[-4000:],flush=True)
finally:tm('kill-session','-t','rig');tm('kill-server');server.shutdown()
