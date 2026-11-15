/** Actual sealed Hub factory/HTTPS/SQLite and shared UI; inert directory, no Fleet, real AD or CLI. */
import { createRequire } from 'node:module';
import { createServer, Server } from 'node:net';
import { Server as TlsServer } from 'node:tls';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import yaml from 'js-yaml';
import { makeTestCerts, ADMIN } from '../../../tests/support/hub-init-fixtures.js';
import { createHubInitializer } from '../../../src/hub/init/initializer.js';
import { hubIdentityProvider } from '../../../src/hub/init/identity.js';
import { createHubServerFactory } from '../../../src/hub/compose/server.js';
import { S3B_HTTP_ENTRY } from '../../../src/hub/runtime.js';
const out=resolve(process.env.OUT || '.artifacts/team-allowlist-m3194/browser'); mkdirSync(out,{recursive:true});
const hash=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex');
const receipt:any={source:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),scope:'Actual sealed production factory, HTTPS, SQLite, shared picker and both editors. Inert directory only. No live AD, Fleet, CLI, room or deployment claim.',checks:[],pictures:[],geometry:[],servedAssets:[],errors:[],foreign:[]};
const check=(name:string,value:unknown)=>{receipt.checks.push({name,ok:!!value});if(!value)throw Error(name)};
const leases=new Map<number,{server:Server,claimed:boolean}>(),listen=Server.prototype.listen;
// Same bound-handle handoff as #3945: every selected port stays bound until its real TLS listener adopts it.
Server.prototype.listen=function(this:Server,...args:any[]){const lease=typeof args[0]==='number'&&args[1]==='127.0.0.1'?leases.get(args[0]):undefined;
 if(lease&&!lease.claimed&&this instanceof TlsServer){lease.claimed=true;return Reflect.apply(listen,this,[lease.server,args.filter(a=>typeof a==='function').pop()]);}return Reflect.apply(listen,this,args); } as typeof listen;
