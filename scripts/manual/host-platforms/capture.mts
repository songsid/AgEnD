/** M3535: real product pages with recorded kernel inputs and controlled CPU/storage DTOs.
 * No collector, native OS command, live Fleet/CLI/account/model, or generated history.
 */
import {mkdirSync,readFileSync,existsSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';import {createHash} from 'node:crypto';
import {bootFixture,matrix,caseName} from '../smoke-fixture/index.mts';
import {disabledHostHealth,type MonitoringPlatform} from '../../../src/host-monitoring.js';
import {interpretMemory as darwin,parseDarwinCompression} from '../../../src/host-monitoring/darwin/interpretation.js';
import {interpretMemory as linux} from '../../../src/host-monitoring/linux/interpretation.js';
import {interpretMemory as wsl} from '../../../src/host-monitoring/wsl/interpretation.js';
import {parseDarwinAvailable,parseDarwinSwap} from '../../../src/darwin-memory.js';
import {readHostMemory} from '../../../src/host-memory.js';import {MemoryPressure} from '../../../src/memory-pressure.js';
// Fixed valid opaque aliases below are synthetic, never machine disk identities.
import {hostAlertSettingsPath} from '../../../src/host-monitoring-alert-settings.js';
const out=process.env.OUT;if(!out)throw Error('OUT required');mkdirSync(out,{recursive:true});
const fixture=(name:string)=>readFileSync(new URL('../../../tests/fixtures/'+name,import.meta.url),'utf8'),GiB=1024**3;
const fx=await bootFixture({port:0,classic:false,host:true,roster:[{name:'sample-helper',displayName:'Sample helper',backend:'claude-code',status:'stopped'}]});
console.log('Owned fixture ready');
let platform:MonitoringPlatform='darwin';
const snapshot=()=>{
 const at=Date.now(),s=disabledHostHealth();s.enabled=true;s.state='sampling';s.platformSupported=true;s.platform=platform;s.history={state:'recording'} as any;
 s.cpu={status:'ok',sampledAt:at,attemptedAt:at,value:{usedPercent:25,logicalCpus:8,loadAverage:[0.8,0.7,0.6]}};
 let reading;
 if(platform==='darwin'){
  const vm=fixture('darwin-memory/vm-stat-16k.txt');
  reading=darwin({level:'critical',memory:{totalBytes:32*GiB,availableBytes:parseDarwinAvailable(vm,32*GiB),availableKind:'estimate',...parseDarwinSwap(fixture('darwin-memory/swap-16k.txt')),...parseDarwinCompression(vm,32*GiB),darwinPressureLevel:2},sampledAt:at,recovering:false,samples:1,trend:null});
 }else{
  const memory=readHostMemory({platform:'linux',includePressure:true,psi:()=>fixture('linux-memory-pressure/wsl2-low-psi.txt'),meminfo:()=>`MemTotal: ${32098*1024} kB\nMemAvailable: ${17351*1024} kB\nSwapTotal: ${8192*1024} kB\nSwapFree: ${330*1024} kB\n`});
  const pressure=new MemoryPressure({platform:'linux',read:()=>memory,now:()=>at}).sample();reading=(platform==='linux'?linux:wsl)(pressure);
 }
 s.memory={status:'ok',attemptedAt:at,sampledAt:at,...reading};
 s.disks={status:'ok',sampledAt:at,attemptedAt:at,value:{backingDrive:platform==='wsl'?'identified':'not-applicable',volumes:[{id:'0000000000000001',roles:['root','state'],totalBytes:200*GiB,availableBytes:95*GiB,usedPercent:52.5,sampledAt:at,...(platform==='darwin'?{shared:true}:{})},...(platform==='wsl'?[{id:'0000000000000002',roles:['wsl-backing'] as any,drive:'E',totalBytes:500*GiB,availableBytes:200*GiB,usedPercent:60,sampledAt:at}]:[])]}};
 s.alerts={state:'ready',needsYou:true,general:false,active:[],resolved:[],pending:0};return s;
};
fx.fm.hostMonitoringPlatform=()=>platform;fx.fm.hostMonitoringAvailable=()=>true;fx.fm.hostHealthSnapshot=snapshot;
fx.fm.hostHistoryQuery=async(_range:string,ids:string[])=>({ok:true,value:{start:Date.now()-3600000,end:Date.now(),step:60000,series:ids.map(id=>({id,buckets:[]})),stats:{bytes:0,rows:0,maxBytes:64*1024**2}}});
fx.fm.notifyFleetError=()=>{throw Error('No delivery in platform fixture');};
const checks:any[]=[];const sidecar=hostAlertSettingsPath(fx.fm.dataDir);
try{
 if(existsSync(sidecar))throw Error('Fresh defaults must have no saved alert file');
 for(const p of ['darwin','linux','wsl']as const){platform=p;
  for(const c of matrix('desk-light-en,desk-dark-zh-TW,phone-light-en,phone-dark-zh-TW')){
   const view=(c.device==='desk'&&c.lang==='en'||c.device==='phone'&&c.lang==='zh-TW')?'health':'settings';
   const errors:string[]=[];const {ctx,page}=await fx.page(c,{path:view==='health'?'/ui/fleet/host-health':'/settings/notifications#host-monitoring'});page.on('pageerror',(e:any)=>errors.push(String(e).slice(0,200)));
   console.log('Loaded',p,view,caseName(c));
   try{
    const selector=view==='health'?'.host-health':'#host-monitoring';await page.locator(selector).waitFor();await page.evaluate(()=>document.fonts.ready);
    if(view==='settings'){await page.locator('.host-alert-settings details').evaluate((e:any)=>{e.open=true;});await page.locator('#alert-memory-criticalOnly').waitFor();if(await page.locator('#alert-memory-criticalOnly').isChecked()!==(p==='darwin'))throw Error('Platform checked state mismatch');}
    else {await page.locator('[data-platform-memory-help]').waitFor();if(await page.locator('.host-volume').count()!==(p==='wsl'?2:1))throw Error('Storage fixture must reach the real strict-ID renderer');if(p==='darwin'&&!await page.locator('.host-storage').textContent().then((v:string)=>v.includes(c.lang==='en'?'Shared APFS capacity':'共用 APFS 容量')))throw Error('APFS shared pool must be rendered');}
    const focus=view==='health'?'.host-compute > .card:last-child':'#alert-memory-criticalOnly';
    await page.locator(focus).evaluate((e:any,v:string)=>e.scrollIntoView({block:v==='settings'?'center':'start'}),view);
    const schema=await(await ctx.request.get(fx.base+'/api/settings/schema')).json(),saved=await(await ctx.request.get(fx.base+'/api/settings/fleet/host-alerts')).json();
    if(schema.host_monitoring_platform!==p||schema.host_alert_defaults.memory.criticalOnly!==(p==='darwin')||Object.keys(saved.rules).length||existsSync(sidecar))throw Error('Real API/default/read-only binding failed');
    const geometry=await page.locator(selector).evaluate((e:any)=>({overflow:document.documentElement.scrollWidth>innerWidth+1,small:[...e.querySelectorAll('button,a.btn,input[role=switch],summary')].filter((n:any)=>{if(n.disabled||!n.offsetWidth)return false;const r=n.getBoundingClientRect();if(n.type==='checkbox'&&[...(n.labels??[])].some((l:any)=>{const x=l.getBoundingClientRect();return x.width>=44&&x.height>=44;}))return false;return r.width<43.5||r.height<43.5;}).map((n:any)=>n.id||n.textContent),text:e.textContent}));
    if(geometry.overflow||errors.length||(c.device==='phone'&&geometry.small.length))throw Error(JSON.stringify({p,c,geometry,errors}));
    const wrapChecks=await page.locator(selector).evaluate((e:any)=>{const walker=document.createTreeWalker(e,NodeFilter.SHOW_TEXT),tokens:any[]=[];let node;while(node=walker.nextNode()){for(const match of node.textContent.matchAll(/\d+(?:\.\d+)?\u00a0(?:GiB|MiB|KiB)/g)){const r=document.createRange();r.setStart(node,match.index);r.setEnd(node,match.index+match[0].length);const rects=[...r.getClientRects()].filter(x=>x.width>0);tokens.push({token:match[0],lines:new Set(rects.map(x=>Math.round(x.top))).size});}}return{units:tokens,words:[...e.querySelectorAll('.host-word')].map((n:any)=>{const r=document.createRange();r.selectNodeContents(n);return{word:n.textContent,lines:new Set([...r.getClientRects()].map(x=>Math.round(x.top))).size};})};});
    if(wrapChecks.units.some((v:any)=>v.lines!==1)||wrapChecks.words.some((v:any)=>v.lines!==1)||(view==='health'&&!wrapChecks.units.length))throw Error('Value/unit or Chinese word split');
    const assets:any[]=[];for(const url of await page.evaluate(()=>performance.getEntriesByType('resource').map((r:any)=>r.name).filter((n:string)=>/\.(js|css)(\?|$)/.test(n)))){const r=await ctx.request.get(url);if(!r.ok())throw Error('Asset failed');assets.push({path:new URL(url).pathname,sha256:createHash('sha256').update(await r.body()).digest('hex')});}
    const focusGeometry=await page.locator(focus).evaluate((e:any)=>{const r=e.getBoundingClientRect();return{top:r.top,bottom:r.bottom,height:r.height,viewportHeight:innerHeight};});
    if(view==='settings'&&(focusGeometry.top<0||focusGeometry.bottom>focusGeometry.viewportHeight))throw Error('Memory choice must be visible in original viewport');
    const name=p+'-'+view+'-'+caseName(c);await page.screenshot({path:join(out,name+'.png')});checks.push({name,platform:p,view,...c,geometry,wrapChecks,focusGeometry,assets,pageErrors:errors,schemaPlatform:schema.host_monitoring_platform,criticalOnly:schema.host_alert_defaults.memory.criticalOnly,savedRules:saved.rules,sidecarAbsent:true});console.log('Captured',name);
    if(p==='wsl'&&view==='health'&&c.device==='phone'){await page.locator('.host-storage').evaluate((e:any)=>e.scrollIntoView({block:'start'}));const drive=await page.locator('.host-storage h4').allTextContents();if(!drive.some((v:string)=>v.includes('（E:）')))throw Error('Exact full-width drive suffix required');await page.screenshot({path:join(out,'wsl-storage-phone-dark-zh-TW.png')});checks.push({name:'wsl-storage-phone-dark-zh-TW',platform:p,view:'storage',...c,drive,assets,pageErrors:errors,syntheticIds:true});}
   }finally{await ctx.close();}
  }
 }
 writeFileSync(join(out,'checks.json'),JSON.stringify({scope:'Real product app/HTTP/schema, recorded vm_stat/swap/PSI interpreted by production modules; controlled CPU/storage, empty history. Linux PSI input is the existing WSL2 recording, not native Ubuntu execution. Synthetic resource aliases. No collector or live Fleet/CLI/account/model.',views:checks,cleanup:'Fixture close in finally'},null,2));
}finally{await fx.close();}
