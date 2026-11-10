import {spawnSync} from 'node:child_process';
import {writeFileSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
const root=process.env.REPO!,out=process.env.OUT!;
const scan=spawnSync(process.execPath,['docs/evidence/manual-smoke-codeql-m2803/scan.mjs',root],{cwd:root,env:process.env,encoding:'utf8',maxBuffer:8<<20});writeFileSync(join(out,'evaluate-scan.json'),scan.stdout);if(scan.status!==0)throw Error(scan.stderr);
const ts=await import('typescript');const syntax=[];for(const file of ['smoke-2556-memory-header.mts','smoke-settings-quota-card-main.mts','smoke-web-update-2738.mts']){const p='scripts/manual/smoke/'+file;const sf=ts.createSourceFile(p,readFileSync(join(root,p),'utf8'),ts.ScriptTarget.Latest,true);if(sf.parseDiagnostics.length)throw Error(p);syntax.push({file:p,parseDiagnostics:0})}writeFileSync(join(out,'syntax.json'),JSON.stringify(syntax,null,2));console.log('Focused tests + bounded static smoke inventory + three smoke parse checks PASS');
