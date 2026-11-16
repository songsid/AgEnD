import {afterEach,beforeAll,expect,it,vi} from "vitest";
import {page,h,settle,type AppPage} from "./helpers/app-harness.js";
import {fire} from "./helpers/mini-dom.js";
let ui:any,words:any,clients:any,confirms:any,commands:any;const pages:AppPage[]=[];
beforeAll(async()=>{const p=page();ui=await import("/ui/js/hub-personal-agent.js");words=await import("/assets/app-i18n.js");clients=await import("/ui/js/hub-client.js");confirms=await import("/assets/ui-confirm.js");commands=await import("/ui/js/runtime-commands.js");p.restore();});
afterEach(async()=>{for(const p of pages.splice(0)){await p.unmount();p.restore();}vi.restoreAllMocks();});
const view=()=>({ok:true,enabled:true,canAdd:true,agent:null,computer:{id:"computer",name:"Alex PC",connected:true,compatible:true,folder:"C:\\Shared",working:false,
 clis:[{id:"codex",path:"C:\\codex.exe",available:true,authenticated:true,personalStatus:"ready",models:[{id:"model-one",label:"Model One"}]},{id:"claude-code",path:null,available:false,authenticated:false,personalStatus:"unchecked",models:[]}]}});
const button=(p:AppPage,label:string)=>[...p.root.querySelectorAll("button")].find((b:any)=>b.textContent===label);
const change=(el:any,value:string,event="input")=>{expect(el).toBeTruthy();el.value=value;fire(el,event);};
async function fixture(language="en",value:any=view(),overrides:any={}){
 const p=page({url:"http://127.0.0.1/ui/hub/exposures",storage:{agend_lang:language}});pages.push(p);words.setLang(language,{store:false});
 const client={personalAgent:vi.fn(async()=>value),refreshPersonalAgent:vi.fn(async()=>value),personalEnrollment:vi.fn(async()=>({ok:true,server:"https://hub.example.test",token:"agend_enroll_"+"a".repeat(43),fingerprint:"b".repeat(64),expiresAt:Date.now()+900000,installer:{scriptSha256:"c".repeat(64)}})),
  savePersonalAgent:vi.fn(async(_scope,input)=>{value.agent={id:"personal",exposureId:"exposure",revision:1,shared:false,...input};return {ok:true,exposure:{id:"exposure"}};}),disconnectPersonalAgent:vi.fn(async()=>({ok:true})),...overrides};
 await p.mount(h(ui.HubPersonalAgent,{client,scope:"captured-signin"}));await settle(20);return {p,client};
}
it.each(["en","zh-TW"])("uses the personal read-only disclosure and normal controls (%s)",async language=>{
 const {p}=await fixture(language);expect(p.root.textContent).toContain(language==="en"?"Personal agent":"個人 Agent");expect(p.root.textContent).toContain(language==="en"?"Your own AI account":"自己的 AI 帳號");
 expect(p.root.textContent).toContain("Alex PC");expect(p.root.textContent).toContain("C:\\Shared");expect(p.root.querySelectorAll("section.card")).toHaveLength(1);expect(p.root.textContent).not.toContain("hubPersonal.");
 expect(button(p,language==="en"?"Save personal agent":"儲存個人 Agent")?.disabled).toBe(true);
});
it("uses actual CLI eligibility and keeps Claude's sign-in action beside a refused Codex",async()=>{
 const data=view();Object.assign(data.computer.clis[0],{available:false,personalStatus:"sandbox-unavailable"});Object.assign(data.computer.clis[1],{path:"C:\\claude.exe"});
 const {p}=await fixture("en",data);expect(p.root.textContent).toContain("this version of Windows can't keep it inside one folder");expect(p.root.textContent).toContain("Sign in on that computer");expect(p.root.querySelector("form")).toBeNull();
});
it("shows answers-when-connected and preserves typed fields across a refresh",async()=>{
 const data=view(),{p,client}=await fixture("en",data);const inputs=p.root.querySelectorAll("form input"),select=p.root.querySelector("form select");
 change(inputs[0],"My typed notes");change(select,"codex","change");await settle();data.computer.connected=false;
 fire(button(p,"Refresh"),"click");await settle(20);expect(client.refreshPersonalAgent).toHaveBeenCalledWith("captured-signin");
 expect(p.root.textContent).toContain("Answers when connected");expect(p.root.querySelector("form input")?.value).toBe("My typed notes");expect(button(p,"Save personal agent")?.disabled).toBe(true);
});
it("saves only the named fields and revision under its captured sign-in",async()=>{
 const {p,client}=await fixture();const inputs=p.root.querySelectorAll("form input");change(inputs[0],"Notes");change(inputs[1],"Project notes");change(p.root.querySelector("form select"),"codex","change");await settle();
 fire(p.root.querySelector("form"),"submit");fire(p.root.querySelector("form"),"submit");await settle(20);expect(client.savePersonalAgent).toHaveBeenCalledTimes(1);expect(client.savePersonalAgent).toHaveBeenCalledWith("captured-signin",{name:"Notes",description:"Project notes",cli:"codex",ifRevision:0});
 expect(p.root.textContent).toContain("Choose who may ask");expect(client.savePersonalAgent.mock.calls[0][1]).not.toHaveProperty("owner");
});
it("keeps the enrollment command private until the owner requests one",async()=>{
 const {p,client}=await fixture();expect(client.personalEnrollment).not.toHaveBeenCalled();expect(p.root.querySelector("pre")).toBeNull();fire(button(p,"Use a different computer"),"click");fire(button(p,"Use a different computer"),"click");await settle(20);expect(client.personalEnrollment).toHaveBeenCalledTimes(1);
 expect(client.personalEnrollment).toHaveBeenCalledWith("captured-signin");expect(p.root.querySelector("pre")?.textContent).toContain("agend_enroll_");expect(p.root.textContent).toContain("15 minutes");expect(p.root.querySelectorAll("button").filter((b:any)=>b.textContent==="New command")).toHaveLength(1);expect(button(p,"New command")?.className).toContain("btn-ghost");
 change(p.root.querySelector("form input"),"Notes");change(p.root.querySelector("form select"),"codex","change");await settle();fire(p.root.querySelector("form"),"submit");await settle(20);expect(p.root.querySelector("pre")).toBeNull();
});
it("does not call enrollment while disabled or while the owner lacks permission",async()=>{
 const value=view();value.enabled=false;const f=await fixture("en",value);expect(button(f.p,"Use a different computer")).toBeUndefined();expect(f.client.personalEnrollment).not.toHaveBeenCalled();
});
it("edits named people and teams while keeping settings writes explicit and scoped",async()=>{
 const p=page({url:"http://127.0.0.1/ui/hub/admin"});pages.push(p);words.setLang("en",{store:false});
 const client={personalAgentSettings:vi.fn(async()=>({ok:true,enabled:false,people:["corp/person"],teams:["team-one"],peopleInfo:[{id:"corp/person",name:"Alex",login:"alex"}],teamsInfo:[{id:"team-one",name:"Launch"}]})),
  teams:async()=>({ok:true,teams:[{id:"team-one",name:"Launch"}]}),savePersonalAgentSettings:vi.fn(async v=>({ok:true,...v}))};
 await p.mount(h(ui.HubPersonalAgentAdmin,{client,scope:"admin-signin"}));await settle(20);expect(p.root.textContent).toContain("Alex");expect(p.root.textContent).toContain("Launch");expect(p.root.textContent).not.toContain("corp/person");
 const toggle=p.root.querySelector('input[type="checkbox"]');toggle.checked=true;fire(toggle,"change");await settle();expect(p.root.textContent).toContain("Unsaved changes");fire(p.root.querySelector("form"),"submit");await settle(20);
 expect(p.root.querySelector("select option")?.textContent).toBe("Choose a team");expect(client.savePersonalAgentSettings).toHaveBeenCalledWith("admin-signin",{enabled:true,people:["corp/person"],teams:["team-one"]});
});

