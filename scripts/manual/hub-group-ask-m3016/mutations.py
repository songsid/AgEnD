#!/usr/bin/env python3
"""Isolated semantic reversals. Stops on load>10; restores exact bytes even on a failed probe."""
import hashlib,json,os,pathlib,subprocess,sys,time
root=pathlib.Path.cwd();out=pathlib.Path(os.environ.get('MUTATION_OUT',str(root/'.artifacts/hub-group-ask-m3016/mutations')));out.mkdir(parents=True,exist_ok=True)
subjects='tests/hub-grant-subjects-m3016.test.ts';picker='tests/hub-grant-picker-m3016.test.ts';directory='tests/hub-grant-person-search-m3016.test.ts'
mutants=[
 ('G1','src/hub/grant-access.ts','facts.groups.includes(g.subject.group.objectId)','true',subjects,'checks live direct membership'),
 ('G2','src/hub/catalog.ts','grant.subject.kind === "person" && personKeyString(grant.subject.person) === personKeyString(asker)','grant.subject.kind === "group" || personKeyString(grant.subject.person) === personKeyString(asker)',subjects,'group identity alone'),
 ('E1','src/hub/catalog.ts','90 * 24 * 60 * 60_000','365 * 24 * 60 * 60_000',subjects,'caps all new person'),
 ('P1','src/hub/catalog.ts','personKeyString(key) !== personKeyString(input.subject.person)','personKeyString(key) === personKeyString(input.subject.person)',subjects,'selection binds'),
 ('G3','src/hub/catalog.ts','personKeyString(key) !== personKeyString(group) || ','',subjects,'fences a held group resolve'),
 ('S1','src/hub/grant-search.ts','assert(); permit?.assertCurrent(); if (failure)','if (failure)',subjects,'does not disclose a held search'),
 ('S2','src/hub/http/core.ts','await policy.withDirectoryRead(actor, read)','await read()',subjects,'four-physical-read pool'),
 ('F1','src/hub/grant-access.ts','value.observedAt < started || value.observedAt > finished','false',subjects,'membership observations'),
 ('F2','src/hub/grant-access.ts','bytes(grantOf(row)) !== bytes(g)','false',subjects,'group identity alone'),
 ('F3','src/hub/grant-access.ts','5_000','50_000',subjects,'accepted durable phases'),
 ('D1','src/hub/directory/directory.ts','const literal = escapeFilterValue(q);\n    const { searchEntries } = await this.client.search(this.cfg.baseDn, {\n      scope: "sub", derefAliases: "never", sizeLimit: 20, timeLimit: 5,\n      filter: `(&${this.cfg.userFilter}', 'const literal = q;\n    const { searchEntries } = await this.client.search(this.cfg.baseDn, {\n      scope: "sub", derefAliases: "never", sizeLimit: 20, timeLimit: 5,\n      filter: `(&${this.cfg.userFilter}',directory,'literal prefix'),
 ('D2','src/hub/directory/directory.ts','await service?.close(true);','await service?.close();',directory,'physical socket close'),
 ('D3','src/hub/directory/directory.ts','{ expired = true; service?.abort(); }, 5000','{ expired = true; }, 5000',directory,'the5s deadline'),
 ('U1','src/ui/panel-hub.js','s?.features?.includes("grant-subjects-v1")','true',picker,'older server/client marks'),
 ('U2','src/ui/hub-grant-picker.js','if (writing.current || !selected || client !== hubClient())','if (!selected || client !== hubClient())',picker,'posts the selected immutable'),
 ('U3','src/ui/hub-client.js','return signal?.aborted ? { ok: false, status: 0, code: "unreachable" } : out;','return out;',picker,'aborted suggestion body'),
 ('I1','src/hub/group-policy/admin-impact.ts','facts.kind === "unknown" ? undefined','facts.kind === "unknown" ? false',subjects,'impact evaluates known-person'),
 ('R1','src/hub/catalog.ts','subjectProof.assertSelectionCurrent();','',subjects,'replacement directory method'),
 ('R2','src/hub/catalog.ts','if (this.core.now() >= subjectProof.expiresAt)','if (false)',subjects,'catalog refreshes an aged'),
 ('R3','src/hub/rooms.ts','    const subjectProof = await this.core.grantAccess(rows.filter(r => r.state === "active").map(r => r.grant_id), asker, context);\n','',subjects,'room-list subject proof'),
 ('C1','src/hub/catalog.ts','askable: selectAskable(db, askable.filter(candidate => {','askable: askable.filter(candidate => {',subjects,'one askable agent'),
 ('K1','src/hub/grant-access.ts','if (at < lastObserved)','if (at < created)',subjects,'permanently retires'),
 ('K2','src/hub/grant-access.ts','lastObserved = at; return at;','return at;',subjects,'permanently retires'),
 ('K3','src/hub/grant-access.ts','if (clockRetired)','if (false)',subjects,'permanently retires'),
]
chosen=set(sys.argv[1:]);manifest=[]
for id,path,old,new,file,name in mutants:
 if chosen and id not in chosen:continue
 if float(pathlib.Path('/proc/loadavg').read_text().split()[0])>10: print('DEFER load>10 before',id,flush=True);sys.exit(75)
 p=root/path;original=p.read_bytes();text=original.decode();assert old in text,(id,'missing source pattern');changed=text.replace(old,new)
 if id=='R3':changed=changed.replace('    const proofs = new Map<string, HubOperationPermit | null>();',old+'    const proofs = new Map<string, HubOperationPermit | null>();',1)
 if id=='C1':changed=changed.replace('}), me) }), { assertCurrent:', '}) }), { assertCurrent:',1)
 log=out/(id+'.log');start=time.time()
 try:
  p.write_text(changed)
  with log.open('w') as f:r=subprocess.run(['node','node_modules/vitest/vitest.mjs','run',file,'--maxWorkers=2','--no-file-parallelism','--reporter=dot','--no-color','-t',name],stdout=f,stderr=subprocess.STDOUT,timeout=90)
  body=log.read_text();caught=r.returncode!=0 and 'AssertionError' in body and 'Transform failed' not in body and 'SyntaxError' not in body
 finally:p.write_bytes(original);assert p.read_bytes()==original
 entry={'id':id,'file':file,'selector':name,'caught':caught,'exit':r.returncode,'sourceDigest':hashlib.sha256(original).hexdigest(),'logDigest':hashlib.sha256(log.read_bytes()).hexdigest(),'seconds':round(time.time()-start,3),'restored':True};manifest.append(entry)
 (out/(id+'.json')).write_text(json.dumps(entry,indent=2)+'\n');print(json.dumps(entry),flush=True)
 if not caught:sys.exit(1)
assert manifest,'no selected mutations';print('ALL CAUGHT',len(manifest))
