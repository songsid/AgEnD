/** Real manager/profile/host metadata, inert processes; no provider launch, credentials or user stores. */
import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { NativePaneManager, type NativePaneManagerOptions } from "../src/native-pane-manager.js";
import { NativePaneRecoveryError } from "../src/native-pane-recovery.js";
import { RuntimePaneHost } from "../src/runtime-pane-host.js";
import { RuntimePaneStore } from "../src/runtime-pane-store.js";
import { WindowsAgents } from "../src/windows-agents.js";
import { nativeInstanceConfig } from "../src/native-instance-registry.js";
import { deriveNeedsYou } from "../src/needs-you.js";
import { validateRuntimePaneRequest, validateRuntimePaneSessionProof } from "../src/runtime-pane-protocol.js";

const cleanup: Array<() => unknown> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "agend-unwritten-claude-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const store = new WindowsAgents(root, { get: () => null, start() { throw Error("No exec"); } } as never);
  const agent = await store.create({ name: "Never written", cli: "claude-code", cwd: "C:\\scratch\\child", sandbox: "read-only" });
  store.bindInstance(agent.id, "unwritten");
  const config = { ...nativeInstanceConfig(agent), native_adapter: "pane" as const };
  const proof = vi.fn(async (): Promise<"absent"|"saved"|"unknown"> => "unknown");
  const notice = vi.fn();
  const baseline = vi.fn(async (cursor: any) => ({ state: "pending" as const, cursor, complete: false, turnKnown: false, openTurn: null }));
  const spawn = vi.fn(async (_launch: unknown, _owner: unknown) => {
    let onExit = (_event: { exitCode: number }) => {};
    return { pid: 10101, write: vi.fn(), resize() {}, pause() {}, resume() {},
      kill: () => onExit({ exitCode: 1 }), onData: () => ({ dispose() {} }),
      onExit: (callback: typeof onExit) => { onExit = callback; return { dispose() {} }; } };
  });
  const host = new RuntimePaneHost({ store: new RuntimePaneStore(join(root, "runner")), bootId: randomUUID(), online: () => true, maxAgents: () => 4, spawn, sessionProof: proof,
    mcpConnection: (owner, tools) => ({ owner, tools, endpoint: "http://127.0.0.1:1/agent", token: "a".repeat(64) }),
    transcript: () => ({ baseline, read: async cursor => ({ state: "pending" as const, cursor: cursor!, data: "", lines: [], complete: false, gap: false }), close: async () => {} }) });
  cleanup.push(() => host.stop());
  const endpoint = { machineId: "local", online: () => true, epoch: () => "scratch", version: () => "Claude Code 2.1.316", call: vi.fn((request: any) => host.request(request)), subscribe: () => () => {} };
  const options: NativePaneManagerOptions = { home: root, store, config: () => config, endpoint: async () => endpoint,
    freshNotice: notice, admit() {}, instructions: () => "No tools or work", menu: () => [{ name: "reply" }], allowed: () => false, published: () => false,
    invoke: async () => { throw Error("No invocation"); } };
  const make = () => new NativePaneManager(options);
  const first = await make().prepare("unwritten", config, () => {});
  await first.acquire(() => {});
  const pin = store.get(agent.id).threadId!;
  expect(pin).toBe(first.snapshot()?.launchId);
  await first.release("close");
  const start = async () => {
    const next = await make().prepare("unwritten", config, () => {});
    cleanup.push(() => next.release("detach"));
    return next.acquire(() => {});
  };
  return { root, agent, store, config, endpoint, spawn, proof, notice, start, pin, make, options };
}

