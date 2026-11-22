import {afterEach,describe,it,expect,vi} from 'vitest';
import {page,h,settle,type AppPage} from './helpers/app-harness.js';import {fire} from './helpers/mini-dom.js';import {createLease} from '/assets/app-ctx.js';
import {disabledHostHealth} from '../src/host-monitoring.js';
import {setLang} from '/assets/app-i18n.js';
// @ts-expect-error product UI
import {HostFootprintView} from '../src/ui/host-footprint.js';
// @ts-expect-error product UI
import {HostHealth} from '../src/ui/host-health.js';
// @ts-expect-error product UI
import {HostAlerts} from '../src/ui/host-alerts.js';
const pages:AppPage[]=[];afterEach(async()=>{for(const p of pages.splice(0)){await p.unmount();p.restore();}setLang('en');});
const mount=()=>{const p=page();pages.push(p);return p;};
describe('actual optional footprint and deferred alert UI',()=>{
 it.each(['en','zh-TW'])('shows off without zero counters, and hides the empty alert explainer (%s)',async locale=>{
  const p=mount();setLang(locale);await p.mount(h(HostFootprintView,{}));expect(p.root.textContent).toContain(locale==='en'?'Agent footprint is off':'Agent 資源用量已關閉');expect(p.root.querySelector('table')).toBeNull();
  await p.mount(h(HostAlerts,{alerts:{state:'ready',active:[],pending:0}}));expect(p.root.textContent).not.toContain(locale==='en'?'Acknowledging':'標記已看過後');
 });
 it.each(['en','zh-TW'])('shows bounded numeric rows, separate overhead and selection/page actions (%s)',async locale=>{
  const p=mount();setLang(locale);const next=vi.fn(),select=vi.fn(),rows=Array.from({length:60},(_,i)=>({id:i.toString(16).padStart(16,'0'),label:'Sample '+i,cpuPercent:i?null:1,rssBytes:1024,managedBytes:10}));
  await p.mount(h(HostFootprintView,{snapshot:{enabled:true,status:'ok',reading:{sampledAt:1700000000000,rows,total:128,covered:50,hasMore:true,shared:{cpuPercent:2,rssBytes:2048}}},onOffset:next,onSelect:select}));expect(p.root.querySelectorAll('tbody tr')).toHaveLength(51);expect(p.root.querySelector('.host-footprint-sample')?.textContent).not.toContain('·');expect(p.root.textContent).not.toMatch(/[・]|採樣/);if(locale==='zh-TW')expect(p.root.querySelector('.host-footprint-memory')?.textContent).toBe('記憶體（估）');expect(p.root.textContent).toContain(locale==='en'?'Shared service overhead':'共用服務用量');
  const buttons=[...p.root.querySelectorAll('button')];fire(buttons[0],'click');expect(select).toHaveBeenCalledWith('0000000000000000');fire(buttons.at(-1)!,'click');expect(next).toHaveBeenCalledWith(50);expect(p.root.textContent).toContain(locale==='en'?'workspaces are not measured':'不量測工作區');
 });
 it('keeps passive refresh on the selected cached page and selected agent series',async()=>{
  const p=mount(),lease=createLease(),calls:string[]=[],saved=globalThis.fetch;const interval=vi.spyOn(lease,'interval');
  const snapshot:any={...disabledHostHealth(),enabled:true,state:'sampling',platform:'linux',history:{state:'recording'},footprint:{enabled:true,status:'ok',reading:{rows:[{id:'a'.repeat(16),label:'Sample helper',cpuPercent:1,rssBytes:1024}],total:128,covered:1,hasMore:true,sampledAt:Date.now(),shared:{cpuPercent:1,rssBytes:1024}}}};
  globalThis.fetch=vi.fn(async(url:any)=>{calls.push(String(url));return{ok:true,status:200,json:async()=>String(url).startsWith('/ui/host-health')?snapshot:{ok:true,value:{series:[]}}};})as any;
  try{await p.mount(h(HostHealth,{lease}));await settle(24);const next=[...p.root.querySelectorAll('button')].find((b:any)=>b.textContent==='More agents');fire(next!,'click');await settle(24);expect(calls).toContain('/ui/host-health?agentOffset=50');
   const select=p.root.querySelector('.host-footprint tbody button');fire(select,'click');await settle(24);expect(calls.filter(s=>s.startsWith('/ui/host-history')).at(-1)).toContain('agent.aaaaaaaaaaaaaaaa.cpu');
   const before=calls.length;(interval.mock.calls[0][0] as ()=>void)();await settle(24);expect(calls.slice(before)[0]).toBe('/ui/host-health?agentOffset=50');expect(calls.slice(before).at(-1)).toContain('agent.aaaaaaaaaaaaaaaa.rss');
  }finally{await p.unmount();lease.dispose();globalThis.fetch=saved;interval.mockRestore();}
 });
 it('does not insert an ASCII space after the Traditional Chinese update label',async()=>{
  const p=mount();setLang('zh-TW');await p.mount(h(HostAlerts,{alerts:{state:'ready',active:[{key:'cpu',kind:'cpu',level:'warning',value:95,threshold:90,revision:1,openedAt:1,updatedAt:1700000000000}],pending:0}}));expect(p.root.textContent).toContain('問題最後更新：');expect(p.root.textContent).not.toContain('問題最後更新： ');
 });
});
