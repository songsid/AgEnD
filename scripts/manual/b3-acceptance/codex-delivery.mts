import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {execFileSync} from 'node:child_process';
import {mkdirSync,mkdtempSync,writeFileSync,readFileSync,readlinkSync,readdirSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import pino from 'pino';
const out=process.env.OUT!,bin=process.env.CODEX_BIN!;mkdirSync(out,{recursive:true});
const root=mkdtempSync('/home/han/Projects/AgEnD-agend-dev-sol/.b3codex-');
const home=join(root,'h'),shared=join(root,'c'),cwd=join(root,'w'),inst=join(root,'i');for(const d of[home,shared,cwd,inst])mkdirSync(d);
process.env.HOME=home;process.env.CODEX_HOME=shared;process.env.AGEND_HOME=join(root,'a');
const bindir=join(root,'bin');mkdirSync(bindir);writeFileSync(join(bindir,'codex'),'#!/bin/sh\nexec '+JSON.stringify(bin)+' "$@"\n',{mode:0o700});process.env.PATH=bindir+':'+process.env.PATH;
const records:any[]=[];const requests:string[]=[];let slow=false,busy=false,n=0;
const wait=async(fn:()=>boolean,ms=30000)=>{const until=Date.now()+ms;while(!fn()&&Date.now()<until)await new Promise(r=>setTimeout(r,100));assert(fn(),'bounded signal not observed');};
function user(b:any){if(typeof b.input==='string')return b.input;const m=(b.input||[]).filter((x:any)=>x.role==='user').at(-1);return typeof m?.content==='string'?m.content:(m?.content||[]).map((x:any)=>x.text||'').join('\n');}
const s=createServer((req,res)=>{let raw='';req.on('data',c=>raw+=c);req.on('end',()=>{
 if(req.method==='GET'&&req.url?.includes('/models')){res.writeHead(200,{'content-type':'application/json'});res.end('{"models":[]}');return;}
 if(req.method!=='POST'||!req.url?.startsWith('/v1/responses')){res.writeHead(404);res.end();return;}
 const b=JSON.parse(raw),text=user(b);requests.push(text);const id='r'+(++n);const delayed=slow;busy=delayed;
 const event=(type:string,body:any)=>res.write('event: '+type+'\ndata: '+JSON.stringify({type,...body})+'\n\n');
 res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache'});event('response.created',{response:{id}});
 const finish=()=>{event('response.output_item.done',{item:{type:'message',role:'assistant',id:'m'+n,content:[{type:'output_text',text:'ack '+text.slice(-100)}]}});event('response.completed',{response:{id,usage:{input_tokens:10,output_tokens:2,total_tokens:12}}});res.end();busy=false;};
 if(delayed)setTimeout(finish,8000);else finish();
 });});await new Promise<void>(r=>s.listen(0,'127.0.0.1',r));
const port=(s.address()as any).port;
writeFileSync(join(shared,'config.toml'),`model="mock-model"\nmodel_provider="mock"\n[model_providers.mock]\nname="mock"\nbase_url="http://127.0.0.1:${port}/v1"\nwire_api="responses"\nrequires_openai_auth=false\n`);
const {CodexBackend}=await import('../../../src/backend/codex.js');
const {TmuxManager}=await import('../../../src/tmux-manager.js');
const {Daemon}=await import('../../../src/daemon.js');const {DEFAULT_INSTANCE_CONFIG}=await import('../../../src/config.js');
const socket='b3-codex-'+process.pid;TmuxManager.setSocketName(socket);const b=new CodexBackend(inst);let pane:any;
const cfg:any={workingDirectory:cwd,instanceDir:inst,instanceName:'b3proof',mcpServers:{},skipPermissions:true,skipResume:true};
b.writeConfig(cfg);b.preTrust(cwd);
const d:any=new Daemon('b3proof',{...DEFAULT_INSTANCE_CONFIG,backend:'codex',working_directory:cwd,log_level:'silent'}as any,inst,true,b,undefined,pino({level:'silent'}));
const tmux=(...a:string[])=>execFileSync('tmux',['-L',socket,...a],{encoding:'utf8'});
async function launch(resume:boolean){cfg.skipResume=!resume;const cmd=b.buildCommand(cfg);pane=new TmuxManager('b3proof','',{columns:120,rows:40});await pane.createWindow(cmd,cwd,resume?'resumed':'fresh');d.tmux=pane;try{await wait(asyncReady,60000);}catch(e){writeFileSync(join(out,'startup-failure.pane.txt'),(await pane.capturePane()).replaceAll(root,'<scratch>'));throw e;}return cmd;}
let ready=false;function asyncReady(){return ready;}
const timer=setInterval(()=>{if(pane)void pane.capturePane().then((p:string)=>{ready=b.getReadyPattern().test(p)&&b.isDeliveryInputReadyPane(p);}).catch(()=>{});},200);
async function deliver(label:string,text:string){const before=await pane.capturePane();assert.equal((await d.probeBlockingDialog()).state,'clear',label+':dialog');assert(await pane.pasteBuffer(text),label+':paste');await new Promise(r=>setTimeout(r,400));assert(await d.sendDeliveryEnter('initial-submit'),label+':Enter');await wait(()=>requests.some(x=>x.includes(text)),45000);writeFileSync(join(out,label+'.pane.txt'),before.replaceAll(root,'<scratch>'));records.push({label,clear:true,paste:true,enter:true,apiReceived:true});}
let complete=false;
try{
 await TmuxManager.ensureSession('b3proof');await launch(false);await deliver('idle','B3_CODEX_IDLE');
 slow=true;await deliver('busy-seed','B3_CODEX_SLOW');await wait(()=>busy);slow=false;assert(busy);await deliver('busy','B3_CODEX_BUSY');
 await wait(()=>!busy);await new Promise(r=>setTimeout(r,700));await pane.killWindow();ready=false;const command=await launch(true);assert(command.includes('resume'),'production resume plan absent');await deliver('resumed','B3_CODEX_RESUMED');complete=true;
}finally{
 clearInterval(timer);try{tmux('kill-server');}catch{};
 // Managed Codex children can outlive the pane: match only this private network namespace and the audited executable.
 const ns=readlinkSync('/proc/self/ns/net'),owned:any[]=[];
 for(const p of readdirSync('/proc').filter(x=>/^\d+$/.test(x))){try{if(readlinkSync('/proc/'+p+'/ns/net')!==ns)continue;const exe=readlinkSync('/proc/'+p+'/exe');if(exe!==bin)continue;const stat=readFileSync('/proc/'+p+'/stat','utf8').split(') ')[1].split(' ');owned.push({pid:Number(p),start:stat[19]});process.kill(Number(p),'SIGTERM');}catch{}}
 await new Promise(r=>setTimeout(r,500));const alive=owned.filter(x=>{try{return readFileSync('/proc/'+x.pid+'/stat','utf8').split(') ')[1].split(' ')[19]===x.start;}catch{return false;}});
 s.closeAllConnections();await new Promise<void>(r=>s.close(()=>r()));rmSync(root,{recursive:true,force:true});
 writeFileSync(join(out,'receipt.json'),JSON.stringify({head:process.env.CANDIDATE,binarySha256:createHash('sha256').update(readFileSync(bin)).digest('hex'),version:'0.167.0',complete,cases:records,mockOnly:true,privateSocket:socket,managedChildren:owned,remainingManaged:alive,scratchRemoved:true},null,2));assert.equal(alive.length,0,'managed child cleanup');
}
