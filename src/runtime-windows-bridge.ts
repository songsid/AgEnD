/** Route the existing native conversation store to a local worker or a paired Windows runtime. */
import { windowsBridgeFor, type WindowsCliExecutor, type WindowsCliProbe, type WindowsCliTask, type WindowsRunOptions } from "./windows-cli.js";
import { validateNativeTask } from "./windows-cli-worker.js";
import { nativeMcpHttp, type NativeMcpRequest } from "./windows-native-mcp.js";
import type { NativeMcpConnection } from "./windows-cli-providers.js";
import type { RuntimeOperation } from "./runtime-protocol.js";
import type { RuntimeCoordinatorEvent } from "./runtime-coordinator.js";

export interface RuntimeExecutionCoordinator {
  machine(id: string): {status: string; platform: string; inventory?: WindowsCliProbe} | null;
  call(machineId: string, operation: RuntimeOperation, payload: unknown): Promise<unknown>;
  task(id: string): WindowsCliTask | null;
  hasActiveTask(machineId: string): boolean;
  subscribe(listener: (event: RuntimeCoordinatorEvent) => void): () => void;
}
type Pending = {machineId: string; task: WindowsCliTask; settle?: WindowsRunOptions["onSettled"]; timer: ReturnType<typeof setTimeout>};

