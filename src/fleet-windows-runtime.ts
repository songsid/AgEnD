/** Windows execution adapter for the ordinary Fleet instance registry and delivery facade. */
import { randomUUID } from "node:crypto";
import type { FleetConfig, InstanceConfig } from "./types.js";
import { windowsAgentsFor, type WindowsAgent, type WindowsAgents } from "./windows-agents.js";
import { LOCAL_WINDOWS_CLI_OFF, windowsBridgeFor, windowsCliEnabled, type WindowsCliExecutor, type WindowsCliTask } from "./windows-cli.js";
import { localWindowsCliEnabled, remoteRuntimeEnabled } from "./runtime-switches.js";

/** M-2255: the switch for where this agent runs — this PC's Windows CLIs, or the other Windows computers. */
const switchedOn = (agent: { machineId?: string }): boolean => agent.machineId ? remoteRuntimeEnabled() : localWindowsCliEnabled();
import { isWindowsInstance, nativeAgentId, nativeInstanceConfig, nativeInstanceName, registerWindowsProfiles, syncWindowsProfile } from "./native-instance-registry.js";
import { validWindowsAgentId } from "./windows-cli-worker.js";
import type { NativeHistoryMessage, WebChatHistory } from "./web-chat-history.js";
import type { SettingsExecution } from "./settings-transaction.js";
import type { NativeMcpLease } from "./native-mcp.js";
import { nativeProviderMcpSupported } from "./windows-cli-providers.js";

