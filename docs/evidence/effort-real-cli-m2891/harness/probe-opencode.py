from pathlib import Path
import subprocess,time,json
r=Path(__file__).parent.resolve();b=['tmux','-S',str(r/'t.sock')]
def key(k):subprocess.run(b+['send-keys','-t','opencode',k],check=True);time.sleep(.15)
def cap():return subprocess.check_output(b+['capture-pane','-p','-t','opencode']).decode()
def send(t):subprocess.run(b+['send-keys','-t','opencode','-l',t],check=True);time.sleep(.35);key('Enter')
rows=[]
for level,downs in [('low',1),('high',3)]:
 if 'Select variant' not in cap():send('/variants');time.sleep(.3)
 key('Home')
 for _ in range(downs):key('Down')
 key('Enter');time.sleep(.3);(r/'out'/('opencode-'+level+'-selected.txt')).write_text(cap())
 prompt='m2891-opencode-'+level+'-'+str(time.monotonic_ns());send(prompt)
 for _ in range(150):
  p=r/'out/opencode-requests.jsonl';found=[json.loads(x) for x in p.read_text().splitlines() if prompt in x and 'reasoning_effort' in x] if p.exists() else []
  found=[x for x in found if x.get('reasoning_effort')]
  if found:break
  time.sleep(.1)
 else:raise Exception('no request '+cap())
 q=found[-1];assert q['reasoning_effort']==level,q
 row={k:v for k,v in q.items() if k!='messages'};shell=int(subprocess.check_output(b+['display-message','-p','-t','opencode','#{pane_pid}']).decode());row['paneShellPid']=shell;row['children']=subprocess.check_output(['ps','--ppid',str(shell),'-o','pid=,comm=']).decode().strip();rows.append(row);time.sleep(1);(r/'out'/('opencode-'+level+'-live.txt')).write_text(cap())
(r/'out/opencode-live-proof.json').write_text(json.dumps(rows,indent=2));print(json.dumps(rows,indent=2))
