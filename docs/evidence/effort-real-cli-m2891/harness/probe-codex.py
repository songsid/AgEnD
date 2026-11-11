from pathlib import Path
import subprocess,time,json,hashlib
r=Path(__file__).parent.resolve();b=['tmux','-S',str(r/'t.sock')]
def cap():return subprocess.check_output(b+['capture-pane','-p','-t','codex']).decode()
def send(t):subprocess.run(b+['send-keys','-t','codex','-l',t],check=True);time.sleep(.35);subprocess.run(b+['send-keys','-t','codex','Enter'],check=True)
rows=[]
for level in ['low','high']:
 send('/model --reasoning='+level)
 for _ in range(100):
  if 'Sol '+level+' · ' in cap():break
  time.sleep(.1)
 else:raise Exception('status '+level+' '+cap())
 prompt='m2891-codex-'+level+'-'+str(time.monotonic_ns());send(prompt)
 for _ in range(150):
  p=r/'codex-bodies.jsonl'
  found=[json.loads(x) for x in p.read_text().splitlines() if prompt in x] if p.exists() else []
  if found:break
  time.sleep(.1)
 else:raise Exception('no request '+level+' '+cap())
 q=found[-1];assert q['reasoning']['effort']==level,q.get('reasoning')
 shell=int(subprocess.check_output(b+['display-message','-p','-t','codex','#{pane_pid}']).decode());ps=subprocess.check_output(['ps','--ppid',str(shell),'-o','pid=,comm=']).decode();row={'model':q['model'],'requested':level,'wire':q['reasoning'],'paneShellPid':shell,'children':ps.strip(),'bodyDigest':hashlib.sha256(json.dumps(q).encode()).hexdigest()};rows.append(row)
 time.sleep(.8);(r/'out'/('codex-'+level+'-live.txt')).write_text(cap())
(r/'out/codex-live-proof.json').write_text(json.dumps(rows,indent=2));print(json.dumps(rows,indent=2))
