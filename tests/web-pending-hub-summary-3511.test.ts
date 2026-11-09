/** #3511: a server-owned confirmation keeps its exact target and authority in either page language. */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { page, h, settle, type AppPage } from "./helpers/app-harness.js";
let shell:any, app:any, words:any;const pages:AppPage[]=[];
beforeAll(async()=>{const p=page();shell=await import("/assets/app-shell.js");app=await import("/assets/app-store.js");words=await import("/assets/app-i18n.js");p.restore();});
afterEach(async()=>{for(const p of pages.splice(0)){await p.unmount();p.restore();}app.appStore.set({pendingChanges:[]});words.setLang("en",{store:false});});
const target="https://hub.example.test:19443";
const en=`Connect this Fleet to Hub ${target} using your company account. Agent sharing stays separate.`;
const zh=`以公司帳號將這個 Fleet 連接到 Hub ${target}。分享 Agent 需另外選擇。`;
describe("Hub connection summary in the page's language",()=>{
 it.each([['zh-TW',en,zh],['en',zh,en],['zh-TW',zh,zh],['en',en,en]])("%s page localizes only the recognized server line",async(lang,source,expected)=>{
  const p=page({storage:{agend_lang:lang}});pages.push(p);words.setLang(lang,{store:false});
  const pending={id:"a".repeat(32),state:"pending",summary:[source],deadline:Date.now()+60000,confirmation:{kind:"host_cli",code:"exact-operation"}};
  app.appStore.set({pendingChanges:[pending]});await p.mount(h(shell.PendingChanges,{inline:true}));await settle(5);
  expect(p.root.querySelector('.pending-summary').textContent).toBe(expected);
  expect(p.root.querySelector('[data-pending]').getAttribute('data-pending')).toBe(pending.id);
  expect(app.appStore.get().pendingChanges[0]).toBe(pending);expect(pending.summary).toEqual([source]);
 });
 it("leaves an unknown or extended summary visible verbatim",async()=>{
  const p=page();pages.push(p);words.setLang('zh-TW',{store:false});const source=en+' Additional scope.';
  app.appStore.set({pendingChanges:[{id:'b'.repeat(32),state:'rejected',summary:[source],outcome:{reason_code:'withdrawn'}}]});
  await p.mount(h(shell.PendingChanges,{inline:true}));expect(p.root.querySelector('.pending-summary').textContent).toBe(source);
 });
});
