/** Actual full-app stock panel/paint proof. Inert local data, no effects, Workers, accounts or fleet. */
import assert from "node:assert/strict";
import { inflateSync, deflateSync } from "node:zlib";
import { createServer } from "node:http";
import { once } from "node:events";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
const pw = createRequire(join(resolve(process.env.PW_DIR!), "package.json"))("playwright");
const out = resolve(process.env.OUT_DIR || ".artifacts/stock-native"); mkdirSync(out, { recursive: true });
const scratch = mkdtempSync(join(out, "private-")); mkdirSync(join(scratch, "home")); mkdirSync(join(scratch, "tmp"));
const crc = (data: Buffer) => { let n=0xffffffff;for(const b of data){n^=b;for(let j=0;j<8;j++)n=(n>>>1)^(n&1?0xedb88320:0);}return(n^0xffffffff)>>>0; };
const chunk = (type: string, data: Buffer) => {const name=Buffer.from(type),len=Buffer.alloc(4),sum=Buffer.alloc(4);len.writeUInt32BE(data.length);sum.writeUInt32BE(crc(Buffer.concat([name,data])));return Buffer.concat([len,name,data,sum]);};
const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(1);ihdr.writeUInt32BE(1,4);ihdr[8]=8;ihdr[9]=6;
const background=Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',ihdr),chunk('IDAT',deflateSync(Buffer.from([0,32,96,224,255]))),chunk('IEND',Buffer.alloc(0))]);
const actions: string[] = [];
const rows: any[] = [], ts = new Date().toISOString();
const message = { boot: "probe", id: 1, instance: "worker", sender: "worker", role: "agent", text: "A stock conversation with a protected reply control and [a link](https://example.invalid).\n\n```js\nconst n = 1;\n```\n\n```html\n<p>unterminated", ts, attachments:[{id:"d".repeat(32),name:"wide.csv",mime:"text/csv",size:600}], buttons: { id: "a".repeat(32), state: "open", labels: ["Approve", "Decline"] } };
function pixel(png,x,y){
 assert.equal(png.subarray(0,8).toString('hex'),'89504e470d0a1a0a');let at=8,width=0,height=0,channels=0;const parts=[];
 while(at<png.length){const size=png.readUInt32BE(at),type=png.subarray(at+4,at+8).toString(),data=png.subarray(at+8,at+8+size);at+=size+12;
  if(type==='IHDR'){width=data.readUInt32BE(0);height=data.readUInt32BE(4);assert.equal(data[8],8);channels=data[9]===2?3:data[9]===6?4:0;assert.ok(channels);assert.equal(data[12],0);assert.ok(width*height<2e6);}
  if(type==='IDAT')parts.push(data);if(type==='IEND')break;
 }
 assert.ok(x>=0&&x<width&&y>=0&&y<height);const raw=inflateSync(Buffer.concat(parts)),stride=width*channels,rows=Buffer.alloc(stride*height);assert.equal(raw.length,(stride+1)*height);
 const paeth=(a,b,c)=>{const p=a+b-c,A=Math.abs(p-a),B=Math.abs(p-b),C=Math.abs(p-c);return A<=B&&A<=C?a:B<=C?b:c;};
 for(let row=0;row<height;row++){const filter=raw[row*(stride+1)];assert.ok(filter<=4);for(let i=0;i<stride;i++){const left=i>=channels?rows[row*stride+i-channels]:0,up=row?rows[(row-1)*stride+i]:0,corner=row&&i>=channels?rows[(row-1)*stride+i-channels]:0;rows[row*stride+i]=(raw[row*(stride+1)+i+1]+(filter===0?0:filter===1?left:filter===2?up:filter===3?Math.floor((left+up)/2):paeth(left,up,corner)))&255;}}
 return [...rows.subarray((y*width+x)*channels,(y*width+x)*channels+3)];
}

