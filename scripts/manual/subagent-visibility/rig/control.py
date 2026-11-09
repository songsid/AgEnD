from pathlib import Path
import sys,json,time,os
r=Path(os.environ['AUDIT_RUN_ROOT']).resolve();c=json.loads(sys.argv[1]);f=r/'control.json';assert not f.exists(),'another control is pending';prior=len(json.loads((r/'receipt.json').read_text()).get('commands',[])) if (r/'receipt.json').exists() else 0;tmp=r/'control.tmp';tmp.write_text(json.dumps(c));tmp.rename(f)
for _ in range(100):
 try:
  v=json.loads((r/'receipt.json').read_text())
  if len(v.get('commands',[]))>prior:
   last=v['commands'][-1];assert last.get('ok'),last
   if c['action']=='capture':print((r/'frames'/c['name']).read_text())
   else:print(last)
   break
 except (FileNotFoundError,json.JSONDecodeError):pass
 time.sleep(.1)
else:raise RuntimeError('control did not complete')
