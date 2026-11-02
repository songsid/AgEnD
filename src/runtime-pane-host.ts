import { RuntimePaneOutputBuffer } from "./runtime-pane-output.js";
/** Runner-owned, persistent CLI panes. A coordinator reconnect neither launches nor replays anything. */
import { randomUUID } from "node:crypto";
import type { IPty } from "node-pty";
import { RuntimePaneStore, type RuntimePaneRecord } from "./runtime-pane-store.js";
import { RuntimePaneScreen } from "./runtime-pane-screen.js";
import { PANE_EDIT_KEYS, validateRuntimePaneRequest, type RuntimePaneLaunch, type RuntimePaneRequest, type RuntimePaneSnapshot } from "./runtime-pane-protocol.js";
import { spawnNativePane } from "./runtime-pane-process.js";
import type { PaneMcpConnection } from "./windows-pane-mcp.js";
import type { NativePaneOwner } from "./runtime-pane-native.js";
import type { PaneMcpOwner } from "./runtime-pane-mcp-protocol.js";
import { NativePaneTranscriptReader } from "./runtime-pane-transcript.js";
import { validatePaneTranscriptBaseline, type PaneTranscriptBaseline, validatePaneTranscriptWireBatch, type PaneTranscriptCursor, type PaneTranscriptWireBatch } from "./runtime-pane-transcript-protocol.js";
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
  spawn?(launch: RuntimePaneLaunch, owner: NativePaneOwner): Promise<RuntimePaneProcess>;
  mcpConnection?(owner: PaneMcpOwner, tools: string[]): PaneMcpConnection;
  /** Internal runner seam. A remote request never provides roots or a path. */
  transcript?(launch: RuntimePaneLaunch, sessionId: string): (Pick<NativePaneTranscriptReader, "read" | "close"> & Partial<Pick<NativePaneTranscriptReader, "baseline">>);
  output?(snapshot: RuntimePaneSnapshot): void;
}
interface LivePane {
  record: RuntimePaneRecord;
  screen: RuntimePaneScreen;
  process: RuntimePaneProcess;
  parsed: Promise<void>;
  output: RuntimePaneOutputBuffer;
  exited: Promise<void>;
  finish(): void;
  transcript?: (Pick<NativePaneTranscriptReader, "read" | "close"> & Partial<Pick<NativePaneTranscriptReader, "baseline">>);
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
    if (request.action === "list") return { hostBootId: this.options.bootId, panes: this.list() };
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
    if (launch.launchId && rows.some(row => row.snapshot.launchId === launch.launchId)) throw Error("Pane launch identity already belongs to another pane");
    const record: RuntimePaneRecord = {
      launch, openDigest: digest, openOperationId: operationId, bootId: this.options.bootId,
      snapshot: { hostBootId: this.options.bootId, paneId: launch.paneId, agentId: launch.agentId, instance: launch.instance, launchId: launch.launchId ?? randomUUID(), columns: launch.columns, rows: launch.rows,
        state: "starting", seq: 0, outputAt: 0, commandSequence: 0 },
    };
    const sessionId = launch.sessionId ?? (launch.cli === "claude-code" ? record.snapshot.launchId : undefined);
    if (sessionId) record.snapshot.sessionId = sessionId;
    // Synchronous reservation before the first await: parallel opens cannot oversubscribe the machine.
    this.options.store.put(record);
    let process: RuntimePaneProcess | undefined;
    try {
      const owner: NativePaneOwner = { directory: this.options.store.directory, launchId: record.snapshot.launchId };
      if (launch.mcpTools) {
        if (!this.options.mcpConnection) throw Error("Persistent pane MCP authority is unavailable");
        owner.mcp = this.options.mcpConnection({ hostBootId: this.options.bootId, paneId: launch.paneId, launchId: record.snapshot.launchId, agentId: launch.agentId, instance: launch.instance }, launch.mcpTools);
      }
      process = await (this.options.spawn ? this.options.spawn(launch, owner) : spawnNativePane(launch, owner));
      let finish!: () => void;
      const exited = new Promise<void>(resolve => { finish = resolve; });
      const screen = new RuntimePaneScreen(launch.columns, launch.rows, data => {
        if (this.live.get(launch.paneId)?.record === record && record.snapshot.state === "running") process!.write(data);
      });
      const live: LivePane = { record, process, screen, parsed: Promise.resolve(), output: new RuntimePaneOutputBuffer(), exited, finish };
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
        live.output.append(data);
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
          void old.transcript?.close().catch(() => {});
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
    if (request.action === "snapshot") return structuredClone(live?.record.snapshot ?? stored.snapshot);
    if (!live && request.action === "capture" && stored.snapshot.state === "exited") return { snapshot: structuredClone(stored.snapshot), text: "" };
    if (!live) throw Error("Pane process is not owned by this runner; its reservation is retained");
    const record = live.record;
    if (request.action === "output") return live.output.read(request.offset, record.snapshot.state === "exited");
    await live.parsed;
    if (request.action === "capture") return { snapshot: structuredClone(record.snapshot), text: await live.screen.capture(request) };
    if (request.action === "bind-session") {
      const expected = record.snapshot.sessionId ?? record.launch.sessionId ?? (record.launch.cli === "claude-code" ? record.snapshot.launchId : undefined);
      if (expected && expected !== request.sessionId) throw Error("Pane conversation identity is already pinned elsewhere");
      if (!expected) {
        if (record.snapshot.state !== "running") throw Error("An unowned pane cannot establish a conversation identity");
        const text = await live.screen.capture({ history: 200, joined: true });
        const ids = [...text.matchAll(/\bSession:\s*([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\b/gi)].map(match => match[1]);
        if (ids.length !== 1 || ids[0] !== request.sessionId) throw Error("The owned pane has no unique matching status identity");
      }
      if (!current() || !this.options.online() || this.closing) throw Error("Pane session binding lease expired");
      if (record.snapshot.sessionId !== request.sessionId) {
        record.snapshot.sessionId = request.sessionId;
        try { this.options.store.put(record); } catch (error) { delete record.snapshot.sessionId; throw error; }
      }
      return structuredClone(record.snapshot);
    }
    if (request.action === "transcript" || request.action === "transcript-baseline") return this.readTranscript(live, request.cursor, current, request.action === "transcript-baseline");
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
  private async readTranscript(live: LivePane, cursor: PaneTranscriptCursor, current: () => boolean, baseline = false): Promise<PaneTranscriptWireBatch | PaneTranscriptBaseline> {
    const { launch, snapshot } = live.record;
    if (!snapshot.sessionId || cursor.sessionId !== snapshot.sessionId) throw Error("Transcript identity differs from its owned pane");
    if (snapshot.state !== "running" && snapshot.state !== "exited") throw Error("Transcript pane ownership is unconfirmed");
    live.transcript ??= this.options.transcript?.(launch, snapshot.sessionId) ?? new NativePaneTranscriptReader(launch.cli, launch.cwd, snapshot.sessionId);
    let settled = false, timer: ReturnType<typeof setTimeout> | undefined;
    const lease = (): boolean => !settled && !this.closing && current() && this.options.online();
    const read = baseline ? live.transcript.baseline?.(cursor, lease) ?? Promise.resolve({ state: "pending" as const, cursor, complete: false, turnKnown: false, openTurn: null }) : live.transcript.read(cursor, lease);
    try {
      const batch = await Promise.race([read, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(Error("Pane transcript read deadline exceeded")), 1000); })]);
      if (!lease()) throw Error("Pane transcript read lease expired");
      if (baseline) return validatePaneTranscriptBaseline(batch, snapshot.sessionId);
      if (!("data" in batch)) throw Error("Pane transcript response has no records");
      return validatePaneTranscriptWireBatch({ state: batch.state, cursor: batch.cursor, data: batch.data, complete: batch.complete, gap: batch.gap }, snapshot.sessionId);
    } finally { settled = true; clearTimeout(timer); void read.catch(() => {}); }
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
      try { this.options.store.put(live.record); } finally { live.screen.dispose(); void live.transcript?.close().catch(() => {}); }
    }
  }
}
