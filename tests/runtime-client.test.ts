import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RuntimeClient, pairRuntime, type RuntimeBridge } from "../src/runtime-client.js";
import { RuntimeClientStore } from "../src/runtime-client-store.js";
import { RuntimeCoordinator } from "../src/runtime-coordinator.js";
import { WindowsCliBridge, type WindowsCliProbe, type WindowsCliTask, type WindowsRunOptions } from "../src/windows-cli.js";

const directories: string[] = [], clients: RuntimeClient[] = [], hubs: RuntimeCoordinator[] = [], servers: Server[] = [];
function home(): string { const path = mkdtempSync(join(tmpdir(), "agend-runtime-client-")); directories.push(path); return path; }
const input = () => ({ requestId: randomUUID(), cli: "codex" as const, cwd: "C:\\workspace", prompt: "Private fixture request; never invoke a real CLI", sandbox: "read-only" as const });
class FakeBridge implements RuntimeBridge {
  readonly tasks = new Map<string, WindowsCliTask>();
  readonly options = new Map<string, WindowsRunOptions>();
  launches = 0;
  readonly probe = vi.fn(async (): Promise<WindowsCliProbe> => ({ home: "C:\\Users\\fixture", clis: [], probedAt: 1 }));
  readonly prepareWorkspace = vi.fn(async (agentId: string) => `C:\\Users\\fixture\\.agend\\workspaces\\${agentId}`);
  start(raw: unknown, _authorized?: () => boolean, options: WindowsRunOptions = {}): WindowsCliTask {
    const task = raw as ReturnType<typeof input>;
    this.launches++; this.options.set(task.requestId, options);
    const snapshot: WindowsCliTask = { id: task.requestId, cli: task.cli, cwd: task.cwd, sandbox: task.sandbox, status: "running", startedAt: Date.now(), output: "" };
    this.tasks.set(snapshot.id, snapshot); return { ...snapshot };
  }
  get(id: string): WindowsCliTask | null { const task = this.tasks.get(id); return task ? { ...task } : null; }
  complete(id: string, output = "fixture result"): void {
    const task = this.tasks.get(id)!; Object.assign(task, { status: "completed", finishedAt: Date.now(), outcomeConfirmed: true, output });
    this.options.get(id)?.onSettled?.({ ...task });
  }
  cancel(id: string): WindowsCliTask {
    const task = this.tasks.get(id); if (!task) throw Error("missing fixture");
    Object.assign(task, { status: "cancelled", finishedAt: Date.now(), outcomeConfirmed: true }); this.options.get(id)?.onSettled?.({ ...task }); return { ...task };
  }
  close(): void { for (const task of this.tasks.values()) if (!task.finishedAt) this.cancel(task.id); }
  releaseUnknown(_id: string): void {}
}
async function fixture(options: ConstructorParameters<typeof RuntimeCoordinator>[1] = {}) {
  const hubHome = home(), state = { hub: new RuntimeCoordinator(hubHome, options) }; hubs.push(state.hub);
  const pairing = state.hub.createPairing(), pending = state.hub.pair({ code: pairing.code, name: "Fixture Windows", platform: "win32" });
  state.hub.approve(pending.machineId);
  const claim = state.hub.claim({ machineId: pending.machineId, claimSecret: pending.claimSecret }); if (claim.status !== "approved") throw Error("Pairing fixture failed");
  const server = createServer((req, res) => { if (!state.hub.handlePublicRequest(req, res, new URL(req.url ?? "/", "http://localhost"))) { res.writeHead(404); res.end(); } });
  servers.push(server); server.on("upgrade", (req, socket, head) => { if (!state.hub.handleUpgrade(req, socket, head)) socket.destroy(); });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); const address = server.address(); if (!address || typeof address === "string") throw Error("No fixture port");
  const base = `http://127.0.0.1:${address.port}`, store = new RuntimeClientStore(home()), bridge = new FakeBridge();
  store.saveCredentials({ server: base, machineId: claim.machineId, credential: claim.credential, name: "Fixture Windows" });
  const client = new RuntimeClient({ store, bridge, reconnectMs: 25, disconnectGraceMs: 500, pollMs: 10 }); clients.push(client); await client.start();
  await vi.waitFor(() => expect(client.online()).toBe(true));
  return { state, hubHome, server, base, store, bridge, client, machineId: claim.machineId, credential: claim.credential };
}
afterEach(async () => {
  for (const client of clients.splice(0)) await client.stop();
  for (const hub of hubs.splice(0)) hub.close();
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); }
  for (const path of directories.splice(0)) { if (!resolve(path).startsWith(resolve(tmpdir()) + sep)) throw Error("Unexpected fixture path"); rmSync(path, { recursive: true, force: true }); }
});

