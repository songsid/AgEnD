/** Sequential presentation/dataflow guard reversals; run alone, restore every original. */
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';import {spawnSync} from 'node:child_process';import {resolve,join} from 'node:path';
const out=resolve(process.env.OUT??'.artifacts/admin-reversals');mkdirSync(out,{recursive:true});
const unit=[
 ['server-feature','src/ui/panel-hub.js','const accessEntry = companyJoin &&','const accessEntry ='],
 ['one-leading-entry','src/ui/panel-hub.js','groups && !accessEntry ? html','groups ? html'],
 ['manual-fold','src/ui/panel-hub.js','accessEntry ? "details" : "div"','"div"'],
 ['manual-attention','src/ui/panel-hub.js','!!offer || pairings.some(p => p.ownerConfirmed && !p.adminApproved)','!!offer'],
 ['exact-copy','src/ui/hub-company-join.js','navigator.clipboard.writeText(view.companyLink)','navigator.clipboard.writeText(location.origin)'],
 ['exact-individual','src/ui/hub-company-join.js','{ login: inviteLogin.trim() }','{ login: "another-person" }'],
 ['invitation-scope','src/ui/hub-company-join.js',' ${hj("inviteScope")}',''],
 ['off-retained-link','src/ui/hub-company-join.js','!view?.enabled || !view?.companyLink || busy || !!error','!view?.companyLink || busy || !!error'],
 ['unknown-copy','src/ui/hub-company-join.js','hj(view ? view.enabled ? "colleagueHint" : "offHint" : "loading")','hj(view?.enabled ? "colleagueHint" : "offHint")'],
];
const results=[];
for(const[name,file,from,to]of unit){const original=readFileSync(file,'utf8');if(!original.includes(from))throw Error('Missing '+name);let r;try{writeFileSync(file,original.replace(from,to));r=spawnSync('npx',['vitest','run','tests/hub-admin-entry-ui.test.ts','--reporter=json','--outputFile='+join(out,name+'.json')],{encoding:'utf8',timeout:120000});writeFileSync(join(out,name+'.log'),(r.stdout??'')+(r.stderr??''));}finally{writeFileSync(file,original);}const j=JSON.parse(readFileSync(join(out,name+'.json'),'utf8')),fail=j.testResults.flatMap(t=>t.assertionResults??[]).filter(a=>a.status==='failed');results.push({name,kind:'mounted-unit',caught:r.status!==0&&fail.length>0&&fail.length===j.numFailedTests,failed:j.numFailedTests,assertions:fail.map(a=>a.fullName)});console.log(name,results.at(-1).caught?'CAUGHT':'SURVIVED');}
if(process.env.BROWSER==='1')for(const[name,file,from,to,skew]of[
 ['company-module-mark','src/ui/panel-hub.js','companyViews.companyJoinAdminEntryV1 === true','true','old-company'],
 ['company-words-mark','src/ui/hub-company-join.js','entryWords.companyAdminStringsV1 === true','true','old-words'],
 ['owner-words-mark','src/ui/panel-hub.js','ownerEntryWords.ownerAdminEntryV1 === true','true','old-owner-words']
]){const original=readFileSync(file,'utf8'),dest=join(out,name);let r;try{if(original.split(from).length!==2)throw Error('Ambiguous '+name);writeFileSync(file,original.replace(from,to));r=spawnSync(process.execPath,['--import','tsx','scripts/manual/hub-admin-entry/accept.mts'],{env:{...process.env,OUT:dest,MATRIX:'desk-light-en',SKEW:skew},encoding:'utf8',timeout:120000});writeFileSync(join(out,name+'.log'),(r.stdout??'')+(r.stderr??''));}finally{writeFileSync(file,original);}const j=JSON.parse(readFileSync(join(dest,'receipt.json'),'utf8'));results.push({name,kind:'owned-https-retained-module',caught:r.status!==0&&j.status==='FAIL'&&j.errors.length===0,reason:j.error,checks:j.checks,cleaned:j.cleaned});console.log(name,results.at(-1).caught?'CAUGHT':'SURVIVED');}
writeFileSync(join(out,'receipt.json'),JSON.stringify({results,restored:true},null,2));if(results.some(r=>!r.caught))process.exitCode=1;
