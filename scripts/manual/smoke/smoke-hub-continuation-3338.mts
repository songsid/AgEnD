/** #3337/#3338 real Hub init + fake LDAPS + member TLS/WSS + browser publish/grant continuation.
 * Owned scratch HOME/private guard binaries only. Native/model delivery is a recording boundary stub.
 * Start own named scripts/manual/hub-directory/run.sh rig; pass AGEND_HUB_RIG_ENV. No real accounts/fleet.
 * REPO=$PWD PW_DIR=<playwright dir> CHROME=<chromium> FONTCONFIG_FILE=<CJK config> TMPDIR=<short owned dir>
 *   node --import tsx scripts/manual/smoke/smoke-hub-continuation-3338.mts
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { createServer } from 'node:net';
import yaml from 'js-yaml';
import { Client } from 'ldapts';
const repo = resolve(process.env.REPO ?? process.cwd()), artifacts = resolve(process.env.ARTIFACT_DIR ?? join(repo, '.artifacts/hub-continuation')), shots = resolve(process.env.SHOT_DIR ?? join(repo, 'docs/screenshots/hub-continuation-3338'));
mkdirSync(artifacts, {recursive:true}); mkdirSync(shots, {recursive:true});
const owned = mkdtempSync(join(artifacts, 'run-')), home = join(owned, 'home'), hubHome = join(owned, 'hub'), bin = join(owned, 'bin');
for(const p of [home,hubHome,bin,join(home,'.claude'),join(home,'.codex'),join(owned,'tmux')])mkdirSync(p,{recursive:true,mode:0o700});
Object.assign(process.env,{REPO:repo,HOME:home,CLAUDE_CONFIG_DIR:join(home,'.claude'),CODEX_HOME:join(home,'.codex'),AGEND_HOME:home,TMUX_TMPDIR:join(owned,'tmux')});
const guardLog=join(owned,'native-refused.jsonl');
for(const name of ['tmux','codex','claude','kiro-cli','agend-private-tmux']){const p=join(bin,name);writeFileSync(p,`#!${process.execPath}\nrequire('fs').appendFileSync(${JSON.stringify(guardLog)},JSON.stringify(process.argv)+'\\n');process.exit(97);\n`);chmodSync(p,0o755)}
process.env.AGEND_TMUX_BIN=join(bin,'agend-private-tmux');process.env.PATH=[bin,dirname(process.execPath),'/usr/bin','/bin'].join(':');
const env:Record<string,string>={};for(const line of readFileSync(process.env.AGEND_HUB_RIG_ENV!,'utf8').trim().split('\n')){const i=line.indexOf('=');env[line.slice(0,i)]=line.slice(i+1)}
const hp=Number(process.env.HP??49160), memberOrigin=`https://127.0.0.1:${hp+2}`, webOrigin=`https://127.0.0.1:${hp+3}`;
for(const port of [hp,hp+1,hp+2,hp+3])await new Promise<void>((resolve,reject)=>{const p=createServer();p.once('error',reject);p.listen(port,'127.0.0.1',()=>p.close(()=>resolve()))});
const {guidStringToBytes}=await import(repo+'/src/hub/directory/profiles.ts');
const ldap=new Client({url:env.AGEND_HUB_RIG_LDAPS_URL,tlsOptions:{ca:readFileSync(env.AGEND_HUB_RIG_CA,'utf8')},timeout:3000});
await ldap.bind(env.AGEND_HUB_RIG_ADMIN_DN,env.AGEND_HUB_RIG_ADMIN_PASSWORD);
for(const login of ['admin','olivia','alex'])await ldap.add(`cn=Continuation ${login},ou=people,dc=example,dc=test`,{objectClass:['inetOrgPerson','fakeAdUser'],cn:`Continuation ${login}`,sn:login,sAMAccountName:login,userPrincipalName:`${login}@example.test`,userAccountControl:'512',objectGUID:guidStringToBytes(randomUUID())!,userPassword:`pw-${login}`}).catch((e:any)=>{if(e.code!==68)throw e});
await ldap.unbind();
const directoryConfig={realm:'corp',url:env.AGEND_HUB_RIG_LDAPS_URL,caPem:readFileSync(env.AGEND_HUB_RIG_CA,'utf8'),baseDn:'dc=example,dc=test',bindDn:env.AGEND_HUB_RIG_BIND_DN,profile:'ad' as const,timeoutMs:3000};
const {createHubDirectory}=await import(repo+'/src/hub/directory/index.ts');
const lookup=createHubDirectory(directoryConfig,{bindPassword:env.AGEND_HUB_RIG_BIND_PASSWORD});
const administrator=await lookup.lookupForInitialization!('admin');if(!administrator.ok)throw Error('fixture administrator lookup failed');await lookup.close();
const {createBrowserCertificate}=await import(repo+'/src/hub/init/browser-certificate.ts');
const {createHubInitializer}=await import(repo+'/src/hub/init/initializer.ts');const {hubIdentityProvider}=await import(repo+'/src/hub/init/identity.ts');const {HubRuntime}=await import(repo+'/src/hub/runtime.ts');
const cert=await createBrowserCertificate(hubHome,webOrigin);
const plan={name:'Continuation Hub',webOrigin,memberOrigin,memberListen:{host:'127.0.0.1',port:hp+2},webListen:{host:'127.0.0.1',port:hp+3},webTls:cert,directory:directoryConfig,bindPasswordRef:'file:hub/secrets/directory-bind',administrator:administrator.person.key,retention:{contentDays:30,eventDays:180},coexistence:'dedicated' as const};
const init=createHubInitializer({home:hubHome,identity:hubIdentityProvider(),probe:{pidAlive:()=>false}});const confirmation=await init.prepareConfirmation(plan,{bindPassword:env.AGEND_HUB_RIG_BIND_PASSWORD});await init.commit(plan,confirmation.reference);
const log:any[]=[],deliveries:any[]=[],result:any={startedAt:new Date().toISOString(),source:execFileSync('git',['-C',repo,'rev-parse','HEAD'],{encoding:'utf8'}).trim(),ports:[hp,hp+1,hp+2,hp+3],memberOrigin,webOrigin,checks:[],cases:[],limits:'No model/native execution. Recording delivery boundary rechecks stillCurrent and beforeInput.'};
const runtime=new HubRuntime({home:hubHome,log:(level,message,meta)=>log.push({level,message,meta})});
let fx:any;
const check=(name:string,ok:unknown,detail?:unknown)=>{result.checks.push({name,ok:!!ok,...(!ok?{detail}:{})});if(!ok)throw Error(name+': '+JSON.stringify(detail))};
const git=(...args:string[])=>execFileSync('git',['-C',repo,...args],{encoding:'utf8',maxBuffer:16<<20});
const baseRef=process.env.BASE_REF??'f0374ff64',oldCssRef=process.env.OLD_CSS_REF??'b47cad34a';
const oldFiles=new Map(['settings-hub.js','panel-hub.js','hub-strings.js','hub-owner-strings.js'].map(f=>['/ui/js/'+f,git('show',`${baseRef}:src/ui/${f}`)]));
const oldOwnerCss=git('show',`${baseRef}:src/ui/shared/hub-owner.css`);
const oldCss=new Map(['app.css','hub.css','hub-owner.css'].map(f=>['/assets/'+f,git('show',`${oldCssRef}:src/ui/shared/${f}`)]));
for(const [url,path] of [['/assets/app-shell.js','shared/app-shell.js'],['/ui/js/hub-client.js','hub-client.js']])oldCss.set(url,git('show',`${oldCssRef}:src/ui/${path}`));
const shot=async(page:any,name:string)=>{await page.screenshot({path:join(shots,name+'.png')});};
const errors:any[]=[];const requests:any[]=[];
async function setup(ctx:any,c:any,mode='current'){
 await ctx.addInitScript({content:`window.__name=(fn)=>fn;try{localStorage.setItem('agend_lang',${JSON.stringify(c.lang)});localStorage.setItem('agend_theme',${JSON.stringify(c.theme)});localStorage.setItem('agend_tour_done','1');localStorage.setItem('agend_firstrun_dismissed','1')}catch{};window.__csp=[];document.addEventListener('securitypolicyviolation',e=>window.__csp.push(e.violatedDirective));`});
 await ctx.route('**/*',(route:any)=>{const u=new URL(route.request().url());if(![fx.base,webOrigin].includes(u.origin))return route.abort();if(mode==='before'&&u.pathname==='/assets/hub-owner.css')return route.fulfill({status:200,contentType:'text/css',body:oldOwnerCss});if(mode==='before'&&oldFiles.has(u.pathname))return route.fulfill({status:200,contentType:'text/javascript',body:oldFiles.get(u.pathname)});if(mode==='skew'&&oldCss.has(u.pathname)){result.skewHits=(result.skewHits??0)+1;return route.fulfill({status:200,contentType:u.pathname.endsWith('.css')?'text/css':'text/javascript',body:oldCss.get(u.pathname)})}return route.continue()});
 ctx.on('page',(p:any)=>{p.on('pageerror',(e:any)=>errors.push(String(e)));p.on('response',(r:any)=>{const u=new URL(r.url());if(u.pathname.startsWith('/hub/v1')||u.pathname.startsWith('/api/hub/'))requests.push({method:r.request().method(),path:u.pathname,status:r.status()})})});
}
async function hubPage(c:any,path:string,mode='current',cookies?:any[]){const ctx=await fx.browser.newContext({viewport:c.device==='phone'?{width:390,height:844}:{width:1366,height:900},colorScheme:c.theme,locale:c.lang==='zh-TW'?'zh-TW':'en-US',isMobile:c.device==='phone',hasTouch:c.device==='phone',ignoreHTTPSErrors:true});await setup(ctx,c,mode);if(cookies)await ctx.addCookies(cookies);const page=await ctx.newPage();await page.goto(webOrigin+path);return{ctx,page}}
async function signIn(p:any,login:string){await p.locator('#hubLogin').fill(login);await p.locator('#hubPassword').fill('pw-'+login);await p.locator('.hub-signin button[type=submit]').click();await p.locator('.hub-signin').waitFor({state:'detached'})}
async function approveDialog(p:any){await p.locator('[data-confirm=yes]').click()}
async function applyPending(p:any){
 for(let n=0;n<60;n++){const b=p.locator('.pending-card.pending .pending-self button');if(await b.count()){await b.first().click();return}
 const pending=p.locator('.pending-card.pending');if(await pending.count()){
  if(process.env.FIXTURE_HOST_APPROVAL==='1'){const id=await pending.first().getAttribute('data-pending');const decision=await fx.fm.settingsConfirmation.store.decide(id,'confirm',{label:'Isolated test host',current:()=>true});result.fixtureHostApprovals??=[];result.fixtureHostApprovals.push({id,state:decision.state});return}
 }await p.waitForTimeout(100)}
}
async function geometry(p:any,selector:string){return p.locator(selector).evaluateAll((els:any[])=>els.map(el=>{const b=el.getBoundingClientRect();return{width:b.width,left:b.left,right:b.right,scroll:el.scrollWidth,client:el.clientWidth,inner:innerWidth}}))}
const c={device:'desk',theme:'light',lang:'en'};
try{
 await runtime.apply(yaml.load(readFileSync(join(hubHome,'fleet.yaml'),'utf8')) as any);check('Hub runtime ready',runtime.currentHolds().length===0,runtime.currentHolds());
 const {bootFixture}=await import(repo+'/scripts/manual/smoke-fixture/index.mts');fx=await bootFixture({port:hp,instances:2,classic:false});result.browser=fx.browser.version();
 const issue=fx.fm.webLoginCodes.issue.bind(fx.fm.webLoginCodes);fx.fm.webLoginCodes.issue=(input:any)=>issue({...input,host:true});
 const fm=fx.fm,cfgPath=join(fx.dir,'fleet.yaml'),cfg:any=yaml.load(readFileSync(cfgPath,'utf8'));cfg.hub_member={enabled:true};writeFileSync(cfgPath,yaml.dump(cfg));fm.hubEffectsReady=true;
 fm.hubAgentToken=()=> 'fixture-owned-lifecycle';fm.hubAgentQuota=async()=>({band:'unknown'});
 fm.deliverHubQuestion=async(input:any)=>{const ok=input.stillCurrent()&&await input.beforeInput()&&input.stillCurrent();deliveries.push({agent:input.agent,correlationId:input.correlationId,ok});return ok};
 for(const name of ['startInstance','startInstanceUnattended','restartInstance','restartFleet','stopInstance'])fm[name]=async()=>{throw Error('native operation refused: '+name)};
 fm.loadConfig(cfgPath);await fm.applyHubSwitches();
 console.log('Hub/member fixture ready');const owner=await hubPage(c,'/ui/hub/exposures');await signIn(owner.page,'olivia');
 const admin=await hubPage(c,'/ui/hub/admin');await signIn(admin.page,'admin');await admin.page.locator('.hub-step-form input').fill('olivia');await admin.page.locator('.hub-step-form button').click();await admin.page.locator('.hub-code').waitFor();
 await admin.ctx.grantPermissions(['clipboard-read','clipboard-write'],{origin:webOrigin});await admin.page.locator('.hub-offer button').click();const copied=await admin.page.evaluate(()=>navigator.clipboard.readText());check('browser copies member address and code',copied.includes(memberOrigin));await shot(admin.page,'workflow-code');
 const code=await admin.page.locator('.hub-code').innerText();check('copied exact code',copied.includes(code));check('code card supplies member origin',await admin.page.locator('.hub-offer .hub-origin').innerText()===memberOrigin);
 const fleet=await fx.page(c,{path:'/settings/hub'});await setup(fleet.ctx,c);await fleet.page.reload();await fleet.page.locator('#hubAddress').fill(memberOrigin);await fleet.page.locator('#hubCode').fill(code);await fleet.page.locator('form.hub-connect button[type=submit]').click();
 await applyPending(fleet.page);await fleet.page.locator('.hub-local-confirm').waitFor({timeout:15000});const fp=await fleet.page.locator('.hub-fp-groups').first().innerText();
 await fleet.page.locator('.hub-local-confirm').click();await applyPending(fleet.page);
 console.log('Fleet fingerprint checked');await owner.page.reload();await owner.page.locator('.hub-pairings button').click();await approveDialog(owner.page);
 await admin.page.reload();await admin.page.locator('.hub-steps ~ .hub-rows button').filter({hasText:/Approve|核准/}).click();await approveDialog(admin.page);
 console.log('Owner/admin approved');await fleet.page.locator('.hub-paired').waitFor({timeout:25000});check('pairing retained fingerprint approvals',fp.replaceAll(' ','').length>=32&&fm.hubMemberPairing().view().state==='paired');
 await fleet.page.locator('.hub-exposure input').last().click();await applyPending(fleet.page);await fleet.page.locator('.hub-exposure.is-shared a').waitFor({timeout:20000});
 const href=await fleet.page.locator('.hub-exposure.is-shared a').getAttribute('href');result.continuation=href;await fleet.page.locator('.hub-exposure.is-shared').scrollIntoViewIfNeeded();await shot(fleet.page,'workflow-published');const id=new URL(href).searchParams.get('agent');check('exact agent link',new URL(href).origin===webOrigin&&!!id&&new URL(href).searchParams.get('grant')==='1');
 console.log('Agent published');const [freshPage]=await Promise.all([fleet.ctx.waitForEvent('page'),fleet.page.locator('.hub-exposure.is-shared a').click()]);const fresh={page:freshPage,ctx:fleet.ctx};await fresh.page.locator('.hub-signin').waitFor();await signIn(fresh.page,'olivia');await fresh.page.locator('.hub-grant').waitFor();
 await shot(fresh.page,'workflow-signed-in-grant');check('signed-out continuation restored grant form',(await fresh.page.locator('.hub-grant').count())===1);
 // The asker must have signed in once; grants resolve the directory's current identity.
 const asker=await hubPage(c,'/ui/hub');await signIn(asker.page,'alex');
 await fresh.page.locator('.hub-grant input').fill('alex');await fresh.page.locator('.dlg-actions .btn-primary').click();await fresh.page.locator('.hub-grant').waitFor({state:'detached'});
 await asker.page.reload();await asker.page.locator('.hub-new').first().click();await asker.page.locator('.hub-pick-row button').first().click();
 await asker.page.locator('#msgIn').fill('Fixture question after contextual grant');await asker.page.locator('#sendBtn').click();
 for(let n=0;n<100&&!deliveries.length;n++)await new Promise(r=>setTimeout(r,100));check('question reached real representative admission',deliveries.some(d=>d.ok),deliveries);
 check('workflow CSP',!(await admin.page.evaluate(()=>window.__csp)).length&&!(await fresh.page.evaluate(()=>window.__csp)).length&&!(await fleet.page.evaluate(()=>window.__csp)).length);
 const adminCookies=await admin.ctx.cookies(),ownerCookies=await owner.ctx.cookies();await fresh.page.close();await asker.ctx.close();await admin.ctx.close();await owner.ctx.close();await fleet.ctx.close();
 if(!process.env.INTEGRATED){for(const device of ['desk','phone'])for(const theme of ['light','dark'])for(const lang of ['en','zh-TW'])for(const mode of ['before','current']){
  const c={device,theme,lang},tag=`${mode}-${device}-${theme}-${lang}`;const entry:any={tag};result.cases.push(entry);
  const a=await hubPage(c,'/ui/hub/admin',mode,adminCookies);await a.page.locator('.hub-step-form input').fill('olivia');await a.page.locator('.hub-step-form button').click();await a.page.locator('.hub-code').waitFor();await shot(a.page,tag+'-code');entry.code=await geometry(a.page,'.hub-offer');
  const f=await fx.page(c as any,{path:'/settings/hub'});await setup(f.ctx,c,mode);await f.page.reload();await f.page.locator('.hub-exposure.is-shared').waitFor();await f.page.locator('.hub-exposure.is-shared').scrollIntoViewIfNeeded();await shot(f.page,tag+'-share');entry.share=await geometry(f.page,'.hub-exposure.is-shared');
  if(mode==='current'){const p=await hubPage(c,new URL(href).pathname+new URL(href).search,mode,ownerCookies);await p.page.locator('.hub-grant').waitFor();await shot(p.page,tag+'-grant');entry.dialog=await geometry(p.page,'.dlg');entry.fields=await geometry(p.page,'.hub-grant .field');check(tag+' stacked form fields',entry.fields.every((b:any)=>b.width>=entry.dialog[0].width-60),entry);check(tag+' no overflow',[...entry.code,...entry.share,...entry.dialog].every((b:any)=>b.left>=-1&&b.right<=b.inner+1),entry);await p.ctx.close()}
  if(mode==='before'){const p=await hubPage(c,new URL(href).pathname+'?agent='+id,mode,ownerCookies);await p.page.locator('.hub-card-head button').click();await p.page.locator('.hub-grant').waitFor();await shot(p.page,tag+'-grant');await p.ctx.close()}await a.ctx.close();await f.ctx.close();
 }
 for(const c of [{device:'desk',theme:'dark',lang:'en'},{device:'phone',theme:'light',lang:'zh-TW'}]){
  const p=await hubPage(c,'/ui/hub/admin','skew',adminCookies);await p.page.locator('.hub-step-form input').fill('olivia');await p.page.locator('.hub-step-form button').click();await p.page.locator('.hub-code').waitFor();await shot(p.page,`skew-${c.device}-${c.lang}-code`);check('cached CSS address '+c.device,(await p.page.locator('.hub-offer').innerText()).includes(memberOrigin));await p.ctx.close();
  const f=await fx.page(c as any,{path:'/settings/hub'});await setup(f.ctx,c,'skew');await f.page.reload();await f.page.locator('.hub-exposure.is-shared a').waitFor();await f.page.locator('.hub-exposure.is-shared').scrollIntoViewIfNeeded();await shot(f.page,`skew-${c.device}-${c.lang}-share`);check('cached CSS link '+c.device,await f.page.locator('.hub-exposure.is-shared a').getAttribute('href')===href);await f.ctx.close();
 }
 }check('no browser exceptions',errors.length===0,errors);if(!process.env.INTEGRATED)check('cached shell/CSS exercised',result.skewHits>0);result.status='PASS';
}catch(e:any){result.status='FAIL';result.error=e.stack;for(const [i,p]of(fx?.browser?.contexts()??[]).flatMap((ctx:any)=>ctx.pages()).entries()){try{await shot(p,'failure-'+i);result['failure'+i]={url:p.url(),text:await p.locator('body').innerText()}}catch{}}throw e}
finally{result.finishedAt=new Date().toISOString();result.deliveries=deliveries;result.errors=errors;result.requests=requests;result.log=log;writeFileSync(join(artifacts,'results.json'),JSON.stringify(result,null,2));await fx?.fm?.hubRuntime?.close();await runtime.close();await fx?.close();}
console.log(JSON.stringify({status:result.status,cases:result.cases.length,checks:result.checks.length,shots}));process.exit(0);