export class RuntimeWindowsBridge implements WindowsCliExecutor {
  private readonly local: WindowsCliExecutor;
  private readonly pending = new Map<string, Pending>();
  private readonly scopes = new Map<string,{machineId: string; connection: NativeMcpConnection}>();
  private subscription: (()=>void) | null = null;
  private attached: RuntimeExecutionCoordinator | null = null;
  constructor(owner: object, private readonly coordinator: ()=>RuntimeExecutionCoordinator|null, local?: WindowsCliExecutor) {
    this.local = local ?? windowsBridgeFor(owner);
  }
  private remote(): RuntimeExecutionCoordinator {
    const remote = this.coordinator();
    if (!remote) throw new Error("Remote runtimes are not enabled");
    if (this.attached !== remote) {
      this.subscription?.();this.attached = remote;
      this.subscription = remote.subscribe(event => {
        if (event.type !== "task" || !event.task) return;
        const pending = this.pending.get(event.task.id);
        if (!pending || pending.machineId !== event.machineId) return;
        pending.task = structuredClone(event.task);
        if (event.task.finishedAt) this.finish(event.task.id,event.task);
      });
    }
    return remote;
  }
  private finish(id: string, task: WindowsCliTask): void {
    const pending=this.pending.get(id);
    this.scopes.delete(id);
    if (!pending) return;
    clearTimeout(pending.timer);this.pending.delete(id);
    pending.settle?.(structuredClone(task));
  }
  private machine(id: string): RuntimeExecutionCoordinator {
    const remote=this.remote(), machine=remote.machine(id);
    if (!machine || machine.status !== "online" || machine.platform !== "win32") throw new Error("The selected Windows runtime is offline or unavailable");
    return remote;
  }
  async probe(options: {force?:boolean;machineId?:string} = {}): Promise<WindowsCliProbe> {
    if (!options.machineId) return this.local.probe(options);
    const remote=this.machine(options.machineId), machine=remote.machine(options.machineId)!;
    if (!options.force) return structuredClone(machine.inventory ?? {clis:[],home:"",probedAt:null});
    return await remote.call(options.machineId,"probe",{force:true}) as WindowsCliProbe;
  }
  async prepareWorkspace(agentId: string, authorized: ()=>boolean = ()=>true, machineId?:string): Promise<string> {
    if (!machineId) return this.local.prepareWorkspace(agentId,authorized);
    if (!authorized()) throw new Error("Authorization expired");
    const result=await this.machine(machineId).call(machineId,"workspace",{agentId}) as {cwd?:unknown};
    if (!authorized()) throw new Error("Authorization expired");
    if (typeof result?.cwd !== "string") throw new Error("The remote runtime did not return a workspace");
    return result.cwd;
  }
  start(value: unknown, authorized: ()=>boolean = ()=>true, options: WindowsRunOptions = {}): WindowsCliTask {
    if (!options.machineId) return this.local.start(value,authorized,options);
    const input=validateNativeTask(value), machineId=options.machineId, remote=this.machine(machineId);
    if (!authorized()) throw new Error("Authorization expired before remote execution");
    const existing=remote.task(input.requestId) ?? this.pending.get(input.requestId)?.task;
    // The coordinator journal validates the complete payload digest as well as task identity.
    if (existing) throw new Error("This remote task was already admitted; reconcile its saved result before retrying");
    if (remote.hasActiveTask(machineId)) throw new Error("This runtime is already executing a task");
    const task:WindowsCliTask={id:input.requestId,cli:input.cli,cwd:input.cwd,sandbox:input.sandbox,...(input.model?{model:input.model}:{}),status:"starting",startedAt:Date.now(),output:""};
    const timer=setTimeout(()=>{
      const pending=this.pending.get(task.id);if(!pending)return;
      this.finish(task.id,{...pending.task,status:"failed",finishedAt:Date.now(),outcomeConfirmed:false,error:"Remote execution outcome is unknown. Reconnect the runtime to reconcile; do not retry automatically."});
    },360_000);
    timer.unref?.();this.pending.set(task.id,{machineId,task,settle:options.onSettled,timer});
    if(options.mcp)this.scopes.set(task.id,{machineId,connection:options.mcp});
    const payload={task:input,...(options.resumeSessionId?{resumeSessionId:options.resumeSessionId}:{}),...(options.context?{context:options.context}:{}),...(options.mcp?{mcp:{tools:options.mcp.tools}}:{})};
    void remote.call(machineId,"run",payload).then(result=>{
      const accepted=result as WindowsCliTask;
      if(!accepted || accepted.id!==task.id)throw new Error("Invalid remote execution acceptance");
      const pending=this.pending.get(task.id);if(pending)pending.task=structuredClone(accepted);
      if(accepted.finishedAt)this.finish(task.id,accepted);
    }).catch(()=>{
      const pending=this.pending.get(task.id);if(!pending)return;
      // A lost response is not proof that the runtime did not execute the command.
      this.finish(task.id,{...pending.task,status:"failed",finishedAt:Date.now(),outcomeConfirmed:false,error:"Remote admission could not be confirmed. Reconnect to reconcile this task before sending another."});
    });
    return structuredClone(task);
  }
  get(id:string):WindowsCliTask|null { return this.coordinator()?.task(id) ?? structuredClone(this.pending.get(id)?.task ?? null) ?? this.local.get(id); }
  list():WindowsCliTask[] { return [...this.local.list(),...Array.from(this.pending.values(),item=>structuredClone(item.task))]; }
  hasActiveTask(machineId?:string):boolean { return machineId ? this.coordinator()?.hasActiveTask(machineId) ?? true : this.local.hasActiveTask(); }
  cancel(id:string):WindowsCliTask {
    const pending=this.pending.get(id), remote=this.coordinator(), task=remote?.task(id) ?? pending?.task;
    if(!task)return this.local.cancel(id);
    if(!pending)throw new Error("Reconnect and reconcile the remote task before cancelling it");
    this.scopes.delete(id);
    void this.machine(pending.machineId).call(pending.machineId,"cancel",{runId:id}).catch(()=>{});
    pending.task={...task,status:"cancelling"};return structuredClone(pending.task);
  }
  releaseUnknown(id:string):void {
    if(this.coordinator()?.task(id) || this.pending.has(id))throw new Error("Remote process state must be reconciled on its runtime before recovery");
    this.local.releaseUnknown(id);
  }
  async recoverRemote(machineId:string,id:string):Promise<WindowsCliTask> {
    const task=await this.machine(machineId).call(machineId,"recover",{runId:id,confirmedStopped:true}) as WindowsCliTask;
    if(!task || task.id!==id || !task.finishedAt || task.outcomeConfirmed!==true)throw new Error("The runtime has not confirmed process recovery");
    this.finish(id,task);return task;
  }
  async mcp(machineId:string,runId:string,body:unknown):Promise<unknown> {
    const scope=this.scopes.get(runId), remote=this.machine(machineId), task=remote.task(runId) ?? this.pending.get(runId)?.task;
    if(!scope || scope.machineId!==machineId || !task || task.finishedAt)throw new Error("The remote tool execution is not active");
    // The central capability still rechecks the agent, original turn and live tool permissions at admission.
    return nativeMcpHttp(scope.connection,body as NativeMcpRequest);
  }
  close():void {
    this.subscription?.();this.subscription=null;this.attached=null;this.scopes.clear();
    for(const pending of this.pending.values())clearTimeout(pending.timer);
    this.pending.clear();this.local.close();
  }
}
