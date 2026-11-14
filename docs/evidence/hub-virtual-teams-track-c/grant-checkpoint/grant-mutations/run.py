from pathlib import Path
import subprocess,os,json,hashlib
root=Path('.artifacts/teams-track-c/grant-mutations')
items=[
('T1-live-membership','src/hub/grant-access.ts','teamObservations.get(g.subject.teamId)?.member === true','true','tests/hub-team-grants-track-c.test.ts','live roster removal'),
('T2-roster-fence','src/hub/grant-access.ts','assertContext(); physical?.assertCurrent(); assertTeams();','assertContext(); physical?.assertCurrent();','tests/hub-team-grants-track-c.test.ts','finite durable'),
('T3-provider-fence','src/hub/grant-access.ts','core.deps.roomTeams !== teamReader || ','','tests/hub-team-grants-track-c.test.ts','finite durable'),
('T4-search-owner','src/hub/grant-search.ts','row.owner !== me','false','tests/hub-team-grants-track-c.test.ts','Team grant feedback'),
('T5-team-identity','src/hub/catalog.ts','kind: z.literal("team"), teamId: uuid','kind: z.literal("team"), teamId: z.string()','tests/hub-team-grants-track-c.test.ts','creates one immutable'),
('T7-group-identity','src/hub/catalog.ts','  if (subject.kind === "group") validated(uuid, subject.group.objectId);\n','','tests/hub-team-grants-track-c.test.ts','retains immutable GUID'),
('T8-retained-grants','src/hub/teams/grant-schema.ts','UPDATE hub_grants SET subject_kind=subject_kind_before_teams;','UPDATE hub_grants SET subject_kind=\'person\';','tests/hub-team-grant-migration.test.ts','preserves every retained'),
('T9-selection-fence','src/hub/catalog.ts','\n            || this.core.atomic(db => JSON.stringify(read.call(reader, db, teamId))) !== image','','tests/hub-team-grants-track-c.test.ts','selected roster changes'),
]
p='src/hub/group-policy/impact-inventory.ts';s=Path(p).read_text();start=s.index('      if (grant.subject.kind === "team") {');end=s.index('      if (grant.subject.kind === "group") {',start)
items.insert(5,('T6-policy-impact',p,s[start:end],'      if (grant.subject.kind === "team") continue;\n','tests/hub-team-grants-track-c.test.ts','policy impact observes'))
import sys
start_index=int(sys.argv[1]) if len(sys.argv)>1 else 0
results=json.loads((root/"results.json").read_text())[:start_index] if start_index else []
for name,path,old,new,test,select in items[start_index:]:
    saved=Path(path).read_bytes();text=saved.decode();assert text.count(old)==1,(name,text.count(old))
    receipt={'name':name,'path':path,'beforeSha256':hashlib.sha256(saved).hexdigest(),'test':test,'selection':select}
    try:
        Path(path).write_text(text.replace(old,new));receipt['mutantSha256']=hashlib.sha256(Path(path).read_bytes()).hexdigest()
        for label,cmd in [('types',['node_modules/.bin/tsc','--noEmit','-p','tsconfig.test.json']),('test',['node_modules/.bin/vitest','run',test,'-t',select,'--maxWorkers=2'])]:
            load=os.getloadavg()[0]
            if load>10:raise RuntimeError(f'load hold {load}')
            with (root/(name+'-'+label+'.log')).open('w') as f:r=subprocess.run(cmd,stdout=f,stderr=subprocess.STDOUT)
            receipt[label]={'command':cmd,'exit':r.returncode,'startLoad1':load}
            if label=='types' and r.returncode:break
        receipt['caught']=receipt.get('types',{}).get('exit')==0 and receipt.get('test',{}).get('exit')==1 and 'AssertionError' in (root/(name+'-test.log')).read_text()
    finally:
        Path(path).write_bytes(saved);receipt['restored']=Path(path).read_bytes()==saved
        results.append(receipt);(root/'results.json').write_text(json.dumps(results,indent=2)+'\n')
        print(name,receipt.get('caught'),receipt.get('types',{}).get('exit'),flush=True)
    if not receipt['caught']:
        if name=='T7-group-identity':
            receipt['equivalentReason']='The explicit group UUID guard duplicates validation.person.objectId:uuid.'
            (root/'results.json').write_text(json.dumps(results,indent=2)+'\n')
        else:raise SystemExit(1)
print(sum(r.get('caught',False) for r in results),'caught;',sum('equivalentReason' in r for r in results),'equivalent; all exact restored',flush=True)
