import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, expect, it } from "vitest";
import { Daemon } from "../src/daemon.js";
import { FleetManager } from "../src/fleet-manager.js";
import { ClaudeCredentialVault } from "../src/claude-credential-vault.js";
const cleanup:Array<()=>void>=[];afterEach(()=>{for(const f of cleanup.splice(0).reverse())f();});
const actor={adapterId:"host",userId:"operator"},value="synthetic-"+"x".repeat(48);
function fixture(){
 const home=mkdtempSync(join(tmpdir(),"credential-observation-")),dir=join(home,"instances","helper");mkdirSync(dir,{recursive:true});cleanup.push(()=>rmSync(home,{recursive:true,force:true}));
 const vault=new ClaudeCredentialVault(home);cleanup.push(()=>vault.close());const metadata=vault.write(null,0,{kind:"api-key",value},actor);
 const launch={id:"fixture-launch",startedAt:Date.now()-1000},binding:any={home,profile:null,id:metadata.id,revision:metadata.revision,kind:"api-key"};
 const backend:any={sourceOkay:true,binaryName:"claude",modelObservationLaunch:()=>launch,credentialObservationLaunch:()=>({launch,binding,sourceCurrent:()=>backend.sourceOkay})};
 const daemon:any=new Daemon("helper",{backend:"claude-code",working_directory:home,log_level:"silent"} as any,dir,false,backend,undefined,pino({level:"silent"}) as any);
 const monitor:any=daemon.buildTranscriptMonitor(null);daemon.transcriptMonitor=monitor;
 const frames:string[]=[],fm:any=Object.create(FleetManager.prototype);Object.assign(fm,{dataDir:home,lifecycle:{daemons:new Map([["helper",daemon]])},sseClients:new Set([{write:(text:string)=>frames.push(text)}]),observeWorkingState:()=>{}});fm.listenForWorkingState("helper",daemon);
 const hook=(extra:any={})=>writeFileSync(join(dir,"statusline.json"),JSON.stringify({_agendLaunchId:launch.id,session_id:"fixture-session",transcript_path:join(dir,"fixture-session.jsonl"),...extra}));hook();
 const at=Date.now()-100;
 const record=(extra:any={})=>({type:"assistant",sessionId:"fixture-session",uuid:"fixture-row",timestamp:new Date(at).toISOString(),requestId:"req_fixture",message:{id:"msg_fixture",type:"message",role:"assistant",model:"claude-sonnet-4-5",stop_reason:"end_turn",content:[{type:"text",text:"synthetic response"}],usage:{input_tokens:1,output_tokens:1}},...extra});
 return {home,dir,vault,launch,binding,backend,daemon,monitor,hook,at,record,fm,frames};
}
it("an owned normal request promotes only its active credential revision, with a proof timestamp and no content in the audit",()=>{
 const f=fixture();expect(f.vault.metadata(null)?.state).toBe("saved-unverified");f.monitor.processEntry(f.record());
 expect(f.vault.metadata(null)).toMatchObject({id:f.binding.id,revision:1,state:"verified",verifiedAt:new Date(f.at).toISOString()});
 expect(JSON.stringify(f.vault.history())).not.toContain("synthetic response");expect(JSON.stringify(f.vault.history())).not.toContain("req_fixture");expect(JSON.stringify(f.vault.history())).not.toContain(value);
 const raw=f.vault.credential(null,f.binding.id,1);expect(raw.value.toString()).toBe(value);raw.value.fill(0);
});

