import {createRequire,syncBuiltinESMExports} from 'node:module';
import {mkdirSync,mkdtempSync,writeFileSync,readFileSync,existsSync,chmodSync,rmSync,renameSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {execFileSync} from 'node:child_process';
const repo=resolve(process.env.REPO!),art=resolve(process.env.ART!),candidate=process.env.CANDIDATE;
if(!repo||!art||!candidate)throw Error('REPO ART CANDIDATE required');
const head=execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).trim();
if(head!==candidate||process.env.CANDIDATE_VERIFIED!=='1')throw Error('Candidate pin not independently verified');
mkdirSync(art,{recursive:true});mkdirSync(join(art,'png'),{recursive:true});
const home=mkdtempSync(join(art,'owned-')),bin=join(home,'bin');mkdirSync(bin);
Object.assign(process.env,{HOME:home,AGEND_HOME:home,CODEX_HOME:join(home,'codex'),CLAUDE_CONFIG_DIR:join(home,'claude'),TMUX_TMPDIR:join(home,'tmux'),FONTCONFIG_FILE:process.env.FONTCONFIG_FILE||'/etc/fonts/fonts.conf'});
for(const x of ['codex','claude','agend','tmux','kiro-cli']){writeFileSync(join(bin,x),`#!${process.execPath}\nprocess.exit(97)\n`);chmodSync(join(bin,x),0o755)}
process.env.PATH=[bin,dirname(process.execPath),'/usr/bin','/bin'].join(':');process.env.AGEND_TMUX_BIN=join(bin,'tmux');
const require=createRequire(import.meta.url),tls=require('node:tls'),original=tls.connect;let dcPort=0;
const host='dashboard.lan.example';
tls.connect=(o:any,...args:any[])=>original({...o,...(o.host==='127.0.0.1'&&o.port===636?{port:dcPort}:{}),...(o.host===host?{host:'127.0.0.1'}:{})},...args);syncBuiltinESMExports();
const {companyJoinRig}=await import('./rig.ts');
const {CompanyJoinClient}=await import(repo+'/src/hub/join/client.ts');
const {currentBinding}=await import(repo+'/src/hub/member/pairing-api.ts');
const {bootFixture}=await import(repo+'/scripts/manual/smoke-fixture/index.mts');
const pw=createRequire(resolve(process.env.PW_DIR!)+'/')('playwright-core');
const browser=await pw.chromium.launch({executablePath:process.env.CHROME,args:['--no-sandbox','--host-resolver-rules=MAP dashboard.lan.example 127.0.0.1']});
const receipt:any={head,browser:browser.version(),started:new Date().toISOString(),stories:[],screenshots:[],pageErrors:[],foreign:[],commands:[],scope:'Actual sealed Hub/FleetManager/HubRuntime/settings writer/production LDAP over dummy TLS-BER peer. Real Chrome public web paths. No response stubs, live accounts/fleet/pilot/native/model requests.'};
let r:any;const fxs:any[]=[],contexts:any[]=[],allowed=new Set<string>();
async function context(device='desk',theme='light'){
 const c=await browser.newContext({viewport:device==='phone'?{width:390,height:844}:{width:1366,height:900},isMobile:device==='phone',hasTouch:device==='phone',locale:'zh-TW',colorScheme:theme,ignoreHTTPSErrors:true});contexts.push(c);
 await c.addInitScript({content:`window.__name=f=>f;try{localStorage.setItem('agend_lang','zh-TW');localStorage.setItem('agend_theme',${JSON.stringify(theme)});localStorage.setItem('agend_tour_done','1');localStorage.setItem('agend_firstrun_dismissed','1')}catch{};window.__csp=[];document.addEventListener('securitypolicyviolation',e=>window.__csp.push(e.violatedDirective));`});
 await c.route('**/*',(route:any)=>{const u=new URL(route.request().url());if(!allowed.has(u.origin)){receipt.foreign.push(u.origin);return route.abort()}return route.continue()});
 c.on('page',(p:any)=>p.on('pageerror',(e:any)=>receipt.pageErrors.push(e.message)));
 return c;
}
async function shot(p:any,name:string){await p.evaluate(()=>document.fonts.ready);await p.screenshot({path:join(art,'png',name+'.png'),fullPage:true});receipt.screenshots.push(name);}
function check(ok:any,message:string){if(!ok)throw Error(message)}
async function hub(login:string,device='desk',theme='light'){
 const ctx=await context(device,theme),page=await ctx.newPage();page.setDefaultTimeout(15000);
 await page.goto(r.webOrigin+'/ui/hub');await page.fill('#hubLogin',login);await page.fill('#hubPassword',r.people.find((x:any)=>x.login===login).password);await page.locator('.hub-signin button[type=submit]').click();await page.locator('.p-hub-signin').waitFor({state:'detached'});return{ctx,page};
}
async function fleetPage(fm:any,base:string,device='desk',theme='light'){
 const ctx=await context(device,theme),page=await ctx.newPage();page.setDefaultTimeout(15000);
 fm.webPrefs.write('operator',new Map([['lang','zh-TW'],['theme',theme]]));
 const code=await(await ctx.request.post(base+'/auth/issue-code',{headers:{'X-Agend-Token':fm.webToken,Origin:base}})).json();
 check(typeof code.code==='string','Owned host login code refused');
 await page.goto(base+'/signin');await page.fill('#code',code.code);await page.click('#go');await page.waitForURL(base+'/ui');await page.goto(base+'/settings/hub');return{ctx,page};
}
async function member(device='desk',theme='light'){
 const fx=await bootFixture({port:55180+fxs.length*10,instances:1,classic:false});fxs.push(fx);allowed.add(fx.base);
 fx.fm.hubEffectsReady=true;
 for(const m of ['startInstance','startInstanceUnattended','restartInstance','restartFleet','stopInstance'])fx.fm[m]=async()=>{throw Error('Refused agent lifecycle '+m)};
 const controller=await fx.fm.hubCompanyJoin();controller.client=new CompanyJoinClient({ca:readFileSync(r.certs.caCert),lookup:(_h:any,o:any,cb:any)=>o.all?cb(null,[{address:'127.0.0.1',family:4}]):cb(null,'127.0.0.1',4)});
 const f=await fleetPage(fx.fm,fx.base,device,theme);return{...f,fx,controller};
}
async function step(id:string,fn:()=>Promise<any>,page?:any){const at=Date.now();try{const detail=await fn();receipt.stories.push({id,status:'PASS',at:new Date(at).toISOString(),duration:Date.now()-at,detail});return detail}catch(e:any){receipt.stories.push({id,status:'CHECK_REQUIRED',at:new Date(at).toISOString(),duration:Date.now()-at,error:e.stack});if(page)await shot(page,id+'-raw-failure').catch(()=>{});throw e}finally{writeFileSync(join(art,'receipt.json'),JSON.stringify(receipt,null,2))}}
try{
 r=await companyJoinRig((p:number)=>dcPort=p,{host});r.wire.state.mode='continuation';allowed.add(r.webOrigin);allowed.add(r.fleetOrigin);
 const api={r,receipt,browser,context,shot,check,hub,fleetPage,member,step,currentBinding,contexts,fxs,allowed};
 (globalThis as any).a10=api;
 writeFileSync(join(art,'ready.json'),JSON.stringify({head,browser:browser.version(),hub:r.webOrigin,fleet:r.fleetOrigin,home:r.home,pid:process.pid}));
 console.log('A10_READY '+JSON.stringify({head,hub:r.webOrigin,fleet:r.fleetOrigin,pid:process.pid}));
 let n=0;
 while(!existsSync(join(art,'stop'))){
  const command=join(art,'command.mjs');if(existsSync(command)){const text=readFileSync(command,'utf8'),saved=join(art,`command-${++n}.mjs`);renameSync(command,saved);
   try{const value=await new Function('return (async()=>{'+text+'\n})()')();receipt.commands.push({n,status:'PASS',value});console.log('CONTROL_DONE '+n+' '+JSON.stringify(value));}
   catch(e:any){receipt.commands.push({n,status:'ERROR',error:e.stack});console.log('CONTROL_ERROR '+n+' '+e.stack)}
   writeFileSync(join(art,'receipt.json'),JSON.stringify(receipt,null,2));
  }
  await new Promise(yes=>setTimeout(yes,200));
 }
}finally{
 for(const c of contexts)await c.close().catch(()=>{});
 for(const fx of fxs){fx.fm.companyJoinController?.close();fx.fm.hubEffectsReady=false;fx.fm.hubRuntime?.fence();await fx.fm.hubRuntime?.close();await fx.close()}
 await browser.close();if(r)await r.close();tls.connect=original;syncBuiltinESMExports();rmSync(home,{recursive:true,force:true});
 receipt.cleanup={at:new Date().toISOString(),browserClosed:true,rigClosed:true,ownedHomesRemoved:!existsSync(home)&&(!r||!existsSync(r.home)),pid:process.pid};
 writeFileSync(join(art,'receipt.json'),JSON.stringify(receipt,null,2));console.log('A10_CLEANED '+JSON.stringify(receipt.cleanup));
}
