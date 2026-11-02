import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";

let p:AppPage, ModelSelect:any, CreateInstanceDialog:any, NativeInstanceSettings:any, catalogs:any, nativeCatalog:any, app:any;
const realFetch=globalThis.fetch;
const requests:string[]=[];
const listed={models:[{id:"claude-opus-5-5",label:"Claude Opus 5.5"},{id:"claude-sonnet-5-5",label:"Claude Sonnet 5.5"}],source:"official-catalog"};
const inventory={home:"C:\\Test",clis:[{id:"claude-code",path:"C:\\claude.exe",runnable:true,authenticated:true,readOnlySupport:true,supports:{execution:true,resume:true},models:[]}]};
const response=(body:any,ok=true)=>({ok,status:ok?200:503,json:async()=>body});
let modelFetch:(url:string)=>Promise<any>;
const nativeName="windows-12345678-1234-4321-abcd-123456789012";
const options=()=>p.root.querySelectorAll(".model-pick option").map((item:any)=>item.value);
const button=(text:string)=>p.root.querySelectorAll("button").find((item:any)=>item.textContent.trim()===text);

beforeAll(async()=>{
  p=page({url:"http://localhost/settings/agents",storage:{agend_lang:"en"}});
  globalThis.fetch=(async(url:string)=>{
    requests.push(url);
    if(url.startsWith("/ui/models?"))return modelFetch(url);
    return response(url==="/ui/windows-cli/probe"?inventory:url==="/ui/backends"?{backends:[{name:"claude-code",installed:true}],defaultBackend:"claude-code"}:{});
  }) as any;
  const {setLang}=await import("/assets/app-i18n.js");setLang("en",{store:false});
  ModelSelect=(await import("/ui/js/settings-dialogs.js")).ModelSelect;
  CreateInstanceDialog=(await import("/ui/js/panel-fleet.js")).CreateInstanceDialog;
  NativeInstanceSettings=(await import("/ui/js/native-instance-settings.js")).NativeInstanceSettings;
  catalogs=await import("/ui/js/settings-catalog.js");nativeCatalog=await import("/ui/js/windows-cli-catalog.js");app=await import("/assets/app-store.js");
});
beforeEach(()=>{requests.length=0;catalogs.forgetCatalogs();nativeCatalog.forgetWindowsCliCatalog();modelFetch=async()=>response(listed);});
afterEach(async()=>{await p.unmount();});
afterAll(()=>{p.restore();globalThis.fetch=realFetch;});

describe("runtime-specific model choices",()=>{
  it("new Windows agents request the CLI's model catalog even when inventory has no models",async()=>{
    app.appStore.set({windowsCli:true});await p.mount(h(CreateInstanceDialog,{onClose(){}}));await settle(8);
    const windows=p.root.querySelectorAll(".agent-runtime-picker input").find((item:any)=>item.value==="windows");windows.checked=true;fire(windows,"change");await settle();
    button("Next").click();await settle(8);
    expect(requests).toContain("/ui/models?backend=claude-code&runtime=windows");
    expect(options()).toContain("claude-opus-5-5");expect(options()).toContain("claude-sonnet-5-5");
    expect(p.root.querySelector(".model-pick select").value).toBe("");
    expect(p.root.querySelector(".model-catalog-status").textContent).toContain("account and provider");
    expect(requests.some(path=>path.includes("/messages")||path==="/ui/instances")).toBe(false);
  });
  it("existing native Agent settings use the same runtime catalog and stage a selected model",async()=>{
    const stageAgent=vi.fn(), inst={runtime:"windows",backend:"claude-code",display_name:"Assistant",working_directory:"C:\\Work",native_sandbox:"read-only",model:"",description:"",systemPrompt:"",tags:[]};
    await p.mount(h(NativeInstanceSettings,{name:nativeName,inst,ctx:{shortName:()=>"Assistant",stageAgent},onClose(){}}));await settle(8);
    expect(requests).toContain(`/ui/models?backend=claude-code&instance=${nativeName}&runtime=windows`);
    const select=p.root.querySelector("#native-instance-model");select.value="claude-opus-5-5";fire(select,"change");await settle();button("Done").click();await settle();
    expect(stageAgent).toHaveBeenCalledWith(nativeName,inst,{model:"claude-opus-5-5"});
  });
  it("shows loading without blocking default/custom selection, and ignores a late answer after switching CLI",async()=>{
    let resolve!:(value:any)=>void;const slow=new Promise<any>(done=>{resolve=done;});
    modelFetch=async url=>url.includes("backend=claude-code")?slow:response({models:[{id:"gpt-local",label:"GPT local"}],source:"cli-cache"});
    const props={value:"",onChange(){},inherit:"CLI default",id:"model"};
    await p.mount(h(ModelSelect,{...props,backend:"claude-code",runtime:"windows"}));await settle();
    expect(p.root.querySelector(".model-catalog-status [role=status]").textContent).toContain("Loading");
    expect(p.root.querySelector("#model").disabled).not.toBe(true);expect(options()).toContain("");expect(options()).toContain("\u0000other");
    await p.mount(h(ModelSelect,{...props,backend:"codex",runtime:"windows"}));await settle(8);
    resolve(response(listed));await settle(8);
    expect(options()).toContain("gpt-local");expect(options()).not.toContain("claude-opus-5-5");
  });
  it("separates Windows and WSL catalogs and clears the custom editor when runtime changes",async()=>{
    modelFetch=async url=>response({models:[{id:url.includes("runtime=windows")?"native-model":"wsl-model",label:"Runtime model"}]});
    const props={backend:"claude-code",value:"custom-current",onChange(){},inherit:"CLI default",id:"model"};
    await p.mount(h(ModelSelect,{...props,runtime:"windows"}));await settle(8);
    expect(options()).toContain("native-model");
    const select=p.root.querySelector("#model");select.value="\u0000other";fire(select,"change");await settle();expect(p.root.querySelector(".model-pick input")).not.toBeNull();
    await p.mount(h(ModelSelect,{...props,runtime:"wsl"}));await settle(8);
    expect(requests).toContain("/ui/models?backend=claude-code");expect(options()).toContain("wsl-model");expect(options()).not.toContain("native-model");
    expect(options()).toContain("custom-current");expect(p.root.querySelector(".model-pick input")).toBeNull();
  });
  it("reports failure and retries with refresh=1 without changing the selected model",async()=>{
    modelFetch=async()=>response({},false);
    const onChange=vi.fn();await p.mount(h(ModelSelect,{backend:"claude-code",runtime:"windows",value:"keep-model",onChange,inherit:"CLI default"}));await settle(8);
    expect(p.root.querySelector(".model-catalog-status [role=alert]").textContent).toContain("Could not load models");
    expect(options()).toContain("keep-model");modelFetch=async()=>response(listed);button("Retry").click();await settle(8);
    expect(requests).toContain("/ui/models?backend=claude-code&runtime=windows&refresh=1");expect(options()).toContain("claude-opus-5-5");
    expect(onChange).not.toHaveBeenCalled();expect(p.root.querySelector(".model-catalog-status [role=alert]")).toBeNull();
  });
});
