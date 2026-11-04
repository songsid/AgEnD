import {afterAll,afterEach,beforeAll,beforeEach,describe,it,expect,vi} from "vitest";
import {page,settle,h,type AppPage} from "./helpers/app-harness.js";
import {fire} from "./helpers/mini-dom.js";
const a="12345678-1234-4321-abcd-123456789012",b="22345678-1234-4321-abcd-123456789012",originalFetch=globalThis.fetch;
let p:AppPage,Dialog:any,app:any,catalog:any,windows:any,models:any,posts:any[],reads:string[],complete:(()=>void)|null,error=false;
const source={revision:"a".repeat(64),runtime:"wsl",directory:"/wsl-private",backend:"claude-code",model:"old-model",adapter:"exec",sandbox:"read-only",general:false};
const inst={working_directory:source.directory,backend:source.backend};
const cli={id:"codex",path:"C:\\codex.exe",runnable:true,readOnlySupport:true,supports:{execution:true,resume:true,mcp:true}};
const response=(body:any,status=200)=>({ok:status<400,status,json:async()=>body});
const button=(label:string)=>p.root.querySelectorAll("dialog button").find((node:any)=>node.textContent.trim()===label);
beforeAll(async()=>{
 p=page({url:"http://localhost/settings/agents",storage:{agend_lang:"en"}});
 globalThis.fetch=(async(path:string,options:any={})=>{
  reads?.push(path);
  if(path==="/ui/instances/agent-1/runtime"){
   if(options.method==="POST"){posts.push(JSON.parse(options.body));return new Promise((yes,no)=>{complete=()=>error?no(Error("Connection lost")):yes(response({ok:true}));});}return response(source);
  }
  if(path==="/ui/runtimes")return response({enabled:true,machines:[{id:a,name:"Desktop",status:"online",inventory:{clis:[cli]}},{id:b,name:"Laptop",status:"online",inventory:{clis:[cli,{...cli,id:"grok",readOnlySupport:false}]}}]});
  if(path==="/ui/backends")return response({backends:[{name:"claude-code",installed:true,state:"usable"}]});
  if(path==="/ui/windows-cli/probe")return response({clis:[cli]});
  if(path.startsWith("/ui/models?"))return response({models:[{id:"model-b",label:"Laptop model"}],source:"cli-cache"});
  return response({});
 }) as any;
 const {setLang}=await import("/assets/app-i18n.js");setLang("en",{store:false});app=await import("/assets/app-store.js");catalog=await import("/ui/js/runtime-catalog.js");windows=await import("/ui/js/windows-cli-catalog.js");models=await import("/ui/js/settings-catalog.js");Dialog=(await import("/ui/js/agent-runtime-settings.js")).AgentRuntimeChangeDialog;
});
beforeEach(()=>{posts=[];reads=[];complete=null;error=false;app.appStore.set({windowsCli:true});catalog.forgetRuntimeCatalog();windows.forgetWindowsCliCatalog();models.forgetCatalogs();});
afterEach(async()=>{await p.unmount();catalog.forgetRuntimeCatalog();});afterAll(()=>{p.restore();globalThis.fetch=originalFetch;});
async function configure(){
 await p.mount(h(Dialog,{name:"agent-1",inst,onClose:vi.fn(),onChanged:vi.fn()}));await settle(8);
 const remote=p.root.querySelectorAll('.agent-runtime-picker input').find((node:any)=>node.value===`machine:${b}`);remote.checked=true;fire(remote,"change");await settle(6);
 expect(button("Next").disabled).toBe(false);button("Next").click();await settle(5);
 const directory=p.root.querySelector('.agent-runtime-change input:not([type="checkbox"])');expect(directory.value).toBe("");directory.value="D:\\Remote";fire(directory,"input");
 const model=p.root.querySelector('.model-pick select');expect(model.value).toBe("");model.value="model-b";fire(model,"change");
 const fresh=p.root.querySelector('.agent-runtime-change input[type="checkbox"]');fresh.checked=true;fire(fresh,"change");await settle(4);
}
describe("existing Agent runtime steps",()=>{
 it("explains a provider without read-only support and requires an explicit supported file-access choice",async()=>{
  await p.mount(h(Dialog,{name:"agent-1",inst,onClose:vi.fn(),onChanged:vi.fn()}));await settle(8);
  const remote=p.root.querySelectorAll('.agent-runtime-picker input').find((node:any)=>node.value===`machine:${b}`);remote.checked=true;fire(remote,"change");await settle(5);
  p.root.querySelector('.agent-runtime-change .cli-picker-trigger').click();await settle();p.root.querySelectorAll('[role="menuitemradio"]').find((node:any)=>node.querySelector('[data-cli="grok"]')).click();await settle(3);button("Next").click();await settle(4);
  const fresh=p.root.querySelector('.agent-runtime-change input[type="checkbox"]');fresh.checked=true;fire(fresh,"change");await settle(3);
  const {t}=await import("/assets/app-i18n.js");expect(p.root.textContent).toContain(t("runtime.noReadOnly"));expect(button("Save runtime change").disabled).toBe(true);
  const access=p.root.querySelectorAll('select').find((node:any)=>node.querySelectorAll('option').some((option:any)=>option.value==="workspace-write"));access.value="workspace-write";fire(access,"change");await settle(3);expect(button("Save runtime change").disabled).toBe(false);expect(posts).toHaveLength(0);
 });
 it("uses the existing Agent account for models when keeping the same Linux CLI",async()=>{
  await p.mount(h(Dialog,{name:"agent-1",inst,onClose:vi.fn(),onChanged:vi.fn()}));await settle(8);button("Next").click();await settle(6);
  const request=reads.find(path=>path.startsWith("/ui/models?"))!;expect(new URL(request,"http://localhost").searchParams.get("instance")).toBe("agent-1");expect(posts).toHaveLength(0);
 });
 it("selects a computer before configuration, clears the old path/model and claims the exact target before awaiting",async()=>{
  await configure();const save=button("Save runtime change");fire(save,"click");fire(save,"click");await settle(3);
  expect(posts).toHaveLength(1);expect(posts[0]).toMatchObject({runtime:"windows",machineId:b,backend:"codex",directory:"D:\\Remote",model:"model-b",startNewConversation:true,expectedRevision:source.revision});
  expect(posts[0].directory).not.toContain("wsl");expect(p.root.textContent).toContain("Preparing the new workspace");expect(button("Cancel").disabled).toBe(true);complete!();await settle(4);
 });
 it("holds a lost outcome until the user reads current state instead of resubmitting a move",async()=>{
  await configure();error=true;button("Save runtime change").click();await settle(3);complete!();await settle(4);
  expect(p.root.textContent).toContain("Read the Agent state again");const save=button("Save runtime change");expect(save.disabled).toBe(true);fire(save,"click");await settle(3);expect(posts).toHaveLength(1);
  button("Read state again").click();await settle(6);expect(button("Next")).toBeTruthy();expect(p.root.querySelector('.agent-runtime-change input[type="checkbox"]')).toBeNull();
 });
});
