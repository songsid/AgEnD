#!/usr/bin/env python3
"""Unmodified2.36/3.0 offline exact-ID control, run each phase in its own network-none container."""
import os,sys,json,sqlite3,shutil,subprocess,time,re,shlex,hashlib
from pathlib import Path
assert os.geteuid()==1000
assert all(row.split()[0]=='lo' for row in Path('/proc/net/route').read_text().splitlines()[1:] if row.split())
os.sched_setaffinity(0,{min(os.sched_getaffinity(0))})
root=Path(os.environ['PROOF_ROOT']);phase=os.environ['PROOF_PHASE'];assert phase in ['2','3']
assert re.fullmatch(r'[0-9a-f]{40}',os.environ.get('PROOF_SOURCE_HEAD','')),'Bind the source commit'
binary=os.environ['KIRO_BINARY'];socket='sol-k3-resume-'+str(os.getpid())
home=root/'home';cwd=root/'work';cwd.mkdir(parents=True,exist_ok=True)
fixture=Path('tests/fixtures/kiro-3.0.0-tui-resume')
meta=json.loads((fixture/'session.json').read_text());sid=meta['session_id'];decoy='30470000-3047-4fd7-9bed-875dc4253000'
sessions=home/'.kiro/sessions/cli'
def tm(*args,check=True):return subprocess.run(['tmux','-L',socket,*args],check=check,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True).stdout
def env():return {'HOME':str(home),'XDG_DATA_HOME':str(home/'.local/share'),'XDG_CONFIG_HOME':str(home/'.config'),'XDG_STATE_HOME':str(home/'.local/state'),'XDG_CACHE_HOME':str(home/'.cache'),'PATH':str(Path(binary).parent)+':/usr/local/bin:/usr/bin:/bin','TERM':'xterm-256color','KIRO_NO_AUTO_UPDATE':'1'}
version=subprocess.check_output([binary,'--version'],text=True,env=env()).strip()
assert version=={'2':'kiro-cli 2.36.0','3':'kiro-cli 3.0.0'}[phase],version
def launch(name,flags):
 cmd=shlex.join(['env','-i',*[k+'='+v for k,v in env().items()],binary,'chat',*flags])
 tm('new-session','-d','-s',name,'-x','120','-y','40','-c',str(cwd),cmd)
 tm('set-option','-t',name,'remain-on-exit','on')
def screen(name):return tm('capture-pane','-p','-S','-200','-t',name)
def wait(name,predicate,seconds=45):
 end=time.monotonic()+seconds
 while time.monotonic()<end:
  pane=screen(name)
  if predicate(pane):return pane
  if 'Pane is dead' in pane or 'Failed to start session:' in pane:raise RuntimeError(pane)
  time.sleep(.1)
 raise RuntimeError('Capture deadline: '+name+'\n'+screen(name))
def digest(p):return hashlib.sha256(p.read_bytes()).hexdigest()
try:
 if phase=='2':
  assert not home.exists(),'Never reuse a partially prepared phase2 profile'
  home.mkdir()
  launch('bootstrap',['--tui','--agent-engine=v2'])
  wait('bootstrap',lambda p:"let's get you signed in" in p)
  tm('kill-session','-t','bootstrap')
  db=sqlite3.connect(home/'.local/share/kiro-cli/data.sqlite3')
  db.execute('INSERT OR REPLACE INTO auth_kv VALUES (?,?)',('kirocli:social:token',json.dumps({'access_token':'offline-dummy-never-valid','refresh_token':'offline-dummy-never-valid','expires_at':'2099-01-01T00:00:00Z','provider':'google','profile_arn':'arn:aws:codewhisperer:us-east-1:000000000000:profile/OFFLINEONLY','region':'us-east-1'})));db.commit();db.close()
  settings=home/'.kiro/settings';settings.mkdir(parents=True,exist_ok=True);(settings/'cli.json').write_text(json.dumps({'chat.agentEngine':'v2'}))
  sessions.mkdir(parents=True,exist_ok=True)
  meta['cwd']=str(cwd);meta['session_state']['permissions']['filesystem']['allowed_read_paths']=[str(cwd)]
  (sessions/(sid+'.json')).write_text(json.dumps(meta))
  shutil.copyfile(fixture/'session.jsonl',sessions/(sid+'.jsonl'))
  # A newer sibling must never replace the explicitly pinned conversation.
  other=json.loads(json.dumps(meta));other['session_id']=decoy;other['session_state']['rts_model_state']['conversation_id']=decoy;other['updated_at']='2099-01-01T00:00:00Z'
  (sessions/(decoy+'.json')).write_text(json.dumps(other))
  (sessions/(decoy+'.jsonl')).write_text((fixture/'session.jsonl').read_text().replace('OFFLINE-RESUME-MEMORY-3047','WRONG-NEWER-SIBLING-3047'))
 else:
  assert (root/'receipt-2.json').exists(),'Phase2 must pass and its container exit first'
  assert json.loads((root/'receipt-2.json').read_text())['passed']
  assert json.loads((root/'receipt-2.json').read_text())['sourceHead']==os.environ.get('PROOF_SOURCE_HEAD')
 before=digest(sessions/(sid+'.jsonl'))
 launch('resume',['--tui','--agent-engine=v2','--model','claude-sonnet-4.6','--resume-id',sid])
 pane=wait('resume',lambda p:bool(re.search(r'^›\s+ask a question or describe a task ↵\s*$',p,re.M)))
 assert 'OFFLINE-RESUME-MEMORY-3047' in pane and 'WRONG-NEWER-SIBLING-3047' not in pane
 (root/('phase-'+phase+'-ready.pane.txt')).write_text(pane)
 # Only a known empty composer gets the local housekeeping command; never answer a choice or make a model turn.
 tm('send-keys','-t','resume','-l','/session-id')
 draft=wait('resume',lambda p:bool(re.search(r'^›\s+/session-id\s*$',p,re.M)),5)
 assert 'Continue with V3' not in draft and 'Keep V2' not in draft and 'Yes, I accept' not in draft
 tm('send-keys','-t','resume','Enter')
 alert=wait('resume',lambda p:'Session ID: '+sid in p and 'Resume with: kiro-cli --resume-id '+sid in p,5)
 (root/('phase-'+phase+'-id.pane.txt')).write_text(alert)
 assert digest(sessions/(sid+'.jsonl'))==before,'No turn or history rewrite expected'
 assert json.loads((sessions/(sid+'.json')).read_text())['session_id']==sid
 version=subprocess.check_output([binary,'--version'],text=True,env=env()).strip()
 (root/('receipt-'+phase+'.json')).write_text(json.dumps({'sourceHead':os.environ.get('PROOF_SOURCE_HEAD'),'binaryVersion':version,'sessionId':sid,'newerSiblingId':decoy,'exactIdObserved':True,'savedTextVisible':True,'wrongSiblingVisible':False,'transcriptHash':before,'transcriptUnchanged':True,'choicesAnswered':0,'housekeepingOnly':'/session-id','modelTurns':0,'mockAcp':False,'patchedBundle':False,'network':'none','realAccount':False,'passed':True},indent=2))
finally:tm('kill-server',check=False)
