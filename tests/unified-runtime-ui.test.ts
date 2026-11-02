import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";

let p:AppPage, app:any, nav:any, shell:any, chat:any, catalog:any, NativeSettings:any;
const realFetch=globalThis.fetch;
const listeners=new Map<string,Array<(value:any)=>void>>();
const sent:Array<{path:string;method:string;body:any}>=[];
const nativeId="12345678-1234-4321-abcd-123456789012";
let sequence=0, nativeName="";
const nativeRow=()=>({name:nativeName,display_name:"Master",runtime:"windows",native_agent_id:nativeId,status:"running",state:"idle",execution_state:"idle",backend:"codex",model:"gpt-5.5",capabilities:{terminal:false,attachments:false,commands:false,usage:false,lifecycle:true,send_while_busy:false}});
const linuxRow={name:"linux-agent",status:"running",state:"idle",execution_state:"idle",backend:"claude-code"};
const emit=(event:string,value:any)=>{for(const listener of listeners.get(event)||[])listener(value);};
const fetchFake=async(path:string,options:any={})=>{
  const body=options.body?JSON.parse(options.body):undefined;
  sent.push({path,method:options.method||"GET",body});
  const result=path.startsWith("/ui/history")?{messages:[{boot:"migrated",id:1,instance:nativeName,role:"agent",sender:"Master",text:"Imported Windows conversation",ts:"2026-11-02T00:00:00Z"}]}:
    path==="/ui/windows-cli/probe"?{home:"C:\\Test",clis:[{id:"codex",path:"C:\\codex.exe",runnable:true,readOnlySupport:true,models:[]}]}:
    path==="/ui/send"?{sent:true,messageId:"shared-delivery"}:
    path===`/ui/windows-cli/agents/${nativeId}`?{agent:{id:nativeId,name:"Master",cli:"codex",cwd:"C:\\Test",sandbox:"read-only",turns:[]}}:{};
  return {ok:true,status:200,json:async()=>result};
};
beforeAll(async()=>{
  p=page({url:"http://localhost/ui",storage:{agend_lang:"en",agend_tour_done:"1"}});
  globalThis.fetch=fetchFake as any;
  const {setLang}=await import("/assets/app-i18n.js");setLang("en",{store:false});
  app=await import("/assets/app-store.js");nav=await import("/assets/app-nav.js");shell=await import("/assets/app-shell.js");
  chat=await import("/ui/js/panel-chat.js");catalog=await import("/ui/js/windows-cli-catalog.js");
  NativeSettings=(await import("/ui/js/native-instance-settings.js")).NativeInstanceSettings;
  chat.boot({stream:{on(event:string,listener:(value:any)=>void){const rows=listeners.get(event)||[];rows.push(listener);listeners.set(event,rows);return()=>{};}},boot:null,deps:{fetch:fetchFake}});
  nav.startRouter(p.window);
});
beforeEach(()=>{
  sent.length=0;nativeName=`native-${++sequence}`;catalog.forgetWindowsCliCatalog();
  const status={instances:[linuxRow,nativeRow()],windows_cli:true,uptime:1};app.applyStatus(status);emit("status",status);
  nav.navigate(`/ui/chat/${nativeName}`);
});
afterEach(async()=>{await p.unmount();chat.forgetKeptThreads();catalog.forgetWindowsCliCatalog();});
afterAll(()=>{p.restore();globalThis.fetch=realFetch;});
const mountNative=async()=>{await p.mount(h(chat.ChatPanel,{route:{panel:"chat",instance:nativeName},navKey:`chat:${nativeName}`}));await settle(8);};

