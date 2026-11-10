from pathlib import Path
import os,sys,subprocess,time,json,tempfile,hashlib,shutil
import mock
repo=Path(sys.argv[1]).resolve();root=Path(sys.argv[2]).resolve();root.mkdir(parents=True,exist_ok=True);(root/'requests').mkdir(exist_ok=True);subprocess.run(['/usr/bin/ip','link','set','lo','up'],check=True)
server=mock.serve(root);port=server.server_address[1];tmp=Path(tempfile.mkdtemp(prefix='l3578-'));sock=tmp/'s';base={'PATH':'/home/han/.nvm/versions/node/v22.22.2/bin:/usr/bin:/bin','TERM':'xterm-256color','LANG':'C.UTF-8','LC_ALL':'C.UTF-8','IS_SANDBOX':'1'}
T=lambda *a:subprocess.check_output(['/usr/bin/tmux','-f','/dev/null','-S',str(sock),*a],stderr=subprocess.STDOUT)
T('new-session','-d','-s','hold','/usr/bin/sleep','600');T('set-window-option','-g','remain-on-exit','on')
binaries={'codex':repo.parents[1]/'.artifacts/m2739/packages/codex-linux/package/vendor/x86_64-unknown-linux-musl/bin/codex','claude-code':repo.parents[1]/'.artifacts/m2739/r/bin/claude'};results=[];homes=[];receipts=[]
try:
 for name,binary in binaries.items():
  home=repo.parents[1]/('.l3578-'+name+'-'+tmp.name[-8:]);home.mkdir(exist_ok=False);homes.append(home);work=tmp/name;work.mkdir();out=root/name;out.mkdir(exist_ok=True);env={**base,'HOME':str(home),'XDG_CONFIG_HOME':str(home/'.config'),'XDG_DATA_HOME':str(home/'.local/share')}
  receipt={'backend':name,'binarySha256':hashlib.sha256(binary.read_bytes()).hexdigest(),'version':subprocess.check_output([str(binary),'--version'],env=env,text=True).strip()};receipts.append(receipt)
  if name=='codex':
   env['CODEX_HOME']=str(home);(home/'config.toml').write_text(f'''model="gpt-5.4"
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
''');args=['--no-daemon','--no-alt-screen','--dangerously-bypass-approvals-and-sandbox']
  else:
   config=home/'.claude';config.mkdir();key='mock-local-key';env.update(CLAUDE_CONFIG_DIR=str(config),ANTHROPIC_BASE_URL=f'http://127.0.0.1:{port}',ANTHROPIC_API_KEY=key,DISABLE_AUTOUPDATER='1',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC='1',DISABLE_TELEMETRY='1',DISABLE_ERROR_REPORTING='1')
   (config/'.claude.json').write_text(json.dumps({'hasCompletedOnboarding':True,'lastOnboardingVersion':'2.1.319','numStartups':5,'theme':'dark','customApiKeyResponses':{'approved':[key[-20:]],'rejected':[]},'projects':{str(work):{'hasTrustDialogAccepted':True,'hasCompletedProjectOnboarding':True,'allowedTools':[]}}}));(config/'settings.json').write_text('{"theme":"dark"}');(home/'empty-mcp.json').write_text('{"mcpServers":{}}');args=['--strict-mcp-config','--mcp-config',str(home/'empty-mcp.json'),'--tools','','--model','claude-sonnet-4-5']
  target=name
  def launch(extra=[]):T('new-session','-d','-s',target,'-x','150','-y','42','-c',str(work),'/usr/bin/env','-i',*[k+'='+v for k,v in env.items()],str(binary),*args,*extra)
  def cap():return T('capture-pane','-p','-t',target).decode()
  def wait(pred,seconds=20):
   end=time.monotonic()+seconds
   while time.monotonic()<end:
    p=cap()
    if pred(p):return p
    time.sleep(.05)
   (out/'failure.pane.txt').write_text(p);raise Exception(name+' readiness/response timeout')
  launch();wait(lambda p:'Ask Codex to do anything' in p and 'Context' in p and 'Waiting for startup' not in p if name=='codex' else 'bypass permissions' in p or 'for shortcuts' in p)
  for scenario in ['idle','busy','resumed']:
   (root/'mode').write_text('busy' if scenario=='busy' else 'ok')
   if scenario=='busy':
    T('send-keys','-t',target,'-l','BUSYSEED');wait(lambda p:'BUSYSEED' in p);time.sleep(.2);T('send-keys','-t',target,'Enter');wait(lambda p:'esc to interrupt' in p)
   if scenario=='resumed':
    if name=='codex':
     meta=next(json.loads(line)['payload'] for p in home.glob('sessions/**/*.jsonl') for line in p.read_text().splitlines() if json.loads(line).get('type')=='session_meta');extra=['resume',meta['id']]
    else:
     files=list((home/'.claude/projects').rglob('*.jsonl'));session=next(p.stem for p in files if len(p.stem)==36);extra=['--resume',session]
    T('kill-session','-t',target);launch(extra);wait(lambda p:'Ask Codex to do anything' in p and 'Context' in p and 'Waiting for startup' not in p if name=='codex' else 'Offline mock completed.' in p)
   cmd=['node','--import',str(repo/'node_modules/tsx/dist/loader.mjs'),str(root.parent/'live-confirm.mts'),str(repo),str(out),str(sock),target,name,scenario]
   r=subprocess.run(cmd,env=env,cwd=work,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,timeout=40,text=True);(out/(scenario+'.log')).write_text(r.stdout)
   if r.returncode:raise Exception(name+' '+scenario+' acceptance failed')
   results.append(json.loads((out/(scenario+'-result.json')).read_text()));wait(lambda p:'Offline mock completed.' in p and 'esc to interrupt' not in p)
  T('kill-session','-t',target)
finally:
 try:T('kill-server')
 except:pass
 server.shutdown();server.server_close();shutil.rmtree(tmp)
 for h in homes:shutil.rmtree(h)
 (root/'receipt.json').write_text(json.dumps({'versions':receipts,'results':results,'routes':json.loads(subprocess.check_output(['/usr/bin/ip','-j','route'])),'scope':'private real CLI/mock confirmation, no live fleet/accounts/vendors','cleanup':{'homesRemoved':all(not h.exists()for h in homes),'privateTmuxClosed':not sock.exists(),'tempRemoved':not tmp.exists(),'mockClosed':True}},indent=2))
print(json.dumps(results))
