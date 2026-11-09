"""One isolated source reversal per run; require assertion failures, restore bytes even on interruption."""
import json, pathlib, subprocess
root = pathlib.Path.cwd()
ui = 'src/ui/hub-directory-notices.js'
host = 'src/ui/hub-host-security-notices.js'
cases = [
 ('server-feature',ui,'!!session?.features?.includes(DIRECTORY_NOTICE_FEATURE)','true',0),
 ('client-feature',ui,'client?.directorySecurityNoticesV1 === true','true',0),
 ('read-generation',ui,'if (mine !== generation.current) return;','if (false) return;',0),
 ('ack-generation',ui,'if (mine !== generation.current) return;','if (false) return;',1),
 ('explicit-ack-result',ui,'if (result.ok) setRows','if (true) setRows',0),
 ('exact-ack-id',ui,'row.id === id ? { ...row, acknowledged: true }','true ? { ...row, acknowledged: true }',0),
 ('single-write',ui,'if (pending.current) return;','if (false) return;',0),
 ('read-authority-clear',ui,'if (result.status === 401 || result.status === 403) { setRows([]); setNext(null); }','if (false) { setRows([]); setNext(null); }',0),
 ('timer-clear',ui,'pending.current = false; clearTimeout(retry.current);','pending.current = false;',0),
 ('host-mark',host,'doc?.body?.dataset.hubDirectoryNotices === "1"','true',0),
 ('host-public-link',host,'doc.body.dataset.publicLink !== "1"','true',0),
]
results=[]
try:
 for name,path,old,new,index in cases:
  target=root/path; original=target.read_bytes(); source=original.decode(); start=0
  for _ in range(index+1):
   pos=source.find(old,start)
   if pos<0: raise RuntimeError('missing '+name)
   start=pos+len(old)
  target.write_text(source[:pos]+new+source[pos+len(old):])
  try:
   run=subprocess.run(['npx','vitest','run','tests/hub-directory-notice-ui.test.ts','--reporter=json'],text=True,capture_output=True)
   data=json.loads(run.stdout)
   failures=[a for f in data['testResults'] for a in f['assertionResults'] if a['status']=='failed']
   messages=[m for a in failures for m in a.get('failureMessages',[])]
   ok=run.returncode!=0 and bool(messages) and all('AssertionError' in m for m in messages)
   results.append({'name':name,'caught':ok,'assertionFailures':len(failures)})
   print(name,ok,len(failures),flush=True)
   if not ok: raise RuntimeError(name+' did not fail by assertion: '+run.stderr[-1000:])
  finally: target.write_bytes(original)
finally:
 out=root/'.artifacts/directory-notice-ui/mutations.json'; out.parent.mkdir(parents=True,exist_ok=True);out.write_text(json.dumps(results,indent=2))