describe("one fleet UI across runtimes",()=>{
  it("lists Windows and Linux in the same sidebar and common chat addresses",async()=>{
    app.appStore.set({windowsAgentsNav:()=>h("div",{class:"old-native-list"},"Windows Agents")});
    const panels=new Map([["chat",{load:async()=>()=>h("div",{},"Shared chat")}]]);
    await p.mount(h(shell.Shell,{panels,onNewInstance(){}}));await settle(8);
    const roster=p.root.querySelector("#instanceList");
    expect(roster.textContent).toContain("Master");expect(roster.textContent).toContain("linux-agent");expect(roster.textContent).toContain("Windows");
    expect(roster.querySelector(`a[href="/ui/chat/${nativeName}"]`)).not.toBeNull();
    const nativeLink=roster.querySelector(`a[href="/ui/chat/${nativeName}"]`);
    expect(nativeLink.textContent).not.toContain(nativeName);expect(nativeLink.querySelector(".inst-alt")?.textContent).toBe("Codex");
    expect(p.root.querySelector(".old-native-list, .windows-agent-nav")).toBeNull();
  });
  it("uses shared history, message rendering and the shared send endpoint for Windows",async()=>{
    await mountNative();expect(p.root.querySelector(".p-chat")).not.toBeNull();expect(p.root.querySelector(".p-windows-agent")).toBeNull();
    expect(p.root.textContent).toContain("Imported Windows conversation");
    expect(p.root.querySelector(".msg.agent .sender")?.textContent).toBe("Master");
    expect(p.root.querySelector(".msg.user")).toBeNull();
    expect(p.root.querySelector('[role="log"]').getAttribute("aria-label")).toContain("Master");
    expect(p.root.querySelector('[role="log"]').getAttribute("aria-label")).not.toContain(nativeName);
    const input=p.root.querySelector("#msgIn");input.value="A Windows message";fire(input,"input");await settle();
    p.root.querySelector("#sendBtn").click();await settle(8);
    expect(sent.find(item=>item.path==="/ui/send")?.body).toMatchObject({instance:nativeName,message:"A Windows message"});
    expect(sent.some(item=>item.path.startsWith("/ui/windows-cli/agents"))).toBe(false);
    emit("message",{boot:"shared",id:2,instance:nativeName,role:"agent",sender:"Renamed Assistant",text:"Shared SSE reply",ts:"2026-11-02T00:01:00Z"});await settle(6);
    expect(p.root.textContent).toContain("Shared SSE reply");
    expect(p.root.querySelectorAll(".msg.agent")).toHaveLength(2);
    expect(p.root.querySelectorAll(".msg.user")).toHaveLength(1);
  });
  it("uses the server role even when a person's sender name looks like an agent ID",async()=>{
    await mountNative();
    emit("message",{boot:"shared",id:3,instance:nativeName,role:"user",sender:nativeName,text:"Person using the same name",ts:"2026-11-02T00:02:00Z"});await settle(6);
    const person=p.root.querySelector(".msg.user");
    expect(person?.textContent).toContain("Person using the same name");
    expect(p.root.querySelectorAll(".msg.agent")).toHaveLength(1);
  });
  it("gates native terminal and attachment controls without changing Linux controls",async()=>{
    await mountNative();expect(p.root.querySelector("#attachBtn")).toBeNull();
    expect(p.root.querySelector(".hd-usage")).toBeNull();
    expect(p.root.querySelector(".composer-row .hint").getAttribute("title")).not.toContain("commands");
    expect(p.root.querySelectorAll(".inst-switch a").map((item:any)=>item.textContent)).toEqual(["Chat"]);
    const drop=fire(p.root.querySelector(".p-chat"),"drop",{dataTransfer:{types:["Files"],files:[{name:"test.txt",size:1,type:"text/plain"}]}});await settle();
    expect(drop.defaultPrevented).toBe(true);expect(sent.some(item=>item.path.startsWith("/ui/upload"))).toBe(false);
    await p.mount(h(chat.ChatPanel,{route:{panel:"chat",instance:"linux-agent"},navKey:"chat:linux-agent"}));await settle(6);
    expect(p.root.querySelector("#attachBtn")).not.toBeNull();
    expect(p.root.querySelector(".hd-usage")).not.toBeNull();
    expect(p.root.querySelectorAll(".inst-switch a").map((item:any)=>item.textContent)).toEqual(["Chat","View","Log","Details"]);
  });
  it("keeps a Windows draft while the native worker is busy",async()=>{
    const status={instances:[linuxRow,{...nativeRow(),native_busy:true}],windows_cli:true};app.applyStatus(status);emit("status",status);
    await mountNative();const input=p.root.querySelector("#msgIn");input.value="Keep my draft";fire(input,"input");await settle();
    expect(p.root.querySelector("#sendBtn").disabled).toBe(true);fire(input,"keydown",{key:"Enter"});await settle();
    expect(input.value).toBe("Keep my draft");expect(sent.some(item=>item.path==="/ui/send")).toBe(false);
    expect(p.root.textContent).toContain("Your draft is kept");
  });
  it("keeps a remote draft while its computer is offline and enables sending after reconnect",async()=>{
    const remote={...nativeRow(),machine_id:nativeId,machine_name:"Build desktop",machine_status:"offline"};
    const status={instances:[linuxRow,remote],windows_cli:true};app.applyStatus(status);emit("status",status);
    await mountNative();expect(p.root.querySelector(".runtime-machine-tag").textContent).toBe("Build desktop");
    expect(p.root.querySelector(".runtime-machine-offline").textContent).toBe("Computer offline");
    const input=p.root.querySelector("#msgIn");input.value="Keep remote draft";fire(input,"input");await settle();fire(input,"keydown",{key:"Enter"});await settle();
    expect(p.root.querySelector("#sendBtn").disabled).toBe(true);expect(input.value).toBe("Keep remote draft");expect(sent.some(item=>item.path==="/ui/send")).toBe(false);
    expect(p.root.querySelector(".runtime-machine-unavailable").textContent).toContain("Build desktop");
    const online={instances:[linuxRow,{...remote,machine_status:"online"}],windows_cli:true};app.applyStatus(online);emit("status",online);await settle();
    expect(p.root.querySelector("#sendBtn").disabled).toBe(false);expect(input.value).toBe("Keep remote draft");expect(p.root.querySelector(".runtime-machine-unavailable")).toBeNull();
  });
  it("shows a remote computer on the same Instances row without changing its Agent state",async()=>{
    const status={instances:[linuxRow,{...nativeRow(),machine_id:nativeId,machine_name:"Build desktop",machine_status:"offline"}],windows_cli:true};app.applyStatus(status);emit("status",status);
    const panels=new Map([["chat",{load:async()=>()=>h("div",{},"Shared chat")}]]);await p.mount(h(shell.Shell,{panels,onNewInstance(){}}));await settle(8);
    const link=p.root.querySelector(`a[href="/ui/chat/${nativeName}"]`);expect(link.querySelector(".inst-machine").textContent).toContain("Build desktop");expect(link.querySelector(".inst-machine").textContent).toContain("Computer offline");
    expect(link.getAttribute("title")).toContain("Status: Running");
    // S-30: the name and the status are separate, so the name is what gives way on a narrow row — never the status.
    expect(link.querySelector(".inst-machine .inst-machine-name").textContent).toBe("Build desktop");
    expect(link.querySelector(".inst-machine .inst-machine-status").textContent).toBe("Computer offline");
  });
  it("offers explicit interrupted-process recovery on the shared chat",async()=>{
    const status={instances:[linuxRow,{...nativeRow(),native_blocked:true}],windows_cli:true};app.applyStatus(status);emit("status",status);
    await mountNative();const recover=p.root.querySelectorAll("button").find((button:any)=>button.textContent.includes("Processes stopped"));
    expect(recover).toBeTruthy();recover.click();await settle(6);
    expect(sent.find(item=>item.path===`/ui/instances/${nativeName}/recover`)?.body).toEqual({confirmedStopped:true});
  });
  it("keeps unsupported CLI commands as drafts instead of sending them to Linux controls",async()=>{
    await mountNative();const input=p.root.querySelector("#msgIn");input.value="/clear";fire(input,"input");await settle();
    expect(p.root.querySelector("#cmdPalette")).toBeNull();p.root.querySelector("#sendBtn").click();await settle();
    expect(input.value).toBe("/clear");expect(sent.some(item=>item.path==="/ui/command"||item.path==="/ui/send")).toBe(false);
  });
  it("deletes a native instance through the common endpoint after typed confirmation",async()=>{
    await mountNative();p.root.querySelector(".panel-head .menu > button").click();await settle();
    p.root.querySelectorAll('[role="menuitem"]').find((button:any)=>/Delete/i.test(button.textContent)).click();await settle();
    const input=p.root.querySelector("dialog input");input.value=`delete ${nativeName}`;fire(input,"input");await settle();
    p.root.querySelector("dialog .btn-danger").click();await settle(6);
    expect(sent.find(item=>item.path===`/ui/instances/${nativeName}`&&item.method==="DELETE")).toBeTruthy();
    expect(sent.some(item=>item.path===`/ui/instances/${nativeName}/delete`)).toBe(false);
  });
  it("stages supported native metadata through the same settings editor",async()=>{
    const stageAgent=vi.fn();const inst={runtime:"windows",native_agent_id:nativeId,backend:"codex",display_name:"Master",working_directory:"C:\\Workspace",native_sandbox:"read-only",model:"",description:"",systemPrompt:"",tags:[]};
    await p.mount(h(NativeSettings,{name:nativeName,inst,ctx:{shortName:()=>"Master",stageAgent},onClose(){}}));await settle(8);
    const fields=p.root.querySelectorAll(".native-instance-settings input");fields[0].value="Renamed";fire(fields[0],"input");await settle();
    expect(fields.find((field:any)=>field.value==="C:\\Workspace").getAttribute("aria-readonly")).toBe("true");
    p.root.querySelectorAll("dialog button").find((button:any)=>button.textContent.trim()==="Done").click();await settle();
    expect(stageAgent).toHaveBeenCalledWith(nativeName,inst,{display_name:"Renamed"});
    expect(p.root.querySelector("#ag-auto")).toBeNull();
  });
});
