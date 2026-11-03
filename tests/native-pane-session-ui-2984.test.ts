/** Actual Preact recovery component; no network, provider or fleet lifecycle. */
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";
let p:AppPage, Recovery:any;
const first={kind:"session-unconfirmed",launchId:"12345678-1234-4321-abcd-123456789099",sessionId:"12345678-1234-4321-abcd-123456789088"};
beforeAll(async()=>{p=page({url:"http://localhost/ui",storage:{agend_lang:"en"}});const {setLang}=await import("/assets/app-i18n.js");setLang("en",{store:false});Recovery=(await import("/ui/js/native-pane-recovery.js")).NativePaneRecovery;});
afterEach(async()=>{await p.unmount();delete p.document.body.dataset.tier;});
afterAll(()=>p.restore());
const buttons=()=>Array.from(p.document.querySelectorAll("button")) as any[];
it("offers one explicit fresh-conversation action, with exact displayed identities",async()=>{
 const fetch=vi.fn(async(_path:string,_options:any)=>({ok:true,json:async()=>({})})),lease={current:()=>true,fetch};
 await p.mount(h(Recovery,{name:"native",inst:{native_adapter:"pane",native_recovery:first},lease}));
 expect(p.root.textContent).toContain("saved conversation could not be checked");
 expect(buttons().filter(b=>b.textContent==="Start a new conversation")).toHaveLength(1);
 expect(p.root.textContent).not.toContain("Recover saved session");
 fire(buttons().find(b=>b.textContent==="Start a new conversation"),"click");await settle(3);
 const confirm=buttons().filter(b=>b.textContent==="Start a new conversation").at(-1);fire(confirm,"click");await settle(4);
 expect(fetch).toHaveBeenCalledOnce();expect(fetch.mock.calls[0][0]).toBe("/ui/instances/native/new-conversation");
 expect(JSON.parse((fetch.mock.calls[0] as any)[1].body)).toEqual({confirmedNewConversation:true,launchId:first.launchId,sessionId:first.sessionId});
});
it("an open tab cannot confirm a replacement launch that arrived after its dialog opened",async()=>{
 const fetch=vi.fn(),lease={current:()=>true,fetch};
 await p.mount(h(Recovery,{name:"native",inst:{native_adapter:"pane",native_recovery:first},lease}));
 fire(buttons().find(b=>b.textContent==="Start a new conversation"),"click");await settle(2);
 const oldButton=buttons().filter(b=>b.textContent==="Start a new conversation").at(-1);
 await p.mount(h(Recovery,{name:"native",inst:{native_adapter:"pane",native_recovery:{...first,sessionId:"12345678-1234-4321-abcd-123456789077"}},lease}));
 fire(oldButton,"click");await settle(3);expect(fetch).not.toHaveBeenCalled();
});
it("a revoked page lease and guest page cannot start a fresh conversation",async()=>{
 const fetch=vi.fn();let current=true;const lease={current:()=>current,fetch};
 await p.mount(h(Recovery,{name:"native",inst:{native_adapter:"pane",native_recovery:first},lease}));
 fire(buttons().find(b=>b.textContent==="Start a new conversation"),"click");await settle(2);current=false;
 fire(buttons().filter(b=>b.textContent==="Start a new conversation").at(-1),"click");await settle(3);expect(fetch).not.toHaveBeenCalled();
 await p.unmount();p.document.body.dataset.tier="guest";await p.mount(h(Recovery,{name:"native",inst:{native_adapter:"pane",native_recovery:first},lease}));
 expect(p.root.textContent).toBe("");
});
