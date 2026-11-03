import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";
let p: AppPage, Dialog: any, app: any, parser: any, catalog: any, modelCatalog: any, WindowsCliPanel: any;
const realFetch=globalThis.fetch;
const sent: Array<{path:string;body:any}> = [];
const id="12345678-1234-4321-abcd-123456789012";
const canonicalName="windows-assistant";
const managedCwd=`C:\\Users\\Test\\.agend\\workspaces\\${id}`;
let draftResult: Record<string,string> | null = null;
const defaultProbe = () => ({home:"C:\\Test",clis:[{id:"codex",path:"C:\\codex.exe",authenticated:true,runnable:true}]});
let probe: { home: string; clis: any[] } = defaultProbe();
let probeFetch: (() => Promise<any>) | null = null;
function deferredProbe() {
  let resolve!: (value:any) => void;
  const promise=new Promise<any>(done=>{resolve=done;});
  return {promise,resolve};
}
const probeResponse=(data=probe)=>({ok:true,status:200,json:async()=>data});
const probeRequests=()=>sent.filter(request=>request.path==="/ui/windows-cli/probe");
const allCliProbe = () => ({home:"C:\\Test",clis:[
  {id:"codex",path:"C:\\codex.exe",version:"Codex 0.162.1",authenticated:true,runnable:true,supports:{execution:true,resume:true},readOnlySupport:true,models:[{id:"gpt-5.5",label:"GPT-5.5"}]},
  {id:"claude-code",path:"C:\\claude.exe",version:"Claude 2.1.299",authenticated:true,runnable:true,supports:{execution:true,resume:true},readOnlySupport:true,models:[{id:"sonnet",label:"Claude Sonnet"}]},
  {id:"antigravity",path:"C:\\antigravity.exe",version:"Antigravity 1.4.12",authenticated:true,runnable:true,supports:{execution:true,resume:true},readOnlySupport:false,models:[]},
  {id:"grok",path:"C:\\grok.exe",version:"Grok 1.0.46",authenticated:true,runnable:true,supports:{execution:true,resume:true},readOnlySupport:false,models:[]},
  ...["kiro-cli","opencode","muse"].map(id=>({id,path:null,version:null,authenticated:null,runnable:false,supports:{execution:true,resume:true},readOnlySupport:false,models:[]})),
]});
const button = (name:string) => p.root.querySelectorAll("dialog button").find((b:any)=>b.textContent.trim()===name);
async function choose(runtime:string) { const input=p.root.querySelectorAll(".agent-runtime-picker input").find((i:any)=>i.value===runtime); input.checked=true;fire(input,"change");await settle(4); }
async function next() { button("Next").click();await settle(4); }
const cliTrigger = () => p.root.querySelector(".agent-create-cli .cli-picker-trigger");
const cliOptions = () => p.root.querySelectorAll('[role="menuitemradio"]');
async function chooseCli(id:string) {
  cliTrigger().click();await settle();
  const option=cliOptions().find((item:any)=>item.querySelector(`[data-cli="${id}"]`));
  expect(option,`CLI option ${id}`).toBeTruthy();option.click();await settle();
}
async function openWindows() {
  app.appStore.set({windowsCli:true});
  await p.mount(h(Dialog,{onClose(){}}));await settle(8);await choose("windows");
}
async function setWindowsIdentity(name="Windows helper") {
  const inputs=p.root.querySelectorAll(".agent-runtime-fields input");
  inputs[0].value="J:\\Game";fire(inputs[0],"input");await settle();
  inputs[1].value=name;fire(inputs[1],"input");await settle();
}
const modelSelect = () => p.root.querySelector(".agent-runtime-fields .model-pick select");
const permissionSelect = () => p.root.querySelector("#native-create-sandbox");
async function setNativePermissions() { const select=permissionSelect();select.value="workspace-write";fire(select,"change");await settle(); }
async function setOtherModel(model:string) {
  const select=modelSelect();select.value="\u0000other";fire(select,"change");await settle();
  const input=p.root.querySelector(".model-pick input");input.value=model;fire(input,"input");await settle();
}
beforeAll(async () => {
  p=page({url:"http://localhost/ui",storage:{agend_lang:"en"}});
  (globalThis as any).fetch=async (path:string,options:any={})=>{
    const body=options.body?JSON.parse(options.body):null;
    if(options.method==="POST")sent.push({path,body});
    if(path==="/ui/windows-cli/probe"&&probeFetch)return probeFetch();
    const data=path.startsWith("/ui/models?")?{models:probe.clis.find(cli=>cli.id===new URL(path,"http://localhost").searchParams.get("backend"))?.models || []}:path==="/ui/backends"?{backends:[{name:"codex",installed:true}]}:path==="/ui/windows-cli/probe"?probe:path==="/ui/instances"&&body?.runtime==="windows"?{name:canonicalName,runtime:"windows",agent:{id,name:body.topic_name,cli:body.backend,cwd:body?.directory || managedCwd}}:path==="/ui/windows-cli/tasks"?{tasks:[]}:path.startsWith("/ui/windows-cli/tasks/")&&draftResult?{status:"completed",output:JSON.stringify(draftResult)}:{};
    return {ok:true,status:200,json:async()=>data};
  };
  app=await import("/assets/app-store.js");
  const {setLang}=await import("/assets/app-i18n.js");setLang("en",{store:false});
  const nav=await import("/assets/app-nav.js");nav.startRouter(p.window);
  Dialog=(await import("/ui/js/panel-fleet.js")).CreateInstanceDialog;
  parser=(await import("/ui/js/agent-runtime.js")).parseAgentDraft;
  catalog=await import("/ui/js/windows-cli-catalog.js");
  modelCatalog=await import("/ui/js/settings-catalog.js");
  WindowsCliPanel=(await import("/ui/js/panel-windows-cli.js")).WindowsCliPanel;
});
beforeEach(()=>{probe=defaultProbe();probeFetch=null;draftResult=null;catalog.forgetWindowsCliCatalog();modelCatalog.forgetCatalogs();});
afterEach(async()=>{await p.unmount();catalog.forgetWindowsCliCatalog();sent.length=0;});
afterAll(()=>{p.restore();globalThis.fetch=realFetch;});
describe("runtime-first creation",()=>{
  it("asks for a runtime before showing runtime-specific fields",async()=>{
    app.appStore.set({windowsCli:true});
    await p.mount(h(Dialog,{onClose(){}}));await settle(6);
    expect(p.root.querySelector(".agent-runtime-picker")).not.toBeNull();
    expect(p.root.querySelector(".agent-runtime-fields")).toBeNull();
    expect(button("Next").disabled).toBe(true);
    await choose("windows");
    expect(p.root.querySelector(".agent-runtime-fields")).toBeNull();
    expect(p.root.querySelector(".agent-draft-assistant")).toBeNull();
    expect(button("Create")).toBeUndefined();
    await next();
    expect(p.root.querySelector(".agent-runtime-picker")).toBeNull();
    expect(p.root.querySelector(".agent-runtime-fields")).not.toBeNull();
    expect(p.root.querySelector(".agent-draft-assistant")).not.toBeNull();
    expect(sent.some(r=>r.path==="/ui/windows-cli/agents" || r.path==="/ui/instances")).toBe(false);
  });
  it("creates a Windows instance through the common endpoint with its runtime and native directory",async()=>{
    app.appStore.set({windowsCli:true});
    await p.mount(h(Dialog,{onClose(){}}));await settle(8);
    await choose("windows");await next();
    const inputs=p.root.querySelectorAll(".agent-runtime-fields input");
    inputs[0].value="J:\\Game";fire(inputs[0],"input");await settle();
    inputs[1].value="Windows Game";fire(inputs[1],"input");await settle();
    button("Create").click();await settle(8);
    expect(sent.find(r=>r.path==="/ui/instances")?.body).toMatchObject({runtime:"windows",topic_name:"Windows Game",backend:"codex",directory:"J:\\Game",sandbox:"read-only"});
    expect(sent.some(r=>r.path==="/ui/windows-cli/agents")).toBe(false);
    expect(p.root.querySelector('.agent-create-wizard').getAttribute("data-step")).toBe("3");
    expect(p.root.querySelector(".agent-create-success")?.textContent).toContain("Windows Game");
    expect(p.root.querySelector(".agent-runtime-fields")).toBeNull();
    expect(button("Create")).toBeUndefined();
    button("Open chat").click();await settle(4);
    expect(p.window.location.pathname).toBe(`/ui/chat/${canonicalName}`);
    expect(sent.filter(r=>r.path==="/ui/instances").length).toBe(1);
  });
  it("creates a general Windows agent with just a name and shows its returned managed workspace",async()=>{
    await openWindows();await next();
    const inputs=p.root.querySelectorAll(".agent-runtime-fields input");
    expect(inputs[0].value).toBe("");expect(inputs[0].required).not.toBe(true);
    expect(p.root.querySelector(".agent-runtime-fields").textContent).toContain("Working directory (optional)");
    expect(inputs[0].getAttribute("placeholder")).toMatch(/empty|optional/i);
    inputs[1].value="General assistant";fire(inputs[1],"input");await settle();
    expect(button("Create").disabled).toBe(false);button("Create").click();await settle(8);
    const posted=sent.find(request=>request.path==="/ui/instances")?.body;
    expect(posted).toMatchObject({runtime:"windows",topic_name:"General assistant",backend:"codex",sandbox:"read-only"});
    expect(posted).not.toHaveProperty("directory");
    expect(sent.some(request=>request.path==="/ui/windows-cli/agents")).toBe(false);
    const summary=p.root.querySelector(".agent-create-success");
    expect(summary.textContent).toContain("General assistant");expect(summary.textContent).toContain(managedCwd);
  });
  it("still requires a name when no Windows working directory was provided",async()=>{
    await openWindows();await next();
    expect(button("Create").disabled).toBe(true);button("Create").click();await settle();
    expect(sent.some(request=>request.path==="/ui/instances" || request.path==="/ui/windows-cli/agents")).toBe(false);
    const inputs=p.root.querySelectorAll(".agent-runtime-fields input");inputs[1].value="   ";fire(inputs[1],"input");await settle();
    expect(button("Create").disabled).toBe(true);
    expect(sent.some(request=>request.path==="/ui/instances" || request.path==="/ui/windows-cli/agents")).toBe(false);
  });
  it("uses general setup hints and lets AI keep an unspecified Windows workspace empty",async()=>{
    await openWindows();await next();
    const assistant=p.root.querySelector(".agent-draft-assistant"), goal=assistant.querySelector("textarea");
    expect(`${p.root.querySelector(".agent-runtime-fields").textContent} ${goal.getAttribute("placeholder")}`).not.toMatch(/godot/i);
    draftResult={name:"Research assistant",cwd:"",description:"Organize research",instructions:"Help explain and summarize topics"};
    goal.value="Create a general research assistant";fire(goal,"input");await settle();
    button("Generate settings").click();await settle(12);
    const task=sent.find(request=>request.path==="/ui/windows-cli/tasks")?.body;
    expect(task.prompt).toMatch(/If no path was given use an empty string/);
    expect(task.prompt).not.toContain(JSON.stringify(probe.home));
    const inputs=p.root.querySelectorAll(".agent-runtime-fields input");
    expect(inputs[0].value).toBe("");expect(inputs[1].value).toBe("Research assistant");
    expect(button("Create").disabled).toBe(false);
    expect(sent.some(request=>request.path==="/ui/instances" || request.path==="/ui/windows-cli/agents")).toBe(false);
  });
  it("keeps form and AI-description drafts when going back or changing runtimes",async()=>{
    app.appStore.set({windowsCli:true});
    await p.mount(h(Dialog,{onClose(){}}));await settle(8);
    await choose("windows");await next();
    let inputs=p.root.querySelectorAll(".agent-runtime-fields input");
    inputs[0].value="J:\\Game";fire(inputs[0],"input");await settle();
    inputs[1].value="Game helper";fire(inputs[1],"input");await settle();
    const goal=p.root.querySelector(".agent-draft-assistant textarea");goal.value="Help with Godot";fire(goal,"input");await settle();
    button("Back").click();await settle();
    expect(p.root.querySelector(".agent-runtime-fields")).toBeNull();
    await next();
    expect(p.root.querySelectorAll(".agent-runtime-fields input").map((i:any)=>i.value).slice(0,2)).toEqual(["J:\\Game","Game helper"]);
    expect(p.root.querySelector(".agent-draft-assistant textarea").value).toBe("Help with Godot");
    button("Back").click();await settle();await choose("wsl");await next();
    inputs=p.root.querySelectorAll(".agent-runtime-fields input");inputs[0].value="/srv/linux";fire(inputs[0],"input");await settle();
    button("Back").click();await settle();await choose("windows");await next();
    expect(p.root.querySelectorAll(".agent-runtime-fields input")[0].value).toBe("J:\\Game");
    expect(sent.some(r=>r.path==="/ui/windows-cli/agents" || r.path==="/ui/instances")).toBe(false);
  });
  it("accepts only a bounded configuration draft matching the chosen runtime",()=>{
    const value={name:"Game",cwd:"J:\\Game",description:"Godot",instructions:"Use Windows tools",sandbox:"workspace-write"};
    expect(parser(JSON.stringify(value),"windows")).toMatchObject({name:"Game",cwd:"J:\\Game"});
    expect(parser(JSON.stringify({...value,cwd:""}),"windows")).toMatchObject({name:"Game",cwd:""});
    expect(()=>parser(JSON.stringify({...value,cwd:"relative"}),"windows")).toThrow();
    expect(()=>parser(JSON.stringify(value),"wsl")).toThrow();
    expect(()=>parser(JSON.stringify({...value,instructions:"x".repeat(8001)}),"windows")).toThrow();
  });
  it("offers only installed task-capable Windows CLIs and identifies all four with product icons",async()=>{
    probe=allCliProbe();await openWindows();
    expect(cliTrigger().getAttribute("aria-label")).toBe("CLI: Codex");
    cliTrigger().click();await settle();
    expect(cliOptions().map((item:any)=>item.querySelector("[data-cli]").getAttribute("data-cli"))).toEqual(["codex","claude-code","antigravity","grok"]);
    expect(cliOptions().map((item:any)=>item.getAttribute("aria-checked"))).toEqual(["true","false","false","false"]);
    for(const id of ["codex","claude-code","antigravity","grok"]){
      const option=cliOptions().find((item:any)=>item.querySelector(`[data-cli="${id}"]`));
      expect(option.querySelector(".cli-product-mark svg, .cli-product-mark img"),`${id} product icon`).not.toBeNull();
    }
    const claude=cliOptions().find((item:any)=>item.querySelector('[data-cli="claude-code"]'));
    expect(claude.querySelector("svg").getAttribute("viewBox")).toBe("0 0 248 248");
    expect(claude.querySelector("svg").getAttribute("fill")).toBe("#D97757");
    for(const id of ["kiro-cli","opencode","muse"])expect(p.root.querySelector(`[role="menuitemradio"] [data-cli="${id}"]`)).toBeNull();
  });
  it("hides installed CLIs without execution or conversation-resume support",async()=>{
    probe=allCliProbe();
    probe.clis.find(cli=>cli.id==="antigravity").supports.execution=false;
    probe.clis.find(cli=>cli.id==="grok").supports.resume=false;
    await openWindows();cliTrigger().click();await settle();
    expect(cliOptions().map((item:any)=>item.querySelector("[data-cli]").getAttribute("data-cli"))).toEqual(["codex","claude-code"]);
  });
  it.each([
    {cli:"claude-code",model:"sonnet",sandbox:"read-only"},
    {cli:"grok",model:"grok-code-fast-1",sandbox:"workspace-write"},
  ])("sends the chosen $cli and its model to the Windows endpoint",async({cli,model,sandbox})=>{
    probe=allCliProbe();await openWindows();await chooseCli(cli);
    expect(cliTrigger().getAttribute("aria-label")).toBe(`CLI: ${cli==="claude-code"?"Claude Code":"Grok"}`);
    await next();await setWindowsIdentity();
    if(cli==="claude-code"){
      expect(p.root.querySelectorAll(".model-pick option").map((option:any)=>option.value)).toContain("sonnet");
      expect(p.root.querySelectorAll(".model-pick option").map((option:any)=>option.value)).not.toContain("gpt-5.5");
      modelSelect().value=model;fire(modelSelect(),"change");await settle();
    }else{await setOtherModel(model);await setNativePermissions();}
    expect(button("Create").disabled).toBe(false);button("Create").click();await settle(8);
    expect(sent.find(request=>request.path==="/ui/instances")?.body).toMatchObject({runtime:"windows",topic_name:"Windows helper",backend:cli,model,directory:"J:\\Game",sandbox});
    expect(sent.some(request=>request.path==="/ui/windows-cli/agents")).toBe(false);
  });
  it("requires an explicit native-permissions selection for Grok before Create can write",async()=>{
    probe=allCliProbe();await openWindows();await chooseCli("grok");await next();await setWindowsIdentity();
    expect(permissionSelect().value).toBe("read-only");
    expect(permissionSelect().querySelectorAll("option").find((option:any)=>option.value==="read-only").disabled).toBe(true);
    expect(p.root.textContent).toContain("This CLI cannot guarantee read-only access");
    expect(button("Create").disabled).toBe(true);button("Create").click();await settle();
    expect(sent.some(request=>request.path==="/ui/instances" || request.path==="/ui/windows-cli/agents")).toBe(false);
    await setNativePermissions();
    expect(button("Create").disabled).toBe(false);
    expect(p.root.textContent).toContain("Uses this CLI's local access and approval settings");
    expect(sent.some(request=>request.path==="/ui/instances" || request.path==="/ui/windows-cli/agents")).toBe(false);
  });
  it("S-30: Claude Code's native permissions say plainly that writes not allowed in its own settings are denied",async()=>{
    probe=allCliProbe();await openWindows();await chooseCli("claude-code");await next();await setWindowsIdentity("Claude helper");
    await setNativePermissions();
    expect(p.root.textContent).toContain("Claude Code may edit files inside this agent's working directory; writes outside it are blocked. Shell commands that change files and network access need an approval");
    expect(p.root.textContent).not.toContain("Uses this CLI's local access and approval settings");
    permissionSelect().value="read-only";fire(permissionSelect(),"change");await settle();
    expect(p.root.textContent).not.toContain("Claude Code may edit files inside this agent");
  });
  it("keeps the selected Windows CLI, model and native permissions when returning to earlier steps or runtimes",async()=>{
    probe=allCliProbe();await openWindows();await chooseCli("grok");await next();await setWindowsIdentity("Grok game helper");
    await setOtherModel("grok-code-fast-1");await setNativePermissions();
    button("Back").click();await settle();
    expect(cliTrigger().textContent).toBe("Grok");cliTrigger().click();await settle();
    expect(cliOptions().find((item:any)=>item.getAttribute("aria-checked")==="true").querySelector("[data-cli]").getAttribute("data-cli")).toBe("grok");
    fire(p.document.activeElement,"keydown",{key:"Escape"});await settle();await next();
    expect(modelSelect().value).toBe("grok-code-fast-1");expect(permissionSelect().value).toBe("workspace-write");
    button("Back").click();await settle();await choose("wsl");await next();
    button("Back").click();await settle();await choose("windows");
    expect(cliTrigger().textContent).toBe("Grok");await next();
    expect(p.root.querySelectorAll(".agent-runtime-fields input").map((input:any)=>input.value).slice(0,2)).toEqual(["J:\\Game","Grok game helper"]);
    expect(modelSelect().value).toBe("grok-code-fast-1");expect(permissionSelect().value).toBe("workspace-write");
    expect(button("Create").disabled).toBe(false);
    expect(sent.some(request=>request.path==="/ui/windows-cli/agents"||request.path==="/ui/instances")).toBe(false);
  });
  it("shows an accessible detection status instead of a frozen Codex selector during the first probe",async()=>{
    const gate=deferredProbe();probeFetch=()=>gate.promise;
    await openWindows();
    const status=p.root.querySelector('.cli-discovery-status[role="status"]');
    expect(status).not.toBeNull();expect(status.textContent).toContain("Detecting Windows CLIs…");
    expect(status.getAttribute("aria-busy")).toBe("true");expect(status.getAttribute("aria-live")).toBe("polite");
    expect(cliTrigger()).toBeNull();expect(button("Next").disabled).toBe(true);
    expect(p.root.textContent).not.toContain("No task-capable CLI found");
    expect(probeRequests()).toHaveLength(1);
    gate.resolve(probeResponse());await settle(8);
    expect(p.root.querySelector('.cli-discovery-status[role="status"]')).toBeNull();
    expect(cliTrigger().textContent).toBe("Codex");expect(button("Next").disabled).toBe(false);
  });
  it("shows a probe failure and Retry without misreporting uninstalled CLIs",async()=>{
    probeFetch=async()=>{throw Error("Windows transport unavailable");};
    await openWindows();
    const alert=p.root.querySelector('.cli-discovery-status[role="alert"]');
    expect(alert.textContent).toContain("Windows CLI detection failed");
    expect(alert.textContent).toContain("Windows transport unavailable");
    expect(p.root.textContent).not.toContain("No task-capable CLI found");
    expect(button("Next").disabled).toBe(true);expect(cliTrigger()).toBeNull();
    probeFetch=null;button("Retry detection").click();await settle(8);
    expect(probeRequests()).toHaveLength(2);expect(probeRequests()[1].body).toEqual({force:true});
    expect(p.root.querySelector('.cli-discovery-status[role="alert"]')).toBeNull();
    expect(button("Next").disabled).toBe(false);
    expect(p.root.querySelectorAll('.agent-runtime-picker input').find((input:any)=>input.value==="windows").checked).toBe(true);
  });
  it("reopens immediately from recent inventory without another Windows probe",async()=>{
    probe=allCliProbe();await openWindows();expect(probeRequests()).toHaveLength(1);
    await p.unmount();await openWindows();
    expect(probeRequests()).toHaveLength(1);expect(cliTrigger().textContent).toBe("Codex");
    expect(button("Next").disabled).toBe(false);
    expect(p.root.querySelector('.cli-discovery-status[role="status"]')).toBeNull();
  });
  it("shares settings inventory with New Agent so opening the dialog does not detect again",async()=>{
    probe=allCliProbe();app.appStore.set({windowsCli:true});
    await p.mount(h(WindowsCliPanel,{navKey:"windows-settings-cache",embedded:true}));await settle(8);
    expect(p.root.querySelectorAll('.windows-cli-provider')).toHaveLength(4);
    expect(probeRequests()).toHaveLength(1);
    await p.unmount();await openWindows();
    expect(probeRequests()).toHaveLength(1);expect(button("Next").disabled).toBe(false);
    expect(p.root.querySelector('.cli-discovery-status[role="status"]')).toBeNull();
  });
  it("S-30: the Settings task form says the same for Claude Code's native permissions, and only for Claude Code",async()=>{
    probe=allCliProbe();app.appStore.set({windowsCli:true});
    await p.mount(h(WindowsCliPanel,{navKey:"windows-settings-claude-hint",embedded:true}));await settle(8);
    const writeHint=()=>p.root.querySelectorAll(".windows-cli-access-option")[1].querySelector("small").textContent;
    expect(writeHint()).toBe("Uses this CLI's local approval settings");                              // Codex (the default)
    p.root.querySelector(".windows-cli-composer .cli-picker-trigger").click();await settle();
    p.root.querySelectorAll('[role="menuitemradio"]').find((item:any)=>item.querySelector('[data-cli="claude-code"]')).click();await settle(4);
    expect(writeHint()).toBe("Edits files in the working directory; writes outside it, shell commands that change files and network access are denied (read-only commands still run)");
  });
  it("lets a pending probe finish across closing and reopening the dialog",async()=>{
    const gate=deferredProbe();probeFetch=()=>gate.promise;
    await openWindows();expect(probeRequests()).toHaveLength(1);
    await p.unmount();await openWindows();
    expect(probeRequests()).toHaveLength(1);
    expect(p.root.querySelector('.cli-discovery-status[role="status"]').textContent).toContain("Detecting Windows CLIs…");
    gate.resolve(probeResponse());await settle(8);
    expect(button("Next").disabled).toBe(false);expect(cliTrigger().textContent).toBe("Codex");
  });
  it("retains the selected CLI, model, permissions and draft when a manual refresh fails and is retried",async()=>{
    probe=allCliProbe();await openWindows();await chooseCli("grok");await next();await setWindowsIdentity("Keep this draft");
    await setOtherModel("grok-code-fast-1");await setNativePermissions();
    button("Back").click();await settle();
    probeFetch=async()=>{throw Error("Temporary bridge error");};
    button("Detect again").click();await settle(8);
    const alert=p.root.querySelector('.cli-discovery-status[role="alert"]');
    expect(alert.textContent).toContain("Showing the last successful inventory");
    expect(alert.textContent).toContain("Temporary bridge error");
    expect(cliTrigger().textContent).toBe("Grok");expect(button("Next").disabled).toBe(false);
    probeFetch=null;button("Retry detection").click();await settle(8);
    expect(p.root.querySelector('.cli-discovery-status[role="alert"]')).toBeNull();
    expect(cliTrigger().textContent).toBe("Grok");await next();
    expect(p.root.querySelectorAll('.agent-runtime-fields input').map((input:any)=>input.value).slice(0,2)).toEqual(["J:\\Game","Keep this draft"]);
    expect(modelSelect().value).toBe("grok-code-fast-1");expect(permissionSelect().value).toBe("workspace-write");
    expect(sent.some(request=>request.path==="/ui/instances" || request.path==="/ui/windows-cli/agents")).toBe(false);
  });
});

