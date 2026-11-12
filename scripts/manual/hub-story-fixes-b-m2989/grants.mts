/** Owned HTTPS/SQLite/Hub shell; in-memory directory and inert authenticated member publication. No live accounts. */
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir,loadavg} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:https';
import {execFileSync} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import {createRequire} from 'node:module';
const repo=process.env.REPO??process.cwd(),out=process.env.OUT!,mode=process.env.MODE??'current',base=process.env.BASE_REF??'a6557a6b3e328b1586de0f853390aabb8f0ad99f';
mkdirSync(out,{recursive:true});const home=mkdtempSync(join(tmpdir(),'hub-grants-m2989-'));process.env.AGEND_HOME=home;
const digest=(s:any)=>createHash('sha256').update(s).digest('hex');
const git=(...args:string[])=>execFileSync('git',['-C',repo,...args],{encoding:'utf8'}).trim();
const result:any={head:git('rev-parse','HEAD'),tree:git('rev-parse','HEAD^{tree}'),trackedDirty:git('status','--porcelain','--untracked-files=no'),mode,base,
 inputDigests:{},servedDigests:{},substitutions:[],cases:[],checks:[],errors:[],scope:'Production HTTPS/Hub cookie, CSRF, SQLite grant catalog and UI; inert directory/member transport; no real AD/account/CLI/Fleet.'};
