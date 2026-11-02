import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";

let p:AppPage, Panel:any, Create:any, catalog:any, models:any, app:any, routes:any, connectCommand:any;
const originalFetch=globalThis.fetch;
const idA="12345678-1234-4321-abcd-123456789012", idB="22345678-1234-4321-abcd-123456789012";
const requests:Array<{path:string;body:any}>=[];
const cli=()=>({id:"codex",path:"C:\\tools\\codex.exe",runnable:true,authenticated:true,version:"1.0",readOnlySupport:true,supports:{execution:true,resume:true,mcp:true},models:[]});
const machine=(id:string,name:string,status="online")=>({id,name,status,...(status==="pending"?{pairingFingerprint:"ABCD-1234-5678"}:{}),platform:"win32",version:"1.0",lastSeenAt:Date.now(),inventoryUpdatedAt:Date.now(),inventory:{home:`C:\\${name}`,clis:[cli(),{id:"muse",path:null,runnable:false}]}});
let machines:any[], enabled:boolean;
const response=(body:any,status=200)=>({ok:status>=200&&status<300,status,json:async()=>body});
const button=(text:string)=>p.root.querySelectorAll("button").find((item:any)=>item.textContent.trim()===text);
const choose=async(id:string)=>{const input=p.root.querySelectorAll(".agent-runtime-picker input").find((item:any)=>item.value===`machine:${id}`);input.checked=true;fire(input,"change");await settle(5);};

beforeAll(async()=>{
  p=page({url:"http://localhost/settings/runtimes",storage:{agend_lang:"en"}});
  globalThis.fetch=(async(path:string,options:any={})=>{
    const body=options.body?JSON.parse(options.body):null;requests.push({path,body});
    if(path==="/ui/runtimes")return response({enabled,machines});
    if(path==="/api/settings/runtimes")return response({switches:{windows_cli:{on:false,configured:false,environment:null},remote_runtime:{on:enabled,configured:enabled,environment:null}},max_agents_per_machine:{value:4,min:1,max:16,default:4},local_origin:"http://127.0.0.1:19280"});
    if(path==="/ui/runtimes/pairing")return response({pairingId:"test",code:"PAIR-TEST-CODE",expiresAt:Date.now()+60000});
    if(path===`/ui/runtimes/machines/${idB}/approve`){machines=machines.map(item=>item.id===idB?{...item,status:"online"}:item);return response({ok:true});}
    if(path.startsWith("/ui/models?")){const id=new URL(path,"http://localhost").searchParams.get("machineId");return response({models:[{id:id===idA?"model-a":"model-b",label:id===idA?"Model A":"Model B"}],source:"cli-cache"});}
    if(path==="/ui/backends")return response({backends:[{name:"claude-code",installed:true}],defaultBackend:"claude-code"});
    if(path==="/ui/instances")return response({name:"remote-agent",agent:{name:body.topic_name,cwd:body.directory || "C:\\managed"}});
    return response({});
  }) as any;
  const {setLang}=await import("/assets/app-i18n.js");setLang("en",{store:false});
  catalog=await import("/ui/js/runtime-catalog.js");models=await import("/ui/js/settings-catalog.js");app=await import("/assets/app-store.js");
  const runtimeUi=await import("/ui/js/panel-runtimes.js");Panel=runtimeUi.RuntimesPanel;connectCommand=runtimeUi.runtimeConnectCommand;Create=(await import("/ui/js/panel-fleet.js")).CreateInstanceDialog;routes=await import("/assets/app-route.js");
});
beforeEach(()=>{requests.length=0;enabled=true;machines=[machine(idA,"Desktop"),machine(idB,"Laptop","pending")];catalog.forgetRuntimeCatalog();models.forgetCatalogs();app.appStore.set({windowsCli:false});});
afterEach(async()=>{await p.unmount();catalog.forgetRuntimeCatalog();});
afterAll(()=>{p.restore();globalThis.fetch=originalFetch;});