describe("outbound runtime with the real coordinator protocol", () => {
  it("authenticates, updates inventory, creates workspaces and returns structured results", async () => {
    const f = await fixture(), agentId = randomUUID();
    expect(f.state.hub.machine(f.machineId)?.status).toBe("online");
    expect(await f.state.hub.call(f.machineId, "probe", {})).toEqual({ home: "C:\\Users\\fixture", clis: [], probedAt: 1 });
    expect(await f.state.hub.call(f.machineId, "workspace", { agentId })).toEqual({ agentId, cwd: `C:\\Users\\fixture\\.agend\\workspaces\\${agentId}` });
    expect(f.bridge.prepareWorkspace).toHaveBeenCalledExactlyOnceWith(agentId);
  });
  it("durably accepts a job, streams snapshots and does not launch a duplicate execution", async () => {
    const f = await fixture(), task = input();
    expect(await f.state.hub.call(f.machineId, "run", { task })).toMatchObject({ id: task.requestId, status: "running" });
    expect(f.store.get(task.requestId)?.seq).toBeGreaterThanOrEqual(2); expect(f.bridge.launches).toBe(1);
    await f.state.hub.call(f.machineId, "run", { task }); expect(f.bridge.launches).toBe(1);
    f.bridge.complete(task.requestId);
    await vi.waitFor(() => expect(f.state.hub.task(task.requestId)?.output).toBe("fixture result"));
    expect(readFileSync(join(f.store.directory, "jobs.json"), "utf8")).not.toContain(task.prompt);
    expect(readFileSync(join(f.store.directory, "jobs.json"), "utf8")).not.toContain(f.credential);
  });
  it("reconnects to a restarted coordinator and replays the same execution snapshot without rerunning", async () => {
    const f = await fixture(), task = input(); await f.state.hub.call(f.machineId, "run", { task });
    f.state.hub.close(); f.state.hub = new RuntimeCoordinator(f.hubHome); hubs.push(f.state.hub);
    await vi.waitFor(() => expect(f.state.hub.machine(f.machineId)?.status).toBe("online"));
    f.bridge.complete(task.requestId, "after reconnect");
    await vi.waitFor(() => expect(f.state.hub.task(task.requestId)?.output).toBe("after reconnect"));
    expect(f.bridge.launches).toBe(1);
  });
  it("cancels only the named active execution and confirms the terminal snapshot", async () => {
    const f = await fixture(), task = input(); await f.state.hub.call(f.machineId, "run", { task });
    expect(await f.state.hub.call(f.machineId, "cancel", { runId: task.requestId })).toMatchObject({ id: task.requestId, status: "cancelled", outcomeConfirmed: true });
    expect(f.store.blocked()).toBe(false);
  });
  it("stops an active execution when the paired machine is revoked instead of reconnecting forever", async () => {
    const f = await fixture(), task = input(); await f.state.hub.call(f.machineId, "run", { task });
    f.state.hub.revoke(f.machineId);
    await f.client.waitUntilStopped();
    expect(f.client.online()).toBe(false); expect(f.bridge.get(task.requestId)?.status).toBe("cancelled");
  });
  it("rejects unsafe remote metadata before invoking the bridge", async () => {
    const f = await fixture(), task = input();
    await expect(f.client.operation("run", { task, mcp: { tools: ["task"], credential: "injected" } })).rejects.toThrow(/MCP/);
    await expect(f.client.operation("run", { task: { ...task, command: "powershell" } })).rejects.toThrow(/Unknown task field/);
    await expect(f.client.operation("workspace", { agentId: "../escape" })).rejects.toThrow(/workspace/);
    expect(f.bridge.launches).toBe(0);
  });
  it("runs an isolated fake worker through the actual native bridge and parses the provider's completion", async () => {
    const f = await fixture(); await f.client.stop();
    const worker = join(home(), "isolated-runtime-worker.mjs");
    writeFileSync(worker, `import {createInterface} from 'node:readline';
const emit=value=>process.stdout.write(JSON.stringify(value)+'\\n');
const finish=value=>process.stdout.write(JSON.stringify(value)+'\\n',()=>process.exit(0));
createInterface({input:process.stdin}).once('line',line=>{
 const request=JSON.parse(line);
 if(request.op==='probe'){finish({type:'probe',home:'C:\\\\Users\\\\fixture',clis:[{id:'codex',path:'C:\\\\fixture\\\\codex.exe',version:'fixture',authenticated:true,runnable:true,readOnlySupport:true,supports:{execution:true,resume:true,model:true,mcp:true},permissionNote:'Isolated fixture',models:[]}]});return;}
 if(request.op==='run'){
  emit({type:'started'});
  const events=[{type:'thread.started',thread_id:'12345678-1234-4321-abcd-123456789012'},{type:'item.completed',item:{type:'agent_message',text:'fake provider completed'}},{type:'turn.completed'}];
  emit({type:'stdout',text:events.map(JSON.stringify).join('\\n')+'\\n'});finish({type:'finished',code:0});
 }
});`);
    const bridge = new WindowsCliBridge(async () => ({ executable: process.execPath, args: [worker] }));
    const client = new RuntimeClient({ store: f.store, bridge, pollMs: 10 }); clients.push(client); await client.start();
    await vi.waitFor(() => expect(client.online()).toBe(true));
    // Match the explicit administrator detection required before any real bridge task, without a real CLI.
    await f.state.hub.call(f.machineId, "probe", {force:true});
    const task = input(); await f.state.hub.call(f.machineId, "run", { task });
    await vi.waitFor(() => {
      const result = f.state.hub.task(task.requestId); if (result?.status === "failed") throw Error(result.error);
      expect(result).toMatchObject({ status: "completed", outcomeConfirmed: true, output: "fake provider completed\n", threadId: "12345678-1234-4321-abcd-123456789012" });
    }, { timeout: 10_000 }).catch(error => {
      throw Error(`${error instanceof Error ? error.message : error}\nBridge: ${JSON.stringify(bridge.get(task.requestId))}\nJournal: ${JSON.stringify(f.store.get(task.requestId))}\nOnline: ${client.online()}`);
    });
    expect(f.store.get(task.requestId)?.task.status).toBe("completed");
  }, 20_000);
  it("relays scoped MCP over the machine channel without exposing machine credentials to the CLI", async () => {
    const handler = vi.fn(async () => ({ content: [{ type: "text", text: "isolated task list" }] }));
    const f = await fixture({ handleMcp: handler }), task = input(); await f.state.hub.call(f.machineId, "run", { task, mcp: { tools: ["task"] } });
    const connection = f.bridge.options.get(task.requestId)?.mcp; expect(connection).toBeDefined();
    expect(JSON.stringify(connection)).not.toContain(f.credential); expect(connection?.endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/agent$/);
    const body = { op: "native-mcp", method: "tools/call", callId: "lookup-1", params: { name: "task", arguments: { action: "list" } } };
    const response = await fetch(connection!.endpoint, { method: "POST", headers: { "Content-Type": "application/json", "X-Agend-Native-Token": connection!.token }, body: JSON.stringify(body) });
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ content: [{ type: "text", text: "isolated task list" }] }); expect(handler).toHaveBeenCalledOnce();
    const denied = await fetch(connection!.endpoint, { method: "POST", headers: { Origin: "http://localhost", "X-Agend-Native-Token": connection!.token }, body: JSON.stringify(body) });
    expect(denied.status).toBe(403); expect(handler).toHaveBeenCalledOnce();
    f.bridge.complete(task.requestId);
    expect((await fetch(connection!.endpoint, { method: "POST", headers: { "X-Agend-Native-Token": connection!.token }, body: JSON.stringify(body) })).status).toBe(403);
  });
});

