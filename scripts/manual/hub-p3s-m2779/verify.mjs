/** Run alone: semantic guard reversals with exact restoration, no browser/type/test job reading these files. */
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';import {spawnSync} from 'node:child_process';import {resolve,join} from 'node:path';
const out=resolve(process.env.OUT??'.artifacts/p3-reversals');mkdirSync(out,{recursive:true});
const cases=[
 ['render-page-language','src/ui/shared/app-shell.js','${pendingSummaryLine(line)}','${line}','tests/web-pending-hub-summary-3511.test.ts'],
 ['exact-target','src/ui/shared/app-shell.js','known[1] ?? known[2]','""','tests/web-pending-hub-summary-3511.test.ts'],
 ['unknown-extended-copy','src/ui/shared/app-shell.js','擇。)$/.exec(line)','擇。)/.exec(line)','tests/web-pending-hub-summary-3511.test.ts'],
 ['dialog-retained-session','src/ui/settings-hub-run.js','Valid sign-ins can resume when you turn it on again.','Everyone is signed out.','tests/hub-stop-copy-3512.test.ts'],
 ['client-summary-retained-session','src/ui/settings-hub-run.js','Valid sign-ins can resume after Run.','Everyone is signed out.','tests/hub-stop-copy-3512.test.ts'],
 ['server-summary-retained-session','src/locale.ts','Valid sign-ins can resume when it runs again.','Everyone is signed out.','tests/hub-stop-copy-3512.test.ts'],
 ['wording-whitelist-stays-exact','src/ui/shared/app-shell.js',null,null,'tests/named-link-test-2906.test.ts'],
];const results=[];
const selected=process.env.MAIN==="1"?cases.filter(c=>c[1]==="src/ui/shared/app-shell.js"):cases;
for(const[name,file,from,to,test]of selected){const original=readFileSync(file,'utf8');if(from&&!original.includes(from))throw Error('Missing '+name);let status;try{writeFileSync(file,from?original.replace(from,to):original+'\nconst forbiddenNetworkCopy = "Company network";\n');const r=spawnSync('npx',['vitest','run',test,'--reporter=json','--outputFile='+join(out,name+'.json')],{encoding:'utf8',timeout:120000});status=r.status;writeFileSync(join(out,name+'.log'),(r.stdout??'')+(r.stderr??''));}finally{writeFileSync(file,original);}const j=JSON.parse(readFileSync(join(out,name+'.json'),'utf8')),failed=j.testResults.flatMap(t=>t.assertionResults??[]).filter(a=>a.status==='failed');const row={name,caught:status!==0&&j.numFailedTests>0&&failed.length===j.numFailedTests,failed:j.numFailedTests,assertions:failed.map(a=>a.fullName),restored:readFileSync(file,'utf8')===original};results.push(row);console.log(name,row.caught?'CAUGHT':'SURVIVED');}
writeFileSync(join(out,'receipt.json'),JSON.stringify({results,restored:results.every(r=>r.restored)},null,2));if(results.some(r=>!r.caught||!r.restored))process.exitCode=1;
