import os,sys,json,time,subprocess,threading
from pathlib import Path
import mock
ROOT=Path(sys.argv[1]).resolve();ROOT.mkdir(exist_ok=True);sock=ROOT/'s';work=ROOT/'work';work.mkdir(exist_ok=True);(ROOT/'frames').mkdir(exist_ok=True)
run=lambda args,**kw:subprocess.run(args,check=True,**kw)
run(['/usr/bin/ip','link','set','lo','up']);server=mock.serve(ROOT);port=server.server_address[1]
codex=Path(os.environ['AUDIT_CODEX_BIN']).resolve();claude=Path(os.environ['AUDIT_CLAUDE_BIN']).resolve();node=os.environ.get('AUDIT_NODE_DIR','/usr/bin')
assert codex.is_file() and claude.is_file(), 'supply owned audited binaries, never a host CLI probe'
base={'PATH':node+':/usr/bin:/bin','TERM':'xterm-256color','LANG':'C.UTF-8','LC_ALL':'C.UTF-8','IS_SANDBOX':'1'}
envs={}
for name in ['claude','codex']:
 h=ROOT/('codex3' if name=='codex' else name);h.mkdir(exist_ok=True);env={**base,'HOME':str(h),'XDG_CONFIG_HOME':str(h/'.config'),'XDG_DATA_HOME':str(h/'.local/share'),'XDG_CACHE_HOME':str(h/'.cache'),'XDG_STATE_HOME':str(h/'.local/state')};envs[name]=env
 if name=='claude':
  c=h/'.claude';c.mkdir(exist_ok=True);key='sk-ant-api03-'+'test'*22+'-testtestAA';env.update(CLAUDE_CONFIG_DIR=str(c),ANTHROPIC_BASE_URL=f'http://127.0.0.1:{port}',ANTHROPIC_API_KEY=key,DISABLE_AUTOUPDATER='1',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC='1',DISABLE_TELEMETRY='1',DISABLE_ERROR_REPORTING='1')
  (c/'.claude.json').write_text(json.dumps({'hasCompletedOnboarding':True,'lastOnboardingVersion':'2.1.319','numStartups':5,'theme':'dark','customApiKeyResponses':{'approved':[key[-20:]],'rejected':[]},'projects':{str(work):{'hasTrustDialogAccepted':True,'hasCompletedProjectOnboarding':True,'allowedTools':[]}}}));(c/'settings.json').write_text(json.dumps({'theme':'dark'}));(ROOT/'empty-mcp.json').write_text('{"mcpServers":{}}')
 else:
  env['CODEX_HOME']=str(h);(h/'config.toml').write_text(f'''model = "gpt-5.4"
model_provider = "mock"
check_for_update_on_startup = false
project_doc_max_bytes = 0
[model_providers.mock]
name = "mock"
base_url = "http://127.0.0.1:{port}/v1"
wire_api = "responses"
requires_openai_auth = false
[features]
multi_agent = true
[projects."{work}"]
trust_level = "trusted"
''')
for name,binary in [('claude',claude),('codex',codex)]:
 for flag in ['--help','--version']:
  r=subprocess.run([str(binary),flag],env=envs[name],cwd=work,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,timeout=30);(ROOT/f'{name}-{flag[2:]}.txt').write_bytes(r.stdout)
T=lambda args,**kw:run(['/usr/bin/tmux','-f','/dev/null','-S',str(sock),*args],**kw)
T(['new-session','-d','-s','hold','-x','160','-y','50','/usr/bin/sleep','1800'])
receipt={'pid':os.getpid(),'netns':os.readlink('/proc/self/ns/net'),'routes':json.loads(subprocess.check_output(['/usr/bin/ip','-j','route','show'])),'interfaces':json.loads(subprocess.check_output(['/usr/bin/ip','-j','link','show'])),'port':port,'commands':[]}
(ROOT/'receipt.json').write_text(json.dumps(receipt,indent=2));(ROOT/'ready.json').write_text(json.dumps(receipt,indent=2));print('READY',json.dumps({'pid':os.getpid(),'netns':receipt['netns'],'port':port}),flush=True)
start=time.monotonic();n=max([int(p.stem.split('-')[-1])for p in ROOT.glob('control-*.json')]+[0])
try:
 while time.monotonic()-start<1800 and not(ROOT/'stop').exists():
  f=ROOT/'control.json'
  if f.exists():
   n+=1;c=json.loads(f.read_text());f.rename(ROOT/f'control-{n}.json');kind=c['action']
   try:
    if kind=='launch':
     name=c['backend'];binary=claude if name=='claude' else codex;argv=['new-session','-d','-s',c.get('session',name),'-x','160','-y','50','-c',str(work),'/usr/bin/env','-i',*[k+'='+v for k,v in envs[name].items()],str(binary),*c['args']];T(argv)
    elif kind=='send':T(['send-keys','-t',c['session'],'-l','--',c['text']]);time.sleep(.15);T(['send-keys','-t',c['session'],'Enter'])
    elif kind=='key':T(['send-keys','-t',c['session'],*c['keys']])
    elif kind=='capture':(ROOT/'frames'/c['name']).write_bytes(subprocess.check_output(['/usr/bin/tmux','-S',str(sock),'capture-pane','-p','-S','-300','-t',c['session']]))
    elif kind=='exec-info':pass
    elif kind=='stop':break
    else:raise ValueError(kind)
    receipt['commands'].append({'n':n,'action':kind,'ok':True});print('DONE',n,kind,flush=True)
   except Exception as e:receipt['commands'].append({'n':n,'action':kind,'error':str(e)});print('ERROR',n,str(e),flush=True)
   (ROOT/'receipt.json').write_text(json.dumps(receipt,indent=2))
  time.sleep(.1)
finally:
 r=subprocess.run(['/usr/bin/tmux','-S',str(sock),'kill-server'],stdout=subprocess.PIPE,stderr=subprocess.PIPE);server.shutdown();receipt['cleanup']={'tmuxClosed':r.returncode==0,'serverClosed':True};(ROOT/'receipt.json').write_text(json.dumps(receipt,indent=2));print('CLEANED',flush=True)
