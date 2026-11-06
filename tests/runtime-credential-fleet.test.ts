import {mkdtempSync,mkdirSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,resolve,sep} from "node:path";
import {afterEach,beforeEach,describe,it,expect,vi} from "vitest";
vi.mock("node:child_process",async original=>({...await original<typeof import("node:child_process")>(),spawn:()=>{throw Error("No processes in credential profile tests");},execFile:()=>{throw Error("No CLI");},execFileSync:()=>{throw Error("No CLI");},execSync:()=>{throw Error("No CLI");},spawnSync:()=>{throw Error("No CLI");}}));
vi.mock("../src/logger.js",()=>({createLogger:()=>({info:vi.fn(),warn:vi.fn(),debug:vi.fn(),error:vi.fn(),child(){return this;}})}));
import {FleetManager} from "../src/fleet-manager.js";
import {TmuxManager} from "../src/tmux-manager.js";
import {WindowsAgents} from "../src/windows-agents.js";
import type {WindowsCliExecutor,WindowsCliTask,WindowsRunOptions} from "../src/windows-cli.js";
import {nativeCredentialProfile} from "../src/native-instance-registry.js";

const a="12345678-1234-4321-abcd-123456789012",b="22345678-1234-4321-abcd-123456789012",old="32345678-1234-4321-abcd-123456789012";
const fixtures:Array<{home:string;fm:FleetManager}>=[];
beforeEach(()=>{vi.stubEnv("AGEND_WINDOWS_CLI","1");vi.stubEnv("AGEND_REMOTE_RUNTIME","1");vi.spyOn(TmuxManager,"sessionExistsStrict").mockResolvedValue(false);});
afterEach(()=>{for(const {home,fm} of fixtures.splice(0)){fm.stormWindow.shutdown();fm.spawnGate.shutdown();if(!resolve(home).startsWith(resolve(tmpdir())+sep))throw Error("Unsafe fixture cleanup");rmSync(home,{recursive:true,force:true});}vi.restoreAllMocks();vi.unstubAllEnvs();});
const claude={id:"claude-code",path:"C:\\claude.exe",runnable:true,readOnlySupport:true,supports:{execution:true,resume:true,mcp:true}};
const report={profiles:[{name:"work",loggedIn:true},{name:"home",loggedIn:true},{name:"expired",loggedIn:false},{name:"unknown",loggedIn:null}],default:"work"};
function fixture(){
 const home=mkdtempSync(join(tmpdir(),"agend-credential-fleet-")),instanceDir=join(home,"instances","agent-1");mkdirSync(instanceDir,{recursive:true});
 const fm=new FleetManager(home),any=fm as any;fixtures.push({home,fm});
 const before:any={working_directory:home,backend:"claude-code",display_name:"Helper",description:"Role",systemPrompt:"Keep instructions",topic_id:7,channel_id:"chat",tool_set:"worker",dashboard:{tasks:false},
  credential_profile:"linux-only",pre_task_command:"source ~/.profile",backend_options:{"claude-code":{credential_profile:"linux-account",other_option:true}}};
 fm.fleetConfig={defaults:{backend:"claude-code"},instances:{"agent-1":before},teams:{}} as any;
 const machine=(id:string,extra:Record<string,unknown>={})=>({id,bootId:id,status:"online",platform:"win32",paneProtocol:1,runtimeInfo:{protocolVersions:[1],capabilities:["exec","mcp","panes","credential-profiles"]},inventory:{clis:[claude],credentialProfiles:report},...extra});
 const machines=new Map<string,any>([[a,machine(a)],[b,machine(b)]]);
 const started:Array<{input:any;options:WindowsRunOptions}>=[];let active=false;
 const bridge={probe:vi.fn(async()=>({clis:[claude]})),prepareWorkspace:vi.fn(async(id:string,_allowed:()=>boolean,machineId?:string)=>`C:\\managed-${machineId||"local"}\\${id}`),
  hasActiveTask:()=>active,get:()=>null,cancel:()=>{throw Error("No cancellation");},
  start:vi.fn((input:any,_auth:()=>boolean,options:WindowsRunOptions)=>{started.push({input,options});active=true;
   return {id:input.requestId,cli:input.cli,cwd:input.cwd,sandbox:input.sandbox,status:"running",startedAt:Date.now(),output:""} satisfies WindowsCliTask;})} as unknown as WindowsCliExecutor;
 any.runtimeWindowsExecutor=()=>bridge;any.runtimeCoordinator=()=>({machine:(id:string)=>machines.get(id)});
 any.backendAvailabilityRows=()=>[{backend:"claude-code",state:"usable"}];any.backendAvailabilityFor=()=>[{backend:"claude-code",state:"usable"}];
 const save=vi.fn();any.saveFleetConfig=save;any.getUiStatus=()=>({instances:Object.keys(fm.fleetConfig!.instances)});any.emitSseEvent=vi.fn();
 any.stopInstance=vi.fn(async(name:string)=>{fm.lifecycle.invalidate(name);fm.lifecycle.daemons.delete(name);return {backgroundWorkEnded:false};});
 const service=fm.agentRuntimeChanges();
 const body=(extra:Record<string,unknown>={})=>({requestId:crypto.randomUUID(),expectedRevision:service.describe("agent-1").revision,runtime:"windows",machineId:b,backend:"claude-code",sandbox:"read-only",startNewConversation:true,...extra});
 const config=()=>fm.fleetConfig!.instances["agent-1"] as any;
 return {home,fm,any,before,bridge,machines,machine,started,save,service,body,config,idle:()=>{active=false;}};
}

