/** Actual Shell+ChatPanel owner region references. No product mount, author code, fleet/account/Worker/frame. */
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

const server = createServer((req, res) => {
  const url = new URL(req.url || "/", "http://localhost"), path = url.pathname;
  if (/^\/assets\/[a-z0-9._-]+$/.test(path) || /^\/ui\/js\/[a-z0-9_-]+\.js$/.test(path)) {
    try { res.setHeader("Content-Type", path.endsWith(".css") ? "text/css" : "text/javascript"); res.end(readFileSync(join("src/ui", path.startsWith("/assets/") ? "shared" : "", path.split("/").at(-1)!))); }
    catch { res.statusCode = 404; res.end(); } return;
  }
  if(path === "/ui/file/"+"d".repeat(32)){res.setHeader("Content-Type","text/csv");res.end(Array.from({length:51},(_,i)=>"column"+i).join(","));return;}
  if(path.startsWith("/ui/img/theme/")){res.setHeader("Content-Type","image/png");res.end(background);return;}
  if (path !== "/") {
    res.setHeader("Content-Type", "application/json");
    if(req.method === "POST")actions.push(path);
    const answer = path === "/api/card/worker" ? {tagline:{text:"Stock identity card",by:"agent"}} : path === "/ui/reply-button" ? {answered:true} : path === "/ui/history" ? { messages: [message] } : path === "/auth/session" ? { label: "Scratch browser", expiresAt: Date.now() + 60000, idleMs: 60000 } : path === "/auth/sessions" ? { sessions: [] } : { ok: true, instances: [], themes: {}, records: [], entries: [] };
    res.end(JSON.stringify(answer)); return;
  }
  res.setHeader("Content-Type", "text/html");
  res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self' 'nonce-stock-probe'; style-src 'self'; connect-src 'self'; img-src 'self'; font-src 'self'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'");
  res.end(`<!doctype html><html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><link rel=stylesheet href=/assets/tokens.css><link rel=stylesheet href=/assets/app.css><body data-mode=full><div id=app class=app-root></div><script type=module nonce=stock-probe>
import{createOwnerEffectRegions}from'/assets/effect-owner-regions.js';import{html,render}from'/assets/app-html.js';import{Shell,openDrawer,closeDrawer,showDialog,closeDialog}from'/assets/app-shell.js';import{appStore}from'/assets/app-store.js';import{navStore}from'/assets/app-nav.js';import{ChatPanel,boot}from'/ui/js/panel-chat.js';import{stockEffectTrust}from'/assets/effect-stock-trust.js';import{createEffectGeometry}from'/assets/effect-geometry.js';import{Dialog}from'/assets/ui-dialog.js';import{setLang}from'/assets/app-i18n.js';import{themesStore}from'/assets/app-themes.js';import{toast}from'/assets/ui-toast.js';import{ownerCssTrial}from'/assets/owner-css.js';import{openPanel,closePanel}from'/ui/js/preview-panel.js';import{startTour,endTour as stopTour}from'/ui/js/chat-tour.js';
const q=new URL(location.href).searchParams;setLang(q.get('lang')||'en',{store:false});document.documentElement.dataset.theme=q.get('dark')==='1'?'dark':'light';
const data={ready:true,connection:'open',instances:[{name:'worker',backend:'codex',state:'idle',model:'probe',card_v:'native-card'}],exec:{worker:'idle'},awaiting:{worker:null},connections:1};appStore.set(data);navStore.set({route:{panel:'chat',instance:'worker'},seq:1});
const store=boot({stream:{on(){return()=>{}}},boot:null,deps:{announce(){},toast(){}}});
store.onPrompt({nonce:'probe-permission',instance:'worker',text:'Host-owned permission question',actions:[{id:'yes',label:'Allow'},{id:'no',label:'Deny'}],expiresAt:Date.now()+600000});
render(html\`<\${Shell} panels=\${new Map([['chat',{Component:ChatPanel}]])} onNewInstance=\${()=>{}} />\`,document.querySelector('#app'));
let root=null,geometry=null,binding=null;
const removePaint=()=>{geometry?.dispose();geometry=null;binding=null;root?.remove();root=null;};
const paint=(layer='behind',by='agent')=>{removePaint();root=document.createElement('div');root.className='agend-effect-layer';document.body.append(root);const snapshot=stockEffectTrust(window,{frameRoot:root,ownerCss:'off'});if(!snapshot.ok||layer==='front'&&!snapshot.front||layer==='front'&&by!=='human'&&!snapshot.agentFront){removePaint();return false;}const canvas=document.createElement('canvas');canvas.className='agend-effect-frame';canvas.width=innerWidth;canvas.height=innerHeight;const c=canvas.getContext('2d');c.fillStyle='#ff1414';c.fillRect(0,0,canvas.width,canvas.height);root.append(canvas);geometry=createEffectGeometry({window});if(!geometry.ok){removePaint();return false;}binding=geometry.bind(canvas,{layer,by});if(!binding.ok||!binding.sync({x:0,y:0,width:innerWidth,height:innerHeight},snapshot)){removePaint();return false;}return true;};
let ownerRegions=null;window.regions={start:()=>{ownerRegions=createOwnerEffectRegions({window,current:()=>window.regionLive!==false});return ownerRegions.ok},resolve:(slot,box)=>{const proof=stockEffectTrust(window,{frameRoot:ownerRegions.root,ownerCss:'off'});const el=ownerRegions.resolve(slot,box,proof);return el?{rect:el.getBoundingClientRect().toJSON(),tag:el.tagName,hidden:getComputedStyle(el).visibility==='hidden',id:el.id,cls:el.className}:null},dispose:()=>ownerRegions.dispose()};window.stock={longThread:()=>{for(let i=0;i<6;i++)store.ingest({boot:'probe',id:50+i,instance:'worker',role:'agent',sender:'worker',text:('A stock paragraph '+i+'\\n\\n').repeat(20),ts:new Date().toISOString()});},theme:()=>themesStore.set({shown:true,themes:{worker:{background:{image:'c'.repeat(32),fit:'cover',opacity:0.6}}},widgets:{worker:{chat_header:{spec:{v:1,title:'Host widget',items:[{type:'stat',label:'Count',key:'count'}]},data:{count:7},by:'agent'}}}}),paint,removePaint,hide:()=>binding?.hide(),snapshot:(ownerCss='off')=>stockEffectTrust(window,{ownerCss}),openDrawer,closeDrawer,closeDialog,dialog:()=>showDialog(Dialog,{title:'Host dialog',children:'A protected host dialog'}),toast:()=>toast('Host notification'),keep:()=>ownerCssTrial.set({id:'a'.repeat(32),sha:'b'.repeat(32),deadline:performance.now()+15000}),revert:()=>ownerCssTrial.set(()=>null),preview:()=>openPanel({key:'probe',instance:'worker',msgKey:'probe:1',n:0,code:'<p>Inert code only</p>',sender:'worker',ts:'probe'},{run:false}),closePanel,tour:()=>startTour(),stopTour,store};
</script>`);
});
let browser: any;
try {
 server.listen(0,"127.0.0.1");await once(server,"listening");const port=(server.address() as any).port;
 for(const engine of(process.env.PROBE_ENGINES||"chromium,firefox,webkit").split(",")){
  browser=await pw[engine].launch({headless:true,env:{HOME:join(scratch,"home"),TMPDIR:join(scratch,"tmp"),PATH:"/usr/bin:/bin",LANG:"C.UTF-8"}});
  for(const width of[1366,390]){
   const context=await browser.newContext({viewport:{width,height:900}}),page=await context.newPage(),errors=[],outside=[];
   page.on("pageerror",e=>errors.push(e.message));await page.route("**/*",r=>{const u=new URL(r.request().url());if(u.hostname==="127.0.0.1"&&u.port===String(port))return r.continue();outside.push(u.origin);return r.abort()});
   try{
    await page.goto('http://127.0.0.1:'+port+'/?lang='+(width===390?'zh-TW':'en'));await page.locator('.composer').waitFor();await page.locator('.rb-row').waitFor();
    await page.evaluate(()=>{document.activeElement?.blur()});assert.equal(await page.evaluate(()=>stock.snapshot().ok),true);const baseline=await page.screenshot({caret:'initial'});
    const points=await page.evaluate(()=>['.composer-box','.panel-head'].map(q=>{const r=document.querySelector(q).getBoundingClientRect();return{x:Math.floor(r.x+12),y:Math.floor(r.y+r.height/2)}}));
    assert.equal(await page.evaluate(()=>regions.start()),true);
    const whole=await page.evaluate(()=>regions.resolve('fx.page'));assert.equal(whole.hidden,true);assert.deepEqual([whole.rect.x,whole.rect.y,whole.rect.width,whole.rect.height],[0,0,width,900]);
    const header=await page.evaluate(()=>regions.resolve('fx.header'));assert.equal(header.cls.includes('panel-head'),true);assert.ok(header.rect.width>0);
    const side=await page.evaluate(()=>regions.resolve('fx.sidebar'));assert.equal(!!side,width>=900);if(side)assert.ok(side.rect.width>=200);
    const boxes=[];
    for(const anchor of['top-left','top-right','bottom-left','bottom-right','center']){
     const b=await page.evaluate(anchor=>regions.resolve('fx.box',{anchor,width:480,height:480,offset:16}),anchor);assert.equal(b.hidden,true);const w=Math.min(480,width-(anchor==='center'?0:32)),h=480;
     const x=anchor==='center'?Math.floor((width-w)/2):anchor.endsWith('right')?width-16-w:16,y=anchor==='center'?210:anchor.startsWith('bottom')?404:16;
     assert.deepEqual([b.rect.x,b.rect.y,b.rect.width,b.rect.height],[x,y,w,h]);boxes.push({anchor,rect:b.rect});
    }
    assert.equal(await page.locator('.agend-owner-effect-target').count(),2);
    // Even hostile decorative paint on a host reference stays invisible: these are never effect surfaces.
    const at=await page.evaluate(()=>{const s=document.querySelector('link[href="/assets/app.css"]').sheet;return s.insertRule('body .agend-owner-effect-target{background:#ff1414!important}',s.cssRules.length)});
    const hidden=await page.screenshot({caret:'initial'});for(const p of points)assert.deepEqual(pixel(hidden,p.x,p.y),pixel(baseline,p.x,p.y));await page.evaluate(at=>document.querySelector('link[href="/assets/app.css"]').sheet.deleteRule(at),at);
    const bad=await page.evaluate(()=>{const s=document.querySelector('link[href="/assets/app.css"]').sheet;const at=s.insertRule('body .agend-owner-effect-target{visibility:visible!important}',s.cssRules.length);window.regionHostRule=s.cssRules[at];return at});
    assert.equal(await page.evaluate(()=>regions.resolve('fx.page')),null);assert.equal(await page.evaluate(()=>regions.resolve('fx.box',{anchor:'center',width:100,height:100,offset:0})),null);assert.equal(await page.locator('.agend-owner-effect-target').count(),0);
    await page.evaluate(()=>{const s=document.querySelector('link[href="/assets/app.css"]').sheet,at=[...s.cssRules].indexOf(window.regionHostRule);if(at<0)throw Error('host control rule lost');s.deleteRule(at)});
    assert.equal((await page.evaluate(()=>regions.resolve('fx.page'))).hidden,true);
    await page.evaluate(()=>{window.regionLive=false});assert.equal(await page.evaluate(()=>regions.resolve('fx.page')),null);
    await page.evaluate(()=>regions.dispose());assert.equal(await page.locator('.agend-owner-effect-target').count(),0);assert.equal(await page.locator('.composer').count(),1);
    assert.equal(await page.locator('iframe,canvas').count(),0);assert.equal(page.workers().length,0);assert.deepEqual(errors,[]);assert.deepEqual(outside,[]);
    rows.push({engine,version:browser.version(),width,status:'pass',actualChatShell:true,viewport:whole.rect,boxes,hiddenReferencePaint:true,strongVisibilityRefused:true,staleRefused:true,cleanup:true,noWorkerOrFrame:true});console.log('PASS',engine,width);
   }catch(e){rows.push({engine,width,status:'failed',error:e.message,stack:e.stack,errors,outside});console.log('FAIL',engine,width,e.stack)}finally{await context.close()}
  }await browser.close();browser=null;
 }
}finally{await browser?.close();await new Promise<void>(r=>server.close(()=>r()));rmSync(scratch,{recursive:true,force:true});writeFileSync(join(out,'receipt.json'),JSON.stringify({rows,passed:rows.filter(r=>r.status==='pass').length,failed:rows.filter(r=>r.status!=='pass').length,unmountedPrimitive:true},null,2))}
if(rows.some(r=>r.status!=='pass'))process.exitCode=1;
