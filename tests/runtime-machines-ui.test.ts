import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";

let p:AppPage, Panel:any, Create:any, catalog:any, windowsCatalog:any, windowsInventory:any, models:any, app:any, routes:any, connectCommand:any;
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
    if(path==="/ui/windows-cli/probe") {
      if(body?.force) windowsInventory={...windowsInventory,hostname:"REFRESHED-DESKTOP"};
      return response(windowsInventory);
    }
    if(path==="/ui/windows-cli/tasks")return response({tasks:[]});
    const diagnostic=/^\/ui\/runtimes\/machines\/([^/]+)\/(inventory|probe|tasks)$/.exec(path);
    if(diagnostic){const target=machines.find(item=>item.id===diagnostic[1]);return response(diagnostic[2]==="tasks"?{tasks:[]}:{inventory:target?.inventory || null});}
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
  windowsCatalog=await import("/ui/js/windows-cli-catalog.js");
  const runtimeUi=await import("/ui/js/panel-runtimes.js");Panel=runtimeUi.RuntimesPanel;connectCommand=runtimeUi.runtimeConnectCommand;Create=(await import("/ui/js/panel-fleet.js")).CreateInstanceDialog;routes=await import("/assets/app-route.js");
});
beforeEach(()=>{requests.length=0;enabled=true;machines=[machine(idA,"Desktop"),machine(idB,"Laptop","pending")];windowsInventory={home:"C:\\Test",hostname:"WINDOWS-DESK",probedAt:1,clis:[cli()]};windowsCatalog.forgetWindowsCliCatalog();catalog.forgetRuntimeCatalog();models.forgetCatalogs();app.appStore.set({windowsCli:false});});
afterEach(async()=>{await p.unmount();catalog.forgetRuntimeCatalog();vi.restoreAllMocks();});
afterAll(()=>{p.restore();globalThis.fetch=originalFetch;});

const diagnosticDialog=()=>p.root.querySelector(".runtime-diagnostics-dialog");
const closeDiagnostics=async()=>{diagnosticDialog().querySelector(".dlg-x").click();await settle(8);};
const openDiagnostics=async(id="")=>{
  if(diagnosticDialog())await closeDiagnostics();
  p.root.querySelector(`[data-machine-id="${id || "local"}"] .runtime-inspect`).click();await settle(12);
};