it("refuses late personal writes after another person signs in",async()=>{
 let token="first";const calls:any[]=[];const client=clients.createHubWebClient({fetchImpl:async(path:string,options:any)=>{calls.push({path,options});return new Response(JSON.stringify(path.endsWith("/session")?{signedIn:true,csrf:token,features:["personal-agents-v1"]}:{}),{status:200});}});
 await client.session();token="second";await client.signIn("another","fixture");const before=calls.length;
 expect(await client.savePersonalAgent("first",{name:"Late"})).toMatchObject({ok:false});expect(await client.personalEnrollment("first")).toMatchObject({ok:false});expect(calls).toHaveLength(before);
 expect((await client.savePersonalAgent("second",{name:"Current"})).ok).toBe(true);expect(calls.at(-1).options.headers["X-AgEnD-Hub-CSRF"]).toBe("second");
});
it("drops a previous sign-in's late owner read",async()=>{
 let release!:(value:any)=>void;const old=new Promise(resolve=>{release=resolve;}),p=page();pages.push(p);words.setLang("en",{store:false});
 const client={personalAgent:vi.fn((scope:string)=>scope==="old"?old:Promise.resolve({...view(),computer:{...view().computer,name:"Current computer"}}))};
 await p.mount(h(ui.HubPersonalAgent,{client,scope:"old"}));await settle();await p.mount(h(ui.HubPersonalAgent,{client,scope:"new"}));await settle(20);
 release({...view(),computer:{...view().computer,name:"Previous person's computer"}});await settle(20);
 expect(p.root.textContent).toContain("Current computer");expect(p.root.textContent).not.toContain("Previous person's computer");
});