it("holds an unwritten first Claude session before another open and keeps its original pin and receipt", async () => {
  const f = await fixture();
  const file = join(f.root, "native-panes", f.agent.id, "active.json"), receipt = readFileSync(file, "utf8");
  for (let attempt = 0; attempt < 3; attempt++) {
    await expect(f.start()).rejects.toBeInstanceOf(NativePaneRecoveryError);
    expect(f.store.get(f.agent.id).threadId).toBe(f.pin);
    expect(f.store.get(f.agent.id).activeId).toBeUndefined();
    expect(readFileSync(file, "utf8")).toBe(receipt);
  }
  expect(f.spawn).toHaveBeenCalledOnce();
  expect(f.endpoint.call.mock.calls.filter(([request]) => request.action === "open")).toHaveLength(1);
  expect(f.proof).toHaveBeenCalledTimes(3);
});

it("positive absence starts one fresh session, records the old ID and refuses a chain when the replacement is also unwritten", async () => {
  const f = await fixture(); f.proof.mockResolvedValue("absent");
  const manager=f.make(), next=await manager.prepare("unwritten",f.config,()=>{});
  await next.acquire(()=>{});const fresh=next.snapshot()!;
  expect(fresh.sessionId).not.toBe(f.pin);expect(fresh.sessionId).toBe(fresh.launchId);
  const intent=JSON.parse(readFileSync(join(f.root,"native-panes",f.agent.id,"active.json"),"utf8"));
  expect(intent.launch.sessionId).toBeUndefined();expect(intent.fresh).toMatchObject({previous:{sessionId:f.pin,state:"exited"},automatic:true,announced:true});
  expect(f.store.get(f.agent.id).threadId).toBe(fresh.sessionId);expect(f.notice).toHaveBeenCalledOnce();
  await next.release("detach");const reattached=await f.make().prepare("unwritten",f.config,()=>{});expect((await reattached.acquire(()=>{})).disposition).toBe("reattached");
  expect(f.notice).toHaveBeenCalledOnce();expect(f.spawn).toHaveBeenCalledTimes(2);await reattached.release("close");
  for(let attempt=0;attempt<3;attempt++)await expect(f.start()).rejects.toBeInstanceOf(NativePaneRecoveryError);
  expect(f.spawn).toHaveBeenCalledTimes(2);expect(f.notice).toHaveBeenCalledOnce();
});

it("a confirmed saved session resumes its original pin and never emits a fresh-session notice", async () => {
  const f=await fixture();f.proof.mockResolvedValue("saved");const next=await f.make().prepare("unwritten",f.config,()=>{});
  const acquired=await next.acquire(()=>{});expect(acquired.disposition).toBe("resumed");expect(next.snapshot()?.sessionId).toBe(f.pin);
  expect(f.spawn.mock.calls[1]).toBeDefined();expect(f.notice).not.toHaveBeenCalled();await next.release("close");
});

it("a durable fresh intent survives failure before its profile pin change, without another fresh identity", async () => {
  const f=await fixture();f.proof.mockResolvedValue("absent");const change=vi.spyOn(f.store,"replacePaneSession");change.mockImplementationOnce(()=>{throw Error("pin save interrupted");});
  await expect(f.start()).rejects.toThrow("pin save interrupted");
  const file=join(f.root,"native-panes",f.agent.id,"active.json"),intent=JSON.parse(readFileSync(file,"utf8"));
  expect(f.store.get(f.agent.id).threadId).toBe(f.pin);expect(f.spawn).toHaveBeenCalledOnce();
  const next=await f.make().prepare("unwritten",f.config,()=>{});await next.acquire(()=>{});
  expect(next.snapshot()?.sessionId).toBe(intent.launch.launchId);expect(f.spawn).toHaveBeenCalledTimes(2);expect(f.proof).toHaveBeenCalledOnce();
  await next.release("close");
});

