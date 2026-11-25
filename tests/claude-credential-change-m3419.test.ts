import Database from "better-sqlite3";
import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changeIdleClaudeCredential } from "../src/claude-credential-change.js";
import { ClaudeCredentialVault } from "../src/claude-credential-vault.js";
import { FleetManager } from "../src/fleet-manager.js";
import { LoginWindowLock } from "../src/login-window-lock.js";
import { Daemon } from "../src/daemon.js";
import { TurnReplyGuard } from "../src/turn-reply-guard.js";
const cleanup:Array<()=>void|Promise<void>>=[];
afterEach(async()=>{vi.restoreAllMocks();vi.unstubAllEnvs();for(const fn of cleanup.splice(0).reverse())await fn();});
const actor={adapterId:"host",userId:"operator"},value="synthetic-"+"x".repeat(48);
function rig(){
 const home=mkdtempSync(join(tmpdir(),"claude-change-"));cleanup.push(()=>rmSync(home,{recursive:true,force:true}));
 vi.stubEnv("HOME",home);vi.stubEnv("AGEND_HOME",home);vi.stubEnv("CLAUDE_CONFIG_DIR",join(home,"claude"));
 const v=new ClaudeCredentialVault(home);v.write(null,0,{kind:"api-key",value},actor);v.close();
 const fm:any=Object.create(FleetManager.prototype),epochs=new Map([["helper",1]]),config={backend:"claude-code",working_directory:home};
 Object.defineProperty(fm,"daemons",{value:new Map(),writable:true,configurable:true});
 const daemon={getConfigSnapshot:()=>config,quiesceClaudeCredential:vi.fn(async()=>true),claudeCredentialRetired:vi.fn(async()=>true)};
 Object.assign(fm,{dataDir:home,fleetConfig:{defaults:{backend:"claude-code"},instances:{helper:config}},settingsGeneration:1,shuttingDown:false,
  daemons:new Map([["helper",daemon]]),loginWindow:new LoginWindowLock(),claudeCredentialChanges:new Map(),credentialLeases:new Map(),keepAliveRenewing:new Map(),credentialOrphans:new Map(),accountWriters:new Set(),sseClients:new Set(),
  lifecycle:{epochOf:(name:string)=>epochs.get(name)??0,runTransition:async(name:string,fn:any)=>fn({name,token:Symbol(name)})},
  accountUses:()=>({agents:[{name:"helper",backend:"claude-code",profile:null}],classic:[],fleetDefaults:new Map()}),keepAliveInUse:()=>false,
  stopInstance:vi.fn(async(name:string)=>{epochs.set(name,(epochs.get(name)??0)+1);fm.daemons.delete(name);return {backgroundWorkEnded:false};}),
  startInstance:vi.fn(async(name:string,...args:any[])=>{args.at(-1)?.assert();fm.daemons.set(name,daemon);}),forgetSignInIdentities:vi.fn(),usageAfterSignIn:vi.fn()});
 const view=fm.claudeCredentialConsumers?.(null)??{users:["helper"],revision:"a".repeat(64)};
 const change=(authorized=()=>true)=>fm.changeClaudeCredential(null,1,{kind:"setup-token",value},actor,{restart:true,consumersRevision:view.revision},authorized);
 return {fm,home,daemon,epochs,view,change};
}
it("a used profile changes only after its idle CLI is stopped, then restarts only that consumer",async()=>{
 const r=rig();r.fm.stopInstance.mockImplementation(async(name:string)=>{
  expect(r.fm.claudeCredentialMetadata(null).revision).toBe(1);r.epochs.set(name,2);r.fm.daemons.delete(name);return {backgroundWorkEnded:false};
 });
 r.fm.startInstance.mockImplementation(async()=>{expect(r.fm.claudeCredentialMetadata(null)).toMatchObject({kind:"setup-token",revision:2});});
 const result=await r.change();expect(result).toMatchObject({credential:{revision:2},restarted:["helper"],pending:[]});
 expect(r.daemon.quiesceClaudeCredential).toHaveBeenCalledOnce();expect(r.fm.stopInstance).toHaveBeenCalledOnce();expect(r.fm.startInstance).toHaveBeenCalledOnce();
 expect(r.fm.loginWindow.holderFor("claude-code")).toBeNull();expect(r.fm.claudeCredentialChanges.size).toBe(0);
});
it("busy, stale consumer confirmation and an uncertain old process refuse without changing the secret",async()=>{
 const r=rig();r.daemon.quiesceClaudeCredential.mockResolvedValue(false);await expect(r.change()).rejects.toThrow("in-use");
 expect(r.fm.stopInstance).not.toHaveBeenCalled();expect(r.fm.claudeCredentialMetadata(null).revision).toBe(1);
 r.daemon.quiesceClaudeCredential.mockResolvedValue(true);r.epochs.set("helper",2);await expect(r.change()).rejects.toThrow("conflict");
 const fresh=r.fm.claudeCredentialConsumers(null);r.fm.credentialOrphans.set(Symbol(),{key:r.fm.credentialKey("claude-code",null)});
 await expect(r.fm.changeClaudeCredential(null,1,null,actor,{restart:true,consumersRevision:fresh.revision},()=>true)).rejects.toThrow("in-use");
 expect(r.fm.claudeCredentialMetadata(null).revision).toBe(1);
});
it("revocation after the stop preserves the old credential and recovers its owned idle consumer",async()=>{
 const r=rig();let authorized=true;
 r.fm.stopInstance.mockImplementation(async()=>{r.epochs.set("helper",2);r.fm.daemons.delete("helper");authorized=false;return {backgroundWorkEnded:false};});
 await expect(r.change(()=>authorized)).rejects.toThrow("session-changed");
 expect(r.fm.claudeCredentialMetadata(null)).toMatchObject({kind:"api-key",revision:1});expect(r.fm.startInstance).toHaveBeenCalledOnce();
});
it("a storage failure recovers old consumers, removal keeps them stopped, and a failed restart is explicit",async()=>{
 const r=rig();const db=new Database(join(r.home,"credential-vault","claude.sqlite"));db.exec("CREATE TRIGGER refuse_write BEFORE UPDATE ON credentials BEGIN SELECT RAISE(ABORT,'synthetic storage refusal'); END");db.close();
 await expect(r.change()).rejects.toThrow("synthetic storage refusal");expect(r.fm.startInstance).toHaveBeenCalledOnce();
 const removed=rig();const out=await removed.fm.changeClaudeCredential(null,1,null,actor,{restart:true,consumersRevision:removed.view.revision},()=>true);
 expect(out).toMatchObject({credential:{kind:null,revision:2},stopped:["helper"],restarted:[]});expect(removed.fm.startInstance).not.toHaveBeenCalled();
 const failed=rig();failed.fm.startInstance.mockRejectedValue(Error("synthetic restart refusal"));expect(await failed.change()).toMatchObject({credential:{revision:2},pending:["helper"]});
});
it("a manual stop or settings change while quiescing cannot commit or resurrect the agent",async()=>{
 const r=rig();r.daemon.quiesceClaudeCredential.mockImplementation(async()=>{r.epochs.set("helper",2);return true;});
 await expect(r.change()).rejects.toThrow("conflict");expect(r.fm.startInstance).not.toHaveBeenCalled();expect(r.fm.claudeCredentialMetadata(null).revision).toBe(1);
});
it("all old consumers stop before commit; a second busy pane recovers only the first claimed pane",async()=>{
 const calls:string[]=[],first={name:"first",quiesce:async()=>{calls.push("q1");return true;},stop:async()=>{calls.push("s1");},current:()=>true,recover:async()=>{calls.push("r1");}},second={...first,name:"second",quiesce:async()=>false};
 const commit=vi.fn();await expect(changeIdleClaudeCredential({consumers:[first,second],assertCurrent:()=>{},commit,releaseStarts:()=>{calls.push("release");},restart:true})).rejects.toThrow("in-use");
 expect(commit).not.toHaveBeenCalled();expect(calls).toEqual(["q1","release","r1"]);
});
it("daemon quiescence uses the pane lock and rejects busy or a changed spawn before fencing input",async()=>{
 const daemon:any=Object.create(Daemon.prototype);Object.defineProperty(daemon,"paneHost",{value:{getPanePid:async()=>123},writable:true,configurable:true});let generation=1;
 Object.assign(daemon,{requestContextCalls:new Map(),backend:{binaryName:"claude"},spawnGeneration:1,launchFenceEpoch:1,pauseWakeState:"active",spawning:false,healthCheckPaused:false,deliveryWritesStopping:false,startupAborted:false,deliveryEpoch:0,
  turnReplyGuard:new TurnReplyGuard(),tmux:{getWindowId:()=>"@fixture"},tmuxSessionName:"fixture",paneHost:{getPanePid:async()=>123},usesNativePane:()=>false,paneWriteLock:{run:vi.fn(async(fn:any)=>fn())},isPaneAuthoritativelyIdle:vi.fn(async()=>false)});
 expect(await daemon.quiesceClaudeCredential()).toBe(false);expect(daemon.deliveryWritesStopping).toBe(false);
 daemon.isPaneAuthoritativelyIdle.mockImplementation(async()=>{daemon.spawnGeneration=++generation;return true;});
 expect(await daemon.quiesceClaudeCredential()).toBe(false);expect(daemon.deliveryWritesStopping).toBe(false);
 daemon.isPaneAuthoritativelyIdle.mockResolvedValue(true);expect(await daemon.quiesceClaudeCredential()).toBe(true);expect(daemon.deliveryWritesStopping).toBe(true);expect(daemon.paneWriteLock.run).toHaveBeenCalledTimes(3);
});
it("real local HTTP can confirm an idle used-profile change, and revocation during stop returns 403 with the old source",async()=>{
 const {createServer,request}=await import("node:http"),{handleWebRequest}=await import("../src/web-api.js"),{WebSessionStore,csrfTokenFor,tokenEpoch}=await import("../src/web-session.js");
 for(const revoke of [false,true]){
  const r=rig(),token="fixture-web-"+"x".repeat(32),sessions=new WebSessionStore({});let verified=true;
  const made=sessions.create({tier:"admin",surface:"local",label:"Fixture browser",tokenEpoch:tokenEpoch(token)});
  const ctx:any={webToken:token,webSessions:sessions,contactActor:()=>verified?{...actor,platform:"host",label:"Operator"}:null,
   claudeCredentialMetadata:r.fm.claudeCredentialMetadata.bind(r.fm),claudeCredentialConsumers:r.fm.claudeCredentialConsumers?.bind(r.fm),writeClaudeCredential:r.fm.writeClaudeCredential.bind(r.fm),changeClaudeCredential:r.fm.changeClaudeCredential?.bind(r.fm)};
  const server=createServer((req,res)=>{if(!handleWebRequest(req,res,new URL(req.url!,"http://127.0.0.1"),ctx)){res.writeHead(404);res.end();}});
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));cleanup.push(()=>new Promise<void>(resolve=>server.close(()=>resolve())));
  if(revoke){r.fm.stopInstance.mockImplementation(async()=>{r.epochs.set("helper",2);r.fm.daemons.delete("helper");verified=false;return {backgroundWorkEnded:false};});}
  const data=JSON.stringify({profile:null,revision:1,kind:"setup-token",value,restart:true,consumersRevision:r.view.revision});
  const response=await new Promise<{code:number;body:any}>((resolve,reject)=>{const req=request({hostname:"127.0.0.1",port:(server.address() as any).port,path:"/ui/claude-credentials",method:"PUT",headers:{cookie:"agend_session="+made.sessionId,origin:"http://127.0.0.1:"+(server.address() as any).port,"x-agend-csrf":csrfTokenFor(made.sessionId),"content-type":"application/json","content-length":Buffer.byteLength(data)}},res=>{let body="";res.on("data",part=>body+=part);res.on("end",()=>resolve({code:res.statusCode!,body:JSON.parse(body)}));});req.on("error",reject);req.end(data);});
  expect(response.code).toBe(revoke?403:200);
  expect(r.fm.claudeCredentialMetadata(null)).toMatchObject({revision:revoke?1:2,kind:revoke?"api-key":"setup-token"});
  expect(JSON.stringify(response.body)).not.toContain(value);
 }
});
it("account-writer drain tracks the operation and new launch admission waits until the committed source",async()=>{
 const r=rig();let entered!:()=>void,finish!:()=>void;const inStop=new Promise<void>(resolve=>{entered=resolve;}),hold=new Promise<void>(resolve=>{finish=resolve;});
 r.fm.stopInstance.mockImplementation(async()=>{entered();await hold;r.epochs.set("helper",2);r.fm.daemons.delete("helper");return {backgroundWorkEnded:false};});
 const change=r.change();await inStop;expect(r.fm.accountWriters.size).toBe(1);
 let admitted=false;const use=r.fm.admitCredentialUse("later",{backend:"claude-code"},"claude-code",()=>{}).then((lease:any)=>{admitted=true;expect(r.fm.claudeCredentialMetadata(null).revision).toBe(2);lease.release();});
 await Promise.resolve();expect(admitted).toBe(false);finish();await change;await use;expect(r.fm.accountWriters.size).toBe(0);
});
it("launch admission rechecks a source change that begins as keep-alive completes",async()=>{
 const r=rig(),key=r.fm.credentialKey("claude-code",null);let finishRenew!:()=>void,finishChange!:()=>void,admitted=false;
 const renew=new Promise<void>(resolve=>{finishRenew=resolve;}),change=new Promise<void>(resolve=>{finishChange=resolve;});r.fm.keepAliveRenewing.set(key,renew);
 const use=r.fm.admitCredentialUse("later",{backend:"claude-code"},"claude-code",()=>{}).then((lease:any)=>{admitted=true;lease.release();});
 r.fm.claudeCredentialChanges.set(key,change);r.fm.keepAliveRenewing.delete(key);finishRenew();await Promise.resolve();await Promise.resolve();expect(admitted).toBe(false);
 r.fm.claudeCredentialChanges.delete(key);finishChange();await use;expect(admitted).toBe(true);
});

