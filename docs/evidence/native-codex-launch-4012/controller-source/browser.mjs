import {readFile,writeFile,mkdir} from 'node:fs/promises';import {spawn} from 'node:child_process';import {join} from 'node:path';import assert from 'node:assert/strict';
const [root,label]=process.argv.slice(2);assert(root&&/^m4012-[A-Z0-9-]+$/i.test(label));
const auth=JSON.parse(await readFile(join(root,'browser-auth.json'),'utf8'));
const check=await fetch(auth.base+'/health');assert.equal(check.headers.get('x-m4012-scratch'),auth.tag,'Wrong owned Web listener');
const profile=join(root,'browser-'+label);await mkdir(profile,{recursive:false});
const edge=spawn('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-component-update','--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'],{shell:false,stdio:['ignore','ignore','pipe'],windowsHide:true});
let exited=false;edge.once('close',()=>{exited=true;});let socket,seq=0;const pending=new Map();let sid;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
try{
 let stderr='';const endpoint=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Owned Edge startup timeout')),30000);edge.stderr.on('data',b=>{stderr=(stderr+b.toString()).slice(-8192);const m=/DevTools listening on (ws:\/\/127\.0\.0\.1:[0-9]+\/[^\s]+)/.exec(stderr);if(m){clearTimeout(timer);resolve(m[1]);}});edge.once('close',()=>{clearTimeout(timer);reject(Error('Owned Edge exited before debugging endpoint'));});});
 socket=new WebSocket(endpoint);await new Promise((r,j)=>{socket.addEventListener('open',r,{once:true});socket.addEventListener('error',j,{once:true});});
 socket.addEventListener('message',e=>{const x=JSON.parse(String(e.data));const p=pending.get(x.id);if(p){pending.delete(x.id);x.error?p.reject(Error('CDP command failed')):p.resolve(x.result);}});
 const call=(method,params={},sessionId=sid)=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}));});
 const target=await call('Target.createTarget',{url:'about:blank'},null);sid=(await call('Target.attachToTarget',{targetId:target.targetId,flatten:true},null)).sessionId;
 const net=[];socket.addEventListener('message',e=>{const x=JSON.parse(String(e.data));if(x.method==='Network.responseReceived'&&x.params.response.status>=400)net.push({status:x.params.response.status,url:new URL(x.params.response.url).pathname});});await call('Network.enable');await call('Page.enable');await call('Runtime.enable');await call('Emulation.setDeviceMetricsOverride',{width:1280,height:960,deviceScaleFactor:1,mobile:false});
 const evaluate=async expression=>{const r=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error('Browser evaluation failed');return r.result?.value;};
 const until=async(fn,ms=20000)=>{const end=Date.now()+ms;while(Date.now()<end){if(await fn())return;await sleep(150);}throw Error('Owned UI readiness timeout');};
 await call('Page.navigate',{url:auth.base+'/signin'});
 await until(()=>evaluate('Boolean(document.querySelector("#code")) && document.querySelector("#form")?.hidden === false'));
 await evaluate(`(()=>{const input=document.querySelector('input[autocomplete="one-time-code"]')||document.querySelector('input');input.value=${JSON.stringify(auth.code)};input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));const form=input.closest('form');if(form)form.requestSubmit();else document.querySelector('button[type="submit"]').click();return true})()`);
 try{await until(()=>evaluate('location.pathname.startsWith("/ui")'));}catch(e){await writeFile(join(root,label+'-diagnostic.json'),JSON.stringify({phase:'signin',net,body:await evaluate('document.body?.innerText'),path:await evaluate('location.pathname')}));throw e;}
 await call('Page.navigate',{url:auth.base+'/ui/chat/'+encodeURIComponent(auth.name)});
 try{await until(()=>evaluate('Boolean(document.querySelector("textarea")) && !document.body?.innerText?.includes("Cannot connect to AgEnD")'));}catch(e){await writeFile(join(root,label+'-diagnostic.json'),JSON.stringify({net,body:await evaluate('document.body?.innerText'),poll:await evaluate('fetch("/ui/poll").then(async r=>({status:r.status,body:await r.text()}))')}));throw e;}
 await sleep(1000);
 const marks=await evaluate('({queued:document.querySelectorAll(".tick-queued").length,processing:document.querySelectorAll(".tick-processing").length,delivered:document.querySelectorAll(".tick-delivered").length,failed:document.querySelectorAll(".tick-failed").length})');
 const png=await call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});await writeFile(join(root,label+'.png'),Buffer.from(png.data,'base64'));
 await call('Browser.close',{},null).catch(()=>{});const end=Date.now()+10000;while(!exited&&Date.now()<end)await sleep(50);assert(exited,'Owned browser close unconfirmed');
 console.log(JSON.stringify({label,marks,browserClosed:true}));
}finally{
 if(socket?.readyState===1){try{socket.send(JSON.stringify({id:++seq,method:'Browser.close'}));}catch{}}socket?.close();
 const end=Date.now()+10000;while(!exited&&Date.now()<end)await sleep(50);
 if(!exited){edge.kill();await sleep(500);} // Only the exact fresh browser child, never the user's browser.
}
