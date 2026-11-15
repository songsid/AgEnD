from pathlib import Path
from http.server import ThreadingHTTPServer,BaseHTTPRequestHandler
import json,ssl,threading,subprocess,time,os,re
root=Path('/rig');out=root/'out'/os.environ.get('RIG_VERSION','1.5.9');out.mkdir(parents=True,exist_ok=True);home=Path('/home/rig');base=home/'.gemini/antigravity-cli';base.mkdir(parents=True,exist_ok=True);(base/'cache').mkdir(exist_ok=True)
token={'access_token':'rig-fake-token','refresh_token':'rig-fake-refresh','token_type':'Bearer','expiry':'2099-01-01T00:00:00Z','auth_method':'consumer','email':'rig@example.invalid'}
(base/'antigravity-oauth-token').write_text(json.dumps({**token,'token':token}))
(base/'cache/onboarding.json').write_text(json.dumps({'consumerOnboardingComplete':True,'enterpriseOnboardingComplete':True,'onboardingComplete':True}))
(base/'settings.json').write_text(json.dumps({'telemetryEnabled':False}))
version = subprocess.run(['/rig/bin/agy', '--version'], capture_output=True, text=True, timeout=10)
(out/'version.txt').write_text(version.stdout + version.stderr)
found=re.search(r'\b(\d+\.\d+\.\d+)\b',version.stdout+version.stderr)
if not found or found.group(1)!=os.environ['RIG_VERSION']:raise RuntimeError('Binary version does not match capture label')
models={k:{'displayName':label,'model':i+1} for i,(k,label) in enumerate([('gemini-3.8-flash-low','Gemini 3.8 Flash (Low)'),('gemini-3.8-flash-medium','Gemini 3.8 Flash (Medium)'),('gemini-3.8-flash-high','Gemini 3.8 Flash (High)'),('claude-sonnet-5-5-low','Claude Sonnet 5.5 (Low)'),('claude-sonnet-5-5-high','Claude Sonnet 5.5 (High)')])}
class H(BaseHTTPRequestHandler):
 def log_message(self,*a):pass
 def do_GET(self):self.answer()
 def do_POST(self):self.rfile.read(int(self.headers.get('Content-Length',0)));self.answer()
 def answer(self):
  with (out/'paths.jsonl').open('a') as f:f.write(json.dumps({'path':self.path})+'\n')
  if 'fetchAvailableModels' in self.path:r={'models':models,'defaultAgentModelId':'gemini-3.8-flash-medium','agentModelSorts':[{'groups':[{'modelIds':list(models)}]}]}
  elif 'userinfo' in self.path:r={'email':'rig@example.invalid','verified_email':True,'name':'Rig'}
  elif 'loadCodeAssist' in self.path:r={'cloudaicompanionProject':'rig-project','currentTier':{'id':'standard-tier','name':'Rig'}}
  else:r={}
  raw=json.dumps(r).encode();self.send_response(200);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(raw)));self.end_headers();self.wfile.write(raw)
server=ThreadingHTTPServer(('127.0.0.1',443),H);ctx=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER);ctx.load_cert_chain('/rig/cert/cert.pem','/rig/cert/key.pem');server.socket=ctx.wrap_socket(server.socket,server_side=True);threading.Thread(target=server.serve_forever,daemon=True).start()
def tm(*a):return subprocess.run(['/usr/bin/tmux','-L','agy3180',*a],capture_output=True,text=True,timeout=5)
try:
 tm('new-session','-d','-s','rig','-x','140','-y','42','-c','/work','/rig/bin/agy'+' --model gemini-3.8-flash-medium');tm('set-option','-t','rig','remain-on-exit','on')
 for i in range(30):
  time.sleep(.5);pane=tm('capture-pane','-p','-t','rig','-S','-120').stdout;(out/'start.txt').write_text(pane)
  if 'trust the contents' in pane.lower():tm('send-keys','-t','rig','Enter')
  if '> Auto mode:' in pane or '? for shortcuts' in pane:break
 print(pane,flush=True)
 if 'not signed in' in pane:raise RuntimeError('Fake token not accepted; no switch command sent')
 for i,cmd in enumerate(['/model claude-sonnet-5-5-high','/effort low','/model definitely-unknown']):
  tm('set-buffer','-b','rig',cmd);tm('paste-buffer','-p','-d','-b','rig','-t','rig');tm('send-keys','-t','rig','Enter');time.sleep(2)
  pane=tm('capture-pane','-p','-t','rig','-S','-160').stdout;(out/f'switch-{i}.txt').write_text(pane);print(pane[-5000:],flush=True)
  for name in ['settings.json']:
   if (base/name).exists():(out/f'{i}-{name}').write_text((base/name).read_text())
 if os.environ.get('DAEMON_PROOF') == '1':
  ah=root/'agend';(ah/'cli-env').mkdir(parents=True,exist_ok=True);(root/'inst').mkdir(exist_ok=True)
  (ah/'cli-env/antigravity.json').write_text(json.dumps({'probedAt':int(time.time()*1000),'models':[{'id':k,'label':v['displayName']} for k,v in models.items()]}))
  env={**os.environ,'AGEND_HOME':str(ah),'AGEND_TMUX_BIN':'/usr/bin/tmux','SOCK':'agy3180','SESSION':'rig','INST':'/rig/inst','WORKDIR':'/work'}
  specs=[{'model':'claude-sonnet-5-5-high','effort':None},{'model':None,'effort':'low'}]
  proof=subprocess.run(['/rig/bin/node','/repo/node_modules/tsx/dist/cli.mjs','/repo/scripts/manual/agy-version-audit/daemon-switch.mts',*[json.dumps(w) for w in specs]],env=env,capture_output=True,text=True,timeout=180)
  (out/'daemon-proof.log').write_text(proof.stdout+proof.stderr)
  if proof.returncode:raise RuntimeError('Production daemon proof failed; inspect daemon-proof.log')

finally:tm('kill-session','-t','rig');tm('kill-server');server.shutdown()
