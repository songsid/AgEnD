/** M-2722: actual mounted join panel, bounded local confirmation and unchanged-read polling. */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { page, h, settle, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";
let panel: any, confirmations: any, shell: any;
const mounted: AppPage[] = [], calls: any[] = [];
const handoff = "0f1e2d3c-4b5a-4968-8776-655443322110", pendingId = "a".repeat(32);
beforeAll(async () => {
 const p = page(); panel = await import("/ui/js/settings-hub-company-join.js"); confirmations = await import("/ui/js/settings-confirm.js"); shell = await import("/assets/app-shell.js"); p.restore();
});
afterEach(async () => {
 for (const p of mounted.splice(0)) { await p.unmount(); p.restore(); }
 confirmations.resetConfirmations(); vi.restoreAllMocks(); vi.unstubAllGlobals(); calls.length = 0;
});
function response(body: any, status = 200) { return { ok: status < 400, status, json: async () => body }; }
// M-2921: the one input probes the Hub (read only) before Start is offered; this Hub answers as joinable.
const probeAnswer = { ok: true, hubName: "Acme Hub", webOrigin: "https://hub.example.test", companyJoin: true, identity: "new", separateHosts: true, suggestedLabel: "QA Fleet", features: [] };
function fetcher(fn: (path: string, init: any) => any) {
 vi.stubGlobal("fetch", vi.fn(async (path: string, init: any = {}) => { calls.push({path,init}); return path.endsWith("/company-join/probe") ? response(probeAnswer) : fn(path,init); }));
}
async function mount(waiting = true) {
 const p = page({url:"http://127.0.0.1:19290/settings/hub"+(waiting?"?joinWait="+handoff:""),storage:{agend_lang:"en"}});mounted.push(p);
 await p.mount(h("div", null, h(shell.PendingChanges, {inline:true}), h(panel.CompanyJoinSettings)));await settle(10);return p;
}
const btn = (p: AppPage, text: string) => [...p.root.querySelectorAll("button")].find((b: any) => b.textContent === text);
function clock() {
 const timers = new Map<number, {fn:()=>any;ms:number}>();let seq=100000;const real = globalThis.setTimeout;
 vi.spyOn(globalThis,"setTimeout").mockImplementation(((fn:any,ms:any,...args:any[]) => {
  if(ms===1500 || ms===2000 || ms>=290000 && ms<=300000){const id=++seq;timers.set(id,{fn,ms:ms>=290000?300000:ms});return id as any;}return real(fn,ms,...args);
 }) as any);
 const clear=globalThis.clearTimeout;vi.spyOn(globalThis,"clearTimeout").mockImplementation(((id:any)=>{timers.delete(id);return clear(id);}) as any);
 return { fire(ms:number){const e=[...timers].find(([,v])=>v.ms===ms);expect(e).toBeTruthy();timers.delete(e![0]);return e![1].fn();},async next(ms:number){const e=[...timers].find(([,v])=>v.ms===ms);expect(e,`no timer ${ms}`).toBeTruthy();timers.delete(e![0]);await e![1].fn();await settle(10);},count(ms:number){return [...timers.values()].filter(t=>t.ms===ms).length;} };
}
async function start(p: AppPage) {
 vi.stubGlobal("open",vi.fn());
 const el=p.root.querySelector("#hubCompanyAddress");el.value="https://hub.example.test";fire(el,"input");await settle(4);fire(el,"blur");
 await settle(8);fire(p.root.querySelector("form"),"submit");await settle(12);
}
function heldFetch(deleteResult = true) {
 fetcher((path,init)=> {
  if(path.endsWith("/start"))return response({result:"pending_confirmation",pending_change:{id:pendingId,state:"pending",remaining_ms:300000,can_withdraw:true}},202);
  if(init.method==="DELETE"){if(!deleteResult)throw Error("offline");return response({id:pendingId,state:"rejected",remaining_ms:0,can_withdraw:false,outcome:{state:"rejected",reason_code:"withdrawn",message:"Withdrawn"}});}
  if(path.includes("/settings/pending/"))return response({id:pendingId,state:"pending",remaining_ms:300000,can_withdraw:true});
  return response({ok:true,operation:null});
 });
}
describe("company join local wait",()=>{
 it("new waiting tabs show the target and continue automatically, without an approval detour",async()=>{
  const c=clock(),replace=vi.fn();let ready=false;fetcher(()=>response({ok:true,operation:ready?{operationId:handoff,handoffId:handoff,state:"awaiting-sign-in"}:null}));
  const p=page({url:"http://127.0.0.1:19290/settings/hub?joinWait="+handoff+"&joinConsent=1#target=https%3A%2F%2Fhub.example.test",storage:{agend_lang:"en"}});mounted.push(p);
  await p.mount(h(panel.CompanyJoinSettings));await settle(10);(globalThis.location as any).replace=replace;
  expect(p.root.textContent).toContain("Opening Hub sign-in");expect(p.root.textContent).toContain("https://hub.example.test");
  expect(btn(p,"Go to the confirm card")).toBeUndefined();expect(p.root.textContent).not.toContain("really you connecting this Fleet");
  ready=true;await c.next(1500);expect(replace).toHaveBeenCalledWith("/api/hub/member/company-join/bridge?operationId="+handoff);
  expect(calls.every(x=>!x.init.method||x.init.method==="GET")).toBe(true);
 });
 it.each([false,true])("Start keeps its server claim inline and asks only the enforced code (%s)",async enforced=>{
  const c=clock();let applied=false,codePosts=0;
  const view=()=>({id:pendingId,state:applied?"applied":enforced?"pending":"applying",presentation:"hub-join",remaining_ms:300000,totp:enforced?"ready":undefined,confirm_digest:"bound-digest",can_withdraw:!applied,outcome:applied?{state:"applied",reason_code:"applied",result:{ok:true,operation:{operationId:handoff,handoffId:handoff,state:"awaiting-sign-in"}}}:null});
  fetcher((path,init)=>{
   if(path.endsWith("/start"))return response({result:"pending_confirmation",pending_change:view()},202);
   if(path.endsWith("/confirm-totp")){codePosts++;expect(JSON.parse(init.body)).toEqual({code:"123456",digest:"bound-digest"});applied=true;return response({result:"pending_confirmation",pending_change:view()},202);}
   if(path.includes("/settings/pending/"))return response(view());return response({ok:true,operation:null});
  });
  const p=await mount(false);await start(p);
  expect((globalThis.open as any).mock.calls[0][0]).toContain("&joinConsent=1#target=https%3A%2F%2Fhub.example.test");
  expect(p.root.querySelector(".pending-card")).toBeNull();expect(btn(p,"Go to the confirm card")).toBeUndefined();
  expect(!!p.root.querySelector(".hub-join-code")).toBe(enforced);expect(p.root.textContent).toContain("https://hub.example.test");
  if(enforced){const input=p.root.querySelector(".hub-join-code input");input.value="123456";fire(input,"input");await settle(5);fire(p.root.querySelector(".hub-join-code"),"submit");await settle(12);}
  else{applied=true;await c.next(2000);}
  expect(codePosts).toBe(enforced?1:0);expect(calls.filter(x=>x.path.endsWith("/start"))).toHaveLength(1);
  expect(p.root.querySelector(".pending-card")).toBeNull();expect(p.root.querySelector(".hub-join-code")).toBeNull();
 });
 it("the inline target stays bound to the submitted address while Start is held",async()=>{
  clock();let release:any;fetcher((path)=>path.endsWith("/start")?new Promise(resolve=>release=resolve):response({ok:true,operation:null}));
  const p=await mount(false);await start(p);const input=p.root.querySelector("#hubCompanyAddress");input.value="https://changed.example.test";fire(input,"input");await settle(5);
  release(response({result:"pending_confirmation",pending_change:{id:pendingId,state:"applying",presentation:"hub-join",remaining_ms:300000}},202));await settle(12);
  expect(p.root.textContent).toContain("Hub: https://hub.example.test");expect(p.root.textContent).not.toContain("changed.example.test");
  expect(JSON.parse(calls.find(x=>x.path.endsWith("/start")).init.body).address).toBe("https://hub.example.test");
 });
 it("a missing legacy confirmation card returns to Settings, never an empty Needs-you page",async()=>{
  fetcher(()=>response({ok:true,operation:null}));const p=await mount();const assign=vi.fn();(globalThis.location as any).assign=assign;
  fire(btn(p,"Go to the confirm card"),"click");expect(assign).toHaveBeenCalledWith("/settings/hub");expect(calls.every(x=>!x.init.method||x.init.method==="GET")).toBe(true);
 });
 it("reload reattaches its sole code challenge with the server target and without another Start",async()=>{
  clock();const claim={id:pendingId,state:"pending",presentation:"hub-join",remaining_ms:120000,totp:"ready",confirm_digest:"exact",hubJoin:{handoffId:handoff,target:"https://hub.example.test"}};
  fetcher(path=>path==="/api/settings/pending"?response([claim]):path.includes("/settings/pending/")?response(claim):response({ok:true,operation:null}));
  await confirmations.attach();const p=await mount(false);
  expect(p.root.querySelector(".hub-join-code")).toBeTruthy();expect(p.root.querySelector(".pending-card")).toBeNull();expect(p.root.textContent).toContain("Hub: https://hub.example.test");
  expect(calls.every(x=>!x.init.method||x.init.method==="GET")).toBe(true);
 });
 it("a new waiting tab never adopts a different handoff’s code challenge",async()=>{
  clock();const claim={id:pendingId,state:"pending",presentation:"hub-join",remaining_ms:120000,totp:"ready",hubJoin:{handoffId:"other",target:"https://other.example.test"}};
  fetcher(path=>path==="/api/settings/pending"?response([claim]):path.includes("/settings/pending/")?response(claim):response({ok:true,operation:null}));await confirmations.attach();
  const p=page({url:"http://127.0.0.1:19290/settings/hub?joinWait="+handoff+"&joinConsent=1#target=https%3A%2F%2Fhub.example.test",storage:{agend_lang:"en"}});mounted.push(p);await p.mount(h(panel.CompanyJoinSettings));await settle(12);
  expect(p.root.querySelector(".hub-join-code")).toBeNull();expect(p.root.textContent).not.toContain("other.example.test");expect(p.root.textContent).toContain("https://hub.example.test");
 });
 it("a loaded empty handoff is a confirmation wait, not an endless loading skeleton; it has a direct action and an exit",async()=>{
  fetcher(()=>response({ok:true,operation:null}));const p=await mount();
  expect(p.root.querySelector(".skeleton")).toBeNull();
  expect(p.root.textContent).toContain("The Hub sign-in opens after that");
  expect(btn(p,"Go to the confirm card")).toBeTruthy();
  expect(p.root.querySelector('a[href="/settings/hub"]')).toBeTruthy();
  expect(p.root.textContent).toContain("does not withdraw");
  expect(p.root.querySelector("form")).toBeNull();
 });
 it("re-arms reads after repeated null frames and eventually observes this exact handoff without a reload",async()=>{
  const c=clock();let reads=0;const replace=vi.fn();
  fetcher(()=>response({ok:true,operation:++reads>=4?{operationId:handoff,handoffId:handoff,state:"awaiting-sign-in"}:null}));
  const p=await mount();(globalThis.location as any).replace=replace;
  await c.next(1500);await c.next(1500);await c.next(1500);
  expect(reads).toBeGreaterThanOrEqual(4);expect(replace).toHaveBeenCalledWith("/api/hub/member/company-join/bridge?operationId="+handoff);
  expect(p.root.textContent).not.toContain("Fleet connected");
 });
 it.each(["cancelled", "ended"])("discovers matching B after older %s A, then pins only B",async state=>{
  const c=clock(),replace=vi.fn(),oldId="11111111-2222-4333-8444-555555555555";let discoveries=0;
  fetcher(path=>{
   if(path.endsWith("?operationId="+oldId))return response({error:"conflict"},409);
   if(path.endsWith("?operationId="+handoff))return response({ok:true,operation:{operationId:handoff,handoffId:handoff,state:"awaiting-sign-in"}});
   return response({ok:true,operation:++discoveries===1?{operationId:oldId,handoffId:"old",state}:{operationId:handoff,handoffId:handoff,state:"joining"}});
  });
  await mount();(globalThis.location as any).replace=replace;
  await c.next(1500);expect(replace).not.toHaveBeenCalled();
  await c.next(1500);expect(replace).toHaveBeenCalledWith("/api/hub/member/company-join/bridge?operationId="+handoff);
  expect(calls.map(x=>x.path)).toEqual(["/api/hub/member/company-join","/api/hub/member/company-join","/api/hub/member/company-join?operationId="+handoff]);
 });
 it("Check again discovers B after the local wait for unmatched A has expired, without a new Start",async()=>{
  const c=clock(),replace=vi.fn(),oldId="11111111-2222-4333-8444-555555555555";let ready=false;
  fetcher(path=>path.includes("?operationId="+oldId)?response({error:"conflict"},409):response({ok:true,operation:ready?{operationId:handoff,handoffId:handoff,state:"awaiting-sign-in"}:{operationId:oldId,handoffId:"old",state:"ended"}}));
  const p=await mount();(globalThis.location as any).replace=replace;await c.next(300000);
  expect(c.count(1500)).toBe(0);ready=true;fire(btn(p,"Check again"),"click");await settle(12);
  expect(replace).toHaveBeenCalledWith("/api/hub/member/company-join/bridge?operationId="+handoff);
  expect(calls.map(x=>x.path)).toEqual(["/api/hub/member/company-join","/api/hub/member/company-join"]);
  expect(calls.every(x=>!x.init.method||x.init.method==="GET")).toBe(true);
 });
 it("a different handoff never redirects this waiting tab",async()=>{
  const c=clock(),replace=vi.fn();fetcher(()=>response({ok:true,operation:{operationId:handoff,handoffId:"other",state:"awaiting-sign-in"}}));
  await mount();(globalThis.location as any).replace=replace;await c.next(1500);await c.next(1500);expect(replace).not.toHaveBeenCalled();
 });
 it("one slow status read retains physical ownership across polling and Retry; unmount retires its continuation",async()=>{
  const c=clock();let finish:any;fetcher(()=>new Promise(resolve=>{finish=resolve;}));const p=await mount();
  expect(p.root.querySelector(".skeleton")).toBeNull();
  const poll=c.fire(1500);await settle(4);expect(calls).toHaveLength(1);
  await c.next(300000);fire(btn(p,"Check again"),"click");await settle(4);expect(calls).toHaveLength(1);
  await p.unmount();finish(response({ok:true,operation:{operationId:handoff,handoffId:handoff,state:"awaiting-sign-in"}}));await poll;await settle(6);
  expect(calls).toHaveLength(1);expect(c.count(1500)).toBe(0);expect(p.root.textContent).toBe("");
 });
 it("the five-minute pre-operation wait ends visibly, stops automatic reads and can inspect the same result without submitting Start",async()=>{
  const c=clock();fetcher(()=>response({ok:true,operation:null}));const p=await mount();
  await c.next(300000);expect(p.root.textContent).toContain("The wait for the confirmation has ended");
  expect(p.root.querySelector(".skeleton")).toBeNull();expect(c.count(1500)).toBe(0);
  expect(btn(p,"Check again")).toBeTruthy();const before=calls.length;fire(btn(p,"Check again"),"click");await settle(10);
  expect(calls.length).toBeGreaterThan(before);expect(calls.every(x=>!x.init.method||x.init.method==="GET")).toBe(true);
  expect(p.root.querySelector("form")).toBeNull();
 });
 it("the original Start reveals the exact shared card and uses its sole Withdraw control",async()=>{
  heldFetch();const p=await mount(false);await start(p);expect(btn(p,"Go to the confirm card")).toBeTruthy();
  const other=p.document.createElement("section");other.setAttribute("data-pending","b".repeat(32));other.className="pending-card";const wrong=vi.fn();other.scrollIntoView=wrong;p.root.insertBefore(other,p.root.firstChild);
  const exact=p.root.querySelector('.pending-card[data-pending="'+pendingId+'"]');expect(exact).toBeTruthy();const scroll=vi.fn();exact.scrollIntoView=scroll;
  expect(p.root.querySelector(".s-company-join").textContent).not.toContain("Withdraw connection request");
  fire(btn(p,"Go to the confirm card"),"click");expect(scroll).toHaveBeenCalledOnce();expect(wrong).not.toHaveBeenCalled();
  const withdraw=[...exact.querySelectorAll("button")].find((el:any)=>el.textContent==="Withdraw");expect(withdraw).toBeTruthy();
  fire(withdraw,"click");await settle(14);
  expect(calls.filter(x=>x.init.method==="DELETE")).toMatchObject([{path:"/api/settings/pending/"+pendingId}]);
  expect(calls.filter(x=>x.init.method==="POST"&&!x.path.endsWith("/probe"))).toHaveLength(1);
  expect(p.root.textContent).toContain("The confirmation was withdrawn");
  expect(p.root.textContent).not.toContain("could not be verified");
  expect(p.root.textContent).not.toContain("Fleet connected");
 });
 it("a lost withdrawal keeps the original Start held rather than inventing cancellation or permitting another Start",async()=>{
  heldFetch(false);const p=await mount(false);await start(p);
  const exact=p.root.querySelector('.pending-card[data-pending="'+pendingId+'"]');
  const withdraw=[...exact.querySelectorAll("button")].find((el:any)=>el.textContent==="Withdraw");fire(withdraw,"click");await settle(12);
  expect(exact.className).toContain("pending");expect(p.root.textContent).not.toContain("The confirmation was withdrawn");
  expect(btn(p,"Sign in with company account").disabled).toBe(true);
  expect(calls.filter(x=>x.init.method==="POST"&&!x.path.endsWith("/probe"))).toHaveLength(1);
 });
 it("a local pending timeout does not apply, silently withdraw or retry the held change",async()=>{
  const c=clock();heldFetch();const p=await mount(false);await start(p);await c.next(300000);
  expect(p.root.textContent).toContain("The wait for the confirmation has ended");
  expect(p.root.querySelector('.pending-card[data-pending="'+pendingId+'"] .pending-actions button')).toBeTruthy();expect(btn(p,"Sign in with company account").disabled).toBe(true);
  expect(calls.filter(x=>x.init.method==="POST"&&!x.path.endsWith("/probe"))).toHaveLength(1);expect(calls.filter(x=>x.init.method==="DELETE")).toHaveLength(0);
 });
 // M-2988 #9: the wait says in plain words where to confirm: General on the chat app that holds the card, else the confirm card.
 it.each([["chat",{kind:"chat",code:"x",where:[{platform:"discord",connection:"discord"}]},"First press Confirm on the card in General on Discord, so AgEnD knows it's really you connecting this Fleet."],
  ["no General",{kind:"host_cli",code:"x",reason:"no_chat"},"First confirm on the confirm card that it's really you connecting this Fleet."]])("the wait names where to confirm (%s)",async(_n,confirmation,words)=>{
  fetcher((path,init)=>{
   if(path.endsWith("/start"))return response({result:"pending_confirmation",pending_change:{id:pendingId,state:"pending",remaining_ms:300000,can_withdraw:true,confirmation}},202);
   if(path.includes("/settings/pending/"))return response({id:pendingId,state:"pending",remaining_ms:300000,can_withdraw:true,confirmation});
   return response({ok:true,operation:null});
  });
  const p=await mount(false);await start(p);
  const wait=p.root.querySelector(".company-local-wait");expect(wait).toBeTruthy();
  expect(wait.textContent).toContain(words);expect(wait.textContent).not.toContain("ocal confirmation");
 });
 // M-2988 round 2 #1: a code alone has its own words and no lookup; the administrator's copied text is the address and
 // the code ("Join code included."), and Start sends that code.
 it("the join code: alone it is explained; the copied handoff text connects with it",async()=>{
  fetcher((path)=>path.endsWith("/start")?response({result:"pending_confirmation",pending_change:{id:pendingId,state:"pending",remaining_ms:300000,can_withdraw:true}},202):response({ok:true,operation:null}));
  vi.stubGlobal("open",vi.fn());
  const p=await mount(false);const el=p.root.querySelector("#hubCompanyAddress");const line=()=>p.root.querySelector("#hubCompanyLine").textContent;
  expect(line()).toContain("A join code goes after the address with a space");
  el.value="ab12-cd34";fire(el,"input");await settle(4);fire(el,"blur");await settle(8);
  expect(line()).toBe("That is a join code. Put the Hub address before it, with a space: hub.example.com AB12-CD34");
  expect(calls.some(x=>x.path.endsWith("/probe"))).toBe(false);
  el.value="In AgEnD Settings → Hub, enter hub.example.test and this code.AB12-CD34";fire(el,"input");await settle(4);fire(el,"blur");await settle(10);
  expect(line()).toContain("Join code included.");
  fire(p.root.querySelector("form"),"submit");await settle(12);
  const post=calls.find(x=>x.path.endsWith("/start"));expect(JSON.parse(post.init.body)).toMatchObject({address:"https://hub.example.test",code:"AB12-CD34"});
 });
 // alpha.2 rehearsal findings 3/4: a held attempt (here another session's, refused by the Hub) is shown with why and its
 // Recover/Cancel; a Start the Fleet refuses ("conflict") says so; a waiting tab whose own start never began shows the
 // blocking attempt instead of "Opening Hub sign-in…".
 const held={operationId:"5d2c1a0b-9e8f-4a7b-8c6d-5e4f3a2b1c0d",handoffId:null,state:"held",reason:"code-denied",hubOrigin:"https://hub.example.test",expiresAt:Date.now()+300000,issued:false,outcomeKnown:true,fleetId:null,waiting:null,foreign:true};
 it("another session's held attempt: why, where it came from, Recover/Cancel, and a Start that names the block",async()=>{
  fetcher((path,init)=>path.endsWith("/start")?response({ok:false,error:"conflict"},409):path.includes("/settings/pending")?response({id:pendingId,state:"applied",outcome:{state:"applied"}}):response({ok:true,bound:false,operation:held}));
  vi.stubGlobal("open",vi.fn());
  const p=await mount(false);await settle(10);
  const text=p.root.querySelector(".hub-join-foreign").textContent;
  expect(text).toContain("The Hub did not accept this join code");
  expect(text).toContain("This attempt was started in another browser tab or session. You can recover or cancel it here.");
  expect(btn(p,"Cancel connection")).toBeTruthy();
  expect(btn(p,"Recover this connection")).toBeUndefined();          // a refusal: recovering would only retry the refused code
  expect(p.root.querySelector("#hubCompanyAddress")).toBeTruthy();   // a new Start is offered (the Fleet retires the refused one first)
  await start(p);
  expect(p.root.textContent).toContain("Another connection attempt is still open (shown above). Use “Recover this connection” or “Cancel connection” on it, then start again.");
  fire(btn(p,"Cancel connection"),"click");await settle(10);
  const cancel=calls.find(x=>x.path.endsWith("/cancel"));expect(JSON.parse(cancel.init.body)).toEqual({operationId:held.operationId});
 });
 it("a waiting tab whose start never began shows the attempt that blocks it, not an endless \"Opening Hub sign-in…\"",async()=>{
  fetcher(()=>response({ok:true,bound:false,operation:{...held,reason:"unavailable"}}));
  const p=await mount(true);await settle(10);
  expect(p.root.textContent).not.toContain("Opening Hub sign-in");
  expect(p.root.querySelector(".hub-join-foreign")).toBeTruthy();
  expect(btn(p,"Recover this connection")).toBeTruthy();
 });
});
