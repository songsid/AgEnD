from pathlib import Path
import json,os,signal,time,subprocess
r=Path(os.environ['AUDIT_RUN_ROOT']).resolve();owned=[]
for h in [r/'codex',r/'codex3']:
 for name in ['daemon.pid','daemon-updater.pid']:
  f=h/'app-server-daemon'/name
  if not f.exists():continue
  d=json.loads(f.read_text());pid=d['pid'];p=Path(f'/proc/{pid}/cmdline')
  if not p.exists():continue
  cmd=p.read_bytes();env=Path(f'/proc/{pid}/environ').read_bytes().split(b'\0');start=Path(f'/proc/{pid}/stat').read_text().split(') ',1)[1].split()[19]
  assert (str(h)+'/packages/').encode()in cmd and b'app-server'in cmd and ('CODEX_HOME='+str(h)).encode()in env
  expected=d.get('processIdentity',{}).get('startTicks');assert expected is None or int(start)==expected
  owned.append({'pid':pid,'start':start,'cmd':cmd.decode().replace('\0',' '),'netns':os.readlink(f'/proc/{pid}/ns/net')})
(r/'stop').touch()
for _ in range(100):
 if json.loads((r/'receipt.json').read_text()).get('cleanup'):break
 time.sleep(.1)
def current(x):
 try:return Path(f"/proc/{x['pid']}/stat").read_text().split(') ',1)[1].split()[19]==x['start'] and Path(f"/proc/{x['pid']}/cmdline").read_bytes().replace(b'\0',b' ').decode()==x['cmd']
 except FileNotFoundError:return False
for x in owned:
 if current(x):os.kill(x['pid'],signal.SIGTERM)
time.sleep(1)
for x in owned:
 if current(x):os.kill(x['pid'],signal.SIGKILL)
time.sleep(.2)
check={'controller':json.loads((r/'receipt.json').read_text()).get('cleanup'),'daemons':[dict(x,stillOwnedProcess=current(x))for x in owned],'socketListening':subprocess.run(['/usr/bin/tmux','-S',str(r/'s'),'list-sessions'],capture_output=True).returncode==0}
assert check['controller']['tmuxClosed']and check['controller']['serverClosed']and not check['socketListening']and not any(x['stillOwnedProcess']for x in check['daemons'])
(r/'cleanup.json').write_text(json.dumps(check,indent=2));print(json.dumps(check,indent=2))
