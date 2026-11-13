/** Actual previous/current Hub factories with private state backup; no package/systemd/host lifecycle. */
import { existsSync, mkdirSync, mkdtempSync, chmodSync, rmSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire, syncBuiltinESMExports } from 'node:module';
if(process.env.SAFE_RUN!=='1'||process.env.AGEND_OWNED_CONTAINER!=='hub-enrolment-code-b1'||!existsSync('/.dockerenv'))throw Error('Owned SAFE_RUN container required');
const out=process.env.OUT!,root=mkdtempSync(join(tmpdir(),'ridge-b1-rollback-'));mkdirSync(out,{recursive:true});
process.env.AGEND_HOME=join(root,'environment');mkdirSync(process.env.AGEND_HOME,{mode:0o700});
const tls=createRequire(import.meta.url)('node:tls'),original=tls.connect;let dc=0;
tls.connect=(o:any,...a:any[])=>original({...o,...(o.host==='127.0.0.1'&&o.port===636?{port:dc}:{})},...a);syncBuiltinESMExports();
const receipt:any={checks:[],legacy:'d2440106a2805187eb50a13c2385144192261f9a',boundary:'Owned source Hub factories with SQLite/TLS/synthetic LDAPS and a full private-home backup. Actual old bootstrap refusal/restored bootstrap; no npm package, systemd, runtime, pilot or real directory.'};
const check=(name:string,pass:boolean)=>{receipt.checks.push({name,pass});console.log(JSON.stringify({check:name,pass}));if(!pass)throw Error(name);};
let old:any,modern:any;
try{
 const {companyJoinRig}=await import('/legacy/tests/support/hub-company-join-rig.ts');old=await companyJoinRig((port:number)=>dc=port);
 check('previous Hub starts and serves metadata',(await old.call(null,'GET','/hub/v1/join/metadata')).status===200);
 await old.stopService();old.db.pragma('wal_checkpoint(TRUNCATE)');old.db.close();const backup=join(root,'backup.tar');execFileSync('tar',['-cpf',backup,'-C',old.home,'.']);chmodSync(backup,0o600);
 const {createHubServerFactory}=await import('/tmp/b1-dist/hub/compose/server.js');const http=await import('/tmp/b1-dist/hub/http/compose.js');
 const {hubTxDatabase}=await import('/tmp/b1-dist/hub/db.js');const {createHubDirectory}=await import('/tmp/b1-dist/hub/directory/directory.js');
 const create=createHubServerFactory({home:old.home,components:{http:async()=>({migrations:http.migrations,createHubHttp:(deps:any)=>http.createHubHttp(deps,hubTxDatabase)})},
  createDirectory:(cfg:any,secrets:any)=>createHubDirectory({...cfg,caPem:old.dcCerts.ca},secrets),report:()=>{},log:()=>{}});
 modern=await create(old.config,()=>true);await modern.start();
 const admin=await old.signIn('alice');check('upgraded company join enabled',(await old.call(admin,'PUT','/hub/v1/admin/company-join',{enabled:true,expectedRevision:1})).status===200);
 check('upgraded actual route creates first code/key',(await old.call(admin,'POST','/hub/v1/admin/enrolment-codes',{})).status===201);await modern.close();modern=undefined;
 let refusal='';try{await old.restartService();}catch(error:any){refusal=String(error);}
 check('previous Hub refuses upgraded component',refusal.includes('enrolment-code')&&refusal.includes('does not know'));receipt.refusal=refusal;
 rmSync(old.home,{recursive:true,force:true});mkdirSync(old.home,{mode:0o700});execFileSync('tar',['-xpf',backup,'-C',old.home]);
 const modes=(directory:string):any[]=>readdirSync(directory,{withFileTypes:true}).flatMap(e=>{const path=join(directory,e.name);return[{path:path.replace(old.home,'HOME'),mode:(statSync(path).mode&0o777).toString(8)},...(e.isDirectory()?modes(path):[])];});receipt.restoredModes=modes(old.home);
 await old.restartService();check('previous Hub starts after full pre-upgrade restore',(await old.call(null,'GET','/hub/v1/join/metadata')).status===200);
 check('restore removes the new key',!existsSync(join(old.home,'hub/secrets/enrolment-code.key')));receipt.ready=true;
}catch(error){receipt.error=String(error);console.error(error);process.exitCode=1;}
finally{await modern?.close();await old?.close();tls.connect=original;syncBuiltinESMExports();rmSync(root,{recursive:true,force:true});receipt.cleaned=true;writeFileSync(join(out,'rollback-receipt.json'),JSON.stringify(receipt,null,2));}
process.exit(receipt.ready?0:1);
