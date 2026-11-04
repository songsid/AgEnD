/** Administrator-only moves of one Fleet identity. Provider sessions never cross machines or providers. */
import { z } from "zod";
import type { InstanceConfig } from "./types.js";
import { settingsFingerprint } from "./settings-transaction.js";

export const AgentRuntimeChangeInput = z.object({
  requestId:z.string().uuid(), expectedRevision:z.string().regex(/^[a-f0-9]{64}$/),
  runtime:z.enum(["wsl","windows"]), machineId:z.string().uuid().optional(),
  backend:z.enum(["claude-code","codex","opencode","kiro-cli","antigravity","grok","muse"]),
  model:z.string().max(160).default(""), directory:z.string().max(1024).default(""),
  sandbox:z.enum(["read-only","workspace-write"]).default("read-only"),
  adapter:z.enum(["exec","pane"]).default("exec"), startNewConversation:z.literal(true),
}).strict().superRefine((value,ctx)=>{
  if(value.runtime==="wsl"&&(value.machineId||value.adapter!=="exec"))ctx.addIssue({code:"custom",message:"Choose the Fleet host for a WSL/Linux agent"});
  if(value.runtime==="windows"&&value.adapter==="pane"&&!['codex','claude-code'].includes(value.backend))ctx.addIssue({code:"custom",message:"Persistent Windows terminals support Codex and Claude Code"});
});
export type AgentRuntimeTarget = z.infer<typeof AgentRuntimeChangeInput>;
export interface PreparedAgentRuntime { config:InstanceConfig; discard():void; current?():boolean }
export interface AgentRuntimeChangeHost {
  config(name:string):InstanceConfig|undefined;
  defaults():unknown;
  generation(name:string):unknown;
  epoch(name:string):number;
  backendState?(name:string,backend:string):string|undefined;
  transition<T>(name:string,run:(stop:()=>Promise<void>)=>Promise<T>):Promise<T>;
  /** Must reject busy, queued and unknown source work, including retained native owners. */
  idle(name:string):boolean;
  prepare(name:string,before:InstanceConfig,target:AgentRuntimeTarget,current:()=>boolean):Promise<PreparedAgentRuntime>;
  closed(name:string,before:InstanceConfig):Promise<boolean>;
  /** Prepare fresh-session pointers without erasing provider history; returns a rollback for an unsaved change. */
  fresh(name:string,requestId:string):()=>void;
  save(name:string,before:InstanceConfig,next:InstanceConfig):void;
  changed(name:string):void;
}
export class AgentRuntimeChanges {
  private attempts=new Map<string,{id:string;digest:string;pending:boolean;result:Promise<unknown>}>();
  constructor(private readonly host:AgentRuntimeChangeHost){}
  describe(name:string){
    const config=this.host.config(name);if(!config)throw Error("Agent not found");
    const backend=config.backend||(this.host.defaults() as {backend?:string}|undefined)?.backend||"claude-code";
    return {revision:settingsFingerprint([config,this.host.defaults(),this.host.generation(name),this.host.epoch(name)]),
      runtime:config.runtime==="windows"?"windows":"wsl",machineId:config.machine_id,backend,backendState:this.host.backendState?.(name,backend),
      directory:config.working_directory,model:config.model??"",general:config.general_topic===true||name==="general",adapter:config.native_adapter??"exec",sandbox:config.native_sandbox??"read-only"};
  }
  change(name:string,raw:unknown,authorized:()=>boolean):Promise<unknown>{
    const target=AgentRuntimeChangeInput.parse(raw),digest=settingsFingerprint(target),old=this.attempts.get(name);
    if(!authorized())throw Error("Runtime change requires a current dashboard administrator");
    if(old?.id===target.requestId){if(old.digest!==digest)throw Error("Runtime request ID belongs to another change");return old.result;}
    if(old?.pending)throw Error("A Runtime change is already in progress for this Agent");
    if(this.describe(name).revision!==target.expectedRevision)throw Error("Agent settings changed; reopen Runtime settings before switching");
    // One synchronous claim per Agent before preparation, transition queueing or workspace allocation.
    const attempt={id:target.requestId,digest,pending:true,result:null as unknown as Promise<unknown>};
    this.attempts.set(name,attempt);
    attempt.result=Promise.resolve().then(()=>this.host.transition(name,async stop=>{
      if(this.describe(name).revision!==target.expectedRevision)throw Error("Agent settings changed while waiting to switch Runtime");
      const before=this.host.config(name)!,baseline=settingsFingerprint([this.host.defaults(),this.host.generation(name)]);let epoch=this.host.epoch(name),revoked=false,prepared:PreparedAgentRuntime|undefined;
      const current=()=>{
        if(revoked)return false;
        if(!authorized()||this.host.config(name)!==before||this.host.epoch(name)!==epoch||settingsFingerprint([this.host.defaults(),this.host.generation(name)])!==baseline||!this.host.idle(name)||prepared?.current?.()===false)revoked=true;
        return !revoked;
      };
      if(!current())throw Error("Wait for this Agent and its queued work to finish before switching Runtime");
      if((before.general_topic||name==="general")&&target.runtime==="windows"&&target.adapter!=="pane")throw Error("A General needs a persistent Windows terminal; choose Codex or Claude Code with the terminal adapter");
      let undoSession:(()=>void)|undefined,saved=false;
      try{
        prepared=await this.host.prepare(name,before,target,current);
        if(!current())throw Error("Runtime change was revoked or the Agent became busy during preparation");
        // stop() owns exactly one epoch advance, even for the exec adapter. Any other advance permanently revokes us.
        epoch++;await stop();
        if(!current())throw Error("Runtime change lost its source owner while stopping the old CLI");
        if(!await this.host.closed(name,before))throw Error("The old CLI exit is unconfirmed; Runtime settings were not changed");
        if(!current())throw Error("Runtime change was revoked while checking the old CLI exit");
        if(target.runtime==="wsl")undoSession=this.host.fresh(name,target.requestId);
        if(!current())throw Error("Runtime change authority expired before saving");
        this.host.save(name,before,prepared.config);saved=true;
        this.host.changed(name);
        return {ok:true,name,runtime:target.runtime,machineId:target.machineId,backend:target.backend,started:false,historyPreserved:true};
      }catch(error){
        if(!saved){undoSession?.();prepared?.discard();}
        throw error;
      }
    })).finally(()=>{attempt.pending=false;});
    return attempt.result;
  }
}
