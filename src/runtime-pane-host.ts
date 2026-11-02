/** Runner-owned, persistent CLI panes. A coordinator reconnect neither launches nor replays anything. */
import { randomUUID } from "node:crypto";
import type { IPty } from "node-pty";
import { RuntimePaneStore, type RuntimePaneRecord } from "./runtime-pane-store.js";
import { RuntimePaneScreen } from "./runtime-pane-screen.js";
import { PANE_EDIT_KEYS, validateRuntimePaneRequest, type RuntimePaneLaunch, type RuntimePaneRequest, type RuntimePaneSnapshot } from "./runtime-pane-protocol.js";
import { spawnNativePane } from "./runtime-pane-process.js";
import type { PaneMcpConnection } from "./windows-pane-mcp.js";
import type { PaneMcpOwner } from "./runtime-pane-mcp-protocol.js";
export { persistentNativeArguments } from "./runtime-pane-native.js";

export type RuntimePaneProcess = Pick<IPty, "pid" | "write" | "resize" | "kill" | "pause" | "resume" | "onData" | "onExit"> & {
  onFailure?(listener: () => void): { dispose(): void };
};
export interface RuntimePaneHostOptions {
  store: RuntimePaneStore;
  bootId: string;
  online(): boolean;
  maxAgents(): number;
  /** Internal local launch factory, never a field in the remote request. */
  spawn?(launch: RuntimePaneLaunch): Promise<RuntimePaneProcess>;
  mcpConnection?(owner: PaneMcpOwner, tools: string[]): PaneMcpConnection;
  output?(snapshot: RuntimePaneSnapshot): void;
}
interface LivePane {
  record: RuntimePaneRecord;
  screen: RuntimePaneScreen;
  process: RuntimePaneProcess;
  parsed: Promise<void>;
  exited: Promise<void>;
  finish(): void;
}
const KEYS = { Enter: "\r", Escape: "\x1b", Up: "\x1b[A", Down: "\x1b[B", Right: "\x1b[C", Left: "\x1b[D", "C-c": "\x03", "C-q": "\x11" } as const;

