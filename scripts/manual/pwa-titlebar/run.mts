/** WSL + installed Windows Chrome. Isolated web-only Fleet and test Hub; no live Fleet or CLI lifecycle. */
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,copyFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,win32} from 'node:path';
import {randomUUID} from 'node:crypto';
import {execFileSync,spawn} from 'node:child_process';
import {createServer} from 'node:https';
import {createInterface} from 'node:readline';
const out=resolve(process.env.OUT??'.artifacts/m3214/browser');mkdirSync(out,{recursive:true});
const browserProcess=process.env.PWA_BROWSER==='edge'?'msedge.exe':'chrome.exe';
const browserExecutable=browserProcess==='msedge.exe'?'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe':'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const tag='m3214-'+randomUUID(),home=mkdtempSync(join(tmpdir(),tag));process.env.AGEND_HOME=home;
const ps='/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
const powershell=(s:string)=>execFileSync(ps,['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(s,'utf16le').toString('base64')],{encoding:'utf8',timeout:20000}).trim();
const paths=JSON.parse(powershell("[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); @{profile=$env:USERPROFILE;node=(Get-Command node.exe).Source}|ConvertTo-Json -Compress"));
const nativeRoot=win32.join(paths.profile,'agend-adapter-proto',tag),root=execFileSync('wslpath',['-u',nativeRoot],{encoding:'utf8'}).trim();mkdirSync(root);writeFileSync(join(root,'.owned'),tag);
writeFileSync(join(out,'scope-private.json'),JSON.stringify({tag,root,nativeRoot,node:paths.node,browserProcess}));
let fm:any,hub:any,named:any;
try{
 const {FleetManager}=await import('../../../src/fleet-manager.ts');const {tokenEpoch}=await import('../../../src/web-session.ts');
 fm=new FleetManager(home);fm.healthPortRetried=true;const noop=()=>{};fm.logger={info:noop,warn:noop,error:noop,debug:noop,child:()=>fm.logger};
 fm.fleetConfig={defaults:{},instances:{},web:{allowed_hosts:['agend-pwa.test'],preview:false}};
 for(const key of ['startInstance','stopInstance','reconcile','handleUpdateCommand'])fm[key]=()=>{throw Error('Forbidden live lifecycle: '+key);};
 fm.startPreviewListener=()=>{};fm.initializeWebAuthTokens();await fm.startHealthServer(0);
 while(!fm.healthServerListening)await new Promise(r=>setTimeout(r,50));
 const base='http://127.0.0.1:'+fm.healthServer.address().port;
 const key=join(home,'key.pem'),cert=join(home,'cert.pem');execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-keyout',key,'-out',cert,'-subj','/CN=agend-pwa.test','-addext','subjectAltName=DNS:agend-pwa.test'],{stdio:'ignore'});
 named=createServer({key:readFileSync(key),cert:readFileSync(cert)},(req,res)=>fm.dispatchWebHttp(req,res,named.address().port));
 await new Promise<void>(r=>named.listen(0,'127.0.0.1',r));
 const namedBase='https://agend-pwa.test:'+named.address().port;
 const {s3bRig}=await import('../../../tests/helpers/hub-s3b-rig.ts');hub=await s3bRig();
 const code=()=>{fm.initializeWebSessions();return fm.webLoginCodes.issue({tier:'admin',epoch:tokenEpoch(fm.webToken)}).display;};
 writeFileSync(join(root,'private.json'),JSON.stringify({tag,browserExecutable,browserProcess,entries:[{label:'fleet-local',base,path:'/ui',code:true},{label:'fleet-named',base:namedBase,path:'/ui',code:true},{label:'hub-local',base:hub.base,path:'/ui/hub'}]}));
 for(const f of ['browser.mjs','window.ps1','app-menu.ps1'])copyFileSync(new URL(f,import.meta.url),join(root,f));
 const node=execFileSync('wslpath',['-u',paths.node],{encoding:'utf8'}).trim();
 const child=spawn(node,[win32.join(nativeRoot,'browser.mjs'),nativeRoot],{stdio:['pipe','pipe','inherit']});
 const lines=createInterface({input:child.stdout});lines.on('line',line=>{const row=JSON.parse(line);if(row.kind==='code-request')child.stdin.write(JSON.stringify({code:code()})+'\n');else console.log(line);});
 const exit=await new Promise(r=>child.on('close',r));assert.equal(exit,0);
 const result=JSON.parse(readFileSync(join(root,'result.json'),'utf8'));assert(result.passed);
 for(const row of result.cases)if(row.screen)copyFileSync(join(root,row.label+'.png'),join(out,row.label+'.png'));
 writeFileSync(join(out,'result.json'),JSON.stringify(result,null,2)+'\n');
 const remaining=JSON.parse(powershell(`@(Get-CimInstance Win32_Process -Filter "Name='${browserProcess}'" | Where-Object {$_.CommandLine -like '*${tag}*'} | Select-Object ProcessId)|ConvertTo-Json -Compress`)||'[]');assert.equal(Array.isArray(remaining)?remaining.length:1,0);
 assert.equal(readFileSync(join(root,'.owned'),'utf8'),tag);rmSync(root,{recursive:true});
 writeFileSync(join(out,'cleanup.json'),JSON.stringify({tag,browserClosed:true,installedAppsRemaining:0,ownedProcesses:0,scratchRemoved:true})+'\n');
}finally{
 await hub?.close();if(named)await new Promise<void>(r=>named.close(r));
 if(fm?.healthServer){fm.healthServer.closeAllConnections?.();await new Promise<void>(r=>fm.healthServer.close(r));}
 rmSync(home,{recursive:true,force:true});
}
