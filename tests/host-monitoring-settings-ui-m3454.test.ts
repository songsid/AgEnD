import { beforeAll,afterAll,afterEach,beforeEach,describe,expect,it } from 'vitest';
import {page,h,settle,type AppPage} from './helpers/app-harness.js';
import {fire} from './helpers/mini-dom.js';
let p:AppPage,Component:any,i18n:any;const staged=new Map();let ctx:any;
beforeAll(async()=>{p=page({url:'http://localhost/settings/notifications'});i18n=await import('/assets/app-i18n.js');Component=(await import('/ui/js/settings-host-monitoring.js')).HostMonitoringSettings});
beforeEach(()=>{staged.clear();i18n.setLang('en',{store:false});ctx={fleet:{},schema:{host_monitoring:true,host_monitoring_agents:true},drafts:new Map(),stage:(k:string,v:any)=>staged.set(k,v),unstage:(k:string)=>staged.delete(k)};globalThis.confirm=()=>true});
afterEach(async()=>{await p.unmount();delete (globalThis as any).confirm});afterAll(()=>p.restore());
const input=(id:string)=>p.root.querySelector('#'+id);
const toggle=async(id:string,value:boolean)=>{const el=input(id);el.checked=value;fire(el,'change');await settle(12)};
describe('shared Settings monitoring card',()=>{
 it('starts both off with agent sampling disabled; opening Settings stages nothing',async()=>{
  await p.mount(h(Component,{ctx}));expect(input('hostMonitoringEnabled').checked).toBe(false);expect(input('hostMonitoringAgents').checked).toBe(false);expect(input('hostMonitoringAgents').disabled).toBe(true);expect(staged.size).toBe(0);expect(p.root.textContent).toContain('no monitoring collector, timer or history file');
 });
 it.each([undefined,false,null,'true'])('renders no card or staged write without a real capability: %j',async capability=>{
  ctx.schema={host_monitoring:capability};await p.mount(h(Component,{ctx}));expect(input('hostMonitoringEnabled')).toBeNull();expect(p.root.textContent).not.toContain('Host monitoring');expect(staged.size).toBe(0);
 });
 it('stages two explicit booleans; cancels disabling before the draft changes',async()=>{
  await p.mount(h(Component,{ctx}));await toggle('hostMonitoringEnabled',true);
  expect(staged.get('host-monitoring').request.body).toEqual({enabled:true,agent_footprint:false});
  globalThis.confirm=()=>false;await toggle('hostMonitoringEnabled',false);
  expect(staged.get('host-monitoring').request.body.enabled).toBe(true);
 });
 it('hides even a configured-on host when the collector is absent',async()=>{
  ctx.fleet.monitoring={enabled:true,agent_footprint:true};ctx.schema={};await p.mount(h(Component,{ctx}));expect(input('hostMonitoringEnabled')).toBeNull();expect(staged.size).toBe(0);
 });
 it('unstages an edit when collection capability disappears',async()=>{
  await p.mount(h(Component,{ctx}));await toggle('hostMonitoringEnabled',true);expect(staged.size).toBe(1);
  ctx.schema={host_monitoring:false};await p.mount(h(Component,{ctx}));expect(input('hostMonitoringEnabled')).toBeNull();expect(staged.size).toBe(0);
 });
 it('keeps the estimated cost and off semantics visible in Traditional Chinese',async()=>{
  i18n.setLang('zh-TW',{store:false});await p.mount(h(Component,{ctx}));expect(p.root.textContent).toContain('估計使用 2–4 MiB');expect(p.root.textContent).toContain('沒有監測收集器、計時器或歷史檔案');
 });
});