describe("remote machine UI",()=>{
  it("keeps existing Windows settings addresses as aliases of Runtime",()=>{
    for(const path of ["/settings/runtimes","/settings/windows-cli","/ui/windows-cli"])expect(routes.parseRoute(path)).toEqual({panel:"settings",section:"runtimes"});
    expect(routes.sectionPath("windows-cli")).toBe("/settings/runtimes");
  });
  it("shows actual machines and installed product marks, and approves a pending computer",async()=>{
    await p.mount(h(Panel,{navKey:"runtime"}));await settle(8);
    expect(p.root.textContent).toContain("Desktop");expect(p.root.textContent).toContain("Awaiting approval");
    expect(p.root.querySelectorAll('[data-cli="codex"]').length).toBe(2);expect(p.root.querySelector('[data-cli="muse"]')).toBeNull();
    expect(p.root.querySelector(".runtime-pairing-fingerprint").textContent).toBe("ABCD-1234-5678");
    button("Approve computer").click();await settle(8);
    expect(requests).toContainEqual({path:`/ui/runtimes/machines/${idB}/approve`,body:{fingerprint:"ABCD-1234-5678"}});
    expect(p.root.querySelector(`[data-machine-id="${idB}"]`).textContent).toContain("Online");
  });
  it("creates a transient pairing code with an interactive CLI command, then hides it",async()=>{
    await p.mount(h(Panel,{navKey:"runtime"}));await settle(8);button("Connect a computer").click();await settle(8);
    const download=p.root.querySelector(".runtime-pairing .runtime-bundle-download");
    expect(download.textContent).toContain("Download Windows Runtime");
    expect(download.getAttribute("href")).toBe("/ui/runtimes/download/windows");
    expect(p.root.textContent).toContain("transfer the ZIP to the Windows computer");
    expect(p.root.querySelector(".runtime-pair-code").value).toBe("PAIR-TEST-CODE");
    expect(p.root.querySelector(".runtime-command").value).toContain("agend-runtime.cmd connect --server");
    expect(p.root.querySelector(".runtime-command").value).not.toContain("PAIR-TEST-CODE");
    // S-30: while pairing, the ZIP is the panel's step 1 — one download button, not one in the header too.
    expect(p.root.querySelectorAll(".runtime-bundle-download").length).toBe(1);
    button("Hide pairing code").click();await settle();expect(p.root.querySelector(".runtime-pair-code")).toBeNull();
    expect(p.root.querySelectorAll(".runtime-bundle-download").length).toBe(1);   // the header's is back
  });
  it("S-30: a computer card names its platform and host name, never a version slot that is always \"Not reported\"",async()=>{
    machines=[{...machine(idA,"Desktop"),version:undefined,hostname:"DESKTOP-7Q2"},{...machine(idB,"Laptop","pending"),version:undefined}];
    await p.mount(h(Panel,{navKey:"runtime"}));await settle(8);
    expect(p.root.querySelector(`[data-machine-id="${idA}"] header p`).textContent).toBe("win32 · DESKTOP-7Q2");
    expect(p.root.querySelector(`[data-machine-id="${idB}"] header p`).textContent).toBe("win32");
    expect(p.root.textContent).not.toContain("Not reported");
  });
  it("keeps local Runtime settings visible while remote connections are disabled",async()=>{
    enabled=false;machines=[];await p.mount(h(Panel,{navKey:"runtime"}));await settle(8);
    expect(p.root.textContent).toContain("Other Windows PCs can connect once “Allow other Windows PCs to pair” is on.");expect(p.root.textContent).toContain("This computer");expect(button("Connect a computer").disabled).toBe(true);
  });
  it("creates a remote agent with an optional workspace while local Windows CLI is disabled",async()=>{
    expect(app.appStore.get().windowsCli).toBe(false);
    await p.mount(h(Create,{onClose(){}}));await settle(8);await choose(idA);button("Next").click();await settle(8);
    expect(p.root.textContent).toContain("Working directory on Desktop (optional)");
    expect(requests.some(item=>item.path===`/ui/models?backend=codex&runtime=windows&machineId=${idA}`)).toBe(true);
    const name=p.root.querySelectorAll(".agent-runtime-fields input")[1];name.value="Remote helper";fire(name,"input");await settle();
    button("Create").click();await settle(8);
    const submitted=requests.find(item=>item.path==="/ui/instances");expect(submitted?.body).toMatchObject({runtime:"windows",machineId:idA,topic_name:"Remote helper",backend:"codex"});
    expect(submitted?.body).not.toHaveProperty("directory");expect(p.root.textContent).toContain("Agent created");
    expect(requests.some(item=>item.path==="/ui/windows-cli/probe")).toBe(false);
  });
  it("isolates machine drafts, directories and model catalogs",async()=>{
    machines=[machine(idA,"Desktop"),machine(idB,"Laptop")];await p.mount(h(Create,{onClose(){}}));await settle(8);await choose(idA);button("Next").click();await settle(8);
    let dir=p.root.querySelector(".agent-runtime-fields input");dir.value="C:\\DesktopOnly";fire(dir,"input");await settle();button("Back").click();await settle();await choose(idB);button("Next").click();await settle(8);
    dir=p.root.querySelector(".agent-runtime-fields input");expect(dir.value).toBe("");
    const ids=p.root.querySelectorAll(".model-pick option").map((item:any)=>item.value);expect(ids).toContain("model-b");expect(ids).not.toContain("model-a");
    button("Back").click();await settle();await choose(idA);button("Next").click();await settle(8);expect(p.root.querySelector(".agent-runtime-fields input").value).toBe("C:\\DesktopOnly");
  });
  it("shows offline machines without enabling selection or silently falling back to another computer",async()=>{
    machines=[machine(idA,"Desktop","offline")];await p.mount(h(Create,{onClose(){}}));await settle(8);
    expect(p.root.querySelectorAll(".agent-runtime-picker input").find((item:any)=>item.value===`machine:${idA}`).disabled).toBe(true);
    expect(button("Next").disabled).toBe(true);expect(requests.some(item=>item.path==="/ui/instances")).toBe(false);
  });
});

describe("machine snapshot boundary",()=>{
  it("never places shell syntax, URL credentials or cleartext remote addresses in the copyable command",()=>{
    expect(connectCommand("https://runtime.example.com:443")).toBe('.\\agend-runtime.cmd connect --server "https://runtime.example.com"');
    expect(connectCommand("http://localhost:19280")).toContain('"http://localhost:19280"');
    for(const bad of ["http://192.168.1.2:19280","https://user:password@example.com","https://example.com/?x=$(calc)","https://$(calc)","https://example.com/path","https://example.com;calc"])expect(connectCommand(bad)).toBe("");
  });
  it("coalesces reads and keeps the last good snapshot after a network failure, clearing it on lost authorization",async()=>{
    let resolve!:(value:any)=>void;let count=0;let mode="pending";
    const pending=new Promise<any>(done=>{resolve=done;});
    const store=catalog.createRuntimeCatalog({fetcher:async()=>{count++;return mode==="pending"?pending:mode==="fail"?response({error:"unavailable"},503):response({error:"unauthorized"},403);}});
    const a=store.load(),b=store.load();resolve(response({enabled:true,machines}));await Promise.all([a,b]);expect(count).toBe(1);expect(store.get().data.machines).toHaveLength(2);
    mode="fail";await store.load({force:true});expect(store.get().data.machines).toHaveLength(2);expect(store.get().error).toBe("unavailable");
    mode="auth";await store.load({force:true});expect(store.get().data).toBeNull();store.clear();
  });
});