it.each([401,403])("owned HTTP %s requests replacement without mutating the credential",status=>{
 const f=fixture();f.monitor.processEntry(f.record());
 f.monitor.processEntry(f.record({uuid:"fixture-auth-error",timestamp:new Date(f.at+1).toISOString(),isApiErrorMessage:true,apiErrorStatus:status,message:{role:"assistant",content:[{type:"text",text:"private provider error"}]}}));
 expect(f.vault.metadata(null)).toMatchObject({state:"needs-replacement",verifiedAt:null,revision:1});
 expect(JSON.stringify(f.vault.history())).not.toContain("private provider error");
});
it("network errors stay unknown; stale/replayed success never recovers them and a fresh normal success does",()=>{
 const f=fixture(),event=(at:number,extra:any={})=>f.record({timestamp:new Date(at).toISOString(),...extra});
 f.monitor.processEntry(event(f.at));
 f.monitor.processEntry(event(f.at+1,{uuid:"fixture-network",isApiErrorMessage:true,message:{role:"assistant",content:"Connection failed"}}));
 expect(f.vault.metadata(null)).toMatchObject({state:"unknown",verifiedAt:null});
 f.monitor.processEntry(event(f.at));expect(f.vault.metadata(null)?.state).toBe("unknown");
 f.monitor.processEntry(event(f.at+2,{requestId:"req_second"}));expect(f.vault.metadata(null)).toMatchObject({state:"verified",verifiedAt:new Date(f.at+2).toISOString()});
 const length=f.vault.history().length;f.monitor.processEntry(event(f.at+3,{requestId:"req_third"}));f.monitor.processEntry(event(f.at+3,{requestId:"req_third"}));expect(f.vault.history()).toHaveLength(length);
});
it("replace/remove/subscription changes reset proof and old request bindings cannot restore it",()=>{
 const f=fixture();f.monitor.processEntry(f.record());
 for(const change of [{kind:"setup-token",value},null,"subscription"] as const){
  const revision=f.vault.metadata(null)!.revision;f.vault.write(null,revision,change,actor);
  expect(f.vault.metadata(null)?.verifiedAt).toBeNull();expect(f.vault.metadata(null)?.state).toBe(change&&change!=="subscription"?"saved-unverified":"not-connected");
  f.monitor.processEntry(f.record({timestamp:new Date(f.at+revision).toISOString(),requestId:"req_late_"+revision}));expect(f.vault.metadata(null)?.verifiedAt).toBeNull();
 }
});
it.each(["launch-hook","session","subagent-path","other-file","old-time","future-time","history","reset","monitor","generation","new-launch","id","revision","kind","profile","subscription","sidechain","meta","agent","missing-request","missing-response","missing-usage","synthetic-model","unfinished","user-text","conflicting-session","error-flag-type","contradictory-error","stopping","startup-aborted","source-changed"])("%s never promotes unowned or insufficient evidence",control=>{
 const f=fixture();let record=f.record();
 switch(control){
  case "source-changed":f.backend.sourceOkay=false;break;
  case "launch-hook":f.hook({_agendLaunchId:"old-launch"});break;
  case "session":f.hook({session_id:"another-session"});break;
  case "subagent-path":f.hook({transcript_path:join(f.dir,"subagents","fixture-session.jsonl")});break;
  case "other-file":f.monitor.transcriptPath=join(f.dir,"another.jsonl");break;
  case "old-time":record.timestamp=new Date(f.launch.startedAt-1).toISOString();break;
  case "future-time":record.timestamp=new Date(Date.now()+60000).toISOString();break;
  case "history":f.monitor.historyBefore=f.at;break;
  case "reset":f.monitor.modelResetAt=f.at;break;
  case "monitor":f.daemon.transcriptMonitor={};break;
  case "generation":f.daemon.launchFenceEpoch++;break;
  case "new-launch":f.backend.credentialObservationLaunch=()=>({launch:{...f.launch,id:"new-launch"},binding:f.binding});break;
  case "id":f.binding.id="different-id";break;
  case "revision":f.binding.revision++;break;
  case "kind":f.binding.kind="setup-token";break;
  case "profile":f.binding.profile="another";break;
  case "subscription":f.binding.kind="subscription";break;
  case "sidechain":record={...record,isSidechain:true} as any;break;
  case "meta":record={...record,isMeta:true} as any;break;
  case "agent":record={...record,agentId:"child"} as any;break;
  case "missing-request":delete (record as any).requestId;break;
  case "missing-response":delete (record.message as any).id;break;
  case "missing-usage":delete (record.message as any).usage;break;
  case "synthetic-model":record.message.model="<synthetic>";break;
  case "unfinished":record.message.stop_reason=null as any;break;
  case "user-text":record.message.role="user";break;
  case "conflicting-session":record={...record,session_id:"another-session"} as any;break;
  case "error-flag-type":record={...record,isApiErrorMessage:"true"} as any;break;
  case "contradictory-error":record={...record,error:"authentication_failed"} as any;break;
  case "stopping":f.daemon.deliveryWritesStopping=true;break;
  case "startup-aborted":f.daemon.startupAborted=true;break;
 }
 f.monitor.processEntry(record);expect(f.vault.metadata(null)).toMatchObject({state:"saved-unverified",verifiedAt:null});expect(f.vault.history()).toHaveLength(1);
});
it("tool-only main responses count; a CLI error is never interpreted as success",()=>{
 const f=fixture();f.monitor.processEntry(f.record({message:{id:"msg_tool",type:"message",role:"assistant",model:"claude-sonnet-4-5",stop_reason:"tool_use",content:[{type:"tool_use",name:"fixture"}],usage:{input_tokens:1,output_tokens:1}}}));expect(f.vault.metadata(null)?.state).toBe("verified");
 f.monitor.processEntry(f.record({uuid:"fixture-error",timestamp:new Date(f.at+1).toISOString(),isApiErrorMessage:true,apiErrorStatus:401}));expect(f.vault.metadata(null)?.state).toBe("needs-replacement");
});

