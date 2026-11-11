/** Real old/new source FleetManagers + Hub/fake LDAPS/browser. No CLI/Agent/host lifecycle. */
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID, generateKeyPairSync, randomBytes } from 'node:crypto';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { request } from 'node:http';
import { pathToFileURL } from 'node:url';
if (process.env.AGEND_OWNED_CONTAINER !== 'hub-simplify-s1' || !existsSync('/.dockerenv') || process.env.SAFE_RUN !== '1') throw Error('Owned SAFE_RUN container required');
const out=process.env.OUT!, root=mkdtempSync(join(tmpdir(),'ridge-s1-')); mkdirSync(out,{recursive:true});
process.env.AGEND_HOME=join(root,'environment'); mkdirSync(process.env.AGEND_HOME,{mode:0o700});
const receipt:any={checks:[],screenshots:[],legacy:'9c98307c938b77d8eaaebf5bcd3f20c5c27dce6f',boundary:'Owned network-none read-only container, real source FleetManager health/Settings and member runtime with empty Agents, production Hub and verified synthetic LDAPS, actual Chromium. Source compatibility, not packaged/systemd/tmux/native/live AD. Reconnect push is supplied through an explicit client fixture hook until U1 orchestrates it.'};
const check=(name:string,pass:boolean)=>{receipt.checks.push({name,pass});console.log(JSON.stringify({check:name,pass}));if(!pass)throw Error(name);};
const wait=async(fn:()=>boolean,ms=15000)=>{const end=Date.now()+ms;while(!fn()&&Date.now()<end)await new Promise(r=>setTimeout(r,30));if(!fn())throw Error('Owned fixture deadline');};
const tls=createRequire(import.meta.url)('node:tls'), original=tls.connect;let dc=0;
tls.connect=(options:any,...args:any[])=>original({...options,...(options.host==='127.0.0.1'&&options.port===636?{port:dc}:{}),...(options.host==='hub.example.test'?{host:'127.0.0.1'}:{})},...args);syncBuiltinESMExports();
const load=async(build:string,path:string)=>import(pathToFileURL(`${build}/src/${path}`).href);
const {chromium}=await import('playwright-core');let browser:any;const managers:any[]=[];const rigs:any[]=[];const clients:any[]=[];
const post=(port:number,path:string,headers:any,body?:unknown)=>new Promise<any>((resolve,reject)=>{const req=request({host:'127.0.0.1',port,path,method:'POST',headers},r=>{let text='';r.on('data',b=>text+=b);r.on('end',()=>resolve({status:r.statusCode,headers:r.headers,body:JSON.parse(text)}));});req.on('error',reject);req.end(body===undefined?undefined:JSON.stringify(body));});
async function closeManager(fm:any){fm.hubEffectsReady=false;await fm.hubRuntime?.close();fm.companyJoinController?.close();if(fm.healthServer){fm.healthServer.closeAllConnections();await new Promise<void>(r=>fm.healthServer.close(()=>r()));fm.healthServer=null;}fm.webSessions?.flush?.();}
async function hub(build:string){const {companyJoinRig}=await import(pathToFileURL(`${build}/tests/support/hub-company-join-rig.ts`).href);const r=await companyJoinRig((port:number)=>{dc=port;});rigs.push(r);const admin=await r.signIn('alice');await r.enable(admin,1);const enabled=await r.call(admin,'PUT','/hub/v1/admin/company-join',{enabled:true,expectedRevision:1});check('company join enabled via exact admin '+build,enabled.status===200);return r;}
async function fleet(build:string,r:any,label:string,language:string,supersedes?:any){
 const home=join(root,randomUUID());mkdirSync(home,{mode:0o700});writeFileSync(join(home,'fleet.yaml'),'instances: {}\nhub_member:\n  enabled: true\n',{mode:0o600});
 const {FleetManager}=await load(build,'fleet-manager.ts');const fm=new FleetManager(home);managers.push(fm);const sink=()=>{};fm.logger={info:sink,warn:sink,error:sink,debug:sink,trace:sink,fatal:sink,child:()=>fm.logger};
 fm.loadConfig(join(home,'fleet.yaml'));fm.hubEffectsReady=true;await fm.applyHubSwitches();fm.initializeWebAuthTokens();fm.startHealthServer(0);await wait(()=>fm.getDashboardAccess().ready);
 const port=fm.healthServer.address().port,origin=`http://127.0.0.1:${port}`;
 const issue=await post(port,'/auth/issue-code',{origin,'x-agend-token':fm.getDashboardAccess().token});
 const signed=await post(port,'/auth/login',{origin,'content-type':'application/json'},{code:issue.body.code});check('real local admin '+label,signed.status===200);
 const [name,value]=signed.headers['set-cookie'][0].split(';')[0].split('=');
 const {CompanyJoinClient}=await load(build,'hub/join/client.ts');const real=new CompanyJoinClient({ca:readFileSync(r.certs.caCert),lookup:(_h:string,o:any,done:any)=>o.all?done(null,[{address:'127.0.0.1',family:4}]):done(null,'127.0.0.1',4)});
 const controller=await fm.hubCompanyJoin();controller.client={discover:real.discover.bind(real),command:(binding:any,purpose:any,payload:any,...rest:any[])=>real.command(binding,purpose,purpose==='push'&&supersedes?{...payload,supersedes}:payload,...rest)};
 const context=await browser.newContext({ignoreHTTPSErrors:true,locale:language,viewport:{width:1366,height:900}});await context.addCookies([{name,value,url:origin}]);await context.addInitScript((language:string)=>{localStorage.setItem('agend_lang',language);localStorage.setItem('agend_tour_done','1');localStorage.setItem('agend_firstrun_dismissed','1');},language);
 const page=await context.newPage();await page.goto(origin+'/settings/hub');await page.locator('.s-nav').waitFor();await page.locator('#hubCompanyAddress').fill(r.webOrigin);await page.locator('#hubCompanyFleetName').fill(label);
 const startResponse=page.waitForResponse((r:any)=>new URL(r.url()).pathname.endsWith('/company-join/start')&&r.request().method()==='POST'),opened=context.waitForEvent('page');await page.getByRole('button',{name:/以公司帳號登入|Sign in with company account/,exact:true}).click();const signin=await opened,start=await (await startResponse).json();console.log(JSON.stringify({stage:'local-start',result:start.result,pending:start.pending_change?.state,error:start.error}));
 if(start.result==='pending_confirmation'&&start.pending_change?.state==='pending')await page.locator('.pending-card[data-pending="'+start.pending_change.id+'"]').getByRole('button',{name:/立即套用|Apply now/,exact:true}).click();
 try{await signin.waitForURL(r.webOrigin+'/ui/hub?join=*');}catch(error){console.log(JSON.stringify({stage:'popup-wait',origin:new URL(signin.url()).origin,path:new URL(signin.url()).pathname,text:(await signin.locator('body').innerText()).slice(0,2200)}));await page.screenshot({path:join(out,label+'-local-failure.png')});await signin.screenshot({path:join(out,label+'-popup-failure.png')});throw error;}
 await signin.locator('#hubLogin').fill('carol');await signin.locator('#hubPassword').fill('Dummy-carol-only');await signin.getByRole('button',{name:/登入並連接 Fleet|Sign in and connect Fleet/,exact:true}).click();
 await page.locator('#hub-connection[data-state="connected"]').waitFor({timeout:30000});await wait(()=>fm.hubMemberLink==='online');check('browser/AD/receipt/member online '+label,true);
 const binding=fm.hubMemberPairing().boundHub(),profile=JSON.parse(readFileSync(join(home,'hub-member',binding.hubId,'pairing.json'),'utf8'));
 const shot=label+'.'+language+'.png';await page.screenshot({path:join(out,shot)});receipt.screenshots.push(shot);return {fm,home,profile,page,context};
}
try{
 browser=await chromium.launch({args:['--no-sandbox','--no-proxy-server','--host-resolver-rules=MAP hub.example.test 127.0.0.1']});
 const current=await hub('/work');
 const {CompanyJoinClient}=await load('/work','hub/join/client.ts'), {pkceChallenge}=await load('/work','hub/join/protocol.ts');
 const client=new CompanyJoinClient({ca:readFileSync(current.certs.caCert),lookup:(_h:string,o:any,d:any)=>o.all?d(null,[{address:'127.0.0.1',family:4}]):d(null,'127.0.0.1',4)});
 async function attempt(login:string,supersedes?:any){
  const meta=await client.discover(current.webOrigin,()=>true),key=generateKeyPairSync('ed25519'),verifier=randomBytes(32).toString('base64url'),state=randomBytes(32).toString('hex');
  const binding={hub:meta.hub,requestId:randomUUID(),operationId:randomUUID(),fleetId:randomUUID(),publicKey:key.publicKey.export({type:'spki',format:'pem'}).toString(),fleetOrigin:'http://127.0.0.1:43210',verifierS256:pkceChallenge(verifier)};
  const command=(purpose:any,payload:any={})=>client.command(binding,purpose,payload,key.privateKey,()=>true);
  await command('push',{label:'Owned protocol acceptance',stateHash:createHash('sha256').update(state).digest('hex'),invitation:null,...(supersedes?{supersedes}:{})});
  const opened=await current.call(null,'POST','/hub/join/open',new URLSearchParams({requestId:binding.requestId,state}).toString(),{'Content-Type':'application/x-www-form-urlencoded',Origin:binding.fleetOrigin});
  const person=await current.signIn(login);person.cookie+='; '+opened.cookie;
  return{command,approve:()=>current.call(person,'POST','/hub/v1/join/approve',{requestId:binding.requestId})};
 }
 current.people.push({id:randomUUID(),login:'offer-person',dn:'CN=OfferPerson,DC=example,DC=test',password:'Dummy-offer-person-only',groups:['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa']});
 const carol=await current.signIn('offer-person'),offer=await current.call(carol,'POST','/hub/v1/quick-pairing',{label:'Other owned connection'});
 check('S1-L5 actual quick offer created',offer.status===200);
 const waiting=await attempt('offer-person'),blockedOffer=await waiting.approve();
 check('S1-L5 precise offer-pending response',blockedOffer.status===409&&blockedOffer.body.code==='offer-pending');
 check('S1-L5 Fleet key holder receives same reason',(await waiting.command('status') as any).reason==='offer-pending');
 check('S1-L5 quick offer stopped',(await current.call(carol,'POST',`/hub/v1/quick-pairing/${offer.body.pairingId}/stop`,{})).status===200);
 check('S1-L5 exact same request continues',(await waiting.approve()).status===200);await waiting.command('cancel');
 const old=await fleet('/legacy',current,'old-fleet-new-hub','en-US');check('S1-L1 legacy strict Fleet joins new Hub',old.fm.hubMemberLink==='online');
 // Alpha.14 regression: full quota -> offline Disconnect -> rejoin without raising the limit.
 const blocked=await attempt('carol',{fleetId:old.profile.fleetId,credential:'f'.repeat(64)}),refused=await blocked.approve();
 check('S1-L4 wrong supersede proof cannot discount limit',refused.status===429&&refused.body.code==='limit-reached');
 const status:any=await blocked.command('status');check('exact key holder receives limit reason without issuance',status.state==='pending'&&status.reason==='limit-reached'&&!status.issued);await blocked.command('cancel');
 const foreign=await attempt('alice',{fleetId:old.profile.fleetId,credential:old.profile.credential});
 check('S1-L4 other-owner supersession refused',(await foreign.approve()).status===403);await foreign.command('cancel');
 check('S1-L4 no row revoked by invalid/foreign proof',current.deps.store.read().fleets.every((f:any)=>f.status==='active'));
 await current.stopService();const disconnected=await old.fm.hubMemberPairing().disconnect(old.fm.hubMemberPairing().boundHub());check('old Fleet removes locally while Hub offline',disconnected.ok===true);await closeManager(old.fm);
 await current.restartService();check('offline leave preserves old active row',current.deps.store.read().fleets.filter((f:any)=>f.status==='active').length===1);
 const fresh=await fleet('/work',current,'current-reconnect','zh-TW',{fleetId:old.profile.fleetId,credential:old.profile.credential});
 const afterReconnect=current.deps.store.read();check('S1-L3 exactly one active at personal limit one',afterReconnect.fleets.filter((f:any)=>f.status==='active').length===1&&afterReconnect.fleets.find((f:any)=>f.id===old.profile.fleetId)?.status==='revoked');
 check('supersede audited once',current.db.prepare("SELECT COUNT(*) n FROM hub_audit WHERE action='member.superseded'").get().n===1);
 const exact=fresh.fm.hubMemberPairing().boundHub();check('leave written through current mounted member',await fresh.fm.hubRuntime.memberLeave(exact));
 await wait(()=>current.deps.store.read().fleets.every((f:any)=>f.status==='revoked'),5000);check('S1-L2 member left revokes within five seconds',true);check('member.left audit',current.db.prepare("SELECT COUNT(*) n FROM hub_audit WHERE action='member.left'").get().n===1);await closeManager(fresh.fm);
 const legacy=await hub('/legacy');const modern=await fleet('/work',legacy,'new-fleet-old-hub','zh-TW');check('S1-L1 current Fleet joins old Hub',modern.fm.hubMemberLink==='online');
 receipt.ready=true;
}catch(error){receipt.error=String(error);console.error(receipt.error);process.exitCode=1;}
finally{
 for(const c of clients)await c.close().catch(()=>{});for(const fm of managers.reverse())await closeManager(fm).catch(()=>{});await browser?.close();for(const r of rigs.reverse())await r.close();tls.connect=original;syncBuiltinESMExports();rmSync(root,{recursive:true,force:true});receipt.cleaned=true;
 const product=['src/hub/join/service.ts','src/hub/join/store.ts','src/hub/join/http.ts','src/hub/store.ts','src/hub/pairing.ts','src/hub/server.ts','src/hub/protocol.ts','src/hub/http/compose.ts','src/hub/compose/server.ts','src/hub/types.ts','src/hub/fleet-revocation.ts','src/hub/client.ts','src/hub/mount.ts','src/hub/runtime.ts','src/hub/compose/member.ts'];
 receipt.production=product.map(path=>({path,sha256:createHash('sha256').update(readFileSync('/work/'+path)).digest('hex')}));receipt.images=receipt.screenshots.map((path:string)=>({path,sha256:createHash('sha256').update(readFileSync(join(out,path))).digest('hex')}));writeFileSync(join(out,'receipt.json'),JSON.stringify(receipt,null,2));
}
console.log(JSON.stringify({pass:receipt.ready===true,checks:receipt.checks.length,error:receipt.error}));process.exit(receipt.ready?0:1);
