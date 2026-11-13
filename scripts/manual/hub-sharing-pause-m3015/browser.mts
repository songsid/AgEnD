/** One owned Chromium; real HTTPS/cookies/CSRF/SQLite/UI, inert directory and member. */
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir, loadavg } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:https';
import { execFileSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { createRequire } from 'node:module';
const repo=process.cwd(),out=process.env.OUT!,mode=process.env.MODE??'current',base=process.env.BASE_REF??'bc22d3b8422d2396d6806972df9d519eaab642de';
mkdirSync(out,{recursive:true});const home=mkdtempSync(join(tmpdir(),'hub-sharing-m3015-'));process.env.AGEND_HOME=home;
const digest=(s:any)=>createHash('sha256').update(s).digest('hex'),git=(...args:string[])=>execFileSync('git',args,{encoding:'utf8'}).trim();
const result:any={head:git('rev-parse','HEAD'),tree:git('rev-parse','HEAD^{tree}'),dirty:git('status','--porcelain','--untracked-files=no'),mode,base,
 inputDigests:{},servedDigests:{},substitutions:[],cases:[],checks:[],errors:[],requests:[],scope:'Owned production HTTPS/SQLite/session/CSRF server and real UI; inert AD/person/group/member facts. No live Fleet, account, AD or model. Before uses retained base panel on candidate server, not execution of a baseline server.'};
const paths=[...new Set([...git('diff','--name-only',base,'HEAD','--','src').split('\n').filter(Boolean),'tests/helpers/hub-s3b-rig.ts','scripts/manual/hub-sharing-pause-m3015/browser.mts'])];
for(const p of paths){const hash=digest(readFileSync(p));(result.inputDigests[hash]??=[]).push(p);}
const check=(name:string,ok:unknown)=>{result.checks.push({name,ok:!!ok});if(!ok)throw Error(name);};
result.font=execFileSync('fc-match',['sans:lang=zh-tw'],{encoding:'utf8'}).trim();
let rig:any,browser:any;const server=createServer((q,p)=>{if(!rig?.http.handle(q,p)){p.writeHead(404);p.end();}});
try{
 await new Promise<void>((done,fail)=>{server.once('error',fail);server.listen(0,'127.0.0.1',()=>{server.removeListener('error',fail);done();});});
 const origin='https://127.0.0.1:'+(server.address() as any).port;
 const {createBrowserCertificate}=await import(repo+'/src/hub/init/browser-certificate.ts');const cert=await createBrowserCertificate(home,origin);
 server.setSecureContext({cert:readFileSync(cert.certFile),key:readFileSync(cert.keyFile)});
 const {s3bRig}=await import(repo+'/tests/helpers/hub-s3b-rig.ts');rig=await s3bRig({webOrigin:origin});
 const owner=rig.addPerson('owner','Avery · 研究者'),asker=rig.addPerson('alex','Alex Chen · 陳同仁'),group={realm:'corp',objectId:randomUUID()},dn='CN=Engineering,DC=example,DC=test';
 Object.assign(rig.directory,{groupPolicy:'ad-direct-guid',resolvePolicyGroup:async()=>({ok:true,group:{key:group,dn}}),
  readPolicyGroups:async(person:any)=>({kind:'complete',person,groups:person.objectId===asker.objectId?[group.objectId]:[],observedAt:Date.now()})});
 const {groupPolicyMigration,createHubGroupPolicyStore}=await import(repo+'/src/hub/group-policy/store.ts');groupPolicyMigration(rig.hubId,'corp','directory-v1').up(rig.db);
 const policy=createHubGroupPolicyStore({db:rig.db,hubId:rig.hubId,realm:'corp',generation:'directory-v1',directory:rig.directory,audit:{appendInTransaction(){}} as any,current:()=>true});
 rig.httpDeps.grantDirectory={policy:()=>policy,binding:()=>({kind:'ready'})};await rig.restartHttp();
 const link=rig.link(randomUUID(),owner),pw=createRequire(process.env.PW_DIR+'/')('playwright-core');
 check('start load at most10',loadavg()[0]!<=10);browser=await pw.chromium.launch({executablePath:process.env.CHROME,args:['--no-sandbox']});result.browser=browser.version();
 const cases:any[]=[];for(const device of ['desk','phone'])for(const theme of ['light','dark'])for(const lang of ['en','zh-TW'])cases.push({device,theme,lang});
 if(mode==='current')for(const skew of ['old-client','old-words','old-css','old-server'])cases.push({device:'phone',theme:'light',lang:'zh-TW',skew});
 if(process.env.CASE_FILTER)for(let i=cases.length-1;i>=0;i--)if(![cases[i].skew??mode,cases[i].device,cases[i].theme,cases[i].lang].join('-').includes(process.env.CASE_FILTER))cases.splice(i,1);
 for(const [index,c]of cases.entries()){
  if(loadavg()[0]!>10){result.pausedAt={case:index,load:loadavg()[0]};throw Error('Host load exceeded10; stop owned campaign');}
  const id=randomUUID(),tag=[c.skew??mode,c.device,c.theme,c.lang].join('-');
  await rig.http.receive(rig.frame('exposure.snapshot',{revision:index+1,exposures:[{id,fleetId:link.fleetId,owner,displayName:'研究助手 · Research',revision:1,state:'published',dataViewId:'agent',allowedTools:[],policyDigest:'b'.repeat(64)}]},link),link);
  const o=await rig.signIn('owner'),a=await rig.signIn('alex');
  const g=await rig.call(o,'POST','/hub/v1/grants',{exposureId:id,exposureRevision:1,login:'alex',days:7});check(tag+' person grant',g.status===200);
  check(tag+' group grant',(await rig.call(o,'POST','/hub/v1/grants',{exposureId:id,exposureRevision:1,days:30,subject:{kind:'group',group,dn}})).status===200);
  const opened=await rig.call(a,'POST','/hub/v1/rooms',{exposureId:id,grantId:g.json.grant.id});check(tag+' room',opened.status===200);
  const original=JSON.stringify(rig.db.prepare('SELECT * FROM hub_grants WHERE exposure_id=? ORDER BY id').all(id));
  const shots:any[]=[];const assets:Promise<void>[]=[];
  const context=async(login:string)=>{
   const ctx=await browser.newContext({viewport:c.device==='desk'?{width:1366,height:1000}:{width:390,height:844},isMobile:c.device==='phone',hasTouch:c.device==='phone',colorScheme:c.theme,ignoreHTTPSErrors:true});
   await ctx.addInitScript('window.__name=fn=>fn;');await ctx.addInitScript(({lang,theme}:any)=>{localStorage.setItem('agend_lang',lang);localStorage.setItem('agend_theme',theme);localStorage.setItem('agend_tour_done','1');localStorage.setItem('agend_firstrun_dismissed','1');},{lang:c.lang,theme:c.theme});
   const retained=mode==='before'?['panel-hub.js']:c.skew==='old-client'?['hub-client.js']:c.skew==='old-words'?['hub-owner-strings.js','hub-strings.js','hub-chat-strings.js']:[];
   for(const file of retained){const body=execFileSync('git',['show',base+':src/ui/'+file],{encoding:'utf8'});result.substitutions.push({ref:base,path:'src/ui/'+file,digest:digest(body)});await ctx.route('**/ui/js/'+file,(r:any)=>r.fulfill({status:200,contentType:'text/javascript',body}));}
   if(c.skew==='old-css'){for(const file of ['app.css','hub-owner.css']){const body=execFileSync('git',['show',base+':src/ui/shared/'+file],{encoding:'utf8'});result.substitutions.push({ref:base,path:'src/ui/shared/'+file,digest:digest(body)});await ctx.route('**/assets/'+file,(r:any)=>r.fulfill({status:200,contentType:'text/css',body}));}}
   if(c.skew==='old-server')await ctx.route('**/hub/v1/session',async(r:any)=>{const response=await r.fetch(),data=await response.json();data.features=data.features?.filter((s:string)=>s!=='sharing-pause-v1');await r.fulfill({response,json:data});});
   const p=await ctx.newPage();p.on('pageerror',(e:any)=>result.errors.push(String(e)));
   p.on('response',(response:any)=>{const path=new URL(response.url()).pathname;if(/\.(js|css)$/.test(path))assets.push((async()=>{try{const hash=digest(await response.body()),paths=result.servedDigests[hash]??=[];if(!paths.includes(path))paths.push(path);}catch{}})());if(path.startsWith('/hub/v1/'))result.requests.push({path,method:response.request().method(),status:response.status()});});
   await p.goto(origin+'/ui/hub'+(login==='owner'?'/exposures?agent='+id:'?room='+opened.json.room.id));await p.fill('#hubLogin',login);await p.fill('#hubPassword','pw-'+login);await p.locator('.hub-signin button[type=submit]').click();
   await p.locator(login==='owner'?'.hub-owner .hub-danger':'.hub-chat-main').waitFor();return {ctx,p};
  };
  const capture=async(p:any,stage:string)=>{
   if(mode!=='before'&&await p.locator('.hub-owner').count())await p.waitForFunction(()=>!!(document.querySelector('link[data-hub-sharing-css="1"]')as HTMLLinkElement)?.sheet);
   const geometry=await p.evaluate(()=>({overflow:document.documentElement.scrollWidth-innerWidth,controls:[...document.querySelectorAll('.hub-sharing-control button,.hub-danger button')].map(e=>({label:e.textContent,...e.getBoundingClientRect().toJSON()}))}));
   check(tag+' '+stage+' no overflow',geometry.overflow<=1);
   if(c.device==='phone'&&mode!=='before')check(tag+' '+stage+' touch targets44px',geometry.controls.every((e:any)=>e.width>=44&&e.height>=44));
   await p.screenshot({path:join(out,tag+'-'+stage+'.png'),fullPage:true});shots.push({stage,geometry});
  };
  let {ctx,p}=await context('owner');
  try{
   const legacy=mode==='before'||c.skew==='old-client'||c.skew==='old-server';check(tag+' feature admission',!!await p.locator('.hub-sharing-control').count()===!legacy);await capture(p,'shared');
   if(!legacy){await p.locator('.hub-sharing-control button').click();await p.getByRole('button',{name:c.lang==='en'?'Resume sharing':'繼續分享',exact:true}).waitFor();await capture(p,'paused');
    check(tag+' paused grant bytes unchanged',JSON.stringify(rig.db.prepare('SELECT * FROM hub_grants WHERE exposure_id=? ORDER BY id').all(id))===original);
    check(tag+' hidden from new questions',(await rig.call(a,'GET','/hub/v1/exposures')).json.askable.length===0);
    await ctx.close();({ctx,p}=await context('alex'));await p.getByText(c.lang==='en'?'The owner paused sharing':'擁有者已暫停分享',{exact:false}).waitFor();
    check(tag+' paused composer disabled',await p.locator('#sendBtn').isDisabled());await capture(p,'asker-paused');
    await ctx.close();({ctx,p}=await context('owner'));await p.locator('.hub-sharing-control button').click();await p.getByRole('button',{name:c.lang==='en'?'Pause sharing':'暫停分享',exact:true}).waitFor();await capture(p,'resumed');
    check(tag+' resumed grant bytes unchanged',JSON.stringify(rig.db.prepare('SELECT * FROM hub_grants WHERE exposure_id=? ORDER BY id').all(id))===original);
    check(tag+' same recipient restored',(await rig.call(a,'GET','/hub/v1/exposures')).json.askable.length===1);
    await p.locator('.hub-danger button').click();await p.locator('[data-confirm=yes]').click();await p.locator('.hub-sharing-control').waitFor({state:'detached'});await capture(p,'stopped');
    check(tag+' permanent stop cannot Resume',(await rig.call(o,'POST','/hub/v1/exposures/'+id+'/sharing',{revision:1,sharingEpoch:3,paused:false})).status!==200);
   }
   await Promise.all(assets);result.cases.push({...c,tag,legacy,shots});
  }finally{await ctx.close();}
 }
 check('no browser errors',result.errors.length===0);check('all cases ran',result.cases.length===cases.length);result.status='PASS';
}catch(e:any){result.status='FAIL';result.error=e.stack;throw e;}
finally{await browser?.close();server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));await rig?.close();rmSync(home,{recursive:true,force:true});result.cleaned=true;writeFileSync(join(out,'receipt.json'),JSON.stringify(result,null,2));}
console.log(JSON.stringify({status:result.status,cases:result.cases.length,checks:result.checks.length,out}));
