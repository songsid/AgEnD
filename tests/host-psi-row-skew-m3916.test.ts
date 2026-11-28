/**
 * Prism #4613 P2: module skew. A tab can still hold the PREVIOUS host-monitoring-linux.js / host-monitoring-wsl.js (cached
 * by URL) when the new host-health.js arrives. The new host-wide PSI row must not need a key those retained files lack,
 * or the page would show the raw key. Its wording lives in host-health.js itself (hostHealth.psiHostLinux / psiHostWsl).
 * The retained wording modules are the files at release fa4c938ec (tests/fixtures/skew/), swapped in for the current ones.
 */
import {afterEach,describe,it,expect,vi} from 'vitest';
import {page,h,settle,type AppPage} from './helpers/app-harness.js';import {setLang} from '/assets/app-i18n.js';
import {disabledHostHealth,type MonitoringPlatform} from '../src/host-monitoring.js';
// @ts-expect-error retained JS fixture (no declaration file)
vi.mock('../src/ui/host-monitoring-linux.js',()=>import('./fixtures/skew/host-monitoring-linux.base-fa4c938ec.js'));
// @ts-expect-error retained JS fixture (no declaration file)
vi.mock('../src/ui/host-monitoring-wsl.js',()=>import('./fixtures/skew/host-monitoring-wsl.base-fa4c938ec.js'));
// @ts-expect-error product UI
const {HostHealthView}=await import('../src/ui/host-health.js');
const pages:AppPage[]=[];
afterEach(async()=>{for(const p of pages.splice(0)){await p.unmount();p.restore();}setLang('en');});
const health=(platform:MonitoringPlatform)=>{const at=Date.now(),s=disabledHostHealth();s.enabled=true;s.state='sampling';s.platform=platform;s.history={state:'recording'}as any;s.alerts={state:'ready',needsYou:true,general:false,active:[],resolved:[],pending:0};s.cpu={status:'ok',sampledAt:at,attemptedAt:at,value:{usedPercent:25,logicalCpus:4,loadAverage:[1,2,3]}};s.memory={status:'ok',sampledAt:at,attemptedAt:at,value:{totalBytes:16*1024**3,availableBytes:8*1024**3,availableKind:platform==='darwin'?'reclaimable-estimate':'available',pressure:'elevated',swapTotalBytes:0,swapFreeBytes:0,details:platform==='darwin'?{kind:'darwin',kernelPressure:2,compressedBytes:1024**3,storedBytes:2*1024**3,swapUsedBytes:0}:{kind:platform,pressureSignal:'psi-full',psiSomeAvg60:1,psiFullAvg10:7,hostPsiSomeAvg60:30,hostPsiFullAvg10:25}}};return s;};
describe('the host-wide PSI row with the retained platform wording modules (Prism #4613)',()=>{
 it.each((['linux','wsl']as const).flatMap(platform=>(['en','zh-TW']as const).map(language=>({platform,language}))))('$platform/$language: no raw key; the row reads from host-health.js',async({platform,language})=>{
  const p=page();pages.push(p);setLang(language);await p.mount(h(HostHealthView,{health:health(platform),range:'1h',busy:false,history:{series:[]}}));await settle(8);
  const text=p.root.textContent;expect(text).not.toMatch(/hostLinux\.|hostWsl\.|hostHealth\.|psiHost/);
  const row=p.root.querySelector('[data-memory-host-psi]').textContent;expect(row).toContain('25.0');
  expect(row).toMatch(language==='zh-TW'?(platform==='wsl'?/整個 WSL/:/整台主機/):(platform==='wsl'?/Whole WSL/:/Whole machine/));
  expect(p.root.querySelector('[data-memory-psi]').textContent).toContain('7.0');
 });
});
