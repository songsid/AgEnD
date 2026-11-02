import { createServer, type Server, type RequestListener } from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RuntimeCoordinator } from "../src/runtime-coordinator.js";
import { RuntimeClient, type RuntimeBridge } from "../src/runtime-client.js";
import { RuntimeClientStore } from "../src/runtime-client-store.js";
import { RuntimeWindowsBridge } from "../src/runtime-windows-bridge.js";
import { WindowsAgents } from "../src/windows-agents.js";
import { FleetWindowsRuntime, type FleetWindowsRuntimeHost } from "../src/fleet-windows-runtime.js";
import type { WindowsCliExecutor, WindowsCliProbe, WindowsCliTask, WindowsRunOptions } from "../src/windows-cli.js";
import type { NativeTaskInput } from "../src/windows-cli-worker.js";
import type { FleetConfig } from "../src/types.js";
import { WebChatHistory } from "../src/web-chat-history.js";

const homes: string[] = [], servers: Server[] = [], hubs: RuntimeCoordinator[] = [], clients: RuntimeClient[] = [], routers: RuntimeWindowsBridge[] = [];
function home() { const value = mkdtempSync(join(tmpdir(), "agend-remote-fleet-")); homes.push(value); return value; }
class FixtureBridge implements RuntimeBridge, WindowsCliExecutor {
  readonly tasks = new Map<string, WindowsCliTask>();
  readonly launches: Array<{ input: NativeTaskInput; options: WindowsRunOptions }> = [];
  readonly sessionId = randomUUID();
  uncertainCancellation = false;
  constructor(readonly label: string, readonly drive = "C") {}
  probe = vi.fn(async (): Promise<WindowsCliProbe> => ({ home: `${this.drive}:\\Users\\${this.label}`, probedAt: 1, clis: [{ id: "codex", path: `${this.drive}:\\cli\\codex.exe`, version: "fixture-1", authenticated: true, runnable: true,
    supports: { execution: true, resume: true, model: true, mcp: true }, readOnlySupport: true, permissionNote: "Fixture only", models: [{ id: `${this.label}-model`, name: `${this.label} model` }], modelsSource: "cli-list" }] }));
  prepareWorkspace = vi.fn(async (agentId: string) => `${this.drive}:\\Users\\${this.label}\\.agend\\workspaces\\${agentId}`);
  start(raw: unknown, authorized: () => boolean = () => true, options: WindowsRunOptions = {}): WindowsCliTask {
    if (!authorized()) throw Error("Fixture authorization expired"); const input = structuredClone(raw as NativeTaskInput); this.launches.push({ input, options });
    const task: WindowsCliTask = { id: input.requestId, cli: input.cli, cwd: input.cwd, sandbox: input.sandbox, ...(input.model ? { model: input.model } : {}), status: "running", startedAt: Date.now(), output: "" }; this.tasks.set(task.id, task); return structuredClone(task);
  }
  get(id: string): WindowsCliTask | null { const task = this.tasks.get(id); return task ? structuredClone(task) : null; }
  list(): WindowsCliTask[] { return [...this.tasks.values()].map(task => structuredClone(task)); }
  hasActiveTask(): boolean { return [...this.tasks.values()].some(task => !task.finishedAt || task.outcomeConfirmed === false); }
  finish(id: string, output = `${this.label} result`): void {
    const task = this.tasks.get(id)!; Object.assign(task, { status: "completed", output, finishedAt: Date.now(), outcomeConfirmed: true, threadId: this.sessionId }); this.launches.find(row => row.input.requestId === id)?.options.onSettled?.(structuredClone(task));
  }
  cancel(id: string): WindowsCliTask {
    const task = this.tasks.get(id); if (!task) throw Error("Fixture task missing");
    Object.assign(task, { status: "cancelled", finishedAt: Date.now(), outcomeConfirmed: !this.uncertainCancellation }); this.launches.find(row => row.input.requestId === id)?.options.onSettled?.(structuredClone(task)); return structuredClone(task);
  }
  releaseUnknown(id: string): void { const task = this.tasks.get(id); if (task) task.outcomeConfirmed = true; }
  close(): void {}
}
async function http(handler: RequestListener) {
  const server = createServer(handler); servers.push(server); server.listen(0, "127.0.0.1"); await once(server, "listening"); const address = server.address(); if (!address || typeof address === "string") throw Error("No fixture port"); return { server, base: `http://127.0.0.1:${address.port}` };
}
async function fixture() {
  const centralHome = home(), state = { hub: null as unknown as RuntimeCoordinator, router: null as unknown as RuntimeWindowsBridge };
  const centralOptions = { handleMcp: (machineId: string, runId: string, body: unknown) => state.router.mcp(machineId, runId, body) };
  state.hub = new RuntimeCoordinator(centralHome, centralOptions); hubs.push(state.hub);
  const { server, base } = await http((req, res) => { if (!state.hub.handlePublicRequest(req, res, new URL(req.url ?? "/", "http://localhost"))) { res.writeHead(404); res.end(); } });
  server.on("upgrade", (req, socket, head) => { if (!state.hub.handleUpgrade(req, socket, head)) socket.destroy(); });
  const add = async (label: string, drive: string) => {
    const p = state.hub.createPairing(), pending = state.hub.pair({ code: p.code, name: label, platform: "win32" }); state.hub.approve(pending.machineId);
    const identity = state.hub.claim({ machineId: pending.machineId, claimSecret: pending.claimSecret }); if (identity.status !== "approved") throw Error("Fixture pairing failed");
    const store = new RuntimeClientStore(home()); store.saveCredentials({ server: base, machineId: identity.machineId, credential: identity.credential, name: label });
    const worker = new FixtureBridge(label, drive), client = new RuntimeClient({ store, bridge: worker, reconnectMs: 15, disconnectGraceMs: 1000, pollMs: 5 }); clients.push(client); await client.start();
    await vi.waitFor(() => expect(state.hub.machine(identity.machineId)?.inventory?.clis.length).toBe(1)); return { ...identity, store, worker, client };
  };
  const one = await add("desk", "C"), two = await add("laptop", "D"), local = new FixtureBridge("local", "E"), owner = { dataDir: centralHome };
  const config = { instances: {}, defaults: { model: "never-inherit-this-model" }, teams: {} } as unknown as FleetConfig;
  const messages: Array<Record<string, unknown>> = [], history = new WebChatHistory();
  const host: FleetWindowsRuntimeHost = { owner, fleet: () => config, save: vi.fn(), stopping: () => false,
    emit(event, data) { if (event === "message") { const message = data as Parameters<WebChatHistory["record"]>[0]; history.record(message); messages.push(message); } },
    history,
    machineAvailable: id => state.hub.machine(id)?.status === "online",
    validateMachine(id, cli) { const machine = state.hub.machine(id); if (machine?.status !== "online" || !machine.inventory?.clis.some(row => row.id === cli && row.runnable)) throw Error("Selected runtime CLI is offline or unavailable"); },
  };
  const build = () => { const router = new RuntimeWindowsBridge(owner, () => process.env.AGEND_REMOTE_RUNTIME === "1" ? state.hub : null, local); routers.push(router); state.router = router; const store = new WindowsAgents(centralHome, router); return { router, store, runtime: new FleetWindowsRuntime(host, { store, bridge: router }) }; };
  return { state, centralHome, centralOptions, one, two, local, owner, config, host, messages, build, ...build() };
}
const message = (requestId = randomUUID()) => ({ requestId, content: "Fixture request; use no real AI", meta: { source: "fleet", from_instance: "dispatcher" } });
beforeEach(() => { vi.stubEnv("AGEND_WINDOWS_CLI", "1"); vi.stubEnv("AGEND_REMOTE_RUNTIME", "1"); });
afterEach(async () => {
  for (const client of clients.splice(0)) await client.stop();
  for (const router of routers.splice(0)) router.close();
  for (const hub of hubs.splice(0)) hub.close();
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); }
  for (const path of homes.splice(0)) { if (!resolve(path).startsWith(resolve(tmpdir()) + sep)) throw Error("Unsafe fixture cleanup"); rmSync(path, { recursive: true, force: true }); }
  vi.unstubAllEnvs(); vi.restoreAllMocks();
});