describe("choosing a Claude account for an agent on a Windows Runtime computer (the Change Runtime flow)",()=>{
 it("stores only the NAME as backend_options, keeps no other Linux-only setting, and reports it for the dialog",async()=>{
  const r=fixture();
  await r.service.change("agent-1",r.body({credentialProfile:"work"}),()=>true);
  const config=r.config();
  expect(config).toMatchObject({runtime:"windows",machine_id:b,backend:"claude-code",backend_options:{"claude-code":{credential_profile:"work"}}});
  expect(config.backend_options).toEqual({"claude-code":{credential_profile:"work"}});
  for(const key of ["credential_profile","pre_task_command"])expect(config).not.toHaveProperty(key);
  expect(JSON.stringify(config)).not.toMatch(/credential-profiles|\\\\\.claude|\.claude/);
  expect(r.service.describe("agent-1").credentialProfile).toBe("work");
 });
 it("a switch to another profile starts a new conversation (a new provider profile) and a switch to none removes the name",async()=>{
  const r=fixture();
  await r.service.change("agent-1",r.body({credentialProfile:"work"}),()=>true);const first=r.config().native_agent_id;
  await r.service.change("agent-1",r.body({credentialProfile:"home"}),()=>true);
  expect(r.config().backend_options).toEqual({"claude-code":{credential_profile:"home"}});expect(r.config().native_agent_id).not.toBe(first);
  const store=new WindowsAgents(r.home,r.bridge);expect(store.get(r.config().native_agent_id).threadId).toBeUndefined();
  await r.service.change("agent-1",r.body(),()=>true);
  expect(r.config()).not.toHaveProperty("backend_options");expect(r.service.describe("agent-1").credentialProfile).toBeUndefined();
 });
 it.each([
  ["is not a name (a Windows path)",{credentialProfile:"C:\\Users\\me\\.claude"},/Invalid credential profile name/],
  ["is not a name (a relative path)",{credentialProfile:"../work"},/Invalid credential profile name/],
  ["is empty",{credentialProfile:""},/Invalid credential profile name/],
  ["is for another CLI",{credentialProfile:"work",backend:"codex"},/Claude Code sign-in/],
  ["is for a WSL/Linux target",{credentialProfile:"work",runtime:"wsl",machineId:undefined},/Claude Code sign-in/],
 ])("refuses a profile that %s, before anything is prepared or saved",async(_why,extra,message)=>{
  const r=fixture(),before=JSON.stringify(r.config());
  expect(()=>r.service.change("agent-1",r.body(extra as any),()=>true)).toThrow(message);
  expect(r.save).not.toHaveBeenCalled();expect(r.bridge.prepareWorkspace).not.toHaveBeenCalled();expect(JSON.stringify(r.config())).toBe(before);
 });
 it("refuses a Runtime that does not report the capability: it would ignore the name and run another account",async()=>{
  const r=fixture();r.machines.set(b,r.machine(b,{runtimeInfo:{protocolVersions:[1],capabilities:["exec","mcp","panes"]}}));
  await expect(r.service.change("agent-1",r.body({credentialProfile:"work"}),()=>true)).rejects.toThrow(/Runtime is too old to choose a Claude account/);
  r.machines.set(b,r.machine(b,{runtimeInfo:undefined}));
  await expect(r.service.change("agent-1",r.body({credentialProfile:"work"}),()=>true)).rejects.toThrow(/too old/);
  expect(r.save).not.toHaveBeenCalled();expect(r.config().runtime).toBeUndefined();
 });
 it("refuses a name the computer has not reported and a profile it reports as signed out; an unchecked one is the Runtime's call at run time",async()=>{
  const r=fixture();
  await expect(r.service.change("agent-1",r.body({credentialProfile:"ghost"}),()=>true)).rejects.toThrow(/has not reported a credential profile named "ghost".*agend-runtime login claude-code ghost/);
  await expect(r.service.change("agent-1",r.body({credentialProfile:"expired"}),()=>true)).rejects.toThrow(/"expired" is not signed in on that computer/);
  expect(r.save).not.toHaveBeenCalled();
  await expect(r.service.change("agent-1",r.body({credentialProfile:"unknown"}),()=>true)).resolves.toMatchObject({machineId:b});
 });
});

