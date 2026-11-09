#!/usr/bin/env python3
"""Focused assertion mutations; run without a browser or other readers of this checkout's source."""
import json
from pathlib import Path
import subprocess

root=Path(__file__).resolve().parents[3]
out=root/'.artifacts/pairing-progress/mutations';out.mkdir(parents=True,exist_ok=True)
guidance='tests/hub-pairing-guidance-3386.test.ts'
quick='tests/hub-quick-pairing-ui.test.ts'

def replace(before,after):
 def change(text):
  assert text.count(before)==1,before
  return text.replace(before,after)
 return change

def omit_guard(n):
 def change(text):
  marker='if (!current()) return;';assert text.count(marker)==2
  parts=text.split(marker);return marker.join(parts[:n+1])+'/* mutant omits operation fence */'+marker.join(parts[n+1:])
 return change

cases=[
 ('observable-settlement','src/ui/hub-client.js',guidance,replace('pendingConfirmation: true, settled, pairing:', 'pendingConfirmation: true, pairing:')),
 ('watch-terminal-result','src/ui/settings-hub.js',guidance,replace('if (!result.settled?.then) return;', 'return;')),
 ('before-read-fence','src/ui/settings-hub.js',guidance,omit_guard(0)),
 ('after-read-fence','src/ui/settings-hub.js',guidance,omit_guard(1)),
 ('new-code-next-step','src/ui/settings-hub.js',guidance,replace('? hp("connectFailed") : hp("notApplied")','? hp("notApplied") : hp("notApplied")')),
 ('unknown-is-not-a-retry','src/ui/settings-hub.js',guidance,replace('? hp("unknown")','? hp("connectFailed")')),
 ('local-proof-marker','src/ui/hub-quick-pairing.js',quick,replace('attempt.state === "claimed" ? "done" : "now"','attempt.state === "offered" ? "now" : "done"')),
 ('claimed-waits-for-pin','src/ui/hub-quick-pairing.js',quick,replace('hq(attempt.state === "claimed" ? "claim" : "waiting")','hq("waiting")')),
]
results=[]
for name,file,suite,mutate in cases:
 p=root/file;original=p.read_bytes();report=out/(name+'.json')
 try:
  p.write_text(mutate(original.decode()))
  run=subprocess.run(['npx','vitest','run',suite,'--reporter=json','--outputFile='+str(report)],cwd=root,capture_output=True,text=True)
  (out/(name+'.log')).write_text(run.stdout+run.stderr)
  data=json.loads(report.read_text()) if report.exists() else {}
  failures=[t['fullName'] for s in data.get('testResults',[]) for t in s.get('assertionResults',[]) if t['status']=='failed']
  killed=run.returncode!=0 and data.get('numTotalTests',0)>0 and data.get('numFailedTests',0)>0 and bool(failures)
  results.append({'name':name,'killed':killed,'total':data.get('numTotalTests',0),'failures':failures})
  print(name,'KILLED' if killed else 'SURVIVED/INVALID',flush=True)
 finally:p.write_bytes(original)
(out/'summary.json').write_text(json.dumps(results,indent=2))
assert len(results)==len(cases) and all(r['killed'] for r in results)
