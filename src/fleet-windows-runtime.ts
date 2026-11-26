import {nativeExecContextInputKey,type NativeExecContextReference} from "./native-exec-context.js";
import {claimNativeExecInput,validateNativeExecInputProof,type NativeExecInputClaim} from "./native-exec-input.js";
import type {RequestContextExecOwner,RequestContextExecInput} from "./request-context-exec-owner.js";
import { runWithRequestContextAdmission, type RequestContextAdmissionPort } from "./request-context-admission.js";
import { RequestContextReferenceMap, type RequestContextRegistrationGate } from "./request-context-fence.js";
/** Windows execution adapter for the ordinary Fleet instance registry and delivery facade. */
import { OPERATIONS_MAX_CHARS } from "./instructions.js";
import { addsSecondGeneral } from "./web-only-fleet.js";
import { formatHumanInboundMessage } from "./human-delivery-receipts.js";
import { randomUUID } from "node:crypto";
import type { FleetConfig, InstanceConfig } from "./types.js";
import { windowsAgentExecutionTask, windowsAgentsFor, type WindowsAgent, type WindowsAgents } from "./windows-agents.js";
import { LOCAL_WINDOWS_CLI_OFF, windowsBridgeFor, windowsCliEnabled, type WindowsCliExecutor, type WindowsCliTask } from "./windows-cli.js";
import { localWindowsCliEnabled, remoteRuntimeEnabled } from "./runtime-switches.js";

/** M-2255: the switch for where this agent runs — this PC's Windows CLIs, or the other Windows computers. */
const switchedOn = (agent: { machineId?: string }): boolean => agent.machineId ? remoteRuntimeEnabled() : localWindowsCliEnabled();
import { isWindowsInstance, isNativeExecInstance, nativeAgentId, nativeCredentialProfile, nativeInstanceConfig, nativeInstanceName, registerWindowsProfiles, previewWindowsProfile, syncWindowsProfile } from "./native-instance-registry.js";
import { PROFILE_CLI_NAMES, assertCredentialProfileName, isCredentialProfileCli } from "./runtime-credential-profiles.js";
import { validWindowsAgentId } from "./windows-cli-worker.js";
import type { NativeHistoryMessage, WebChatHistory } from "./web-chat-history.js";
import type { SettingsExecution } from "./settings-transaction.js";
import type { NativeMcpLease } from "./native-mcp.js";
import { nativeProviderMcpSupported } from "./windows-cli-providers.js";
import type { AgentRuntimeTarget, PreparedAgentRuntime } from "./agent-runtime-change.js";
import { captureRequestContextCall, type RequestContextCallLease } from "./request-context-call.js";
import {requestContextDigest} from "./request-context-store.js";
import { deliveryContentDigest } from "./delivery-outbox.js";
import { RequestContextInputDeferred, type RequestContextLocalTurns, type RequestContextRuntimeOwner } from "./request-context-turns.js";

export interface FleetWindowsRuntimeHost {
  owner: object & { dataDir?: string };
  fleet(): FleetConfig | null;
  save(): void;
  emit(event: string, data: unknown): void;
  stopping(): boolean;
  requestContextAdmission?(): RequestContextAdmissionPort | undefined;
  history?: Pick<WebChatHistory,"findByMessageId"> & Partial<Pick<WebChatHistory,"reconcileNativeMessages" | "findByNativeHistoryId">>;
  openMcp?(instance: string, requestId: string, sandbox: WindowsAgent["sandbox"], stillCurrent: () => boolean, requestContext?: RequestContextCallLease, inputReady?:()=>Promise<boolean>): NativeMcpLease | null;
  /** One projector for live completion and history import. No latest-chat or current-speaker fallback. */
  projectRequestContextOutput?(instance:string,task:NativeExecutionResult,completion:ReturnType<FleetWindowsRuntime["requestContextCompletion"]>):Pick<NativeHistoryMessage,"replyTo"|"requestProvenance">|null;
  warn?(message: string,error: unknown): void;
  removed?(name: string,config: InstanceConfig): void;
  machineAvailable?(machineId: string): boolean;
  paneCurrent?(name: string): boolean;
  /** `credentialProfile`: also refuses a Runtime that cannot honour it, a name that computer never reported, and one it reports as signed out. */
  validateMachine?(machineId: string, cli: string, sandbox?: unknown, credentialProfile?: string): void;
  machineGeneration?(machineId:string):string|null;
  paneAvailable?(machineId:string):boolean;
}
export interface NativeRuntimeDeliveryOptions {
  /** Internal admitted-input key; never selected from a model's payload or correlation id. */
  requestContextInputId?: string;
  /** The handoff fence: checked before the turn is journaled (it may include the sending request's own lifetime). */
  stillCurrent?: () => boolean;
  /**
   * The sender's authority after the handoff — rechecked by the bridge before the Windows process is spawned and by the
   * turn's MCP lease. It must not depend on the sending HTTP request still being open (that request is answered once
   * the turn is journaled). Defaults to stillCurrent.
   */
  authorityCurrent?: () => boolean;
  /** A durable outbox fences its attempt immediately before the native task is claimed. */
  beforeStart?: () => void;
}
export type NativeRuntimePatch = Pick<InstanceConfig,"display_name"|"description"|"systemPrompt"|"operations"|"model"|"working_directory"|"native_sandbox"|"tags">;
export type NativeExecutionResult = WindowsCliTask & {reportedCorrelationIds?: readonly string[]};

