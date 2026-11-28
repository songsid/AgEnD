import {afterEach,describe,it,expect,vi} from 'vitest';
import {page,h,settle,type AppPage} from './helpers/app-harness.js';import {fire} from './helpers/mini-dom.js';import {setLang} from '/assets/app-i18n.js';
// @ts-expect-error product UI
import {HostHealthView} from '../src/ui/host-health.js';
// @ts-expect-error product UI
import {HostMonitoringSettings} from '../src/ui/settings-host-monitoring.js';
// @ts-expect-error product UI
import {HostAlertSettings} from '../src/ui/settings-host-alerts.js';
import {hostAlertDefaults} from '../src/host-monitoring-defaults.js';import {defaultHostAlertSettings} from '../src/host-monitoring-alert-settings.js';import {HOST_ALERT_DEFAULTS} from '../src/host-monitoring-alert-policy.js';import {disabledHostHealth,type MonitoringPlatform} from '../src/host-monitoring.js';
const pages:AppPage[]=[],originalFetch=globalThis.fetch;
afterEach(async()=>{for(const p of pages.splice(0)){await p.unmount();p.restore();}setLang('en');globalThis.fetch=originalFetch;});
const cases=(['darwin','linux','wsl']as const).flatMap(platform=>(['en','zh-TW']as const).map(language=>({platform,language})));
const health=(platform:MonitoringPlatform)=>{const at=Date.now(),s=disabledHostHealth();s.enabled=true;s.state='sampling';s.platform=platform;s.history={state:'recording'}as any;s.alerts={state:'ready',needsYou:true,general:false,active:[],resolved:[],pending:0};s.cpu={status:'ok',sampledAt:at,attemptedAt:at,value:{usedPercent:25,logicalCpus:4,loadAverage:[1,2,3]}};s.memory={status:'ok',sampledAt:at,attemptedAt:at,value:{totalBytes:16*1024**3,availableBytes:8*1024**3,availableKind:platform==='darwin'?'reclaimable-estimate':'available',pressure:'elevated',swapTotalBytes:0,swapFreeBytes:0,details:platform==='darwin'?{kind:'darwin',kernelPressure:2,compressedBytes:1024**3,storedBytes:2*1024**3,swapUsedBytes:0}:{kind:platform,pressureSignal:'psi-full',psiSomeAvg60:1,psiFullAvg10:7,hostPsiSomeAvg60:30,hostPsiFullAvg10:25}}};return s;};
describe('per-platform Host health and Settings meaning',()=>{
 it('keeps byte value/unit tokens together and uses plain zh labels',async()=>{
  const p=page();pages.push(p);setLang('zh-TW');await p.mount(h(HostHealthView,{health:health('wsl'),range:'1h',busy:false,history:{series:[]}}));await settle(8);
  expect(p.root.textContent).toContain('可用記憶體：');expect(p.root.textContent).toContain('8.0\u00a0GiB');expect(p.root.querySelectorAll('.host-compute > .card')[1].textContent).not.toMatch(/\d[ .\d]* (?:GiB|MiB|KiB)/);
  const words=[...p.root.querySelectorAll('.host-word')].map((el:any)=>el.textContent);expect(words).toContain('歷史');expect(words).toContain('取樣');
  const fallback=health('wsl');fallback.memory.value!.availableKind='free';await p.mount(h(HostHealthView,{health:fallback,range:'1h',busy:false,history:{series:[]}}));await settle(8);expect(p.root.textContent).toContain('WSL 可用記憶體備用讀數：');expect(p.root.textContent).not.toContain('MemAvailable：');
 });

 it.each(cases)('$platform/$language shows only that platform’s memory diagnostics',async({platform,language})=>{
  const p=page();pages.push(p);setLang(language);await p.mount(h(HostHealthView,{health:health(platform),range:'1h',busy:false,history:{series:[]}}));await settle(8);
  const text=p.root.textContent;expect(text).not.toMatch(/hostDarwin\.|hostLinux\.|hostWsl\./);const hint=p.root.querySelector('[data-platform-memory-help]').textContent;
  if(platform==='darwin'){expect(hint).toContain('macOS');expect(p.root.querySelector('[data-memory-compression]')).not.toBeNull();expect(p.root.querySelector('[data-memory-psi]')).toBeNull();expect(text).toContain(language==='en'?'allocated now':'目前配置');expect(text).not.toContain('MemAvailable');}
  else{expect(p.root.querySelector('[data-memory-compression]')).toBeNull();expect(p.root.querySelector('[data-memory-psi]').textContent).toContain('7.0');expect(p.root.querySelector('[data-memory-psi]').textContent).toContain('AgEnD');const host=p.root.querySelector('[data-memory-host-psi]').textContent;expect(host).toContain('25.0');expect(host).toMatch(language==='zh-TW'?/僅供參考/:/for reference only/);expect(text).toContain(language==='zh-TW'?(platform==='wsl'?'WSL 可用記憶體：':'可用記憶體：'):(platform==='wsl'?'WSL MemAvailable':'MemAvailable'));expect(text).not.toContain(language==='en'?'Compressor RAM':'壓縮器佔用');}
 });
 it.each(cases)('$platform/$language uses the platform default without staging or rewriting an untouched choice',async({platform,language})=>{
  const p=page();pages.push(p);setLang(language);globalThis.fetch=vi.fn(async()=>({ok:true,json:async()=>health(platform)}))as any;
  const staged=new Map(),ctx:any={fleet:{monitoring:{enabled:false,agent_footprint:false}},hostAlerts:defaultHostAlertSettings(),schema:{host_monitoring:true,host_monitoring_page:true,host_monitoring_platform:platform,host_alert_defaults:hostAlertDefaults(platform)},drafts:new Map(),stage:(key:string,value:any)=>staged.set(key,value),unstage:(key:string)=>staged.delete(key)};
  await p.mount(h(HostMonitoringSettings,{ctx}));await settle(12);expect(staged.size).toBe(0);const toggle=p.root.querySelector('#alert-memory-criticalOnly');expect(toggle.checked).toBe(platform==='darwin');expect(p.root.querySelector('[data-monitoring-platform-help]').textContent).toContain(platform==='darwin'?'macOS':platform==='wsl'?'WSL':'Linux');
  toggle.checked=platform!=='darwin';fire(toggle,'change');await settle(12);expect(staged.get('host-alerts').request.body.rules.memory.criticalOnly).toBe(platform!=='darwin');expect(staged.has('host-monitoring')).toBe(false);
 });
 it.each(['darwin','linux','wsl']as const)('%s preserves a legacy explicit off rule even if its defaults are on',async platform=>{
  const p=page();pages.push(p);const ctx:any={hostAlerts:{...defaultHostAlertSettings(),rules:{memory:{...HOST_ALERT_DEFAULTS.memory}}},schema:{host_monitoring_platform:platform,host_alert_defaults:hostAlertDefaults(platform)},drafts:new Map(),stage:vi.fn(),unstage:vi.fn()};await p.mount(h(HostAlertSettings,{ctx,health:health(platform)}));await settle(8);expect(p.root.querySelector('#alert-memory-criticalOnly').checked).toBe(false);expect(ctx.stage).not.toHaveBeenCalled();
 });
});