it("admin fresh-start is bound to the held launch and session, refuses stale authority, and preserves old receipt bytes", async () => {
  const f=await fixture();await expect(f.start()).rejects.toBeInstanceOf(NativePaneRecoveryError);
  const file=join(f.root,"native-panes",f.agent.id,"active.json"),old=JSON.parse(readFileSync(file,"utf8"));
  const receipt=join(f.root,"native-panes",f.agent.id,`${old.launch.launchId}.pane.json`),bytes=readFileSync(receipt,"utf8"),manager=f.make();
  await expect(manager.startFresh("unwritten",f.config,randomUUID(),f.pin,()=>{})).rejects.toThrow("changed");
  await expect(manager.startFresh("unwritten",f.config,old.launch.launchId,randomUUID(),()=>{})).rejects.toThrow("changed");
  await expect(manager.startFresh("unwritten",f.config,old.launch.launchId,f.pin,()=>{throw Error("authority revoked");})).rejects.toThrow("authority revoked");
  expect(f.store.get(f.agent.id).threadId).toBe(f.pin);
  await manager.startFresh("unwritten",f.config,old.launch.launchId,f.pin,()=>{});
  await expect(manager.startFresh("unwritten",f.config,old.launch.launchId,f.pin,()=>{})).rejects.toThrow("changed");
  const next=await manager.prepare("unwritten",f.config,()=>{});await next.acquire(()=>{});
  expect(next.snapshot()?.sessionId).not.toBe(f.pin);expect(readFileSync(receipt,"utf8")).toBe(bytes);expect(f.notice).not.toHaveBeenCalled();
  await next.release("close");
});

it("a changed endpoint epoch during absence proof never resets the pin or opens a replacement", async () => {
  const f=await fixture();f.proof.mockImplementation(async()=>{f.endpoint.epoch=()=>"changed";return"absent";});
  await expect(f.start()).rejects.toThrow("transport changed");expect(f.store.get(f.agent.id).paneRecovery).toBeUndefined();expect(f.store.get(f.agent.id).threadId).toBe(f.pin);expect(f.spawn).toHaveBeenCalledOnce();
});
it("a session proof for another owner cannot reset this pin even when it claims absence",async()=>{
 const f=await fixture();f.proof.mockResolvedValue("absent");const call=f.endpoint.call.getMockImplementation()!;
 f.endpoint.call.mockImplementation(async request=>{const result:any=await call(request);return request.action==="session-proof"?{...result,snapshot:{...result.snapshot,agentId:randomUUID()}}:result;});
 await expect(f.start()).rejects.toBeInstanceOf(NativePaneRecoveryError);expect(f.store.get(f.agent.id).threadId).toBe(f.pin);expect(f.spawn).toHaveBeenCalledOnce();
});
it("repeating an admin decision after an interrupted pin save consumes its existing intent once",async()=>{
 const f=await fixture();await expect(f.start()).rejects.toBeInstanceOf(NativePaneRecoveryError);const held=f.store.get(f.agent.id).paneRecovery!,manager=f.make();
 const change=vi.spyOn(f.store,"replacePaneSession");change.mockImplementationOnce(()=>{throw Error("profile save failed");});
 await expect(manager.startFresh("unwritten",f.config,held.launchId!,f.pin,()=>{})).rejects.toThrow("profile save failed");
 const file=join(f.root,"native-panes",f.agent.id,"active.json"),intent=JSON.parse(readFileSync(file,"utf8"));
 await manager.startFresh("unwritten",f.config,held.launchId!,f.pin,()=>{});
 expect(f.store.get(f.agent.id).threadId).toBe(intent.launch.launchId);expect(JSON.parse(readFileSync(file,"utf8")).launch.launchId).toBe(intent.launch.launchId);
 const next=await manager.prepare("unwritten",f.config,()=>{});await next.acquire(()=>{});expect(f.spawn).toHaveBeenCalledTimes(2);await next.release("close");
});

it("an old tab's stopped-process recovery refuses with refresh guidance instead of changing the held session",async()=>{
 const f=await fixture();await expect(f.start()).rejects.toBeInstanceOf(NativePaneRecoveryError);
 const hold=f.store.get(f.agent.id).paneRecovery!;
 await expect(f.make().recover("unwritten",f.config,hold.launchId!,true,()=>{})).rejects.toThrow("Refresh this page");
 expect(f.store.get(f.agent.id).threadId).toBe(f.pin);expect(f.spawn).toHaveBeenCalledOnce();
});

