import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";
let p:AppPage,C:any,i18n:any,requestLog:Array<{url:string;method:string;body:any}>=[],failure:string|null=null,revision=0;
beforeAll(async()=>{p=page({url:"http://127.0.0.1:19281/settings/accounts"});C=await import("/ui/js/claude-credentials.js");i18n=await import("/assets/app-i18n.js");});
afterAll(()=>{p.restore();delete (globalThis as any).fetch;});
beforeEach(async()=>{
 await p.unmount();i18n.setLang("en",{store:false});requestLog=[];failure=null;revision=0;
 (globalThis as any).fetch=async(url:string,options:any={})=>{
  const method=options.method||"GET",body=options.body?JSON.parse(options.body):null;requestLog.push({url:String(url),method,body});
  if(failure)return {ok:false,status:403,json:async()=>({error:failure})};
  return {ok:true,status:200,json:async()=>({credential:method==="GET"?null:{id:"11111111-1111-4111-8111-111111111111",revision:++revision,kind:body.kind,state:"saved-unverified",source:"managed"}})};
 };
});
async function mount(initial="subscription",onClose=()=>{}){await p.mount(h(C.ClaudeCredentialsDialog,{profile:"spare",initial,onClose}));await settle(12);}
const text=()=>p.root.textContent;
const button=(label:string)=>[...p.root.querySelectorAll("button")].find((el:any)=>el.textContent===label);
it("EN/zh methods have localized new-tab help and keep source acquisition outside the dashboard",async()=>{
 for(const language of ["en","zh-TW"]){await p.unmount();i18n.setLang(language,{store:false});await mount();
  expect(p.root.querySelectorAll('input[type="radio"]')).toHaveLength(3);
  const links=[...p.root.querySelectorAll('a.credential-help')] as any[];expect(links).toHaveLength(3);
  for(const link of links){expect(link.getAttribute("target")).toBe("_blank");expect(link.getAttribute("rel")).toContain("noopener");expect(link.getAttribute("href")).toContain(language==="zh-TW"?"/zh-tw/docs/claude-credentials/#":"/docs/claude-credentials/#");}
  expect(text()).not.toContain("Design preview");expect(text()).not.toContain("設計預覽");expect(requestLog.every(r=>r.method==="GET")).toBe(true);
 }
});
it("save sends a synthetic secret once to the bound local API, then clears the field and reports unverified",async()=>{
 await mount("api");const input=p.root.querySelector('input[type="password"]') as any;expect(button("Save credential").disabled).toBe(true);input.value="synthetic-"+"x".repeat(48);fire(input,"input");await settle(4);expect(button("Save credential").disabled).toBe(false);
 fire(button("Save credential"),"click");await settle(16);
 const writes=requestLog.filter(r=>r.method==="PUT");expect(writes).toHaveLength(1);expect(writes[0]).toMatchObject({url:"/ui/claude-credentials",body:{profile:"spare",revision:0,kind:"api-key"}});
 expect(input.value).toBe("");expect(text()).toContain("Saved · not verified");expect(text()).not.toContain(writes[0].body.value);
});
it("method switch, close and unmount clear a typed value without sending it",async()=>{
 let closed=0;await mount("oauth",()=>closed++);let input=p.root.querySelector('input[type="password"]') as any;input.value="synthetic-"+"x".repeat(48);
 fire([...p.root.querySelectorAll("input")].find((el:any)=>el.value==="api"),"change");await settle(8);expect(input.value).toBe("");
 input=p.root.querySelector('input[type="password"]') as any;input.value="synthetic-"+"x".repeat(48);fire(button("Cancel"),"click");expect(input.value).toBe("");expect(closed).toBe(1);
 await p.unmount();await mount("api");input=p.root.querySelector('input[type="password"]') as any;input.value="synthetic-"+"x".repeat(48);await p.unmount();expect(input.value).toBe("");expect(requestLog.every(r=>r.method==="GET")).toBe(true);
});
it("local authority refusal is actionable and performs no write",async()=>{
 failure="credential_local_verified_required";await mount("api");expect(text()).toContain("local dashboard");expect(text()).toContain("verify");expect(requestLog.every(r=>r.method==="GET")).toBe(true);
});
it("managed rows suppress a prior identity, subscription meters and keep-alive even with stale metadata",async()=>{
 const A=await import("/ui/js/accounts-view.js"),S=await import("/ui/js/backend-signin.js");
 const row={scope:{kind:"host"},backend:"claude-code",profile:"spare",state:"usable",signIn:true,credential:{source:"managed",kind:"setup-token",revision:1},identity:{maskedEmail:"old@example.com",plan:"max"},usageGroups:[{windows:[{kind:"weekly",percent:42}]}],keepAlive:{enabled:true},usedBy:{agents:[],classic:[],fleetDefault:false}};
 const view={clis:[{backend:"claude-code",profiles:true,installed:true,agents:[],rows:[row]}]};(globalThis as any).fetch=async(url:string)=>({ok:true,status:200,json:async()=>String(url).startsWith("/ui/accounts")?view:{selected:[],pending:[],login:null,targets:[]}});
 A.accountsStore.set({loaded:true,failed:false,view});S.signInStore.set({loaded:true,targets:[],login:null});
 await p.mount(h(A.AccountsView,{instances:{}}));await settle(8);expect(text()).toContain("Subscription token");expect(text()).toContain("Saved · not verified");expect(text()).not.toContain("old@example.com");expect(text()).not.toContain("42%");expect(text()).not.toContain("Keep sign-in alive");
});

it("a local Subscription selection binds its source before continuing the original sign-in flow",async()=>{
 let continued=0;await p.mount(h(C.ClaudeCredentialsDialog,{profile:"spare",continueSubscription:()=>continued++,onClose:()=>{}}));await settle(10);
 fire(button("Continue to sign in"),"click");await settle(4);expect(continued).toBe(1);expect(requestLog.filter(r=>r.method==="POST")).toEqual([{url:"/ui/claude-credentials",method:"POST",body:{profile:"spare",revision:0,source:"subscription",confirm:true}}]);
 expect(C.credentialError("credential_session-changed")).toContain("verify");
});