it("an unconfirmed old pane retains the old secret and blocks later rotation until retirement is proven",async()=>{
 const r=rig();r.daemon.claudeCredentialRetired.mockResolvedValue(false);
 await expect(r.change()).rejects.toThrow("unavailable");expect(r.fm.claudeCredentialMetadata(null).revision).toBe(1);expect(r.fm.startInstance).not.toHaveBeenCalled();expect(r.fm.credentialOrphans.size).toBe(1);
 const view=r.fm.claudeCredentialConsumers(null);
 await expect(r.fm.changeClaudeCredential(null,1,null,actor,{restart:true,consumersRevision:view.revision},()=>true)).rejects.toThrow("in-use");expect(r.fm.claudeCredentialMetadata(null).revision).toBe(1);
});
it("retirement proof rejects unreadable, same or unknown panes and accepts a missing or replaced incarnation",async()=>{
 const {TmuxManager}=await import("../src/tmux-manager.js");const daemon:any=Object.create(Daemon.prototype),pid=vi.fn(async():Promise<number|null>=>123);
 Object.defineProperty(daemon,"paneHost",{value:{getPanePid:pid}});daemon.tmuxSessionName="credential-fixture";
 const windows=vi.spyOn(TmuxManager,"listWindowsStrict").mockRejectedValue(Error("synthetic unreadable inventory"));
 expect(await daemon.claudeCredentialRetired()).toBe(false);daemon.credentialChangeIncarnation={windowId:"@fixture",pid:123};
 expect(await daemon.claudeCredentialRetired()).toBe(false);windows.mockResolvedValue([{id:"@fixture"}] as any);expect(await daemon.claudeCredentialRetired()).toBe(false);
 pid.mockResolvedValue(null);expect(await daemon.claudeCredentialRetired()).toBe(false);pid.mockResolvedValue(456);expect(await daemon.claudeCredentialRetired()).toBe(true);
 windows.mockResolvedValue([]);expect(await daemon.claudeCredentialRetired()).toBe(true);
});