describe("runtime interactive pairing protocol", () => {
  it("stores a credential only after explicit approval and never follows a redirect", async () => {
    const machineId = randomUUID(), requests: string[] = []; let claims = 0;
    const server = createServer((req, res) => {
      requests.push(req.url!); req.resume(); res.setHeader("Content-Type", "application/json");
      if (req.url?.endsWith("/pair")) { res.writeHead(201); res.end(JSON.stringify({ machineId, claimSecret: "c".repeat(64), status: "pending", expiresAt: Date.now() + 10_000 })); }
      else if (++claims === 1) { res.writeHead(202); res.end(JSON.stringify({ status: "pending" })); }
      else { res.writeHead(200); res.end(JSON.stringify({ machineId, status: "approved", credential: "d".repeat(64) })); }
    });
    servers.push(server); server.listen(0, "127.0.0.1"); await once(server, "listening"); const address = server.address(); if (!address || typeof address === "string") throw Error("No fixture port");
    const store = new RuntimeClientStore(home());
    const paired = await pairRuntime({ server: `http://127.0.0.1:${address.port}`, code: "interactive-code", name: "Fixture", store, pollMs: 1 });
    expect(paired.credential).toBe("d".repeat(64)); expect(store.credentials()?.machineId).toBe(machineId); expect(requests).toEqual(["/runtime/v1/pair", "/runtime/v1/claim", "/runtime/v1/claim"]);
    const redirect = createServer((req, res) => { req.resume(); res.writeHead(307, { Location: `http://127.0.0.1:${address.port}/runtime/v1/pair` }); res.end(); }); servers.push(redirect);
    redirect.listen(0, "127.0.0.1"); await once(redirect, "listening"); const other = redirect.address(); if (!other || typeof other === "string") throw Error("No fixture port");
    await expect(pairRuntime({ server: `http://127.0.0.1:${other.port}`, code: "interactive-code", name: "Fixture", store: new RuntimeClientStore(home()) })).rejects.toThrow();
    expect(requests).toHaveLength(3);
  });
});

