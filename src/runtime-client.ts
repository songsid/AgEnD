/** Standalone, outbound-only native runtime. Imports no Fleet, database, bot or Linux native dependency. */
import WebSocket from "ws";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { hostname } from "node:os";
import { randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";
import { WindowsCliBridge, nativeWindowsTransport, WINDOWS_CLI_INVENTORY_FILE, type WindowsCliProbe, type WindowsCliTask, type WindowsRunOptions } from "./windows-cli.js";
import { validateNativeTask, validWindowsAgentId, type NativeTaskInput } from "./windows-cli-worker.js";
import { validNativeSessionId, type NativeMcpConnection } from "./windows-cli-providers.js";
import { RuntimeClientStore, runtimeJobDigest, validateRuntimeServer, type RuntimeCredentials, type RuntimeStoredJob } from "./runtime-client-store.js";
import { RUNTIME_ROTATE_PATH, runtimeClaimFingerprint } from "./runtime-protocol.js";
import { validateRuntimePaneRequest } from "./runtime-pane-protocol.js";
import type { RuntimePaneLink } from "./runtime-pane-link.js";
import type { RuntimePaneHost } from "./runtime-pane-host.js";
import type { RuntimePaneHostOptions } from "./runtime-pane-host.js";
export { RUNTIME_PANE_MODULES } from "./runtime-pane-assets.js";

export interface RuntimeBridge {
  probe(options?: { force?: boolean }): Promise<WindowsCliProbe>;
  prepareWorkspace(agentId: string): Promise<string>;
  start(value: unknown, authorized?: () => boolean, options?: WindowsRunOptions): WindowsCliTask;
  get(id: string): WindowsCliTask | null;
  cancel(id: string): WindowsCliTask;
  close(): void;
  releaseUnknown(id: string): void;
}
interface Command { v: 1; type: "request"; id: string; operation: string; payload: Record<string, unknown> }
interface PendingTool { accept(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
export interface RuntimeClientOptions {
  store: RuntimeClientStore;
  bridge?: RuntimeBridge;
  report?: (message: string) => void;
  reconnectMs?: number;
  disconnectGraceMs?: number;
  pollMs?: number;
  /** Tests may use an isolated fake worker. Production always uses the Windows bridge. */
  socketFactory?: (url: string, credential: string) => WebSocket;
  /** Offline transport acceptance supplies its own process factory, never a public configuration field. */
  createPaneHost?: (options: RuntimePaneHostOptions) => RuntimePaneHost;
}
const MAX_FRAME = 256 * 1024;
const MAX_TOOL = 64 * 1024;
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function message(error: unknown): string { return error instanceof Error ? error.message.slice(0, 1000) : "Runtime operation failed"; }
interface CheckedRun { task: NativeTaskInput; resumeSessionId?: string; context?: string; mcp?: { tools: string[] } }
function checkedRun(value: unknown): CheckedRun {
  if (!object(value) || Object.keys(value).some(key => !["task", "resumeSessionId", "context", "mcp"].includes(key))) throw new Error("Invalid runtime run payload");
  const task = validateNativeTask(value.task);
  if (value.resumeSessionId !== undefined && !validNativeSessionId(task.cli, value.resumeSessionId)) throw new Error("Invalid native conversation ID");
  if (value.context !== undefined && (typeof value.context !== "string" || value.context.length > 2000 || value.context.includes("\0"))) throw new Error("Invalid native context");
  if (value.mcp !== undefined && (!object(value.mcp) || Object.keys(value.mcp).some(key => key !== "tools")
    || !Array.isArray(value.mcp.tools) || !value.mcp.tools.length || value.mcp.tools.length > 64
    || value.mcp.tools.some(tool => typeof tool !== "string" || !/^[a-z][a-z0-9_]{0,63}$/.test(tool)))) throw new Error("Invalid scoped MCP request");
  return { task, resumeSessionId: value.resumeSessionId as string | undefined, context: value.context as string | undefined,
    mcp: value.mcp as { tools: string[] } | undefined };
}
function jsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((accept, reject) => {
    let text = "", bytes = 0;
    req.setTimeout(10_000, () => { reject(new Error("MCP request timed out")); req.destroy(); });
    req.setEncoding("utf8");
    req.on("data", (part: string) => { bytes += Buffer.byteLength(part); if (bytes > MAX_TOOL) { reject(new Error("MCP request is too large")); req.destroy(); } else text += part; });
    req.on("error", reject);
    req.on("end", () => { try { accept(JSON.parse(text)); } catch { reject(new Error("Invalid MCP JSON")); } });
  });
}
export class RuntimeClient {
  readonly bootId = randomUUID();
  private readonly bridge: RuntimeBridge;
  private socket: WebSocket | null = null;
  private welcomed = false;
  private stopped = true;
  private closed = false;
  private unlock: (() => void) | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private graceTimer: ReturnType<typeof setTimeout> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private credentials: RuntimeCredentials | null = null;
  private startupRotation: Promise<RuntimeCredentials> | null = null;
  private paneHost: RuntimePaneHost | RuntimePaneLink | null = null;
  private paneOpening: Promise<RuntimePaneHost | RuntimePaneLink> | null = null;
  private machinePaneLimit = 4;
  private readonly active = new Set<string>();
  private readonly snapshots = new Map<string, string>();
  private readonly pendingTools = new Map<string, PendingTool>();
  private readonly mcpTokens = new Map<string, { runId: string; tools: string[] }>();
  private mcpServer: Server | null = null;
  private mcpOpening: Promise<number> | null = null;
  private mcpPort = 0;
  private inventory: WindowsCliProbe | null = null;
  private readonly stoppedListeners = new Set<() => void>();
  constructor(private readonly options: RuntimeClientOptions) {
    this.bridge = options.bridge ?? new WindowsCliBridge(nativeWindowsTransport, join(options.store.directory, WINDOWS_CLI_INVENTORY_FILE));
  }
  private report(text: string): void { this.options.report?.(text); }
  online(): boolean { return this.welcomed && this.socket?.readyState === WebSocket.OPEN; }
  waitUntilStopped(): Promise<void> { return this.stopped && this.closed ? Promise.resolve() : new Promise(done => this.stoppedListeners.add(done)); }
  async start(): Promise<void> {
    if (!this.stopped) return;
    let credentials = this.options.store.credentials(); if (!credentials) throw new Error("Pair this runtime before connecting");
    validateRuntimeServer(credentials.server);
    this.unlock = this.options.store.lock(this.bootId);
    try {
      this.stopped = false; this.closed = false;
      if (credentials.pendingCredential) {
        const rotating = this.startupRotation = rotateRuntimeCredentials({ store: this.options.store });
        try { credentials = await rotating; } finally { if (this.startupRotation === rotating) this.startupRotation = null; }
      }
      if (this.stopped) throw Error("Runtime start was cancelled");
      this.options.store.recoverInterrupted(); this.credentials = credentials;
      // Connect immediately, then publish the last administrator detection from the private profile.
      // A cached read starts no CLI. Only an explicit probe command with force:true performs detection.
      this.connect();
      // A foreground runtime must remain alive while an idle connection is down. Promises and unref'ed retry
      // timers do not keep Node running after the last socket closes; stop() owns and clears this liveness ref.
      this.pollTimer = setInterval(() => this.poll(), this.options.pollMs ?? 250);
      void this.refreshInventory().catch(() => this.report("CLI discovery failed; refresh it from AgEnD after checking the local installation."));
    } catch (error) { this.stopped = true; this.unlock?.(); this.unlock = null; throw error; }
  }
  private connect(): void {
    if (this.stopped || !this.credentials) return;
    const url = validateRuntimeServer(this.credentials.server); url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = "/runtime/v1/connect";
    const socket = this.socket = this.options.socketFactory?.(url.href, this.credentials.credential)
      ?? new WebSocket(url.href, { headers: { Authorization: `Bearer ${this.credentials.credential}` }, followRedirects: false,
        maxPayload: MAX_FRAME, handshakeTimeout: 15_000, perMessageDeflate: false });
    this.welcomed = false;
    socket.on("open", () => {
      if (this.stopped || this.socket !== socket) { socket.close(); return; }
      this.send({ v: 1, type: "hello", bootId: this.bootId, name: this.credentials!.name, platform: process.platform,
        ...(process.platform === "win32" || this.options.createPaneHost ? { paneProtocol: 1 } : {}),
        ...(this.inventory ? { inventory: this.inventory } : {}) });
    });
    socket.on("message", (bytes, binary) => {
      const size = Array.isArray(bytes) ? bytes.reduce((sum, part) => sum + part.byteLength, 0) : bytes.byteLength;
      if (binary || size > MAX_FRAME || this.socket !== socket) { socket.close(1008, "Invalid runtime frame"); return; }
      void this.receive(bytes.toString()).catch(() => socket.close(1008, "Invalid runtime protocol"));
    });
    socket.on("error", () => { /* close is the single reconnection path; never log credential-bearing errors */ });
    socket.on("unexpected-response", (_req, response) => {
      response.resume();
      if (response.statusCode === 401 || response.statusCode === 403) {
        this.report("Runtime credential was refused. Re-pair after the machine is authorized.");
        void this.stop();
      } else socket.terminate();
    });
    socket.on("close", code => {
      if (this.socket !== socket) return;
      this.socket = null; this.welcomed = false;
      this.rejectTools();
      if (this.stopped) return;
      if (code === 1008) {
        this.report("Runtime connection was refused, revoked or replaced. Check pairing and protocol compatibility before reconnecting.");
        void this.stop(); return;
      }
      this.report("Disconnected. Existing execution is not replayed; reconnecting…");
      if (!this.graceTimer) this.graceTimer = setTimeout(() => {
        this.graceTimer = null;
        for (const id of this.active) { try { this.bridge.cancel(id); } catch { /* state reconciles in poll */ } }
        this.report("The coordinator remained disconnected; cancellation was requested for the active execution.");
      }, this.options.disconnectGraceMs ?? 45_000);
      this.graceTimer.unref?.();
      const base = Math.min(30_000, 2000 * 2 ** Math.min(this.reconnectAttempt++, 4));
      const delay = this.options.reconnectMs ?? Math.min(30_000, Math.round(base * (0.75 + Math.random() * 0.5)));
      this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this.connect(); }, delay);
      this.reconnectTimer.unref?.();
    });
  }
  private send(value: unknown): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    const frame = JSON.stringify(value);
    if (Buffer.byteLength(frame) > MAX_FRAME) throw new Error("Runtime frame limit exceeded");
    if (this.socket.bufferedAmount > 2 * MAX_FRAME) { this.socket.close(1013, "Runtime backpressure"); return; }
    this.socket.send(frame);
  }
  private async receive(text: string): Promise<void> {
    const value: unknown = JSON.parse(text);
    if (!object(value) || value.v !== 1 || typeof value.type !== "string") throw new Error("Unsupported runtime protocol");
    if (value.type === "welcome") {
      if (value.machineId !== this.credentials?.machineId || !Number.isSafeInteger(value.generation)) throw new Error("Runtime machine identity mismatch");
      this.welcomed = true;
      this.reconnectAttempt = 0;
      if (this.graceTimer) { clearTimeout(this.graceTimer); this.graceTimer = null; }
      this.report("Connected to AgEnD.");
      for (const job of this.options.store.list()) this.publish(job);
      return;
    }
    if (value.type === "revoked") { this.report("This machine was revoked by AgEnD."); await this.stop(); return; }
    if (!this.welcomed) throw new Error("Runtime handshake is incomplete");
    if (value.type === "ping") { this.send({ v: 1, type: "pong" }); return; }
    if (value.type === "tool.result") {
      if (typeof value.id !== "string") throw new Error("Invalid tool reply");
      const pending = this.pendingTools.get(value.id); if (!pending) return;
      clearTimeout(pending.timer); this.pendingTools.delete(value.id);
      if (value.ok === true) pending.accept(value.result); else pending.reject(new Error("AgEnD MCP request was refused"));
      return;
    }
    if (value.type === "pane.request") {
      if (Object.keys(value).some(key => !["v", "type", "id", "maxAgents", "request"].includes(key))
        || typeof value.id !== "string" || !validWindowsAgentId(value.id) || !Number.isInteger(value.maxAgents)
        || (value.maxAgents as number) < 1 || (value.maxAgents as number) > 16) throw Error("Invalid pane transport envelope");
      const request = validateRuntimePaneRequest(value.request);
      this.machinePaneLimit = value.maxAgents as number;
      try {
        const result = await (await this.panes()).request(request);
        this.send({ v: 1, type: "pane.response", id: value.id, ok: true, result });
      } catch (error) { this.send({ v: 1, type: "pane.response", id: value.id, ok: false, error: message(error) }); }
      return;
    }
    if (value.type !== "request" || typeof value.id !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(value.id)
      || typeof value.operation !== "string" || !object(value.payload)) throw new Error("Invalid runtime request");
    const command = value as unknown as Command;
    try { this.send({ v: 1, type: "response", id: command.id, ok: true, result: await this.operation(command.operation, command.payload) }); }
    catch (error) { this.send({ v: 1, type: "response", id: command.id, ok: false, error: message(error) }); }
  }
  private publish(job: RuntimeStoredJob): void { if (this.online()) this.send({ v: 1, type: "task", seq: job.seq, task: job.task }); }
  private panes(): Promise<RuntimePaneHost | RuntimePaneLink> {
    if (!this.paneOpening) {
      const output: RuntimePaneHostOptions["output"] = snapshot => { if (this.online()) this.send({ v: 1, type: "pane.output", snapshot }); };
      if (this.options.createPaneHost) this.paneOpening = import("./runtime-pane-store.js").then(({ RuntimePaneStore }) => {
        const store = new RuntimePaneStore(join(this.options.store.directory, "panes")); store.recoverInterrupted();
        return this.paneHost = this.options.createPaneHost!({ store, bootId: this.bootId, online: () => !this.stopped && this.online(), maxAgents: () => this.machinePaneLimit, output });
      });
      else this.paneOpening = import("./runtime-pane-link.js").then(({ RuntimePaneLink }) => RuntimePaneLink.open({
        directory: this.options.store.directory, server: this.credentials!.server, machineId: this.credentials!.machineId,
        online: () => !this.stopped && this.online(), maxAgents: () => this.machinePaneLimit, output,
      })).then(host => this.paneHost = host);
    }
    return this.paneOpening;
  }
  private update(task: WindowsCliTask): void {
    if (this.closed) return;
    const serialized = JSON.stringify(task);
    if (this.snapshots.get(task.id) === serialized) return;
    try {
      const job = this.options.store.update(task); this.snapshots.set(task.id, serialized); this.publish(job);
      if (task.finishedAt) { this.active.delete(task.id); this.closeMcp(task.id); }
    } catch {
      // A process whose state could not be committed must not continue accepting commands.
      this.report("Runtime execution state could not be saved. Stop and inspect the private runtime profile.");
      try { this.bridge.cancel(task.id); } catch { /* leave durable accepted state blocked */ }
      this.socket?.close(1011, "Runtime storage failed");
    }
  }
  private poll(): void { for (const id of this.active) { const task = this.bridge.get(id); if (task) this.update(task); } }
  private async refreshInventory(force = false): Promise<WindowsCliProbe> {
    const inventory = await this.bridge.probe({ force });
    this.inventory = inventory;
    if (this.online()) this.send({ v: 1, type: "inventory", inventory });
    return inventory;
  }
  /** Testable command surface. Mutation identity is committed before calling the native bridge. */
  async operation(operation: string, payload: Record<string, unknown>): Promise<unknown> {
    if (operation === "probe") {
      if (Object.keys(payload).some(key => key !== "force") || (payload.force !== undefined && typeof payload.force !== "boolean")) throw new Error("Invalid discovery request");
      return this.refreshInventory(payload.force === true);
    }
    if (operation === "workspace") {
      if (Object.keys(payload).some(key => key !== "agentId") || !validWindowsAgentId(payload.agentId)) throw new Error("Invalid workspace request");
      return { agentId: payload.agentId, cwd: await this.bridge.prepareWorkspace(payload.agentId) };
    }
    if (operation === "reconcile") {
      if (Object.keys(payload).length) throw new Error("Invalid reconciliation request");
      return { jobs: this.options.store.list().map(row => ({ seq: row.seq, task: row.task })) };
    }
    if (operation === "cancel" || operation === "recover") {
      if (typeof payload.runId !== "string" || Object.keys(payload).some(key => !["runId", ...(operation === "recover" ? ["confirmedStopped", "original"] : [])].includes(key))) throw new Error("Invalid execution operation");
      const stored = this.options.store.get(payload.runId);
      if (operation === "recover") {
        if (this.active.has(payload.runId)) throw new Error("The native execution is still connected; wait for cancellation");
        if (payload.confirmedStopped !== true) throw new Error("Confirm the execution stopped before recovery");
        const original = payload.original === undefined ? null : checkedRun(payload.original);
        if (original && original.task.requestId !== payload.runId) throw new Error("Recovery execution identity does not match the original run");
        const digest = original ? runtimeJobDigest(original) : null;
        if (stored && digest && stored.digest !== digest) throw new Error("Recovery arguments do not match the accepted execution");
        if (!stored) {
          if (!original || !digest) throw new Error("Unknown execution recovery needs its trusted original run");
          if (this.active.size) throw new Error("Wait for the active native execution before recovery");
          const task = original.task;
          // The coordinator may have durably submitted a run that never reached this client. Explicit manual
          // confirmation creates a terminal tombstone, never an execution, so a delayed retry cannot launch it.
          const accepted = this.options.store.accept({ id: task.requestId, cli: task.cli, cwd: task.cwd, sandbox: task.sandbox,
            ...(task.model ? { model: task.model } : {}), status: "failed", startedAt: Date.now(), finishedAt: Date.now(),
            outcomeConfirmed: true, output: "", error: "The unconfirmed execution was manually confirmed stopped before local acceptance; it will not be replayed." }, digest);
          this.publish(accepted.job); return accepted.job.task;
        }
        if (stored.task.finishedAt && stored.task.outcomeConfirmed === true) return stored.task;
        this.bridge.releaseUnknown(payload.runId);
        const job = this.options.store.recover(payload.runId, true); this.publish(job); return job.task;
      }
      if (!stored) throw new Error("Runtime execution not found");
      if (!this.active.has(payload.runId)) return stored.task;
      const task = this.bridge.cancel(payload.runId); this.update(task); return task;
    }
    if (operation !== "run") throw new Error("Unknown runtime operation");
    const run = checkedRun(payload), task = run.task;
    const digest = runtimeJobDigest(run);
    const accepted = this.options.store.accept({ id: task.requestId, cli: task.cli, cwd: task.cwd, sandbox: task.sandbox,
      ...(task.model ? { model: task.model } : {}), status: "starting", startedAt: Date.now(), output: "" }, digest);
    if (accepted.duplicate) return accepted.job.task;
    this.publish(accepted.job);
    try {
      const mcp = payload.mcp ? await this.openMcp(task.requestId, (payload.mcp as { tools: string[] }).tools) : undefined;
      if (this.stopped || !this.online()) throw new Error("Runtime disconnected before native execution started");
      this.active.add(task.requestId);
      const initial = this.bridge.start(task, () => !this.stopped && this.online(), {
        ...(payload.resumeSessionId ? { resumeSessionId: payload.resumeSessionId as string } : {}),
        ...(payload.context ? { context: payload.context as string } : {}), ...(mcp ? { mcp } : {}),
        onSettled: settled => this.update(settled),
      });
      this.update(initial); return this.options.store.get(task.requestId)!.task;
    } catch (error) {
      this.active.delete(task.requestId); this.closeMcp(task.requestId);
      const failed = { ...accepted.job.task, status: "failed" as const, error: message(error), finishedAt: Date.now(), outcomeConfirmed: true };
      this.update(failed); return failed;
    }
  }
  private async openMcp(runId: string, tools: string[]): Promise<NativeMcpConnection> {
    if (!this.mcpOpening) this.mcpOpening = new Promise<number>((accept, reject) => {
      const server = this.mcpServer = createServer((req, res) => {
        const reply = (status: number, value: unknown): void => { if (!res.writableEnded && !res.destroyed) { res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(value)); } };
        const header = req.headers["x-agend-native-token"];
        const entry = typeof header === "string" && /^[a-f0-9]{64}$/.test(header) ? this.mcpTokens.get(header) : undefined;
        if (req.method !== "POST" || req.url !== "/agent" || req.headers.origin !== undefined || req.headers.cookie !== undefined
          || !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress ?? "") || !entry
          || !this.active.has(entry.runId) || !this.online()) { req.resume(); reply(403, { error: "Runtime MCP capability is unavailable" }); return; }
        void jsonBody(req).then(async body => {
          if (!object(body) || body.op !== "native-mcp" || !["tools/list", "tools/call"].includes(String(body.method))
            || !object(body.params) || Object.keys(body).some(key => !["op", "method", "params", "callId"].includes(key))) throw new Error("Invalid runtime MCP request");
          if (body.method === "tools/call" && (!entry.tools.includes(String(body.params.name)) || !object(body.params.arguments)
            || typeof body.callId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(body.callId))) throw new Error("Runtime MCP tool is unavailable");
          const result = await this.toolCall(entry.runId, body);
          if (!this.active.has(entry.runId) || !this.online()) { reply(401, { error: "Runtime MCP capability expired" }); return; }
          if (Buffer.byteLength(JSON.stringify(result) ?? "") > MAX_TOOL) throw new Error("Runtime MCP result is too large");
          reply(200, result);
        }).catch(() => reply(403, { error: "Runtime MCP request was refused or its execution expired" }));
      });
      server.on("error", reject);
      server.listen(0, "127.0.0.1", () => { const address = server.address(); if (!address || typeof address === "string") { reject(new Error("Runtime MCP could not bind")); return; } this.mcpPort = address.port; accept(address.port); });
    });
    await this.mcpOpening;
    const token = randomBytes(32).toString("hex"); this.mcpTokens.set(token, { runId, tools: [...tools] });
    return { endpoint: `http://127.0.0.1:${this.mcpPort}/agent`, token, tools: [...tools] };
  }
  private closeMcp(runId: string): void { for (const [token, entry] of this.mcpTokens) if (entry.runId === runId) this.mcpTokens.delete(token); }
  private toolCall(runId: string, body: unknown): Promise<unknown> {
    if (!this.online()) return Promise.reject(new Error("Runtime is disconnected"));
    if (this.pendingTools.size >= 64) return Promise.reject(new Error("Runtime MCP call capacity reached"));
    const id = randomUUID();
    return new Promise((accept, reject) => {
      const timer = setTimeout(() => { this.pendingTools.delete(id); reject(new Error("AgEnD MCP request timed out")); }, 90_000); timer.unref?.();
      this.pendingTools.set(id, { accept, reject, timer });
      this.send({ v: 1, type: "tool.call", id, runId, body });
    });
  }
  private rejectTools(): void { for (const pending of this.pendingTools.values()) { clearTimeout(pending.timer); pending.reject(new Error("Runtime disconnected")); } this.pendingTools.clear(); }
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true; this.welcomed = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.graceTimer) clearTimeout(this.graceTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.reconnectTimer = null; this.graceTimer = null; this.pollTimer = null;
    this.rejectTools(); this.mcpTokens.clear(); this.bridge.close();
    const socket = this.socket; this.socket = null;
    if (socket) { socket.close(); if (socket.readyState !== WebSocket.CLOSED) socket.terminate(); }
    // A cancelled start may still finish its durable credential write. Do not release the profile to another writer.
    await this.startupRotation?.catch(() => {});
    await this.paneOpening?.then(host => host.stop()).catch(() => this.report("Pane cleanup is unconfirmed; its durable reservations remain held."));
    // Keep the profile lock until cancellation is confirmed or the journal is explicitly marked uncertain.
    const deadline = Date.now() + 5000;
    while (this.active.size && Date.now() < deadline) {
      this.poll();
      if (!this.active.size) break;
      await new Promise<void>(done => setTimeout(done, 50));
    }
    for (const id of this.active) {
      const old = this.options.store.get(id);
      if (old) this.update({ ...old.task, status: "failed", finishedAt: Date.now(), outcomeConfirmed: false,
        error: "Runtime stopped before native process shutdown was confirmed. Inspect processes before recovery." });
    }
    this.closed = true;
    if (this.mcpServer) { const server = this.mcpServer; this.mcpServer = null; server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); }
    this.unlock?.(); this.unlock = null;
    for (const done of this.stoppedListeners) done(); this.stoppedListeners.clear();
  }
}