async function reserve(){const server=createServer();await new Promise<void>((yes,no)=>{server.once('error',no);server.listen(0,'127.0.0.1',()=>{server.removeListener('error',no);yes()})});server.unref();const port=(server.address()as any).port;leases.set(port,{server,claimed:false});return port}
let browser:any,service:any,db:Database.Database|undefined,home:string|undefined,certs:ReturnType<typeof makeTestCerts>|undefined;
const assets=new Map<string,string>(),pending:Promise<void>[]=[];
try{
 const memberPort=await reserve(),webPort=await reserve(),origin=`https://hub.example.test:${webPort}`;
 home=mkdtempSync(join(out,'private-home-'));certs=makeTestCerts();
 const group=randomUUID(),other=randomUUID(),team=randomUUID(),dn='CN=Hub Members,DC=example,DC=test';
 const people=[ADMIN,...[['morgan','Morgan Example'],['riley','Riley Example']].map(([login,displayName])=>({key:{realm:'corp',objectId:randomUUID()},login,displayName,dn:`CN=${displayName},DC=example,DC=test`,groups:[]}))];
 const directory:any={realm:'corp',groupPolicy:'ad-direct-guid',async signIn(login:string,password:string){const person=people.find(p=>p.login===login);return person&&password===`test-${login}`?{ok:true,person}:{ok:false,reason:'invalid-credentials'}},
 async checkEligibility(key:any){const person=people.find(p=>p.key.realm===key.realm&&p.key.objectId===key.objectId);return person?{eligible:true,person}:{eligible:false,reason:'disabled'}},
 async resolvePolicyGroup(value:string){return value===dn?{ok:true,group:{key:{realm:'corp',objectId:group},dn}}:{ok:false,reason:'not-found'}},
 async readPolicyGroups(person:any){return {kind:'complete',person,groups:[person.objectId===ADMIN.key.objectId?group:other],observedAt:Date.now()}},
 async searchPolicyGroups(q:string){return {ok:true,groups:/hub/i.test(q)?[{objectId:group,cn:'Hub Members',dn}]:[],truncated:false}},
 async searchGrantPeople(q:string){return {ok:true,people:people.filter(p=>`${p.login} ${p.displayName}`.toLowerCase().includes(q.toLowerCase())).map(p=>({person:p.key,login:p.login,displayName:p.displayName})),truncated:false}},async close(){}};
 const plan:any={name:'Allowed-list trial Hub',webOrigin:origin,memberOrigin:`https://hub.example.test:${memberPort}`,webListen:{host:'127.0.0.1',port:webPort},memberListen:{host:'127.0.0.1',port:memberPort},webTls:{certFile:certs.cert,keyFile:certs.key},directory:{realm:'corp',url:'ldaps://directory.example.test:636',profile:'ad',baseDn:'DC=example,DC=test',bindDn:'CN=Reader,DC=example,DC=test'},bindPasswordRef:'file:hub/secrets/directory-bind',administrator:ADMIN.key,retention:{contentDays:7,eventDays:30},coexistence:'dedicated'};
 const init=createHubInitializer({home,identity:hubIdentityProvider(),probe:{pidAlive:()=>false}}),confirmation=await init.prepareConfirmation(plan,{bindPassword:'inert-test-bind'});await init.commit(plan,confirmation.reference);
 const cfg=(yaml.load(readFileSync(join(home,'fleet.yaml'),'utf8'))as any).hub;
 service=await createHubServerFactory({home,components:{http:S3B_HTTP_ENTRY},createDirectory:()=>directory,report:()=>{},log:()=>{}})(cfg,()=>true);await service.start();
 check('both actual TLS listeners adopted reserved sockets',[...leases.values()].every(l=>l.claimed));
 db=new Database(join(home,'hub/hub.sqlite'));db.pragma('foreign_keys=ON');
 db.prepare("INSERT INTO hub_teams VALUES(?,1,'Product launch','','','',?,?,?,0)").run(team,`corp/${people[1]!.key.objectId}`,Date.now(),Date.now());
 db.prepare('INSERT INTO hub_team_leads VALUES(?,?,0)').run(team,`corp/${people[1]!.key.objectId}`);
 for(const p of people.slice(1))db.prepare("INSERT INTO hub_team_members VALUES(?,?,?,?, '')").run(team,`corp/${p.key.objectId}`,p.displayName,p.login);
 const pw=createRequire(resolve(process.env.PW_DIR||'.','package.json'))('playwright-core');
 browser=await pw.chromium.launch({...(process.env.CHROME?{executablePath:process.env.CHROME}:{}),args:['--no-sandbox','--no-proxy-server','--host-resolver-rules=MAP hub.example.test 127.0.0.1']});receipt.browser=browser.version();
 const cases=[{device:'desktop',lang:'en',theme:'light'},{device:'desktop',lang:'zh-TW',theme:'dark'},{device:'phone',lang:'en',theme:'dark'},{device:'phone',lang:'zh-TW',theme:'light'}];
 const subject=`[data-subject="team/${team}"]`;
 for(const [i,c] of cases.slice(Number(process.env.START_CASE || 0)).entries()){
  const tag=`${c.device}-${c.lang}-${c.theme}`,context=await browser.newContext({viewport:c.device==='phone'?{width:390,height:844}:{width:1366,height:1000},isMobile:c.device==='phone',hasTouch:c.device==='phone',locale:c.lang==='en'?'en-US':'zh-TW',colorScheme:c.theme,ignoreHTTPSErrors:true});
  try{
   await context.addInitScript({content:'window.__name=fn=>fn;'});
   await context.addInitScript(({lang,theme}:any)=>{localStorage.setItem('agend_lang',lang);localStorage.setItem('agend_theme',theme);localStorage.setItem('agend_tour_done','1');},c);
   await context.route('**/*',(r:any)=>{if(new URL(r.request().url()).origin!==origin){receipt.foreign.push(r.request().url());return r.abort()}return r.continue()});
   const page=await context.newPage();page.on('pageerror',(e:any)=>receipt.errors.push(String(e)));page.on('response',(res:any)=>{const path=new URL(res.url()).pathname;if(path.startsWith('/assets/')||path.startsWith('/ui/js/'))pending.push(res.body().then((b:Buffer)=>assets.set(path,hash(b))).catch(()=>{}))});
   const shot=async(name:string)=>{const path=`${tag}-${name}.png`;await page.screenshot({path:join(out,path),fullPage:true});receipt.pictures.push({path,sha256:hash(readFileSync(join(out,path)))})};
   const geometry=async(scope:string,label:string)=>{const sizes=await page.locator(`${scope} button,${scope} input:not([type=checkbox]),${scope} select,${scope} label:has(input[type=checkbox])`).evaluateAll((els:HTMLElement[])=>els.filter(el=>!el.hidden&&el.getBoundingClientRect().width>0).map(el=>({tag:el.tagName,text:(el.textContent||'').trim().slice(0,80),width:el.getBoundingClientRect().width,height:el.getBoundingClientRect().height})));receipt.geometry.push({tag,label,fields:sizes});check(tag+' '+label+' horizontal fit',await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));check(tag+' '+label+' touch targets',c.device!=='phone'||sizes.every((s:any)=>s.width>=43.9&&s.height>=43.9))};
   await page.goto(origin+'/ui/hub/admin?view=groups');await page.fill('#hubLogin',ADMIN.login);await page.fill('#hubPassword',`test-${ADMIN.login}`);await page.locator('.hub-signin button[type=submit]').click();await page.locator('.hub-groups-list').waitFor();
   if(i===0){
    await page.locator('.hub-subject-picker input[type=search]').fill('Hub');await page.locator('.hub-group-hits button').click();await page.locator(`[data-group="${group}"]`).waitFor();
    await page.locator('.hub-groups-state button').click();
    await page.locator('.hub-subject-picker [data-subject-kind]').selectOption('team');await page.locator('[data-grant-team]').selectOption(team);await page.locator(subject).waitFor();
    await page.locator(subject+' input[type=checkbox]').nth(2).check();
    await page.locator('.hub-subject-picker [data-subject-kind]').selectOption('person');await page.locator('.hub-subject-picker input[type=search]').fill('Morgan');await page.locator('.hub-group-hits button').click();await page.locator(`[data-subject="person/${people[1]!.key.objectId}"]`).waitFor();
   }
   await page.locator(subject+' input[type=number]').fill(String(i%2*2+2));await page.locator('.hub-groups-preview .btn-primary').waitFor();
   check(tag+' full Team summary has count and lead',(await page.locator(subject).innerText()).includes('Morgan Example')&&/2/.test(await page.locator(subject).innerText()));
   await geometry('.hub-groups','full');if(!process.env.RETAKE || c.device==='phone')await shot('full-preview');
   const put=page.waitForResponse((r:any)=>r.url().endsWith('/hub/v1/admin/group-policy')&&r.request().method()==='PUT');await page.locator('.hub-groups-preview .btn-primary').click();check(tag+' full actual save',(await put).status()===200);await page.locator('.hub-groups-preview').waitFor({state:'detached'});
   const details=await page.evaluate(async(id:string)=>{const r=await fetch('/hub/v1/teams/'+id);return r.json()},team);check(tag+' production factory Used-for hook',details.team?.impact?.allowedList===true);
   await page.goto(origin+'/ui/hub/admin?view=manage');await page.locator('.hub-join-step2').waitFor();await page.locator('.hub-join-step2 '+subject+' input[type=number]').fill(String(i%2*2+3));await page.locator('.hub-join-preview .btn-primary').waitFor();
   await geometry('.hub-join-step2','manage');await shot('manage-preview');
   const saved=page.waitForResponse((r:any)=>r.url().endsWith('/hub/v1/admin/group-policy')&&r.request().method()==='PUT');await page.locator('.hub-join-preview .btn-primary').click();check(tag+' manage actual save',(await saved).status()===200);await page.locator('.hub-join-preview').waitFor({state:'detached'});
   const stored=JSON.parse((db.prepare('SELECT body FROM hub_group_policy').get()as any).body);
   check(tag+' SQLite preserves all three subject kinds',stored.groups.length===1&&stored.teams.length===1&&stored.people.length===1&&stored.teams[0].maxFleets===i%2*2+3);
  }finally{await context.close()}
 }
 check('no browser errors',!receipt.errors.length);check('only owned Hub requests',!receipt.foreign.length);receipt.status='PASS';
}catch(error:any){receipt.status='FAIL';receipt.error=error.stack;throw error}
finally{
 await Promise.all(pending);receipt.servedAssets=[...assets].sort(([a],[b])=>a.localeCompare(b)).map(([path,sha256])=>({path,sha256}));writeFileSync(join(out,'receipt.json'),JSON.stringify(receipt,null,2)+'\n');
 await browser?.close();db?.close();await service?.close();Server.prototype.listen=listen;
 for(const lease of leases.values())await new Promise<void>(yes=>{if(!lease.server.listening)return yes();lease.server.close(()=>yes())});
 if(home)rmSync(home,{recursive:true,force:true});if(certs)rmSync(certs.dir,{recursive:true,force:true});
}
console.log(JSON.stringify({status:receipt.status,checks:receipt.checks.length,pictures:receipt.pictures.length}));
