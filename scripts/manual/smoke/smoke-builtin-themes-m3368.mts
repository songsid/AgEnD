/** M3368: shipped Hub/Fleet pages, owned listeners, synthetic content, serial Linux headless captures. */
import { createServer } from 'node:https';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, copyFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
const repo=process.env.REPO!, out=resolve(process.env.OUT!), before=process.env.STAGE==='before';
if(!repo||!process.env.OUT||!process.env.PW_DIR||!process.env.CJK_FONT)throw Error('REPO/OUT/PW_DIR/CJK_FONT required');
if(process.platform!=='linux'||!process.env.CHROME?.startsWith('/home/')||process.env.CHROME.includes('/mnt/'))throw Error('Linux headless browser required');
mkdirSync(out,{recursive:true});
const owned=mkdtempSync(join(out,'.owned-')), fonts=join(owned,'fonts');mkdirSync(fonts);
copyFileSync(process.env.CJK_FONT,join(fonts,'NotoSansCJKtc-Regular.otf'));
const fontconfig=join(owned,'fonts.conf');writeFileSync(fontconfig,`<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "fonts.dtd"><fontconfig><include ignore_missing="yes">/etc/fonts/fonts.conf</include><dir>${fonts}</dir><cachedir>${owned}/font-cache</cachedir></fontconfig>`);
process.env.FONTCONFIG_FILE=fontconfig;
const {bootFixture}=await import(repo+'/scripts/manual/smoke-fixture/index.mts');
const checks:any[]=[], errors:string[]=[],shots:string[]=[];
const check=(name:string,ok:unknown,details?:unknown)=>{checks.push({name,ok:!!ok,...(details===undefined?{}:{details})});if(!ok)throw Error(name+' '+JSON.stringify(details));};
const shot=async(p:any,name:string)=>{await p.evaluate(()=>document.fonts.ready);await p.screenshot({path:join(out,name+'.png'),animations:'disabled'});shots.push(name+'.png');};
const noOverflow=async(p:any,name:string)=>{const x=await p.evaluate(()=>({width:innerWidth,body:document.documentElement.scrollWidth,unsafe:/-t\d+/.test(document.body.innerText)}));check(name,x.body<=x.width+1&&!x.unsafe,x);};
const openColours=async(p:any,select:string)=>{await p.locator(select).selectOption('other');await p.locator('dialog.theme-picker[open]').waitFor();};
const choose=async(p:any,id:string,mode:string,apply=true)=>{await p.locator(`.theme-colour input`).evaluateAll((nodes:any[],id:string)=>{const x=nodes.find(x=>x.value===id);x.closest('label').click();},id);await p.locator(`.theme-appearance input`).evaluateAll((nodes:any[],mode:string)=>{nodes.find(x=>x.value===mode).closest('label').click();},mode);if(apply)await p.locator('.theme-apply').click();};
let fx:any,hub:any,server:any,browser:any;
try{
 if(process.env.SURFACE!=='hub'){
 fx=await bootFixture({port:Number(process.env.HP||19892),classic:false,roster:[{name:'release-helper',displayName:'Release helper',backend:'codex',status:'running'},{name:'notes-helper',displayName:'Notes helper',backend:'codex'}]});
 for(const message of [{role:'user',sender:'Example person',text:'Please review this small change.'},{role:'agent',sender:'Release helper',text:'The example is ready.\n\n```ts\nconst message = "Hello, world";\nconsole.log(message);\n```\n\nPlease check the highlighted notice before sending.'}])fx.fm.emitSseEvent('message',{instance:'release-helper',...message,ts:new Date().toISOString()});
 for(const device of ['desk','phone'].filter(x=>!process.env.DEVICE||x===process.env.DEVICE)){
  const lang=device==='desk'?'en':'zh-TW',c={device,theme:'light',lang};
  if(process.env.VIEW!=='menu'){
  const a=await fx.page(c,{path:'/settings/look',prefs:{'nav.density':'detailed'}}),p=a.page;p.on('pageerror',(e:any)=>errors.push('fleet:'+String(e).slice(0,160)));
  try{
   await p.locator('#pref-theme').waitFor();await noOverflow(p,'fleet-'+device+'-look');
   if(process.env.VIEW==='look'){await shot(p,'fleet-'+device+'-look-colours-row');await p.locator('.s-theme-colours').click();await choose(p,'mint','system');await p.emulateMedia({colorScheme:'dark'});const dark=await p.evaluate(()=>getComputedStyle(document.documentElement).getPropertyValue('--bg').trim());await p.emulateMedia({colorScheme:'light'});const light=await p.evaluate(()=>getComputedStyle(document.documentElement).getPropertyValue('--bg').trim());check('fleet-'+device+'-system-keeps-palette',dark!==light&&await p.evaluate(()=>globalThis.AgendTheme.get()==='system'&&globalThis.AgendTheme.getPalette()==='mint'),{dark,light});await p.locator('.s-theme-colours').click();await choose(p,'','light');check('fleet-'+device+'-default-restores-neutral',await p.evaluate(()=>!document.documentElement.hasAttribute('data-palette')&&localStorage.getItem('agend_palette')===null));continue;}
   if(before){await shot(p,'fleet-'+device+'-before-look');continue;}
   await p.locator('.s-theme-colours').click();await p.locator('dialog.theme-picker[open]').waitFor();
   const rect=await p.locator('dialog.theme-picker').boundingBox();const view=p.viewportSize();check('fleet-'+device+'-centred',Math.abs(rect.x+rect.width/2-view.width/2)<3&&Math.abs(rect.y+rect.height/2-view.height/2)<3,{rect,view});
   const content=await p.locator('.theme-picker .dlg-box').boundingBox();check('fleet-'+device+'-content-height',rect.height<=content.height+2,{dialog:rect.height,content:content.height});
   check('fleet-'+device+'-five-radios',await p.locator('input[name=builtin-palette]').count()===5);
   await shot(p,'fleet-'+device+'-dialog-light');
   // Real radio keyboard movement, then Escape restores the original paint without storage writes.
   await p.locator('input[name=builtin-palette]').first().focus();await p.keyboard.press('ArrowRight');
   check('fleet-'+device+'-arrow',await p.evaluate(()=>globalThis.AgendTheme.getPalette())==='sky');
   await p.keyboard.press('Escape');check('fleet-'+device+'-escape',await p.evaluate(()=>globalThis.AgendTheme.getPalette())==='');
   for(const id of device==='desk'?['sky','meadow','violet','mint']:['mint'])for(const mode of ['light','dark']){
    await p.locator('.s-theme-colours').click();await choose(p,id,mode);
    await p.waitForTimeout(950);await p.goto(fx.base+'/ui/chat/release-helper');await p.locator('.p-chat .msg .md pre').waitFor();
    check(`fleet-${device}-${id}-${mode}-paint`,await p.evaluate(({id,mode})=>document.documentElement.dataset.palette===id&&globalThis.AgendTheme.get()===mode,{id,mode}));
    await p.locator('#msgIn').fill('Example reply ready to send.');fx.fm.getInstanceStatus=()=> 'running';fx.fm.emitSseEvent('activity',{instance:'release-helper',state:'stuck'});await p.locator('.av-dot.warn, .dot.warn').first().waitFor();check(`fleet-${device}-${id}-${mode}-send-ready`,await p.locator('#sendBtn').isEnabled());
    await noOverflow(p,`fleet-${device}-${id}-${mode}-fits`);await shot(p,`fleet-${device}-${id}-${mode}-chat`);
    await p.goto(fx.base+'/settings/look');await p.locator('.s-theme-colours').waitFor();
   }
   await p.locator('.s-theme-colours').click();await choose(p,'mint','dark',false);await shot(p,'fleet-'+device+'-dialog-dark');await p.locator('.theme-apply').click();
   await p.reload();await p.locator('#pref-theme').waitFor();check('fleet-'+device+'-reload',await p.evaluate(()=>globalThis.AgendTheme.getPalette())==='mint');
   await p.locator('#pref-theme input[value=light]').check();check('fleet-'+device+'-mode-keeps-colours',await p.evaluate(()=>globalThis.AgendTheme.getPalette())==='mint');
   if(device==='desk'){
    fx.seedTheme('release-helper',{v:1,colors:{light:{bg:'#f6f2ff',surface:'#f0eafa',text:'#20182e',text2:'#514563',accent:'#6847a5'}},bubble:{radius:8,border:'thin'}});
    await p.goto(fx.base+'/ui/chat/release-helper');await p.locator('.p-chat.th').waitFor();await shot(p,'fleet-agent-look-over-mint');
   }
  }finally{await a.ctx.close();}
  }
  // The Fleet quick control is the existing anonymous View reader's menu, not an invented admin control.
  const ctx=await fx.browser.newContext({viewport:device==='desk'?{width:1366,height:900}:{width:390,height:844},isMobile:device==='phone',hasTouch:device==='phone',locale:lang==='en'?'en-US':'zh-TW',colorScheme:'light'});
  try{
   await ctx.addInitScript({content:`localStorage.setItem('agend_lang',${JSON.stringify(lang)});`});const q=await ctx.newPage();await q.goto(fx.base+'/view/release-helper');await q.locator('.prefs-pop').waitFor({state:'attached'});
   if(!await q.locator('.prefs-pop > summary').isVisible())await q.locator('#sbOpen').click();await q.locator('.prefs-pop > summary').click();
   const values=await q.locator('#pref-theme option').evaluateAll((xs:any[])=>xs.map(x=>x.value));check('fleet-'+device+'-quick-options',JSON.stringify(values)===JSON.stringify(before?['system','light','dark']:['system','light','dark','other']),values);
   await shot(q,'fleet-'+device+(before?'-before-menu':'-menu-default'));
   if(!before){await openColours(q,'#pref-theme');await choose(q,'mint','dark');await q.locator('#pref-theme').selectOption('light');check('fleet-'+device+'-quick-mode-keeps-colours',await q.evaluate(()=>globalThis.AgendTheme.getPalette())==='mint');await q.evaluate(()=>Promise.all(document.getAnimations().filter(a=>a.effect?.getComputedTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{}))));const colours=await q.locator('.v-term-earlier,.v-id .btn').evaluateAll((xs:any[])=>xs.map(x=>({text:x.textContent.trim(),color:getComputedStyle(x).color,bg:getComputedStyle(x).backgroundColor,theme:document.documentElement.dataset.theme,palette:document.documentElement.dataset.palette})));checks.push({name:'fleet-'+device+'-view-control-colours',ok:true,details:colours});await shot(q,'fleet-'+device+'-menu-mint');}
  }finally{await ctx.close();}
 }
 await fx.close();fx=null;
 }
 if(process.env.SURFACE!=='fleet'){
 // Real Hub HTTPS / SQLite / synthetic directory. Hold the listener from allocation through startup.
 const {s3bRig}=await import(repo+'/tests/helpers/hub-s3b-rig.ts');const {provisionHubIdentity}=await import(repo+'/src/hub/tls.ts');const {listenLoopback}=await import(repo+'/scripts/manual/smoke-fixture/listen-loopback.mts');
 server=createServer();const port=await listenLoopback(server,{port:0}),origin=`https://hub.example.com:${port}`;const keys=join(owned,'keys');mkdirSync(keys,{mode:0o700});
 await provisionHubIdentity({home:keys,memberOrigin:origin});server.setSecureContext({key:readFileSync(join(keys,'hub/keys/tls-key.pem')),cert:readFileSync(join(keys,'hub/keys/tls-cert.pem'))});
 hub=await s3bRig({webOrigin:origin,realAudit:true});server.on('request',(req:any,res:any)=>{if(!hub.http.handle(req,res)){res.writeHead(404);res.end();}});
 const {HUB_ROOM_INVITATIONS_MIGRATION,createHubRoomInvitations}=await import(repo+'/src/hub/invitations.ts');HUB_ROOM_INVITATIONS_MIGRATION.up(hub.db);hub.httpDeps.roomInvitations=createHubRoomInvitations;await hub.restartHttp();
 const example=hub.addPerson('example-person','Example person');const signed=await hub.signIn('example-person'),admin=await hub.signIn('admin');const {personKeyString}=await import(repo+'/src/hub/identity.ts');const created=await hub.call(admin,'POST','/hub/v1/rooms',{name:'Example project',people:[personKeyString(example)]});check('owned-hub-room-created',created.status===200,created.status);const room=created.json.room.id;
 await hub.call(signed,'POST',`/hub/v1/rooms/${room}/messages`,{text:'The example is ready.\n\n```ts\nconst message = "Hello, world";\n```',mentions:[],idempotencyKey:randomUUID()});
 const pw=createRequire(join(resolve(process.env.PW_DIR),'package.json'))('playwright-core');
 browser=await pw.chromium.launch({executablePath:process.env.CHROME,headless:true,args:['--no-sandbox','--host-resolver-rules=MAP hub.example.com 127.0.0.1']});
 for(const device of ['desk','phone'].filter(x=>!process.env.DEVICE||x===process.env.DEVICE)){
  const lang=device==='desk'?'en':'zh-TW',ctx=await browser.newContext({viewport:device==='desk'?{width:1366,height:900}:{width:390,height:844},isMobile:device==='phone',hasTouch:device==='phone',locale:lang==='en'?'en-US':'zh-TW',colorScheme:'light',ignoreHTTPSErrors:true});
  try{
   await ctx.addInitScript({content:`if(!localStorage.getItem('m3368-initialized')){localStorage.setItem('agend_lang',${JSON.stringify(lang)});localStorage.setItem('agend_theme','light');localStorage.setItem('m3368-initialized','1');}`});
   const p=await ctx.newPage();p.on('pageerror',(e:any)=>errors.push('hub:'+String(e).slice(0,160)));await p.goto(origin+'/ui/hub');await p.fill('#hubLogin','example-person');await p.fill('#hubPassword','pw-example-person');await p.locator('.hub-signin button[type=submit]').click();await p.locator('.hub-session-row').first().waitFor({state:'attached'});
   await p.goto(`${origin}/ui/hub?room=${room}`);await p.locator('#msgIn').waitFor();
   if(!await p.locator('.hub-prefs > summary').isVisible()){if(!await p.locator('#sbOpen').count())await p.locator('.hub-back').click();await p.locator('#sbOpen').click();}await p.locator('.hub-prefs > summary').click();
   const values=await p.locator('#pref-theme option').evaluateAll((xs:any[])=>xs.map(x=>x.value));check('hub-'+device+'-quick-options',JSON.stringify(values)===JSON.stringify(before?['system','light','dark']:['system','light','dark','other']),values);await shot(p,'hub-'+device+(before?'-before-menu':'-menu-default'));
   if(!before){
    await openColours(p,'#pref-theme');await choose(p,'mint','light',false);await shot(p,'hub-'+device+'-dialog-light');await p.locator('.theme-apply').click();
    await p.locator('#pref-theme').selectOption('dark');check('hub-'+device+'-keep-palette',await p.evaluate(()=>globalThis.AgendTheme.getPalette())==='mint');await shot(p,'hub-'+device+'-menu-mint');
    await openColours(p,'#pref-theme');await choose(p,'violet','dark',false);await shot(p,'hub-'+device+'-dialog-dark');await p.locator('.theme-cancel').click();check('hub-'+device+'-cancel',await p.evaluate(()=>globalThis.AgendTheme.getPalette())==='mint');
    await p.goto(`${origin}/ui/hub?room=${room}`);await p.locator('#msgIn').waitFor();await noOverflow(p,'hub-'+device+'-chat-fits');check('hub-'+device+'-reload',await p.evaluate(()=>globalThis.AgendTheme.getPalette())==='mint');await shot(p,'hub-'+device+'-mint-dark-chat');
   }
  }finally{await ctx.close();}
 }
 }
 check('no-page-errors',errors.length===0,errors);
}finally{
 await fx?.close();await browser?.close();if(server)await new Promise<void>(r=>{server.closeAllConnections();server.close(()=>r());});await hub?.close();rmSync(owned,{recursive:true,force:true});writeFileSync(join(out,'result.json'),JSON.stringify({before,checks,errors,shots},null,2));
}
console.log(JSON.stringify({before,checks:checks.length,shots:shots.length}));
