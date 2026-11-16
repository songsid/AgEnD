/** Headless Linux/WSL only. Real Fleet/Hub HTTP; no live Fleet, browser profile or CLI. */
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createServer} from 'node:https';

assert.equal(process.platform,'linux','Run only headless in Linux/WSL');
assert(process.env.PW_DIR,'Set PW_DIR to an owned Playwright prefix');
const out=resolve(process.env.OUT??'.artifacts/m3214/headless');mkdirSync(out,{recursive:true});
const home=mkdtempSync(join(out,'private-home-'));process.env.AGEND_HOME=home;
const pw=createRequire(resolve(process.env.PW_DIR!,'package.json'))('playwright-core');
const receipt:any={scope:'Headless Linux Chromium; real Fleet dispatcher and Hub HTTP/SQLite; fake directory, empty Fleet. No native title-bar claim.',checks:[],pictures:[]};
const check=(name:string,ok:unknown)=>{receipt.checks.push({name,ok:!!ok});assert(ok,name);};
let fm:any,hub:any,named:any,hubNamed:any,browser:any;
try{
 const {FleetManager}=await import('../../../src/fleet-manager.ts');const {tokenEpoch}=await import('../../../src/web-session.ts');
 fm=new FleetManager(home);fm.healthPortRetried=true;const noop=()=>{};fm.logger={info:noop,warn:noop,error:noop,debug:noop,child:()=>fm.logger};
 fm.fleetConfig={defaults:{},instances:{},web:{allowed_hosts:['agend-pwa.test'],preview:false}};
 for(const key of ['startInstance','stopInstance','reconcile','handleUpdateCommand'])fm[key]=()=>{throw Error('Forbidden live lifecycle: '+key);};
 fm.startPreviewListener=()=>{};fm.initializeWebAuthTokens();await fm.startHealthServer(0);
 while(!fm.healthServerListening)await new Promise(r=>setTimeout(r,30));
 const base='http://127.0.0.1:'+fm.healthServer.address().port;
 const key=join(home,'key.pem'),cert=join(home,'cert.pem');
 execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-keyout',key,'-out',cert,'-subj','/CN=agend-pwa.test','-addext','subjectAltName=DNS:agend-pwa.test,DNS:hub-pwa.test'],{stdio:'ignore'});
 named=createServer({key:readFileSync(key),cert:readFileSync(cert)},(req,res)=>fm.dispatchWebHttp(req,res,named.address().port));
 await new Promise<void>(r=>named.listen(0,'127.0.0.1',r));
 hubNamed=createServer({key:readFileSync(key),cert:readFileSync(cert)},(req,res)=>{if(!hub.http.handle(req,res)){res.writeHead(404);res.end();}});
 await new Promise<void>(r=>hubNamed.listen(0,'127.0.0.1',r));const hubBase='https://hub-pwa.test:'+hubNamed.address().port;
 const {s3bRig}=await import('../../../tests/helpers/hub-s3b-rig.ts');hub=await s3bRig({webOrigin:hubBase});
 browser=await pw.chromium.launch({headless:true,args:['--no-sandbox','--no-proxy-server','--host-resolver-rules=MAP agend-pwa.test 127.0.0.1,MAP hub-pwa.test 127.0.0.1'],env:{...process.env,DISPLAY:'',WAYLAND_DISPLAY:''}});
 receipt.browser=browser.version();
 for(const entry of [{label:'fleet-local',base,path:'/ui',fleet:true},{label:'fleet-named',base:'https://agend-pwa.test:'+named.address().port,path:'/ui',fleet:true},{label:'hub-named',base:hubBase,path:'/ui/hub',fleet:false}]){
  const context=await browser.newContext({viewport:{width:1120,height:820},colorScheme:'light',locale:'en',ignoreHTTPSErrors:true});
  const page=await context.newPage();const errors:string[]=[];page.on('pageerror',(e:Error)=>errors.push(e.message));
  await context.addInitScript(()=>{localStorage.setItem('agend_lang','en');localStorage.setItem('agend_tour_done','1');});
  if(entry.fleet){
   fm.initializeWebSessions();const code=fm.webLoginCodes.issue({tier:'admin',epoch:tokenEpoch(fm.webToken)}).display;
   await page.goto(entry.base+'/signin');await page.locator('#code').evaluate((input:HTMLInputElement,value:string)=>{input.value=value;input.form!.requestSubmit();},code);await page.waitForURL('**/ui**');
  }else{
   const session=await hub.signIn('admin');assert.equal(session.status,200);const split=session.cookie.indexOf('=');
   await context.addCookies([{name:session.cookie.slice(0,split),value:session.cookie.slice(split+1),url:entry.base,secure:true,httpOnly:true,sameSite:'Strict'}]);
  }
  const response=await page.goto(entry.base+entry.path);check(entry.label+' production CSP',response!.headers()['content-security-policy']?.includes("default-src 'self'"));
  await page.waitForFunction(()=>Boolean((window as any).AgendTheme&&document.querySelector('.panel-head')));
  const manifest=await page.evaluate(async()=>{const link=document.querySelector<HTMLLinkElement>('link[rel="manifest"]')!;const r=await fetch(link.href);return {status:r.status,type:r.headers.get('content-type'),value:await r.json()};});
  check(entry.label+' standalone manifest',manifest.status===200&&manifest.type==='application/manifest+json'&&manifest.value.name==='AgEnD'&&manifest.value.id==='/'&&manifest.value.display==='standalone');
  check(entry.label+' launch colors',/^#[a-f0-9]{6}$/i.test(manifest.value.theme_color)&&/^#[a-f0-9]{6}$/i.test(manifest.value.background_color));
  for(const icon of manifest.value.icons){const r=await page.evaluate(async path=>{const response=await fetch(path);return {status:response.status,type:response.headers.get('content-type')};},icon.src);check(entry.label+' icon '+icon.sizes,r.status===200&&r.type==='image/png');}
  const cdp=await context.newCDPSession(page),app=await cdp.send('Page.getAppManifest');check(entry.label+' browser parses manifest',app.errors.length===0);
  for(const theme of ['light','dark','custom']){
   await page.evaluate(theme=>{(window as any).AgendTheme.set(theme==='light'?'light':'dark');if(theme==='custom')document.querySelector<HTMLElement>('.panel-head')!.style.backgroundColor='#17313f';},theme);
   const expected=theme==='light'?'rgb(255, 255, 255)':theme==='dark'?'rgb(33, 33, 33)':'rgb(23, 49, 63)';
   await page.waitForFunction(expected=>document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.content===expected,expected);
   const view=await page.evaluate(()=>{const tags=[...document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')];return {color:tags[0].content,count:tags.length,media:tags[0].getAttribute('media'),osLight:matchMedia('(prefers-color-scheme: light)').matches};});
   check(entry.label+' '+theme+' live color',view.count===1&&view.media===null&&view.osLight&&view.color===expected);
   const file=entry.label+'-'+theme+'.png';await page.screenshot({path:join(out,file)});
   receipt.pictures.push({file,...view,sha256:createHash('sha256').update(readFileSync(join(out,file))).digest('hex')});
  }
  check(entry.label+' no script errors',errors.length===0);await context.close();
 }
}finally{
 await browser?.close();if(hubNamed){hubNamed.closeAllConnections();await new Promise<void>(r=>hubNamed.close(r));}await hub?.close();if(named){named.closeAllConnections();await new Promise<void>(r=>named.close(r));}
 if(fm?.healthServer){fm.healthServer.closeAllConnections?.();await new Promise<void>(r=>fm.healthServer.close(r));}
 rmSync(home,{recursive:true,force:true});receipt.cleanup={browserClosed:browser?!browser.isConnected():true,listenersClosed:!named?.listening&&!hubNamed?.listening&&!fm?.healthServer?.listening,privateHomeRemoved:!existsSync(home)};
 writeFileSync(join(out,'receipt.json'),JSON.stringify(receipt,null,2)+'\n');
}
console.log(JSON.stringify({checks:receipt.checks.length,failed:receipt.checks.filter((x:any)=>!x.ok).length,pictures:receipt.pictures.length,cleanup:receipt.cleanup}));