describe("manual recovery when a submitted command never reached the runtime", () => {
  it("persists a confirmed terminal tombstone without execution, so a delayed original run cannot launch", async () => {
    const store = new RuntimeClientStore(home()), bridge = new FakeBridge(), client = new RuntimeClient({ store, bridge }), task = input();
    const original = { task, context: "trusted context", mcp: { tools: ["task"] } };
    await expect(client.operation("recover", { runId: task.requestId, confirmedStopped: false, original })).rejects.toThrow(/Confirm/);
    expect(store.get(task.requestId)).toBeNull();
    expect(await client.operation("recover", { runId: task.requestId, confirmedStopped: true, original })).toMatchObject({ id: task.requestId, status: "failed", outcomeConfirmed: true });
    expect(store.get(task.requestId)?.seq).toBe(1);
    expect(await client.operation("run", original)).toMatchObject({ status: "failed", outcomeConfirmed: true });
    expect(bridge.launches).toBe(0); expect(store.blocked()).toBe(false);
    expect(await client.operation("recover", { runId: task.requestId, confirmedStopped: true, original })).toMatchObject({ status: "failed", outcomeConfirmed: true });
  });
  it("rejects mismatched or injected original arguments, preserving execution identity", async () => {
    const store = new RuntimeClientStore(home()), bridge = new FakeBridge(), client = new RuntimeClient({ store, bridge }), task = input();
    await expect(client.operation("recover", { runId: randomUUID(), confirmedStopped: true, original: { task } })).rejects.toThrow(/identity/);
    await expect(client.operation("recover", { runId: task.requestId, confirmedStopped: true, original: { task: { ...task, command: "powershell" } } })).rejects.toThrow(/Unknown task field/);
    await client.operation("recover", { runId: task.requestId, confirmedStopped: true, original: { task } });
    await expect(client.operation("recover", { runId: task.requestId, confirmedStopped: true, original: { task: { ...task, prompt: "changed" } } })).rejects.toThrow(/arguments/);
    expect(bridge.launches).toBe(0);
  });
});
