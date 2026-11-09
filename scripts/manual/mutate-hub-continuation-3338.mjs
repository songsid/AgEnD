// Focused semantic mutations; always restores source, refuses an unmatched edit.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const ui='src/ui/settings-hub.js',panel='src/ui/panel-hub.js',server='src/hub/http/compose.ts';
const mutations=[
 ['browser instead of member',server,'memberOrigin: deps.config.memberOrigin','memberOrigin: deps.config.webOrigin','tests/hub-s3b-server.test.ts'],
 ['omit member address',server,'{ ...offer, memberOrigin: deps.config.memberOrigin }','offer','tests/hub-s3b-server.test.ts'],
 ['generic Hub landing',ui,'/ui/hub/exposures?agent=${encodeURIComponent(row.exposureId)}&grant=1','/ui/hub','tests/hub-continuation-3338.test.ts'],
 ['pending continuation',ui,'&& !row.pending &&','&&','tests/hub-continuation-3338.test.ts'],
 ['withdrawn continuation',ui,'row.state === "published" && !row.pending','!row.pending','tests/hub-continuation-3338.test.ts'],
 ['missing committed ID',ui,'&& /^[a-f0-9-]{36}$/.test(row.exposureId || "")','', 'tests/hub-continuation-3338.test.ts'],
 ['stale pairing rows',ui,'key=${`${p.binding}|${p.hub.hubId}|${p.hub.fingerprint?.digest}|${safeWebOrigin(p)}`}','', 'tests/hub-continuation-3338.test.ts'],
 ['no intent accepted',panel,'new URLSearchParams(location.search).get("grant") === "1"','true','tests/hub-continuation-3338.test.ts'],
 ['intent ignored',panel,'new URLSearchParams(location.search).get("grant") === "1"','false','tests/hub-continuation-3338.test.ts'],
 ['asker treated as owner',panel,'mine.find((e) => e.id === id)','[...mine, ...(cat?.askable || [])].find((e) => e.id === id)','tests/hub-continuation-3338.test.ts'],
 ['revision lost',panel,'exposureRevision: x.revision, login: form.login.trim()','exposureRevision: 0, login: form.login.trim()','tests/hub-continuation-3338.test.ts'],
 ['cached dictionary fallback',ui,'${allowOnHubLabel()}','${hw("allowOnHub")}','tests/hub-continuation-3338.test.ts'],
];
mkdirSync('.artifacts/hub-continuation',{recursive:true});const results=[];
for(const[name,file,from,to,test]of mutations){if(process.env.MUTATION&&name!==process.env.MUTATION)continue;const original=readFileSync(file,'utf8');if(!original.includes(from))throw Error('unmatched mutation: '+name);try{writeFileSync(file,original.replace(from,to));const run=spawnSync(process.execPath,['node_modules/vitest/vitest.mjs','run',test,'--reporter=dot'],{encoding:'utf8',timeout:90000,maxBuffer:2<<20});const killed=run.status!==null&&run.status!==0&&!run.error;results.push({name,killed,status:run.status});writeFileSync('.artifacts/hub-continuation/mutant-'+results.length+'.log',run.stdout+run.stderr);console.log((killed?'CAUGHT ':'SURVIVED ')+name)}finally{writeFileSync(file,original)}}
writeFileSync('.artifacts/hub-continuation/mutations.json',JSON.stringify(results,null,2));if(results.some(x=>!x.killed))process.exitCode=1;
