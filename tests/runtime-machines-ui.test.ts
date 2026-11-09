import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";

let p:AppPage, Panel:any, Create:any, catalog:any, windowsCatalog:any, windowsInventory:any, models:any, app:any, routes:any, connectCommand:any, installCommand:any, installOnlyCommand:any, windowsConnectCommand:any, enrollCommand:any;
const originalFetch=globalThis.fetch;
const idA="12345678-1234-4321-abcd-123456789012", idB="22345678-1234-4321-abcd-123456789012";
const requests:Array<{path:string;body:any}>=[];
const cli=()=>({id:"codex",path:"C:\\tools\\codex.exe",runnable:true,authenticated:true,version:"1.0",readOnlySupport:true,supports:{execution:true,resume:true,mcp:true},models:[]});
const machine=(id:string,name:string,status="online")=>({id,name,status,...(status==="pending"?{pairingFingerprint:"ABCD-1234-5678"}:{}),platform:"win32",version:"1.0",lastSeenAt:Date.now(),inventoryUpdatedAt:Date.now(),inventory:{home:`C:\\${name}`,clis:[cli(),{id:"muse",path:null,runnable:false}]}});
let machines:any[], enabled:boolean, installerMode="ok", enrollments:any[]=[], enrollSeq=0, pairingTtl=60000, enrollSkew=0;
const TOKEN="agend_enroll_"+"Qw3_-".repeat(9).slice(0,43), FINGERPRINT="cd".repeat(32), ENROLL_ID="aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const SCRIPT_SHA="ab".repeat(32);
const response=(body:any,status=200)=>({ok:status>=200&&status<300,status,json:async()=>body});
const button=(text:string)=>p.root.querySelectorAll("button").find((item:any)=>item.textContent.trim()===text);
const zipTab=async()=>{const tab=p.root.querySelectorAll('[role="tab"]').find((item:any)=>item.textContent.trim()==="Other install methods (ZIP)");tab.click();await settle(4);};
const choose=async(id:string)=>{const input=p.root.querySelectorAll(".agent-runtime-picker input").find((item:any)=>item.value===`machine:${id}`);input.checked=true;fire(input,"change");await settle(5);};

