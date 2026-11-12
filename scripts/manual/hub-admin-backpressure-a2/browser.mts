/** Full production Hub shell and client; recorded API DTOs with controlled read admission. No live Fleet/AD/account. */
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir, loadavg } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
const repo=process.cwd(), out=process.env.OUT!, base=process.env.BASE_REF??'a11aa634c1b728663d3364a57d629c5d52dea706';
if(loadavg()[0]>10)throw Error('Defer: host load above 10');
mkdirSync(out,{recursive:true}); const home=mkdtempSync(join(tmpdir(),'hub-admin-busy-'));process.env.AGEND_HOME=home;
const git=(...args:string[])=>execFileSync('git',args,{encoding:'utf8',cwd:repo}).trim();
const hash=(body:any)=>createHash('sha256').update(body).digest('hex');
const input=['src/ui/hub-client.js','src/ui/hub-company-join.js','src/ui/hub-join-steps.js','src/ui/hub-enrolment-code.js','scripts/manual/hub-admin-backpressure-a2/browser.mts'];
const result:any={head:git('rev-parse','HEAD'),tree:git('rev-parse','HEAD^{tree}'),dirty:git('status','--porcelain','--untracked-files=no'),base,inputDigests:{},servedDigests:{},cases:[],checks:[],substitutions:[],scope:'Production Hub shell/renderer/browser. Controlled recorded GET DTOs and 4-read cap; no AD, account, write, daemon or container. Actual HubCore physical cap is separately tested over cookie HTTP.'};
for(const p of input)(result.inputDigests[hash(readFileSync(join(repo,p)))]??=[]).push(p);
const check=(name:string,ok:any)=>{result.checks.push({name,ok:!!ok});if(!ok)throw Error(name);};
const policy={realm:'corp',generation:'g1',revision:1,state:'enabled',groups:[{group:{realm:'corp',objectId:'11111111-1111-4111-8111-111111111111'},dn:'CN=Owners,DC=example,DC=test',allow:['ask_agents','pair_fleet'],maxFleets:1}],denies:[]};
let rig:any,browser:any,activeCase:any,active=0;
const server=createServer(async(req,res)=>{
 const path=req.url??'';
 if(path.startsWith('/hub/v1/')){
  if(req.method!=='GET'){activeCase?.writes.push(path);res.writeHead(405);res.end('{}');return;}
  const r=activeCase;active++;r.peak=Math.max(r.peak,active);let status=200;
  const count=r.counts[path]=(r.counts[path]??0)+1;
  if(active>(r.cap??4)||path==='/hub/v1/admin/company-join'&&(r.mode==='exhausted'&&!r.released||r.mode==='transient'&&count===1))status=429;
  await new Promise(done=>setTimeout(done,60));active--;
  let body:any={};
  if(path==='/hub/v1/session')body={signedIn:true,admin:true,csrf:'fixture-csrf',displayName:'Ada Admin',login:'ada',hub:{name:'研究 Hub'},features:['company-join-v1','group-policy-v1','enrolment-code-v1']};
  else if(path==='/hub/v1/admin/overview')body={fleets:[],pairings:[]};
  else if(path==='/hub/v1/admin/group-policy')body={supported:true,binding:'ready',policy,paused:[]};
  else if(path==='/hub/v1/admin/company-join')body={enabled:true,revision:1,companyLink:'https://hub.example.test/join-info#hub=Zml4dHVyZQ'};
  else if(path==='/hub/v1/admin/enrolment-codes')body={codes:[]};
  else if(path==='/hub/v1/admin/hub')body={name:'研究 Hub',hubId:rig.hubId,fingerprint:'a'.repeat(64),version:'2.4.0-alpha.201'};
  else body={rooms:[],askable:[],notices:[],mode:'legacy'};
  r.requests.push({path,status});res.writeHead(status,{'Content-Type':'application/json',...(status===429?{'Retry-After':'1'}:{})});res.end(JSON.stringify(status===429?{code:'backpressure'}:body));return;
 }
 if(!rig.http.handle(req,res)){res.writeHead(404);res.end();}
});
try{
 await new Promise<void>((done,fail)=>{server.once('error',fail);server.listen(0,'127.0.0.1',()=>{server.removeListener('error',fail);done();});});
 const origin='http://127.0.0.1:'+(server.address() as any).port;
 const {s3bRig}=await import(repo+'/tests/helpers/hub-s3b-rig.ts');rig=await s3bRig({webOrigin:origin});
 const pw=createRequire(process.env.PW_DIR+'/')('playwright-core');browser=await pw.chromium.launch({executablePath:process.env.CHROME,args:['--no-sandbox']});result.browser=browser.version();
 const cases:any[]=[];
 for(const theme of ['light','dark'])for(const lang of ['en','zh-TW'])for(const mode of ['normal','transient','exhausted'])cases.push({theme,lang,mode});
 cases.push({theme:'light',lang:'zh-TW',mode:'before'},{theme:'dark',lang:'en',mode:'old-company'},{theme:'light',lang:'en',mode:'old-client',cap:32});
 for(const spec of cases){
  if(loadavg()[0]>10)throw Error('Paused: host load above 10');
  const r:any={...spec,peak:0,counts:{},requests:[],writes:[],errors:[]};activeCase=r;result.cases.push(r);
  const ctx=await browser.newContext({viewport:{width:1366,height:1000},colorScheme:spec.theme});
  try{
   await ctx.addInitScript(({lang,theme}:any)=>{(window as any).__name=(fn:any)=>fn;localStorage.setItem('agend_lang',lang);localStorage.setItem('agend_theme',theme);localStorage.setItem('agend_tour_done','1');},{lang:spec.lang,theme:spec.theme});
   const replaced=spec.mode==='before'?input.filter(p=>p.startsWith('src/ui/')):spec.mode==='old-company'?['src/ui/hub-company-join.js']:spec.mode==='old-client'?['src/ui/hub-client.js']:[];
   for(const file of replaced){const body=execFileSync('git',['show',base+':'+file],{cwd:repo});result.substitutions.push({case:spec.mode,path:file,ref:base,digest:hash(body)});await ctx.route('**/ui/js/'+file.split('/').at(-1),(route:any)=>route.fulfill({status:200,contentType:'text/javascript',body}));}
   const p=await ctx.newPage(),resources:Promise<any>[]=[];p.on('pageerror',(e:any)=>r.errors.push(e.message));p.on('response',(res:any)=>{const path=new URL(res.url()).pathname;if(/\.(css|js)$/.test(path))resources.push((async()=>{const key=hash(await res.body());const a=result.servedDigests[key]??=[];if(!a.includes(path))a.push(path);})().catch(()=>{}));});
   await p.goto(origin+'/ui/hub/admin');
   const create=p.getByRole('button',{name:spec.lang==='en'?'Create join code':'建立加入碼',exact:true});
   const tag=spec.mode+'-'+spec.theme+'-'+spec.lang;
   if(spec.mode==='before'){
    await p.waitForTimeout(1800);check(tag+' original burst causes429',r.requests.some((x:any)=>x.status===429));
    await p.screenshot({path:join(out,tag+'.png'),fullPage:true});
   }else{
    if(spec.mode==='exhausted'){
     await p.locator('.hub-join-card [role=alert]').waitFor();
     check(tag+' stopped after4 company attempts',r.counts['/hub/v1/admin/company-join']===4);
     check(tag+' known group completion retained',await p.locator('[data-step="2"]').evaluate((e:any)=>e.classList.contains('done')));
     check(tag+' no false incomplete message',!(await p.locator('.hub-join-card').innerText()).includes(spec.lang==='en'?'Finish steps 1 and 2 first.':'請先完成步驟 1 和 2。'));
     await p.screenshot({path:join(out,tag+'-retry.png'),fullPage:true});r.released=true;
     await p.locator('.hub-join-card [role=alert] button').click();
    }
    await create.waitFor();await p.waitForFunction((label:string)=>[...document.querySelectorAll('button')].some(b=>b.textContent===label&&!b.disabled),spec.lang==='en'?'Create join code':'建立加入碼');
    check(tag+' steps1and2 done',await p.locator('[data-step="1"].done').count()===1&&await p.locator('[data-step="2"].done').count()===1);
    if(!spec.mode.startsWith('old-'))check(tag+' peak1',r.peak===1);
    check(tag+' no horizontal overflow',await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
    await p.screenshot({path:join(out,tag+'-ready.png'),fullPage:true});
   }
   await Promise.all(resources);check(tag+' no browser errors',r.errors.length===0);check(tag+' no writes',r.writes.length===0);
  }finally{await ctx.close();}
 }
 result.status='PASS';
}catch(e:any){result.status='FAIL';result.error=e.stack;throw e;}
finally{await browser?.close();server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));await rig?.close();rmSync(home,{recursive:true,force:true});result.cleaned=true;writeFileSync(join(out,'receipt.json'),JSON.stringify(result,null,2)+'\n');}
console.log(JSON.stringify({status:result.status,cases:result.cases.length,checks:result.checks.length,out}));