for(const p of ['src/hub/catalog.ts','src/ui/panel-hub.js','src/hub/sessions.ts','scripts/manual/hub-story-fixes-b-m2989/grants.mts']){const hash=digest(readFileSync(join(repo,p)));(result.inputDigests[hash]??=[]).push(p);}
const check=(name:string,ok:unknown)=>{result.checks.push({name,ok:!!ok});if(!ok)throw Error(name);};
let rig:any,browser:any;
const server=createServer((q,p)=>{if(!rig?.http.handle(q,p)){p.writeHead(404);p.end();}});
try{
 await new Promise<void>((done,fail)=>{server.once('error',fail);server.listen(0,'127.0.0.1',()=>{server.removeListener('error',fail);done();});});
 const origin='https://127.0.0.1:'+(server.address() as any).port;
 const {createBrowserCertificate}=await import(repo+'/src/hub/init/browser-certificate.ts');const material=await createBrowserCertificate(home,origin);
 server.setSecureContext({cert:readFileSync(material.certFile),key:readFileSync(material.keyFile)});
 const {s3bRig}=await import(repo+'/tests/helpers/hub-s3b-rig.ts');rig=await s3bRig({webOrigin:origin});
 const owner=rig.addPerson('owner','研究者 Avery'),recipient=rig.addPerson('recipient','新同仁 Alex');
 rig.directory.lookupForGrant=async(login:string)=>{const p=rig.people.get(login);return p?{ok:true,person:{key:p.key,login,displayName:p.name,dn:'fixture only',groups:[]}}:{ok:false,reason:'not-found'};};
 const eligibility=rig.directory.checkEligibility.bind(rig.directory);
 rig.directory.checkEligibility=async(key:any)=>{const answer=await eligibility(key);const person=[...rig.people.values()].find((p:any)=>p.key.realm===key.realm&&p.key.objectId===key.objectId) as any;
   return answer.eligible?{...answer,person:{...answer.person,displayName:person?.name}}:answer;};
 const admin=await rig.signIn('owner'),link=rig.link(randomUUID(),owner),id=randomUUID();
 await rig.http.receive(rig.frame('exposure.snapshot',{revision:1,exposures:[{id,fleetId:link.fleetId,owner,displayName:'研究助手 · Research',revision:1,state:'published',dataViewId:'agent',allowedTools:[],policyDigest:'b'.repeat(64)}]},link),link);
 check('grant succeeds before recipient sign-in',(await rig.call(admin,'POST','/hub/v1/grants',{exposureId:id,exposureRevision:1,login:'recipient',days:7})).status===200);
 const pw=createRequire(process.env.PW_DIR+'/')('playwright-core');browser=await pw.chromium.launch({executablePath:process.env.CHROME,args:['--no-sandbox']});result.browser=browser.version();
 const cases:any[]=[];for(const device of ['desk','phone'])for(const theme of ['light','dark'])for(const lang of ['en','zh-TW'])cases.push({device,theme,lang});
 if(mode==='current')cases.push({device:'desk',theme:'light',lang:'en',skew:'old-words'},{device:'phone',theme:'dark',lang:'zh-TW',skew:'old-server'});
 for(const c of cases){
  if(loadavg()[0]!>10)throw Error('Paused: host load above 10');
  const tag=[c.skew??mode,c.device,c.theme,c.lang].join('-'),ctx=await browser.newContext({viewport:c.device==='desk'?{width:1366,height:900}:{width:390,height:844},isMobile:c.device==='phone',hasTouch:c.device==='phone',colorScheme:c.theme,ignoreHTTPSErrors:true});
  try{
   await ctx.addInitScript("window.__name=fn=>fn;");
   await ctx.addInitScript(({lang,theme}:any)=>{localStorage.setItem('agend_lang',lang);localStorage.setItem('agend_theme',theme);localStorage.setItem('agend_tour_done','1');localStorage.setItem('agend_firstrun_dismissed','1');},{lang:c.lang,theme:c.theme});
   const substitutions=mode==='before'?['panel-hub.js']:c.skew==='old-words'?['hub-owner-strings.js','hub-strings.js']:[];
   for(const file of substitutions){const body=execFileSync('git',['-C',repo,'show',base+':src/ui/'+file],{encoding:'utf8'});result.substitutions.push({ref:base,path:'src/ui/'+file,digest:digest(body)});await ctx.route('**/ui/js/'+file,(route:any)=>route.fulfill({status:200,contentType:'text/javascript',body}));}
   if(c.skew==='old-server')await ctx.route('**/hub/v1/exposures',async(route:any)=>{const response=await route.fetch(),body=await response.json();for(const x of body.mine)for(const g of x.grants)delete g.subjectSignedIn;await route.fulfill({response,json:body});});
   const p=await ctx.newPage(),resources:Promise<void>[]=[];
   p.on('pageerror',(e:any)=>result.errors.push(String(e)));
   p.on('response',(response:any)=>{const u=new URL(response.url());if(/\.(js|css)$/.test(u.pathname))resources.push((async()=>{try{const hash=digest(await response.body()),paths=result.servedDigests[hash]??=[];if(!paths.includes(u.pathname))paths.push(u.pathname);}catch{}})());});
   await p.goto(origin+'/ui/hub/exposures?agent='+id);await p.fill('#hubLogin','owner');await p.fill('#hubPassword','pw-owner');await p.locator('.hub-signin button[type=submit]').click();
   await p.locator('.hub-owner .hub-row strong').filter({hasText:'新同仁 Alex'}).waitFor();
   const label=c.lang==='en'?"Hasn't signed in to Hub yet":'還沒登入過 Hub';
   check(tag+' explicit never-signed-in label',(await p.locator('.hub-owner').innerText()).includes(label)===(mode==='current'&&c.skew!=='old-server'));
   const geometry=await p.evaluate(()=>({overflow:document.documentElement.scrollWidth-innerWidth,small:[...document.querySelectorAll('.hub-owner button,.hub-owner a.btn')].filter(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&innerWidth<900&&(r.width<44||r.height<44);}).map(e=>e.outerHTML)}));
   check(tag+' no overflow',geometry.overflow<=1);check(tag+' phone taps',!geometry.small.length);
   await p.screenshot({path:join(out,tag+'-grant.png'),fullPage:true});await Promise.all(resources);result.cases.push({tag,geometry});
  }finally{await ctx.close();}
 }
 const signed=await rig.signIn('recipient');check('recipient sign-in succeeds',signed.status===200);
 check('recipient sign-out succeeds',(await rig.call(signed,'DELETE','/hub/v1/session')).status===200);
 const view=(await rig.call(admin,'GET','/hub/v1/exposures')).json;
 check('durable witness after sign-out',view.mine[0].grants[0].subjectSignedIn===true);
 check('no browser errors',result.errors.length===0);check('all matrix cases ran',result.cases.length===cases.length);result.status='PASS';
}catch(e:any){result.status='FAIL';result.error=e.stack;throw e;}
finally{await browser?.close();server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));await rig?.close();rmSync(home,{recursive:true,force:true});result.cleaned=true;writeFileSync(join(out,'receipt.json'),JSON.stringify(result,null,2));}
console.log(JSON.stringify({status:result.status,cases:result.cases.length,checks:result.checks.length,out}));
