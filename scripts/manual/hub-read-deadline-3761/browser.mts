/** Owned HTTPS + production Hub shell, recorded DTOs. The120s UI timer is explicitly accelerated to1s. */
import { createServer } from 'node:https';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir, loadavg } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
const repo=process.cwd(),out=process.env.OUT!,base=process.env.BASE_REF??'719fb6f2c316de810e0cf86fcedc8851629d24ad';
if(loadavg()[0]>10)throw Error('Defer: load above10');mkdirSync(out,{recursive:true});
const home=mkdtempSync(join(tmpdir(),'hub-read-deadline-'));process.env.AGEND_HOME=home;
const git=(...a:string[])=>execFileSync('git',a,{cwd:repo,encoding:'utf8'}).trim(),hash=(b:any)=>createHash('sha256').update(b).digest('hex');
const result:any={head:git('rev-parse','HEAD'),tree:git('rev-parse','HEAD^{tree}'),dirty:git('status','--porcelain','--untracked-files=no'),base,inputDigests:{},servedDigests:{},substitutions:[],cases:[],checks:[],timerAcceleration:{from:120000,to:1000},scope:'Real owned HTTPS stalled headers/body, socket-close acknowledgement; production shell/client with recorded API DTOs. Timer acceleration only; no server/LDAP/Fleet/account operation.'};
for(const p of ['src/ui/hub-client.js','src/ui/hub-join-steps.js','src/ui/hub-enrolment-code.js','scripts/manual/hub-read-deadline-3761/browser.mts'])(result.inputDigests[hash(readFileSync(join(repo,p)))]??=[]).push(p);
const check=(name:string,ok:any)=>{result.checks.push({name,ok:!!ok});if(!ok)throw Error(name);};
const policy={realm:'corp',generation:'g1',revision:1,state:'enabled',groups:[{group:{realm:'corp',objectId:'11111111-1111-4111-8111-111111111111'},dn:'CN=Owners,DC=example,DC=test',allow:['ask_agents','pair_fleet'],maxFleets:1}],denies:[]};
const code={id:'22222222-2222-4222-8222-222222222222',code:'1234-ABCD',state:'live',uses:0,maxUses:30,inFlight:0,scope:{kind:'directory'},expiresAt:Date.now()+3600000,perPersonFleets:1};
let rig:any,browser:any,current:any;const held=new Set<any>(),sockets=new Set<any>();
const server=createServer((req,res)=>{
 const path=req.url??'';
 if(path.startsWith('/hub/v1/')){
  const r=current;if(req.method!=='GET'){r.writes.push(path);res.writeHead(405);res.end('{}');return;}
  r.requests.push(path);
  if(r.stall&&path==='/hub/v1/admin/enrolment-codes'){
   held.add(res);r.stalls++;
   const socket=req.socket;socket.once('close',()=>{r.closedStallSockets++;});
   res.once('close',()=>{held.delete(res);if(!res.writableEnded)r.abandoned++;});
   if(r.kind==='body'){res.writeHead(200,{'Content-Type':'application/json'});res.write('{"codes":');}
   return;
  }
  let body:any={};
  if(path==='/hub/v1/session')body={signedIn:true,admin:true,csrf:'owned-fixture',displayName:'Ada Admin',login:'ada',hub:{name:'研究 Hub'},features:['company-join-v1','group-policy-v1','enrolment-code-v1']};
  else if(path==='/hub/v1/admin/overview')body={fleets:[],pairings:[]};
  else if(path==='/hub/v1/admin/group-policy')body={supported:true,binding:'ready',policy,paused:[]};
  else if(path==='/hub/v1/admin/company-join')body={enabled:true,revision:1,companyLink:'https://hub.example.test/join-info#hub=Zml4dHVyZQ'};
  else if(path==='/hub/v1/admin/enrolment-codes')body={codes:[code]};
  else if(path==='/hub/v1/admin/hub')body={name:'研究 Hub',hubId:rig.hubId,fingerprint:'a'.repeat(64),version:'2.4.0-alpha.2'};
  else body={rooms:[],askable:[],notices:[],mode:'legacy'};
  res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(body));return;
 }
 if(!rig.http.handle(req,res)){res.writeHead(404);res.end();}
});
server.on('connection',s=>{sockets.add(s);s.once('close',()=>sockets.delete(s));});
try{
 await new Promise<void>((done,fail)=>{server.once('error',fail);server.listen(0,'127.0.0.1',()=>{server.removeListener('error',fail);done();});});
 const origin='https://127.0.0.1:'+(server.address() as any).port;
 const {createBrowserCertificate}=await import(repo+'/src/hub/init/browser-certificate.ts');const cert=await createBrowserCertificate(home,origin);server.setSecureContext({cert:readFileSync(cert.certFile),key:readFileSync(cert.keyFile)});
 const {s3bRig}=await import(repo+'/tests/helpers/hub-s3b-rig.ts');rig=await s3bRig({webOrigin:origin});
 const pw=createRequire(process.env.PW_DIR+'/')('playwright-core');browser=await pw.chromium.launch({executablePath:process.env.CHROME,args:['--no-sandbox']});result.browser=browser.version();
 const cases:any[]=[];for(const theme of ['light','dark'])for(const lang of ['en','zh-TW'])for(const kind of ['headers','body'])cases.push({theme,lang,kind});
 cases.push({theme:'light',lang:'en',kind:'headers',retained:'client'},{theme:'dark',lang:'zh-TW',kind:'body',retained:'client'},{theme:'light',lang:'zh-TW',kind:'body',retained:'ui'});
 for(const spec of cases){
  if(loadavg()[0]>10)throw Error('Paused: load above10');
  const r:any={...spec,requests:[],writes:[],errors:[],external:[],stall:false,stalls:0,abandoned:0,closedStallSockets:0};current=r;result.cases.push(r);
  const ctx=await browser.newContext({viewport:{width:1366,height:1000},colorScheme:spec.theme,ignoreHTTPSErrors:true});
  try{
   await ctx.route('**/*',(route:any)=>{const url=new URL(route.request().url());if(url.origin===origin)return route.continue();r.external.push(url.origin);return route.abort();});
   await ctx.addInitScript(({lang,theme}:any)=>{(window as any).__name=(f:any)=>f;localStorage.setItem('agend_lang',lang);localStorage.setItem('agend_theme',theme);localStorage.setItem('agend_tour_done','1');
    const native=window.setTimeout.bind(window);window.setTimeout=((fn:any,ms:any,...args:any[])=>native(fn,ms===120000?1000:ms,...args)) as any;},{lang:spec.lang,theme:spec.theme});
   const replaced=spec.retained==='client'?['hub-client.js']:spec.retained==='ui'?['hub-join-steps.js','hub-enrolment-code.js']:[];
   for(const file of replaced){const body=execFileSync('git',['show',base+':src/ui/'+file],{cwd:repo});result.substitutions.push({case:spec,ref:base,path:'src/ui/'+file,digest:hash(body)});await ctx.route('**/ui/js/'+file,(route:any)=>route.fulfill({status:200,contentType:'text/javascript',body}));}
   const p=await ctx.newPage(),resources:Promise<any>[]=[];p.on('pageerror',(e:any)=>r.errors.push(e.message));p.on('response',(res:any)=>{const path=new URL(res.url()).pathname;if(/\.(js|css)$/.test(path))resources.push((async()=>{const key=hash(await res.body()),a=result.servedDigests[key]??=[];if(!a.includes(path))a.push(path);})().catch(()=>{}));});
   const tag=[spec.retained??'candidate',spec.theme,spec.lang,spec.kind].join('-');
   await p.goto(origin+'/ui/hub/admin');const slot=p.locator('[data-enrolment-codes]');await slot.getByText('1234-ABCD',{exact:true}).waitFor();await p.locator('[data-step="2"].done').waitFor();await slot.scrollIntoViewIfNeeded();
   check(tag+' initial known step2',await p.locator('[data-step="2"].done').count()===1);
   await p.screenshot({path:join(out,tag+'-ready.png'),fullPage:true});
   r.stall=true;await p.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
   for(let i=0;i<100&&!r.stalls;i++)await new Promise(done=>setTimeout(done,20));check(tag+' held request admitted',r.stalls===1);
   await p.evaluate(()=>{(window as any).__nextRead=null;import('/ui/js/hub-client.js').then(m=>m.hubClient().adminOverview()).then(r=>{(window as any).__nextRead=r;});});
   if(spec.retained==='client'){
    await p.waitForTimeout(1400);check(tag+' original queue stuck',await p.evaluate(()=>(window as any).__nextRead===null));check(tag+' no early physical close',r.abandoned===0);
    await p.screenshot({path:join(out,tag+'-stuck.png'),fullPage:true});
   }else{
    await p.waitForFunction(()=>(window as any).__nextRead?.ok===true);
    await slot.getByRole('button',{name:spec.lang==='en'?'Try again':'再試一次',exact:true}).waitFor();
    for(let i=0;i<100&&!r.closedStallSockets;i++)await new Promise(done=>setTimeout(done,20));
    check(tag+' physical stalled socket closed',r.abandoned===1&&r.closedStallSockets===1&&held.size===0);
    check(tag+' no immediate timeout retry',r.stalls===1);
    check(tag+' known code display',await slot.getByText('1234-ABCD',{exact:true}).count()===(spec.retained==='ui'?0:1));
    await p.screenshot({path:join(out,tag+'-timeout.png'),fullPage:true});
    r.stall=false;await slot.getByRole('button',{name:spec.lang==='en'?'Try again':'再試一次',exact:true}).click();await slot.getByText('1234-ABCD',{exact:true}).waitFor();
    await p.waitForFunction((label:string)=>[...document.querySelectorAll('[data-enrolment-codes] button')].some(b=>b.textContent===label&&!(b as HTMLButtonElement).disabled),spec.lang==='en'?'Create join code':'建立加入碼');
    const create=slot.getByRole('button',{name:spec.lang==='en'?'Create join code':'建立加入碼',exact:true});check(tag+' manual Retry recovers',await create.isEnabled());
    await p.screenshot({path:join(out,tag+'-recovered.png'),fullPage:true});
   }
   check(tag+' no horizontal overflow',await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));check(tag+' no writes',r.writes.length===0);check(tag+' no external requests',r.external.length===0);check(tag+' no browser errors',r.errors.length===0);await Promise.all(resources);
  }finally{await ctx.close();for(let i=0;i<100&&held.size;i++)await new Promise(done=>setTimeout(done,10));check('context cleanup '+spec.kind,held.size===0);}
 }
 result.status='PASS';
}catch(e:any){result.status='FAIL';result.error=e.stack;throw e;}
finally{await browser?.close();for(const res of held)res.destroy();server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));await rig?.close();rmSync(home,{recursive:true,force:true});result.cleaned=true;result.remainingHeld=held.size;result.remainingSockets=sockets.size;writeFileSync(join(out,'receipt.json'),JSON.stringify(result,null,2)+'\n');}
console.log(JSON.stringify({status:result.status,cases:result.cases.length,checks:result.checks.length,out}));