const adapterSelect=()=>p.root.querySelector('#native-create-adapter');
it('per-message remains the default and omits the opt-in field',async()=>{
 await openWindows();await next();await setWindowsIdentity();expect(adapterSelect().value).toBe('exec');button('Create').click();await settle(8);expect(sent.find(row=>row.path==='/ui/instances')?.body).not.toHaveProperty('native_adapter');
});
it.each(['codex','claude-code'])('an explicit %s persistent choice submits pane without changing the read-only scope',async cli=>{
 probe=allCliProbe();await openWindows();await chooseCli(cli);await next();await setWindowsIdentity();adapterSelect().value='pane';fire(adapterSelect(),'change');await settle();button('Create').click();await settle(8);expect(sent.find(row=>row.path==='/ui/instances')?.body).toMatchObject({native_adapter:'pane',backend:cli,sandbox:'read-only'});
});
it.each(['grok','antigravity'])('switching a pane draft to unsupported %s restores exec and disables pane',async cli=>{
 probe=allCliProbe();await openWindows();await next();await setWindowsIdentity();adapterSelect().value='pane';fire(adapterSelect(),'change');await settle();button('Back').click();await settle();await chooseCli(cli);await next();expect(adapterSelect().value).toBe('exec');expect(adapterSelect().querySelectorAll('option').find((row:any)=>row.value==='pane').disabled).toBe(true);await setNativePermissions();button('Create').click();await settle(8);expect(sent.find(row=>row.path==='/ui/instances')?.body).not.toHaveProperty('native_adapter');
});
