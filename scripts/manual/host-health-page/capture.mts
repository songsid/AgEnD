/** S207: owned real-app UI fixture. REAL=1 explicitly samples this host, no model/account or live Fleet startup.
 * Synthetic macOS/Linux views prove rendering only. No native macOS claim. One Chromium, serial pages.
 * REPO=<checkout> PW_DIR=<installed playwright-core> OUT=<private output> REAL=1 node --import tsx ...
 */
import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {createServer} from 'node:net';
import {setTimeout as pause} from 'node:timers/promises';
import {bootFixture,matrix,caseName,type MatrixCase} from '../smoke-fixture/index.mts';
import {disabledHostHealth,type HostHealthSnapshot} from '../../../src/host-monitoring.js';
const out=process.env.OUT;if(!out)throw Error('OUT is required');mkdirSync(out,{recursive:true});
// Ephemeral, distinct port family. The canonical fixture refuses a bind race; it never contacts/takes over another listener.
async function family(){const server=createServer();await new Promise<void>((r,j)=>{server.once('error',j);server.listen(0,'127.0.0.1',r)});const p=(server.address()as any).port;await new Promise<void>(r=>server.close(()=>r()));if(p===65535)throw Error('No adjacent port');return p;}
const fx=await bootFixture({port:await family(),roster:[{name:'sample-helper',displayName:'Sample helper',backend:'claude-code',description:'Synthetic capture fixture',status:'stopped'}],classic:false,host:true});
const leaderR1=process.env.RETAKE==='leader-r1',affected=leaderR1||process.env.RETAKE==='affected';const checks:any[]=[];let mode:HostHealthSnapshot|null=null,real=false;
const actualHealth=fx.fm.hostHealthSnapshot.bind(fx.fm),actualHistory=fx.fm.hostHistoryQuery.bind(fx.fm);
const fakeHistory=(snapshot:HostHealthSnapshot,range:string,series:string[])=>({start:Date.now()-3600000,end:Date.now(),step:60000,series:series.map(id=>({id,buckets:Array.from({length:60},(_,i)=>{const n=id==='cpu.used'?20+i%30:id==='memory.pressure'?1:id==='memory.available'?snapshot.memory.value?.availableBytes??0:snapshot.disks.value?.volumes.find(v=>id===`disk.${v.id}.available`)?.availableBytes??0;return{at:Date.now()-(60-i)*60000,min:i===12?null:n,max:i===12?null:n,average:i===12?null:n,count:i===12?0:1,sourceAt:Date.now()-(60-i)*60000};})})),stats:{bytes:65536,rows:500,maxBytes:64*1024**2,dbBudget:30*1024**2,trimmed:false}});
fx.fm.hostHealthSnapshot=()=>mode??actualHealth();fx.fm.hostHistoryQuery=(range:string,series:string[])=>mode?Promise.resolve({ok:true,value:fakeHistory(mode,range,series)}):actualHistory(range,series);
async function until(test:()=>boolean,ms=7000){const end=Date.now()+ms;while(!test()){if(Date.now()>end)throw Error('Capture condition not met');await pause(20);}}
function synthetic(platform:'wsl'|'linux'|'darwin'):HostHealthSnapshot{
 const s=disabledHostHealth(),at=Date.now();s.enabled=true;s.platformSupported=true;s.platform=platform;s.state='sampling';s.history={state:'recording'};
 s.cpu={status:'ok',sampledAt:at,attemptedAt:at,value:{usedPercent:37,logicalCpus:8,loadAverage:[0.8,0.7,0.6]}};
 s.memory={status:'ok',sampledAt:at,attemptedAt:at,value:{totalBytes:24*1024**3,availableBytes:12*1024**3,availableKind:'estimate',pressure:'normal',swapTotalBytes:4*1024**3,swapFreeBytes:3*1024**3}};
 s.disks={status:'ok',sampledAt:at,attemptedAt:at,value:{backingDrive:platform==='wsl'?'identified':'not-applicable',volumes:[{id:'a'.repeat(16),roles:['root','state'],availableBytes:95*1024**3,totalBytes:200*1024**3,usedPercent:52.5,sampledAt:at,...(platform==='darwin'?{shared:true}: {})},...(platform==='wsl'?[{id:'b'.repeat(16),roles:['wsl-backing'],drive:'D',availableBytes:45*1024**3,totalBytes:200*1024**3,usedPercent:77.5,sampledAt:at}]:[])]}};return s;
}
async function capture(name:string,c:MatrixCase,path='/ui/fleet/host-health',settings=false,lower=false){
 const {ctx,page}=await fx.page(c,{path});const errors:string[]=[];page.on('pageerror',(e:any)=>errors.push(String(e).slice(0,200)));
 try{
  await page.locator(settings?'#host-monitoring':'.host-health').waitFor();await page.evaluate(()=>document.fonts.ready);await page.waitForFunction(()=>!document.querySelector('.host-health[aria-busy="true"]'));
  if(lower)await page.locator('.host-compute > .card').first().scrollIntoViewIfNeeded();
  const result=await page.evaluate(()=>{const root=document.querySelector('.host-health')||document.querySelector('#host-monitoring');const nav=document.querySelector('.p-fleet nav[data-trust=panel-navigation]'),active=nav?.querySelector('a.active');const nr=nav?.getBoundingClientRect(),ar=active?.getBoundingClientRect();const activeVisible=!ar||!nr||ar.left>=nr.left-1&&ar.right<=nr.right+1;const compute=[...root!.querySelectorAll('.host-compute > .card')].map(e=>{const r=e.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom}});const value=root!.querySelector('.host-pressure-value'),range=value?document.createRange():null;if(value)range!.selectNodeContents(value);const pressureLines=range?.getClientRects().length??0;const action=root!.querySelector('.s-page-actions a.btn'),col=root!.closest('.col'),panel=root!.closest('.panel-body'),buttonStyle=action?getComputedStyle(action):null;const header=action&&col&&panel?{gutter:panel.getBoundingClientRect().right-action.getBoundingClientRect().right,colPadding:parseFloat(getComputedStyle(col).paddingRight),buttonPadding:parseFloat(buttonStyle!.paddingRight),gap:parseFloat(getComputedStyle(action.parentElement!).gap)}:null;const buttons=[...root!.querySelectorAll('button,a.btn')].filter(e=>(e as HTMLElement).offsetWidth>0);return{activeVisible,compute,pressureLines,header,overflow:document.documentElement.scrollWidth>innerWidth+1,small:buttons.filter(e=>{const r=e.getBoundingClientRect();return r.width<43.5||r.height<43.5}).map(e=>e.textContent),cards:root!.querySelectorAll('.card').length,svg:root!.querySelectorAll('svg[role=img]').length};});
  if(!result.activeVisible||result.overflow||errors.length||(c.device==='phone'&&result.small.length))throw Error(JSON.stringify({name,result,errors}));
  if(leaderR1&&(result.pressureLines!==1||(c.device==='desk'&&(!result.header||result.header.gutter<result.header.colPadding-1||result.header.buttonPadding<12||result.header.gap<8))))throw Error('Pressure value wrapping or header spacing');
  if(lower&&c.device==='phone'&&(result.compute.length!==2||Math.abs(result.compute[0].top-result.compute[1].top)>1||result.compute[0].right>result.compute[1].left+1||result.compute.some(r=>r.top<0||r.top>600)))throw Error('Paired phone resources are not visible');
  await page.screenshot({path:join(out,name+'.png'),fullPage:true});checks.push({name,...c,source:real?'actual-host-cache':'synthetic-platform-dto',...result,pageErrors:errors.length});
 }finally{await ctx.close();}
}
async function stop(){fx.fm.hostMonitor?.stop();fx.fm.memoryPressure?.stop();if(fx.fm.hostMonitor)await until(()=>{const h=actualHealth();return h.state==='off'&&(h.history?.state??'off')==='off'});}
try{
 if(process.env.REAL!=='1')throw Error('REAL=1 is required for the explicitly approved real-data batch');
 // A fresh instance of the same cheap memory sampler, without Fleet notifications/top-process callbacks.
 const {MemoryPressure}=await import('../../../src/memory-pressure.js');fx.fm.memoryPressure=new MemoryPressure();fx.fm.memoryPressure.start();
 fx.fm.fleetConfig.monitoring={enabled:true,agent_footprint:false};fx.fm.saveFleetConfig([{path:['monitoring','enabled'],value:true},{path:['monitoring','agent_footprint'],value:false}]);fx.fm.startHostMonitoringRuntime();
 await until(()=>{const s=actualHealth();return s.cpu.value?.usedPercent!==null&&s.cpu.status==='ok'&&s.disks.status==='ok'&&s.history?.state==='recording';},45000);real=true;
 // Wait for an actual CPU sample to reach the owned history worker, not just its current snapshot.
 let committed=false;const deadline=Date.now()+75000;while(Date.now()<deadline){const cpu=await actualHistory('1h',['cpu.used']);if(cpu.ok&&cpu.value.series[0].buckets.some((b:any)=>b.count>0)){committed=true;break;}await pause(1000);}if(!committed)throw Error('Native CPU history has not committed');
 const sample=actualHealth();writeFileSync(join(out,'real-snapshot-private.json'),JSON.stringify(sample,null,2));
 for(const c of matrix(leaderR1?'desk-light-en,desk-dark-en,phone-dark-zh-TW':'full'))await capture('real-'+caseName(c),c);
 for(const c of matrix(leaderR1?'phone-dark-zh-TW':'phone-light-en,phone-dark-zh-TW'))await capture('real-resources-'+caseName(c),c,'/ui/fleet/host-health',false,true);
 if(!affected)for(const c of matrix('desk-light-en,phone-dark-zh-TW'))await capture('settings-on-'+caseName(c),c,'/settings/notifications#host-monitoring',true);
 fx.fm.fleetConfig.monitoring.enabled=false;fx.fm.saveFleetConfig([{path:['monitoring','enabled'],value:false}]);await until(()=>actualHealth().state==='off'&&actualHealth().history?.state==='off');fx.fm.memoryPressure.stop();
 if(!affected)for(const c of matrix('desk-light-en,phone-dark-zh-TW'))await capture('settings-off-'+caseName(c),c,'/settings/notifications#host-monitoring',true);
 if(!affected)await capture('real-off-phone-dark-zh-TW',matrix('phone-dark-zh-TW')[0]);await stop();real=false;
 if(!leaderR1){for(const platform of ['darwin','linux']as const){mode=synthetic(platform);for(const c of matrix('desk-light-en,phone-dark-zh-TW'))await capture('fixture-'+platform+'-'+caseName(c),c);}
 mode=synthetic('wsl');mode.disks.value!.backingDrive='unknown';mode.disks.value!.volumes.pop();mode.history={state:'paused',reason:'backing_drive_unknown'};await capture('fixture-wsl-unknown-phone-dark-zh-TW',matrix('phone-dark-zh-TW')[0]);
 mode=synthetic('darwin');mode.memory.value!.pressure='unknown';mode.memory.status='stale';mode.memory.sampledAt=Date.now()-180000;await capture('fixture-mac-stale-phone-light-en',matrix('phone-light-en')[0]);await capture('fixture-mac-stale-resources-phone-light-en',matrix('phone-light-en')[0],'/ui/fleet/host-health',false,true);
 mode=synthetic('wsl');mode.history={state:'paused',reason:'low_space'};mode.disks.value!.volumes[1].availableBytes=1024**3;mode.disks.value!.volumes[1].usedPercent=99.5;await capture('fixture-low-space-phone-dark-zh-TW',matrix('phone-dark-zh-TW')[0]);
 mode=disabledHostHealth();mode.platformSupported=false;if(!affected)await capture('fixture-unsupported-phone-light-en',matrix('phone-light-en')[0]);
 }
 writeFileSync(join(out,'checks.json'),JSON.stringify({views:checks,nativePlatform:sample.platform,nativeBackingIdentified:sample.disks.value?.backingDrive==='identified',nativeSampleCount:fx.fm.memoryPressure.snapshot().samples,scope:'Actual WSL cache; macOS/Linux and unavailable states are synthetic UI only. No footprint/hour/model/account claim.'},null,2));
}catch(error){writeFileSync(join(out,'failure-private.json'),JSON.stringify({snapshot:actualHealth(),history:fx.fm.hostHistory?.status()},null,2));throw error;}finally{try{await stop();}finally{await fx.close();}}
