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
 const c={stub:false,web:true,groupPolicyV1:true,onSignedOut:()=>()=>{},session:vi.fn(async()=>session),rooms:async()=>({ok:true,rooms:[]}),catalog:async()=>({ok:true,askable:[]}),adminOverview:vi.fn(async()=>({ok:true,fleets:[],pairings:o.pendingManual?[{id:"p",ownerConfirmed:true,adminApproved:false,fingerprint:"f".repeat(64)}]:[]})),createPairing:vi.fn(async()=>({ok:true,code:"PAIR1234",expiresAt:Date.now()+60000,memberOrigin:"https://member.example.test"})),
  groupPolicy:vi.fn(async()=>({ok:true,groupPolicyV1:true,supported:true,binding:"ready",policy:{realm:"example",generation:"g1",revision:3,state:"never-enabled",groups:[],denies:[]},paused:[]})),
  searchGroups:vi.fn(async()=>({ok:true,groups:[],truncated:false})),resolveGroup:vi.fn(),previewGroupPolicy:vi.fn(),saveGroupPolicy:vi.fn()};clients.setHubClient(c);
 vi.stubGlobal("fetch",vi.fn(async(path:string,init:any={})=>{calls.push({path,init});let body:any;
  if(path==="/hub/v1/admin/company-join/invitations")body={ok:true,url:invite};
  else if(path==="/hub/v1/admin/company-join"){if(init.method==="PUT")enabled=JSON.parse(init.body).enabled;if(o.held&&init.method==="GET")return o.held;body={ok:true,enabled,revision:4,companyLink:enabled||o.retainedLink?link:null};}
  else body={ok:true};return{ok:true,status:200,json:async()=>body};}));
 await p.mount(h(o.card?company.CompanyJoinAdminCard:panel.HubPanel,o.card?{entry:true,groups:true}:{route:{panel:"hub",tab:"admin"}}));await settle(30);return{p,c,calls,copy};
}
const btn=(p:AppPage,text:string)=>[...p.root.querySelectorAll("button")].find((e:any)=>e.textContent===text);
describe("Administration leads with existing group and individual connection controls",()=>{
// Hub UX U2 (spec 1.2 / 1.5): the leading card is 「讓同仁加入」 (three steps). The long link lives only under 進階 and is never
// copied by a button; individual invitations stay, folded. Opening the page still writes nothing.
 it.each(["en","zh-TW"])("one leading card with three steps, individual invitations folded; manual pairing under Advanced (%s)",async lang=>{
  const f=await fixture({lang});await until(()=>f.p.root.querySelector(".hub-join-card"));
  const first=f.p.root.querySelector(".hub-admin .s-section-layout").firstElementChild;expect(first.getAttribute("data-entry")).toBe("let-colleagues-join");
  expect(first.querySelector("h3").textContent).toBe(lang==="en"?"Let colleagues join":"讓同仁加入");
  expect([...first.querySelectorAll("li[data-step]")].map((li:any)=>li.getAttribute("data-step"))).toEqual(["1","2","3"]);
  expect(first.querySelector("details.hub-admin-individual")).toBeTruthy();expect(first.querySelector("details.hub-admin-individual").open).toBeFalsy();
  const advanced=f.p.root.querySelector("details.hub-admin-manual");expect(advanced).toBeTruthy();expect(advanced.open).toBe(false);expect(advanced.querySelector("#hubOwnerLogin")).toBeTruthy();
  expect(f.calls.every(x=>x.init.method==="GET")).toBe(true);expect(f.copy).not.toHaveBeenCalled();expect(f.c.createPairing).not.toHaveBeenCalled();
 });
 it("the long link is only under 「含金鑰指紋的連結（進階）」: exactly the server's link, no copy button, nothing written",async()=>{
  const f=await fixture();await until(()=>f.p.root.querySelector(".hub-join-advanced"));
  expect(f.p.root.querySelector(".hub-join-advanced").open).toBeFalsy();expect(f.p.root.querySelector(".hub-join-advanced textarea").value).toBe(link);
  expect(btn(f.p,"Copy colleague connection link")).toBeUndefined();
  expect(f.calls.every(x=>x.init.method==="GET")).toBe(true);expect(f.copy).not.toHaveBeenCalled();expect(f.c.createPairing).not.toHaveBeenCalled();
 });
 it("off: step 1 not done, step 3 off with its reason, no invitation, no link; enabling uses the existing revision and CSRF",async()=>{
  const f=await fixture({enabled:false});await until(()=>f.p.root.querySelector('li[data-step="1"] input[role="switch"]'));
  expect(f.p.root.querySelector('li[data-step="3"] button').disabled).toBe(true);expect(f.p.root.textContent).toContain("Finish steps 1 and 2 first.");
  expect(f.p.root.querySelector(".hub-admin-individual")).toBeNull();expect(f.p.root.querySelector(".hub-join-advanced")).toBeNull();
  const input=f.p.root.querySelector('li[data-step="1"] input[role="switch"]');input.checked=true;fire(input,"change");await settle(15);
  const write=f.calls.find(x=>x.init.method==="PUT");expect(JSON.parse(write.init.body)).toEqual({enabled:true,expectedRevision:4});expect(write.init.headers["X-AgEnD-Hub-CSRF"]).toBe("exact-csrf");expect(f.copy).not.toHaveBeenCalled();
 });
 it("an off response with a retained public link still offers neither the link nor an invitation",async()=>{
  const f=await fixture({enabled:false,retainedLink:true});await until(()=>f.p.root.querySelector('.hub-join-card input[role="switch"]'));
  expect(f.p.root.querySelector(".hub-join-advanced")).toBeNull();expect(f.p.root.querySelector(".hub-admin-individual")).toBeNull();expect(f.copy).not.toHaveBeenCalled();
 });
 it("Advanced reveals a manual pairing already waiting for explicit admin approval",async()=>{
  const f=await fixture({pendingManual:true});await until(()=>f.p.root.querySelector("details.hub-admin-manual"));expect(f.p.root.querySelector("details.hub-admin-manual").open).toBe(true);
 });
 it("an explicit individual invitation keeps the existing endpoint and scoped login body",async()=>{
  const f=await fixture();await until(()=>f.p.root.querySelector(".hub-admin-individual input"));const input=f.p.root.querySelector(".hub-admin-individual input");input.value="eligible-colleague";fire(input,"input");await settle(4);fire(f.p.root.querySelector(".hub-admin-individual form"),"submit");await settle(12);
  const post=f.calls.find(x=>x.init.method==="POST");expect(post.path).toBe("/hub/v1/admin/company-join/invitations");expect(JSON.parse(post.init.body)).toEqual({login:"eligible-colleague"});expect(post.init.headers["X-AgEnD-Hub-CSRF"]).toBe("exact-csrf");expect(f.copy).not.toHaveBeenCalled();
  fire(btn(f.p,"Copy invitation"),"click");await settle(6);expect(f.copy).toHaveBeenCalledExactlyOnceWith(invite);
 });
 it("an unread settings response does not claim joining is off, and offers no link or copy",async()=>{
  let resolve!:(v:any)=>void;const held=new Promise(r=>{resolve=r;}),f=await fixture({held});
  await until(()=>f.calls.some(x=>x.path==="/hub/v1/admin/company-join"));
  expect(f.p.root.querySelector('li[data-step="1"] input[role="switch"]')).toBeNull();expect(f.p.root.querySelector('li[data-step="3"] button').disabled).toBe(true);
  expect(f.p.root.querySelector(".hub-join-advanced")).toBeNull();
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