it("an audit failure rolls back status atomically; additive metadata schema keeps old ciphertext readable",()=>{
 const f=fixture();(f.vault as any).db.exec("CREATE TRIGGER fixture_status_audit BEFORE INSERT ON credential_audit WHEN NEW.action='request-status' BEGIN SELECT RAISE(ABORT,'fixture fault');END;");
 f.monitor.processEntry(f.record());expect(f.vault.metadata(null)).toMatchObject({state:"saved-unverified",verifiedAt:null});
 (f.vault as any).db.exec("DROP TRIGGER fixture_status_audit; DROP TABLE credential_request_status;");
 const reopened=new ClaudeCredentialVault(f.home);cleanup.push(()=>reopened.close());expect(reopened.metadata(null)).toMatchObject({state:"saved-unverified",verifiedAt:null});
 f.monitor.processEntry(f.record());expect(reopened.metadata(null)?.state).toBe("verified");
 const raw=reopened.credential(null,f.binding.id,1);expect(raw.value.toString()).toBe(value);raw.value.fill(0);
});
it("the production backend exposes only managed launch references, never legacy/subscription auth",async()=>{
 const {ClaudeCodeBackend}=await import("../src/backend/claude-code.js");const backend:any=Object.create(ClaudeCodeBackend.prototype);
 Object.assign(backend,{observationLaunchId:"fixture-launch",observationStartedAt:100,managedLaunch:undefined});expect(backend.credentialObservationLaunch()).toBeNull();
 backend.managedLaunch={binding:{kind:"subscription"}};expect(backend.credentialObservationLaunch()).toBeNull();
 backend.managedLaunch={sourceCurrent:()=>true,binding:{kind:"api-key",id:"fixture-id",revision:2,profile:"sample",home:"/fixture"}};
 expect(backend.credentialObservationLaunch()).toMatchObject({launch:{id:"fixture-launch",startedAt:100},binding:{kind:"api-key",revision:2,profile:"sample"}});
});

it("only the published Fleet owner writes metadata and streams a payload-free refresh",()=>{
 const f=fixture();f.fm.daemons.delete("helper");f.monitor.processEntry(f.record());expect(f.vault.metadata(null)?.state).toBe("saved-unverified");expect(f.frames).toEqual([]);
 f.fm.daemons.set("helper",f.daemon);f.monitor.processEntry(f.record());expect(f.vault.metadata(null)?.state).toBe("verified");expect(f.frames).toHaveLength(1);expect(f.frames[0]).toContain("event: backend_login");expect(f.frames[0]).not.toContain("req_fixture");expect(f.frames[0]).not.toContain("fixture-session");
 f.monitor.processEntry(f.record());expect(f.frames).toHaveLength(1);
});
