import {afterEach,describe,expect,it,vi} from 'vitest';
import {page,h,settle,type AppPage} from './helpers/app-harness.js';
import {shellRoute} from '../src/web-shell-routes.js';
import {parseRoute} from '/assets/app-route.js';
import {disabledHostHealth} from '../src/host-monitoring.js';
const pages:AppPage[]=[],savedFetch=globalThis.fetch;
afterEach(async()=>{for(const p of pages.splice(0)){await p.unmount();p.restore();}globalThis.fetch=savedFetch;});
async function fleet(admin:boolean,narrow=false){
 const pg=page({url:'http://127.0.0.1:19280/ui/fleet/host-health',storage:{agend_tour_done:'1'},matchNarrow:narrow});pages.push(pg);const calls:string[]=[];
 (pg.window as any).AgendAuth={canWrite:async()=>admin,sessionEnded:()=>false,onSessionEnd(){}};
 globalThis.fetch=(async(url:any)=>{calls.push(String(url));return{ok:true,status:200,json:async()=>String(url)==='/ui/host-health'?disabledHostHealth():[]};})as any;
 const {startRouter}=await import('/assets/app-nav.js'),{appStore}=await import('/assets/app-store.js'),{Shell,canCreateStore}=await import('/assets/app-shell.js');
 // @ts-expect-error product UI module
 const {FleetPanel}=await import('../src/ui/panel-fleet.js');
 canCreateStore.set({value:false});appStore.set({viewOnly:false});startRouter(pg.window);await pg.mount(h(Shell,{panels:new Map([['fleet',{Component:FleetPanel}]]),onNewInstance(){}}));await settle(12);return{pg,calls};
}
describe('administrator Host health navigation',()=>{
 it('uses the same exact route on client and server',()=>{
  expect(parseRoute('/ui/fleet/host-health')).toEqual({panel:'fleet',tab:'host-health'});expect(shellRoute('GET','/ui/fleet/host-health')).toMatchObject({kind:'shell',route:{panel:'fleet',tab:'host-health'}});expect(parseRoute('/ui/fleet/host-health/extra')).toBeNull();
 });
 it('a read-only direct route never mounts/fetches host metrics and offers no Host health tab',async()=>{
  const {pg,calls}=await fleet(false);expect(pg.root.textContent).toContain('Administrator sign-in is required');expect(pg.root.querySelector('.p-fleet nav[data-trust="panel-navigation"] > a[href="/ui/fleet/host-health"]')).toBeNull();expect(calls.filter(x=>x.startsWith('/ui/host-'))).toEqual([]);
 });
 it('brings the active phone tab into view when administrator tabs arrive asynchronously',async()=>{
  const {pg}=await fleet(false,true),nav=pg.root.querySelector('.fleet-phone-tabs')as any;
  const proto=Object.getPrototypeOf(nav),old=proto.getBoundingClientRect;
  proto.getBoundingClientRect=function(this:any){const active=this.getAttribute?.('href')==='/ui/fleet/host-health';return {left:active?400:0,right:active?520:300,width:active?120:300,top:0,bottom:44,height:44};};
  try{nav.scrollLeft=0;const {canCreateStore}=await import('/assets/app-shell.js');canCreateStore.set({value:true});await settle(8);expect(nav.scrollLeft).toBe(220);}finally{proto.getBoundingClientRect=old;}
 });
 it('an administrator gets the active tab and the real lazy page',async()=>{
  const {pg,calls}=await fleet(true);expect(pg.root.querySelector('.p-fleet nav[data-trust="panel-navigation"] > a[href="/ui/fleet/host-health"]')?.getAttribute('aria-current')).toBe('page');await vi.waitFor(()=>expect(pg.root.textContent).toContain('Host monitoring is off'));expect(calls.filter(x=>x==='/ui/host-health')).toHaveLength(1);
 });
});
