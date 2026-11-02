import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";

let p:AppPage, NativeSettings:any, CreateDialog:any, catalog:any, modelCatalog:any, app:any;
const realFetch=globalThis.fetch;
const name="windows-12345678-1234-4321-abcd-123456789012";
let cli:any;
const requests:string[]=[];
const installed=(id="codex",mcp:boolean|undefined=true)=>({id,path:`C:\\CLI\\${id}.exe`,runnable:true,authenticated:true,readOnlySupport:true,supports:{execution:true,resume:true,...(mcp===undefined?{}:{mcp})},models:[]});
const note=()=>p.root.querySelector(".native-agend-tools");
const button=(text:string)=>p.root.querySelectorAll("button").find((item:any)=>item.textContent.trim()===text);

beforeAll(async()=>{
  p=page({url:"http://localhost/settings/agents",storage:{agend_lang:"en"}});
  globalThis.fetch=(async(path:string)=>{
    requests.push(path);
    const body=path==="/ui/windows-cli/probe"?{home:"C:\\Test",clis:[cli]}:path==="/ui/backends"?{backends:[{name:"claude-code",installed:true}],defaultBackend:"claude-code"}:path.startsWith("/ui/models?")?{models:[]}:{};
    return {ok:true,status:200,json:async()=>body};
  }) as any;
  const {setLang}=await import("/assets/app-i18n.js");setLang("en",{store:false});
  NativeSettings=(await import("/ui/js/native-instance-settings.js")).NativeInstanceSettings;
  CreateDialog=(await import("/ui/js/panel-fleet.js")).CreateInstanceDialog;
  catalog=await import("/ui/js/windows-cli-catalog.js");modelCatalog=await import("/ui/js/settings-catalog.js");app=await import("/assets/app-store.js");
});
beforeEach(()=>{cli=installed();requests.length=0;catalog.forgetWindowsCliCatalog();modelCatalog.forgetCatalogs();});
afterEach(async()=>{await p.unmount();catalog.forgetWindowsCliCatalog();});
afterAll(()=>{p.restore();globalThis.fetch=realFetch;});

async function settings(sandbox="read-only") {
  const stageAgent=vi.fn(),inst={runtime:"windows",backend:cli.id,display_name:"Native assistant",model:"",description:"",systemPrompt:"",tags:[],working_directory:"C:\\Work",native_sandbox:sandbox};
  await p.mount(h(NativeSettings,{name,inst,ctx:{shortName:()=>"Native assistant",stageAgent},onClose(){}}));await settle(8);
  return {inst,stageAgent};
}

describe("native AgEnD tool capability hints",()=>{
  it.each(["codex","claude-code"])("shows query scope only after the installed %s reports support",async id=>{
    cli=installed(id);await settings();
    expect(note()?.textContent).toContain("read-only mode can query agents, tasks and delivery status");
    expect(note()?.textContent).not.toContain("delegation");
  });

  it("updates existing settings with the selected access mode and stages only that existing setting",async()=>{
    const {inst,stageAgent}=await settings();
    const access=p.root.querySelector(".native-instance-settings label select");
    access.value="workspace-write";fire(access,"change");await settle();
    expect(note()?.textContent).toContain("messaging, delegation and task actions");
    expect(note()?.textContent).toContain("tool permissions");
    expect(stageAgent).not.toHaveBeenCalled();
    button("Done").click();await settle();
    expect(stageAgent).toHaveBeenCalledWith(name,inst,{native_sandbox:"workspace-write"});
    expect(requests).not.toContain("/ui/instances");
  });

  it("describes an unsupported CLI without promising AgEnD tool calls",async()=>{
    cli=installed("grok",false);await settings("workspace-write");
    expect(note()?.textContent).toBe("This CLI cannot call AgEnD tools yet. It can still receive Fleet tasks.");
    expect(note()?.textContent).not.toContain("messaging");
  });

  it("does not advertise support merely because an older inventory row names Codex",async()=>{
    cli=installed("codex");delete cli.supports.mcp;await settings();
    expect(note()).toBeNull();
  });

  it("uses the same access-mode hint in the configure step without creating an agent",async()=>{
    app.appStore.set({windowsCli:true});await p.mount(h(CreateDialog,{onClose(){}}));await settle(8);
    const windows=p.root.querySelectorAll(".agent-runtime-picker input").find((item:any)=>item.value==="windows");
    windows.checked=true;fire(windows,"change");await settle();
    expect(note()).toBeNull();button("Next").click();await settle(8);
    expect(note()?.textContent).toContain("read-only mode can query");
    const access=p.root.querySelector("#native-create-sandbox");
    access.value="workspace-write";fire(access,"change");await settle();
    expect(note()?.textContent).toContain("messaging, delegation and task actions");
    expect(requests).not.toContain("/ui/instances");
    expect(requests).not.toContain("/ui/windows-cli/tasks");
  });
});