describe("a message to a Windows agent that has a credential profile",()=>{
 const send=(r:ReturnType<typeof fixture>)=>r.fm.nativeInstanceRuntime().deliver("agent-1",{requestId:crypto.randomUUID(),content:"hello",meta:{source:"web"}});
 it("carries the NAME (and only the name) to the bridge",async()=>{
  const r=fixture();await r.service.change("agent-1",r.body({credentialProfile:"work"}),()=>true);
  await send(r);
  expect(r.started).toHaveLength(1);expect(r.started[0].options).toMatchObject({machineId:b,credentialProfile:"work"});
  expect(r.started[0].options.credentialHome).toBeUndefined();expect(JSON.stringify(r.started[0])).not.toMatch(/credential-profiles|\.claude/);
  expect(JSON.stringify(new WindowsAgents(r.home,r.bridge).list())).not.toContain("credential_profile");
 });
 it("sends no profile for an agent that has none",async()=>{
  const r=fixture();await r.service.change("agent-1",r.body(),()=>true);await send(r);
  expect(r.started[0].options.credentialProfile).toBeUndefined();
 });
 it.each([
  ["a malformed name in the saved configuration",(c:any)=>{c.backend_options={"claude-code":{credential_profile:"C:\\Users\\me\\.claude"}};},/Credential profile names/],
  ["a path-like name",(c:any)=>{c.backend_options={"claude-code":{credential_profile:"../other"}};},/Credential profile names/],
  ["a profile on a CLI that has no credential home",(c:any)=>{c.backend="codex";},/Claude Code only/],
  ["a profile for another CLI's options",(c:any)=>{c.backend_options={"claude-code":{credential_profile:"work"},codex:{credential_profile:"work"}};},/Claude Code only/],
  ["a profile on an agent that has no paired computer",(c:any)=>{delete c.machine_id;},/does not match its saved conversation|paired Runtime computer/],
 ])("fails closed on %s: nothing is journaled or started",async(_why,tamper,message)=>{
  const r=fixture();await r.service.change("agent-1",r.body({credentialProfile:"work"}),()=>true);
  tamper(r.config());
  await expect(send(r)).rejects.toThrow(message);
  expect(r.started).toEqual([]);expect(r.bridge.start).not.toHaveBeenCalled();
  const agent=new WindowsAgents(r.home,r.bridge).list()[0];expect(agent.activeId).toBeUndefined();
 });
});

describe("the server-side reading of a Windows agent's profile",()=>{
 const base=(extra:any={})=>({backend:"claude-code",machine_id:b,...extra});
 it("is the validated name, or undefined when there is none",()=>{
  expect(nativeCredentialProfile(base())).toBeUndefined();
  expect(nativeCredentialProfile(base({backend_options:{}}))).toBeUndefined();
  expect(nativeCredentialProfile(base({backend_options:{"claude-code":{credential_profile:""}}}))).toBeUndefined();
  expect(nativeCredentialProfile(base({backend_options:{"claude-code":{credential_profile:"work"}}}))).toBe("work");
  expect(nativeCredentialProfile(undefined)).toBeUndefined();
 });
 it.each([5,true,{},["work"],"a/b","C:\\x","..","con"])("refuses the value %j",value=>{
  expect(()=>nativeCredentialProfile(base({backend_options:{"claude-code":{credential_profile:value}}}))).toThrow();
 });
});