describe("remote runtime joins the same Fleet agent and conversation flow", () => {
  it("routes two machines independently, keeps workspaces/models local, and resumes without duplicate launches or chat", async () => {
    const f = await fixture();
    const a = await f.runtime.create({ machineId: f.one.machineId, name: "Desk agent", cli: "codex", sandbox: "read-only", model: "desk-model" }, () => true);
    const b = await f.runtime.create({ machineId: f.two.machineId, name: "Laptop agent", cli: "codex", sandbox: "read-only", model: "laptop-model" }, () => true);
    expect(a.agent.cwd).toContain("C:\\Users\\desk\\"); expect(b.agent.cwd).toContain("D:\\Users\\laptop\\");
    expect(f.config.instances[a.name].machine_id).toBe(f.one.machineId); expect(f.config.instances[b.name].machine_id).toBe(f.two.machineId);
    const first = message(), second = message(), runA = f.runtime.execute(a.name, first), runB = f.runtime.execute(b.name, second);
    await vi.waitFor(() => { expect(f.one.worker.launches).toHaveLength(1); expect(f.two.worker.launches).toHaveLength(1); });
    expect(f.one.worker.launches[0].input.model).toBe("desk-model"); expect(f.two.worker.launches[0].input.model).toBe("laptop-model");
    f.one.worker.finish(first.requestId); f.two.worker.finish(second.requestId); expect((await runA).status).toBe("completed"); expect((await runB).status).toBe("completed");
    expect(f.runtime.get(a.name)?.threadId).toBe(f.one.worker.sessionId); expect(f.runtime.get(b.name)?.threadId).toBe(f.two.worker.sessionId);
    const before = f.messages.length; await f.runtime.execute(a.name, first); expect(f.one.worker.launches).toHaveLength(1); expect(f.messages).toHaveLength(before);
    const followup = message(), resumed = f.runtime.execute(a.name, followup); await vi.waitFor(() => expect(f.one.worker.launches).toHaveLength(2));
    expect(f.one.worker.launches[1].options.resumeSessionId).toBe(f.one.worker.sessionId); expect(f.two.worker.launches).toHaveLength(1);
    f.one.worker.finish(followup.requestId); await resumed;
    expect(f.messages.filter(row => row.role === "agent")).toHaveLength(3); expect(f.messages.filter(row => row.role === "user")).toHaveLength(3);
    const defaults = await f.runtime.create({ machineId: f.one.machineId, name: "CLI default agent", cli: "codex", sandbox: "read-only" }, () => true);
    expect(defaults.agent.model).toBeUndefined(); expect(f.config.instances[defaults.name].model).toBe("");
  });
  it("refuses cross-machine conversation reassignment and offline creation", async () => {
    const f = await fixture(), a = await f.runtime.create({ machineId: f.one.machineId, name: "Pinned agent", cli: "codex", sandbox: "read-only" }, () => true);
    f.config.instances[a.name].machine_id = f.two.machineId;
    expect(() => f.runtime.get(a.name)).toThrow(/machine/); expect(() => f.runtime.update(a.name, { description: "Must not move" }, () => true)).toThrow(/different runtime machine/);
    f.config.instances[a.name].machine_id = f.one.machineId; f.state.hub.revoke(f.two.machineId);
    await expect(f.runtime.create({ machineId: f.two.machineId, name: "Unavailable", cli: "codex", sandbox: "read-only" }, () => true)).rejects.toThrow(/offline|unavailable/);
    expect(f.store.list()).toHaveLength(1); expect(f.local.launches).toHaveLength(0);
  });
  it("restores a result after coordinator restart without rerunning and then resumes the original CLI conversation", async () => {
    const f = await fixture(), a = await f.runtime.create({ machineId: f.one.machineId, name: "Restart agent", cli: "codex", sandbox: "read-only" }, () => true), first = message();
    void f.runtime.execute(a.name, first); await vi.waitFor(() => expect(f.one.worker.launches).toHaveLength(1));
    f.router.close(); f.state.hub.close(); f.state.hub = new RuntimeCoordinator(f.centralHome, f.centralOptions); hubs.push(f.state.hub); const next = f.build();
    await vi.waitFor(() => expect(f.state.hub.machine(f.one.machineId)?.status).toBe("online")); f.one.worker.finish(first.requestId, "Recovered result");
    await vi.waitFor(() => expect(f.state.hub.task(first.requestId)?.output).toBe("Recovered result"));
    expect(next.runtime.get(a.name)).toMatchObject({ threadId: f.one.worker.sessionId, blocked: false }); expect(next.runtime.get(a.name)?.activeId).toBeUndefined();
    next.runtime.importHistory(); next.runtime.importHistory(); expect(f.messages.filter(row => row.text === "Recovered result")).toHaveLength(1); expect(f.one.worker.launches).toHaveLength(1);
    const followup = message(), run = next.runtime.execute(a.name, followup); await vi.waitFor(() => expect(f.one.worker.launches).toHaveLength(2)); expect(f.one.worker.launches[1].options.resumeSessionId).toBe(f.one.worker.sessionId); f.one.worker.finish(followup.requestId); await run;
  });
  it("keeps an uncertain cancellation blocked until the runtime confirms recovery", async () => {
    const f = await fixture(), a = await f.runtime.create({ machineId: f.one.machineId, name: "Cancel agent", cli: "codex", sandbox: "read-only" }, () => true), first = message();
    f.one.worker.uncertainCancellation = true; const run = f.runtime.execute(a.name, first); await vi.waitFor(() => expect(f.one.worker.launches).toHaveLength(1)); f.runtime.cancel(a.name);
    expect((await run).outcomeConfirmed).toBe(false); expect(f.state.hub.hasActiveTask(f.one.machineId)).toBe(true); expect(f.runtime.get(a.name)?.blocked).toBe(true);
    await expect(f.runtime.execute(a.name, message())).rejects.toThrow(/process|working|unconfirmed|unlock/);
    await f.state.hub.call(f.one.machineId, "recover", { runId: first.requestId, confirmedStopped: true }); await vi.waitFor(() => expect(f.runtime.get(a.name)?.blocked).toBe(false)); expect(f.state.hub.hasActiveTask(f.one.machineId)).toBe(false);
  });
  it("relays the same scoped AgEnD MCP capability through both machine channels", async () => {
    const received: Array<{ header: unknown; body: unknown }> = [], central = await http((req, res) => { let body = ""; req.setEncoding("utf8"); req.on("data", part => body += part); req.on("end", () => { received.push({ header: req.headers["x-agend-native-token"], body: JSON.parse(body) }); res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ content: [{ type: "text", text: "Private fixture task query" }] })); }); });
    const f = await fixture(), close = vi.fn(); f.host.openMcp = () => ({ connection: { endpoint: central.base + "/agent", token: "a".repeat(64), tools: ["task"] }, close, reportedCorrelations: () => [] });
    const a = await f.runtime.create({ machineId: f.one.machineId, name: "Tool agent", cli: "codex", sandbox: "read-only" }, () => true), first = message(), run = f.runtime.execute(a.name, first); await vi.waitFor(() => expect(f.one.worker.launches).toHaveLength(1));
    const connection = f.one.worker.launches[0].options.mcp!; expect(connection.endpoint).not.toBe(central.base + "/agent"); expect(connection.token).not.toBe(f.one.credential);
    const body = { op: "native-mcp", method: "tools/call", callId: "fixture-list-1", params: { name: "task", arguments: { action: "list" } } };
    const response = await fetch(connection.endpoint, { method: "POST", headers: { "Content-Type": "application/json", "X-Agend-Native-Token": connection.token }, body: JSON.stringify(body) }); expect(response.status).toBe(200); expect((await response.text())).toContain("Private fixture task query"); expect(received).toEqual([{ header: "a".repeat(64), body }]);
    await expect(f.router.mcp(f.two.machineId, first.requestId, body)).rejects.toThrow(/not active/); f.one.worker.finish(first.requestId); await run;
    expect(close).toHaveBeenCalledOnce(); expect((await fetch(connection.endpoint, { method: "POST", headers: { "X-Agend-Native-Token": connection.token }, body: JSON.stringify(body) })).status).toBe(403);
  });
  it("preserves the existing local Windows path when remote runtimes are disabled", async () => {
    vi.stubEnv("AGEND_REMOTE_RUNTIME", ""); const local = new FixtureBridge("local"), router = new RuntimeWindowsBridge({}, () => null, local); routers.push(router);
    const store = new WindowsAgents(home(), router), a = await store.create({ name: "Local agent", cli: "codex", sandbox: "read-only" });
    expect(a.machineId).toBeUndefined(); const requestId = randomUUID(); store.send(a.id, { requestId, prompt: "Fixture local request" }, () => true); expect(local.launches).toHaveLength(1); local.finish(requestId); expect(store.get(a.id).blocked).toBe(false); expect(store.get(a.id).threadId).toBe(local.sessionId);
    await expect(store.create({ name: "Unavailable remote", machineId: randomUUID(), cli: "codex", sandbox: "read-only" })).rejects.toThrow(/not enabled/);
  });
});