beforeAll(async()=>{
  p=page({url:"http://localhost/settings/runtimes",storage:{agend_lang:"en"}});
  globalThis.fetch=(async(path:string,options:any={})=>{
    const body=options.body?JSON.parse(options.body):null;requests.push({path,body});
    if(path==="/ui/runtimes")return response({enabled,machines,enrollments});
    if(path==="/ui/runtimes/enrollment"){
      enrollSeq++;const issued={id:`${ENROLL_ID.slice(0,-1)}${enrollSeq}`,token:TOKEN,fingerprint:FINGERPRINT,createdAt:Date.now()+enrollSkew,expiresAt:Date.now()+enrollSkew+15*60_000};
      enrollments=[{id:issued.id,status:"unused",createdAt:issued.createdAt,expiresAt:issued.expiresAt},...enrollments.map(row=>row.status==="unused"?{...row,status:"revoked"}:row)];return response(issued,201);
    }
    const enrollRevoke=/^\/ui\/runtimes\/enrollment\/([^/]+)\/revoke$/.exec(path);
    if(enrollRevoke){enrollments=enrollments.map(row=>row.id===enrollRevoke[1]?{...row,status:"revoked"}:row);return response({enrollment:enrollments.find(row=>row.id===enrollRevoke[1])});}
    if(path==="/ui/windows-cli/probe") {
      if(body?.force) windowsInventory={...windowsInventory,hostname:"REFRESHED-DESKTOP"};
      return response(windowsInventory);
    }
    if(path==="/ui/windows-cli/tasks")return response({tasks:[]});
    const diagnostic=/^\/ui\/runtimes\/machines\/([^/]+)\/(inventory|probe|tasks)$/.exec(path);
    if(diagnostic){const target=machines.find(item=>item.id===diagnostic[1]);return response(diagnostic[2]==="tasks"?{tasks:[]}:{inventory:target?.inventory || null});}
    if(path==="/api/settings/runtimes")return response({switches:{windows_cli:{on:false,configured:false,environment:null},remote_runtime:{on:enabled,configured:enabled,environment:null}},max_agents_per_machine:{value:4,min:1,max:16,default:4},local_origin:"http://127.0.0.1:19280"});
    if(path==="/ui/runtimes/installer"){return installerMode==="fail"?response({error:"unavailable"},503):response({version:"2.3.5-alpha.7",scriptSha256:SCRIPT_SHA,scriptBytes:13536,bundleSha256:"c".repeat(64)});}
    if(path==="/ui/runtimes/pairing")return response({pairingId:"test",code:"PAIR-TEST-CODE",expiresAt:Date.now()+pairingTtl});
    const renaming=/^\/ui\/runtimes\/machines\/([^/]+)\/rename$/.exec(path);
    if(renaming){machines=machines.map(item=>item.id===renaming[1]?{...item,name:body.name}:item);return response({ok:true});}
    const rejecting=/^\/ui\/runtimes\/machines\/([^/]+)\/reject$/.exec(path);
    if(rejecting){
      const target=machines.find(item=>item.id===rejecting[1]);
      if(!target || target.status!=="pending")return response({error:"This computer was already handled",code:"not-pending"},409);
      machines=machines.map(item=>item.id===rejecting[1]?{...item,status:"revoked"}:item);return response({machine:{id:rejecting[1],status:"revoked"}});
    }
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
  const runtimeUi=await import("/ui/js/panel-runtimes.js");Panel=runtimeUi.RuntimesPanel;connectCommand=runtimeUi.runtimeConnectCommand;installCommand=runtimeUi.runtimeInstallCommand;installOnlyCommand=runtimeUi.runtimeInstallOnlyCommand;windowsConnectCommand=runtimeUi.runtimeWindowsConnectCommand;enrollCommand=runtimeUi.runtimeEnrollCommand;Create=(await import("/ui/js/panel-fleet.js")).CreateInstanceDialog;routes=await import("/assets/app-route.js");
});
beforeEach(()=>{requests.length=0;enabled=true;installerMode="ok";enrollments=[];enrollSeq=0;pairingTtl=60000;enrollSkew=0;machines=[machine(idA,"Desktop"),machine(idB,"Laptop","pending")];windowsInventory={home:"C:\\Test",hostname:"WINDOWS-DESK",probedAt:1,clis:[cli()]};windowsCatalog.forgetWindowsCliCatalog();catalog.forgetRuntimeCatalog();models.forgetCatalogs();app.appStore.set({windowsCli:false});});
afterEach(async()=>{await p.unmount();catalog.forgetRuntimeCatalog();vi.restoreAllMocks();});
afterAll(()=>{p.restore();globalThis.fetch=originalFetch;});

const machineTimeOf=(value:number)=>new Date(value).toLocaleString();
const diagnosticDialog=()=>p.root.querySelector(".runtime-diagnostics-dialog");
const closeDiagnostics=async()=>{diagnosticDialog().querySelector(".dlg-x").click();await settle(8);};
const openDiagnostics=async(id="")=>{
  if(diagnosticDialog())await closeDiagnostics();
  p.root.querySelector(`[data-machine-id="${id || "local"}"] .runtime-inspect`).click();await settle(12);
};

describe("remote machine UI",()=>{
  it.each(["en","zh-TW"])("shows pending/failed targets and a pinned separate-install repair without creating a pairing (%s)",async lang=>{
    const i18n=await import("/assets/app-i18n.js"), updateUi=await import("/ui/js/runtime-update-status.js");i18n.setLang(lang,{store:false});
    try {
      const target={version:"2.3.5-alpha.12",bundleSha256:"a".repeat(64)}, bootId="32345678-1234-4321-abcd-123456789012";
      machines=[{...machine(idA,"Fake desktop"),bootId,generation:3,runtimeInfo:{version:"2.3.5-alpha.11",buildId:"b".repeat(64),capabilities:["managed-update-status-v1"]},updateReport:{bootId,generation:3,reportedAt:1,status:{state:"pending",target}}}];
      await p.mount(h(Panel,{navKey:`update-pending-${lang}`}));await settle(12);
      let notice=p.root.querySelector(".runtime-update-notice");
      expect(notice.textContent).toContain(updateUi.runtimeUpdateText("pending",target.version,"aaaaaaaa"));expect(notice.textContent).toContain("2.3.5-alpha.11");
      expect(notice.getAttribute("role")).toBe("status");expect(notice.querySelector("button")).toBeNull();
      machines[0]={...machines[0],updateReport:{...machines[0].updateReport,status:{state:"failed",target}}};catalog.forgetRuntimeCatalog();await p.unmount();
      await p.mount(h(Panel,{navKey:`update-failed-${lang}`}));await settle(12);
      notice=p.root.querySelector(".runtime-update-notice");expect(notice.textContent).toContain(updateUi.runtimeUpdateText("failed",target.version,"aaaaaaaa"));expect(notice.getAttribute("role")).toBe("alert");
      machines[0]={...machines[0],updateReport:{...machines[0].updateReport,status:{state:"manual",reason:"shared"}}};catalog.forgetRuntimeCatalog();await p.unmount();
      await p.mount(h(Panel,{navKey:`update-manual-${lang}`}));await settle(12);
      p.root.querySelector(".runtime-update-notice button").click();await settle(12);
      const text=p.root.textContent;expect(text).toContain(updateUi.runtimeUpdateText("repairHint"));
      const copied=p.root.querySelectorAll("code").map((code:any)=>code.textContent).join(" ");
      expect(copied).toContain(SCRIPT_SHA);expect(copied).toContain("AGEND_RUNTIME_INSTALL_DIR");expect(copied).toContain("[Guid]::NewGuid()");expect(copied).toContain("$agend = 'http://localhost'");expect(copied).toContain("$agend/runtime/install.ps1");
      expect(copied).not.toContain("PAIR-TEST-CODE");expect(requests.some(r=>r.path==="/ui/runtimes/installer")).toBe(true);expect(requests.some(r=>r.path==="/ui/runtimes/pairing")).toBe(false);
    } finally {i18n.setLang("en",{store:false});}
  });
  it("never labels an offline/old-boot current report as the current connection's build",async()=>{
    const updateUi=await import("/ui/js/runtime-update-status.js");
    machines=[{...machine(idA,"Fake desktop","offline"),bootId:"new",generation:4,updateReport:{bootId:"old",generation:3,reportedAt:1,status:{state:"current"}}}];
    await p.mount(h(Panel,{navKey:"update-old-report"}));await settle(12);
    const notice=p.root.querySelector(".runtime-update-notice");expect(notice.textContent).toContain(updateUi.runtimeUpdateText("unknown"));expect(notice.textContent).toContain(updateUi.runtimeUpdateText("last"));expect(notice.textContent).not.toContain(updateUi.runtimeUpdateText("current"));
    expect(updateUi.runtimeFreshInstallCommand("https://other.test/path",SCRIPT_SHA)).toBe("");expect(updateUi.runtimeFreshInstallCommand("https://other.test","invalid")).toBe("");
  });
  it("Needs you groups the failed build under Runtime and offers navigation without an approval action",async()=>{
    const {NeedsPanel}=await import("/ui/js/panel-needs.js"),updateUi=await import("/ui/js/runtime-update-status.js");
    app.appStore.set({proposals:[],needs:[{id:"runtime-update:fake:hash",type:"runtime",instance:"",reason:"dialog",runtimeUpdate:true,since:1,detail:"Fake desktop: update failed 2.3.5-alpha.12 / aaaaaaaa"}]});
    try {
      await p.mount(h(NeedsPanel,{navKey:"runtime-needs"}));await settle(8);
      expect(p.root.querySelector(".n-group-head").textContent).toBe(updateUi.runtimeUpdateText("attention"));
      expect(p.root.querySelector('.n-item a[href="/settings/runtimes"]').textContent).toBe(updateUi.runtimeUpdateText("open"));
      expect(p.root.querySelector(".n-item").textContent).toContain("2.3.5-alpha.12");expect(p.root.querySelectorAll(".n-item button")).toEqual([]);
    } finally {app.appStore.set({needs:[]});}
  });
  it("shows the selected Runtime's reported version, build and compatibility, with an explicit legacy fallback",async()=>{
    machines[0]={...machines[0],runtimeInfo:{version:"2.3.5-alpha",buildId:"a".repeat(64),protocolVersions:[1],capabilities:["exec","mcp","panes"]},runtimeCompatibility:"compatible"};
    await p.mount(h(Panel,{navKey:"runtime-version-info"}));await settle(12);
    const openInfo=async(id:string)=>{p.root.querySelector(`[data-machine-id="${id}"] .runtime-machine-menu button`).click();await settle();button("Computer information").click();await settle();};
    await openInfo(idA);expect(p.root.querySelector(".runtime-reported-version").textContent).toBe("2.3.5-alpha");expect(p.root.querySelector(".runtime-reported-build").textContent).toBe("a".repeat(64));
    expect(p.root.querySelector(".runtime-compatibility").textContent).toBe("Compatible");expect(p.root.querySelector(".runtime-machine-facts").textContent).toContain("Persistent terminals");
    p.root.querySelector(".dlg-x").click();await settle();await openInfo(idB);
    expect(p.root.querySelector(".runtime-reported-version").textContent).toBe("This Runtime does not provide version information");expect(p.root.querySelector(".runtime-reported-build")).toBeNull();
  });
  it("labels a persistent-pane CLI version AgEnD has not audited (cc3ce4fe) on the card and in diagnostics, and says nothing for verified or other CLIs",async()=>{
    machines[0]={...machines[0],inventory:{...machines[0].inventory,clis:[{...cli(),version:"codex-cli 0.199.0",paneVerification:"unverified"},{...cli(),id:"claude-code",version:"2.1.316",paneVerification:"verified"},{...cli(),id:"grok",version:"1.0.70"}]}};
    await p.mount(h(Panel,{navKey:"runtime-pane-unverified"}));await settle(12);
    const card=p.root.querySelector(`[data-machine-id="${idA}"]`),tags=card.querySelectorAll(".runtime-cli-table .tag");
    expect(tags.map((tag:any)=>tag.textContent)).toEqual(["Not yet verified"]);expect(tags[0].getAttribute("title")).toContain("has not tested this version in Windows panes");
    await openDiagnostics(idA);
    expect(diagnosticDialog().querySelectorAll(".windows-cli-diagnostic-row .tag").map((tag:any)=>tag.textContent)).toEqual(["Not yet verified"]);
  });
  it("uses the same machine cards and does not load task history until diagnostics open",async()=>{
    app.appStore.set({windowsCli:true});await p.mount(h(Panel,{navKey:"unified-machine-cards"}));await settle(12);
    const cards=p.root.querySelectorAll(".runtime-machine");expect(cards).toHaveLength(3);
    expect(cards.map((card:any)=>card.querySelector(".runtime-cli-table")!==null)).toEqual([true,true,true]);
    // the computer waiting for approval is first, then this PC, then the paired ones.
    expect(cards[0].querySelector("h3").textContent).toBe("LaptopPaired");
    expect(cards[1].querySelector("h3").textContent).toBe("WINDOWS-DESKThis PC");
    expect(cards[2].querySelector("h3").textContent).toBe("DesktopPaired");
    expect(cards[1].querySelector(".runtime-inspect").textContent).toBe(cards[2].querySelector(".runtime-inspect").textContent);
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
  describe("waiting computers open an approval dialog, come first, and same-name computers can be told apart",()=>{
    const idC="32345678-1234-4321-abcd-123456789012", idD="42345678-1234-4321-abcd-123456789012";
    const asked=(id:string,name:string,createdAt:number,fingerprint:string)=>({...machine(id,name,"pending"),pairingFingerprint:fingerprint,hostname:`${name.toUpperCase()}-HOST`,createdAt});
    const ask=()=>p.root.querySelector("dialog.runtime-approve-dialog");
    const inAsk=(sel:string)=>ask()?.querySelector(sel);
    const askButton=(text:string)=>ask()?.querySelectorAll("button").find((item:any)=>item.textContent.trim()===text);
    const refresh=async()=>{button("Refresh machines").click();await settle(10);};
    /** "1 of 2" (or the Chinese form): the first note in the dialog, only when more than one computer is in its list. */
    const count=()=>{const first=ask()?.querySelector(".dlg-body > .note")?.textContent ?? "";return /^\d+ of \d+$|^第 \d+ 台，共 \d+ 台$/.test(first) ? first : null;};
    const armed=()=>new Promise(done=>setTimeout(done,1100));
    const mountPage=async(key:string)=>{await p.mount(h(Panel,{navKey:key}));await settle(10);};
    it("opens by itself for a waiting computer, with its facts and the pairing fingerprint large, and keeps the card's own Approve",async()=>{
      machines=[machine(idA,"Desktop"),asked(idB,"Laptop",1_700_000_000_000,"ABCD-1234-5678")];
      await mountPage("ask-open");
      expect(ask()?.open).toBe(true);expect(inAsk(".dlg-title").textContent).toBe("A computer wants to pair");
      const facts=inAsk(".runtime-machine-facts").textContent;
      for(const text of ["Laptop","LAPTOP-HOST","Windows"])expect(facts).toContain(text);
      expect(inAsk(".runtime-approve-fingerprint").textContent).toBe("ABCD-1234-5678");
      expect(ask()!.textContent).toContain("Compare this fingerprint with the one shown in the requesting Runtime before approving.");
      expect(count()).toBeNull();   // one computer: no "1 of 1"
      expect(askButton("Later")).toBeTruthy();expect(askButton("Reject")).toBeTruthy();expect(askButton("Approve")).toBeTruthy();
      expect(button("Approve computer"),"the card keeps its own Approve").toBeTruthy();
      expect(p.root.querySelector(`[data-machine-id="${idB}"] .runtime-pairing-fingerprint`).textContent).toBe("ABCD-1234-5678");
      expect(requests.filter(r=>/\/(approve|reject|revoke)$/.test(r.path))).toEqual([]);   // nothing is decided by opening
    });
    it("keeps Approve off for a second after it shows, then approves with the fingerprint and closes",async()=>{
      machines=[machine(idA,"Desktop"),asked(idB,"Laptop",1,"ABCD-1234-5678")];
      await mountPage("ask-approve");
      expect(askButton("Approve").disabled).toBe(true);   // a browser sends no click to a disabled button
      expect(requests.filter(r=>r.path.endsWith("/approve"))).toEqual([]);
      await armed();await settle(4);
      expect(askButton("Approve").disabled).toBe(false);
      askButton("Approve").click();await settle(10);
      expect(requests).toContainEqual({path:`/ui/runtimes/machines/${idB}/approve`,body:{fingerprint:"ABCD-1234-5678"}});
      expect(ask()).toBeNull();
      expect(p.root.querySelector(`[data-machine-id="${idB}"]`).textContent).toContain("Online");
    });
    it("never offers Approve without a fingerprint",async()=>{
      machines=[machine(idA,"Desktop"),{...asked(idB,"Laptop",1,"ABCD-1234-5678"),pairingFingerprint:undefined}];
      await mountPage("ask-no-fingerprint");await armed();await settle(4);
      expect(askButton("Approve").disabled).toBe(true);
    });
    it("Later, Esc and × only close it: no request, and the same computer does not open it again on the next poll",async()=>{
      machines=[machine(idA,"Desktop"),asked(idB,"Laptop",1,"ABCD-1234-5678")];
      await mountPage("ask-later");
      askButton("Later").click();await settle(6);expect(ask()).toBeNull();
      await refresh();expect(ask()).toBeNull();
      expect(requests.filter(r=>/\/(approve|reject|revoke)$/.test(r.path))).toEqual([]);
      expect(button("Approve computer"),"the card can still approve").toBeTruthy();
      // The banner is the way back in.
      button("Review and approve").click();await settle(6);expect(ask()?.open).toBe(true);
      inAsk(".dlg-x").click();await settle(6);expect(ask()).toBeNull();
      button("Review and approve").click();await settle(6);
      fire(ask()!,"cancel");await settle(6);expect(ask()).toBeNull();
    });
    it("a computer that arrives while the dialog is open joins its list; Later is final for every computer in it, and only a computer never asked about opens it again",async()=>{
      machines=[machine(idA,"Desktop"),asked(idB,"Laptop",1,"ABCD-1234-5678")];
      await mountPage("ask-new");
      expect(count()).toBeNull();
      machines=[...machines,asked(idC,"Lab",2,"1111-2222-3333")];await refresh();
      expect(ask()?.open,"the open dialog is not 'another dialog': the new computer joins it").toBe(true);
      expect(count()).toBe("1 of 2");expect(inAsk(".runtime-machine-facts").textContent).toContain("Laptop");   // the oldest first
      askButton("Later").click();await settle(6);expect(ask()).toBeNull();
      // A poll later, with both still waiting: neither comes back, whatever the clock or the count.
      await refresh();await refresh();expect(ask(),"Laptop and Lab were put off: nothing comes back by itself").toBeNull();
      // A third arrives: only it opens the dialog, alone.
      machines=[...machines,asked(idD,"Bench",3,"5555-6666-7777")];await refresh();
      expect(ask()?.open).toBe(true);expect(count()).toBeNull();
      expect(inAsk(".runtime-machine-facts").textContent).toContain("Bench");expect(inAsk(".runtime-approve-fingerprint").textContent).toBe("5555-6666-7777");
      askButton("Later").click();await settle(6);await refresh();expect(ask()).toBeNull();
      // They are all still one click away: the bar counts them, and its button opens the dialog over all that wait.
      expect(p.root.querySelector(".runtime-pending-banner").textContent).toContain("3 computers are waiting for approval");
      button("Review and approve").click();await settle(6);expect(count()).toBe("1 of 3");
    });
    it("goes from one waiting computer to the next after approving, each with its own fingerprint and its own armed delay",async()=>{
      machines=[machine(idA,"Desktop"),asked(idB,"Laptop",1,"ABCD-1234-5678"),asked(idC,"Lab",2,"1111-2222-3333")];
      await mountPage("ask-two");
      expect(count()).toBe("1 of 2");expect(inAsk(".runtime-approve-fingerprint").textContent).toBe("ABCD-1234-5678");
      await armed();await settle(4);askButton("Approve").click();await settle(10);
      expect(ask()?.open).toBe(true);expect(inAsk(".runtime-approve-fingerprint").textContent).toBe("1111-2222-3333");
      expect(count()).toBe("2 of 2");expect(askButton("Approve").disabled,"each computer re-arms Approve").toBe(true);
    });
    it("Reject takes the request back (the reject route, never revoke) with no second question and leaves no card behind",async()=>{
      machines=[machine(idA,"Desktop"),asked(idB,"Laptop",1,"ABCD-1234-5678")];
      await mountPage("ask-reject");
      askButton("Reject").click();await settle(10);
      expect(requests.filter(r=>/\/(reject|revoke)$/.test(r.path))).toEqual([{path:`/ui/runtimes/machines/${idB}/reject`,body:{}}]);
      expect(ask()).toBeNull();expect(p.root.querySelector(`[data-machine-id="${idB}"]`)).toBeNull();
      expect(p.root.textContent).not.toContain("Revoked");expect(p.root.querySelector(".runtime-pending-banner")).toBeNull();
    });
    it("puts waiting computers first, oldest first, and counts them in a bar that opens the dialog",async()=>{
      machines=[machine(idA,"Desktop"),asked(idD,"Later-one",20,"4444-5555-6666"),asked(idB,"Laptop",10,"ABCD-1234-5678")];
      app.appStore.set({windowsCli:true});
      await mountPage("ask-order");
      expect(p.root.querySelectorAll(".runtime-machine").map((card:any)=>card.getAttribute("data-machine-id"))).toEqual([idB,idD,"local",idA]);
      expect(p.root.querySelector(".runtime-pending-banner").textContent).toContain("2 computers are waiting for approval");
      askButton("Later").click();await settle(6);
      button("Review and approve").click();await settle(6);
      expect(ask()?.open).toBe(true);expect(count()).toBe("1 of 2");
      askButton("Later").click();await settle(6);
      machines=machines.filter(item=>item.id===idA||item.id===idB);await refresh();
      expect(p.root.querySelector(".runtime-pending-banner").textContent).toContain("1 computer is waiting for approval");
      machines=machines.map(item=>({...item,status:"online"}));await refresh();
      expect(p.root.querySelector(".runtime-pending-banner")).toBeNull();
    });
    it("does not open over a dialog the person is using: it waits until that one closes",async()=>{
      machines=[machine(idA,"Desktop")];
      await mountPage("ask-blocked");
      p.root.querySelector(`[data-machine-id="${idA}"] .runtime-machine-menu button`).click();await settle();button("Rename").click();await settle(6);
      expect(p.root.querySelector("dialog .runtime-rename")).toBeTruthy();
      machines=[...machines,asked(idB,"Laptop",1,"ABCD-1234-5678")];await refresh();
      expect(ask()).toBeNull();
      fire([...p.root.querySelectorAll("dialog .dlg-actions button")].find((b:any)=>b.textContent.trim()==="Cancel"),"click");await settle(6);
      await refresh();expect(ask()?.open).toBe(true);
    });
    it("Reject on a computer that was approved meanwhile (another tab) revokes nothing: 409, \"already handled\", the list is read again",async()=>{
      machines=[machine(idA,"Desktop"),asked(idB,"Laptop",1,"ABCD-1234-5678")];
      await mountPage("ask-race");
      machines=machines.map(item=>item.id===idB?{...item,status:"online"}:item);   // approved elsewhere; this page has not polled yet
      askButton("Reject").click();await settle(10);
      expect(requests.filter(r=>/\/(reject|revoke)$/.test(r.path))).toEqual([{path:`/ui/runtimes/machines/${idB}/reject`,body:{}}]);
      expect(machines.find(item=>item.id===idB)!.status,"the approved computer is still approved").toBe("online");
      expect(p.root.textContent).toContain("This computer was already approved or removed, probably in another tab. The list is up to date now.");
      expect(ask()).toBeNull();expect(p.root.querySelector(`[data-machine-id="${idB}"]`).textContent).toContain("Online");
      expect(p.root.querySelector(`[data-machine-id="${idB}"]`).textContent).not.toContain("Revoked");
    });
    it("does not open for a request that has expired: its card says so, cannot approve, and Reject clears it",async()=>{
      machines=[machine(idA,"Desktop"),{...asked(idB,"Laptop",1,"ABCD-1234-5678"),pairingExpired:true}];
      await mountPage("ask-expired");
      expect(ask(),"nothing pops up for a request nobody can approve").toBeNull();expect(p.root.querySelector(".runtime-pending-banner")).toBeNull();
      const card=p.root.querySelector(`[data-machine-id="${idB}"]`);
      expect(card.textContent).toContain("This request has expired. Run the connect command on that computer again; Reject clears this one.");
      expect(button("Approve computer"),"no Approve on an expired request").toBeUndefined();
      expect(p.root.querySelector(".runtime-pairing-step, .runtime-step[aria-current]")).toBeNull();   // the connect panel is closed, and an expired request is not 'awaiting approval'
      card.querySelector(".runtime-expired-reject").click();await settle(10);
      expect(requests.filter(r=>/\/(reject|revoke)$/.test(r.path))).toEqual([{path:`/ui/runtimes/machines/${idB}/reject`,body:{}}]);
      expect(p.root.querySelector(`[data-machine-id="${idB}"]`)).toBeNull();
    });
    it("shows a computer's own words as text: no markup in a name or host name becomes an element",async()=>{
      const evil='<img src=x onerror=alert(1)><b id="pwn">x</b>';
      machines=[machine(idA,"Desktop"),{...asked(idB,evil,1,"ABCD-1234-5678"),hostname:evil}];
      await mountPage("ask-inject");
      expect(ask()!.querySelector("img, b, #pwn, script")).toBeNull();expect(p.root.querySelector("img[src='x'], #pwn")).toBeNull();
      expect(inAsk(".runtime-machine-facts").textContent).toContain(evil);
    });
    it("with two waiting computers of one name, Reject sends the id of the one on screen and no other",async()=>{
      machines=[machine(idA,"Desktop"),asked(idB,"Same",1,"ABCD-1234-5678"),asked(idC,"same",2,"1111-2222-3333")];
      await mountPage("ask-same-reject");
      expect(inAsk(".runtime-approve-fingerprint").textContent).toBe("ABCD-1234-5678");
      askButton("Reject").click();await settle(10);
      expect(requests.filter(r=>/\/(reject|revoke|approve)$/.test(r.path))).toEqual([{path:`/ui/runtimes/machines/${idB}/reject`,body:{}}]);
      expect(machines.find(item=>item.id===idC)!.status).toBe("pending");
      expect(inAsk(".runtime-approve-fingerprint").textContent,"the next one, with its own fingerprint").toBe("1111-2222-3333");
    });
    it("a computer that joined with an install command never asks: the dialog is for the one waiting, and the joined notice stays an inline notice beside the bar, never a second popup",async()=>{
      const joined={...machine(idC,"Studio"),enrolledVia:"install-command",approvedAt:Date.now()-60_000,createdAt:5};
      machines=[machine(idA,"Desktop"),joined,asked(idB,"Laptop",1,"ABCD-1234-5678")];
      await mountPage("ask-joined");
      expect(ask()?.open).toBe(true);expect(count()).toBeNull();expect(inAsk(".runtime-machine-facts").textContent).toContain("Laptop");
      expect(p.root.querySelectorAll("dialog[open]"),"one dialog, for the waiting computer").toHaveLength(1);
      expect(p.root.querySelector(".runtime-pending-banner").textContent).toContain("1 computer is waiting for approval");   // the joined computer is not counted: it never waited
      const joinedNotice=p.root.querySelector(".runtime-joined");expect(joinedNotice).toBeTruthy();expect(joinedNotice.closest("dialog")).toBeNull();
      expect(joinedNotice.textContent).toContain("Studio");
      // Only the computer that waits is ever offered for approval; the joined one has no Approve and no pending state.
      expect(p.root.querySelector(`[data-machine-id="${idC}"] .runtime-approval`)).toBeNull();
    });
    it("tells computers with the same name apart: #1 and #2 by when they asked, when and which, and how to rename",async()=>{
      machines=[{...machine(idA,"Demo-notebook"),createdAt:1_700_000_000_000,approvedAt:1_700_000_100_000},asked(idB,"demo-notebook ",1_700_000_900_000,"ABCD-1234-5678"),machine(idC,"Lab")];
      await mountPage("same-name");
      const card=(id:string)=>p.root.querySelector(`[data-machine-id="${id}"]`);
      expect(card(idA).querySelector(".runtime-same-name-tag").textContent).toBe("#1");
      expect(card(idB).querySelector(".runtime-same-name-tag").textContent).toBe("#2");
      expect(card(idA).querySelector(".runtime-same-name-when").textContent).toBe(`Paired ${machineTimeOf(1_700_000_100_000)} · ID ${idA.slice(0,8)}`);
      expect(card(idB).querySelector(".runtime-same-name-when").textContent).toBe(`Requested ${machineTimeOf(1_700_000_900_000)} · ID ${idB.slice(0,8)}`);
      expect(card(idA).querySelector(".runtime-same-name").textContent).toBe("Another computer is also named “Demo-notebook”. Use ⋯ → Rename to tell them apart.");
      expect(card(idC).querySelector(".runtime-same-name-tag")).toBeNull();expect(card(idC).querySelector(".runtime-same-name")).toBeNull();
      // The dialog says so too: this is how a computer pairing twice looks.
      expect(inAsk(".runtime-same-name").textContent).toBe(`A computer with this name is already paired (paired ${machineTimeOf(1_700_000_100_000)}). It may be the same computer pairing again: check the fingerprint.`);
    });
    it("a revoked computer does not make its namesake look duplicated",async()=>{
      machines=[machine(idA,"Laptop","revoked"),machine(idB,"Laptop")];
      await mountPage("same-name-revoked");
      expect(p.root.querySelector(".runtime-same-name-tag")).toBeNull();
    });
    it("reads naturally in Traditional Chinese, with the product terms kept",async()=>{
      const i18n=await import("/assets/app-i18n.js");i18n.setLang("zh-TW",{store:false});
      try {
        machines=[{...machine(idA,"Notebook"),createdAt:1},asked(idB,"Notebook",2,"ABCD-1234-5678"),asked(idC,"Lab",3,"1111-2222-3333")];
        await mountPage("ask-zh");
        expect(inAsk(".dlg-title").textContent).toBe("有電腦要求配對");expect(count()).toBe("第 1 台，共 2 台");
        expect(["稍後","拒絕","核准"].every(text=>askButton(text))).toBe(true);
        expect(p.root.querySelector(".runtime-pending-banner").textContent).toContain("有 2 台電腦等待核准");
        expect(p.root.querySelector(".runtime-pending-review").textContent).toBe("檢視並核准");
        expect(p.root.querySelector(`[data-machine-id="${idA}"] .runtime-same-name`).textContent).toBe("另一台電腦也叫「Notebook」。可從 ⋯ 選單 →「重新命名」改成容易分辨的名稱。");
        expect(inAsk(".runtime-same-name").textContent).toContain("已有一台同名電腦");
      } finally {i18n.setLang("en",{store:false});}
    });
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
    it("keeps the account list's rules (credential profiles, which account a sign-in is) there too, and none in app.css",()=>{
      const own=[".runtime-profiles",".runtime-profile-list",".runtime-account",".runtime-profile-default",".runtime-profiles-old"];
      for(const selector of own){expect(selectors,selector).toContain(selector);expect(read("src/ui/shared/app.css"),`${selector} must not be in app.css: a tab with an older app.css never gets it`).not.toMatch(new RegExp(`(^|[\\s,}])${selector.replace(".","\\.")}(?![a-z-])`,"m"));}
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
    it("shows the one-time install command with the confirmed address, the manual options, no ZIP step and no account option",async()=>{
      await open("runtime-windows-commands");
      expect(stepTitles()).toEqual(["AgEnD address","Copy the one-time install command","Paste it on the other computer"]);
      // the one-time command first (the same text the page builder makes), then the manual options (install only, connect) in the collapsed block
      expect(commands()).toEqual([enrollCommand("http://localhost",SCRIPT_SHA,TOKEN,FINGERPRINT),installOnlyCommand("http://localhost",SCRIPT_SHA),'agend-runtime connect --server "http://localhost"']);
      expect(commands()[0]).toContain(`$agendEnroll = '${TOKEN}'; $agendFingerprint = '${FINGERPRINT}'; try { `);expect(commands()[0]).toContain(installCommand("http://localhost",SCRIPT_SHA));
      expect(commands()[0]).toContain(" finally { $agendEnroll = $null; $agendFingerprint = $null }; if ($LASTEXITCODE) { Write-Error ");expect(commands()[1]).toBe(`$agendNoConnect = 1; ${installCommand("http://localhost",SCRIPT_SHA)}; $agendNoConnect = $null`);
      expect(commands()[1]).not.toContain(TOKEN);expect(commands()[2]).not.toContain(TOKEN);
      const manual=p.root.querySelector(".runtime-install-panel details.runtime-manual-command");
      expect(manual.querySelector("summary").textContent).toBe("Manual options (pairing code, install only)");expect(manual.hasAttribute("open")).toBe(false);
      expect(manual.querySelectorAll(".runtime-command-card")).toHaveLength(2);expect(manual.textContent).toContain("Install only (does not connect)");
      expect(manual.textContent).toContain("cannot be put in a command or a variable");expect(manual.textContent).toContain("use the one-time install command above instead");
      // The main step says what it does: installs and connects at once, with no pairing code and no approval, on any computer.
      const installHint=p.root.querySelectorAll(".runtime-pairing .runtime-step")[1].querySelector(".note").textContent;
      expect(installHint).toContain("connects the computer straight away: no pairing code and no approval step");expect(installHint).toContain("any Windows computer, or hand it to an AI agent");
      expect(installHint).not.toMatch(/does not connect|not connect, pair|won't connect/i);
      expect(p.root.querySelector(".runtime-install-panel").textContent).toContain("connect-agend.bat");
      // The hash the command checks is on the page, and it came from the administrator-only endpoint, not from the script's own response; the server fingerprint is shown too.
      expect(p.root.querySelector(".runtime-installer-hash code").textContent).toBe(SCRIPT_SHA);expect(p.root.querySelectorAll(".runtime-installer-hash code")[1].textContent).toBe(FINGERPRINT);
      expect(requests.filter(item=>item.path==="/ui/runtimes/installer")).toHaveLength(1);expect(requests.filter(item=>item.path==="/ui/runtimes/enrollment")).toHaveLength(1);
      expect(requests.some(item=>item.path.includes("install.ps1"))).toBe(false);
      expect(p.root.querySelector(".runtime-bundle-download")).toBeNull();expect(p.root.textContent).not.toContain("Double-click connect-agend.bat there");
      // No pairing code is made for this route: the code is made only when the person asks for it (or opens the ZIP route).
      expect(requests.some(item=>item.path==="/ui/runtimes/pairing")).toBe(false);expect(p.root.querySelector(".runtime-pair-code")).toBeNull();expect(p.root.querySelector(".runtime-enroll-card")).not.toBeNull();
      expect(p.root.textContent).not.toMatch(/another Claude account|claude-config-dir|--profile/i);expect(p.root.querySelectorAll('.runtime-pairing input[type=checkbox]')).toHaveLength(0);
      expect(p.root.textContent).toContain("22.14");
    });
    it.each([
      ["en",["Copy the one-time install command","Paste it on the other computer"],"connects the computer straight away: no pairing code and no approval step","It can be any computer that can reach this AgEnD's address","Manual options (pairing code, install only)","Install only (does not connect)","Treat this command like a password"],
      ["zh-TW",["複製一次性安裝指令","在另一台電腦貼上並執行"],"然後立刻連線那台電腦：不用配對碼，也不用另外核准","不限這台電腦，只要能連到這台 AgEnD 的位址都可以","手動選項（配對碼、只安裝）","只安裝（不連線）","請把這行指令當成密碼"],
    ] as const)("describes the one-time command in %s: copy it, paste it anywhere, nothing to type or approve; the old 'type the pairing code' wording is gone",async(lang,titles,hint,anywhere,manual,installOnly,password)=>{
      const i18n=await import("/assets/app-i18n.js");i18n.setLang(lang,{store:false});
      try{
        await p.mount(h(Panel,{navKey:`runtime-windows-copy-${lang}`}));await settle(8);button(lang==="en" ? "Connect a computer" : "連接電腦").click();await settle(8);
        expect(stepTitles().slice(1,3)).toEqual(titles);
        const text=p.root.querySelector(".runtime-install-panel").textContent;
        expect(text).toContain(hint);expect(text).toContain(anywhere);expect(text).toContain(manual);expect(text).toContain(installOnly);
        expect(text).toContain("connect-agend.bat");   // the reconnect hint: double-click it next time
        expect(p.root.querySelector(".runtime-enroll-card").textContent).toContain(password);
        expect(p.root.textContent).not.toMatch(/Enter the pairing code when the window asks|視窗提示時輸入配對碼|When the PowerShell window asks|PowerShell 視窗要求一次性配對碼|not connect, pair|不會連線、不會配對/);   // (the manual "Install only (does not connect)" label is deliberate)
        // the connection guide above the steps says the same thing: one pasted command, no code, no approval
        expect(p.root.querySelector("details.runtime-connect-guide").textContent).toContain(lang==="en" ? "it installs the Runtime and connects, with no pairing code and no approval" : "它會安裝 Runtime 並直接連線，不用配對碼，也不用核准");
      }finally{i18n.setLang("en",{store:false});}
    });
    it("rewrites the commands when the address changes, and shows none for an unsafe one",async()=>{
      await open("runtime-windows-address");
      await setServer("https://fleet.example.test:10443");
      expect(commands()).toEqual([enrollCommand("https://fleet.example.test:10443",SCRIPT_SHA,TOKEN,FINGERPRINT),installOnlyCommand("https://fleet.example.test:10443",SCRIPT_SHA),'agend-runtime connect --server "https://fleet.example.test:10443"']);
      expect(commands()[0]).toContain("$agend = 'https://fleet.example.test:10443'");expect(commands()[0]).toContain(`$h -eq '${SCRIPT_SHA}'`);
      for(const bad of ["http://192.168.1.20:19280","https://user:password@fleet.example.test","https://fleet.example.test/path","https://fleet.example.test/?x=1","https://fleet.example.test'; calc; '"]){
        await setServer(bad);expect(commands(),bad).toEqual([]);expect(p.root.querySelector('.runtime-pairing [role="alert"]').textContent).toContain("Enter an HTTPS origin");
      }
    });
    it("offers no install command, and says why, when the server cannot supply the installer hash; retrying brings it back",async()=>{
      installerMode="fail";await open("runtime-windows-no-installer");
      expect(commands()).toEqual(['agend-runtime connect --server "http://localhost"']);   // only the connect command; there is no unpinned install command, with or without a token
      expect(p.root.querySelector(".runtime-installer-error").textContent).toContain("cannot offer the installer");expect(p.root.querySelector(".runtime-installer-hash")).toBeNull();
      expect(p.root.querySelector(".runtime-install-panel").textContent).not.toMatch(/\birm\b/);
      installerMode="ok";button("Try again").click();await settle(8);
      expect(commands()).toHaveLength(3);expect(commands()[0]).toBe(enrollCommand("http://localhost",SCRIPT_SHA,TOKEN,FINGERPRINT));expect(commands()[1]).toBe(installOnlyCommand("http://localhost",SCRIPT_SHA));expect(p.root.querySelector(".runtime-installer-error")).toBeNull();
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
        copy(0).click();await settle(6);copy(1).click();await settle(6);copy(2).click();await settle(6);
        expect(written).toEqual(commands());expect(copy(2).textContent).toContain("Copied");
      }finally{Object.defineProperty(globalThis.navigator,"clipboard",{value:undefined,configurable:true});}
    });
    it("waits for a computer: the card says so, the flow moves on once the one-time command is copied, and it is done when a computer joins with it",async()=>{
      Object.defineProperty(globalThis.navigator,"clipboard",{value:{writeText:async()=>{}},configurable:true});
      try{
        machines=[machine(idA,"Desktop")];await open("runtime-windows-waiting");
        expect(p.root.querySelector('.runtime-step[aria-current="step"] h4').textContent).toBe("Copy the one-time install command");
        expect(p.root.querySelector(".runtime-enroll-card .runtime-pair-status").textContent).toContain("Waiting for a computer to run the command");
        p.root.querySelectorAll(".runtime-command-row .btn")[0].click();await settle(6);
        expect(p.root.querySelector('.runtime-step[aria-current="step"] h4').textContent).toBe("Paste it on the other computer");
        // a computer joins with the token: the catalog says the token is used and which computer used it
        const joined={...machine(idB,"Laptop"),enrolledVia:"install-command",approvedAt:Date.now()};machines=[machines[0],joined];
        enrollments=enrollments.map(row=>({...row,status:"used",usedAt:Date.now(),machineId:idB}));
        button("Refresh machines").click();await settle(10);
        expect(p.root.querySelector(".runtime-enroll-card .runtime-pair-status").textContent).toContain("A computer joined with this command; the token is spent.");
        expect(p.root.textContent).toContain("Laptop joined with this command.");expect(commands().some((text:string)=>text.includes(TOKEN))).toBe(false);   // a spent token is not offered again
        expect(p.root.querySelectorAll(".runtime-pairing .runtime-step.is-done")).toHaveLength(3);
      }finally{Object.defineProperty(globalThis.navigator,"clipboard",{value:undefined,configurable:true});}
      expect(requests.filter(item=>item.path==="/ui/runtimes").length).toBeGreaterThan(0);
    });
    it("shows a computer waiting for approval (the pairing-code route) on the card, whichever tab is open",async()=>{
      await open("runtime-windows-approval");
      expect(p.root.querySelector(".runtime-enroll-card .runtime-pair-status").textContent).toContain("A computer is waiting for your approval");
      expect(p.root.querySelector(".runtime-pairing-fingerprint").textContent).toBe("ABCD-1234-5678");   // the pending computer's card keeps its fingerprint and Approve button
      await zipTab();expect(p.root.querySelector('.runtime-step[aria-current="step"] h4').textContent).toBe("Return here to approve");
      expect(p.root.querySelector(".runtime-pair-card .runtime-pair-status").textContent).toContain("A computer is waiting for your approval");
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
    it("shows a countdown, makes a new command on request (ending the old one), and offers the command only while the token is unused",async()=>{
      machines=[machine(idA,"Desktop")];await open("runtime-enroll-lifecycle");
      expect(p.root.querySelector(".runtime-enroll-clock").textContent).toMatch(/^Expires in 1[45]:\d\d$/);
      button("New command").click();await settle(8);
      expect(requests.filter(item=>item.path==="/ui/runtimes/enrollment")).toHaveLength(2);expect(enrollments.map(row=>row.status)).toEqual(["unused","revoked"]);   // the server ended the first one
      expect(commands()[0]).toBe(enrollCommand("http://localhost",SCRIPT_SHA,TOKEN,FINGERPRINT));
      // the server reports the token ended (expired, or revoked elsewhere): the command is no longer shown and the card says why
      enrollments=enrollments.map((row,index)=>index===0?{...row,status:"expired"}:row);button("Refresh machines").click();await settle(10);
      expect(commands().some((text:string)=>text.includes(TOKEN))).toBe(false);expect(p.root.querySelector(".runtime-enroll-ended").textContent).toContain("This install command has expired. Generate a new one.");
      expect(p.root.querySelector(".runtime-enroll-card .runtime-pair-status").textContent).toContain("expired");expect(p.root.querySelector(".runtime-enroll-clock")).toBeNull();
      enrollments=enrollments.map((row,index)=>index===0?{...row,status:"revoked"}:row);button("Refresh machines").click();await settle(10);
      expect(p.root.querySelector(".runtime-enroll-ended").textContent).toContain("was revoked");
      button("New command").click();await settle(8);expect(commands()[0]).toContain(TOKEN);expect(p.root.querySelector(".runtime-enroll-ended")).toBeNull();
    });
    it("revokes an unused token when the panel is closed, so a command nobody can see does not stay valid",async()=>{
      await open("runtime-enroll-close");
      button("Revoke and close").click();await settle(10);
      const issued=enrollments[0];expect(requests).toContainEqual({path:`/ui/runtimes/enrollment/${issued.id}/revoke`,body:{}});expect(issued.status).toBe("revoked");
      expect(p.root.querySelector(".runtime-pairing")).toBeNull();expect(p.root.textContent).not.toContain(TOKEN);
      // a spent token has nothing to revoke: closing just closes
      await open("runtime-enroll-close-spent");requests.length=0;
      enrollments=enrollments.map(row=>({...row,status:"used",machineId:idB}));button("Refresh machines").click();await settle(10);
      button("Hide pairing code").click();await settle(10);
      expect(requests.some(item=>/\/revoke$/.test(item.path))).toBe(false);expect(p.root.querySelector(".runtime-pairing")).toBeNull();
    });
    it("keeps the token in memory only: it reaches no storage, and a reloaded page cannot show it again",async()=>{
      await open("runtime-enroll-memory");
      expect(commands()[0]).toContain(TOKEN);
      expect(JSON.stringify([...(p as any).storage.entries()])).not.toContain(TOKEN);expect(JSON.stringify((globalThis as any).sessionStorage ?? {})).not.toContain(TOKEN);expect(String((globalThis as any).document?.cookie ?? "")).not.toContain(TOKEN);
      await p.unmount();catalog.forgetRuntimeCatalog();await p.mount(h(Panel,{navKey:"runtime-enroll-memory-reload"}));await settle(10);
      expect(p.root.textContent).not.toContain(TOKEN);expect(p.root.querySelector(".runtime-pairing")).toBeNull();
    });
    it("makes a pairing code only when asked (Manual options) or when the ZIP route is opened, never for the one-time command",async()=>{
      await open("runtime-enroll-manual-code");
      expect(requests.some(item=>item.path==="/ui/runtimes/pairing")).toBe(false);
      button("Show a pairing code").click();await settle(8);
      expect(requests.filter(item=>item.path==="/ui/runtimes/pairing")).toHaveLength(1);expect(p.root.querySelector(".runtime-manual-command .runtime-pair-code").value).toBe("PAIR-TEST-CODE");
      expect(commands().join(" ")).not.toContain("PAIR-TEST-CODE");
      await zipTab();expect(requests.filter(item=>item.path==="/ui/runtimes/pairing")).toHaveLength(1);   // already there: not made twice
    });
    it("makes the token visible: the header button on the ZIP tab goes to the Windows tab, and the ZIP route makes no token of its own",async()=>{
      machines=[machine(idA,"Desktop")];await p.mount(h(Panel,{navKey:"runtime-enroll-header"}));await settle(8);
      button("Download Windows Runtime (ZIP)").click();await settle(10);
      expect(tabs()[1].getAttribute("aria-selected")).toBe("true");expect(requests.some(item=>item.path==="/ui/runtimes/enrollment")).toBe(false);   // the ZIP route needs no token
      expect(p.root.querySelector(".runtime-pair-code").value).toBe("PAIR-TEST-CODE");
      // switching to Windows shows how to get a command, instead of an empty step; the header button then makes one and shows it
      tabs()[0].click();await settle(6);expect(commands().some((text:string)=>text.includes(TOKEN))).toBe(false);expect(p.root.querySelector(".runtime-enroll-generate").textContent).toBe("Generate the install command");
      tabs()[1].click();await settle(6);button("Connect a computer").click();await settle(10);
      expect(tabs()[0].getAttribute("aria-selected")).toBe("true");expect(requests.filter(item=>item.path==="/ui/runtimes/enrollment")).toHaveLength(1);expect(commands()[0]).toContain(TOKEN);
    });
    it("makes a token from the generate button when there is none yet",async()=>{
      machines=[machine(idA,"Desktop")];await p.mount(h(Panel,{navKey:"runtime-enroll-generate"}));await settle(8);
      button("Download Windows Runtime (ZIP)").click();await settle(10);tabs()[0].click();await settle(6);
      p.root.querySelector(".runtime-enroll-generate").click();await settle(10);
      expect(commands()[0]).toContain(TOKEN);expect(p.root.querySelector(".runtime-enroll-generate")).toBeNull();expect(requests.filter(item=>item.path==="/ui/runtimes/enrollment")).toHaveLength(1);
    });
    it("does not make a new pairing code on its own when the shown one expires; the card offers one on request",async()=>{
      pairingTtl=120;machines=[machine(idA,"Desktop")];await p.mount(h(Panel,{navKey:"runtime-zip-expiry"}));await settle(8);
      button("Download Windows Runtime (ZIP)").click();await settle(10);expect(p.root.querySelector(".runtime-pair-code").value).toBe("PAIR-TEST-CODE");
      await new Promise(done=>setTimeout(done,400));await settle(10);
      expect(p.root.querySelector(".runtime-pair-code")).toBeNull();expect(requests.filter(item=>item.path==="/ui/runtimes/pairing")).toHaveLength(1);   // not re-made behind the administrator's back
      pairingTtl=60000;button("New code").click();await settle(10);expect(p.root.querySelector(".runtime-pair-code").value).toBe("PAIR-TEST-CODE");expect(requests.filter(item=>item.path==="/ui/runtimes/pairing")).toHaveLength(2);
    });
    it("measures a token's life from when the answer arrived, not by comparing the server's clock with the browser's (a skewed clock does not hide a valid command)",async()=>{
      enrollSkew=3_600_000;machines=[machine(idA,"Desktop")];await open("runtime-enroll-skew");      // the server's clock is an hour ahead of this browser's
      expect(commands()[0]).toContain(TOKEN);expect(p.root.querySelector(".runtime-enroll-clock").textContent).toMatch(/^Expires in 1[45]:\d\d$/);expect(p.root.querySelector(".runtime-enroll-ended")).toBeNull();
      await p.unmount();enrollSkew=-3_600_000;catalog.forgetRuntimeCatalog();await open("runtime-enroll-skew-behind");   // and an hour behind
      expect(commands()[0]).toContain(TOKEN);expect(p.root.querySelector(".runtime-enroll-clock").textContent).toMatch(/^Expires in 1[45]:\d\d$/);
    });
    it("keeps the ZIP flow as it was inside its tab: download, connect-agend.bat and the manual command",async()=>{
      await open("runtime-zip-unchanged");await zipTab();
      expect(stepTitles()).toEqual(["AgEnD address","Download the Runtime","Double-click connect-agend.bat there","Return here to approve"]);
      expect(p.root.querySelector(".runtime-command").value).toBe('.\\agend-runtime.cmd connect --server "http://localhost"');
      expect(p.root.querySelector(".runtime-bundle-download").textContent).toContain("Download Windows Runtime");
    });
  });
  describe("a computer that joined with an install command",()=>{
    const joined=(id=idB,name="Laptop")=>({...machine(id,name),enrolledVia:"install-command",enrollmentId:ENROLL_ID,approvedAt:Date.now()-60_000});
    const notice=()=>p.root.querySelector(".runtime-joined");
    beforeEach(()=>{(globalThis as any).localStorage.removeItem("agend.runtime.joined.dismissed");});
    it.each([
      ["en","A new computer joined with an install command","no pairing code and no approval step","Revoke","Dismiss","Joined by install command"],
      ["zh-TW","有新電腦透過安裝指令加入","沒有配對碼，也沒有核准步驟","撤銷","關閉通知","以安裝指令加入"],
    ] as const)("announces it on the page with a way to revoke it (%s), without opening the connect panel",async(lang,title,body,revoke,dismiss,badge)=>{
      const i18n=await import("/assets/app-i18n.js");i18n.setLang(lang,{store:false});
      try{
        machines=[machine(idA,"Desktop"),joined()];await p.mount(h(Panel,{navKey:`joined-${lang}`}));await settle(12);
        expect(p.root.querySelector(".runtime-pairing")).toBeNull();
        expect(notice().getAttribute("role")).toBe("status");expect(notice().textContent).toContain(title);expect(notice().textContent).toContain("Laptop");expect(notice().textContent).toContain(body);
        expect(notice().querySelectorAll("button").map((item:any)=>item.textContent.trim())).toEqual([revoke,dismiss]);
        expect(p.root.querySelector(`[data-machine-id="${idB}"] .runtime-kind`).textContent).toBe(badge);expect(p.root.querySelector(`[data-machine-id="${idA}"] .runtime-kind`).textContent).not.toBe(badge);
      }finally{i18n.setLang("en",{store:false});}
    });
    it("does not announce a computer that was paired the usual way",async()=>{
      await p.mount(h(Panel,{navKey:"joined-none"}));await settle(12);expect(notice()).toBeNull();
      machines=[machine(idA,"Desktop"),{...joined(),enrolledVia:undefined}];catalog.forgetRuntimeCatalog();await p.unmount();await p.mount(h(Panel,{navKey:"joined-none-2"}));await settle(12);expect(notice()).toBeNull();
    });
    it("revokes the computer from the notice, with the same confirmation and request as the card's own menu",async()=>{
      (globalThis as any).confirm=()=>true;machines=[machine(idA,"Desktop"),joined()];await p.mount(h(Panel,{navKey:"joined-revoke"}));await settle(12);
      notice().querySelectorAll("button")[0].click();await settle(12);
      expect(requests).toContainEqual({path:`/ui/runtimes/machines/${idB}/revoke`,body:{}});expect(notice()).toBeNull();
      expect(p.root.querySelector(`[data-machine-id="${idB}"]`).className).toContain("is-revoked");
    });
    it("is dismissed for good in this browser, and a revoked or old one is not announced",async()=>{
      machines=[machine(idA,"Desktop"),joined()];await p.mount(h(Panel,{navKey:"joined-dismiss"}));await settle(12);
      notice().querySelectorAll("button")[1].click();await settle(8);expect(notice()).toBeNull();
      expect(JSON.parse((globalThis as any).localStorage.getItem("agend.runtime.joined.dismissed"))).toEqual([idB]);
      expect(requests.some(item=>/\/revoke$/.test(item.path))).toBe(false);                   // dismissing only hides the notice; the computer stays connected
      await p.unmount();catalog.forgetRuntimeCatalog();await p.mount(h(Panel,{navKey:"joined-dismiss-again"}));await settle(12);expect(notice()).toBeNull();
      await p.unmount();catalog.forgetRuntimeCatalog();(globalThis as any).localStorage.removeItem("agend.runtime.joined.dismissed");
      machines=[machine(idA,"Desktop"),{...joined(),status:"revoked"},{...joined("32345678-1234-4321-abcd-123456789012","Old"),approvedAt:Date.now()-8*24*3_600_000}];
      await p.mount(h(Panel,{navKey:"joined-old"}));await settle(12);expect(notice()).toBeNull();
    });
    it("ignores a damaged dismissal record",async()=>{
      (globalThis as any).localStorage.setItem("agend.runtime.joined.dismissed","{not json");machines=[machine(idA,"Desktop"),joined()];
      await p.mount(h(Panel,{navKey:"joined-damaged"}));await settle(12);expect(notice()).not.toBeNull();
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
    expect(p.root.querySelector(`[data-machine-id="${idA}"] header p`).textContent).toBe("Windows · DESKTOP-7Q2 · 1 CLI");
    expect(p.root.querySelector(`[data-machine-id="${idB}"] header p`).textContent).toBe("Windows · 1 CLI");
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
    expect(requests.some(item=>item.path===`/ui/models?backend=codex&runtime=windows&machineId=${idA}&profile=`)).toBe(true);
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
    expect(p.root.textContent).not.toContain("Laptop");expect(p.root.querySelector(".runtime-computers-heading .note").textContent).toBe("1 computer");
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
    // the install-only command is the same pinned command with the switch around it, and nothing else
    expect(installOnlyCommand("https://runtime.example.com:443",SCRIPT_SHA)).toBe(`$agendNoConnect = 1; ${installCommand("https://runtime.example.com:443",SCRIPT_SHA)}; $agendNoConnect = $null`);
    for(const bad of ["http://192.168.1.2:19280","https://user:password@example.com","https://example.com/?x=$(calc)","https://$(calc)","https://example.com/path","https://example.com;calc","https://exa'mple.com","https://example.com/'; calc; '","",undefined as any]){
      expect(installCommand(bad,SCRIPT_SHA),String(bad)).toBe("");expect(installOnlyCommand(bad,SCRIPT_SHA),String(bad)).toBe("");expect(windowsConnectCommand(bad),String(bad)).toBe("");
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
    for(const bad of ["",undefined,null,"A".repeat(64),"abc","g".repeat(64),`${SCRIPT_SHA}'; calc; '`]){expect(installCommand("https://runtime.example.com",bad as any),String(bad)).toBe("");expect(installOnlyCommand("https://runtime.example.com",bad as any),String(bad)).toBe("");}
  });
  it("builds the one-time install command around the same pinned command, with the token and server fingerprint as inert, single-quoted values cleared in a finally",()=>{
    const origin="https://runtime.example.com", text=enrollCommand(origin,SCRIPT_SHA,TOKEN,FINGERPRINT), base=installCommand(origin,SCRIPT_SHA);
    expect(text).toMatch(new RegExp(`^\\$global:LASTEXITCODE = 0; \\$agendEnroll = '${TOKEN}'; \\$agendFingerprint = '${FINGERPRINT}'; try \\{ `));
    expect(text).toContain(` try { ${base} } finally { $agendEnroll = $null; $agendFingerprint = $null }; if ($LASTEXITCODE) { Write-Error '`);   // the status of the last step reaches the shell's exit code
    expect(text).toMatch(/-ErrorAction SilentlyContinue \}$/);
    expect(text.match(/\biex\b/g)).toHaveLength(1);expect(text).not.toMatch(/\n|SkipCertificateCheck|Set-ExecutionPolicy|-ExecutionPolicy|setx|\|\s*iex/i);
    expect(text).not.toContain("agendNoConnect");expect(text).not.toMatch(/--[a-z]/);   // no flag and no argument: the token is read from two variables, handed over on stdin
    expect(text.split(TOKEN)).toHaveLength(2);                                            // the token appears exactly once, in its own assignment
    // without the pinned script hash, an address that is not an origin, or a token or fingerprint of the wrong shape, there is no command at all
    for(const [o,h,t,f] of [["https://example.com/path",SCRIPT_SHA,TOKEN,FINGERPRINT],[origin,"",TOKEN,FINGERPRINT],[origin,SCRIPT_SHA,"",FINGERPRINT],[origin,SCRIPT_SHA,TOKEN+"x",FINGERPRINT],[origin,SCRIPT_SHA,TOKEN.toUpperCase(),FINGERPRINT],[origin,SCRIPT_SHA,`${TOKEN.slice(0,-1)}'`,FINGERPRINT],
      [origin,SCRIPT_SHA,TOKEN,"nope"],[origin,SCRIPT_SHA,TOKEN,FINGERPRINT.toUpperCase()],[origin,SCRIPT_SHA,TOKEN,`${FINGERPRINT.slice(0,-1)}'`],[origin,SCRIPT_SHA,undefined,FINGERPRINT],[origin,SCRIPT_SHA,TOKEN,undefined]] as const)
      expect(enrollCommand(o,h as any,t as any,f as any),`${o} ${h} ${t} ${f}`).toBe("");
    // the commands that carry no token carry none of it
    for(const other of [base,installOnlyCommand(origin,SCRIPT_SHA),windowsConnectCommand(origin),connectCommand(origin)])expect(other).not.toMatch(/agendEnroll|agend_enroll|agendFingerprint/);
  });
  it("coalesces reads and keeps the last good snapshot after a network failure, clearing it on lost authorization",async()=>{
    let resolve!:(value:any)=>void;let count=0;let mode="pending";
    const pending=new Promise<any>(done=>{resolve=done;});
    const store=catalog.createRuntimeCatalog({fetcher:async()=>{count++;return mode==="pending"?pending:mode==="fail"?response({error:"unavailable"},503):response({error:"unauthorized"},403);}});
    const a=store.load(),b=store.load();resolve(response({enabled:true,machines}));await Promise.all([a,b]);expect(count).toBe(1);expect(store.get().data.machines).toHaveLength(2);
    mode="fail";await store.load({force:true});expect(store.get().data.machines).toHaveLength(2);expect(store.get().error).toBe("unavailable");
    mode="auth";await store.load({force:true});expect(store.get().data).toBeNull();store.clear();
  });

  it("Ridge #3321 S11 (#3328 F1a): Rename — the footer's Save submits the rename form (POST {name}) and closes; the footer's Cancel closes with no request", async()=>{
    await p.mount(h(Panel,{navKey:"rename-s11"}));await settle(14);
    const open=async()=>{p.root.querySelector(`[data-machine-id="${idA}"] .runtime-machine-menu button`).click();await settle();button("Rename").click();await settle(6);};
    const footer=()=>p.root.querySelector("dialog .dlg-actions");
    await open();
    const input=p.root.querySelector("dialog .runtime-rename input");input.value="Studio PC";fire(input,"input");await settle(4);
    const save=[...footer().querySelectorAll("button")].find((b:any)=>b.textContent.trim()==="Save name") as any;
    // What a browser does with <button type="submit" form="…"> outside its form: submit the form that attribute names.
    const named=save.getAttribute("form"), form=named ? p.document.getElementById(named) : null;
    expect(form?.matches("form.runtime-rename"),"Save names the rename form").toBe(true);
    requests.length=0;fire(form!,"submit");await settle(12);
    expect([requests.filter(r=>r.path.endsWith("/rename")),!!p.root.querySelector("dialog .runtime-rename")]).toEqual([[{path:`/ui/runtimes/machines/${idA}/rename`,body:{name:"Studio PC"}}],false]);
    await open();requests.length=0;
    fire([...footer().querySelectorAll("button")].find((b:any)=>b.textContent.trim()==="Cancel"),"click");await settle(6);
    expect([requests.filter(r=>r.path.endsWith("/rename")),!!p.root.querySelector("dialog .runtime-rename")]).toEqual([[],false]);
  });
});

describe("the page says the Runtime keeps running in the background (en and zh-TW)",()=>{
  const source=readFileSync("src/ui/panel-runtimes.js","utf8");
  const text=(name:string):string[]=>[...source.matchAll(new RegExp(`${name}:"((?:[^"\\\\]|\\\\.)*)"`,"g"))].map(match=>match[1]);
  it("the install and connect steps, and the ZIP's launch step, tell that closing the window does not disconnect it and name status, stop and logs",()=>{
    for(const name of ["stepConnectHint","stepLaunchHint"]){
      const [en,zh]=text(name);
      expect(en,name).toMatch(/background/);expect(en,name).toMatch(/agend-runtime status, stop and logs/);expect(en,name).toMatch(/sign in to Windows|you sign in/);
      expect(zh,name).toMatch(/背景/);expect(zh,name).toMatch(/agend-runtime status、stop、logs/);expect(zh,name).toMatch(/登入/);
    }
    const [installEn,installZh]=text("stepInstallHint");
    expect(installEn).toMatch(/keeps running in the background \(closing the window does not disconnect it/);expect(installZh).toMatch(/背景持續執行（關掉視窗不會斷線/);
    const [approveEn,approveZh]=text("stepApproveHint");
    expect(approveEn).toMatch(/running in the background/);expect(approveZh).toMatch(/背景執行/);
  });
  it("no copy still tells a person to keep the Runtime window open for the Runtime to stay connected",()=>{
    expect(source).not.toMatch(/Keep the Runtime window open/);expect(source).not.toMatch(/請保持 Runtime 視窗開啟/);expect(source).not.toMatch(/connects and keeps running; there is nothing to type/);
  });
});