function logicalTurnDaemon(){
 const daemon:any=Object.create(Daemon.prototype),turn=new TurnReplyGuard();
 Object.defineProperty(daemon,"paneHost",{value:{getPanePid:vi.fn(async()=>123)},writable:true,configurable:true});
 Object.assign(daemon,{requestContextCalls:new Map(),backend:{binaryName:"claude"},spawnGeneration:1,launchFenceEpoch:1,pauseWakeState:"active",spawning:false,healthCheckPaused:false,deliveryWritesStopping:false,startupAborted:false,deliveryEpoch:0,turnReplyGuard:turn,
  tmux:{getWindowId:()=>"@fixture"},tmuxSessionName:"fixture",usesNativePane:()=>false,paneWriteLock:{run:async(fn:any)=>fn()},isPaneAuthoritativelyIdle:vi.fn(async()=>true)});
 return {daemon,turn};
}
it("idle-looking unfinished owned turns refuse credential changes before stop or commit",async()=>{
 const r=rig(),{daemon,turn}=logicalTurnDaemon();
 turn.arm({chatId:"fixture-room",messageId:"fixture-request"});
 r.daemon.quiesceClaudeCredential.mockImplementation(()=>daemon.quiesceClaudeCredential());
 await expect(r.change()).rejects.toThrow("in-use");
 expect(r.fm.stopInstance).not.toHaveBeenCalled();expect(r.fm.startInstance).not.toHaveBeenCalled();
 expect(r.fm.claudeCredentialMetadata(null).revision).toBe(1);expect(daemon.deliveryWritesStopping).toBe(false);
 expect(daemon.paneHost.getPanePid).not.toHaveBeenCalled();
});
it("logical turn admission is fresh after both pane awaits and retains completed/cancelled positives",async()=>{
 for(const stage of ["idle","pid"]){
  const {daemon,turn}=logicalTurnDaemon();
  const intervene=async()=>{turn.arm({chatId:"fixture-room"});return stage==="idle"?true:123;};
  if(stage==="idle")daemon.isPaneAuthoritativelyIdle.mockImplementation(intervene);else daemon.paneHost.getPanePid.mockImplementation(intervene);
  expect(await daemon.quiesceClaudeCredential()).toBe(false);expect(daemon.deliveryWritesStopping).toBe(false);
 }
 for(const ending of ["complete","cancel"]){
  const {daemon,turn}=logicalTurnDaemon();const generation=turn.arm({chatId:"fixture-room"});
  if(ending==="complete")turn.complete(generation);else turn.cancelByUser();
  expect(await daemon.quiesceClaudeCredential()).toBe(true);expect(daemon.deliveryWritesStopping).toBe(true);
 }
 const {daemon}=logicalTurnDaemon();daemon.paneHost.getPanePid.mockImplementation(async()=>{daemon.deliveryEpoch++;return 123;});
 expect(await daemon.quiesceClaudeCredential()).toBe(false);expect(daemon.deliveryWritesStopping).toBe(false);
});
