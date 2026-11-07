/** #3370: real HTTPS + strict fake LDAPS, new recipients, ordinary owner browser; no native/model execution.
 * AGEND_HUB_RIG_ENV=<owned rig.env> REPO=<checkout> PW_DIR=<playwright-core> CHROME=<chrome>
 * FONTCONFIG_FILE=<CJK fonts.conf> TMPDIR=<short owned dir> MODE=before|current OUT=<PNG directory>
 * node --import tsx scripts/manual/smoke/smoke-hub-grant-3370.mts
 * The member-link/exposure publication and audit/content backend use s3bRig's recorded boundary. Sessions,
 * owner/revision checks, directory resolution, grants, projection and the browser are production code.
 */
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,chmodSync} from 'node:fs';import {join,resolve,dirname} from 'node:path';
import {createServer} from 'node:https';import {execFileSync} from 'node:child_process';import {randomUUID,randomBytes} from 'node:crypto';import {createRequire} from 'node:module';import {Client} from 'ldapts';
const repo=resolve(process.env.REPO??process.cwd()),out=resolve(process.env.OUT??join(repo,'docs/screenshots/hub-grant-3370')),art=resolve(process.env.ARTIFACT_DIR??join(repo,'.artifacts/hub-grant-3370')),mode=process.env.MODE??'current';mkdirSync(out,{recursive:true});mkdirSync(art,{recursive:true});
const scratch=mkdtempSync(join(art,mode+'-')),home=join(scratch,'home'),bin=join(scratch,'bin');for(const p of[home,bin,join(home,'.claude'),join(home,'.codex'),join(home,'tmux')])mkdirSync(p,{recursive:true,mode:0o700});
Object.assign(process.env,{HOME:home,AGEND_HOME:home,CLAUDE_CONFIG_DIR:join(home,'.claude'),CODEX_HOME:join(home,'.codex'),TMUX_TMPDIR:join(home,'tmux')});
for(const name of ['tmux','agend','claude','codex','kiro-cli']){const p=join(bin,name);writeFileSync(p,`#!${process.execPath}\nprocess.exit(97)\n`);chmodSync(p,0o755)}process.env.AGEND_TMUX_BIN=join(bin,'tmux');process.env.PATH=[bin,dirname(process.execPath),'/usr/bin','/bin'].join(':');
const env:Record<string,string>={};for(const line of readFileSync(process.env.AGEND_HUB_RIG_ENV!,'utf8').trim().split('\n')){const i=line.indexOf('=');env[line.slice(0,i)]=line.slice(i+1)}
const salt=randomBytes(4).toString('hex'),ownerLogin='grant-owner-'+salt,adminLogin='grant-admin-'+salt,disabledLogin='grant-disabled-'+salt;
const ldap=new Client({url:env.AGEND_HUB_RIG_LDAPS_URL,tlsOptions:{ca:readFileSync(env.AGEND_HUB_RIG_CA,'utf8')},timeout:3000});await ldap.bind(env.AGEND_HUB_RIG_ADMIN_DN,env.AGEND_HUB_RIG_ADMIN_PASSWORD);
const {guidStringToBytes}=await import(repo+'/src/hub/directory/profiles.ts');
async function add(login:string,uac='512'){const key={realm:'corp',objectId:randomUUID()};await ldap.add(`cn=${login},ou=people,dc=example,dc=test`,{objectClass:['inetOrgPerson','fakeAdUser'],cn:login,sn:'Acceptance',sAMAccountName:login,userAccountControl:uac,objectGUID:guidStringToBytes(key.objectId)!,userPassword:'pw-'+login});return key}
const owner=await add(ownerLogin),administrator=await add(adminLogin);await add(disabledLogin,'514');
const {createHubDirectory}=await import(repo+'/src/hub/directory/index.ts');const directory=createHubDirectory({realm:'corp',url:env.AGEND_HUB_RIG_LDAPS_URL,caPem:readFileSync(env.AGEND_HUB_RIG_CA,'utf8'),baseDn:'dc=example,dc=test',bindDn:env.AGEND_HUB_RIG_BIND_DN,profile:'ad',timeoutMs:3000},{bindPassword:env.AGEND_HUB_RIG_BIND_PASSWORD});
const port=Number(process.env.HP??49410),origin=`https://127.0.0.1:${port}`;
const {s3bRig}=await import(repo+'/tests/helpers/hub-s3b-rig.ts');const r=await s3bRig({directory,administrator,webOrigin:origin});const link=r.link(randomUUID(),owner);
const {createBrowserCertificate}=await import(repo+'/src/hub/init/browser-certificate.ts');const cert=await createBrowserCertificate(home,origin);
const server=createServer({cert:readFileSync(cert.certFile),key:readFileSync(cert.keyFile)},(q,p)=>{if(!r.http.handle(q,p)){p.writeHead(404);p.end()}});await new Promise<void>(done=>server.listen(port,'127.0.0.1',done));
const pw=createRequire(process.env.PW_DIR+'/')('playwright-core'),browser=await pw.chromium.launch({executablePath:process.env.CHROME,args:['--no-sandbox']});
const result:any={mode,source:execFileSync('git',['-C',repo,'rev-parse','HEAD'],{encoding:'utf8'}).trim(),browser:browser.version(),cases:[],checks:[],errors:[],requests:[],boundary:'Inert authenticated member publication; production HTTPS/session/LDAPS/grant UI. No CLI/model or live fleet.'};
const check=(name:string,ok:unknown)=>{result.checks.push({name,ok:!!ok});if(!ok)throw Error(name)};
const oldRef=process.env.OLD_REF??'46b036679',old=new Map<string,string>();for(const [url,file] of [['/assets/app.css','shared/app.css'],['/assets/app-shell.js','shared/app-shell.js'],['/assets/hub-owner.css','shared/hub-owner.css'],['/ui/js/hub-owner-strings.js','hub-owner-strings.js'],['/ui/js/hub-strings.js','hub-strings.js']])old.set(url,execFileSync('git',['-C',repo,'show',`${oldRef}:src/ui/${file}`],{encoding:'utf8',maxBuffer:16<<20}));
const shot=async(p:any,name:string)=>p.screenshot({path:join(out,name+'.png')});
try{
 const cases=[];for(const device of['desk','phone'])for(const lang of['en','zh-TW'])for(const theme of['light','dark'])cases.push({device,lang,theme,skew:false});if(mode!=='before')cases.push({device:'desk',lang:'en',theme:'dark',skew:true},{device:'phone',lang:'zh-TW',theme:'light',skew:true});
 for(const [i,c]of cases.entries()){
  const exposureId=randomUUID();await r.http.receive(r.frame('exposure.snapshot',{revision:i+1,exposures:[{id:exposureId,fleetId:link.fleetId,owner,displayName:'Shared research agent · 研究助手',revision:1,state:'published',dataViewId:'agent',allowedTools:[],policyDigest:'b'.repeat(64)}]},link)as never,link);
  const tag=`${mode}-${c.skew?'skew-':''}${c.device}-${c.lang}-${c.theme}`,login='grant-'+salt+'-'+i,key=await add(login);let p:any;
  const ctx=await browser.newContext({viewport:c.device==='phone'?{width:390,height:844}:{width:1366,height:900},isMobile:c.device==='phone',hasTouch:c.device==='phone',locale:c.lang==='zh-TW'?'zh-TW':'en-US',colorScheme:c.theme,ignoreHTTPSErrors:true});
  await ctx.addInitScript({content:`window.__name=fn=>fn;try{localStorage.setItem('agend_lang',${JSON.stringify(c.lang)});localStorage.setItem('agend_theme',${JSON.stringify(c.theme)});localStorage.setItem('agend_tour_done','1');localStorage.setItem('agend_firstrun_dismissed','1')}catch{};`});
  await ctx.route('**/*',(route:any)=>{const u=new URL(route.request().url());if(u.origin!==origin)return route.abort();if(c.skew&&old.has(u.pathname)){result.skewHits=(result.skewHits??0)+1;return route.fulfill({status:200,contentType:u.pathname.endsWith('.css')?'text/css':'text/javascript',body:old.get(u.pathname)})}return route.continue()});
  try{p=await ctx.newPage();p.on('pageerror',(e:any)=>result.errors.push(String(e)));p.on('response',(q:any)=>{if(q.url().includes('/hub/v1/grants'))result.requests.push({status:q.status(),method:q.request().method()})});
   await p.goto(origin+`/ui/hub/exposures?agent=${exposureId}&grant=1`);await p.fill('#hubLogin',ownerLogin);await p.fill('#hubPassword','pw-'+ownerLogin);await p.locator('.hub-signin button[type=submit]').click();await p.locator('.hub-grant').waitFor();
   const personId=key.realm+'/'+key.objectId;check(tag+' recipient has never signed in',(r.db.prepare('SELECT COUNT(*) n FROM hub_people WHERE person=?').get(personId)as any).n===0);
   await p.locator('.hub-grant input').fill(login);await p.locator('.dlg-actions .btn-primary').click();
   if(mode==='before'){
    await p.locator('.hub-owner .err').waitFor();await shot(p,tag+'-eligible-refused');check(tag+' base refuses eligible recipient',(r.db.prepare('SELECT COUNT(*) n FROM hub_grants WHERE subject=?').get(personId)as any).n===0);check(tag+' base dialog stays open',await p.locator('.hub-grant').count()===1);
   }else{
    await p.locator('.hub-grant').waitFor({state:'detached'});await p.getByText(login,{exact:true}).first().waitFor();await shot(p,tag+'-allowed-before-signin');
    check(tag+' only exact grant created',(r.db.prepare('SELECT COUNT(*) n FROM hub_grants WHERE subject=? AND exposure_id=?').get(personId,exposureId)as any).n===1);
    check(tag+' no recipient person',(r.db.prepare('SELECT COUNT(*) n FROM hub_people WHERE person=?').get(personId)as any).n===0);check(tag+' no recipient session',(r.db.prepare('SELECT COUNT(*) n FROM hub_sessions WHERE person=?').get(personId)as any).n===0);
    check(tag+' no horizontal overflow',await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await p.locator('.hub-card-head button').click();await p.locator('.hub-grant input').fill('unknown-'+salt);await p.locator('.dlg-actions .btn-primary').click();await p.locator('.hub-grant [role=alert]').waitFor();
    const refusal=c.lang==='en'?'Check the sign-in name and that the account is active':'請確認登入名稱正確、帳號仍可使用';check(tag+' plain refusal in dialog',(await p.locator('.hub-grant [role=alert]').innerText()).includes(refusal));await shot(p,tag+'-unknown-refused');
    await p.locator('.hub-grant input').fill(disabledLogin);await p.locator('.dlg-actions .btn-primary').click();await p.locator('.hub-grant [role=alert]').waitFor();check(tag+' disabled refusal',(await p.locator('.hub-grant [role=alert]').innerText()).includes(refusal));
    await p.keyboard.press('Escape');await p.locator('.hub-grant').waitFor({state:'detached'});
   }
   result.cases.push({tag,ok:true});
  }catch(e){if(p)await shot(p,tag+'-FAIL');throw e}finally{await ctx.close()}
 }
 check('all intended cases executed',result.cases.length===(mode==='before'?8:10));check('real grants endpoint exercised',result.requests.length>=result.cases.length);check('no browser exceptions',result.errors.length===0);if(mode!=='before')check('old shell assets served',result.skewHits>0);result.status='PASS';
}catch(e:any){result.status='FAIL';result.error=e.stack;throw e}
finally{writeFileSync(join(art,mode+'-browser-results.json'),JSON.stringify(result,null,2));await browser.close();await new Promise<void>(done=>server.close(()=>done()));await r.close();await directory.close();await ldap.unbind()}
console.log(JSON.stringify({status:result.status,cases:result.cases.length,checks:result.checks.length,out}));