const profiles = [{instance_name:"worker",display_name:"Worker",backend:"codex",status:"running",description:"Inert profile",card_v:"stock-card"}];
const config = {defaults:{backend:"codex"},instances:{worker:{working_directory:"/inert",description:"Inert agent"}},channels:[]};
const server=createServer(async(req,res)=>{
 const url=new URL(req.url||"/","http://local"),path=url.pathname;
 if(/^\/assets\/[a-z0-9._-]+$/.test(path)||/^\/ui\/js\/[a-z0-9_-]+\.js$/.test(path)){
  try{res.setHeader("Content-Type",path.endsWith(".css")?"text/css":"text/javascript");res.end(readFileSync(join("src/ui",path.startsWith("/assets/")?"shared":"",path.split("/").at(-1)!)))}catch{res.statusCode=404;res.end()}return;
 }
 if(path!=="/"){
  if(req.method!=="GET")actions.push(req.method+" "+path);
  if(path==="/api/pane/worker"){res.setHeader("Content-Type","text/plain");res.end("Inert terminal output\n$ _");return}
  res.setHeader("Content-Type","application/json");
  let answer:any={ok:true};
  if(path==="/ui/owner-css/state")answer={active:null,text:"",assets:[],versions:[],limits:{maxAssets:16}};
  else if(path==="/api/profiles")answer=profiles;
  else if(path==="/api/fleet")answer={version:"2.3.0-alpha.1",instances:[{name:"worker",backend:"codex",status:"running",state:"idle"}]};
  else if(path==="/api/card/worker")answer={tagline:{text:"Stock identity card",by:"agent"}};
  else if(path==="/api/settings/schema")answer={impacts:{"defaults.model":"now"},provider_secrets:false,order:["now","instance","fleet"]};
  else if(path==="/api/settings/fleet/raw"||path==="/ui/config")answer=config;
  else if(path==="/api/settings/classic")answer={defaults:{},channels:{}};
  else if(path==="/api/settings/connections"||path==="/auth/sessions")answer=[];
  else if(path==="/ui/steps")answer={enabled:true,backend:"codex",supported:true,key:"inert",steps:[],events:[],after:null,before:null,ev:0};
  else if(path==="/ui/tasks")answer={tasks:[{id:"task",title:"Inert task",status:"open",priority:"normal"}]};
  else if(path==="/ui/schedules")answer={schedules:[]};
  else if(path==="/ui/teams")answer={teams:[]};
  else if(path==="/ui/instance/worker")answer={instance:{name:"worker"},runtime:{},recent:[]};
  else if(path==="/ui/history")answer={messages:[]};
  else if(path==="/auth/session")answer={label:"Scratch browser",expiresAt:Date.now()+60000,idleMs:60000};
  res.end(JSON.stringify(answer));return;
 }
 res.setHeader("Content-Type","text/html");res.setHeader("Content-Security-Policy","default-src 'none'; script-src 'self' 'nonce-stock'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'");
 res.end(`<!doctype html><html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><link rel=stylesheet href=/assets/tokens.css><link rel=stylesheet href=/assets/app.css><body data-mode=full><div id=app class=app-root></div><script nonce=stock type=module>
import{createOwnerEffectRegions}from'/assets/effect-owner-regions.js';import{html,render}from'/assets/app-html.js';import{Shell,showDialog,closeDialog}from'/assets/app-shell.js';import{appStore}from'/assets/app-store.js';import{navStore}from'/assets/app-nav.js';import{stockEffectTrust}from'/assets/effect-stock-trust.js';import{createEffectGeometry}from'/assets/effect-geometry.js';import{FleetPanel}from'/ui/js/panel-fleet.js';import{NeedsPanel}from'/ui/js/panel-needs.js';import{SettingsPanel}from'/ui/js/panel-settings.js';import{LogPanel}from'/ui/js/panel-log.js';import{DetailsPanel}from'/ui/js/panel-details.js';import{ViewPanel,viewStore}from'/assets/panel-view.js';import{Dialog}from'/assets/ui-dialog.js';
localStorage.setItem('agend_tour_done','1');
const instances=[{name:'worker',backend:'codex',state:'idle',status:'running',card_v:'stock-card'}];
appStore.set({ready:true,connection:'open',instances,exec:{worker:'idle'},awaiting:{},connections:1,streamOn:()=>()=>{},needs:[{id:'prompt:1',type:'prompt',instance:'worker',reason:'permission',detail:'Inert permission request',nonce:'n',since:Date.now(),actions:[{id:'yes',label:'Allow'}]}]});
viewStore.set({loaded:true,error:null,roster:${JSON.stringify(profiles)}});
const panels=new Map([['fleet',FleetPanel],['needs',NeedsPanel],['settings',SettingsPanel],['view',ViewPanel],['log',LogPanel],['details',DetailsPanel]].map(([k,Component])=>[k,{Component}]));let seq=0;
const route=(kind,sub='',state='ready')=>{removePaint();appStore.set({ready:state!=='loading',pendingChanges:state==='pending'?[{id:'p',state:'pending',label:'Inert confirmation',expiresAt:Date.now()+60000}]:[]});viewStore.set({loaded:state!=='loading',error:state==='error'?'Inert error':null,roster:['loading','error','empty'].includes(state)?[]:${JSON.stringify(profiles)}});navStore.set({route:{panel:kind,tab:sub||'tasks',section:sub||'agents',instance:state==='notfound'?'missing':'worker'},seq:++seq})};
let root=null,geometry=null,binding=null;const removePaint=()=>{geometry?.dispose();geometry=null;root?.remove();root=null;binding=null};
const paint=(layer='front')=>{removePaint();root=document.createElement('div');root.className='agend-effect-layer';document.body.append(root);const proof=stockEffectTrust(window,{frameRoot:root,ownerCss:'off'});if(!proof.ok||layer==='front'&&!proof.agentFront){removePaint();return false}const canvas=document.createElement('canvas');canvas.className='agend-effect-frame';canvas.width=innerWidth;canvas.height=innerHeight;const c=canvas.getContext('2d');c.fillStyle='#ff1414';c.fillRect(0,0,canvas.width,canvas.height);root.append(canvas);geometry=createEffectGeometry({window});binding=geometry.bind(canvas,{layer,by:'agent'});if(!binding.ok||!binding.sync({x:0,y:0,width:innerWidth,height:innerHeight},proof)){removePaint();return false}return true};
route('fleet');render(html\`<\${Shell} panels=\${panels} onNewInstance=\${()=>{}} />\`,document.querySelector('#app'));
const ownerRegions=createOwnerEffectRegions({window,current:()=>true});window.stock={ownerOff:()=>ownerRegions.dispose(),ownerRefs:()=>{const proof=stockEffectTrust(window,{frameRoot:ownerRegions.root,ownerCss:'off'}),get=(slot,box)=>{const el=ownerRegions.resolve(slot,box,proof);if(!el)return null;const r=el.getBoundingClientRect();return{rect:[r.x,r.y,r.width,r.height],hidden:getComputedStyle(el).visibility==='hidden',cls:el.className}};return{header:get('fx.header'),sidebar:get('fx.sidebar'),page:get('fx.page'),box:get('fx.box',{anchor:'top-left',width:100,height:80,offset:8})}},route,snapshot:()=>stockEffectTrust(window,{ownerCss:'off'}),paint,removePaint,dialog:()=>showDialog(Dialog,{title:'Inert host dialog',children:'Protected dialog'}),closeDialog,viewStore,appStore};
</script>`);
});
let browser:any;
try{
 server.listen(0,"127.0.0.1");await once(server,"listening");const port=(server.address() as any).port;
 for(const engine of(process.env.PROBE_ENGINES||"chromium,firefox,webkit").split(",")){
  browser=await pw[engine].launch({headless:true,env:{HOME:join(scratch,"home"),TMPDIR:join(scratch,"tmp"),PATH:"/usr/bin:/bin",LANG:"C.UTF-8"}});
  for(const width of[1366,390]){
   const context=await browser.newContext({viewport:{width,height:900}}),page=await context.newPage(),errors:string[]=[],outside:string[]=[];
   page.on("pageerror",(e:any)=>{errors.push(e.message);console.error(e.message)});await page.route("**/*",(r:any)=>{const u=new URL(r.request().url());if(u.hostname==="127.0.0.1"&&u.port===String(port))return r.continue();outside.push(u.origin);return r.abort()});
   const cases:any[]=[];
   try{
    await page.goto('http://127.0.0.1:'+port+'/');await page.locator('.p-fleet .panel-body').waitFor();
    const routes=[...['tasks','schedules','teams','org','cache','config'].map(sub=>['fleet',sub,'ready']),...['device','appearance','agents','bots','classic','general','web','advanced'].map(sub=>['settings',sub,'ready']),['needs','','ready'],['view','','ready'],['view','','notfound'],['view','','loading'],['view','','error'],['view','','empty'],['log','','ready'],['log','','loading'],['log','','notfound'],['details','','ready'],['details','','loading'],['details','','notfound'],['settings','general','pending']];
    const painted=new Set();
    for(const [kind,sub,state]of routes){
     await page.evaluate(([k,s,v])=>(window as any).stock.route(k,s,v),[kind,sub,state]);await page.locator('.main > .p-'+kind).waitFor();await page.waitForTimeout(80);
     if(kind==='view'&&['loading','error','empty'].includes(state)){await page.evaluate(state=>(window as any).stock.viewStore.set({loaded:state!=='loading',error:state==='error'?'Inert error':null,roster:[]}),state);await page.locator('.p-view > .panel-body').waitFor()}
     if(kind==='view'&&state==='ready'){await page.locator('.v-card').waitFor();await page.locator('.v-card button[aria-expanded]').click();await page.locator('.v-id').waitFor()}
     if(kind==='log'&&state==='ready')await page.locator('.log-bar').waitFor();
     if(kind==='settings'&&sub==='general'&&state==='ready'){
      await page.locator('#g-model').fill('inert-model');await page.locator('.s-general button[type=button]').last().click();await page.locator('.s-pending').waitFor();await page.waitForFunction(()=>!document.querySelector('.toast'));
      // No write is sent: staging is entirely local. The real sticky Apply producer must be protected.
     }
     await page.evaluate(()=>{document.activeElement?.blur()});await page.waitForTimeout(30);
     const snapshot=await page.evaluate(()=>(window as any).stock.snapshot());
     const diag=await page.evaluate(()=>[...document.querySelectorAll('.main>.panel,.main>.panel>*')].map(el=>({cls:el.className,marker:el.getAttribute('data-trust'),producer:el.getAttribute('data-effect-panel'),position:getComputedStyle(el).position,z:getComputedStyle(el).zIndex,mask:getComputedStyle(el).maskImage,filter:getComputedStyle(el).filter,opacity:getComputedStyle(el).opacity})));
     assert.equal(snapshot.ok,true,JSON.stringify({kind,sub,state,snapshot,diag}));
     const refs=await page.evaluate(()=>(window as any).stock.ownerRefs());
     assert.ok(refs.header?.cls.includes('panel-head'),JSON.stringify({kind,sub,state,refs}));assert.equal(refs.page?.hidden,true);assert.deepEqual(refs.page.rect,[0,0,width,900]);assert.equal(refs.box?.hidden,true);assert.deepEqual(refs.box.rect,[8,8,100,80]);assert.equal(!!refs.sidebar,width>=900);

     const hasPending=state==='pending';assert.equal(snapshot.front,!hasPending||kind==='settings',JSON.stringify({kind,sub,state,snapshot}));
     const selected=kind==='settings'&&sub==='general'||kind==='view'&&state==='ready'||kind==='log'&&state==='ready'||!painted.has(kind);
     if(selected&&snapshot.front){
      await page.mouse.move(0,0);await page.waitForTimeout(250);
      const baseline=await page.screenshot({caret:'initial'}),points=await page.evaluate(()=>[...document.querySelectorAll('.main>.panel>.panel-head button,.main>.panel>.seg a,.main>.panel>.panel-body button,.main>.panel>.v-card button,.main>.panel>.log-bar button,.main>.panel>.s-pending button,.main>.panel>.v-id')].filter(el=>{const r=el.getBoundingClientRect();return r.width>0&&r.height>0&&r.x>=0&&r.y>=0&&r.right<=innerWidth&&r.bottom<=innerHeight}).slice(0,16).map(el=>{const r=el.getBoundingClientRect();return{x:Math.floor(r.x+r.width/2),y:Math.floor(r.y+r.height/2),cls:el.className}}));
      assert.ok(points.length>0);assert.equal(await page.evaluate(()=>(window as any).stock.paint()),true);const front=await page.screenshot({caret:'initial'});for(const p of points)assert.deepEqual(pixel(front,p.x,p.y),pixel(baseline,p.x,p.y),'protected '+kind+'/'+sub+' '+p.cls);await page.evaluate(()=>(window as any).stock.removePaint());painted.add(kind);
     }
     const controls=[];
     for(const change of['marker','negative','transform','unknown-child']){
      await page.evaluate(change=>{const panel=document.querySelector('.main>.panel'),target=panel.querySelector(':scope>.panel-body,:scope>.v-term'),sheet=document.querySelector('link[href="/assets/app.css"]').sheet;(window as any).probeTarget=target;if(change==='marker')target.removeAttribute('data-trust');else if(change==='unknown-child'){const el=document.createElement('button');el.className='unknown-stock';panel.append(el)}else{const i=sheet.insertRule('.main>.panel>.'+target.classList[0]+'{'+(change==='negative'?'z-index:-1':'transform:translateX(1px)')+'!important}',sheet.cssRules.length);(window as any).probeRule=sheet.cssRules[i]}},change);
      assert.equal(await page.evaluate(()=>(window as any).stock.snapshot().ok),false,kind+'/'+change);const refused=await page.evaluate(()=>(window as any).stock.ownerRefs());assert.ok(Object.values(refused).every(x=>x===null),kind+'/'+change+' owner references');assert.equal(await page.evaluate(()=>(window as any).stock.paint()),false);assert.equal(await page.locator('canvas').count(),0);
      await page.evaluate(change=>{if(change==='marker')(window as any).probeTarget.setAttribute('data-trust','panel-content');else if(change==='unknown-child')document.querySelector('.unknown-stock').remove();else{const s=document.querySelector('link[href="/assets/app.css"]').sheet;s.deleteRule([...s.cssRules].indexOf((window as any).probeRule))}},change);controls.push(change);
     }
     assert.equal(await page.evaluate(()=>(window as any).stock.snapshot().ok),true);cases.push({kind,sub,state,protected:snapshot.rects.length,front:snapshot.front,controls});
    }
    await page.evaluate(()=>(window as any).stock.route('unknown'));await page.locator('.main>.panel:not([data-effect-panel])').waitFor();assert.equal(await page.evaluate(()=>(window as any).stock.snapshot().ok),false);await page.evaluate(()=>(window as any).stock.route('details'));await page.locator('.p-details').waitFor();
    await page.evaluate(()=>(window as any).stock.dialog());await page.locator('dialog[open]').waitFor();assert.equal(await page.evaluate(()=>(window as any).stock.snapshot().front),false);await page.evaluate(()=>(window as any).stock.closeDialog());
    assert.equal(await page.locator('iframe,canvas').count(),0);assert.equal(page.workers().length,0);await page.evaluate(()=>(window as any).stock.ownerOff());assert.equal(await page.locator('.agend-owner-effect-target').count(),0);assert.deepEqual(errors,[]);assert.deepEqual(outside,[]);assert.deepEqual(actions,[]);
    rows.push({engine,version:browser.version(),width,status:'pass',cases,painted:[...painted],noEffectRuntime:true,globalOwnerReferences:true,ownerReferenceRefusals:true,ownerReferenceCleanup:true});console.log('PASS',engine,width,cases.length);
   }catch(e){rows.push({engine,width,status:'failed',error:e.message,stack:e.stack,errors,cases});console.log('FAIL',engine,width,e.stack)}finally{await context.close()}
  }await browser.close();browser=null;
 }
}finally{await browser?.close();await new Promise<void>(r=>server.close(()=>r()));rmSync(scratch,{recursive:true,force:true});writeFileSync(join(out,'receipt.json'),JSON.stringify({scratchRemoved:true,noFleet:true,noEffectRuntime:true,rows},null,2))}
assert.ok(rows.length>0&&rows.every(r=>r.status==='pass'),JSON.stringify(rows.filter(r=>r.status!=='pass')));
