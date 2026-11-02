/** Full InstanceLifecycle/Daemon flow with an inert native runner; every local process/window boundary throws. */
import {afterEach,expect,it,vi} from "vitest";
import {EventEmitter} from "node:events";
import {mkdtempSync,rmSync,existsSync,writeFileSync,mkdirSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {randomUUID} from "node:crypto";
import {FleetManager} from "../src/fleet-manager.js";
import {DEFAULT_INSTANCE_CONFIG} from "../src/config.js";
import {createNativePaneBackend} from "../src/backend/native-pane.js";
import * as factory from "../src/backend/factory.js";
vi.mock("../src/tmux-manager.js",async original=>({...await original<typeof import("../src/tmux-manager.js")>(),TmuxManager:class{constructor(){throw Error("No coordinator tmux server in this fixture");}}}));
const clean:Array<()=>unknown>=[];afterEach(async()=>{for(const f of clean.splice(0).reverse())await f();vi.restoreAllMocks();});
function fixture(provider:"codex"|"claude-code"="codex"){
 const dir=mkdtempSync(join(tmpdir(),"agend-native-instance-lifecycle-"));clean.push(()=>rmSync(dir,{recursive:true,force:true}));const cwd=`Z:\\agend-native-never-local-${randomUUID()}`,paneId=randomUUID(),sessionId=randomUUID();clean.push(()=>rmSync(resolve(cwd),{recursive:true,force:true}));
 const fleet:any=new FleetManager(dir),config={...structuredClone(DEFAULT_INSTANCE_CONFIG),working_directory:cwd,runtime:"windows",native_adapter:"pane",native_agent_id:randomUUID(),native_sandbox:"read-only",backend:provider,agent_mode:"cli",log_level:"silent"};fleet.fleetConfig={defaults:{},instances:{native:config}};
 const forbidden=vi.fn(()=>{throw Error("No coordinator process/window operation");}),pane={getWindowId:()=>paneId,getPaneStatus:vi.fn(async()=>({alive:true})),capturePane:vi.fn(async()=>""),capturePaneWithHistory:vi.fn(async()=>""),pipeOutput:forbidden,killWindow:forbidden,sendSpecialKey:forbidden};
 const observation=Object.assign(new EventEmitter(),{start:vi.fn(),stop:vi.fn(),registerWindow:vi.fn(async()=>{}),unregisterWindow:vi.fn(),getObservationResetAt:()=>Date.now(),isObservationBlind:()=>false,isIdle:()=>true,getLastOutputAt:()=>undefined,hasOutputSince:()=>false});
 const backend=createNativePaneBackend(provider,()=>({sessionId,contextPercentage:null,statusLineItems:[],resumes:true})),source={initialize:vi.fn(async()=>{}),poll:vi.fn(async()=>({toolUses:[],toolResults:[],assistantTexts:[]})),close:vi.fn(),reset:vi.fn(),currentPath:()=>null,following:()=>true,turnStateKnown:()=>true};
 const native={backend,host:{executionHost:"remote",bind:forbidden,ensureSession:forbidden,getPanePid:forbidden},observation,acquire:vi.fn(async(check:()=>void)=>{check();return{pane,source,disposition:"reattached"};}),release:vi.fn(async()=>{}),checkpointSession:vi.fn(),mcpProof:()=>"unknown",current:()=>true};
 fleet.nativePaneFor=vi.fn(async(_name:any,_config:any,check:()=>void)=>{check();return native;});vi.spyOn(factory,"createBackend").mockImplementation(()=>{throw Error("Local backend configuration is forbidden");});
 clean.push(async()=>{for(const daemon of fleet.daemons.values())await daemon.abortStartup();for(const channel of fleet.instanceIpcClients.values())await channel.close();});return{fleet,config,native,forbidden,dir,cwd};
}
it.each(["codex","claude-code"] as const)("%s starts through the native factory before any coordinator cwd, root or binary setup",async provider=>{
 const f=fixture(provider);await expect(f.fleet.lifecycle.start("native",f.config,true)).resolves.toBeUndefined();const daemon=f.fleet.daemons.get("native");expect(daemon.usesNativePane()).toBe(true);expect(daemon.config.agent_mode).toBe("mcp");expect(f.native.acquire).toHaveBeenCalledOnce();expect(existsSync(f.cwd)).toBe(false);expect(f.forbidden).not.toHaveBeenCalled();expect(factory.createBackend).not.toHaveBeenCalled();
 await f.fleet.lifecycle.stop("native");expect(f.native.release).toHaveBeenCalledExactlyOnceWith("close");expect(f.fleet.daemons.has("native")).toBe(false);expect(f.forbidden).not.toHaveBeenCalled();
});
it("a missing native factory holds without creating the Windows cwd on the coordinator",async()=>{
 const f=fixture();f.fleet.nativePaneFor=undefined;await expect(f.fleet.lifecycle.start("native",f.config,true)).rejects.toThrow("no local CLI");expect(existsSync(f.cwd)).toBe(false);expect(f.fleet.daemons.size).toBe(0);expect(factory.createBackend).not.toHaveBeenCalled();
});
it("native outbox reconciliation needs its own proof and never retires saved local windows",async()=>{
 const f=fixture(),instance=f.fleet.getInstanceDir("native");mkdirSync(instance,{recursive:true});writeFileSync(join(instance,"window-id"),"%OFF_LIMITS");
 f.fleet.deliveryOutbox={recoverTargetGeneration:vi.fn(()=>({queued:0,reconciliationPending:1}))};f.fleet.reconcileNativePaneBeforeStart=vi.fn(async()=>false);
 await expect(f.fleet.lifecycle.start("native",f.config,true)).rejects.toThrow();expect(f.fleet.reconcileNativePaneBeforeStart).toHaveBeenCalledOnce();expect(f.native.acquire).not.toHaveBeenCalled();expect(f.native.release).toHaveBeenCalledExactlyOnceWith("detach");expect(f.forbidden).not.toHaveBeenCalled();
});
it("stopping an unpublished retained native owner uses its typed close hook and never a saved local PID/window",async()=>{
 const f=fixture(),instance=f.fleet.getInstanceDir("native");mkdirSync(instance,{recursive:true});writeFileSync(join(instance,"daemon.pid"),String(process.pid));writeFileSync(join(instance,"window-id"),"%OFF_LIMITS");f.fleet.closeRetainedNativePane=vi.fn(async()=>{});
 const signal=vi.spyOn(process,"kill").mockImplementation(()=>{throw Error("No PID signal");});await f.fleet.lifecycle.stop("native");expect(f.fleet.closeRetainedNativePane).toHaveBeenCalledExactlyOnceWith("native");expect(signal).not.toHaveBeenCalled();expect(f.forbidden).not.toHaveBeenCalled();
});
