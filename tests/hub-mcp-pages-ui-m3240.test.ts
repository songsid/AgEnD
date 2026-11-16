import {afterEach,beforeAll,expect,it,vi} from "vitest";
import {page,h,settle,type AppPage} from "./helpers/app-harness.js";
import {fire} from "./helpers/mini-dom.js";
import {hubConnectorPrompt} from "../src/ui/shared/connector-prompt.js";
import {render} from "/assets/preact.module.js";
const pages:AppPage[]=[];let ui:any,words:any;
beforeAll(async()=>{const p=page();ui=await import("/ui/js/hub-ai-apps.js");words=await import("/assets/app-i18n.js");p.restore();});
afterEach(async()=>{for(const p of pages.splice(0)){await p.unmount();p.restore();}vi.restoreAllMocks();});
const button=(p:AppPage,label:string)=>[...p.root.querySelectorAll("button")].find((b:any)=>b.textContent===label);
async function mount(name="AppConsentPage",language="en",overrides:any={},props:any={}){
 const p=page({url:"https://hub.example.com/ui/hub?view=app-consent&request=owned",storage:{agend_lang:language}});pages.push(p);words.setLang(language,{store:false});const ended=new Set<()=>void>();
 const client={aiAppsScope:()=>"owned-scope",appConsent:vi.fn(async()=>({ok:true,name:"Example AI",scopes:[...ui.APP_SCOPES],redirectOrigin:"http://127.0.0.1:43123"})),saveAppConsent:vi.fn(async()=>({ok:true,location:"http://127.0.0.1:43123/callback?code=owned"})),
  aiApps:vi.fn(async()=>({ok:true,address:"https://hub.example.com/mcp",available:true,apps:[{id:"app-one",name:"Example AI",scopes:[...ui.APP_SCOPES],connectedAt:1800000000000,lastUsedAt:1800000001000}]})),disconnectAiApp:vi.fn(async()=>({ok:true})),
  aiAppsSettings:vi.fn(async()=>({ok:true,revision:1,enabled:false,everyone:true,subjects:[]})),saveAiAppsSettings:vi.fn(async()=>({ok:true,revision:2,enabled:true,everyone:true,subjects:[]})),
  teams:vi.fn(async()=>({ok:true,teams:[]})),teamsLive:()=>true,searchAiAppSubjects:vi.fn(async()=>({ok:true,people:[],groups:[]})),
  onSignedOut:(fn:()=>void)=>{ended.add(fn);return()=>ended.delete(fn);},...overrides};
 const returnTo=vi.fn();await p.mount(h(ui[name],{client,request:"owned",person:"Casey",returnTo,...props}));await settle(15);
 const link=p.document.querySelector('link[data-hub-apps-css="1"]');expect(link?.getAttribute("href")).toBe("/assets/hub-ai-apps.css");fire(link!,"load");await settle(20);
 return{p,client,returnTo,end:()=>{for(const fn of ended)fn();}};
}
it.each(["en","zh-TW"])("draws three selected consent scopes and the disabled later permission (%s)",async language=>{
 const{p}=await mount("AppConsentPage",language);const fields=[...p.root.querySelectorAll('input[type="checkbox"]')];expect(fields).toHaveLength(4);expect(fields.slice(0,3).every((x:any)=>x.checked&&!x.disabled)).toBe(true);expect(fields[3].checked).toBe(false);expect(fields[3].disabled).toBe(true);
 expect(p.root.textContent).toContain("Casey");expect(p.root.textContent).toContain(language==="en"?"provider":"服務商");expect(button(p,language==="en"?"Allow":"允許")).toBeTruthy();
});
it("sends only the chosen scopes and follows a validated callback, without a caller identity",async()=>{
 const{p,client,returnTo}=await mount();const read=p.root.querySelector('[data-app-scope="rooms:read"]');read.checked=false;fire(read,"change");await settle(5);fire(button(p,"Allow"),"click");await settle(15);
 expect(client.saveAppConsent).toHaveBeenCalledExactlyOnceWith("owned-scope","owned",{scopes:["rooms:post","agents:ask"]});expect(returnTo).toHaveBeenCalledExactlyOnceWith("http://127.0.0.1:43123/callback?code=owned");
});
it("discloses an HTTPS app's return origin independently of its unverified name",async()=>{
 const{p}=await mount("AppConsentPage","en",{appConsent:vi.fn(async()=>({ok:true,name:"Claude Code",scopes:[...ui.APP_SCOPES],redirectOrigin:"https://other-app.example"}))});
 expect(p.root.textContent).toContain("https://other-app.example");expect(p.root.textContent).toContain("started from that app or site");expect(p.root.textContent).toContain("The Hub can't check who made it");
});
it("shows a local callback and refuses Allow with no selected scope or no disclosed destination",async()=>{
 const{p,client}=await mount();expect(p.root.textContent).toContain("This app is running on this computer.");expect(p.root.textContent).toContain("http://127.0.0.1:43123");
 for(const input of p.root.querySelectorAll("[data-app-scope]")){input.checked=false;fire(input,"change");await settle(1);}await settle(5);expect(button(p,"Allow").disabled).toBe(true);fire(button(p,"Allow"),"click");await settle(5);expect(client.saveAppConsent).not.toHaveBeenCalled();
});
it("keeps the manual disclosure closed and gives generic apps an address instead of a prompt button",async()=>{
 const{p}=await mount("MyAiAppsPage");expect(p.root.querySelector("details.s-ui-disclosure").open).not.toBe(true);expect(p.root.textContent).toContain("Set it up by hand");expect(p.root.textContent).toContain("Paste this into Claude Code");expect(button(p,"Copy address").className).toContain("btn-primary");
 const select=p.root.querySelector("select");select.value="generic";fire(select,"change");await settle(5);expect(button(p,"Copy setup prompt")).toBeUndefined();expect(p.root.textContent).toContain("Add the address above as a remote MCP server");expect(p.root.textContent).toContain("May:");
});
it("uses short connected dates, relative last use and disabled choices while app access is off",async()=>{
 const{p}=await mount("AiAppsAdminCard");expect([...p.root.querySelectorAll('input[type="radio"]')].every(input=>input.disabled)).toBe(true);
 const now=Date.UTC(2026,10,16,12),dates=ui.appConnectionDates(now,now-120000,now);expect(dates).toContain("16 Nov");expect(dates).toContain("2 minutes ago");
});
it("retires queued app reads and writes after another sign-in instead of using the new person's cookie",async()=>{
 const{createHubWebClient}=await import("/ui/js/hub-client.js");let csrf="first";const calls:any[]=[];
 const client=createHubWebClient({fetchImpl:async(path:any,init:any)=>{calls.push([path,init]);return{ok:true,status:200,headers:{get:()=>null},json:async()=>({signedIn:true,csrf})};}});
 await client.session();const old=client.aiAppsScope();csrf="second";await client.signIn("another","owned");const count=calls.length;
 for(const read of[()=>client.aiApps(old),()=>client.appConsent(old,"old-request"),()=>client.aiAppsSettings(old),()=>client.searchAiAppSubjects(old,"person","Casey")])expect((await read()).ok).toBe(false);
 for(const write of[()=>client.saveAppConsent(old,"old-request",{cancel:true}),()=>client.disconnectAiApp(old,"app-one"),()=>client.saveAiAppsSettings(old,{}),()=>client.setRoomAiApps(old,"room-one",false)])expect((await write()).ok).toBe(false);
 expect(calls).toHaveLength(count);
});
it("cancels explicitly and never treats a script return address as a callback",async()=>{
 const{p,client,returnTo}=await mount("AppConsentPage","en",{saveAppConsent:vi.fn(async()=>({ok:true,location:"javascript:alert(1)"}))});fire(button(p,"Cancel"),"click");await settle(15);
 expect(client.saveAppConsent).toHaveBeenCalledExactlyOnceWith("owned-scope","owned",{cancel:true});expect(returnTo).not.toHaveBeenCalled();expect(p.root.textContent).toContain("return address");
});
it("retires a held consent result after sign-out",async()=>{
 let finish!:(value:any)=>void;const{p,returnTo,end}=await mount("AppConsentPage","en",{saveAppConsent:vi.fn(()=>new Promise(r=>{finish=r;}))});fire(button(p,"Allow"),"click");await settle(5);end();await settle(5);finish({ok:true,location:"http://127.0.0.1:43123/callback?code=owned"});await settle(15);
 expect(returnTo).not.toHaveBeenCalled();expect(p.root.textContent).toContain("Sign in again");
});
it("retires a held consent result when another app request replaces the page",async()=>{
 let finish!:(value:any)=>void;const{p,client,returnTo}=await mount("AppConsentPage","en",{saveAppConsent:vi.fn(()=>new Promise(r=>{finish=r;}))});fire(button(p,"Allow"),"click");await settle(5);
 await p.mount(h(ui.AppConsentPage,{client,request:"new-request",person:"Casey",returnTo}));await settle(10);finish({ok:true,location:"https://app.example.com/callback?code=old"});await settle(15);expect(returnTo).not.toHaveBeenCalled();
});
it("hides the previous consent identity synchronously when a new request starts loading",async()=>{
 const{p,client,returnTo}=await mount();expect(p.root.textContent).toContain("Example AI");client.appConsent.mockImplementationOnce(()=>new Promise(()=>{}));
 render(h(ui.AppConsentPage,{client,request:"different-request",person:"Casey",returnTo}),p.root);
 expect(p.root.textContent).not.toContain("Example AI");expect(button(p,"Allow")).toBeUndefined();
});
it.each(["en","zh-TW"])("shows connections and disconnects only the selected app (%s)",async language=>{
 const{p,client}=await mount("MyAiAppsPage",language);expect(p.root.textContent).toContain("Example AI");expect(p.root.querySelector('input[type="url"]').value).toBe("https://hub.example.com/mcp");
 client.aiApps.mockResolvedValue({ok:true,address:"https://hub.example.com/mcp",available:true,apps:[]});fire(button(p,language==="en"?"Disconnect":"中斷連接"),"click");await settle(20);expect(client.disconnectAiApp).toHaveBeenCalledExactlyOnceWith("owned-scope","app-one");expect(p.root.textContent).not.toContain("Example AI");
});
it("saves the administrator's default-off policy and exact selected-person subject",async()=>{
 const{p,client}=await mount("AiAppsAdminCard","en",{searchAiAppSubjects:vi.fn(async()=>({ok:true,people:[{person:{realm:"corp",objectId:"person-a"},login:"casey",displayName:"Casey"}]}))});
 const enabled=p.root.querySelector('[role="switch"]');expect(enabled.checked).toBe(false);enabled.checked=true;fire(enabled,"change");const radio=p.root.querySelectorAll('input[type="radio"]')[1];fire(radio,"change");await settle(10);
 const kind=p.root.querySelector("[data-subject-kind]");kind.value="person";fire(kind,"change");await settle(10);const input=p.root.querySelector('input[type="search"]');input.value="Ca";fire(input,"input");await settle(330);fire(button(p,"Choose"),"click");await settle(10);fire(button(p,"Save"),"click");await settle(15);
 expect(client.saveAiAppsSettings).toHaveBeenCalledExactlyOnceWith("owned-scope",{revision:1,enabled:true,everyone:false,subjects:[{kind:"person",id:"corp/person-a",name:"Casey"}]});
});
it("renders app labels as text and refuses all controls on a denied consent",async()=>{
 const{p,client}=await mount("AppConsentPage","en",{appConsent:vi.fn(async()=>({ok:false,status:403}))});expect(p.root.textContent).toContain("administrator");expect(button(p,"Allow")).toBeUndefined();expect(client.saveAppConsent).not.toHaveBeenCalled();
});
it("sends browser-only URLs and CSRF through the existing Hub client",async()=>{
 const{createHubWebClient}=await import("/ui/js/hub-client.js");const calls:any[]=[];
 const client=createHubWebClient({fetchImpl:async(path:any,init:any)=>{calls.push([path,init]);return{ok:true,status:200,headers:{get:()=>null},json:async()=>path==="/hub/v1/session"?{signedIn:true,csrf:"owned-csrf",features:["mcp-apps-v1"]}:{}};}});
 await client.session();const scope=client.aiAppsScope();await client.appConsent(scope,"opaque&other=x");await client.saveAppConsent(scope,"opaque",{scopes:["rooms:read"]});await client.disconnectAiApp(scope,"app-one");await client.searchAiAppSubjects(scope,"person","Casey & Riley");await client.setRoomAiApps(scope,"room-one",false);
 expect(calls[1][0]).toBe("/hub/v1/mcp/consent?request=opaque%26other%3Dx");expect(calls[2][1].headers["X-AgEnD-Hub-CSRF"]).toBe("owned-csrf");expect(JSON.parse(calls[2][1].body)).toEqual({request:"opaque",scopes:["rooms:read"]});
 expect(calls[3][1].method).toBe("DELETE");expect(calls[4][0]).toBe("/hub/v1/admin/ai-apps/search?kind=person&q=Casey+%26+Riley");expect(JSON.parse(calls[5][1].body)).toEqual({enabled:false});expect(calls.every(([,init])=>init.credentials==="same-origin"&&!init.headers.Authorization)).toBe(true);
});
it.each(["en","zh-TW"])("localizes a quiet app rate line in the viewer's language (%s)",async language=>{
 const p=page();pages.push(p);words.setLang(language,{store:false});const{systemText}=await import("/ui/js/hub-room-thread.js");
 expect(systemText({system:{kind:"app-rate-limited",name:"Casey"},text:"Stored fallback"})).toBe(language==="en"?"Casey's AI app was slowed down.":"Casey 的 AI App 被放慢了。");
});
it("links the whole Hub panel and keeps an app request on the signed-out sign-in page",async()=>{
 const p=page({url:"https://hub.example.com/ui/hub?view=app-consent&request=owned"});pages.push(p);words.setLang("en",{store:false});
 const panel=await import("/ui/js/panel-hub.js"),clients=await import("/ui/js/hub-client.js");panel.resetHubSession();clients.setHubClient({session:async()=>({ok:true,signedIn:false}),onSignedOut:()=>()=>{}});
 try{await p.mount(h(panel.HubPanel,{route:{panel:"hub",tab:"ask"}}));await settle(20);expect(p.root.querySelector("#hubLogin")).toBeTruthy();expect(p.root.textContent).not.toContain("This tab is older");expect(p.window.location.search).toContain("request=owned");}
 finally{await p.unmount();panel.resetHubSession();clients.setHubClient(null);}
});
it("mounts the actual app consent query view in the signed-in Hub panel",async()=>{
 const p=page({url:"https://hub.example.com/ui/hub?view=app-consent&request=owned"});pages.push(p);words.setLang("en",{store:false});
 const panel=await import("/ui/js/panel-hub.js"),clients=await import("/ui/js/hub-client.js");const consent=vi.fn(async()=>({ok:true,name:"Example AI",scopes:[...ui.APP_SCOPES],redirectOrigin:"http://127.0.0.1:43123"}));panel.resetHubSession();clients.setHubClient({session:async()=>({ok:true,signedIn:true,displayName:"Casey",features:["mcp-apps-v1"]}),roomList:async()=>({ok:true,rooms:[]}),appConsent:consent,onSignedOut:()=>()=>{}});
 try{await p.mount(h(panel.HubPanel,{route:{panel:"hub",tab:"ask"}}));await settle(25);const link=p.document.querySelector('link[data-hub-apps-css="1"]');expect(link).toBeTruthy();fire(link!,"load");await settle(20);expect(consent).toHaveBeenCalledWith(undefined,"owned");expect(p.root.textContent).toContain("Let Example AI use this Hub as you?");}
 finally{await p.unmount();panel.resetHubSession();clients.setHubClient(null);}
});
it.each(["claude","codex","generic"])("builds a remote-only setup prompt for %s and rejects secret-bearing addresses",app=>{
 const text=hubConnectorPrompt("https://hub.example.com/mcp",app,k=>({prompt:"Set up {app}",config:"Configuration",claude:"Claude Code",codex:"Codex",generic:"MCP app"}[k]||k));
 expect(text).toContain("https://hub.example.com/mcp");expect(text).not.toMatch(/command|wsl\.exe|access_token|client_secret/);for(const url of["http://hub.example.com/mcp","https://person:secret@hub.example.com/mcp","https://hub.example.com/mcp?token=secret"])expect(hubConnectorPrompt(url,app,k=>k)).toBe("");
});
