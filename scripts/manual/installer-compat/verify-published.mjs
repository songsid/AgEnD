/** Read-only published-package auth/readiness contract probe. No FleetManager, backend or account is started.
 * Run in a networkless disposable container with scratch HOME/AGEND_HOME and AGEND_INSTALLER_COMPAT_CONTAINER=1.
 * Extract npm tarballs (without lifecycle scripts) under <dir>/<version>/package before running.
 */
import {readFileSync} from "node:fs";
import * as path from "node:path";
import {runInNewContext} from "node:vm";
import http from 'node:http';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
if(process.env.AGEND_INSTALLER_COMPAT_CONTAINER!=='1'||process.env.AGEND_INSTANCE_NAME)throw Error('Run this read-only probe in a disposable private container');
const packages=process.argv[2],before=process.argv[3],after=process.argv[4];
if(!packages||!before||!after)throw Error('Usage: verify-published.mjs <extracted-packages-dir> <before.ps1> <after.ps1>');
const receipts=[];
async function generatedProbe(source,port){
 const block=source.slice(source.indexOf('function Test-InstallerReady'),source.indexOf('function Merge-InstallIni'));
 const program=block.match(/\$js = '([^']+)'/)[1], processState={env:{AGEND_HOME:'/scratch/probe'},exitCode:0};
 await runInNewContext(program,{process:processState,fetch,AbortSignal,console,setTimeout:fn=>setTimeout(fn,1),require:name=>{
  if(name==='path')return path;
  if(name==='child_process')return {execFileSync:(bin,args)=>{if(bin!=='npm'||args.join(' ')!=='root -g')throw Error('Native boundary forbidden');return '/scratch/global'}};
  if(name==='module')return {createRequire:()=>name=>{if(name!=='js-yaml')throw Error('Unexpected dependency');return {load:()=>({health_port:port})}}};
  if(name==='fs')return {readFileSync:()=>''};throw Error('Unexpected module '+name);
 }});return processState.exitCode;
}
for(const version of ['2.3.1','2.3.2-beta.11']){
 const root=resolve(packages,version,'package');
 const auth=await import(pathToFileURL(root+'/dist/auth-api.js'));
 const {decideWebGate}=await import(pathToFileURL(root+'/dist/web-auth.js'));
 const requests=[];
 const server=http.createServer((req,res)=>{
  if(req.method!=='GET'){res.writeHead(405);res.end();return;}
  requests.push(req.url);const url=new URL(req.url,'http://127.0.0.1');
  if(!auth.bypassesWebGate(req,url.pathname,{web:{}},()=>false)){
   const decision=decideWebGate(req,url,'inert-test-token',null);
   if(decision.kind==='reject'){res.writeHead(decision.status,{'content-type':'application/json'});res.end(JSON.stringify({error:decision.reason}));return;}
  }
  if(auth.handleAuthRequest(req,res,url,{fleetConfig:null}))return;
  if(url.pathname==='/health'){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({status:'ok',startupComplete:true}));return;}
  res.writeHead(500);res.end('Unexpected route');
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{
  const base='http://127.0.0.1:'+server.address().port;
  const old=await fetch(base+'/');await old.text();
  const next=await fetch(base+'/signin');await next.text();
  const health=await fetch(base+'/health');const body=await health.json();
  const oldProgram=await generatedProbe(readFileSync(before,'utf8'),server.address().port);
  const fixedProgram=await generatedProbe(readFileSync(after,'utf8'),server.address().port);
  receipts.push({version,old:{status:old.status,path:new URL(old.url).pathname,ready:old.ok&&health.ok&&body.startupComplete},fixed:{status:next.status,path:new URL(next.url).pathname,ready:next.ok&&health.ok&&body.startupComplete},generatedProgram:{oldExit:oldProgram,fixedExit:fixedProgram},requestCounts:Object.fromEntries([...new Set(requests)].map(p=>[p,requests.filter(x=>x===p).length]))});
 }finally{await new Promise(r=>server.close(r));}
}
console.log(JSON.stringify(receipts,null,2));
if(!receipts.every(r=>!r.old.ready&&r.old.status===401&&r.fixed.ready&&r.fixed.status===200&&r.generatedProgram.oldExit===1&&r.generatedProgram.fixedExit===0))process.exitCode=1;