export class RuntimePaneHost {
  private readonly live = new Map<string, LivePane>();
  private readonly queues = new Map<string, { tail: Promise<unknown>; count: number }>();
  private closing = false;
  constructor(private readonly options: RuntimePaneHostOptions) {}
  list(): RuntimePaneSnapshot[] {
    for (const row of this.options.store.list()) if (!this.live.has(row.launch.paneId)) this.options.store.reconcileExit(row.launch.paneId);
    return this.options.store.list().map(row => structuredClone(this.live.get(row.launch.paneId)?.record.snapshot ?? row.snapshot));
  }
  /** Exact live reservation; no PID adoption or scans of other panes. */
  owns(owner: PaneMcpOwner): boolean {
    if (this.closing || owner.hostBootId !== this.options.bootId) return false;
    try {
      const pane = this.live.get(owner.paneId)?.record.snapshot ?? this.options.store.get(owner.paneId)?.snapshot;
      return !!pane && pane.hostBootId === owner.hostBootId && pane.launchId === owner.launchId && pane.agentId === owner.agentId
        && pane.instance === owner.instance && (pane.state === "starting" || pane.state === "running");
    } catch { return false; }
  }
  async request(raw: unknown, current: () => boolean = () => true): Promise<unknown> {
    const request = validateRuntimePaneRequest(raw);
    if (request.action === "list") return { panes: this.list() };
    if (this.closing || !this.options.online() || !current()) throw Error("Pane runtime is disconnected");
    const id = request.action === "open" ? request.launch.paneId : request.paneId;
    const queue = this.queues.get(id) ?? { tail: Promise.resolve(), count: 0 };
    if (queue.count >= 16) throw Error("Pane operation queue is full");
    queue.count++; this.queues.set(id, queue);
    const operation = queue.tail.catch(() => {}).then(async () => {
      if (this.closing || !this.options.online() || !current()) throw Error("Pane runtime is disconnected");
      return request.action === "open" ? this.open(request) : this.operate(request, current);
    });
    queue.tail = operation;
    try { return await operation; }
    finally { if (--queue.count === 0 && this.queues.get(id) === queue) this.queues.delete(id); }
  }
  private async open(request: Extract<RuntimePaneRequest, { action: "open" }>): Promise<RuntimePaneSnapshot> {
    const { launch, operationId } = request;
    const digest = RuntimePaneStore.digest(launch);
    const existing = this.options.store.get(launch.paneId);
    if (existing) {
      if (existing.openOperationId !== operationId || existing.openDigest !== digest) throw Error("Pane id already belongs to another launch");
      const live = this.live.get(launch.paneId);
      if (!live && existing.snapshot.state !== "exited") throw Error("Pane launch outcome is unknown; no replacement was started");
      return structuredClone(live?.record.snapshot ?? existing.snapshot);
    }
    this.list();
    const rows = this.options.store.list();
    if (rows.some(row => row.launch.agentId === launch.agentId && row.snapshot.state !== "exited")) throw Error("This agent already has a live or uncertain pane");
    const limit = this.options.maxAgents();
    if (!Number.isInteger(limit) || limit < 1 || limit > 16) throw Error("Invalid machine pane limit");
    if (rows.filter(row => row.snapshot.state !== "exited").length >= limit) throw Error("Machine concurrent-agent limit reached");
    const record: RuntimePaneRecord = {
      launch, openDigest: digest, openOperationId: operationId, bootId: this.options.bootId,
      snapshot: { hostBootId: this.options.bootId, paneId: launch.paneId, agentId: launch.agentId, instance: launch.instance, launchId: randomUUID(), columns: launch.columns, rows: launch.rows,
        state: "starting", seq: 0, outputAt: 0, commandSequence: 0 },
    };
    // Synchronous reservation before the first await: parallel opens cannot oversubscribe the machine.
    this.options.store.put(record);
    let process: RuntimePaneProcess | undefined;
    try {
      process = await (this.options.spawn ? this.options.spawn(launch) : spawnNativePane(launch, { directory: this.options.store.directory, launchId: record.snapshot.launchId }));
      let finish!: () => void;
      const exited = new Promise<void>(resolve => { finish = resolve; });
      const screen = new RuntimePaneScreen(launch.columns, launch.rows, data => {
        if (this.live.get(launch.paneId)?.record === record && record.snapshot.state === "running") process!.write(data);
      });
      const live: LivePane = { record, process, screen, parsed: Promise.resolve(), exited, finish };
      this.live.set(launch.paneId, live);
      record.pid = process.pid;
      record.snapshot.state = "running";
      process.onFailure?.(() => {
        if (record.snapshot.state === "exited") return;
        record.snapshot.state = "unknown";
        try { this.options.store.put(record); } catch { /* retained on disk as unfinished */ }
      });
      process.onData(data => {
        if (this.live.get(launch.paneId) !== live) return;
        live.parsed = screen.write(data).then(() => {
          record.snapshot.seq++; record.snapshot.outputAt = Date.now();
          try { this.options.output?.(structuredClone(record.snapshot)); } catch { /* observer backpressure cannot change process ownership */ }
        }).catch(() => {
          record.snapshot.state = "unknown";
          try { process!.pause(); this.options.store.put(record); } catch { /* reserved until exit is proven */ }
        });
      });
      process.onExit(({ exitCode }) => {
        record.snapshot.state = "exited"; record.snapshot.exitCode = exitCode;
        try { this.options.store.put(record); } catch { /* an old live record stays reserved on restart */ }
        finish();
        try { this.options.output?.(structuredClone(record.snapshot)); } catch { /* process exit is independent of its observer */ }
        const retired = [...this.live.values()].filter(row => row.record.snapshot.state === "exited");
        for (const old of retired.slice(0, Math.max(0, retired.length - 16))) {
          old.screen.dispose(); this.live.delete(old.record.launch.paneId);
        }
      });
      this.options.store.put(record);
      if (this.closing) { process.kill(); throw Error("Pane host stopped during launch"); }
      return structuredClone(record.snapshot);
    } catch (error) {
      if (process) { try { process.kill(); } catch { /* retain uncertain reservation */ } }
      // A launch factory may fail after creating a native child. Only onExit proves there is no process.
      if (record.snapshot.state !== "exited") record.snapshot.state = "unknown";
      this.options.store.put(record);
      throw error;
    }
  }
  private async operate(request: Exclude<RuntimePaneRequest, { action: "list" | "open" }>, current: () => boolean): Promise<unknown> {
    const live = this.live.get(request.paneId);
    const stored = this.options.store.get(request.paneId);
    if (!stored || stored.snapshot.launchId !== request.launchId) throw Error("Pane launch identity is stale");
    if (!live) throw Error("Pane process is not owned by this runner; its reservation is retained");
    const record = live.record;
    await live.parsed;
    if (request.action === "capture") return { snapshot: structuredClone(record.snapshot), text: await live.screen.capture(request) };
    if (request.action === "reconcile") {
      if (record.snapshot.commandSequence !== request.sequence || record.lastCommand?.id !== request.operationId
        || record.lastCommand.digest !== request.digest || record.lastCommand.state !== "applied") throw Error("Pane command outcome is unconfirmed");
      return structuredClone(record.snapshot);
    }
    if (!current() || !this.options.online()) throw Error("Pane input lease expired");
    const digest = RuntimePaneStore.digest(request);
    if (request.sequence === record.snapshot.commandSequence) {
      if (record.lastCommand?.id !== request.operationId || record.lastCommand.digest !== digest) throw Error("Pane input sequence belongs to another command");
      if (record.lastCommand.state !== "applied") throw Error("Pane input outcome is unknown; it will not be replayed");
      return structuredClone(record.snapshot);
    }
    if (request.sequence !== record.snapshot.commandSequence + 1) throw Error("Pane input sequence is stale or has a gap");
    if (record.lastCommand?.state === "prepared" && request.action !== "close") throw Error("Previous pane input outcome is unknown");
    if (record.snapshot.state !== "running" && request.action !== "close") throw Error("Pane process is not confirmed running");
    record.snapshot.commandSequence = request.sequence;
    record.lastCommand = { id: request.operationId, digest, state: "prepared" };
    // Durable before input: a crash after this write must hold, never duplicate Enter.
    this.options.store.put(record);
    if (request.action === "input") live.process.write(request.kind === "paste" ? live.screen.bracketedPaste(request.text) : request.text);
    else if (request.action === "edit") live.process.write(request.keys.map(key => PANE_EDIT_KEYS[key]).join("").repeat(request.repeat ?? 1));
    else if (request.action === "key") live.process.write(KEYS[request.key]);
    else if (request.action === "resize") {
      live.process.resize(request.columns, request.rows); await live.screen.resize(request.columns, request.rows);
      record.snapshot.columns = request.columns; record.snapshot.rows = request.rows;
    } else {
      live.process.kill();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const stopped = await Promise.race([live.exited.then(() => true), new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), 10_000); })]);
      clearTimeout(timer);
      if (!stopped) record.snapshot.state = "unknown";
    }
    record.lastCommand.state = "applied";
    this.options.store.put(record);
    return structuredClone(record.snapshot);
  }
  async stop(): Promise<void> {
    this.closing = true;
    for (const live of this.live.values()) if (live.record.snapshot.state !== "exited") {
      try { live.process.kill(); } catch { live.record.snapshot.state = "unknown"; }
    }
    // Pending opens recheck admission and retire their own process; no new request can enter.
    await Promise.allSettled([...this.queues.values()].map(queue => queue.tail));
    // A request to close is not exit evidence. Keep native helpers alive until their job receipt or the bounded hold.
    const remaining = [...this.live.values()].filter(live => live.record.snapshot.state !== "exited");
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (remaining.length) await Promise.race([Promise.all(remaining.map(live => live.exited)), new Promise<void>(done => { timer = setTimeout(done, 10_000); })]);
    clearTimeout(timer);
    for (const live of this.live.values()) {
      if (live.record.snapshot.state !== "exited") live.record.snapshot.state = "unknown";
      try { this.options.store.put(live.record); } finally { live.screen.dispose(); }
    }
  }
}
