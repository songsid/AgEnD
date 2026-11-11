"""Isolated semantic reversals; owned worktree only; exact source restored in finally."""
from pathlib import Path
import subprocess,sys
root=Path(__file__).resolve().parents[3]
out=root/'.artifacts/hub-simplify-s1'
cases=[
 ('offer-reason','src/hub/join/service.ts','throw new CompanyJoinOfferPending();','throw new HubProtocolError("conflict");','tests/hub-simplify-s1.test.ts','answers offer-pending'),
 ('supersedes-owner','src/hub/join/service.ts','if (old && personKeyString(old.owner) !== personKeyString(owner)) throw new HubProtocolError("denied");','/* removed immutable-owner fence */','tests/hub-simplify-s1.test.ts','another person'),
 ('supersedes-credential','src/hub/join/service.ts','old.credentialHash === sha256(p.supersedes.credential)','!!old.credentialHash','tests/hub-simplify-s1.test.ts','wrong old credential'),
 ('approve-slot','src/hub/join/service.ts','this.records.reservations(owner)) - Number(!!old)','this.records.reservations(owner))','tests/hub-simplify-s1.test.ts','supersedes its authenticated'),
 ('issue-slot','src/hub/join/service.ts','this.records.reservations(owner, b.requestId)) - Number(!!old)','this.records.reservations(owner, b.requestId))','tests/hub-simplify-s1.test.ts','supersedes its authenticated'),
 ('after-audit','src/hub/store.ts','const checked: unknown = beforePublish();','const checked: unknown = undefined;','tests/hub-simplify-s1.test.ts','last supersession audit'),
 ('old-cas','src/hub/join/store.ts','record.binding.requestId, raw.body','record.binding.requestId, canonicalArguments(previous)','tests/hub-simplify-s1.test.ts','old stored request'),
 ('leave-feature','src/hub/server.ts','if (!context.features.has("member-leave-v1") || !context.features.has("welcome-caps-v1")) throw new HubProtocolError("incompatible");','/* removed negotiated-leave gate */','tests/hub-member-leave-s1.test.ts','unnegotiated leave'),
 ('fleet-reason-relay','src/hub/join/service.ts','this.records.save({ ...r, reason, version: r.version + 1 }, r.version);','this.records.save({ ...r, reason: null, version: r.version + 1 }, r.version);','tests/hub-simplify-s1.test.ts','wrong old credential'),
 ('leave-binding','src/hub/client.ts','expected.binding !== sha256(JSON.stringify(["agend-hub-binding-v1", expected.hubId, digest]))','false','tests/hub-member-leave-s1.test.ts','mismatched local binding'),
 ('leave-live-profile','src/hub/client.ts','canonicalArguments(store.readProfile()) !== canonicalArguments(profile)','false','tests/hub-member-leave-s1.test.ts','replaced on-disk'),
 ('leave-mount-generation','src/hub/mount.ts','&& this.generation === generation','', 'tests/hub-member-leave-mount-s1.test.ts','retired generation'),
]
for name,file,old,new,test,pattern in cases:
 if len(sys.argv)>1 and name not in sys.argv[1:]: continue
 path=root/file; source=path.read_text(); assert source.count(old)==1,(name,source.count(old))
 try:
  path.write_text(source.replace(old,new,1))
  typed=subprocess.run([str(root/'node_modules/.bin/tsc'),'--noEmit'],cwd=root,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
  (out/f'mutant-{name}-types.log').write_bytes(typed.stdout)
  assert typed.returncode==0, f'{name}: mutation did not typecheck'
  run=subprocess.run([str(root/'node_modules/.bin/vitest'),'run',test,'-t',pattern],cwd=root,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
  log=run.stdout.decode(); (out/f'mutant-{name}.log').write_text(log)
  assert run.returncode!=0 and ('AssertionError' in log or 'AssertionError:' in log), f'{name}: no semantic assertion failure'
  print(f'{name}: compiled, intended assertion caught',flush=True)
 finally:
  path.write_text(source)
