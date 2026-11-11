/** Story5 is presentation of existing group/invitation/manual authority, never a new permission source. */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { page, h, settle, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";
let panel:any, company:any, clients:any, words:any;const pages:AppPage[]=[];
const link="https://hub.example.test/join-info#hub=ZXhhY3QtaWRlbnRpdHk",invite="https://hub.example.test/join-info#invite=ZXhhY3QtaW52aXRl";
const until=async(fn:()=>unknown)=>{for(let i=0;i<100&&!fn();i++)await settle(5);expect(fn()).toBeTruthy();};
beforeAll(async()=>{const p=page();panel=await import("/ui/js/panel-hub.js");company=await import("/ui/js/hub-company-join.js");clients=await import("/ui/js/hub-client.js");words=await import("/assets/app-i18n.js");p.restore();});
afterEach(async()=>{for(const p of pages.splice(0)){await p.unmount();p.restore();}panel.resetHubSession();clients.setHubClient(null);vi.restoreAllMocks();vi.unstubAllGlobals();});
async function fixture(o:{lang?:string;enabled?:boolean;admin?:boolean;marked?:boolean;groups?:boolean;held?:Promise<any>;card?:boolean;retainedLink?:boolean;pendingManual?:boolean}={}){
 const p=page({url:"https://hub.example.test/ui/hub/admin",storage:{agend_lang:o.lang??"en"}});pages.push(p);words.setLang(o.lang??"en");let enabled=o.enabled??true;
 const calls:any[]=[],copy=vi.fn(async()=>{});vi.stubGlobal("navigator",{clipboard:{writeText:copy}});
 const session={ok:true,signedIn:true,displayName:"Ada Admin",login:"ada",admin:o.admin!==false,csrf:"exact-csrf",features:[...(o.marked===false?[]:["company-join-v1"]),...(o.groups===false?[]:["group-policy-v1"])]};
 const c={stub:false,web:true,groupPolicyV1:true,onSignedOut:()=>()=>{},session:vi.fn(async()=>session),rooms:async()=>({ok:true,rooms:[]}),catalog:async()=>({ok:true,askable:[]}),adminOverview:vi.fn(async()=>({ok:true,fleets:[],pairings:o.pendingManual?[{id:"p",ownerConfirmed:true,adminApproved:false,fingerprint:"f".repeat(64)}]:[]})),createPairing:vi.fn(async()=>({ok:true,code:"PAIR1234",expiresAt:Date.now()+60000,memberOrigin:"https://member.example.test"}))};clients.setHubClient(c);
 vi.stubGlobal("fetch",vi.fn(async(path:string,init:any={})=>{calls.push({path,init});let body:any;
  if(path==="/hub/v1/admin/company-join/invitations")body={ok:true,url:invite};
  else if(path==="/hub/v1/admin/company-join"){if(init.method==="PUT")enabled=JSON.parse(init.body).enabled;if(o.held&&init.method==="GET")return o.held;body={ok:true,enabled,revision:4,companyLink:enabled||o.retainedLink?link:null};}
  else body={ok:true};return{ok:true,status:200,json:async()=>body};}));
 await p.mount(h(o.card?company.CompanyJoinAdminCard:panel.HubPanel,o.card?{entry:true,groups:true}:{route:{panel:"hub",tab:"admin"}}));await settle(30);return{p,c,calls,copy};
}
const btn=(p:AppPage,text:string)=>[...p.root.querySelectorAll("button")].find((e:any)=>e.textContent===text);
describe("Administration leads with existing group and individual connection controls",()=>{
 it.each(["en","zh-TW"])("one leading access card, copy action, individual invitations; manual pairing under Advanced (%s)",async lang=>{
  const f=await fixture({lang});await until(()=>f.p.root.querySelector(".hub-admin-access"));
  const first=f.p.root.querySelector(".hub-admin .s-section-layout").firstElementChild;expect(first.getAttribute("data-entry")).toBe("allowed-groups-people");
  expect(first.textContent).toContain(lang==="en"?"Allowed groups and people":"允許的群組與人員");expect(first.querySelector('a[href="/ui/hub/admin?view=groups"]')).toBeTruthy();
  expect(first.querySelectorAll(".hub-company-guide li")).toHaveLength(3); expect(first.textContent).toContain(lang === "en" ? "Allowed groups need no further approval" : "允許的群組不需要另外核准");
  expect(first.querySelector(".hub-admin-individual")).toBeTruthy();expect(first.textContent).toContain(lang==="en"?"does not grant permission":"不會授予");
  const advanced=f.p.root.querySelector("details.hub-admin-manual");expect(advanced).toBeTruthy();expect(advanced.open).toBe(false);expect(advanced.querySelector("#hubOwnerLogin")).toBeTruthy();
  expect(f.calls.every(x=>x.init.method==="GET")).toBe(true);expect(f.copy).not.toHaveBeenCalled();expect(f.c.createPairing).not.toHaveBeenCalled();
 });
 it("copies only the exact server-supplied identity link, without creating a code or invitation",async()=>{
  const f=await fixture();await until(()=>btn(f.p,"Copy colleague connection link"));fire(btn(f.p,"Copy colleague connection link"),"click");await settle(10);
  expect(f.copy).toHaveBeenCalledExactlyOnceWith(link);expect(f.calls.every(x=>x.init.method==="GET")).toBe(true);expect(f.c.createPairing).not.toHaveBeenCalled();
 });
 it("off stays off, with a reason for the disabled copy; enabling uses the existing revision and CSRF",async()=>{
  const f=await fixture({enabled:false});await until(()=>f.p.root.querySelector('input[role="switch"]'));
  expect(btn(f.p,"Copy colleague connection link").disabled).toBe(true);expect(f.p.root.textContent).toContain("Turn on company-account Fleet connections");expect(f.p.root.querySelector(".hub-admin-individual")).toBeNull();
  const input=f.p.root.querySelector('input[role="switch"]');input.checked=true;fire(input,"change");await settle(15);
  const write=f.calls.find(x=>x.init.method==="PUT");expect(JSON.parse(write.init.body)).toEqual({enabled:true,expectedRevision:4});expect(write.init.headers["X-AgEnD-Hub-CSRF"]).toBe("exact-csrf");expect(f.copy).not.toHaveBeenCalled();
 });
 it("an off response with a retained public link still cannot offer copying or an invitation",async()=>{
  const f=await fixture({enabled:false,retainedLink:true});await until(()=>f.p.root.querySelector('.hub-admin-access input[role="switch"]'));
  expect(btn(f.p,"Copy colleague connection link").disabled).toBe(true);expect(f.p.root.querySelector(".hub-admin-individual")).toBeNull();expect(f.copy).not.toHaveBeenCalled();
 });
 it("Advanced reveals a manual pairing already waiting for explicit admin approval",async()=>{
  const f=await fixture({pendingManual:true});await until(()=>f.p.root.querySelector("details.hub-admin-manual"));expect(f.p.root.querySelector("details.hub-admin-manual").open).toBe(true);
 });
 it("an explicit individual invitation keeps the existing endpoint and scoped login body",async()=>{
  const f=await fixture();await until(()=>f.p.root.querySelector(".hub-admin-individual input"));const input=f.p.root.querySelector(".hub-admin-individual input");input.value="eligible-colleague";fire(input,"input");await settle(4);fire(f.p.root.querySelector(".hub-admin-individual form"),"submit");await settle(12);
  const post=f.calls.find(x=>x.init.method==="POST");expect(post.path).toBe("/hub/v1/admin/company-join/invitations");expect(JSON.parse(post.init.body)).toEqual({login:"eligible-colleague"});expect(post.init.headers["X-AgEnD-Hub-CSRF"]).toBe("exact-csrf");expect(f.copy).not.toHaveBeenCalled();
  fire(btn(f.p,"Copy invitation"),"click");await settle(6);expect(f.copy).toHaveBeenCalledExactlyOnceWith(invite);expect(btn(f.p,"Copy colleague connection link")).toBeTruthy();
 });
 it("an unread settings response does not claim joining is off or offer a copy",async()=>{
  let resolve!:(v:any)=>void;const held=new Promise(r=>{resolve=r;}),f=await fixture({held});
  await until(()=>f.calls.some(x=>x.path==="/hub/v1/admin/company-join"));
  expect(f.p.root.textContent).not.toContain("Turn on company-account Fleet connections");expect(btn(f.p,"Copy colleague connection link").disabled).toBe(true);
  await f.p.unmount();resolve({ok:true,status:200,json:async()=>({ok:true,enabled:true,revision:4,companyLink:link})});await settle(15);expect(f.copy).not.toHaveBeenCalled();
 });
 it("missing company feature retains the earlier group/manual entry and performs no company read",async()=>{
  const f=await fixture({marked:false});await until(()=>f.p.root.querySelector(".hub-groups-entry"));expect(f.p.root.querySelector(".hub-admin-access")).toBeNull();expect(f.p.root.querySelector("details.hub-admin-manual")).toBeNull();expect(f.calls).toEqual([]);
 });
 it("a non-admin gets no controls or company lookup",async()=>{const f=await fixture({admin:false});expect(f.p.root.querySelector(".hub-admin-access")).toBeNull();expect(f.calls).toEqual([]);});
 it("old panels using the default component retain its existing company card",async()=>{
  const f=await fixture();await f.p.unmount();await f.p.mount(h(company.CompanyJoinAdminCard));await settle(20);expect(f.p.root.textContent).toContain("Company sign-in joining");expect(f.p.root.querySelector(".hub-admin-access")).toBeNull();
 });
});
