import subprocess,os,json,select,time
from pathlib import Path
r=Path('.e2891').resolve();env={'HOME':str(r/'h'),'CODEX_HOME':str(r/'c'),'PATH':str(r/'bin')+':/usr/bin:/bin'}
p=subprocess.Popen(['unshare','-Urn','sh','-c','ip link set lo up; exec "$@"','--',str(r/'bin/codex'),'app-server','--stdio'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=open(r/'out/codex-models-stderr.txt','w'),text=True,env=env)
rows=[]
try:
 for q in [{'id':1,'method':'initialize','params':{'clientInfo':{'name':'m2891','version':'1.0.0'},'capabilities':{}}},{'method':'initialized'},{'id':2,'method':'model/list','params':{'includeHidden':True}}]:p.stdin.write(json.dumps(q)+'\n');p.stdin.flush()
 end=time.monotonic()+15
 while time.monotonic()<end:
  if select.select([p.stdout],[],[],.5)[0]:
   line=p.stdout.readline()
   if not line:break
   row=json.loads(line);rows.append(row)
   if row.get('id')==2:break
finally:
 p.terminate()
 try:p.wait(timeout=5)
 except subprocess.TimeoutExpired:p.kill();p.wait()
(r/'out/codex-models-rpc.json').write_text(json.dumps(rows,indent=2))
for q in rows:
 if q.get('id')==2:
  print(json.dumps(q)[:1200])
  data=q.get('result',{}).get('data',[]);print('MODELS',len(data))
  print(json.dumps([{'id':m['id'],'levels':m.get('supportedReasoningEfforts'),'default':m.get('defaultReasoningEffort')} for m in data],indent=2)[:8000])
