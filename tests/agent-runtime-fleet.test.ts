import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync,unlinkSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,resolve,sep} from "node:path";
import {afterEach,beforeEach,describe,it,expect,vi} from "vitest";
vi.mock("node:child_process",async original=>({...await original<typeof import("node:child_process")>(),spawn:()=>{throw Error("No processes in runtime migration tests");},execFile:()=>{throw Error("No CLI");},execFileSync:()=>{throw Error("No CLI");},execSync:()=>{throw Error("No CLI");},spawnSync:()=>{throw Error("No CLI");}}));
vi.mock("../src/logger.js",()=>({createLogger:()=>({info:vi.fn(),warn:vi.fn(),debug:vi.fn(),error:vi.fn(),child(){return this;}})}));
import {FleetManager} from "../src/fleet-manager.js";
import {TmuxManager} from "../src/tmux-manager.js";
import {WindowsAgents} from "../src/windows-agents.js";
import {registerWindowsProfiles} from "../src/native-instance-registry.js";
import type {WindowsCliExecutor} from "../src/windows-cli.js";
const a="12345678-1234-4321-abcd-123456789012",b="22345678-1234-4321-abcd-123456789012",oldId="32345678-1234-4321-abcd-123456789012";
const fixtures:Array<{home:string;fm:FleetManager}>=[];
beforeEach(()=>{vi.stubEnv("AGEND_WINDOWS_CLI","1");vi.stubEnv("AGEND_REMOTE_RUNTIME","1");vi.spyOn(TmuxManager,"sessionExistsStrict").mockResolvedValue(false);});
afterEach(()=>{for(const {home,fm} of fixtures.splice(0)){fm.stormWindow.shutdown();fm.spawnGate.shutdown();if(!resolve(home).startsWith(resolve(tmpdir())+sep))throw Error("Unsafe fixture cleanup");rmSync(home,{recursive:true,force:true});}vi.restoreAllMocks();vi.unstubAllEnvs();});
function fixture(windows=false){
 const home=mkdtempSync(join(tmpdir(),"agend-runtime-switch-")),instanceDir=join(home,"instances","agent-1");mkdirSync(instanceDir,{recursive:true});
 const old={id:oldId,name:"Helper",cli:"codex",cwd:"C:\\original",sandbox:"read-only",description:"Role",instructions:"Keep instructions",createdAt:1,threadId:a,fleet_instance:"agent-1",machineId:a,turns:[{id:b,prompt:"Before migration",output:"Retained reply",status:"completed",startedAt:1,finishedAt:2}]};
 if(windows)writeFileSync(join(home,"windows-agents.json"),JSON.stringify({version:1,agents:[old],requests:{}}));
 const fm=new FleetManager(home),any=fm as any;fixtures.push({home,fm});
 const before:any={working_directory:windows?old.cwd:home,backend:windows?"codex":"claude-code",display_name:"Helper",description:"Role",systemPrompt:"Keep instructions",tags:["test"],topic_id:7,channel_id:"chat",tool_set:"worker",dashboard:{tasks:false},...(windows?{runtime:"windows",native_agent_id:oldId,machine_id:a,native_sandbox:"read-only"}:{})};
 fm.fleetConfig={defaults:{backend:"claude-code"},instances:{"agent-1":before},teams:{review:{members:["agent-1"]}}} as any;
 const cli={id:"codex",path:"C:\\codex.exe",runnable:true,readOnlySupport:true,supports:{execution:true,resume:true,mcp:true}};
 const machines=new Map([[a,{id:a,bootId:a,status:"online",platform:"win32",paneProtocol:1,inventory:{clis:[cli]}}],[b,{id:b,bootId:b,status:"online",platform:"win32",paneProtocol:1,inventory:{clis:[cli]}}]]);
 const bridge={probe:vi.fn(async()=>({clis:[cli]})),prepareWorkspace:vi.fn(async(id:string,_allowed:()=>boolean,machineId?:string)=>`C:\\managed-${machineId||"local"}\\${id}`),hasActiveTask:()=>false,get:()=>null,start:()=>{throw Error("No provider execution");},cancel:()=>{throw Error("No cancellation");}} as unknown as WindowsCliExecutor;
 any.runtimeWindowsExecutor=()=>bridge;any.runtimeCoordinator=()=>({machine:(id:string)=>machines.get(id)});
 any.backendAvailabilityRows=()=>[{backend:"claude-code",state:"usable"},{backend:"codex",state:"usable"}];
 const save=vi.fn();any.saveFleetConfig=save;any.getUiStatus=()=>({instances:Object.keys(fm.fleetConfig!.instances)});
 any.emitSseEvent=vi.fn((event:string,value:any)=>{if(event==="message")fm.webChatHistory.record(value);});
 any.stopInstance=vi.fn(async(name:string)=>{fm.lifecycle.invalidate(name);fm.lifecycle.daemons.delete(name);const file=join(instanceDir,"window-id");if(existsSync(file))unlinkSync(file);return {backgroundWorkEnded:false};});
 fm.webChatHistory.record({instance:"agent-1",sender:"You",role:"user",text:"Shared AgEnD history",ts:new Date(0).toISOString()});
 const service=fm.agentRuntimeChanges();
 const body=(runtime="windows",machineId:string|undefined=b)=>({requestId:crypto.randomUUID(),expectedRevision:service.describe("agent-1").revision,runtime,...(runtime==="windows"&&machineId?{machineId}:{}),backend:"codex",sandbox:"read-only",startNewConversation:true});
 return {home,instanceDir,fm,any,before,bridge,machines,save,service,body};
}
describe("real Fleet runtime migration wiring with inert providers",()=>{
 it("keeps an existing Linux account on the same backend, and drops host-only credential settings when moving to another Runtime",async()=>{
  const r=fixture();r.before.backend_options={"claude-code":{credential_profile:"work-account"}};
  const account=vi.fn(()=>[{backend:"claude-code",state:"usable"}]);r.any.backendAvailabilityFor=account;
  await r.service.change("agent-1",{...r.body("wsl"),backend:"claude-code"},()=>true);
  expect(r.fm.fleetConfig!.instances["agent-1"]).toMatchObject({backend_options:{"claude-code":{credential_profile:"work-account"}}});expect(account).toHaveBeenCalled();
  await r.service.change("agent-1",r.body(),()=>true);
  const config=r.fm.fleetConfig!.instances["agent-1"]!;expect(config).not.toHaveProperty("backend_options");
 });
 it("keeps a General's role on a capable terminal target and leaves its profile ready for the explicit terminal start",async()=>{
  const r=fixture();r.before.general_topic=true;r.before.tool_set="general";
  await r.service.change("agent-1",{...r.body(),adapter:"pane"},()=>true);
  const config=r.fm.fleetConfig!.instances["agent-1"]!;expect(config).toMatchObject({general_topic:true,tool_set:"general",native_adapter:"pane",topic_id:7,channel_id:"chat"});
  const store=new WindowsAgents(r.home,r.bridge);expect(store.get(config.native_agent_id!).paused).toBe(false);expect(store.reservePane(config.native_agent_id!,crypto.randomUUID()).paneLaunchId).toBeTruthy();
 });
 it("refuses a persistent terminal destination whose Runtime does not negotiate panes",async()=>{
  const r=fixture();r.machines.get(b)!.paneProtocol=0;
  await expect(r.service.change("agent-1",{...r.body(),adapter:"pane"},()=>true)).rejects.toThrow("Runtime");expect(r.save).not.toHaveBeenCalled();expect(r.bridge.prepareWorkspace).not.toHaveBeenCalled();
 });
 it("never imports a prepared, uncommitted target as a second Agent after a restart",async()=>{
  const r=fixture(),input={...r.body(),backend:"codex" as const,directory:"",model:"",adapter:"exec" as const,runtime:"windows" as const,sandbox:"read-only" as const,startNewConversation:true as const};
  const prepared=await r.fm.nativeInstanceRuntime().prepareRuntimeChange("agent-1",r.before,input,()=>true);
  const restarted=new WindowsAgents(r.home,r.bridge);registerWindowsProfiles(r.fm.fleetConfig!,restarted,()=>{});
  expect(Object.keys(r.fm.fleetConfig!.instances)).toEqual(["agent-1"]);expect(r.fm.fleetConfig!.instances["agent-1"]).toBe(r.before);expect(restarted.list()[0]?.fleet_instance).toBe("agent-1");prepared.discard();
 });
 it.each([false,true])("moves a %s Windows source to the chosen computer, retains roles/history and never resumes its old provider session",async windows=>{
  const r=fixture(windows);await expect(r.service.change("agent-1",r.body(),()=>true)).resolves.toMatchObject({name:"agent-1",runtime:"windows",machineId:b,started:false});
  const config=r.fm.fleetConfig!.instances["agent-1"]!;
  expect(Object.keys(r.fm.fleetConfig!.instances)).toEqual(["agent-1"]);expect(config).toMatchObject({runtime:"windows",machine_id:b,backend:"codex",tool_set:"worker",dashboard:{tasks:false},display_name:"Helper",topic_id:7,channel_id:"chat",systemPrompt:"Keep instructions"});
  expect(config.native_agent_id).not.toBe(oldId);expect(config.working_directory).toContain(b);expect(r.fm.fleetConfig!.teams!.review!.members).toEqual(["agent-1"]);
  const store=new WindowsAgents(r.home,r.bridge),profile=store.get(config.native_agent_id!);expect(profile.threadId).toBeUndefined();expect(profile.paused).toBe(true);expect(profile.fleet_instance).toBe("agent-1");expect(profile.turns).toEqual([]);
  expect(r.fm.webChatHistory.list("agent-1").some(row=>row.text==="Shared AgEnD history")).toBe(true);
  if(windows){expect(store.get(oldId).threadId).toBe(a);expect(r.fm.webChatHistory.list("agent-1").map(row=>row.text)).toContain("Retained reply");}
  const count=Object.keys(r.fm.fleetConfig!.instances).length;registerWindowsProfiles(r.fm.fleetConfig!,store,()=>{});expect(Object.keys(r.fm.fleetConfig!.instances)).toHaveLength(count);
 });
 it("returns a Windows Agent to Linux with fresh pointers, retaining its original profile and AgEnD identity",async()=>{
  const r=fixture(true);writeFileSync(join(r.instanceDir,"session-id"),"old-linux-thread");writeFileSync(join(r.instanceDir,"session-id.backend"),"codex");
  await r.service.change("agent-1",r.body("wsl",undefined),()=>true);
  const config=r.fm.fleetConfig!.instances["agent-1"]!;expect(config.runtime).toBe("wsl");expect(config).not.toHaveProperty("machine_id");expect(config).not.toHaveProperty("native_agent_id");expect(config.working_directory).toBe(join(r.home,"workspaces","agent-1"));expect(existsSync(config.working_directory)).toBe(true);
  expect(existsSync(join(r.instanceDir,"session-id"))).toBe(false);expect(new WindowsAgents(r.home,r.bridge).get(oldId).threadId).toBe(a);expect(r.fm.webChatHistory.list("agent-1").map(row=>row.text)).toContain("Retained reply");
 });
 it("rolls back the prepared Windows profile when source configuration changes while workspace preparation is held",async()=>{
  const r=fixture(),original=r.bridge.prepareWorkspace;let release!:(value:string)=>void;
  vi.mocked(r.bridge.prepareWorkspace).mockImplementationOnce(()=>new Promise(yes=>{release=yes;}));
  const result=r.service.change("agent-1",r.body(),()=>true),assertion=expect(result).rejects.toThrow();await vi.waitFor(()=>expect(r.bridge.prepareWorkspace).toHaveBeenCalledOnce());
  r.fm.fleetConfig!.instances["agent-1"]={...r.before,description:"Changed concurrently"};release("C:\\prepared");await assertion;expect(r.save).not.toHaveBeenCalled();expect(new WindowsAgents(r.home,r.bridge).list()).toEqual([]);expect(r.any.stopInstance).not.toHaveBeenCalled();
 });
 it("pins the selected Runtime generation instead of accepting an offline/reconnected target after a wait",async()=>{
  const r=fixture(),machine=r.machines.get(b)!;let release!:(value:string)=>void;vi.mocked(r.bridge.prepareWorkspace).mockImplementationOnce(()=>new Promise(yes=>{release=yes;}));
  const result=r.service.change("agent-1",r.body(),()=>true),assertion=expect(result).rejects.toThrow();await vi.waitFor(()=>expect(r.bridge.prepareWorkspace).toHaveBeenCalledOnce());machine.bootId=a;release("C:\\prepared");await assertion;
  expect(r.save).not.toHaveBeenCalled();expect(new WindowsAgents(r.home,r.bridge).list()).toEqual([]);
 });
 it("does not stop an orphaned Linux CLI whose idle state is unknown",async()=>{
  const r=fixture();writeFileSync(join(r.instanceDir,"window-id"),"@7");await expect(r.service.change("agent-1",r.body(),()=>true)).rejects.toThrow("queued work");expect(r.bridge.prepareWorkspace).not.toHaveBeenCalled();expect(r.any.stopInstance).not.toHaveBeenCalled();
 });
 it("proves the exact old tmux window exited even when its name changed",async()=>{
  const r=fixture();writeFileSync(join(r.instanceDir,"window-id"),"@7");r.fm.lifecycle.daemons.set("agent-1",{} as any);r.any.getInstanceExecutionState=()=>"idle";vi.mocked(TmuxManager.sessionExistsStrict).mockResolvedValue(true);vi.spyOn(TmuxManager,"listWindowsStrict").mockResolvedValue([{id:"@7",name:"renamed"}]);
  await expect(r.service.change("agent-1",r.body(),()=>true)).rejects.toThrow("exit is unconfirmed");expect(r.save).not.toHaveBeenCalled();expect(r.fm.fleetConfig!.instances["agent-1"]).toBe(r.before);expect(new WindowsAgents(r.home,r.bridge).list()).toEqual([]);
 });
});
