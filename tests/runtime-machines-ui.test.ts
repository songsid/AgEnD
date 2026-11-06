import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";

let p:AppPage, Panel:any, Create:any, catalog:any, windowsCatalog:any, windowsInventory:any, models:any, app:any, routes:any, connectCommand:any, installCommand:any, windowsConnectCommand:any;
const originalFetch=globalThis.fetch;
const idA="12345678-1234-4321-abcd-123456789012", idB="22345678-1234-4321-abcd-123456789012";
const requests:Array<{path:string;body:any}>=[];
const cli=()=>({id:"codex",path:"C:\\tools\\codex.exe",runnable:true,authenticated:true,version:"1.0",readOnlySupport:true,supports:{execution:true,resume:true,mcp:true},models:[]});
const machine=(id:string,name:string,status="online")=>({id,name,status,...(status==="pending"?{pairingFingerprint:"ABCD-1234-5678"}:{}),platform:"win32",version:"1.0",lastSeenAt:Date.now(),inventoryUpdatedAt:Date.now(),inventory:{home:`C:\\${name}`,clis:[cli(),{id:"muse",path:null,runnable:false}]}});
let machines:any[], enabled:boolean, installerMode="ok";
const SCRIPT_SHA="ab".repeat(32);
const response=(body:any,status=200)=>({ok:status>=200&&status<300,status,json:async()=>body});
const button=(text:string)=>p.root.querySelectorAll("button").find((item:any)=>item.textContent.trim()===text);
const zipTab=async()=>{const tab=p.root.querySelectorAll('[role="tab"]').find((item:any)=>item.textContent.trim()==="Other install methods (ZIP)");tab.click();await settle(4);};
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
    if(path==="/ui/runtimes/installer"){return installerMode==="fail"?response({error:"unavailable"},503):response({version:"2.3.5-alpha.7",scriptSha256:SCRIPT_SHA,scriptBytes:13536,bundleSha256:"c".repeat(64)});}
    if(path==="/ui/runtimes/pairing")return response({pairingId:"test",code:"PAIR-TEST-CODE",expiresAt:Date.now()+60000});
    const revoking=/^\/ui\/runtimes\/machines\/([^/]+)\/revoke$/.exec(path);
    if(revoking){machines=machines.map(item=>item.id===revoking[1]?{...item,status:"revoked"}:item);return response({ok:true});}
    if(path===`/ui/runtimes/machines/${idB}/approve`){machines=machines.map(item=>item.id===idB?{...item,status:"online"}:item);return response({ok:true});}
    if(path.startsWith("/ui/models?")){const id=new URL(path,"http://localhost").searchParams.get("machineId");return response({models:[{id:id===idA?"model-a":"model-b",label:id===idA?"Model A":"Model B"}],source:"cli-cache"});}
    if(path==="/ui/backends")return response({backends:[{name:"claude-code",installed:true}],defaultBackend:"claude-code"});
    if(path==="/ui/instances")return response({name:"remote-agent",agent:{name:body.topic_name,cwd:body.directory || "C:\\managed"}});
    return response({});
  }) as any;
  const {setLang}=await import("/assets/app-i18n.js");setLang("en",{store:false});
  catalog=await import("/ui/js/runtime-catalog.js");models=await import("/ui/js/settings-catalog.js");app=await import("/assets/app-store.js");
  windowsCatalog=await import("/ui/js/windows-cli-catalog.js");
  const runtimeUi=await import("/ui/js/panel-runtimes.js");Panel=runtimeUi.RuntimesPanel;connectCommand=runtimeUi.runtimeConnectCommand;installCommand=runtimeUi.runtimeInstallCommand;windowsConnectCommand=runtimeUi.runtimeWindowsConnectCommand;Create=(await import("/ui/js/panel-fleet.js")).CreateInstanceDialog;routes=await import("/assets/app-route.js");
});
beforeEach(()=>{requests.length=0;enabled=true;installerMode="ok";machines=[machine(idA,"Desktop"),machine(idB,"Laptop","pending")];windowsInventory={home:"C:\\Test",hostname:"WINDOWS-DESK",probedAt:1,clis:[cli()]};windowsCatalog.forgetWindowsCliCatalog();catalog.forgetRuntimeCatalog();models.forgetCatalogs();app.appStore.set({windowsCli:false});});
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
    await p.mount(h(Panel,{navKey:"runtime"}));await settle(8);button("Connect a computer").click();await settle(8);await zipTab();
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
    await p.mount(h(Panel,{navKey:"runtime-waiting"}));await settle(8);button("Connect a computer").click();await settle(8);await zipTab();
    expect(p.root.querySelector('.runtime-step[aria-current="step"] h4').textContent).toBe("Download the Runtime");
    expect(p.root.querySelector(".runtime-pair-card .runtime-pair-status").textContent).toContain("Waiting for the computer to connect");
    expect(p.root.querySelector(".runtime-pair-card .expires, .runtime-pair-card .note").textContent).toContain("Expires");
  });
  describe("the install page's stylesheet follows the lazy page",()=>{
    const read=(file:string)=>readFileSync(file,"utf8");
    const selectors=read("src/ui/shared/runtime-install.css").match(/\.runtime-[a-z-]+/g)!;
    it("keeps every install rule in runtime-install.css, which the page links itself, and none in app.css",()=>{
      const own=[".runtime-install",".runtime-install-tabs",".runtime-install-panel",".runtime-command-card",".runtime-command-label",".runtime-command-row",".runtime-command-text",".runtime-installer-hash",".runtime-installer-error",".runtime-reinstall"];
      for(const selector of own){expect(selectors,selector).toContain(selector);expect(read("src/ui/shared/app.css"),`${selector} must not be in app.css: a tab with an older app.css never gets it`).not.toMatch(new RegExp(`(^|[\\s,}])${selector.replace(".","\\.")}(?![a-z-])`,"m"));}
      // the page links it, the server serves it, and the long command wraps and scrolls inside it (the phone layout is its media rule)
      expect(read("src/ui/panel-runtimes.js")).toContain('href", "/assets/runtime-install.css"');
      expect(read("src/auth-api.ts")).toContain('"runtime-install.css": { file: join("shared", "runtime-install.css")');
      expect(read("src/ui/shared/runtime-install.css")).toMatch(/\.runtime-command-text \{[^}]*white-space: pre-wrap[^}]*overflow-x: auto/);
      expect(read("src/ui/shared/runtime-install.css")).toMatch(/@media \(max-width: 600px\) \{ \.runtime-command-row \{ flex-direction: column/);
      expect(read("src/ui/shared/runtime-install.css")).not.toMatch(/style\s*=|@import|url\(/);
    });
    it("links the stylesheet once, when the page module loads, so an old shell gets it too",async()=>{
      const links=()=>[...document.head.querySelectorAll('link[data-runtime-install-css="1"]')];
      expect(links()).toHaveLength(1);expect(links()[0].getAttribute("href")).toBe("/assets/runtime-install.css");expect(links()[0].getAttribute("rel")).toBe("stylesheet");
      const {linkRuntimeInstallCss}=await import("/ui/js/panel-runtimes.js");linkRuntimeInstallCss();linkRuntimeInstallCss();expect(links()).toHaveLength(1);
      linkRuntimeInstallCss(null as any);   // no document: nothing happens, nothing throws
    });
  });
  describe("install method tabs (Windows one-line install)",()=>{
    const tabs=()=>p.root.querySelectorAll('.runtime-install-tabs [role="tab"]');
    const stepTitles=()=>[...p.root.querySelectorAll(".runtime-pairing .runtime-step h4")].map((el:any)=>el.textContent);
    const open=async(navKey:string)=>{await p.mount(h(Panel,{navKey}));await settle(8);button("Connect a computer").click();await settle(8);};
    const commands=()=>[...p.root.querySelectorAll(".runtime-command-text")].map((el:any)=>el.textContent);
    const setServer=async(value:string)=>{const address=p.root.querySelector('.runtime-pairing input[type=url]');address.value=value;fire(address,"input");await settle();};
    it("opens on Windows (PowerShell) with the other install method named ZIP, as a labelled tablist",async()=>{
      await open("runtime-tabs");
      expect(tabs().map((item:any)=>item.textContent)).toEqual(["Windows (PowerShell)","Other install methods (ZIP)"]);
      expect(tabs().map((item:any)=>item.getAttribute("aria-selected"))).toEqual(["true","false"]);
      expect(p.root.querySelector(".runtime-install-tabs").getAttribute("role")).toBe("tablist");
      const panel=p.root.querySelector(".runtime-install-panel");expect(panel.getAttribute("role")).toBe("tabpanel");expect(panel.getAttribute("aria-labelledby")).toBe(tabs()[0].id);
      expect(tabs()[0].getAttribute("aria-controls")).toBe(panel.id);
      expect(p.root.textContent).not.toMatch(/macOS|Linux tab/i);expect(tabs()).toHaveLength(2);
    });
    it("shows the install and connect commands with the confirmed address, no code, no ZIP step, and no account option",async()=>{
      await open("runtime-windows-commands");
      expect(stepTitles()).toEqual(["AgEnD address","Install the Runtime","Connect that computer","Return here to approve"]);
      expect(commands()).toEqual([`[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor 3072; $agend = 'http://localhost'; $s = $null; $h = $null; $s = (iwr "$agend/runtime/install.ps1" -UseBasicParsing).Content; $h = (-join ([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($s)) | % { $_.ToString('x2') })); if ($s -and $h -eq '${SCRIPT_SHA}') { iex $s } else { Write-Host 'install.ps1 could not be verified against the hash on the AgEnD page (a certificate or download error above is the usual cause: trust this AgEnD certificate, or use the ZIP; otherwise reload the page and copy the command again)' -ForegroundColor Red; throw 'install.ps1 was not run' }`,'agend-runtime connect --server "http://localhost"']);
      // The hash the command checks is on the page, and it came from the administrator-only endpoint, not from the script's own response.
      expect(p.root.querySelector(".runtime-installer-hash code").textContent).toBe(SCRIPT_SHA);
      expect(requests.filter(item=>item.path==="/ui/runtimes/installer")).toHaveLength(1);
      expect(requests.some(item=>item.path.includes("install.ps1"))).toBe(false);
      expect(p.root.querySelector(".runtime-bundle-download")).toBeNull();expect(p.root.textContent).not.toContain("connect-agend.bat");
      expect(commands().join(" ")).not.toContain("PAIR-TEST-CODE");expect(p.root.querySelector(".runtime-pair-code").value).toBe("PAIR-TEST-CODE");
      // The multi-account option and its flags are not part of this feature.
      expect(p.root.textContent).not.toMatch(/another Claude account|claude-config-dir|--profile/i);expect(p.root.querySelectorAll('.runtime-pairing input[type=checkbox]')).toHaveLength(0);
      expect(p.root.textContent).toContain("never put in the command");expect(p.root.textContent).toContain("22.14");
    });
    it("rewrites both commands when the address changes, and shows neither for an unsafe one",async()=>{
      await open("runtime-windows-address");
      await setServer("https://fleet.example.test:10443");
      expect(commands()).toEqual([installCommand("https://fleet.example.test:10443",SCRIPT_SHA),'agend-runtime connect --server "https://fleet.example.test:10443"']);
      expect(commands()[0]).toContain("$agend = 'https://fleet.example.test:10443'");expect(commands()[0]).toContain(`$h -eq '${SCRIPT_SHA}'`);
      for(const bad of ["http://192.168.1.20:19280","https://user:password@fleet.example.test","https://fleet.example.test/path","https://fleet.example.test/?x=1","https://fleet.example.test'; calc; '"]){
        await setServer(bad);expect(commands(),bad).toEqual([]);expect(p.root.querySelector('.runtime-pairing [role="alert"]').textContent).toContain("Enter an HTTPS origin");
      }
    });
    it("offers no install command, and says why, when the server cannot supply the installer hash; retrying brings it back",async()=>{
      installerMode="fail";await open("runtime-windows-no-installer");
      expect(commands()).toEqual(['agend-runtime connect --server "http://localhost"']);   // only the connect command; there is no unpinned install command
      expect(p.root.querySelector(".runtime-installer-error").textContent).toContain("cannot offer the installer");expect(p.root.querySelector(".runtime-installer-hash")).toBeNull();
      expect(p.root.querySelector(".runtime-install-panel").textContent).not.toMatch(/\birm\b/);
      installerMode="ok";button("Try again").click();await settle(8);
      expect(commands()).toHaveLength(2);expect(commands()[0]).toBe(installCommand("http://localhost",SCRIPT_SHA));expect(p.root.querySelector(".runtime-installer-error")).toBeNull();
    });
    it("tells the administrator what to do on a TLS error or a restricted PowerShell, and never suggests turning checks off",async()=>{
      await open("runtime-windows-tls");
      const text=p.root.querySelector(".runtime-install-panel").textContent;
      expect(text).toContain("certificate error");expect(text).toContain("trust this AgEnD's certificate");expect(text).toContain("use the ZIP");
      expect(text).toContain("Constrained Language Mode or AppLocker");expect(text).toContain("never changes your execution policy");
      expect(text).toMatch(/Never turn certificate checks off/);
      expect(text).not.toMatch(/SkipCertificateCheck|ServerCertificateValidationCallback|-ExecutionPolicy|Set-ExecutionPolicy|setx/i);
    });
    it("shows a computer whose Runtime is not compatible with this AgEnD as needing the install command again",async()=>{
      machines=[{...machine(idA,"Desktop","offline"),runtimeInfo:{version:"1.0.0",buildId:"a".repeat(64),protocolVersions:[2],capabilities:["exec"]},runtimeCompatibility:"incompatible"},machine(idB,"Laptop")];
      await p.mount(h(Panel,{navKey:"runtime-reinstall"}));await settle(12);
      const card=p.root.querySelector(`[data-machine-id="${idA}"] .runtime-reinstall`);
      expect(card.textContent).toContain("not compatible with this AgEnD");expect(card.textContent).toContain("Run the install command");expect(card.textContent).toContain("pairing is kept");
      expect(card.getAttribute("role")).toBe("alert");expect(p.root.querySelector(`[data-machine-id="${idB}"] .runtime-reinstall`)).toBeNull();
      p.root.querySelector(`[data-machine-id="${idA}"] .runtime-machine-menu button`).click();await settle();button("Computer information").click();await settle();
      expect(p.root.querySelector(".runtime-compatibility").textContent).toContain("re-run the install command");
    });
    it("copies exactly the command shown, and marks it copied for a moment",async()=>{
      const written:string[]=[];Object.defineProperty(globalThis.navigator,"clipboard",{value:{writeText:async(text:string)=>{written.push(text);}},configurable:true});
      try{
        await open("runtime-windows-copy");
        const copy=(index:number)=>p.root.querySelectorAll(".runtime-command-row .btn")[index];
        copy(0).click();await settle(6);copy(1).click();await settle(6);
        expect(written).toEqual(commands());expect(copy(1).textContent).toContain("Copied");
      }finally{Object.defineProperty(globalThis.navigator,"clipboard",{value:undefined,configurable:true});}
    });
    it("keeps the existing waiting behaviour: the code card waits, the flow moves on once the install command is copied, and to approval when a computer asks",async()=>{
      Object.defineProperty(globalThis.navigator,"clipboard",{value:{writeText:async()=>{}},configurable:true});
      try{
        machines=[machine(idA,"Desktop")];await open("runtime-windows-waiting");
        expect(p.root.querySelector('.runtime-step[aria-current="step"] h4').textContent).toBe("Install the Runtime");
        expect(p.root.querySelector(".runtime-pair-card .runtime-pair-status").textContent).toContain("Waiting for the computer to connect");
        p.root.querySelectorAll(".runtime-command-row .btn")[0].click();await settle(6);
        expect(p.root.querySelector('.runtime-step[aria-current="step"] h4').textContent).toBe("Connect that computer");
      }finally{Object.defineProperty(globalThis.navigator,"clipboard",{value:undefined,configurable:true});}
      expect(requests.filter(item=>item.path==="/ui/runtimes").length).toBeGreaterThan(0);
    });
    it("lands on the approval step with the fingerprint card when a computer is pending, whichever tab is open",async()=>{
      await open("runtime-windows-approval");
      expect(p.root.querySelector('.runtime-step[aria-current="step"] h4').textContent).toBe("Return here to approve");
      expect(p.root.querySelector(".runtime-pair-card .runtime-pair-status").textContent).toContain("A computer is waiting for your approval");
      await zipTab();expect(p.root.querySelector('.runtime-step[aria-current="step"] h4').textContent).toBe("Return here to approve");
    });
    it("switches by click and by arrow, Home and End keys, moving focus with the selection",async()=>{
      await open("runtime-windows-keys");
      tabs()[1].click();await settle(4);expect(tabs().map((item:any)=>item.getAttribute("aria-selected"))).toEqual(["false","true"]);
      expect(p.root.querySelector(".runtime-install-panel").getAttribute("data-install-method")).toBe("zip");expect(p.root.querySelector(".runtime-bundle-download")).not.toBeNull();expect(commands()).toEqual([]);
      expect(tabs().map((item:any)=>item.getAttribute("tabindex"))).toEqual(["-1","0"]);
      fire(tabs()[1],"keydown",{key:"ArrowRight"});await settle(6);expect(tabs()[0].getAttribute("aria-selected")).toBe("true");
      fire(tabs()[0],"keydown",{key:"End"});await settle(6);expect(tabs()[1].getAttribute("aria-selected")).toBe("true");
      fire(tabs()[1],"keydown",{key:"Home"});await settle(6);expect(tabs()[0].getAttribute("aria-selected")).toBe("true");
      const other=fire(tabs()[0],"keydown",{key:"a"});expect(other.defaultPrevented).toBe(false);
    });
    it("keeps the ZIP flow as it was inside its tab: download, connect-agend.bat and the manual command",async()=>{
      await open("runtime-zip-unchanged");await zipTab();
      expect(stepTitles()).toEqual(["AgEnD address","Download the Runtime","Double-click connect-agend.bat there","Return here to approve"]);
      expect(p.root.querySelector(".runtime-command").value).toBe('.\\agend-runtime.cmd connect --server "http://localhost"');
      expect(p.root.querySelector(".runtime-bundle-download").textContent).toContain("Download Windows Runtime");
    });
  });
  it("downloads a connection-ready ZIP with the reviewed address in a protected POST and claims one download",async()=>{
    const fixtureFetch=globalThis.fetch;let release!:(value:unknown)=>void;const create=vi.spyOn(URL,"createObjectURL").mockReturnValue("blob:runtime-fixture"),revoke=vi.spyOn(URL,"revokeObjectURL").mockImplementation(()=>{});
    globalThis.fetch=(async(path:any,options:any)=>{
      if(path!=="/ui/runtimes/download/windows")return fixtureFetch(path,options);
      requests.push({path,body:JSON.parse(options.body)});return new Promise(resolve=>{release=resolve;});
    }) as any;
    try{
      await p.mount(h(Panel,{navKey:"runtime-download-config"}));await settle(12);button("Download Windows Runtime (ZIP)").click();await settle(12);await zipTab();
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
  it("does not list a revoked computer on load, nor offer it when creating an Agent",async()=>{
    machines=[machine(idA,"Desktop"),machine(idB,"Laptop","revoked")];
    await p.mount(h(Panel,{navKey:"revoked-on-load"}));await settle(12);
    expect(p.root.querySelector(`[data-machine-id="${idA}"]`)).not.toBeNull();expect(p.root.querySelector(`[data-machine-id="${idB}"]`)).toBeNull();
    expect(p.root.textContent).not.toContain("Laptop");expect(p.root.querySelector(".runtime-computers-heading .note").textContent).toBe("1 computers");
    await p.unmount();catalog.forgetRuntimeCatalog();
    await p.mount(h(Create,{onClose(){}}));await settle(8);
    const values=p.root.querySelectorAll(".agent-runtime-picker input").map((item:any)=>item.value);
    expect(values).toContain(`machine:${idA}`);expect(values).not.toContain(`machine:${idB}`);
  });
  it("keeps a computer revoked on this page as a revoked card, through polling, until the page is left",async()=>{
    (globalThis as any).confirm=()=>true;await p.mount(h(Panel,{navKey:"revoked-here"}));await settle(12);
    const card=()=>p.root.querySelector(`[data-machine-id="${idA}"]`);
    expect(card().querySelector(".runtime-kind").textContent).toBe("Paired");
    card().querySelector(".runtime-machine-menu button").click();await settle();button("Revoke connection").click();await settle();
    await settle(12);
    expect(requests).toContainEqual({path:`/ui/runtimes/machines/${idA}/revoke`,body:{}});
    expect(card()).not.toBeNull();expect(card().className).toContain("is-revoked");
    expect(card().querySelector(".runtime-status").textContent).toBe("Revoked");expect(card().querySelector(".runtime-kind")).toBeNull();expect(card().textContent).not.toContain("Paired");
    expect(card().querySelector(".runtime-cli-table")).toBeNull();expect(card().querySelector(".runtime-inspect")).toBeNull();
    expect(card().querySelector(".runtime-revoked-note").textContent).toBe("Revoked. It leaves this list when you refresh the page.");
    button("Refresh machines").click();await settle(12);
    expect(card()).not.toBeNull();expect(card().className).toContain("is-revoked");
    expect(p.root.querySelector(`[data-machine-id="${idB}"]`)).not.toBeNull();expect(p.root.querySelector(".runtime-empty-remotes")).toBeNull();
    await p.unmount();catalog.forgetRuntimeCatalog();
    await p.mount(h(Panel,{navKey:"revoked-here-reloaded"}));await settle(12);
    expect(card()).toBeNull();expect(p.root.textContent).not.toContain("Desktop");expect(p.root.querySelector(`[data-machine-id="${idB}"]`)).not.toBeNull();
  });
  it("drops a computer revoked on the page when the page is left and opened again, with the loaded list still cached",async()=>{
    (globalThis as any).confirm=()=>true;await p.mount(h(Panel,{navKey:"revoked-leave"}));await settle(12);
    p.root.querySelector(`[data-machine-id="${idA}"] .runtime-machine-menu button`).click();await settle();button("Revoke connection").click();await settle(12);
    expect(p.root.querySelector(`[data-machine-id="${idA}"]`).className).toContain("is-revoked");
    await p.unmount(); // the catalog is NOT forgotten: only the page's own memory of the revocation goes
    await p.mount(h(Panel,{navKey:"revoked-leave-again"}));await settle(12);
    expect(p.root.querySelector(`[data-machine-id="${idA}"]`)).toBeNull();expect(p.root.querySelector(`[data-machine-id="${idB}"]`)).not.toBeNull();
  });
  it("shows the empty note once the only computer is revoked and the page is reloaded",async()=>{
    machines=[machine(idA,"Desktop","revoked")];await p.mount(h(Panel,{navKey:"only-revoked"}));await settle(12);
    expect(p.root.querySelector(".runtime-machine")).toBeNull();expect(p.root.querySelector(".runtime-empty-remotes").textContent).toBe("No remote computers connected yet.");
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
    // The Windows one-line commands carry the same origin and nothing else: no pairing code, no token, no flag the page did not choose.
    expect(installCommand("https://runtime.example.com:443",SCRIPT_SHA)).toContain("$agend = 'https://runtime.example.com'; $s = $null; $h = $null; $s = (iwr \"$agend/runtime/install.ps1\" -UseBasicParsing).Content;");
    expect(installCommand("http://localhost:19280",SCRIPT_SHA)).toContain("$agend = 'http://localhost:19280';");
    expect(windowsConnectCommand("https://runtime.example.com:443")).toBe('agend-runtime connect --server "https://runtime.example.com"');
    for(const bad of ["http://192.168.1.2:19280","https://user:password@example.com","https://example.com/?x=$(calc)","https://$(calc)","https://example.com/path","https://example.com;calc","https://exa'mple.com","https://example.com/'; calc; '","",undefined as any]){
      expect(installCommand(bad,SCRIPT_SHA),String(bad)).toBe("");expect(windowsConnectCommand(bad),String(bad)).toBe("");
    }
    for(const good of ["https://runtime.example.com","https://[fd7a:115c::1]:8445","http://127.0.0.1:19280"]){
      const text=installCommand(good,SCRIPT_SHA);
      expect(text).toMatch(/^\[Net\.ServicePointManager\]::SecurityProtocol = \[Net\.ServicePointManager\]::SecurityProtocol -bor 3072; \$agend = '[^']*'; \$s = \$null; \$h = \$null; \$s = \(iwr "\$agend\/runtime\/install\.ps1" -UseBasicParsing\)\.Content; \$h = \(-join /);
      // the rule: nothing that can fail sits in the condition, and iex is only inside the branch the condition admits
      expect(text).toMatch(/if \(\$s -and \$h -eq '[a-f0-9]{64}'\) \{ iex \$s \} else \{ Write-Host '[^']*' -ForegroundColor Red; throw '[^']*' \}$/); expect(text.match(/\biex\b/g)).toHaveLength(1);
      expect(text.slice(0, text.indexOf("if ($s -and"))).not.toMatch(/\biex\b/);
      // one line; no certificate bypass, no execution-policy change, no setx, no pairing code
      expect(text).not.toMatch(/\n|SkipCertificateCheck|ServerCertificateValidationCallback|Set-ExecutionPolicy|-ExecutionPolicy|setx|\|\s*iex/i);
    }
    // The command needs the server's hash: without a valid one there is no command to copy (never an unpinned fallback).
    for(const bad of ["",undefined,null,"A".repeat(64),"abc","g".repeat(64),`${SCRIPT_SHA}'; calc; '`])expect(installCommand("https://runtime.example.com",bad as any),String(bad)).toBe("");
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
