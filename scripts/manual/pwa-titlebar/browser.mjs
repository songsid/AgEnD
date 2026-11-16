import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {spawn,execFileSync} from 'node:child_process';
import {join} from 'node:path';
import {createInterface} from 'node:readline';
const [root]=process.argv.slice(2), state=JSON.parse(await readFile(join(root,'private.json'),'utf8'));
assert(await readFile(join(root,'.owned'),'utf8')===state.tag);
let giveCode;const input=createInterface({input:process.stdin});input.on('line',line=>{const value=JSON.parse(line);assert(giveCode&&typeof value.code==='string');const done=giveCode;giveCode=null;done(value.code);});
const freshCode=()=>new Promise(resolve=>{giveCode=resolve;console.log(JSON.stringify({kind:'code-request'}));});
const profile=join(root,'edge-profile'); await mkdir(profile);
const edge=spawn('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',['--user-data-dir='+profile,'--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-component-update','--ignore-certificate-errors','--host-resolver-rules=MAP agend-pwa.test 127.0.0.1','--remote-debugging-port=0','about:blank'],{stdio:['ignore','ignore','pipe'],windowsHide:false});
let exited=false;edge.on('close',()=>{exited=true;});const sleep=ms=>new Promise(r=>setTimeout(r,ms));let ws,call,activeSid,phase='startup',seq=0;const pending=new Map(),installed=[];const result={cases:[]};
try{
 const endpoint=await new Promise((resolve,reject)=>{let s='';const timer=setTimeout(()=>reject(Error('Edge startup timeout')),20000);edge.stderr.on('data',b=>{s=(s+b).slice(-8000);const m=/DevTools listening on (ws:\/\/127\.0\.0\.1:[^\s]+)/.exec(s);if(m){clearTimeout(timer);resolve(m[1]);}});});
 ws=new WebSocket(endpoint);await new Promise((r,j)=>{ws.addEventListener('open',r,{once:true});ws.addEventListener('error',j,{once:true});});
 ws.addEventListener('message',e=>{const x=JSON.parse(String(e.data));const p=pending.get(x.id);if(p){pending.delete(x.id);x.error?p.reject(Error(p.method+': '+x.error.message)):p.resolve(x.result);}});
 call=(method,params={},sessionId)=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject,method});ws.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}));});
 const attach=async targetId=>(await call('Target.attachToTarget',{targetId,flatten:true})).sessionId;
 const evaluate=async(sid,expression)=>{const r=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true},sid);assert(!r.exceptionDetails,JSON.stringify(r.exceptionDetails));return r.result.value;};
 const until=async f=>{const end=Date.now()+25000;while(Date.now()<end){try{const v=await f();if(v)return v;}catch{}await sleep(150);}throw Error('Page readiness timeout');};
 result.browser=await call('Browser.getVersion');
 for(const entry of state.entries){
  phase=entry.label+':sign-in';console.log(JSON.stringify({phase}));
  const manifestId=entry.base+'/';const target=await call('Target.createTarget',{url:entry.base+'/signin'});const sid=await attach(target.targetId);activeSid=sid;
  await call('Page.enable',{},sid);await call('Runtime.enable',{},sid);
  if(entry.code){const loginCode=await freshCode();await until(()=>evaluate(sid,'Boolean(document.querySelector("#code")) && document.querySelector("#form")?.hidden === false'));await evaluate(sid,`(()=>{const i=document.querySelector('#code');i.value=${JSON.stringify(loginCode)};i.dispatchEvent(new Event('input',{bubbles:true}));i.closest('form').requestSubmit();return true})()`);await until(()=>evaluate(sid,'location.pathname.startsWith("/ui")'));}
  await call('Page.navigate',{url:entry.base+entry.path},sid);await until(()=>evaluate(sid,'Boolean(window.AgendTheme && document.querySelector(".panel-head, .p-hub-signin"))'));
  phase=entry.label+':manifest';console.log(JSON.stringify({phase}));
  const app=await call('Page.getAppManifest',{},sid);assert(!app.errors.length,JSON.stringify(app.errors));
  assert.equal(JSON.parse(app.data).display,'standalone');
  await call('PWA.install',{manifestId,installUrlOrBundleUrl:entry.base+entry.path});installed.push(manifestId);phase=entry.label+':installed';console.log(JSON.stringify({phase}));
  const launched=await call('PWA.launch',{manifestId,url:entry.base+entry.path}),appSid=await attach(launched.targetId);activeSid=appSid;
  await call('Page.enable',{},appSid);await call('Runtime.enable',{},appSid);
  await until(()=>evaluate(appSid,'Boolean(window.AgendTheme && document.querySelector(".panel-head, .p-hub-signin"))'));
  assert(await evaluate(appSid,'matchMedia("(display-mode: standalone)").matches'),'Not an installed standalone window');
  await call('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:'light'}]},appSid);
  for(const theme of ['light','dark']){
   await evaluate(appSid,`AgendTheme.set(${JSON.stringify(theme)})`);
   const color=await until(()=>evaluate(appSid,`document.querySelector('meta[name="theme-color"]').content===${JSON.stringify(theme==='dark'?'rgb(33, 33, 33)':'rgb(255, 255, 255)')} && document.querySelector('meta[name="theme-color"]').content`));
   await sleep(800);const label=entry.label+'-'+theme;phase=label;console.log(JSON.stringify({phase}));
   const p=join(root,label+'.png'),ps=process.env.SystemRoot+'\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
   const screen=JSON.parse(execFileSync(ps,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',join(root,'window.ps1'),'-Tag',state.tag,'-Out',p],{encoding:'utf8',windowsHide:true}));
   const channels=screen.captionColor.slice(1).match(/../g).map(v=>parseInt(v,16));
   assert(theme==='dark'?channels.every(v=>v<100):channels.every(v=>v>200),'Native caption did not follow '+theme+': '+screen.captionColor);
   result.cases.push({label,color,standalone:true,screen});
  }
  // Read the actual surface after a custom appearance arrives; no auth/settings changes.
  await evaluate(appSid,`(()=>{const el=document.querySelector('.panel-head')||document.body;el.style.backgroundColor='#17313f';return true})()`);
  const custom=await until(()=>evaluate(appSid,`document.querySelector('meta[name="theme-color"]').content==='rgb(23, 49, 63)'`));assert(custom);
  result.cases.push({label:entry.label+'-custom',color:'rgb(23, 49, 63)',live:true});
  result.osState=await call('PWA.getOsAppState',{manifestId});
  await call('PWA.uninstall',{manifestId});installed.splice(installed.indexOf(manifestId),1);
  await call('Target.closeTarget',{targetId:target.targetId});
 }
 result.passed=true;
 await writeFile(join(root,'result.json'),JSON.stringify(result,null,2)+'\n');
 await call('Browser.close');
 const end=Date.now()+12000;while(!exited&&Date.now()<end)await sleep(100);assert(exited,'Browser close not confirmed');
 console.log(JSON.stringify({passed:true,cases:result.cases.length,browserClosed:true,installedAppsRemaining:installed.length}));
}catch(error){
 if(ws?.readyState===1 && activeSid)try{const page=await call('Runtime.evaluate',{expression:'({url:location.href,body:document.body.innerText})',returnByValue:true},activeSid);await writeFile(join(root,'failure-private.json'),JSON.stringify({phase,page,error:String(error)})+'\n');}catch{}
 throw error;
}finally{
 if(ws?.readyState===1){for(const manifestId of [...installed]){await call('PWA.uninstall',{manifestId});installed.splice(installed.indexOf(manifestId),1);}await call('Browser.close').catch(()=>{});}
 input.close();process.stdin.pause();ws?.close();const end=Date.now()+10000;while(!exited&&Date.now()<end)await sleep(100);
 if(!exited)throw Error('Owned Edge process remains; preserve scratch for cleanup');
}
