/** M-2722: actual mounted join panel, bounded local confirmation and unchanged-read polling. */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { page, h, settle, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";
let panel: any, confirmations: any;
const mounted: AppPage[] = [], calls: any[] = [];
const handoff = "0f1e2d3c-4b5a-4968-8776-655443322110", pendingId = "a".repeat(32);
beforeAll(async () => {
 const p = page(); panel = await import("/ui/js/settings-hub-company-join.js"); confirmations = await import("/ui/js/settings-confirm.js"); p.restore();
});
afterEach(async () => {
 for (const p of mounted.splice(0)) { await p.unmount(); p.restore(); }
 confirmations.resetConfirmations(); vi.restoreAllMocks(); vi.unstubAllGlobals(); calls.length = 0;
});
function response(body: any, status = 200) { return { ok: status < 400, status, json: async () => body }; }
function fetcher(fn: (path: string, init: any) => any) {
 vi.stubGlobal("fetch", vi.fn(async (path: string, init: any = {}) => { calls.push({path,init}); return fn(path,init); }));
}
async function mount(waiting = true) {
 const p = page({url:"http://127.0.0.1:19290/settings/hub"+(waiting?"?joinWait="+handoff:""),storage:{agend_lang:"en"}});mounted.push(p);
 await p.mount(h(panel.CompanyJoinSettings));await settle(10);return p;
}
const btn = (p: AppPage, text: string) => [...p.root.querySelectorAll("button")].find((b: any) => b.textContent === text);
function clock() {
 const timers = new Map<number, {fn:()=>any;ms:number}>();let seq=100000;const real = globalThis.setTimeout;
 vi.spyOn(globalThis,"setTimeout").mockImplementation(((fn:any,ms:any,...args:any[]) => {
  if(ms===1500 || ms>=290000 && ms<=300000){const id=++seq;timers.set(id,{fn,ms:ms>=290000?300000:ms});return id as any;}return real(fn,ms,...args);
 }) as any);
 const clear=globalThis.clearTimeout;vi.spyOn(globalThis,"clearTimeout").mockImplementation(((id:any)=>{timers.delete(id);return clear(id);}) as any);
 return { fire(ms:number){const e=[...timers].find(([,v])=>v.ms===ms);expect(e).toBeTruthy();timers.delete(e![0]);return e![1].fn();},async next(ms:number){const e=[...timers].find(([,v])=>v.ms===ms);expect(e,`no timer ${ms}`).toBeTruthy();timers.delete(e![0]);await e![1].fn();await settle(10);},count(ms:number){return [...timers.values()].filter(t=>t.ms===ms).length;} };
}
async function start(p: AppPage) {
 vi.stubGlobal("open",vi.fn());
 for(const [id,value]of [["hubCompanyAddress","https://hub.example.test"],["hubCompanyFleetName","QA Fleet"]]){const el=p.root.querySelector("#"+id);el.value=value;fire(el,"input");}
 await settle(4);fire(p.root.querySelector("form"),"submit");await settle(12);
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
 it("a loaded empty handoff is a confirmation wait, not an endless loading skeleton; it has a direct action and an exit",async()=>{
  fetcher(()=>response({ok:true,operation:null}));const p=await mount();
  expect(p.root.querySelector(".skeleton")).toBeNull();
  expect(p.root.textContent).toContain("Company sign-in has not started");
  expect(btn(p,"Review local confirmation")).toBeTruthy();
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
 it("a different handoff never redirects this waiting tab",async()=>{
  const c=clock(),replace=vi.fn();fetcher(()=>response({ok:true,operation:{operationId:handoff,handoffId:"other",state:"awaiting-sign-in"}}));
  await mount();(globalThis.location as any).replace=replace;await c.next(1500);await c.next(1500);expect(replace).not.toHaveBeenCalled();
 });
 it("one slow status read retains physical ownership across polling and Retry; unmount retires its continuation",async()=>{
  const c=clock();let finish:any;fetcher(()=>new Promise(resolve=>{finish=resolve;}));const p=await mount();
  const poll=c.fire(1500);await settle(4);expect(calls).toHaveLength(1);
  await c.next(300000);fire(btn(p,"Check again"),"click");await settle(4);expect(calls).toHaveLength(1);
  await p.unmount();finish(response({ok:true,operation:{operationId:handoff,handoffId:handoff,state:"awaiting-sign-in"}}));await poll;await settle(6);
  expect(calls).toHaveLength(1);expect(c.count(1500)).toBe(0);expect(p.root.textContent).toBe("");
 });
 it("the five-minute pre-operation wait ends visibly, stops automatic reads and can inspect the same result without submitting Start",async()=>{
  const c=clock();fetcher(()=>response({ok:true,operation:null}));const p=await mount();
  await c.next(300000);expect(p.root.textContent).toContain("Local confirmation has not completed");
  expect(p.root.querySelector(".skeleton")).toBeNull();expect(c.count(1500)).toBe(0);
  expect(btn(p,"Check again")).toBeTruthy();const before=calls.length;fire(btn(p,"Check again"),"click");await settle(10);
  expect(calls.length).toBeGreaterThan(before);expect(calls.every(x=>!x.init.method||x.init.method==="GET")).toBe(true);
  expect(p.root.querySelector("form")).toBeNull();
 });
 it("the original Start exposes its exact confirmation and withdraws only that request",async()=>{
  heldFetch();const p=await mount(false);await start(p);expect(btn(p,"Review local confirmation")).toBeTruthy();
  const other=p.document.createElement("section");other.setAttribute("data-pending","b".repeat(32));other.className="pending-card";const wrong=vi.fn();other.scrollIntoView=wrong;p.root.appendChild(other);
  const exact=p.document.createElement("section");exact.setAttribute("data-pending",pendingId);exact.className="pending-card";const scroll=vi.fn();exact.scrollIntoView=scroll;p.root.appendChild(exact);
  fire(btn(p,"Review local confirmation"),"click");expect(scroll).toHaveBeenCalledOnce();expect(wrong).not.toHaveBeenCalled();
  fire(btn(p,"Withdraw connection request"),"click");await settle(14);
  expect(calls.filter(x=>x.init.method==="DELETE")).toMatchObject([{path:"/api/settings/pending/"+pendingId}]);
  expect(calls.filter(x=>x.init.method==="POST")).toHaveLength(1);
  expect(p.root.textContent).toContain("Local confirmation was withdrawn");
  expect(p.root.textContent).not.toContain("could not be verified");
  expect(p.root.textContent).not.toContain("Fleet connected");
 });
 it("a lost withdrawal keeps the original Start held rather than inventing cancellation or permitting another Start",async()=>{
  heldFetch(false);const p=await mount(false);await start(p);fire(btn(p,"Withdraw connection request"),"click");await settle(12);
  expect(p.root.textContent).toContain("could not be verified");
  expect(btn(p,"Sign in with company account").disabled).toBe(true);
  expect(calls.filter(x=>x.init.method==="POST")).toHaveLength(1);
 });
 it("a local pending timeout does not apply, silently withdraw or retry the held change",async()=>{
  const c=clock();heldFetch();const p=await mount(false);await start(p);await c.next(300000);
  expect(p.root.textContent).toContain("Local confirmation has not completed");
  expect(btn(p,"Withdraw connection request")).toBeTruthy();expect(btn(p,"Sign in with company account").disabled).toBe(true);
  expect(calls.filter(x=>x.init.method==="POST")).toHaveLength(1);expect(calls.filter(x=>x.init.method==="DELETE")).toHaveLength(0);
 });
});
