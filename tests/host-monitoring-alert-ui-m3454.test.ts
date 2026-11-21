import {afterEach,describe,it,expect,vi} from 'vitest';
import {page,h,settle,type AppPage} from './helpers/app-harness.js';import {fire} from './helpers/mini-dom.js';
import {setLang} from '/assets/app-i18n.js';
// @ts-expect-error product UI
import {HostAlerts} from '../src/ui/host-alerts.js';
// @ts-expect-error product UI
import {HostAlertSettings} from '../src/ui/settings-host-alerts.js';
// @ts-expect-error product UI
import {HostMonitoringSettings} from '../src/ui/settings-host-monitoring.js';
// @ts-expect-error product UI
import {loadAll} from '../src/ui/panel-settings.js';
import {HOST_ALERT_DEFAULTS} from '../src/host-monitoring-alert-policy.js';
import {defaultHostAlertSettings} from '../src/host-monitoring-alert-settings.js';
const pages:AppPage[]=[],originalFetch=globalThis.fetch;
afterEach(async()=>{for(const p of pages.splice(0)){await p.unmount();p.restore();}setLang('en');globalThis.fetch=originalFetch;});
const record={key:'cpu',kind:'cpu',level:'warning',revision:1,openedAt:1000,updatedAt:1000,value:95,threshold:90};
describe('shared alert views and staged settings',()=>{
 it.each(['en','zh-TW'])('keeps acknowledged issues visible and sends bounded actions (%s)',async language=>{
  const p=page();pages.push(p);setLang(language);const changed=vi.fn();globalThis.fetch=vi.fn(async()=>({ok:true}))as any;
  await p.mount(h(HostAlerts,{alerts:{state:'ready',active:[{...record,acknowledgedAt:1000}],pending:0},onChange:changed}));await settle(6);expect(p.root.textContent).toContain(language==='en'?'Acknowledged':'已看過');const buttons=[...p.root.querySelectorAll('button')];expect(buttons[0].disabled).toBe(true);fire(buttons[1],'click');await settle(12);expect(globalThis.fetch).toHaveBeenCalledWith('/ui/host-alert-action',expect.objectContaining({body:JSON.stringify({key:'cpu',revision:1,snoozeMs:3600000})}));expect(changed).toHaveBeenCalledTimes(1);expect(p.root.textContent).toContain('95.0%');
 });
 it('loads the separate alert preference into the real Settings context rather than raw fleet YAML',async()=>{
  const p=page();pages.push(p);const preferences={...defaultHostAlertSettings(),general:true},paths:string[]=[];const lease={current:()=>true,fetch:async(path:string)=>{paths.push(path);return {ok:true,status:200,json:async()=>path==='/api/settings/schema'?{host_alert_defaults:HOST_ALERT_DEFAULTS,provider_secrets:false}:path==='/api/settings/fleet/host-alerts'?preferences:{}};}};const data=await loadAll(lease);expect(data.hostAlerts).toEqual(preferences);expect(data.fleet).not.toHaveProperty('host_alerts');expect(paths).toContain('/api/settings/fleet/host-alerts');
 });
 it('mounts alert controls through the actual monitoring card with separately loaded preferences',async()=>{
  const p=page();pages.push(p);globalThis.fetch=vi.fn(async()=>({ok:true,json:async()=>({platform:'linux'})}))as any;const ctx:any={fleet:{},hostAlerts:defaultHostAlertSettings(),schema:{host_monitoring:true,host_monitoring_page:true,host_alert_defaults:HOST_ALERT_DEFAULTS},drafts:new Map(),stage:vi.fn(),unstage:vi.fn()};await p.mount(h(HostMonitoringSettings,{ctx}));await settle(12);expect(p.root.querySelector('.host-alert-settings summary')).not.toBeNull();
 });
 it('stages a separate strict preference with General opt-in, never monitoring YAML',async()=>{
  const p=page();pages.push(p);const staged=new Map(),ctx:any={fleet:{},hostAlerts:defaultHostAlertSettings(),schema:{host_alert_defaults:HOST_ALERT_DEFAULTS},drafts:new Map(),stage:(k:string,v:any)=>staged.set(k,v),unstage:(k:string)=>staged.delete(k)};
  await p.mount(h(HostAlertSettings,{ctx,health:{}}));await settle(6);expect(staged.size).toBe(0);const toggle=p.root.querySelector('#hostAlert-general');expect(toggle.checked).toBe(false);toggle.checked=true;fire(toggle,'change');await settle(12);expect(staged.get('host-alerts').request).toMatchObject({method:'PUT',url:'/api/settings/fleet/host-alerts',body:{general:true,needsYou:true,rules:{}}});expect(staged.has('host-monitoring')).toBe(false);
  const warning=p.root.querySelector('input[id="alert-cpu-warning"]');warning.value='92';fire(warning,'input');await settle(12);expect(staged.get('host-alerts').request.body.rules.cpu.warning).toBe(92);
 });
});