it("a session hold is visible in Needs-you even though the process is stopped, and disappears when resolved",()=>{
 const recovery={key:"session-unconfirmed:owned",detail:"Check the saved Windows Claude conversation",since:1000};
 const item=deriveNeedsYou({prompts:[],deliveries:[],ownerOf:()=>undefined,instances:[{name:"unwritten",state:"stopped",paneRecovery:recovery}]});
 expect(item).toEqual([expect.objectContaining({reason:"native_pane_hold",instance:"unwritten",detail:recovery.detail,since:1000})]);
 expect(deriveNeedsYou({prompts:[],deliveries:[],ownerOf:()=>undefined,instances:[{name:"unwritten",state:"stopped",paneRecovery:null}]})).toEqual([]);
});

it("the session proof request cannot name another profile, session or path, and rejects malformed proof statuses",()=>{
 const request={action:"session-proof",paneId:randomUUID(),launchId:randomUUID()};
 expect(validateRuntimePaneRequest(request)).toEqual(request);
 for(const extra of [{path:"C:\\elsewhere"},{sessionId:randomUUID()},{cwd:"C:\\other"},{profile:"other"}])expect(()=>validateRuntimePaneRequest({...request,...extra})).toThrow();
 expect(()=>validateRuntimePaneSessionProof({state:["absent"],snapshot:{}})).toThrow();
});