export interface FleetWindowsRuntimeHost {
  owner: object & { dataDir?: string };
  fleet(): FleetConfig | null;
  save(): void;
  emit(event: string, data: unknown): void;
  stopping(): boolean;
  history?: Pick<WebChatHistory,"findByMessageId"> & Partial<Pick<WebChatHistory,"reconcileNativeMessages">>;
  openMcp?(instance: string, requestId: string, sandbox: WindowsAgent["sandbox"], stillCurrent: () => boolean): NativeMcpLease | null;
  warn?(message: string,error: unknown): void;
  removed?(name: string,config: InstanceConfig): void;
  machineAvailable?(machineId: string): boolean;
  validateMachine?(machineId: string, cli: string, sandbox?: unknown): void;
}
export interface NativeRuntimeDeliveryOptions {
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
export type NativeRuntimePatch = Pick<InstanceConfig,"display_name"|"description"|"systemPrompt"|"model"|"working_directory"|"native_sandbox"|"tags">;
export type NativeExecutionResult = WindowsCliTask & {reportedCorrelationIds?: readonly string[]};

export class FleetWindowsRuntime {
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
  private enabled(): void { if (!windowsCliEnabled()) throw new Error("Windows runtime is disabled"); }
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
    const fleet = this.host.fleet();
    return !!fleet && windowsCliEnabled() && registerWindowsProfiles(fleet,this.store,this.host.save);
  }
  get(name: string): (WindowsAgent & {blocked:boolean}) | null {
    const config = this.config(name);
    if (!isWindowsInstance(config)) return null;
    const agent = this.store.get(this.id(name));
    if (config.machine_id !== agent.machineId) throw new Error("The instance machine does not match its saved conversation");
    return {...agent,name:config.display_name ?? agent.name,description:config.description ?? "",instructions:config.systemPrompt ?? "",cwd:config.working_directory,model:config.model || undefined,sandbox:config.native_sandbox ?? agent.sandbox};
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
  available(name: string): boolean {
    let agent:ReturnType<FleetWindowsRuntime["get"]>;
    try { agent=this.get(name); } catch { return false; }
    return !!agent && switchedOn(agent) && !this.host.stopping() && !agent.blocked && !agent.paused
      && (!agent.machineId || this.host.machineAvailable?.(agent.machineId) === true)
      && !this.bridge.hasActiveTask(agent.machineId);
  }
  async create(input: Record<string,unknown>, authorized: () => boolean, transaction?:Pick<SettingsExecution,"mutate"|"complete">): Promise<{name:string;runtime:"windows";agent:WindowsAgent}> {
    this.enabled();
    const fleet = this.host.fleet();
    if (!fleet) throw new Error("Fleet configuration is unavailable");
    const {tags,...profile} = input;
    if (profile.machineId !== undefined) {
      if (typeof profile.machineId !== "string" || !this.host.validateMachine) throw new Error("Remote runtime is not enabled");
      this.host.validateMachine(profile.machineId,String(profile.cli ?? "codex"),profile.sandbox);
    } else if (!localWindowsCliEnabled()) throw new Error(LOCAL_WINDOWS_CLI_OFF);   // M-2255: refused before anything is made
    const agent = await this.store.create(profile,authorized), name = nativeInstanceName(agent.id), before=fleet.instances[name];
    try {
      const persist=()=>{
        if (!authorized()) throw new Error("Authorization expired");
        if (Object.hasOwn(fleet.instances,name)) throw new Error("Instance name already exists");
        fleet.instances[name] = {...nativeInstanceConfig(agent),...(Array.isArray(tags) ? {tags:tags as string[]} : {})};
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
  update(name: string, patch: Partial<NativeRuntimePatch>, authorized: () => boolean): {name:string;agent:WindowsAgent} {
    this.enabled();
    const fleet = this.host.fleet(), before = this.config(name);
    if (!fleet || !before || !this.has(name)) throw new Error("Windows instance not found");
    const id = this.id(name), old = this.store.get(id);
    const next = {...before,...patch};
    const updated = syncWindowsProfile(next,this.store,authorized);
    try { if (!authorized()) throw new Error("Authorization expired"); fleet.instances[name] = next; this.host.save(); }
    catch(error) {
      fleet.instances[name] = before;
      this.store.update(id,{name:old.name,cwd:old.cwd,description:old.description,instructions:old.instructions,model:old.model ?? "",cli:old.cli,sandbox:old.sandbox});
      throw error;
    }
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
  cancel(name: string): WindowsCliTask | null { this.closeMcp(name);const result=this.store.cancel(this.id(name));this.changed(name);return result; }
  recover(name: string, confirmedStopped: unknown): WindowsAgent & {blocked:boolean} {
    const result=this.store.recover(this.id(name),confirmedStopped);this.changed(name);return result;
  }
  async recoverAsync(name:string,confirmedStopped:unknown):Promise<WindowsAgent & {blocked:boolean}> {
    const agent=this.get(name);
    if(!agent?.machineId)return this.recover(name,confirmedStopped);
    if(confirmedStopped!==true || !agent.activeId || !agent.blocked)throw new Error("Confirm the remote execution stopped before recovery");
    const bridge=this.bridge as WindowsCliExecutor & {recoverRemote?(machineId:string,id:string):Promise<WindowsCliTask>};
    if(!bridge.recoverRemote)throw new Error("Remote recovery is unavailable");
    await bridge.recoverRemote(agent.machineId,agent.activeId);
    const result=this.get(name)!;this.changed(name);return result;
  }
  /** Idempotently bring existing native conversations into shared chat history and search. */
  importHistory(): void {
    if (!this.host.history) return;
    for (const [name,config] of Object.entries(this.host.fleet()?.instances ?? {})) {
      if (!isWindowsInstance(config)) continue;
      const agent=this.store.get(this.id(name));
      const expected: NativeHistoryMessage[]=[];
      for (const turn of agent.turns) {
        const userId=`native:${turn.id}:user`, replyId=`native:${turn.id}:reply`;
        expected.push({role:"user",sender:"You",text:turn.prompt,ts:new Date(turn.startedAt).toISOString(),messageId:userId});
        if (turn.finishedAt) expected.push({role:turn.status === "completed" ? "agent" : "status",sender:agent.name,text:turn.output || turn.error || turn.status,ts:new Date(turn.finishedAt).toISOString(),messageId:replyId});
      }
      this.host.history.reconcileNativeMessages?.(name,expected);
      for (const message of expected) if (!this.host.history.findByMessageId(name,message.messageId)) this.host.emit("message",{instance:name,...message});
    }
  }
  private claim(name: string, payload: Record<string,unknown>, options: NativeRuntimeDeliveryOptions, settled: (task:NativeExecutionResult)=>void): WindowsCliTask | import("./windows-agents.js").WindowsTurn {
    this.enabled();
    if (this.host.stopping() || options.stillCurrent?.() === false) throw new Error("Windows delivery is no longer current");
    const config=this.config(name);
    if (!config || !this.has(name)) throw new Error("Windows instance not found");
    const agent=syncWindowsProfile(config,this.store);
    if(!switchedOn(agent))throw new Error(agent.machineId ? "Other Windows computers are turned off. Turn them on in Settings → Runtime." : LOCAL_WINDOWS_CLI_OFF);
    if(agent.machineId && this.host.machineAvailable?.(agent.machineId)!==true)throw new Error("This runtime machine is offline. Reconnect it before sending a message.");
    const raw = typeof payload.content === "string" ? payload.content : typeof payload.text === "string" ? payload.text
      : payload.payload && typeof payload.payload === "object" ? (payload.payload as {message?:unknown}).message : undefined;
    if (typeof raw !== "string" || !raw.trim()) throw new Error("Windows delivery needs a text message");
    if (["raw_paste","steer"].includes(String(payload.type))) throw new Error("This Windows runtime supports messages, not terminal input or steering");
    const requestId=validWindowsAgentId(payload.requestId) ? payload.requestId : randomUUID();
    options.beforeStart?.();
    const meta=payload.meta && typeof payload.meta === "object" ? payload.meta as Record<string,unknown> : {};
    const authority=options.authorityCurrent ?? options.stillCurrent;
    const existing=agent.turns.some(turn=>turn.id===requestId);
    let lease:NativeMcpLease|null=null;
    if (!existing && nativeProviderMcpSupported(agent.cli) && this.host.openMcp) {
      this.closeMcp(name);
      lease=this.host.openMcp(name,requestId,agent.sandbox,()=>{
        if (this.host.stopping() || !switchedOn(agent) || authority?.() === false
          || agent.machineId && this.host.machineAvailable?.(agent.machineId) !== true) return false;
        try { const current=this.get(name);return !!current && current.activeId===requestId && !current.paused && !current.blocked; }
        catch { return false; }
      });
      if (lease) this.mcpLeases.set(name,{requestId,lease});
    }
    const closeLease=()=>{if(lease){lease.close();if(this.mcpLeases.get(name)?.lease===lease)this.mcpLeases.delete(name);}};
    const context=lease ? [
      `Your AgEnD instance is ${name}. AgEnD tools query Fleet agents, tasks and delivery receipts. ${agent.sandbox === "read-only" ? "This turn permits queries only; delegation and task changes are unavailable." : "Send/delegate tools enqueue work and return a receipt; do not wait for another Windows agent while holding this turn."}`,
      ...(typeof meta.from_instance === "string" ? [`Incoming Fleet context: ${JSON.stringify({from_instance:meta.from_instance.slice(0,128),correlation_id:typeof meta.correlation_id === "string" ? meta.correlation_id.slice(0,256) : undefined,requires_reply:meta.requires_reply === "true"})}`] : []),
    ].join("\n") : undefined;
    let task:ReturnType<WindowsAgents["send"]>;
    try { task=this.store.send(agent.id,{requestId,prompt:raw},()=>!this.host.stopping() && authority?.() !== false,{...(lease ? {mcp:lease.connection,context} : {}),onSettled:task=>{
      const reportedCorrelationIds=lease?.reportedCorrelations(typeof meta.from_instance === "string" ? meta.from_instance : undefined) ?? [];
      closeLease();
      const replyId=`native:${task.id}:reply`;
      if (!this.host.history?.findByMessageId(name,replyId)) this.host.emit("message",{instance:name,role:task.status === "completed" ? "agent" : "status",sender:this.config(name)?.display_name || agent.name,text:task.status === "completed" ? task.output || "(No text output)" : [task.output,task.error || task.status].filter(Boolean).join("\n"),ts:new Date(task.finishedAt ?? Date.now()).toISOString(),messageId:replyId});
      this.changed(name);settled({...task,reportedCorrelationIds});
    }}); } catch(error) { closeLease();throw error; }
    if (task.finishedAt) closeLease();
    if (meta.source !== "web") {
      const userId=`native:${requestId}:user`;
      if (!this.host.history?.findByMessageId(name,userId)) this.host.emit("message",{instance:name,role:"user",sender:String(meta.from_instance || meta.user || "Fleet"),text:raw,ts:new Date().toISOString(),messageId:userId});
    }
    this.changed(name);return task;
  }
  async deliver(name: string, payload: Record<string,unknown>, options: NativeRuntimeDeliveryOptions = {}): Promise<boolean> {
    this.enabled();
    if (this.host.stopping() || options.stillCurrent?.() === false) throw new Error("Windows delivery is no longer current");
    const current=this.get(name);
    if (current?.paused) this.setPaused(name,false);
    this.claim(name,payload,options,()=>{});return true;
  }
  execute(name: string, payload: Record<string,unknown>, options: NativeRuntimeDeliveryOptions = {}): Promise<NativeExecutionResult> {
    return new Promise((resolve,reject)=>{
      try {
        const task=this.claim(name,payload,options,resolve);
        if (task.finishedAt) resolve({...task,cli:this.get(name)!.cli,cwd:this.get(name)!.cwd,sandbox:this.get(name)!.sandbox} as WindowsCliTask);
      } catch(error) { reject(error); }
    });
  }
}
