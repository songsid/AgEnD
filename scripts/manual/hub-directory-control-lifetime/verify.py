#!/usr/bin/env python3
"""Focused lifetime reversals; never run beside tests/types/source edits."""
from pathlib import Path
import hashlib,json,subprocess,sys
root=Path(__file__).resolve().parents[3]
source=root/'src/fleet-manager.ts';original=source.read_bytes()
rows=[
 ('expired-owner','if (expired && this.hubDirectoryCurrent?.() !== true)','if (false)','replaces an expired directory controller'),
 ('fence','      expired.fence();','      // no fence','drains an expired controller'),
 ('physical-drain','      await expired.close();','      void expired.close();','drains an expired controller'),
 ('initialization-cas','if (this.hubDirectoryInit === previous)','if (true)','drains an expired controller'),
 ('cache-owner','this.hubDirectoryControl = control; this.hubDirectoryCurrent = current; return control;','this.hubDirectoryControl = control; return control;','offers one lazy directory controller'),
]
selected=set(sys.argv[1:]);assert not selected-{r[0] for r in rows}
out=root/'.artifacts/hub-directory-control-lifetime';out.mkdir(parents=True,exist_ok=True);results=[]
try:
 for name,old,new,pattern in rows:
  if selected and name not in selected:continue
  text=original.decode();assert text.count(old)==1,name
  source.write_text(text.replace(old,new));report=out/f'{name}.json'
  try:
   with (out/f'{name}.log').open('w') as log:
    run=subprocess.run(['npx','vitest','run','tests/hub-settings-fleet-m2682.test.ts','-t',pattern,'--reporter=json',f'--outputFile={report}'],cwd=root,stdout=log,stderr=subprocess.STDOUT,timeout=90)
   data=json.loads(report.read_text());failures=[t for s in data['testResults'] for t in s['assertionResults'] if t['status']=='failed']
   assert failures and all('AssertionError' in '\n'.join(t['failureMessages']) for t in failures),(name,run.returncode)
   row={'name':name,'exit':run.returncode,'passed':data['numPassedTests'],'failed':data['numFailedTests'],'deselected':data['numPendingTests']};results.append(row);print(json.dumps(row),flush=True)
  finally:source.write_bytes(original)
finally:
 source.write_bytes(original)
 suffix='-'+'-'.join(sorted(selected)) if selected else ''
 (out/f'mutations{suffix}.json').write_text(json.dumps({'baseline':{hashlib.sha256(original).hexdigest():'src/fleet-manager.ts'},'rows':results,'restored':source.read_bytes()==original},indent=2)+'\n')
assert results