it.each(["endpoint","list","proof-rpc","offline"])("a transient %s failure stays retryable and later resumes the same saved pin",async stage=>{
 const f=await fixture(),endpoint=f.options.endpoint,call=f.endpoint.call.getMockImplementation()!,online=f.endpoint.online;
 f.proof.mockResolvedValue("saved");
 if(stage==="endpoint")f.options.endpoint=async()=>{throw Error("starting host");};
 else if(stage==="offline")f.proof.mockImplementation(async()=>{f.endpoint.online=()=>false;return"saved";});
 else f.endpoint.call.mockImplementation(request=>request.action===(stage==="list"?"list":"session-proof")?Promise.reject(Error("host request timed out")):call(request));
 let caught:unknown;try{await f.start();}catch(error){caught=error;}
 expect(caught).toBeInstanceOf(Error);expect(caught).not.toBeInstanceOf(NativePaneRecoveryError);
 expect(f.store.get(f.agent.id).paneRecovery).toBeUndefined();expect(f.store.get(f.agent.id).threadId).toBe(f.pin);expect(f.spawn).toHaveBeenCalledOnce();
 f.options.endpoint=endpoint;f.endpoint.call.mockImplementation(call);f.endpoint.online=online;f.proof.mockResolvedValue("saved");
 const next=await f.make().prepare("unwritten",f.config,()=>{});await next.acquire(()=>{});
 expect(next.snapshot()?.sessionId).toBe(f.pin);expect(f.spawn).toHaveBeenCalledTimes(2);expect(f.notice).not.toHaveBeenCalled();await next.release("close");
});
it("a reachable older host without the proof capability holds without interpreting a failed RPC as absence",async()=>{
 const f=await fixture(),call=f.endpoint.call.getMockImplementation()!;f.proof.mockResolvedValue("saved");
 f.endpoint.call.mockImplementation(async request=>{const result:any=await call(request);if(request.action==="list")delete result.capabilities.claudeSessionProof;return result;});
 await expect(f.start()).rejects.toBeInstanceOf(NativePaneRecoveryError);
 expect(f.store.get(f.agent.id).paneRecovery?.kind).toBe("host-upgrade");
 expect(f.store.get(f.agent.id).threadId).toBe(f.pin);expect(f.proof).not.toHaveBeenCalled();expect(f.spawn).toHaveBeenCalledOnce();
});
it.each(["model","sandbox","prompt","workflow"])("a proven absent pin builds its replacement from the current %s settings",async change=>{
 const f=await fixture();f.proof.mockResolvedValue("absent");
 if(change==="model")f.config.model="changed-model";
 if(change==="sandbox")f.config.native_sandbox="workspace-write";
 if(change==="prompt")f.config.systemPrompt="current prompt";
 if(change==="workflow")f.config.workflow="current-workflow";
 f.options.instructions=()=>"current role";f.options.menu=()=>[{name:"reply"},{name:"task"}];
 const next=await f.make().prepare("unwritten",f.config,()=>{});await next.acquire(()=>{});
 const launch:any=f.spawn.mock.calls[1][0];expect(launch).toMatchObject({cwd:f.config.working_directory,sandbox:f.config.native_sandbox,instructions:"current role",mcpTools:["reply","task"]});
 expect(launch.model).toBe(f.config.model||undefined);expect(launch.sessionId).toBeUndefined();expect(f.notice).toHaveBeenCalledOnce();await next.release("close");
});
it("an unlaunched fresh intent follows later cold settings without changing its chosen UUID",async()=>{
 const f=await fixture();f.proof.mockResolvedValue("absent");vi.spyOn(f.store,"replacePaneSession").mockImplementationOnce(()=>{throw Error("pin save interrupted");});
 await expect(f.start()).rejects.toThrow("pin save interrupted");
 const file=join(f.root,"native-panes",f.agent.id,"active.json"),intent=JSON.parse(readFileSync(file,"utf8"));
 f.config.model="newer-model";f.options.instructions=()=>"newer role";f.options.menu=()=>[{name:"task"}];
 const next=await f.make().prepare("unwritten",f.config,()=>{});await next.acquire(()=>{});
 expect(next.snapshot()?.sessionId).toBe(intent.launch.launchId);expect(f.spawn.mock.calls[1][0]).toMatchObject({model:"newer-model",instructions:"newer role",mcpTools:["task"]});
 expect(f.notice).toHaveBeenCalledOnce();expect(f.proof).toHaveBeenCalledOnce();await next.release("close");
});
it("an explicit fresh decision on a held pin uses the current launch settings",async()=>{
 const f=await fixture();await expect(f.start()).rejects.toBeInstanceOf(NativePaneRecoveryError);const hold=f.store.get(f.agent.id).paneRecovery!;
 f.config.model="current-admin-model";f.config.systemPrompt="current admin role";f.options.instructions=()=>"current admin role";
 const manager=f.make();await manager.startFresh("unwritten",f.config,hold.launchId!,f.pin,()=>{});
 const next=await manager.prepare("unwritten",f.config,()=>{});await next.acquire(()=>{});
 expect(f.spawn.mock.calls[1][0]).toMatchObject({model:"current-admin-model",instructions:"current admin role"});await next.release("close");
});
it("a saved transcript appearing before the admin decision keeps the pin and clears its stale hold",async()=>{
 const f=await fixture();await expect(f.start()).rejects.toBeInstanceOf(NativePaneRecoveryError);const hold=f.store.get(f.agent.id).paneRecovery!;
 f.proof.mockResolvedValue("saved");const manager=f.make(),file=join(f.root,"native-panes",f.agent.id,"active.json"),before=readFileSync(file,"utf8");
 await expect(manager.startFresh("unwritten",f.config,hold.launchId!,f.pin,()=>{})).rejects.toThrow("The saved conversation is available again. Choose Start to resume it.");
 expect(f.store.get(f.agent.id).threadId).toBe(f.pin);expect(f.store.get(f.agent.id).paneRecovery).toBeUndefined();expect(readFileSync(file,"utf8")).toBe(before);expect(f.spawn).toHaveBeenCalledOnce();
 const next=await manager.prepare("unwritten",f.config,()=>{});await next.acquire(()=>{});expect(next.snapshot()?.sessionId).toBe(f.pin);expect(f.notice).not.toHaveBeenCalled();await next.release("close");
});

