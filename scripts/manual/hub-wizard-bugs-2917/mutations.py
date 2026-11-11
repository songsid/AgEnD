import hashlib,json,subprocess
from pathlib import Path
root=Path.cwd();out=root/'.artifacts/wizard-2917/mutations';out.mkdir(exist_ok=True)
files=['src/hub/init/wizard.ts','src/hub/init/prompt.ts','src/hub/init/text.ts']
original={f:(root/f).read_bytes() for f in files}
wizard=original[files[0]].decode();prompt=original[files[1]].decode();text=original[files[2]].decode()
cases=[
 ('M1-fingerprint-cancels','src/hub/init/wizard.ts','          io.say(ht(pin.trim() ? "dir_leaf_refused" : "dir_ca_not_approved"));\n          continue;','          io.say(ht(pin.trim() ? "dir_leaf_refused" : "dir_ca_not_approved"));\n          return undefined;', ['tests/hub-init-setup-bugs-2917.test.ts']),
 ('M2-fingerprint-ignored','src/hub/init/wizard.ts','if (!sameDirectoryFingerprint(probe.certificate.fingerprint256, pin))','if (false)', ['tests/hub-init-setup-bugs-2917.test.ts']),
 ('M3-url-unvalidated','src/hub/init/wizard.ts','const url = await askDirectoryUrl(io);','const url = (await io.ask(ht("dir_url_q"))).trim();',['tests/hub-init-setup-bugs-2917.test.ts']),
 ('M4-method-echoes','src/hub/init/wizard.ts','const choice = (await io.askHidden(ht("dir_bind_source_q"))).trim();','const choice = (await io.ask(ht("dir_bind_source_q"))).trim();',['tests/hub-init-setup-bugs-2917.test.ts']),
 ('M5-path-echoes','src/hub/init/wizard.ts','const path = (await io.askHidden(ht("dir_bind_file_q"))).trim();','const path = (await io.ask(ht("dir_bind_file_q"))).trim();',['tests/hub-secret-file-wizard.test.ts']),
 ('M9-file-ca-refusal-cancels','src/hub/init/wizard.ts','if (!await confirmDirectoryCa(io, caPem)) { io.say(ht("dir_ca_not_approved")); continue; }','if (!await confirmDirectoryCa(io, caPem)) return undefined;', ['tests/hub-init-setup-bugs-2917.test.ts']),
 ('M10-fetched-ca-refusal-cancels','src/hub/init/wizard.ts','if (!await confirmDirectoryCa(io, bundle.pem)) { io.say(ht("dir_ca_not_approved")); continue; }','if (!await confirmDirectoryCa(io, bundle.pem)) return undefined;', ['tests/hub-init-setup-bugs-2917.test.ts']),
 ('M6-paints-before-raw','src/hub/init/prompt.ts','    input.setRawMode!(true);','    output.write(question);\n    input.setRawMode!(true);',['tests/hub-init-setup-bugs-2917.test.ts']),
]
# The wording regressions are entire localized values, not test-only approximations.
for key,label in [('tls_intro','M7-old-certificate-copy'),('pairing_steps','M8-old-handoff-copy')]:
 base=subprocess.check_output(['git','show','9c98307c:src/hub/init/text.ts']).decode()
 import re
 pattern=r'(  '+key+r':\s*\n?\s*)("(?:[^"\\]|\\.)*")'
 old=list(re.finditer(pattern,base));new=list(re.finditer(pattern,text));assert len(old)==len(new)==2
 mutated=text
 for a,b in reversed(list(zip(new,old))):mutated=mutated[:a.start(2)]+b.group(2)+mutated[a.end(2):]
 cases.append((label,'src/hub/init/text.ts',text,mutated,['tests/hub-init-setup-bugs-2917.test.ts']))
rows=[]
try:
 for name,file,before,after,tests in cases:
  for f,data in original.items():(root/f).write_bytes(data)
  source=(root/file).read_text();assert source.count(before)==1,(name,source.count(before));(root/file).write_text(source.replace(before,after))
  if name=='M6-paints-before-raw':
   p=root/file;s=p.read_text();s=s.replace('    // Disable kernel echo before the prompt is visible: even a fast paste must remain private.\n    output.write(question);','    // Mutated: echo not disabled before the first paint.');p.write_text(s)
  report=out/(name+'.json')
  cmd=['npx','vitest','run',*tests,'--reporter=json','--outputFile='+str(report)]
  result=subprocess.run(cmd,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True)
  (out/(name+'.log')).write_text(result.stdout)
  data=json.loads(report.read_text());failed=[{'test':a['fullName'],'failures':a.get('failureMessages',[])} for t in data['testResults'] for a in t['assertionResults'] if a['status']=='failed']
  assert result.returncode!=0 and failed,(name,result.returncode,result.stdout)
  assert not any('Transform failed' in x or 'Failed to load' in x or 'SyntaxError' in x for a in failed for x in a['failures']),(name,failed)
  rows.append({'name':name,'file':file,'failedTests':len(failed),'assertions':[a['test'] for a in failed]})
  print(name,len(failed),flush=True)
finally:
 for f,data in original.items():(root/f).write_bytes(data)
 (out/'summary.json').write_text(json.dumps({'mutations':rows,'restored':all((root/f).read_bytes()==v for f,v in original.items()),'sourceDigests':[{hashlib.sha256(v).hexdigest():[f]} for f,v in original.items()]},indent=2)+'\n')
assert len(rows)==10
