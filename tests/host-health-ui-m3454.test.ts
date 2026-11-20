import {afterEach,describe,expect,it,vi} from 'vitest';
import {page,h,settle,type AppPage} from './helpers/app-harness.js';
import {fire} from './helpers/mini-dom.js';
import {disabledHostHealth} from '../src/host-monitoring.js';
import {createLease} from '/assets/app-ctx.js';
import {setLang} from '/assets/app-i18n.js';
// @ts-expect-error product UI module
import {HostHealth,HostHealthView} from '../src/ui/host-health.js';
const pages:AppPage[]=[],leases:ReturnType<typeof createLease>[]=[],savedFetch=globalThis.fetch;
afterEach(async()=>{for(const p of pages.splice(0)){await p.unmount();p.restore();}for(const l of leases.splice(0))l.dispose();globalThis.fetch=savedFetch;setLang('en');vi.restoreAllMocks();});
function health(platform:'wsl'|'linux'|'darwin'='wsl'){
 const s=disabledHostHealth(),now=Date.now();s.enabled=true;s.state='sampling';s.platform=platform;s.history={state:'recording'};
 s.cpu={status:'ok',sampledAt:now,attemptedAt:now,value:{usedPercent:35,logicalCpus:4,loadAverage:[0.1,0.2,0.3]}};
 s.memory={status:'ok',sampledAt:now,attemptedAt:now,value:{totalBytes:16*1024**3,availableBytes:8*1024**3,availableKind:'estimate',pressure:'normal',swapTotalBytes:4*1024**3,swapFreeBytes:3*1024**3}};
 s.disks={status:'ok',sampledAt:now,attemptedAt:now,value:{backingDrive:platform==='wsl'?'identified':'not-applicable',volumes:[{id:'a'.repeat(16),roles:['root','state'],availableBytes:100*1024**3,totalBytes:200*1024**3,usedPercent:50,sampledAt:now},...(platform==='wsl'?[{id:'b'.repeat(16),roles:['wsl-backing'],drive:'D',availableBytes:40*1024**3,totalBytes:200*1024**3,usedPercent:80,sampledAt:now}]:[])]}};
 return s;
}
const history={series:[{id:'cpu.used',buckets:[{average:0,min:0,max:0,count:1},{average:35,min:35,max:35,count:1},{average:null,min:null,max:null,count:0},{average:20,min:20,max:20,count:1},{average:25,min:25,max:25,count:1}]}]};
async function view(snapshot=health(),language='en'){
 const p=page();pages.push(p);setLang(language);await p.mount(h(HostHealthView,{health:snapshot,history,range:'1h',busy:false,onRange(){},onRefresh(){}}));await settle(4);return p;
}
async function mounted(fetcher:any){
 const p=page();pages.push(p);globalThis.fetch=fetcher;const lease=createLease();leases.push(lease);const interval=vi.spyOn(lease,'interval');await p.mount(h(HostHealth,{lease}));await settle(8);return{p,lease,interval};
}
const reply=(value:any,status=200)=>({ok:status===200,status,json:async()=>value});
describe('real Host health UI',()=>{
 it.each(['en','zh-TW'])('shows WSL and its separate backing drive with real numeric charts (%s)',async language=>{
  const p=await view(health(),language);const text=p.root.textContent;expect(text).toContain(language==='en'?'Windows backing drive':'存放 WSL 的 Windows 磁碟');expect(text).toContain('40.0 GiB');expect(p.root.querySelectorAll('.host-volume')).toHaveLength(2);expect(p.root.querySelectorAll('.host-chart svg polyline')).toHaveLength(2);
  expect(text).toContain(language==='en'?'not the physical Windows computer':'不是實體 Windows 電腦');expect(text).toContain(language==='en'?'Gaps mean no sample':'缺口代表沒有記錄取樣');expect(p.root.querySelector('a[href="/settings/notifications#host-monitoring"]')).not.toBeNull();
 });
 it.each(['en','zh-TW'])('keeps the drive suffix and pressure value readable (%s)',async language=>{
  const p=await view(health(),language);expect(p.root.querySelector('.host-volume h4')?.textContent).toBe(language==='en'?'Windows backing drive (D:)':'存放 WSL 的 Windows 磁碟（D:）');expect(p.root.querySelector('.host-pressure-value')?.textContent).toBe(language==='en'?'Normal':'正常');
 });
 it.each(['en','zh-TW'])('waits for four recorded buckets before drawing sparse history (%s)',async language=>{
  const p=page();pages.push(p);setLang(language);const buckets=Array.from({length:120},(_,i)=>({average:i<3?35:null,min:i<3?35:null,max:i<3?35:null,count:i<3?1:0}));
  const draw=async()=>{await p.mount(h(HostHealthView,{health:health(),history:{series:[{id:'cpu.used',buckets}]},range:'1h',busy:false,onRange(){},onRefresh(){}}));await settle(4);};await draw();expect(p.root.querySelector('.host-chart svg')).toBeNull();expect(p.root.textContent).toContain(language==='en'?'Collecting history…':'正在累積歷史紀錄…');
  buckets[3]={average:40,min:40,max:40,count:1};await draw();expect(p.root.querySelector('.host-chart svg')).not.toBeNull();expect(p.root.textContent).toContain(language==='en'?'Peak: 40.0%':'最高：40.0%');
 });
 it('represents macOS APFS sharing and unknown pressure without a healthy substitute',async()=>{
  const s=health('darwin');s.memory.value!.pressure='unknown';s.disks.value!.volumes[0].shared=true;const p=await view(s);
  expect(p.root.textContent).toContain('Memory pressure: Unknown');expect(p.root.textContent).toContain('Shared APFS capacity');expect(p.root.textContent).toContain('Do not add their free space together');expect(p.root.textContent).not.toContain('Windows backing drive');expect(p.root.querySelectorAll('.host-volume')).toHaveLength(1);
 });
 it('shows Linux unavailable/stale readings and per-metric last-good times, never healthy zero',async()=>{
  const s=health('linux');s.cpu.value!.usedPercent=null;s.cpu.status='unavailable';s.memory.sampledAt=Date.now()-120000;s.memory.value!.availableBytes=null;s.memory.value!.pressure='unknown';const p=await view(s);
  expect(p.root.textContent).toContain('Not available');expect(p.root.textContent).toContain('Stale');expect(p.root.textContent).toContain('Memory pressure: Unknown');expect(p.root.querySelector('.host-compute .host-value')?.textContent).toBe('Not available');expect(p.root.querySelectorAll('.host-compute .note').length).toBeGreaterThan(4);
 });
 it('never calls cached pressure Normal after its source becomes unavailable',async()=>{
  const s=health('darwin');s.memory.status='unavailable';s.memory.value!.pressure='normal';const p=await view(s);expect(p.root.textContent).toContain('Memory pressure: Unknown');expect(p.root.textContent).not.toContain('Memory pressure: Normal');
 });
 it('identification and low-water pauses are visible, not hidden in a tooltip',async()=>{
  const s=health();s.disks.value!.backingDrive='unknown';s.disks.value!.volumes.pop();s.history={state:'paused',reason:'low_space'};const p=await view(s);expect(p.root.textContent).toContain('Windows drive not identified');expect(p.root.textContent).toContain('keeping current samples in memory only');
 });
 it('a failed or stopping disable is never presented as a clean Off',async()=>{
  const s=disabledHostHealth();s.state='failed';s.reason='history_cleanup_failed';const p=await view(s);expect(p.root.textContent).toContain('history cleanup may still need attention');expect(p.root.textContent).not.toContain('Host monitoring is off');
 });
 it('an unsupported platform has no misleading enable link or collection claim',async()=>{
  const s=disabledHostHealth();s.platformSupported=false;const p=await view(s);expect(p.root.textContent).toContain('not available on this computer');expect(p.root.querySelectorAll('a[href*=host-monitoring]')).toHaveLength(0);
 });
 it('off opens Settings without history requests or a monitoring refresh interval',async()=>{
  const fetcher=vi.fn(async(_url:any)=>reply(disabledHostHealth())),f=await mounted(fetcher);expect(f.p.root.textContent).toContain('Host monitoring is off');expect(fetcher).toHaveBeenCalledTimes(1);expect(fetcher.mock.calls[0][0]).toBe('/ui/host-health');expect(f.interval).not.toHaveBeenCalled();expect(f.p.root.querySelectorAll('.host-chart')).toHaveLength(0);
 });
 it('stops its lease-owned refresh interval after another session turns monitoring off',async()=>{
  let enabled=true;const f=await mounted(async(url:string)=>reply(url==='/ui/host-health'?(enabled?health():disabledHostHealth()):{ok:true,value:history}));expect(f.interval).toHaveBeenCalledTimes(1);enabled=false;
  fire(f.p.root.querySelector('.s-page-actions button')!,'click',{button:0});await settle(8);expect(f.p.root.textContent).toContain('Host monitoring is off');expect(f.lease.holding()).toBe(0);
 });
 it('keeps one request in flight, discards an old range and reads only the latest selected range',async()=>{
  let finish!:(value:any)=>void;const calls:string[]=[];const fetcher=vi.fn(async(url:string)=>{calls.push(String(url));if(url==='/ui/host-health')return reply(health());if(url.includes('range=1h'))return new Promise(r=>{finish=r});return reply({ok:true,value:history});});
  const f=await mounted(fetcher);const choose=async(label:string)=>{const b=[...f.p.root.querySelectorAll('.host-range button')].find((x:any)=>x.textContent===label);fire(b!,'click',{button:0});await settle(4);};
  await choose('24h');await choose('7d');expect(calls.filter(x=>x.startsWith('/ui/host-history'))).toHaveLength(1);finish(reply({ok:true,value:history}));await settle(12);
  const ranges=calls.filter(x=>x.startsWith('/ui/host-history')).map(x=>new URL(x,'http://fixture.test').searchParams.get('range'));expect(ranges).toEqual(['1h','7d']);expect(f.p.root.querySelector('.host-range [aria-pressed="true"]')?.textContent).toBe('7d');
 });
 it('withdraws visible metrics after an admin-session refusal and stops its poll',async()=>{
  const f=await mounted(async(url:string)=>url==='/ui/host-health'?reply(health()):reply({},403));expect(f.p.root.textContent).toContain('Administrator sign-in required');expect(f.p.root.querySelector('.host-grid')).toBeNull();
 });
 it('distinguishes a temporarily unavailable history reader from a zero/no-samples chart',async()=>{
  const f=await mounted(async(url:string)=>url==='/ui/host-health'?reply(health()):reply({ok:false,reason:'history_busy'}));expect(f.p.root.textContent).toContain('Recorded history is temporarily unavailable');expect(f.p.root.textContent).not.toContain('No recorded samples');
 });
 it('drops late async state after unmount while an ignoring-abort response completes',async()=>{
  let finish!:(value:any)=>void;const f=await mounted(()=>new Promise(r=>{finish=r}));await f.p.unmount();f.lease.dispose();finish(reply(health()));await settle(8);expect(f.p.root.textContent).toBe('');expect(f.lease.holding()).toBe(0);
 });
});