it('an exited receipt saved before releasing the profile survives a host outage and a missing inventory version',async()=>{
 const f=await fixture();
 // Restore only the original exact reservation: simulate a coordinator dying after it saved the exit manifest.
 f.store.reservePane(f.agent.id,f.pin);const endpoint=f.options.endpoint;
 f.options.endpoint=async()=>{throw Error('offline');};await expect(f.start()).rejects.toThrow('offline');
 expect(f.store.get(f.agent.id)).toMatchObject({activeId:f.pin,paneLaunchId:f.pin,threadId:f.pin});expect(f.store.get(f.agent.id).paneRecovery).toBeUndefined();
 f.options.endpoint=endpoint;const version=f.endpoint.version;f.endpoint.version=()=>null as any;
 await expect(f.start()).rejects.toThrow();expect(f.store.get(f.agent.id).activeId).toBe(f.pin);expect(f.spawn).toHaveBeenCalledOnce();expect(f.store.get(f.agent.id).paneRecovery).toBeUndefined();
 f.endpoint.version=version;f.proof.mockResolvedValue('saved');const next=await f.make().prepare('unwritten',f.config,()=>{});await next.acquire(()=>{});
 expect(next.snapshot()?.sessionId).toBe(f.pin);expect(f.spawn).toHaveBeenCalledTimes(2);await next.release('close');
});

it("changing only the configured cwd refuses before any fresh intent or pin change",async()=>{
 const f=await fixture();f.proof.mockResolvedValue("absent");const file=join(f.root,"native-panes",f.agent.id,"active.json"),before=readFileSync(file,"utf8");
 f.config.working_directory="C:\\scratch\\other";
 await expect(f.start()).rejects.toThrow("profile scope differs");expect(readFileSync(file,"utf8")).toBe(before);expect(f.store.get(f.agent.id).threadId).toBe(f.pin);expect(f.spawn).toHaveBeenCalledOnce();
 expect(()=>f.store.update(f.agent.id,{cwd:f.config.working_directory})).toThrow("Start a new conversation before changing");
});
it("a saved transcript cancels an unopened interrupted admin intent before changing its original pin",async()=>{
 const f=await fixture();await expect(f.start()).rejects.toBeInstanceOf(NativePaneRecoveryError);const hold=f.store.get(f.agent.id).paneRecovery!,manager=f.make();
 vi.spyOn(f.store,"replacePaneSession").mockImplementationOnce(()=>{throw Error("interrupted profile save");});
 await expect(manager.startFresh("unwritten",f.config,hold.launchId!,f.pin,()=>{})).rejects.toThrow("interrupted profile save");
 f.proof.mockResolvedValue("saved");await expect(manager.startFresh("unwritten",f.config,hold.launchId!,f.pin,()=>{})).rejects.toThrow("saved conversation is available again");
 expect(f.store.get(f.agent.id).threadId).toBe(f.pin);expect(f.store.get(f.agent.id).paneRecovery).toBeUndefined();
 const next=await manager.prepare("unwritten",f.config,()=>{});await next.acquire(()=>{});expect(next.snapshot()?.sessionId).toBe(f.pin);expect(f.spawn).toHaveBeenCalledTimes(2);expect(f.notice).not.toHaveBeenCalled();await next.release("close");
});

it.each(['epoch','authority'])('the admin proof recheck keeps its %s fence before changing the pin',async fence=>{
 const f=await fixture();await expect(f.start()).rejects.toBeInstanceOf(NativePaneRecoveryError);const held=f.store.get(f.agent.id).paneRecovery!;let current=true;
 f.proof.mockImplementation(async()=>{if(fence==='epoch')f.endpoint.epoch=()=> 'new epoch';else current=false;return 'absent';});
 await expect(f.make().startFresh('unwritten',f.config,held.launchId!,f.pin,()=>{if(!current)throw Error('revoked');})).rejects.toThrow(fence==='epoch'?'transport changed':'revoked');
 expect(f.store.get(f.agent.id).threadId).toBe(f.pin);expect(f.spawn).toHaveBeenCalledOnce();expect(f.store.get(f.agent.id).paneRecovery).toEqual(held);
});
