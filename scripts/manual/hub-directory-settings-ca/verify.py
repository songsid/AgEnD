#!/usr/bin/env python3
"""One guard at a time; assertion failures only. Do not run beside tests/types/source edits."""
import hashlib,json,subprocess,sys
from pathlib import Path
root=Path(__file__).resolve().parents[3]
ca='src/hub/settings-directory-ca.ts';control='src/hub/settings-directory-control.ts';tls='src/hub/init/directory-certificate.ts';http='src/hub/http/compose.ts'
unit=['tests/hub-directory-settings-ca.test.ts']
physical=['tests/hub-directory-certificate.test.ts']
owner=['tests/hub-directory-settings-control.test.ts']
marks=['tests/hub-compose.test.ts']
rows=[
 ('actor-binding',ca,'actorKey(ctx.actor) !== record.actor || ','',unit,'another'),
 ('source-image',ca,'source.image !== record.source.image || ','',unit,'a changed image'),
 ('source-epoch',ca,'source.epoch !== record.source.epoch || ','',unit,'a changed epoch'),
 ('source-directory',ca,' || source.directory !== record.source.directory','',unit,'a changed directory'),
 ('source-snapshot',ca,'const source = { ...original, config: structuredClone(original.config), administrator: { ...original.administrator },\n        groups: structuredClone(original.groups), current: original.current.bind(original) };','const source = original;',unit,'a changed image|a changed epoch'),
 ('actor-snapshot',ca,'actor: structuredClone(input.actor)','actor: input.actor',unit,'snapshots the actor'),
 ('initial-time',ca,'before < record.createdAt || before >= record.expiresAt || ','',unit,'a changed initial'),
 ('final-time',ca,' || t < record.createdAt || t >= record.expiresAt','',unit,'a changed late-clock'),
 ('pin-before-pool',ca,'if (!sameDirectoryFingerprint(record.probe.certificate.fingerprint256, request.fingerprint)) throw new HubDirectorySettingsCaError("ca-trust");','// missing pin',unit,'refuses a mismatched pin'),
 ('consume-once',ca,'check(record, ctx); probes.delete(request.ref);','check(record, ctx);',unit,'normalizes the target'),
 ('retained-cap',ca,'probes.size + preparing >= MAX_PROBES','false',unit,'bounds retained probes'),
 ('stale-probe-prune',ca,' || old.source.image !== source.image\n        || old.source.epoch !== source.epoch || old.source.directory !== source.directory','',unit,'prunes probes'),
 ('inflight-reservation',ca,'probes.size + preparing >= MAX_PROBES','probes.size >= MAX_PROBES',unit,'reserves the last'),
 ('shared-pool',ca,'const result = await deps.withDirectoryRead(record.source.administrator, async () => { check(record, ctx); return work(); });','const result = await work();',unit,'normalizes the target|held inspection|held fetch'),
 ('credential-pair',ca,'.refine(r => (r.bindDn === undefined) === (r.bindPassword === undefined))','',unit,'requires service credential fields'),
 ('anonymous-refusal',ca,'directory_ca_auth_required: "ca-auth-required"','directory_ca_auth_required: "ca-unavailable"',unit,'requires service credential fields'),
 ('strict-inspect',ca,'const inspectRequest = z.strictObject(','const inspectRequest = z.object(',unit,'refuses arbitrary targets'),
 ('strict-fetch',ca,'const fetchRequest = z.strictObject(','const fetchRequest = z.object(',unit,'refuses arbitrary targets'),
 ('inspect-physical',tls,'finally { await closeSocket(socket); }','finally { void closeSocket(socket); }',physical,'inspect retains ownership'),
 ('verified-physical',tls,'finally { await closeSocket(verified); }','finally { void closeSocket(verified); }',physical,'fetch-verified retains ownership'),
 ('pinned-physical',tls,'await closed;','void closed;',physical,'fetch-pinned retains ownership'),
 ('inspect-stop',control,'return track(() => ca.inspect(request, ctx));','return ca.inspect(request, ctx);',owner,'Stop drains physical CA inspect'),
 ('fetch-stop',control,'return track(() => ca.fetch(request, ctx));','return ca.fetch(request, ctx);',owner,'Stop drains physical CA fetch'),
 ('session-mark',http,'...(deps.directorySettings ? [HUB_DIRECTORY_SETTINGS_FEATURE, HUB_DIRECTORY_CA_FEATURE] : [])];','...(deps.directorySettings ? [HUB_DIRECTORY_SETTINGS_FEATURE] : [])];',marks,'authorizes CA'),
 ('entry-mark',http,'...(deps.directorySettings ? [HUB_DIRECTORY_SETTINGS_FEATURE, HUB_DIRECTORY_CA_FEATURE] : [])]),','...(deps.directorySettings ? [HUB_DIRECTORY_SETTINGS_FEATURE] : [])]),',marks,'authorizes CA'),
]
selected=set(sys.argv[1:]);assert not selected-{r[0] for r in rows}
original={path:(root/path).read_bytes() for path in {r[1] for r in rows}}
out=root/'.artifacts/hub-directory-settings-ca';out.mkdir(parents=True,exist_ok=True);results=[]
try:
 for name,path,old,new,files,pattern in rows:
  if selected and name not in selected:continue
  text=original[path].decode();assert text.count(old)==1,(name,text.count(old));target=root/path;target.write_text(text.replace(old,new));report=out/f'{name}.json'
  try:
   with (out/f'{name}.log').open('w') as log:
    run=subprocess.run(['npx','vitest','run',*files,'-t',pattern,'--reporter=json',f'--outputFile={report}'],cwd=root,stdout=log,stderr=subprocess.STDOUT,timeout=90)
   data=json.loads(report.read_text());failures=[t for s in data['testResults'] for t in s['assertionResults'] if t['status']=='failed']
   assert failures and all('AssertionError' in '\n'.join(t['failureMessages']) for t in failures),(name,run.returncode,failures)
   row={'name':name,'file':path,'exit':run.returncode,'passed':data['numPassedTests'],'failed':data['numFailedTests'],'deselected':data['numPendingTests']};results.append(row);print(json.dumps(row),flush=True)
  finally:target.write_bytes(original[path])
finally:
 for path,contents in original.items():(root/path).write_bytes(contents)
 suffix=('-'+'-'.join(sorted(selected)) if len(selected)<=3 else '-selected') if selected else ''
 (out/f'mutations{suffix}.json').write_text(json.dumps({'baseline':{hashlib.sha256(v).hexdigest():k for k,v in original.items()},'rows':results,'restored':all((root/p).read_bytes()==v for p,v in original.items())},indent=2)+'\n')
assert results