async function post(server: URL, path: string, body: unknown, signal?: AbortSignal, credential?: string): Promise<{ status: number; data: Record<string, unknown> }> {
  const response = await fetch(new URL(path, server), { method: "POST", redirect: "error", headers: { "Content-Type": "application/json", ...(credential ? { Authorization: `Bearer ${credential}` } : {}) },
    body: JSON.stringify(body), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000) });
  let text = "", bytes = 0;
  if (response.body) for await (const part of response.body) { bytes += part.byteLength; if (bytes > MAX_TOOL) throw new Error("Runtime pairing response is too large"); text += new TextDecoder().decode(part); }
  let data: unknown; try { data = JSON.parse(text); } catch { throw new Error("Invalid runtime pairing response"); }
  if (!object(data)) throw new Error("Invalid runtime pairing response");
  return { status: response.status, data };
}
/** Caller holds the profile lock. Persist the candidate before wire; either credential can recover a lost response. */
export async function rotateRuntimeCredentials(input: { store: RuntimeClientStore; signal?: AbortSignal }): Promise<RuntimeCredentials> {
  let saved = input.store.credentials(); if (!saved) throw Error("Pair this runtime before rotating its credential");
  if (!saved.pendingCredential) {
    saved = { ...saved, pendingCredential: randomBytes(32).toString("hex") };
    input.store.saveCredentials(saved);
  }
  const server = validateRuntimeServer(saved.server), candidate = saved.pendingCredential!;
  for (const credential of [saved.credential, candidate]) {
    const response = await post(server, RUNTIME_ROTATE_PATH, { machineId: saved.machineId, credential: candidate }, input.signal, credential);
    if (response.status === 200 && response.data.status === "rotated" && response.data.machineId === saved.machineId) {
      const { pendingCredential: _, ...current } = saved;
      const completed = { ...current, credential: candidate }; input.store.saveCredentials(completed); return completed;
    }
    if (response.status !== 401 && response.status !== 429) break;
  }
  throw Error("Runtime credential rotation was not confirmed. The saved candidate is retained; retry rotate before connecting.");
}
export async function pairRuntime(input: { server: string; code: string; name: string; store: RuntimeClientStore; signal?: AbortSignal; report?: (text: string) => void; pollMs?: number }): Promise<RuntimeCredentials> {
  const server = validateRuntimeServer(input.server);
  if (!input.code.trim() || input.code.length > 256 || /[\x00-\x1f]/.test(input.code) || !input.name.trim() || input.name.length > 100) throw new Error("Enter a valid pairing code and machine name");
  const paired = await post(server, "/runtime/v1/pair", { code: input.code.trim(), name: input.name.trim(), platform: process.platform, hostname: hostname() }, input.signal);
  if (paired.status !== 201 || paired.data.status !== "pending" || typeof paired.data.machineId !== "string" || typeof paired.data.claimSecret !== "string") throw new Error(`Runtime pairing was refused (HTTP ${paired.status})`);
  const deadline = Math.min(Date.now() + 10 * 60_000, typeof paired.data.expiresAt === "number" ? paired.data.expiresAt : Infinity);
  const fingerprint = runtimeClaimFingerprint(paired.data.claimSecret);
  input.report?.(`Pairing fingerprint: ${fingerprint}. Compare it with AgEnD Settings → Runtime before approving this machine; waiting for approval…`);
  while (!input.signal?.aborted && Date.now() < deadline) {
    const claimed = await post(server, "/runtime/v1/claim", { machineId: paired.data.machineId, claimSecret: paired.data.claimSecret }, input.signal);
    if (claimed.status === 200 && claimed.data.status === "approved" && claimed.data.machineId === paired.data.machineId
      && typeof claimed.data.credential === "string" && /^[A-Za-z0-9._-]{16,256}$/.test(claimed.data.credential)) {
      const credentials = { server: server.origin, machineId: paired.data.machineId, credential: claimed.data.credential, name: input.name.trim() };
      input.store.saveCredentials(credentials); input.report?.("Runtime paired. Its machine credential was saved in the private local profile."); return credentials;
    }
    if (claimed.status !== 202 || claimed.data.status !== "pending") throw new Error(`Runtime approval was refused or expired (HTTP ${claimed.status})`);
    await new Promise<void>((accept, reject) => {
      const timer = setTimeout(() => { input.signal?.removeEventListener("abort", abort); accept(); }, input.pollMs ?? 1500);
      const abort = (): void => { clearTimeout(timer); reject(new Error("Runtime pairing cancelled")); };
      input.signal?.addEventListener("abort", abort, { once: true });
    });
  }
  throw new Error("Runtime pairing was cancelled or expired");
}
