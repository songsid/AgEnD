/** Owned HTTPS + real Hub sessions/CSRF/SQLite + production UI, inert AD and member publication. */
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir,loadavg} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:https';
import {execFileSync} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import {createRequire} from 'node:module';
const repo=process.env.REPO??process.cwd(), out=process.env.OUT!, mode=process.env.MODE??'current', base=process.env.BASE_REF??'34bd23bdef54628059744044b79e43ee0d50749c';
mkdirSync(out,{recursive:true});const home=mkdtempSync(join(tmpdir(),'hub-group-ask-m3016-'));process.env.AGEND_HOME=home;
const digest=(s:any)=>createHash('sha256').update(s).digest('hex'),git=(...args:string[])=>execFileSync('git',['-C',repo,...args],{encoding:'utf8'}).trim();
const result:any={head:git('rev-parse','HEAD'),tree:git('rev-parse','HEAD^{tree}'),trackedDirty:git('status','--porcelain','--untracked-files=no'),mode,base,inputDigests:{},servedDigests:{},substitutions:[],cases:[],checks:[],errors:[],requests:[],scope:'Production HTTPS/cookie/CSRF/SQLite/owner UI. Inert directory GUID facts and authenticated member boundary. Real fixture grant writes/revokes, no real AD/account/Fleet/model execution. Before is retained base panel on candidate server, not a baseline server execution.'};
const inputs=[...new Set([...git('diff','--name-only',base,'HEAD','--','src/hub','src/ui','src/general-knowledge/skills/hub').split('\n').filter(Boolean),'tests/helpers/hub-s3b-rig.ts','scripts/manual/hub-group-ask-m3016/browser.mts'])];
result.font=execFileSync('fc-match',['sans:lang=zh-tw'],{encoding:'utf8'}).trim();
for(const p of inputs){const hash=digest(readFileSync(join(repo,p)));(result.inputDigests[hash]??=[]).push(p);}
const check=(name:string,ok:unknown)=>{result.checks.push({name,ok:!!ok});if(!ok)throw Error(name);};
let rig:any,browser:any;
const server=createServer((q,p)=>{if(!rig?.http.handle(q,p)){p.writeHead(404);p.end();}});
try{
 await new Promise<void>((done,fail)=>{server.once('error',fail);server.listen(0,'127.0.0.1',()=>{server.removeListener('error',fail);done();});});
 const origin='https://127.0.0.1:'+(server.address() as any).port;
 const {createBrowserCertificate}=await import(repo+'/src/hub/init/browser-certificate.ts');const material=await createBrowserCertificate(home,origin);
 server.setSecureContext({cert:readFileSync(material.certFile),key:readFileSync(material.keyFile)});
 const {s3bRig}=await import(repo+'/tests/helpers/hub-s3b-rig.ts');rig=await s3bRig({webOrigin:origin});
 const owner=rig.addPerson('owner','Avery · 研究者'),recipient=rig.addPerson('alex','Alex Chen · 陳同仁'),group={realm:'corp',objectId:randomUUID()},dn='CN=Engineering,DC=example,DC=test';let member=true,unknown=false;
 Object.assign(rig.directory,{groupPolicy:'ad-direct-guid',
  resolvePolicyGroup:async(input:string)=>input===dn?{ok:true,group:{key:group,dn}}:{ok:false,reason:'not-found'},
  searchPolicyGroups:async()=>unknown?{ok:false,reason:'unknown'}:{ok:true,groups:[{objectId:group.objectId,cn:'Engineering · 工程部',dn}],truncated:false},
  searchGrantPeople:async()=>unknown?{ok:false,reason:'unknown'}:{ok:true,people:[{person:recipient,login:'alex',displayName:'Alex Chen · 陳同仁'}],truncated:false},
  lookupForGrant:async(login:string)=>login==='alex'?{ok:true,person:{key:recipient,login,dn:'private',groups:[]}}:{ok:false,reason:'not-found'},
  readPolicyGroups:async(person:any)=>({kind:'complete',person,groups:member&&person.objectId===recipient.objectId?[group.objectId]:[],observedAt:Date.now()})});
 const eligibility=rig.directory.checkEligibility.bind(rig.directory);rig.directory.checkEligibility=async(key:any)=>{const answer=await eligibility(key);const p=[...rig.people.values()].find((p:any)=>p.key.objectId===key.objectId) as any;return answer.eligible?{...answer,person:{...answer.person,displayName:p?.name}}:answer;};
 const {groupPolicyMigration,createHubGroupPolicyStore}=await import(repo+'/src/hub/group-policy/store.ts');groupPolicyMigration(rig.hubId,'corp','directory-v1').up(rig.db);
 const policy=createHubGroupPolicyStore({db:rig.db,hubId:rig.hubId,realm:'corp',generation:'directory-v1',directory:rig.directory,audit:{appendInTransaction(){}} as any,current:()=>true});
 rig.httpDeps.grantDirectory={policy:()=>policy,binding:()=>({kind:'ready'})};await rig.restartHttp();
 const link=rig.link(randomUUID(),owner),pw=createRequire(process.env.PW_DIR+'/')('playwright-core');browser=await pw.chromium.launch({executablePath:process.env.CHROME,args:['--no-sandbox']});result.browser=browser.version();
 const cases:any[]=[];for(const device of ['desk','phone'])for(const theme of ['light','dark'])for(const lang of ['en','zh-TW'])cases.push({device,theme,lang});
 if(mode==='current')for(const skew of ['old-client','old-group-search','old-words','old-server'])cases.push({device:skew==='old-client'?'phone':'desk',theme:skew==='old-client'?'dark':'light',lang:skew==='old-client'?'zh-TW':'en',skew});
 if(process.env.CASE_FILTER)for(let i=cases.length-1;i>=0;i--)if(![cases[i].skew??mode,cases[i].device,cases[i].theme,cases[i].lang].join('-').includes(process.env.CASE_FILTER))cases.splice(i,1);
 check('at least one selected case',cases.length>0);
 for(const [index,c] of cases.entries()){
  for(let pause=0;loadavg()[0]!>10;pause++){if(pause>=40)throw Error('Paused for10minutes: host load stayed above10');(result.pauses??=[]).push({case:index,load:loadavg()[0],at:new Date().toISOString()});console.log('PAUSED before case',index,'load',loadavg()[0]);await new Promise(done=>setTimeout(done,15000));}
  const id=randomUUID();await rig.http.receive(rig.frame('exposure.snapshot',{revision:index+1,exposures:[{id,fleetId:link.fleetId,owner,displayName:'研究助手 · Research',revision:1,state:'published',dataViewId:'agent',allowedTools:[],policyDigest:'b'.repeat(64)}]},link),link);
  const tag=[c.skew??mode,c.device,c.theme,c.lang].join('-'),ctx=await browser.newContext({viewport:c.device==='desk'?{width:1366,height:1000}:{width:390,height:844},isMobile:c.device==='phone',hasTouch:c.device==='phone',colorScheme:c.theme,ignoreHTTPSErrors:true});
  try{
   await ctx.addInitScript('window.__name=fn=>fn;');await ctx.addInitScript(({lang,theme}:any)=>{localStorage.setItem('agend_lang',lang);localStorage.setItem('agend_theme',theme);localStorage.setItem('agend_tour_done','1');localStorage.setItem('agend_firstrun_dismissed','1');},{lang:c.lang,theme:c.theme});
   const retained=mode==='before'?['panel-hub.js']:c.skew==='old-client'?['hub-client.js']:c.skew==='old-group-search'?['hub-group-search.js']:c.skew==='old-words'?['hub-owner-strings.js','hub-strings.js','hub-grant-strings.js']:[];
   for(const file of retained){const body=execFileSync('git',['-C',repo,'show',base+':src/ui/'+file],{encoding:'utf8'});result.substitutions.push({ref:base,path:'src/ui/'+file,digest:digest(body)});await ctx.route('**/ui/js/'+file,(r:any)=>r.fulfill({status:200,contentType:'text/javascript',body}));}
   if(process.env.CSS_REF){const ref=process.env.CSS_REF,body=execFileSync('git',['-C',repo,'show',ref+':src/ui/shared/app.css'],{encoding:'utf8'});result.substitutions.push({ref,path:'src/ui/shared/app.css',digest:digest(body)});await ctx.route('**/assets/app.css',(r:any)=>r.fulfill({status:200,contentType:'text/css',body}));}
   if(c.skew==='old-server')await ctx.route('**/hub/v1/session',async(route:any)=>{const response=await route.fetch(),body=await response.json();if(Array.isArray(body.features))body.features=body.features.filter((s:string)=>s!=='grant-subjects-v1');await route.fulfill({response,json:body});});
   const p=await ctx.newPage(),assets:Promise<void>[]=[];p.on('pageerror',(e:any)=>result.errors.push(String(e)));
   p.on('response',(response:any)=>{const path=new URL(response.url()).pathname;if(/\.(js|css)$/.test(path))assets.push((async()=>{try{const hash=digest(await response.body()),paths=result.servedDigests[hash]??=[];if(!paths.includes(path))paths.push(path);}catch{}})());if(path.startsWith('/hub/v1/'))result.requests.push({path,method:response.request().method(),status:response.status()});});
   await p.goto(origin+'/ui/hub/exposures?agent='+id+'&grant=1');await p.fill('#hubLogin','owner');await p.fill('#hubPassword','pw-owner');await p.locator('.hub-signin button[type=submit]').click();await p.locator('.hub-grant').waitFor();
   const legacy=mode==='before'||c.skew==='old-client'||c.skew==='old-server';check(tag+' matched picker admission',(await p.locator('[data-grant-picker]').count()>0)!==legacy);
   const geometry=async(stage:string)=>{const g=await p.evaluate(()=>({overflow:document.documentElement.scrollWidth-innerWidth,dialog:document.querySelector('.dlg')?.getBoundingClientRect().toJSON(),small:[...document.querySelectorAll('.hub-grant button,.dlg-actions button')].map(e=>({label:e.textContent,...e.getBoundingClientRect().toJSON()})),fields:[...document.querySelectorAll('[data-grant-picker] input,[data-grant-picker] select')].map(e=>({tag:e.tagName,id:e.id,...e.getBoundingClientRect().toJSON()}))}));check(tag+' '+stage+' no overflow',g.overflow<=1);return g;};
   const capture=async(stage:string)=>{const g=await geometry(stage);await p.screenshot({path:join(out,tag+'-'+stage+'.png'),fullPage:true});if(c.device==='phone'&&!legacy){check(tag+' '+stage+' phone controls44px',[...g.small,...g.fields].every(e=>e.width>=44&&e.height>=44));}return {stage,geometry:g};};const shots:any[]=[];
   shots.push(await capture('empty'));
   if(legacy){await p.locator('.hub-grant input').fill('alex');await p.locator('.dlg-actions .btn-primary').click();await p.locator('.hub-grant').waitFor({state:'detached'});shots.push(await capture('allowed'));}
   else{
    await p.fill('#hubGrantPerson','Al');await p.locator('.hub-group-hits button').first().waitFor();shots.push(await capture('people'));
    await p.locator('.hub-group-hits button').first().click();await p.selectOption('[data-grant-days]','90');shots.push(await capture('person-selected'));await p.locator('.dlg-actions .btn-primary').click();await p.locator('.hub-grant').waitFor({state:'detached'});
    check(tag+' personal grant persisted',rig.db.prepare("SELECT COUNT(*) n FROM hub_grants WHERE exposure_id=? AND subject_kind='person' AND expires_at-starts_at=?").get(id,90*86400000).n===1);
    await p.locator('.hub-card-head button').first().click();await p.locator('[data-grant-kind]').waitFor();await p.selectOption('[data-grant-kind]','group');await p.fill('#hubGrantGroup','En');await p.locator('.hub-group-hits button').first().waitFor();shots.push(await capture('groups'));
    await p.locator('.hub-group-hits button').first().click();await p.selectOption('[data-grant-days]','90');shots.push(await capture('group-selected'));await p.locator('.dlg-actions .btn-primary').click();await p.locator('.hub-grant').waitFor({state:'detached'});await p.locator('.hub-owner .hub-row .tag').filter({hasText:c.lang==='en'?'AD group':'AD 群組'}).waitFor();shots.push(await capture('allowed'));
    check(tag+' one GUID group row',rig.db.prepare("SELECT COUNT(*) n FROM hub_grants WHERE exposure_id=? AND subject_kind='group' AND subject=?").get(id,group.realm+'/'+group.objectId).n===1);
   }
   check(tag+' no real recipient sign-in',!rig.db.prepare('SELECT 1 FROM hub_people WHERE person=?').get(recipient.realm+'/'+recipient.objectId));
   await Promise.all(assets);result.cases.push({tag,...c,legacy,shots});
  }finally{await ctx.close();}
 }
 if(mode==='current'){
 const ownerSession=await rig.signIn('owner'),asker=await rig.signIn('alex'),owned=(await rig.call(ownerSession,'GET','/hub/v1/exposures')).json.mine[0];
 const created=await rig.call(ownerSession,'POST','/hub/v1/grants',{exposureId:owned.id,exposureRevision:owned.revision,days:7,subject:{kind:'group',group,dn}});check('group fixture grant for live checks',created.status===200);const groupGrant=created.json.grant;
 const open=await rig.call(asker,'POST','/hub/v1/rooms',{exposureId:owned.id,grantId:groupGrant.id});check('member opens own room',open.status===200);member=false;
 check('leaving group stops history',(await rig.call(asker,'GET','/hub/v1/rooms/'+open.json.room.id+'/messages')).status===403);member=true;
 check('rejoining group restores authorized history',(await rig.call(asker,'GET','/hub/v1/rooms/'+open.json.room.id+'/messages')).status===200);
 check('owner revokes group',(await rig.call(ownerSession,'DELETE','/hub/v1/grants/'+groupGrant.id+'?revision='+groupGrant.revision)).status===200);
 check('revoked group cannot open',(await rig.call(asker,'POST','/hub/v1/rooms',{exposureId:owned.id,grantId:groupGrant.id})).status!==200);
 }
 check('all intended cases ran',result.cases.length===cases.length);check('no browser errors',result.errors.length===0);result.status='PASS';
}catch(e:any){result.status='FAIL';result.error=e.stack;throw e;}
finally{await browser?.close();server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));await rig?.close();rmSync(home,{recursive:true,force:true});result.cleaned=true;writeFileSync(join(out,'receipt.json'),JSON.stringify(result,null,2));}
console.log(JSON.stringify({status:result.status,cases:result.cases.length,checks:result.checks.length,out}));
