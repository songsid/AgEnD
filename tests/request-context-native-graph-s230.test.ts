import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach,expect,it} from "vitest";
import {FleetManager} from "../src/fleet-manager.js";
import {RequestContextPaneProofs} from "../src/request-context-pane.js";
import {NativeMcpSessions} from "../src/native-mcp.js";
import {acquireFleetLock,setProcessFleetLock,releaseProcessFleetLock} from "../src/fleet-lock.js";
const roots:string[]=[];
afterEach(()=>{releaseProcessFleetLock();for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function rig(){
 const root=mkdtempSync(join(tmpdir(),"native-graph-s230-"));roots.push(root);setProcessFleetLock(acquireFleetLock(root));
 let current=true,fenced=true;const registration={assertRegistration:()=>{}};
 const graph={registration,panes:new RequestContextPaneProofs("fixture-proof-key-which-is-at-least-thirty-two-bytes",registration),execTurns:()=>{throw Error("No run started");},execOwner:()=>{throw Error("No run started");},current:()=>current};
 const fm:any=Object.assign(Object.create(FleetManager.prototype),{dataDir:root,requestContextAdmission:{available:()=>!fenced},fleetConfig:{instances:{}}});
 return {fm,graph,registration,current:(value:boolean)=>current=value,fenced:(value:boolean)=>fenced=value};
}
it("one fenced, physically retired graph creates a required-context grant factory registered to the same drain gate",()=>{
 const f=rig();f.fm.stageRequestContextNativeGraph(f.graph);const sessions=f.fm.nativeMcpSessions();expect(sessions).toBeInstanceOf(NativeMcpSessions);expect(sessions.drainView("root").registration).toBe(f.registration);
 expect(()=>sessions.grant({instance:"worker"}as any)).toThrow(/admitted request context/);expect(f.fm.nativeMcpSessions()).toBe(sessions);expect(()=>f.fm.stageRequestContextNativeGraph(f.graph)).toThrow(/not retired/);
});
it.each(["runtimeHub","localPaneRelay","openingLocalPane","paneManager","nativeMcpStore","fleetWindowsRuntime"])("an existing %s cannot be relabelled as a new scoped factory",key=>{
 const f=rig();f.fm[key]={};expect(()=>f.fm.stageRequestContextNativeGraph(f.graph)).toThrow(/not retired/);expect(f.fm.requestContextNativeGraph).toBeUndefined();
});
it("missing admission fence, wrong registry or lost exact Fleet lock refuses before factory creation",()=>{
 const f=rig();f.fenced(false);expect(()=>f.fm.stageRequestContextNativeGraph(f.graph)).toThrow(/not retired/);f.fenced(true);
 expect(()=>f.fm.stageRequestContextNativeGraph({...f.graph,panes:new RequestContextPaneProofs("fixture-proof-key-which-is-at-least-thirty-two-bytes")})).toThrow(/not retired/);
 releaseProcessFleetLock();expect(()=>f.fm.stageRequestContextNativeGraph(f.graph)).toThrow(/not retired/);expect(f.fm.nativeMcpStore).toBeUndefined();
});
it.each(["owner","lock"])("a later %s loss refuses even a cached factory and never falls back to legacy",kind=>{
 const f=rig();f.fm.stageRequestContextNativeGraph(f.graph);f.fm.nativeMcpSessions();if(kind==="owner")f.current(false);else releaseProcessFleetLock();expect(()=>f.fm.nativeMcpSessions()).toThrow(/owner changed/);
});
it("an activated boot without its prepared graph refuses instead of constructing a legacy grant factory",()=>{
 const f=rig();f.fm.requestContextBoot={};expect(()=>f.fm.nativeMcpSessions()).toThrow(/not prepared/);expect(f.fm.nativeMcpStore).toBeUndefined();
});
it("the default Off factory remains unregistered and does not acquire a required-context policy",()=>{
 const f=rig(),sessions=f.fm.nativeMcpSessions();expect(sessions.drainView("root").registration).toBeNull();expect(()=>sessions.grant({instance:"worker"}as any)).toThrow(/active supported Windows instance/);expect(f.fm.requestContextNativeFactoryOwners).toBeUndefined();
});

it("an in-flight asynchronous pane-manager construction also blocks graph replacement",()=>{
 const f=rig();f.fm.requestContextOpeningPaneManagers=1;expect(()=>f.fm.stageRequestContextNativeGraph(f.graph)).toThrow(/not retired/);f.fm.requestContextOpeningPaneManagers=0;f.fm.stageRequestContextNativeGraph(f.graph);expect(f.fm.currentRequestContextNativeGraph()).toBe(f.graph);
});
it("a cached object that was not created by this graph cannot be adopted by a later lookup",()=>{
 const f=rig();f.fm.stageRequestContextNativeGraph(f.graph);f.fm.nativeMcpStore=new NativeMcpSessions(f.fm);expect(()=>f.fm.nativeMcpSessions()).toThrow(/not prepared/);
});