export class FleetWindowsRuntime {
  private retired=false;
  private preparations=0;
  private settling=0;
  requestContextPhysicallyIdle():boolean{return !this.preparations&&!this.settling&&!this.mcpLeases.size&&!this.requestContextRuns.size&&!this.store.requestContextActiveExecutions().length&&this.bridge.idleForRequestContext?.()===true;}
  retireForRequestContext():void {
    if(!this.requestContextPhysicallyIdle())throw Error("Native conversations are not physically retired");
    this.retired=true;
  }
  private async prepareFactory<T>(operation:()=>Promise<T>):Promise<T>{
    this.enabled();this.preparations++;try{return await operation();}finally{this.preparations--;}
  }
  private hasClaimed = false;
  private readonly requestContextRuns = new RequestContextReferenceMap<string, { requestId: string; rootContextId:string; retire(): void }>(run=>run.rootContextId,run=>`exec-run:${run.requestId}`);
  private requestContextLifecycle?: { turns(instance: string): RequestContextLocalTurns; owner(instance: string): RequestContextRuntimeOwner; prepare?: (instance:string,...args:Parameters<RequestContextExecOwner["prepare"]>)=>RequestContextExecInput };
  /** Uninstalled in production until L. The lane owner is stable across exec claims, not the new run id. */
  setRequestContextExecLifecycle(turns: RequestContextLocalTurns, owner: (instance: string) => RequestContextRuntimeOwner): void {
    if (this.retired || this.requestContextLifecycle || this.hasClaimed || this.mcpLeases.size) throw Error("Native request context must be installed before claims");
    this.requestContextRuns.installRegistration(turns.registrationGate??undefined);
    this.requestContextLifecycle = { turns: () => turns, owner };
  }
  /** Whole-Fleet installation uses distinct C lanes per instance, all owned by the same drain registration. */
  setRequestContextExecLifecycles(turnsOf: (instance: string) => RequestContextLocalTurns,
    owner: (instance: string) => RequestContextRuntimeOwner, registration: RequestContextRegistrationGate,
    prepare?: (instance:string,...args:Parameters<RequestContextExecOwner["prepare"]>)=>RequestContextExecInput): void {
    if (this.retired || this.requestContextLifecycle || this.hasClaimed || this.mcpLeases.size) throw Error("Native request context must be installed before claims");
    this.requestContextRuns.installRegistration(registration);
    const lanes = new Map<string, RequestContextLocalTurns>();
    this.requestContextLifecycle = { owner, ...(prepare?{prepare}:{}), turns: instance => {
      const turns = turnsOf(instance), previous = lanes.get(instance);
      if (turns.registrationGate !== registration || previous && previous !== turns
        || [...lanes].some(([other, lane]) => other !== instance && lane === turns)) throw Error("Native request context lane differs");
      lanes.set(instance, turns); return turns;
    } };
  }
  requestContextCallsRequired(name:string):boolean{return !!this.requestContextLifecycle&&isNativeExecInstance(this.config(name));}
  /** Exact server-owned completion evidence remains readable after its C turn ended. */
  requestContextCompletion(name:string,requestId:string,inputId?:string){
    const lifecycle=this.requestContextLifecycle;
    if(this.retired||!lifecycle?.prepare||this.host.stopping()||!isNativeExecInstance(this.config(name)))throw Error("Native scoped completion is unavailable");
    const agentId=this.id(name),owner=Object.freeze(structuredClone(lifecycle.owner(name))),reference=this.store.requestExecContext(agentId,requestId);
    if(!reference||reference.instance!==name||reference.incarnation!==owner.incarnation||inputId!==undefined&&reference.inputId!==inputId)throw Error("Native run belongs to another admitted input");
    const inputKey=nativeExecContextInputKey(reference),claim=this.store.requestExecInput(agentId,requestId,inputKey);
    if(!claim||owner.instance!==name)throw Error("Native scoped completion is unavailable");
    const image=requestContextDigest({claim,owner,reference});
    const current=()=>{try{return !this.host.stopping()&&this.requestContextLifecycle===lifecycle&&this.id(name)===agentId&&requestContextDigest({claim:this.store.requestExecInput(agentId,requestId,inputKey),owner:lifecycle.owner(name),reference:this.store.requestExecContext(agentId,requestId)})===image;}catch{return false;}};
    return Object.freeze({claim,owner,reference,current});
  }
  get drainRevision():string{return `${this.requestContextRuns.revision}:${this.store.requestContextDrainRevision}`;}
  drainView(rootId:string){
    const view=this.requestContextRuns.view(rootId),runs=[...this.requestContextRuns.values()];
    const unknown=this.store.requestContextActiveExecutions().some(active=>!runs.some(run=>run.requestId===active.requestId));
    return {...view,revision:this.drainRevision,unknown:view.unknown||unknown};
  }
  private readonly mcpLeases = new Map<string,{requestId:string;lease:NativeMcpLease}>();
  private readonly store: WindowsAgents;
  private readonly bridge: WindowsCliExecutor;
  constructor(private readonly host: FleetWindowsRuntimeHost, deps: {store?:WindowsAgents;bridge?:WindowsCliExecutor} = {}) {
    this.bridge = deps.bridge ?? windowsBridgeFor(host.owner);
    this.store = deps.store ?? windowsAgentsFor(host.owner,this.bridge);
  }
  private config(name: string): InstanceConfig | null { return this.host.fleet()?.instances[name] ?? null; }
  has(name: string): boolean { return isWindowsInstance(this.config(name)); }
  busy(name?: string): boolean { return this.bridge.hasActiveTask(name ? this.config(name)?.machine_id : undefined); }
  private id(name: string): string {
    const id = nativeAgentId(this.config(name));
    if (!id) throw new Error("Instance does not name a valid Windows runtime agent");
    return id;
  }
  private enabled(): void { if(this.retired)throw Error("Native conversation factory is retired");if (!windowsCliEnabled()) throw new Error("Windows runtime is disabled"); }
  private closeMcp(name: string): void {
    const active=this.mcpLeases.get(name);
    this.mcpLeases.delete(name);
    active?.lease.close();
  }
  private changed(name?: string): void {
    if (name) this.host.emit("activity",{instance:name,state:this.execution(name)});
    this.host.emit("status",this.statusFrame());
  }
  /** The host replaces this lightweight signal with the complete shared status frame. */
  private statusFrame(): {runtimeChanged:true} { return {runtimeChanged:true}; }
  register(): boolean {
    if(this.retired)throw Error("Native conversation factory is retired");
    const fleet = this.host.fleet();
    return !!fleet && windowsCliEnabled() && registerWindowsProfiles(fleet,this.store,this.host.save);
  }
  /** Reconcile the exact recovered run on both status reads and the direct durable execute/claim lane. */
  private retireRecoveredRequestContext(name: string, agent: Pick<WindowsAgent, "activeId">): void {
    const run = this.requestContextRuns.get(name);
    if (run && agent.activeId !== run.requestId) {
      const recovered = this.bridge.get(run.requestId);
      if (recovered?.finishedAt && recovered.outcomeConfirmed === true) { run.retire(); this.requestContextRuns.delete(name); }
    }
  }
  get(name: string): (WindowsAgent & {blocked:boolean}) | null {
    if(this.retired)throw Error("Native conversation factory is retired");
    const config = this.config(name);
    if (!isWindowsInstance(config)) return null;
    const agent = this.store.get(this.id(name));
    this.retireRecoveredRequestContext(name, agent);
    if (config.machine_id !== agent.machineId) throw new Error("The instance machine does not match its saved conversation");
    const blocked = config.native_adapter === "pane" && agent.paneLaunchId ? this.host.paneCurrent?.(name) !== true : agent.blocked;
    return {...agent,blocked,name:config.display_name ?? agent.name,description:config.description ?? "",instructions:config.systemPrompt ?? "",cwd:config.working_directory,model:config.model || undefined,sandbox:config.native_sandbox ?? agent.sandbox};
  }
  status(name: string): "running"|"paused"|"stopped"|"crashed" {
    let agent:ReturnType<FleetWindowsRuntime["get"]>;
    try { agent=this.get(name); } catch { return "crashed"; }
    if (!agent || !switchedOn(agent)) return "stopped";
    return agent.blocked ? "crashed" : agent.paused ? "paused" : "running";
  }
  execution(name: string): "working"|"idle"|null {
    let agent:ReturnType<FleetWindowsRuntime["get"]>;
    try { agent=this.get(name); } catch { return null; }
    return !agent || agent.paused || agent.blocked || !switchedOn(agent) ? null : agent.activeId ? "working" : "idle";
  }
  /** Prepare a separate, pre-bound profile. The old conversation remains intact; startup cannot import an orphan. */
  prepareRuntimeChange(name:string,before:InstanceConfig,target:AgentRuntimeTarget,current:()=>boolean):Promise<PreparedAgentRuntime>{return this.prepareFactory(()=>this.prepareRuntimeChangeOwned(name,before,target,current));}
  private async prepareRuntimeChangeOwned(name:string,before:InstanceConfig,target:AgentRuntimeTarget,current:()=>boolean):Promise<PreparedAgentRuntime>{
    const identity=target.machineId?this.host.machineGeneration?.(target.machineId):undefined;let revoked=false;
    const targetCurrent=()=>{
      if(revoked||this.retired)return false;
      try{
      if(target.machineId){if(!remoteRuntimeEnabled()||!this.host.validateMachine)throw Error("Remote runtime is disabled");this.host.validateMachine(target.machineId,target.backend,target.sandbox,target.credentialProfile);}
      else if(!localWindowsCliEnabled())throw Error(LOCAL_WINDOWS_CLI_OFF);
      if(target.credentialProfile&&!target.machineId)throw Error("A credential profile is a sign-in kept on a paired Runtime computer");
      if(target.machineId&&this.host.machineGeneration&&(!identity||this.host.machineGeneration(target.machineId)!==identity))throw Error("Runtime connection changed");
      if(target.machineId&&target.adapter==="pane"&&this.host.paneAvailable?.(target.machineId)===false)throw Error("This Runtime does not support persistent terminals; update it before switching");
      return true;
      }catch{revoked=true;return false;}
    };
    // The profile checks say what to do next (sign in there, update the Runtime); the generic race check below would swallow them.
    if(target.credentialProfile&&target.machineId)this.host.validateMachine?.(target.machineId,target.backend,target.sandbox,target.credentialProfile);
    const validate=()=>{if(!current()||!targetCurrent())throw Error("Selected Runtime is unavailable or changed during the operation");};validate();
    if(!target.machineId){
      const inventory=await this.bridge.probe({force:false});validate();
      if(!inventory.clis.some(cli=>cli.id===target.backend&&cli.runnable&&cli.supports.resume))throw Error("Choose an available CLI on the selected Windows computer");
    }
    const agent=await this.store.create({name:before.display_name||name,cli:target.backend,model:target.model,
      ...(target.directory.trim()?{cwd:target.directory.trim()}:{}),...(target.machineId?{machineId:target.machineId}:{}),
      sandbox:target.sandbox,description:before.description??"",instructions:before.systemPrompt??""},()=>{try{validate();return true;}catch{return false;}},{instance:name});
    const discard=()=>{this.store.remove(agent.id);};
    try{validate();if(target.adapter==="pane")this.store.setPaused(agent.id,false);
      const config:InstanceConfig={...before,runtime:"windows",native_agent_id:agent.id,native_adapter:target.adapter,
      native_sandbox:agent.sandbox,working_directory:agent.cwd,backend:agent.cli,model:agent.model||"",agent_mode:"cli"};
      if(agent.machineId)config.machine_id=agent.machineId;else delete config.machine_id;
      // A Windows Agent has no Linux shell hook and no Linux credential home; #3036's General move drops the same three fields. The one thing
      // that does carry over is a NAME the target computer resolves itself: the credential profile of the agent's own CLI (Claude Code's, Antigravity's) on a paired Runtime.
      for(const key of ["backend_options","credential_profile","pre_task_command"] as const)delete (config as unknown as Record<string,unknown>)[key];
      if(target.credentialProfile)config.backend_options={[agent.cli]:{credential_profile:assertCredentialProfileName(target.credentialProfile)}};
      nativeCredentialProfile(config);
      if(before.backend!==target.backend)config.model_failover=[];
      return {config,discard,current:targetCurrent};}
    catch(error){discard();throw error;}
  }
  available(name: string): boolean {
    let agent:ReturnType<FleetWindowsRuntime["get"]>;
    try { agent=this.get(name); } catch { return false; }
    return !!agent && switchedOn(agent) && !this.host.stopping() && !agent.blocked && !agent.paused
      && (!agent.machineId || this.host.machineAvailable?.(agent.machineId) === true)
      && !this.bridge.hasActiveTask(agent.machineId);
  }
  create(input: Record<string,unknown>, authorized: () => boolean, transaction?:Pick<SettingsExecution,"mutate"|"complete">,binding?:{native_adapter:"pane";topic_id?:number|string;channel_id?:string}): Promise<{name:string;runtime:"windows";agent:WindowsAgent}> {return this.prepareFactory(()=>this.createOwned(input,()=>!this.retired&&authorized(),transaction,binding));}
  private async createOwned(input: Record<string,unknown>, authorized: () => boolean, transaction?:Pick<SettingsExecution,"mutate"|"complete">,binding?:{native_adapter:"pane";topic_id?:number|string;channel_id?:string}): Promise<{name:string;runtime:"windows";agent:WindowsAgent}> {
    this.enabled();
    const fleet = this.host.fleet();
    if (!fleet) throw new Error("Fleet configuration is unavailable");
    // #3021 review: a Windows agent inherits the defaults too — never a second General on a fleet with no chat connection.
    if (addsSecondGeneral(fleet as never)) throw new Error("one_general: this fleet already has its General, and a new agent would inherit defaults.general_topic: true");
    const {tags,credentialProfile,...profile} = input;
    if (credentialProfile !== undefined) {
      if (profile.machineId === undefined || !isCredentialProfileCli(profile.cli)) throw new Error(`A credential profile is a ${PROFILE_CLI_NAMES()} sign-in kept on a paired Runtime computer; choose that computer and ${PROFILE_CLI_NAMES()}`);
      assertCredentialProfileName(credentialProfile);
    }
    if (profile.machineId !== undefined) {
      if (typeof profile.machineId !== "string" || !this.host.validateMachine) throw new Error("Remote runtime is not enabled");
      this.host.validateMachine(profile.machineId,String(profile.cli ?? "codex"),profile.sandbox,credentialProfile as string|undefined);
    } else if (!localWindowsCliEnabled()) throw new Error(LOCAL_WINDOWS_CLI_OFF);   // M-2255: refused before anything is made
    const agent = await this.store.create(profile,authorized), name = nativeInstanceName(agent.id), before=fleet.instances[name];
    try {
      const persist=()=>{
        if (!authorized()) throw new Error("Authorization expired");
        if (Object.hasOwn(fleet.instances,name)) throw new Error("Instance name already exists");
        // #3021 review r2: asked again at the commit, after the profile's await — a create made meanwhile counts.
        if (addsSecondGeneral(fleet as never)) throw new Error("one_general: this fleet already has its General, and a new agent would inherit defaults.general_topic: true");
        fleet.instances[name] = {...nativeInstanceConfig(agent),...binding,...(Array.isArray(tags) ? {tags:tags as string[]} : {}),
          ...(credentialProfile ? {backend_options:{[agent.cli]:{credential_profile:credentialProfile as string}}} : {})};
        this.host.save();
      };
      if(transaction)transaction.mutate(persist);else persist();
    } catch(error) { if(before)fleet.instances[name]=before;else delete fleet.instances[name];this.store.remove(agent.id);throw error; }
    // Fleet configuration is the identity commit point. A crash before this best-effort backlink must leave
    // an unbound profile that startup can repair, never a bound-but-unregistered conversation.
    try { this.store.bindInstance(agent.id,name); }
    catch(error) { this.host.warn?.("Windows profile backlink will be repaired on the next registration",error); }
    transaction?.complete();
    this.changed(name);
    return {name,runtime:"windows",agent};
  }
  previewUpdate(name: string, patch: Partial<NativeRuntimePatch>): WindowsAgent {
    if(!patch||typeof patch!=="object"||Array.isArray(patch)||Object.keys(patch).some(key=>!["display_name","description","systemPrompt","operations","model","working_directory","native_sandbox","tags"].includes(key)))throw Error("Unknown Windows instance setting");
    // M-3522: context text only, stored as it is (the instructions carry it); its shape is still checked here.
    if(Object.hasOwn(patch,"operations")&&patch.operations!==undefined&&(typeof patch.operations!=="string"||patch.operations.length>OPERATIONS_MAX_CHARS))throw Error("Invalid Windows instance operations text");
    if(Object.hasOwn(patch,"tags")&&(!Array.isArray(patch.tags)||patch.tags.length>32||patch.tags.some(tag=>typeof tag!=="string"||!tag||tag.length>64)))throw Error("Invalid Windows instance tags");
    this.enabled();const before=this.config(name);if(!before||!this.has(name))throw Error("Windows instance not found");
    return previewWindowsProfile({...before,...patch},this.store);
  }
  update(name: string, patch: Partial<NativeRuntimePatch>, authorized: () => boolean, transaction?:Pick<SettingsExecution,"mutate"|"complete">): {name:string;agent:WindowsAgent} {
    this.enabled();
    const fleet = this.host.fleet(), before = this.config(name);
    if (!fleet || !before || !this.has(name)) throw new Error("Windows instance not found");
    const id = this.id(name), old = this.store.get(id);
    const checked=this.previewUpdate(name,patch);
    const next = {...before,...structuredClone(patch)};
    // M-3522: an emptied "Owner and routine operations" leaves no key behind.
    if(Object.hasOwn(patch,"operations")&&!(patch.operations??"").trim())delete (next as Record<string,unknown>).operations;
    // Persist the provider validator's canonical values as well as the profile: launch ownership compares both.
    const fields={display_name:"name",description:"description",systemPrompt:"instructions",model:"model",working_directory:"cwd",native_sandbox:"sandbox"} as const;
    for(const field of Object.keys(fields) as Array<keyof typeof fields>)if(Object.hasOwn(patch,field))(next as Record<string,unknown>)[field]=checked[fields[field]]??"";
    const updated = syncWindowsProfile(next,this.store,authorized);
    // #2942: a settings execution (an agent's confirmed request) writes through its transaction, like create does.
    const write=()=>{ if (!authorized()) throw new Error("Authorization expired"); fleet.instances[name] = next; this.host.save(); };
    try { if (transaction) transaction.mutate(write); else write(); }
    catch(error) {
      fleet.instances[name] = before;
      this.store.update(id,{name:old.name,cwd:old.cwd,description:old.description,instructions:old.instructions,model:old.model ?? "",cli:old.cli,sandbox:old.sandbox});
      throw error;
    }
    transaction?.complete();
    this.changed(name); return {name,agent:updated};
  }
  remove(name: string, authorized: () => boolean, transaction?:Pick<SettingsExecution,"mutate"|"complete">): void {
    this.enabled();
    const fleet = this.host.fleet(), before = this.config(name);
    if (!fleet || !before || !this.has(name)) throw new Error("Windows instance not found");
    const id=this.id(name), teams=structuredClone(fleet.teams), snapshot=this.store.remove(id,authorized);
    try {
      const persist=()=>{
        if (!authorized()) throw new Error("Authorization expired");
        delete fleet.instances[name];
        for(const [key,team] of Object.entries(fleet.teams ?? {})) {
          team.members=team.members.filter(member=>member!==name);
          if(!team.members.length)delete fleet.teams![key];
        }
        this.host.save();
      };
      if(transaction)transaction.mutate(persist);else persist();
    }
    catch(error) { fleet.instances[name]=before;fleet.teams=teams;this.store.restore(snapshot);throw error; }
    transaction?.complete();
    this.closeMcp(name);
    try { this.host.removed?.(name,before); } catch(error) { this.host.warn?.("Windows instance was removed but some shared metadata cleanup needs attention",error); }
    this.changed();
  }
  setPaused(name: string, paused: boolean): void {
    this.enabled();
    this.store.setPaused(this.id(name),paused);
    if (paused) { this.closeMcp(name);this.store.cancel(this.id(name)); }
    this.changed(name);
  }
  cancel(name: string): WindowsCliTask | null { this.enabled();this.closeMcp(name);const result=this.store.cancel(this.id(name));this.changed(name);return result; }
  recover(name: string, confirmedStopped: unknown): WindowsAgent & {blocked:boolean} {
    this.enabled();const result=this.store.recover(this.id(name),confirmedStopped);this.changed(name);return result;
  }
  recoverAsync(name:string,confirmedStopped:unknown):Promise<WindowsAgent & {blocked:boolean}> {return this.prepareFactory(()=>this.recoverAsyncOwned(name,confirmedStopped));}
  private async recoverAsyncOwned(name:string,confirmedStopped:unknown):Promise<WindowsAgent & {blocked:boolean}> {
    const agent=this.get(name);
    if(!agent?.machineId)return this.recover(name,confirmedStopped);
    if(confirmedStopped!==true || !agent.activeId || !agent.blocked)throw new Error("Confirm the remote execution stopped before recovery");
    const bridge=this.bridge as WindowsCliExecutor & {recoverRemote?(machineId:string,id:string):Promise<WindowsCliTask>};
    if(!bridge.recoverRemote)throw new Error("Remote recovery is unavailable");
    await bridge.recoverRemote(agent.machineId,agent.activeId);
    const result=this.get(name)!;this.changed(name);return result;
  }
  private scopedOutput(name:string,agent:Pick<WindowsAgent,"id"|"name">,task:NativeExecutionResult):NativeHistoryMessage|null {
    if(!task.finishedAt||task.outcomeConfirmed!==true||!task.execInputProof)return null;
    const completion=this.requestContextCompletion(name,task.id);
    validateNativeExecInputProof(task.execInputProof,completion.claim);
    const projection=this.host.projectRequestContextOutput?.(name,task,completion);
    if(!projection||!completion.current())return null;
    return {messageId:`native:${task.id}:reply`,role:task.status==="completed"?"agent":"status",sender:this.config(name)?.display_name||agent.name,
      text:task.status==="completed"?task.output||"(No text output)":[task.output,task.error||task.status].filter(Boolean).join("\n"),ts:new Date(task.finishedAt).toISOString(),...projection};
  }
  /** Idempotently bring existing native conversations into shared chat history and search. */
  importHistory(instance?:string): void {
    if (this.retired||!this.host.history) return;
    for (const [name,config] of Object.entries(this.host.fleet()?.instances ?? {})) {
      if(instance&&name!==instance)continue;
      if (!isWindowsInstance(config)) continue;
      const agent=this.store.get(this.id(name));
      const expected: NativeHistoryMessage[]=[];
      for (const turn of agent.turns) {
        if(this.store.requestExecInput(agent.id,turn.id)){
          try{const task=this.store.requestExecCompletion(agent.id,turn.id)??this.bridge.get(turn.id),projected=task&&this.scopedOutput(name,agent,task);if(projected)expected.push(projected);}catch(error){this.host.warn?.("Native scoped output remains unresolved",error);}
          continue; // Its accepted input already owns the original human/peer history row.
        }
        const userId=`native:${turn.id}:user`, replyId=`native:${turn.id}:reply`;
        expected.push({role:"user",sender:"You",text:turn.prompt,ts:new Date(turn.startedAt).toISOString(),messageId:userId});
        if (turn.finishedAt) expected.push({role:turn.status === "completed" ? "agent" : "status",sender:agent.name,text:turn.output || turn.error || turn.status,ts:new Date(turn.finishedAt).toISOString(),messageId:replyId});
      }
      this.host.history.reconcileNativeMessages?.(name,expected);
      for (const message of expected) if (!(this.host.history.findByNativeHistoryId?.(name,message.messageId) ?? this.host.history.findByMessageId(name,message.messageId))) this.host.emit("message",{instance:name,...message});
    }
  }
  private claim(name: string, payload: Record<string,unknown>, options: NativeRuntimeDeliveryOptions, settled: (task:NativeExecutionResult)=>void): WindowsCliTask | import("./windows-agents.js").WindowsTurn {
    this.enabled();
    if (this.host.requestContextAdmission?.()?.available() === false) throw new RequestContextInputDeferred();
    this.hasClaimed = true;
    if (this.host.stopping() || options.stillCurrent?.() === false) throw new Error("Windows delivery is no longer current");
    const config=this.config(name);
    if (!config || !this.has(name)) throw new Error("Windows instance not found");
    if (!isNativeExecInstance(config)) throw new Error("Persistent native panes use the ordinary daemon delivery path");
    const agent=syncWindowsProfile(config,this.store);
    this.retireRecoveredRequestContext(name, agent);
    if(!switchedOn(agent))throw new Error(agent.machineId ? "Other Windows computers are turned off. Turn them on in Settings → Runtime." : LOCAL_WINDOWS_CLI_OFF);
    if(agent.machineId && this.host.machineAvailable?.(agent.machineId)!==true)throw new Error("This runtime machine is offline. Reconnect it before sending a message.");
    // Fail closed before anything is journaled: a malformed profile never becomes "run on the computer's own account".
    const credentialProfile=nativeCredentialProfile(config);
    const raw = typeof payload.content === "string" ? payload.content : typeof payload.text === "string" ? payload.text
      : payload.payload && typeof payload.payload === "object" ? (payload.payload as {message?:unknown}).message : undefined;
    if (typeof raw !== "string" || !raw.trim()) throw new Error("Windows delivery needs a text message");
    if (["raw_paste","steer"].includes(String(payload.type))) throw new Error("This Windows runtime supports messages, not terminal input or steering");
    const requestId=validWindowsAgentId(payload.requestId) ? payload.requestId : randomUUID();
    const meta=payload.meta && typeof payload.meta === "object" ? payload.meta as Record<string,unknown> : {};
    const prompt=meta.source === "app" ? formatHumanInboundMessage(raw,{source:"app"},"mcp") : raw;
    const authority=options.authorityCurrent ?? options.stillCurrent;
    const existing=agent.turns.some(turn=>turn.id===requestId);
    const contextText=[
      `Your AgEnD instance is ${name}. AgEnD tools query Fleet agents, tasks and delivery receipts. ${agent.sandbox === "read-only" ? "This turn permits queries only; delegation and task changes are unavailable." : "Send/delegate tools enqueue work and return a receipt; do not wait for another Windows agent while holding this turn."}`,
      ...(typeof meta.from_instance === "string" ? [`Incoming Fleet context: ${JSON.stringify({from_instance:meta.from_instance.slice(0,128),correlation_id:typeof meta.correlation_id === "string" ? meta.correlation_id.slice(0,256) : undefined,requires_reply:meta.requires_reply === "true"})}`] : []),
    ].join("\n");
    const preparedLifecycle=this.requestContextLifecycle?.prepare;
    let inputFrame:RequestContextExecInput|undefined,execInput:Readonly<NativeExecInputClaim>|undefined,inputKey:string|undefined,contextReference:Readonly<NativeExecContextReference>|undefined;
    if(preparedLifecycle){
      if(!nativeProviderMcpSupported(agent.cli)||!this.host.openMcp)throw Error("Native request tools are unavailable");
      inputKey=requestContextDigest([name,this.requestContextLifecycle!.owner(name).incarnation,options.requestContextInputId??null]);
      if(existing){contextReference=this.store.requestExecContext(agent.id,requestId)??undefined;execInput=this.store.requestExecInput(agent.id,requestId,inputKey)??undefined;if(!execInput)throw Error("Native legacy turn cannot acquire request scope");}
      else{
        if(agent.activeId)throw new RequestContextInputDeferred();
        const task=windowsAgentExecutionTask(agent,requestId,prompt),inputOptions={context:contextText,resumeSessionId:agent.threadId};
        execInput=claimNativeExecInput(task,inputOptions);
        inputFrame=preparedLifecycle(name,options.requestContextInputId??null,task,inputOptions,execInput);
      }
    }
    let requestContext: RequestContextCallLease | undefined;
    let retireContext = (): void => {};
    if (!existing && this.requestContextLifecycle) {
      // Even a valid return cannot replace a still-running exec grant. Queue it before touching C or the lease.
      if (agent.activeId) throw new RequestContextInputDeferred();
      const { owner: ownerOf } = this.requestContextLifecycle, owner = ownerOf(name), turns = this.requestContextLifecycle.turns(name);
      if (owner.instance !== name) throw Error("Native request context owner differs");
      const previous = turns.current(owner);
      // Resolve the admitted input with C's exact parent/actor/wire checks BEFORE retiring any old grant.
      let snapshot:import("./request-context-turns.js").RequestContextTurnSnapshot;
      try{snapshot = turns.beforeWrite(inputFrame?.inputId ?? options.requestContextInputId ?? null, inputFrame?.wireSha256??deliveryContentDigest(prompt), owner);inputFrame?.bind(snapshot);}
      catch(error){inputFrame?.finish();throw error;}
      if(inputFrame)contextReference=Object.freeze({version:1,inputId:options.requestContextInputId??null,instance:name,incarnation:owner.incarnation,contextId:snapshot.context.ref.contextId,rootContextId:snapshot.context.ref.rootContextId});
      retireContext = () => {
        inputFrame?.finish();
        if (snapshot !== previous) turns.ended(snapshot, owner);
        if (this.requestContextRuns.get(name)?.requestId === requestId) this.requestContextRuns.delete(name);
      };
      try { this.requestContextRuns.set(name, { requestId, rootContextId:snapshot.context.ref.rootContextId,retire: retireContext });
        requestContext = captureRequestContextCall(snapshot, captured => turns.isCurrent(captured, ownerOf(name))); }
      catch (error) { retireContext(); throw error; }
    }
    try { options.beforeStart?.(); } catch (error) { retireContext(); throw error; }
    let lease:NativeMcpLease|null=null;
    try {
    if (!existing && nativeProviderMcpSupported(agent.cli) && this.host.openMcp) {
      this.closeMcp(name);
      const current=()=>{
        if (this.host.stopping() || !switchedOn(agent) || authority?.() === false
          || agent.machineId && this.host.machineAvailable?.(agent.machineId) !== true) return false;
        try { const current=this.get(name);return !!current && current.activeId===requestId && !current.paused && !current.blocked; }
        catch { return false; }
      };
      lease=requestContext ? this.host.openMcp(name,requestId,agent.sandbox,current,requestContext,inputFrame?.inputReady)
        : this.host.openMcp(name,requestId,agent.sandbox,current);
      if (lease) this.mcpLeases.set(name,{requestId,lease});
      else if(inputFrame)throw Error("Native request tools are unavailable");
    }
    } catch (error) { retireContext(); throw error; }
    const closeLease=()=>{if(lease){lease.close();if(this.mcpLeases.get(name)?.lease===lease)this.mcpLeases.delete(name);}};
    const context=lease ? contextText : existing&&execInput?contextText:undefined;
    let task:ReturnType<WindowsAgents["send"]>;
    try { task=this.store.send(agent.id,{requestId,prompt},()=>!this.host.stopping() && authority?.() !== false,{...(lease ? {mcp:lease.connection} : {}),...(context?{context}:{}),...(credentialProfile ? {credentialProfile} : {}),...(execInput?{execInput,...(inputKey?{requestContextInputKey:inputKey}:{}),...(contextReference?{requestContextReference:contextReference}:{}),onInputWritten:inputFrame?inputFrame.written:()=>{throw Error("Retired native input cannot be written again");}}:{}),onSettled:task=>{
      this.settling++;try{
      const reportedCorrelationIds=lease?.reportedCorrelations(typeof meta.from_instance === "string" ? meta.from_instance : undefined) ?? [];
      closeLease();inputFrame?.finish();
      // A confirmed run end is terminal. An uncertain native outcome is not proof that work ended.
      if (task.outcomeConfirmed) retireContext();
      const replyId=`native:${task.id}:reply`;
      if (!this.host.history?.findByMessageId(name,replyId)) {
        if(execInput){try{const projected=this.scopedOutput(name,agent,task);if(projected)this.host.emit("message",{instance:name,...projected});}catch(error){this.host.warn?.("Native scoped output remains unresolved",error);}}
        else this.host.emit("message",{instance:name,role:task.status === "completed" ? "agent" : "status",sender:this.config(name)?.display_name || agent.name,text:task.status === "completed" ? task.output || "(No text output)" : [task.output,task.error || task.status].filter(Boolean).join("\n"),ts:new Date(task.finishedAt ?? Date.now()).toISOString(),messageId:replyId});
      }
      this.changed(name);settled({...task,reportedCorrelationIds});
      }finally{this.settling--;}
    }}); } catch(error) { closeLease();retireContext();throw error; }
    if (task.finishedAt) closeLease();
    if (!execInput && meta.source !== "web" && meta.source !== "app") {
      const userId=`native:${requestId}:user`;
      if (!this.host.history?.findByMessageId(name,userId)) this.host.emit("message",{instance:name,role:"user",sender:String(meta.from_instance || meta.user || "Fleet"),text:raw,ts:new Date().toISOString(),messageId:userId});
    }
    this.changed(name);return task;
  }
  async deliver(name: string, payload: Record<string,unknown>, options: NativeRuntimeDeliveryOptions = {}): Promise<boolean> {
    const port = this.host.requestContextAdmission?.();
    if (port) return runWithRequestContextAdmission(port, () => !this.host.stopping() && options.stillCurrent?.() !== false,
      () => this.deliverAdmitted(name, payload, options));
    return this.deliverAdmitted(name, payload, options);
  }
  private async deliverAdmitted(name: string, payload: Record<string,unknown>, options: NativeRuntimeDeliveryOptions): Promise<boolean> {
    this.enabled();
    if (this.host.stopping() || options.stillCurrent?.() === false) throw new Error("Windows delivery is no longer current");
    const current=this.get(name);
    if (current?.paused) this.setPaused(name,false);
    this.claim(name,payload,options,()=>{});return true;
  }
  execute(name: string, payload: Record<string,unknown>, options: NativeRuntimeDeliveryOptions = {}): Promise<NativeExecutionResult> {
    const port = this.host.requestContextAdmission?.();
    if (port) return runWithRequestContextAdmission(port, () => !this.host.stopping() && options.stillCurrent?.() !== false,
      () => this.executeAdmitted(name, payload, options));
    return this.executeAdmitted(name, payload, options);
  }
  private executeAdmitted(name: string, payload: Record<string,unknown>, options: NativeRuntimeDeliveryOptions): Promise<NativeExecutionResult> {
    return new Promise((resolve,reject)=>{
      try {
        const task=this.claim(name,payload,options,resolve);
        if (task.finishedAt) resolve({...task,cli:this.get(name)!.cli,cwd:this.get(name)!.cwd,sandbox:this.get(name)!.sandbox} as WindowsCliTask);
      } catch(error) { reject(error); }
    });
  }
}