describe("remote machine UI",()=>{
  it("shows the selected Runtime's reported version, build and compatibility, with an explicit legacy fallback",async()=>{
    machines[0]={...machines[0],runtimeInfo:{version:"2.3.5-alpha",buildId:"a".repeat(64),protocolVersions:[1],capabilities:["exec","mcp","panes"]},runtimeCompatibility:"compatible"};
    await p.mount(h(Panel,{navKey:"runtime-version-info"}));await settle(12);
    const openInfo=async(id:string)=>{p.root.querySelector(`[data-machine-id="${id}"] .runtime-machine-menu button`).click();await settle();button("Computer information").click();await settle();};
    await openInfo(idA);expect(p.root.querySelector(".runtime-reported-version").textContent).toBe("2.3.5-alpha");expect(p.root.querySelector(".runtime-reported-build").textContent).toBe("a".repeat(64));
    expect(p.root.querySelector(".runtime-compatibility").textContent).toBe("Compatible");expect(p.root.querySelector(".runtime-machine-facts").textContent).toContain("Persistent terminals");
    p.root.querySelector(".dlg-x").click();await settle();await openInfo(idB);
    expect(p.root.querySelector(".runtime-reported-version").textContent).toBe("This Runtime does not provide version information");expect(p.root.querySelector(".runtime-reported-build")).toBeNull();
  });
  it("uses the same machine cards and does not load task history until diagnostics open",async()=>{
    app.appStore.set({windowsCli:true});await p.mount(h(Panel,{navKey:"unified-machine-cards"}));await settle(12);
    const cards=p.root.querySelectorAll(".runtime-machine");expect(cards).toHaveLength(3);
    expect(cards.map((card:any)=>card.querySelector(".runtime-cli-table")!==null)).toEqual([true,true,true]);
    expect(cards[0].querySelector("h3").textContent).toBe("WINDOWS-DESKThis PC");
    expect(cards[1].querySelector("h3").textContent).toBe("DesktopPaired");
    expect(cards[0].querySelector(".runtime-inspect").textContent).toBe(cards[1].querySelector(".runtime-inspect").textContent);
    expect(diagnosticDialog()).toBeNull();expect(p.root.querySelector(".runtime-local-diagnostics")).toBeNull();
    expect(requests.some(item=>item.path.endsWith("/tasks"))).toBe(false);expect(requests.some(item=>item.body?.force===true)).toBe(false);
  });
  it("opens local diagnostics as a named dialog with testing collapsed, and restores focus on Escape",async()=>{
    app.appStore.set({windowsCli:true});await p.mount(h(Panel,{navKey:"local-diagnostic-dialog"}));await settle(12);
    const opener=p.root.querySelector('[data-machine-id="local"] .runtime-inspect');opener.focus();await openDiagnostics();
    const dialog=diagnosticDialog();expect(dialog.open).toBe(true);expect(dialog.getAttribute("aria-label")).toBe("CLI diagnostics · WINDOWS-DESK");
    const testBlock=dialog.querySelector(".windows-cli-test-disclosure");expect(testBlock.open).toBe(false);
    expect(testBlock.contains(dialog.querySelector(".windows-cli-composer"))).toBe(true);
    expect(testBlock.contains(dialog.querySelector(".windows-cli-history"))).toBe(true);
    expect(testBlock.contains(dialog.querySelector(".windows-cli-close-note"))).toBe(true);
    expect(dialog.querySelector(".windows-cli-diagnostic-row").textContent).toContain("Codex");
    expect(dialog.querySelector(".runtime-diagnostic-target")).toBeNull();
    fire(dialog,"cancel");await settle(8);expect(diagnosticDialog()).toBeNull();expect(p.window.document.activeElement).toBe(opener);
  });
  it("keeps legacy names unknown until explicit detection updates the card and dialog title",async()=>{
    delete windowsInventory.hostname;app.appStore.set({windowsCli:true});await p.mount(h(Panel,{navKey:"legacy-diagnostic-host"}));await settle(12);
    await openDiagnostics();expect(diagnosticDialog().getAttribute("aria-label")).toBe("CLI diagnostics · Native Windows");
    p.root.querySelector(".windows-cli-probe").click();await settle(12);
    expect(p.root.querySelector('[data-machine-id="local"] h3').textContent).toContain("REFRESHED-DESKTOP");
    expect(diagnosticDialog().getAttribute("aria-label")).toBe("CLI diagnostics · REFRESHED-DESKTOP");
    expect(requests.filter(item=>item.body?.force===true)).toHaveLength(1);
  });
  it("opens the clicked computer and keeps diagnostic drafts, models, paths and probes on their owner",async()=>{
    app.appStore.set({windowsCli:true});machines=[machine(idA,"Desktop"),machine(idB,"Laptop")];
    machines[0].inventory.clis[0].models=[{id:"model-a",label:"Model A"}];machines[1].inventory.clis[0].models=[{id:"model-b",label:"Model B"}];
    await p.mount(h(Panel,{navKey:"diagnostic-selection"}));await settle(12);await openDiagnostics(idA);
    expect(p.root.querySelector("#windows-cwd").value).toBe("C:\\Desktop");expect(diagnosticDialog().getAttribute("aria-label")).toBe("CLI diagnostics · Desktop");
    const prompt=p.root.querySelector("#windows-prompt");prompt.value="Desktop draft";fire(prompt,"input");
    const model=p.root.querySelector("#windows-model");model.value="model-a";fire(model,"change");await settle();
    const before=requests.length;p.root.querySelector(".windows-cli-probe").click();await settle(12);
    expect(requests.slice(before).some(item=>item.path===`/ui/runtimes/machines/${idA}/probe`)).toBe(true);
    expect(requests.slice(before).some(item=>item.path==="/ui/windows-cli/probe")).toBe(false);
    await openDiagnostics(idB);expect(p.root.querySelector("#windows-cwd").value).toBe("C:\\Laptop");expect(p.root.querySelector("#windows-prompt").value).toBe("");
    expect(p.root.querySelector("#windows-model").textContent).toContain("Model B");expect(p.root.querySelector("#windows-model").textContent).not.toContain("Model A");
    await openDiagnostics(idA);expect(p.root.querySelector("#windows-prompt").value).toBe("Desktop draft");expect(p.root.querySelector("#windows-model").value).toBe("model-a");
  });
  it("ignores a late inventory after closing and opening another computer, and fences revocation",async()=>{
    app.appStore.set({windowsCli:true});machines=[machine(idA,"Desktop"),machine(idB,"Laptop")];
    const fixtureFetch=globalThis.fetch;let release!:(value:unknown)=>void;
    globalThis.fetch=(async(path:any,options:any)=>path===`/ui/runtimes/machines/${idA}/inventory`?new Promise(resolve=>{release=resolve;}):fixtureFetch(path,options)) as any;
    try{
      await p.mount(h(Panel,{navKey:"held-computer-inventory"}));await settle(12);await openDiagnostics(idA);await openDiagnostics(idB);
      release(response({inventory:machine(idA,"Desktop").inventory}));await settle(12);
      expect(p.root.querySelector("#windows-cwd").value).toBe("C:\\Laptop");expect(diagnosticDialog().getAttribute("aria-label")).toBe("CLI diagnostics · Laptop");
      machines=machines.map(item=>item.id===idB?{...item,status:"revoked"}:item);button("Refresh machines").click();await settle(12);
      expect(diagnosticDialog().getAttribute("aria-label")).toBe("CLI diagnostics · Laptop");expect(p.root.textContent).toContain("This Runtime is unavailable or no longer approved.");
      expect(p.root.querySelector(".windows-cli-probe").disabled).toBe(true);expect(requests.filter(item=>item.path==="/ui/windows-cli/probe")).toHaveLength(1);
    }finally{globalThis.fetch=fixtureFetch;}
  });
  it("keeps a diagnostic probe alive and visible on its card across close and reopen",async()=>{
    machines=[machine(idA,"Desktop")];const fixtureFetch=globalThis.fetch;let release!:(value:unknown)=>void,signal:AbortSignal,count=0;
    globalThis.fetch=(async(path:any,options:any)=>{if(path!==`/ui/runtimes/machines/${idA}/probe`)return fixtureFetch(path,options);count++;signal=options.signal;return new Promise(resolve=>{release=resolve;});}) as any;
    try{
      await p.mount(h(Panel,{navKey:"diagnostic-probe-ownership"}));await settle(12);await openDiagnostics(idA);
      p.root.querySelector(".windows-cli-probe").click();await settle(8);await closeDiagnostics();
      expect(signal!.aborted).toBe(false);const cardProbe=p.root.querySelector(`[data-machine-id="${idA}"] .runtime-probe`);
      expect(cardProbe.disabled).toBe(true);expect(cardProbe.textContent).toContain("Detecting…");
      await openDiagnostics(idA);expect(p.root.querySelector(".windows-cli-probe").disabled).toBe(true);expect(count).toBe(1);
      release(response({inventory:machines[0].inventory}));await settle(12);
      expect(p.root.querySelector(".windows-cli-probe").disabled).toBe(false);expect(count).toBe(1);
    }finally{globalThis.fetch=fixtureFetch;}
  });
  it("waits for history, submits once and preserves a pending send across dialog close and reopen",async()=>{
    machines=[machine(idA,"Desktop")];const fixtureFetch=globalThis.fetch,root=`/ui/runtimes/machines/${idA}/tasks`;
    let releaseHistory!:(value:unknown)=>void,releaseSend!:(value:unknown)=>void,first=true,task:any=null,signal:AbortSignal;const sent:any[]=[];
    globalThis.fetch=(async(path:any,options:any={})=>{
      if(path!==root)return fixtureFetch(path,options);
      if(options.method==="POST"){const body=JSON.parse(options.body);sent.push(body);signal=options.signal;return new Promise(resolve=>{releaseSend=resolve;});}
      if(first){first=false;return new Promise(resolve=>{releaseHistory=resolve;});}return response({tasks:task?[task]:[]});
    }) as any;
    try{
      await p.mount(h(Panel,{navKey:"remote-diagnostic-submission"}));await settle(12);await openDiagnostics(idA);
      const prompt=p.root.querySelector("#windows-prompt");prompt.value="Fixture analysis";fire(prompt,"input");await settle();
      const submit=()=>p.root.querySelector(".windows-cli-composer button[type=submit]");expect(submit().disabled).toBe(true);
      releaseHistory(response({tasks:[]}));await settle(12);expect(submit().disabled).toBe(false);
      const form=p.root.querySelector(".windows-cli-composer form");fire(form,"submit");fire(form,"submit");await settle(8);expect(sent).toHaveLength(1);
      await closeDiagnostics();expect(signal!.aborted).toBe(false);expect(requests.some(item=>item.path.endsWith("/cancel"))).toBe(false);
      await openDiagnostics(idA);expect(submit().disabled).toBe(true);expect(p.root.querySelector("#windows-prompt").value).toBe("Fixture analysis");
      task={id:sent[0].requestId,cli:"codex",cwd:"C:\\Desktop",sandbox:"read-only",startedAt:1,status:"running",output:"Fixture output"};releaseSend(response({task},202));
      diagnosticDialog().querySelector('[aria-label="Refresh"]').click();await settle(12);expect(p.root.textContent).toContain("Fixture output");expect(submit().disabled).toBe(true);expect(sent).toHaveLength(1);
      task={...task,status:"failed",outcomeConfirmed:false};diagnosticDialog().querySelector('[aria-label="Refresh"]').click();await settle(12);
      expect(submit().disabled).toBe(true);expect(p.root.textContent).toContain("A task outcome is unconfirmed.");expect(requests.some(item=>item.path.startsWith("/ui/windows-cli/"))).toBe(false);
    }finally{globalThis.fetch=fixtureFetch;}
  });
  it("supports remote-only diagnostics and disables offline actions without falling back to the host",async()=>{
    machines=[machine(idA,"Offline desk","offline")];await p.mount(h(Panel,{navKey:"remote-only-diagnostics"}));await settle(12);await openDiagnostics(idA);
    expect(diagnosticDialog().getAttribute("aria-label")).toBe("CLI diagnostics · Offline desk");
    expect(p.root.querySelector("#windows-cwd").value).toBe("C:\\Offline desk");expect(p.root.querySelector(".windows-cli-probe").disabled).toBe(true);
    expect(p.root.querySelector(".windows-cli-composer button[type=submit]").disabled).toBe(true);
    expect(p.root.textContent).toContain("This computer is offline.");expect(requests.some(item=>item.path.startsWith("/ui/windows-cli/"))).toBe(false);
  });
  it("keeps existing Windows settings addresses as aliases of Runtime",()=>{
    for(const path of ["/settings/runtimes","/settings/windows-cli","/ui/windows-cli"])expect(routes.parseRoute(path)).toEqual({panel:"settings",section:"runtimes"});
    expect(routes.sectionPath("windows-cli")).toBe("/settings/runtimes");
  });
  it("shows actual machines and installed product marks, and approves a pending computer",async()=>{
    await p.mount(h(Panel,{navKey:"runtime"}));await settle(8);
    expect(p.root.textContent).toContain("Desktop");expect(p.root.textContent).toContain("Awaiting approval");
    expect(p.root.querySelectorAll('.runtime-machines [data-cli="codex"]').length).toBe(2);expect(p.root.querySelector('[data-cli="muse"]')).toBeNull();
    expect(p.root.querySelector(".runtime-pairing-fingerprint").textContent).toBe("ABCD-1234-5678");
    button("Approve computer").click();await settle(8);
    expect(requests).toContainEqual({path:`/ui/runtimes/machines/${idB}/approve`,body:{fingerprint:"ABCD-1234-5678"}});
    expect(p.root.querySelector(`[data-machine-id="${idB}"]`).textContent).toContain("Online");
  });
  it("creates a transient pairing code with an interactive CLI command, then hides it",async()=>{
    await p.mount(h(Panel,{navKey:"runtime"}));await settle(8);button("Connect a computer").click();await settle(8);
    const download=p.root.querySelector(".runtime-pairing .runtime-bundle-download");
    expect(download.textContent).toContain("Download Windows Runtime");
    expect(download.tagName).toBe("BUTTON");expect(download.disabled).toBe(false);
    expect(p.root.textContent).toContain("Double-click connect-agend.bat there");
    // The four steps are an ordered list, the code card shows the waiting state, and a repeated explanation is gone.
    expect([...p.root.querySelectorAll(".runtime-pairing .runtime-step h4")].map(el=>el.textContent)).toEqual(["AgEnD address","Download the Runtime","Double-click connect-agend.bat there","Return here to approve"]);
    // The fixture has a computer awaiting approval, so the flow is at its last step and the card says so.
    expect(p.root.querySelector('.runtime-step[aria-current="step"] h4').textContent).toBe("Return here to approve");
    expect(p.root.querySelector(".runtime-pair-card .runtime-pair-status").textContent).toContain("A computer is waiting for your approval");
    expect(p.root.textContent.split("connect-agend.bat").length-1).toBe(1);
    expect(p.root.querySelector(".runtime-pair-code").value).toBe("PAIR-TEST-CODE");
    expect(p.root.querySelector(".runtime-command").value).toContain("agend-runtime.cmd connect --server");
    expect(p.root.querySelector(".runtime-command").value).not.toContain("PAIR-TEST-CODE");
    // S-30: while pairing, the ZIP is the panel's step 1 — one download button, not one in the header too.
    expect(p.root.querySelectorAll(".runtime-bundle-download").length).toBe(1);
    button("Hide pairing code").click();await settle();expect(p.root.querySelector(".runtime-pair-code")).toBeNull();
    expect(p.root.querySelectorAll(".runtime-bundle-download").length).toBe(1);   // the header's is back
  });
  it("shows the pairing card as waiting for a computer, at the download step, while nothing is pending",async()=>{
    machines=[machine(idA,"Desktop")];
    await p.mount(h(Panel,{navKey:"runtime-waiting"}));await settle(8);button("Connect a computer").click();await settle(8);
    expect(p.root.querySelector('.runtime-step[aria-current="step"] h4').textContent).toBe("Download the Runtime");
    expect(p.root.querySelector(".runtime-pair-card .runtime-pair-status").textContent).toContain("Waiting for the computer to connect");
    expect(p.root.querySelector(".runtime-pair-card .expires, .runtime-pair-card .note").textContent).toContain("Expires");
  });
  it("downloads a connection-ready ZIP with the reviewed address in a protected POST and claims one download",async()=>{
    const fixtureFetch=globalThis.fetch;let release!:(value:unknown)=>void;const create=vi.spyOn(URL,"createObjectURL").mockReturnValue("blob:runtime-fixture"),revoke=vi.spyOn(URL,"revokeObjectURL").mockImplementation(()=>{});
    globalThis.fetch=(async(path:any,options:any)=>{
      if(path!=="/ui/runtimes/download/windows")return fixtureFetch(path,options);
      requests.push({path,body:JSON.parse(options.body)});return new Promise(resolve=>{release=resolve;});
    }) as any;
    try{
      await p.mount(h(Panel,{navKey:"runtime-download-config"}));await settle(12);button("Download Windows Runtime (ZIP)").click();await settle(12);
      const address=p.root.querySelector('.runtime-pairing input[type=url]');address.value="https://fleet.example.test:10443";fire(address,"input");await settle();
      const download=p.root.querySelector(".runtime-pairing .runtime-bundle-download");download.click();download.click();await settle(8);
      expect(requests.filter(item=>item.path==="/ui/runtimes/download/windows")).toEqual([{path:"/ui/runtimes/download/windows",body:{server:"https://fleet.example.test:10443"}}]);expect(address.disabled).toBe(true);
      release({ok:true,headers:{get:()=> 'attachment; filename="agend-runtime-windows-fixture.zip"'},blob:async()=>new Blob(["fixture zip"])});await settle(12);
      expect(create).toHaveBeenCalledTimes(1);expect(p.root.textContent).toContain("Downloaded for: https://fleet.example.test:10443");
      expect(JSON.stringify(requests.filter(item=>item.path==="/ui/runtimes/download/windows"))).not.toContain("PAIR-TEST-CODE");
      address.value="https://user:password@fleet.example.test";fire(address,"input");await settle();expect(p.root.querySelector(".runtime-bundle-download").disabled).toBe(true);
    }finally{globalThis.fetch=fixtureFetch;}
  });
  it("S-30: a computer card names its platform and host name, never a version slot that is always \"Not reported\"",async()=>{
    machines=[{...machine(idA,"Desktop"),version:undefined,hostname:"DESKTOP-7Q2"},{...machine(idB,"Laptop","pending"),version:undefined}];
    await p.mount(h(Panel,{navKey:"runtime"}));await settle(8);
    expect(p.root.querySelector(`[data-machine-id="${idA}"] header p`).textContent).toBe("Windows · DESKTOP-7Q2 · 1 CLIs");
    expect(p.root.querySelector(`[data-machine-id="${idB}"] header p`).textContent).toBe("Windows · 1 CLIs");
    expect(p.root.querySelector(".runtime-machines").textContent).not.toContain("Not reported");
  });
  it("keeps local Runtime settings visible while remote connections are disabled",async()=>{
    enabled=false;machines=[];await p.mount(h(Panel,{navKey:"runtime"}));await settle(8);
    expect(p.root.textContent).toContain("Other Windows PCs can connect once “Allow other Windows PCs to pair” is on.");expect(p.root.querySelector(".runtime-policy")).not.toBeNull();expect(button("Connect a computer").disabled).toBe(true);
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
    const adapter=()=>p.root.querySelector("#native-create-adapter");adapter().value="pane";fire(adapter(),"change");await settle();
    let dir=p.root.querySelector(".agent-runtime-fields input");dir.value="C:\\DesktopOnly";fire(dir,"input");await settle();button("Back").click();await settle();await choose(idB);button("Next").click();await settle(8);
    dir=p.root.querySelector(".agent-runtime-fields input");expect(dir.value).toBe("");expect(adapter().value).toBe("exec");
    const ids=p.root.querySelectorAll(".model-pick option").map((item:any)=>item.value);expect(ids).toContain("model-b");expect(ids).not.toContain("model-a");
    button("Back").click();await settle();await choose(idA);button("Next").click();await settle(8);expect(p.root.querySelector(".agent-runtime-fields input").value).toBe("C:\\DesktopOnly");expect(adapter().value).toBe("pane");
    button("Create").click();await settle(8);expect(requests.find(row=>row.path==="/ui/instances")?.body).toMatchObject({native_adapter:"pane",machineId:idA});
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
