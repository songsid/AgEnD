#!/usr/bin/env python3
"""One-at-a-time focused semantic guard reversals. Never run beside browser/tests/types/source edits."""
from pathlib import Path
import hashlib,json,subprocess,sys
root=Path(__file__).resolve().parents[3];out=root/'.artifacts/editor-mutations';out.mkdir(parents=True,exist_ok=True)
ui='src/ui/hub-directory-editor.js';host='src/ui/settings-hub-directory.js';control='src/hub/settings-directory-control.ts'
def test(pattern):return ['tests/hub-directory-editor-ui.test.ts','-t',pattern]
rows=[
 ('read-compat',ui,'if (!directoryView(r)) fail("unsupported");','',test('incompatible read DTO')),
 ('stale-epoch',ui,'latest.epoch !== view.epoch || ','',test('changed displayed epoch')),
 ('stale-fields',ui,' || !same(latest.directory, view.directory)','',test('changed displayed directory')),
 ('secret-target',ui,'if (input.bindPassword === undefined &&','if (false &&',test('explicit new service password')),
 ('secret-bytes',ui,'{ bindPassword: form.bindPassword }','{ bindPassword: form.bindPassword.trim() }',test('explicit new service password')),
 ('trust-defer',ui,'if (p.trust) setDialog({ phase: "ready", p, intent });','if (false) setDialog({ phase: "ready", p, intent });',test('one trust dialog')),
 ('trust-challenge',ui,'...(p.trust ? { confirmation: p.trust.challenge } : {})','...{}',test('one trust dialog')),
 ('trust-server-port',ui,'directoryEndpoint(p.trust.server) !== directoryEndpoint(candidate.url) || ','',test('incompatible trust reply.*1636')),
 ('trust-server',ui,'directoryEndpoint(p.trust.server) !== directoryEndpoint(candidate.url) || ','',test('incompatible trust reply')),
 ('late-life',ui,'n === life.current && ','',test('Stop while CA preparation')),
 ('late-abort',ui,'for (const request of requests.current) request.abort();','',test('held prepare after')),
 ('late-cancel',ui,'if (REF.test(p.ref || "")) void client.cancelDirectorySettings({ ref: p.ref }).catch(() => {});','',test('held prepare after')),
 ('single-flight',ui,'working.current || !current(life.current)','!current(life.current)',test('duplicate Save clicks')),
 ('uncertain-save',ui,'setUncertain(true); setForm(f => f &&','setUncertain(false); setForm(f => f &&',test('ambiguous .* Save')),
 ('stop-uncertain',ui,'if (saveSent.current) { setUncertain(true); setFailureCode("uncertain"); }','',test('Stop while Save')),
 ('session-refresh',ui,'if (await afterSave() !== true || !current(n))','if (false)',test('one Save prepares')),
 ('anonymous-ca',ui,'...(credentials ? { bindDn: form.bindDn.trim(), bindPassword: form.bindPassword } : {})','...(form.bindPassword ? { bindDn: form.bindDn.trim(), bindPassword: form.bindPassword } : {})',test('CA bootstrap sends no credentials')),
 ('fresh-probe',ui,'credentials ? await send("inspectDirectoryCa", { url: form.url.trim() }, signal) : previous','previous',test('changed leaf before credentialed')),
 ('retry-pin',ui,' || fingerprint(probe.certificate?.fingerprint256) !== fingerprint(previous.certificate?.fingerprint256)','',test('changed leaf before credentialed')),
 ('bundle-pin',ui,' || fingerprint(bundle.leafFingerprint) !== fingerprint(previous.certificate.fingerprint256)','',test('mismatched bundle-leaf')),
 ('prepared-pin',ui,'fingerprint(p.trust.leafFingerprint) !== fingerprint(previous.certificate.fingerprint256) || ','',test('mismatched prepared-leaf')),
 ('CA-agreement',ui,'|| JSON.stringify(p.trust.caFingerprints.map(fingerprint).sort()) !== JSON.stringify(fingerprints)','',test('mismatched prepared-ca')),
 ('host-mark',host,'doc?.body?.dataset.hubDirectorySettings === "1" && ','',test('host adapter is absent')),
 ('host-public',host,'doc.body.dataset.publicLink !== "1" && ','',test('host adapter is absent')),
 ('read-epoch',control,'epoch: s.epoch','epoch: 0',['tests/hub-directory-settings-control.test.ts','-t','returns editable connection']),
 ('editor-feature','src/hub/settings-directory-http.ts','HUB_DIRECTORY_EDITOR_FEATURE = "directory-editor-v1"','HUB_DIRECTORY_EDITOR_FEATURE = "unavailable"',['tests/hub-compose.test.ts','-t','authorizes the configured administrator before lazily']),
 ('host-page-mark','src/web-api.ts',' data-hub-directory-settings="1"','',['tests/hub-directory-host-notices.test.ts','-t','reads and ACKs the host target']),
]
rows += [
 ('panel-client-mark','src/ui/panel-hub.js',' && hubClient()?.directoryEditorV1 === true','',['tests/hub-groups-ui-s89.test.ts','-t','new panel with an old cached client']),
 ('gateway-page-mark','src/web-api.ts','setup && !gatewayRequestContext(req) && typeof ctx.hubDirectorySettings','setup && typeof ctx.hubDirectorySettings',['tests/hub-directory-host-notices.test.ts','-t','reads and ACKs the host target']),
]
selected=set(sys.argv[1:]);original={p:(root/p).read_bytes() for p in {r[1] for r in rows}};results=[]
try:
 for name,path,before,after,tests in rows:
  if selected and name not in selected:continue
  source=original[path].decode();assert source.count(before)==1,(name,source.count(before));file=root/path;file.write_text(source.replace(before,after,1))
  try:
   report=out/(name+'.json');run=subprocess.run(['npx','vitest','run',*tests,'--reporter=json','--outputFile='+str(report)],cwd=root,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,timeout=90)
   (out/(name+'.log')).write_text(run.stdout);data=json.loads(report.read_text())
   failed=[t for s in data['testResults'] for t in s.get('assertionResults',[]) if t['status']=='failed'];assertions=[t for t in failed if any('AssertionError:' in m for m in t['failureMessages'])]
   caught=run.returncode!=0 and bool(assertions);results.append(dict(name=name,path=path,pattern=before,passed=data['numPassedTests'],failed=data['numFailedTests'],assertionFailures=len(assertions),caught=caught));print(name,len(assertions),'assertion failures',flush=True)
  finally:file.write_bytes(original[path])
finally:
 for path,value in original.items():assert (root/path).read_bytes()==value,path
 (out/'receipt.json').write_text(json.dumps({'v':1,'baseline':{hashlib.sha256(value).hexdigest():path for path,value in original.items()},'rows':results,'restored':True},indent=2)+'\n')
assert len(results)==(len(selected) if selected else len(rows))
assert all(r['caught'] for r in results),[r['name'] for r in results if not r['caught']]
