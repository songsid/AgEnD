/** #3512 intentionally preserves valid sessions: Stop is a service pause, not a bulk-sign-out operation. */
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { page, h, settle, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";
import { getLocale, setLocale, t } from "../src/locale.js";
let component:any, words:any, confirmation:any;const pages:AppPage[]=[];const original=getLocale();
beforeAll(async()=>{const p=page();component=await import('/ui/js/settings-hub-run.js');words=await import('/assets/app-i18n.js');confirmation=await import('/assets/ui-confirm.js');p.restore();});
afterEach(async()=>{for(const q of confirmation.confirmStore.get().queue)confirmation.answerConfirm(q.id,false);for(const p of pages.splice(0)){await p.unmount();p.restore();}vi.unstubAllGlobals();setLocale(original);});
it.each(['en','zh-TW'])("%s Stop dialog and both summaries describe retained valid sign-ins",async lang=>{
 const p=page({storage:{agend_lang:lang}});pages.push(p);vi.stubGlobal("confirm",undefined);words.setLang(lang,{store:false});setLocale(lang as any);
 const requests:any[]=[];vi.stubGlobal('fetch',vi.fn(async(path:string,init:any={})=>{requests.push({path,init});return{ok:true,status:200,json:async()=>({ok:true,initialized:true,enabled:true})};}));
 await p.mount(h(component.HubRunSettings));await settle(12);const toggle=p.root.querySelector('#hubRunOn');expect(toggle).toBeTruthy();toggle.checked=false;fire(toggle,'change');await settle(3);
 const q=confirmation.confirmStore.get().queue[0];expect(q).toBeTruthy();
 for(const line of [q.message,words.t('hubRun.summary_off'),t('hub.run.stop')]) {
  expect(line).not.toMatch(/signed out|登出/);expect(line).toMatch(lang==='en'?/valid sign-ins.*resume/i:/有效.*登入.*恢復/);
 }
 confirmation.answerConfirm(q.id,false);await settle(3);expect(requests.every(r=>!r.init.method||r.init.method==='GET')).toBe(true);expect(toggle.checked).toBe(true);
});