it("retries an unavailable administrator read with the shared error state",async()=>{
 const p=page();pages.push(p);words.setLang("en",{store:false});
 const client={personalAgentSettings:vi.fn().mockResolvedValueOnce({ok:false}).mockResolvedValue({ok:true,enabled:false,people:[],teams:[]}),teams:async()=>({ok:true,teams:[]})};
 await p.mount(h(ui.HubPersonalAgentAdmin,{client,scope:"admin"}));await settle(20);expect(p.root.querySelector("form")).toBeNull();expect(p.root.querySelector('[role="alert"]')).toBeTruthy();
 fire(p.root.querySelector(".error-state button"),"click");await settle(20);expect(p.root.querySelector("form")).toBeTruthy();expect(client.personalAgentSettings).toHaveBeenCalledTimes(2);
});

it("retries a failed person search without saving the administrator's unsaved policy",async()=>{
 const p=page();pages.push(p);words.setLang("en",{store:false});
 const client={personalAgentSettings:async()=>({ok:true,enabled:false,people:[],teams:[]}),teams:async()=>({ok:true,teams:[]}),teamSuggestions:vi.fn().mockResolvedValueOnce({ok:false}).mockResolvedValue({ok:true,candidates:[]}),savePersonalAgentSettings:vi.fn()};
 await p.mount(h(ui.HubPersonalAgentAdmin,{client,scope:"admin"}));await settle(20);change(p.root.querySelector('input[type="search"]'),"Alex");await settle();fire(button(p,"Search"),"click");await settle(20);
 fire(p.root.querySelector(".error-state button"),"click");await settle(20);expect(client.teamSuggestions).toHaveBeenCalledTimes(2);expect(client.savePersonalAgentSettings).not.toHaveBeenCalled();expect(p.root.querySelector(".error-state")).toBeNull();
});

it("keeps sharing primary until configured, and replacement/disconnect quiet at the bottom",async()=>{
 const data:any=view();data.agent={id:"personal",exposureId:"exposure",revision:1,name:"Notes",cli:"codex",shared:false};
 const {p,client}=await fixture("en",data);expect(p.root.textContent).toContain("Not shared yet. Nobody can ask this agent.");
 expect(p.root.querySelector('a.btn-primary')?.getAttribute("href")).toBe("/ui/hub/exposures?agent=exposure");
 expect(button(p,"Use a different computer")?.className).toContain("btn-ghost");expect(button(p,"Disconnect computer")?.className).toContain("btn-danger");
 (globalThis as any).confirm=undefined;fire(button(p,"Disconnect computer"),"click");fire(button(p,"Disconnect computer"),"click");await settle();const q=confirms.confirmStore.get().queue;
 expect(q).toHaveLength(1);expect(q[0]).toMatchObject({danger:true,confirmLabel:"Disconnect",message:"Disconnect this computer? The agent stops answering. Nothing on the computer is deleted or uninstalled."});
 confirms.answerConfirm(q[0].id,false);await settle();expect(client.disconnectPersonalAgent).not.toHaveBeenCalled();
 data.agent.shared=true;fire(button(p,"Refresh"),"click");await settle(20);expect(p.root.textContent).not.toContain("Not shared yet.");expect(p.root.querySelector('a.btn-primary')).toBeNull();expect(p.root.querySelector("a")?.textContent).toBe("Change who may ask");expect(p.root.querySelector("a")?.parentElement?.className).toBe("field-row");
});
it("leaves an unavailable CLI out of the selector while explaining it separately",async()=>{
 const data=view();Object.assign(data.computer.clis[0],{available:false,personalStatus:"sandbox-unavailable"});Object.assign(data.computer.clis[1],{available:true,authenticated:true,path:"C:/claude"});
 const {p}=await fixture("en",data);expect([...p.root.querySelector("form select").querySelectorAll("option")].map((o:any)=>o.value)).toEqual(["","claude-code"]);
 expect(p.root.textContent).toContain("Can be used");expect(p.root.textContent).toContain("this version of Windows can't keep it inside one folder");
});
it("offers a new command after expiry",async()=>{
 const data:any=view();data.computer=null;const {p}=await fixture("en",data,{personalEnrollment:async()=>({ok:true,expiresAt:Date.now()-1})});
 fire(button(p,"Add a personal agent"),"click");await settle(20);expect(p.root.querySelector("pre")).toBeNull();expect(p.root.textContent).toContain("This command has expired.");expect(button(p,"New command")).toBeTruthy();
});
it("keeps certificate help in a closed disclosure and personal terminal advice safe",async()=>{
 const data:any=view();data.computer=null;const next=await fixture("en",data);fire(button(next.p,"Add a personal agent"),"click");await settle(20);expect(next.p.root.querySelector("details")?.getAttribute("open")).toBeNull();
 expect(next.p.root.textContent).toContain("Don't change security settings to get past it.");expect(button(next.p,"Copy command")?.className).toContain("btn-primary");
 const ordinary=commands.runtimeInstallCommand("https://hub.example.test","a".repeat(64)),personal=commands.runtimeInstallCommand("https://hub.example.test","a".repeat(64),"personal");
 expect(ordinary).toContain("or use the ZIP");expect(personal).not.toContain("or use the ZIP");expect(personal).toContain("Don''t change security settings");expect(personal).toContain("if ($s -and $h -eq");
});
