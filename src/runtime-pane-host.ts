import { RuntimePaneOutputBuffer } from "./runtime-pane-output.js";
import { RuntimeGeneralWorkspace, loadGeneralKnowledge } from "./runtime-general-workspace.js";
import { GeneralManagedFileError } from "./runtime-general-protocol.js";
/** Runner-owned, persistent CLI panes. A coordinator reconnect neither launches nor replays anything. */
import { randomUUID } from "node:crypto";
import type { IPty } from "node-pty";
import { RuntimePaneStore, type RuntimePaneRecord } from "./runtime-pane-store.js";
import { RuntimePaneScreen } from "./runtime-pane-screen.js";
import { PANE_EDIT_KEYS, validateRuntimePaneRequest, type RuntimePaneLaunch, type RuntimePaneRequest, type RuntimePaneSnapshot, type RuntimePaneOpenResult } from "./runtime-pane-protocol.js";
import { spawnNativePane } from "./runtime-pane-process.js";
import type { PaneMcpConnection } from "./windows-pane-mcp.js";
import type { NativePaneOwner } from "./runtime-pane-native.js";
import type { PaneMcpOwner } from "./runtime-pane-mcp-protocol.js";
import { NativePaneTranscriptReader, nativeClaudeSessionState, nativeCodexSessionState, nativePaneTranscriptRoots, type NativeClaudeSessionState } from "./runtime-pane-transcript.js";
import { CredentialProfileRefusal, credentialLoginRequired, withCredentialProfile } from "./runtime-credential-profiles.js";
import { nativeCliEnvironment } from "./windows-cli-worker.js";
import { validatePaneTranscriptBaseline, type PaneTranscriptBaseline, validatePaneTranscriptWireBatch, type PaneTranscriptCursor, type PaneTranscriptWireBatch } from "./runtime-pane-transcript-protocol.js";
export { persistentNativeArguments } from "./runtime-pane-native.js";

export type RuntimePaneProcess = Pick<IPty, "pid" | "write" | "resize" | "kill" | "pause" | "resume" | "onData" | "onExit"> & {
  onFailure?(listener: () => void): { dispose(): void };
};
export interface RuntimePaneHostOptions {
  store: RuntimePaneStore;
  bootId: string;
  systemBootId?: string;
  online(): boolean;
  maxAgents(): number;
  /** Internal local launch factory, never a field in the remote request. */
  spawn?(launch: RuntimePaneLaunch, owner: NativePaneOwner): Promise<RuntimePaneProcess>;
  mcpConnection?(owner: PaneMcpOwner, tools: string[]): PaneMcpConnection;
  /** Internal runner seam. A remote request never provides roots or a path. */
  transcript?(launch: RuntimePaneLaunch, sessionId: string): (Pick<NativePaneTranscriptReader, "read" | "close"> & Partial<Pick<NativePaneTranscriptReader, "baseline">>);
  sessionProof?(launch: RuntimePaneLaunch, sessionId: string, current: () => boolean): Promise<NativeClaudeSessionState>;
  /**
   * Local seam, never a request field: the folder of a credential profile that exists under this Runtime's own profile root, or a refusal.
   * Absent means this host cannot honour a profile, and a launch that names one is refused rather than started on the default account.
   */
  credentialHome?(cli: RuntimePaneLaunch["cli"], name: string): string;
  /** Asked once for each NEW launch that names a profile (never for a reattach): true = signed in. Anything else refuses the launch. */
  credentialLogin?(cli: RuntimePaneLaunch["cli"], home: string, name: string): Promise<boolean | null>;
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
  private readonly general: RuntimeGeneralWorkspace;
  constructor(private readonly options: RuntimePaneHostOptions) { this.general = new RuntimeGeneralWorkspace(options.store.directory); }
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
    if (request.action === "list") return { hostBootId: this.options.bootId, capabilities: { openDisposition: true, recovery: true, claudeSessionProof: true, codexSessionProof: true, generalWorkspace: true }, panes: this.list() };
    if (this.closing || !this.options.online() || !current()) throw Error("Pane runtime is disconnected");
    if (request.action === "general-workspace") {
      const installed = loadGeneralKnowledge(request.cli).hash;
      if (installed !== request.packHash) return { version: 1, bindingId: request.bindingId, instance: request.instance, cli: request.cli, packHash: installed, upgradeRequired: true };
      try {
        return this.general.prepare(request, current, cwd => !this.list().some(row => row.state !== "exited"
          && this.options.store.get(row.paneId)?.launch.cwd.toLowerCase() === cwd.toLowerCase()));
      } catch (err) {
        // Closed, fixed-asset diagnostics cross the transport; raw errors, paths and file contents never do.
        if (!(err instanceof GeneralManagedFileError)) throw err;
        return { version: 1, bindingId: request.bindingId, instance: request.instance, cli: request.cli, packHash: request.packHash, managedFile: err.file };
      }
    }
    if (request.action === "shutdown") {
      // No await between the inventory, admission fence and reply. An accepted/queued launch or an unknown
      // reservation prevents shutdown; disconnect/lease loss alone never tears down a persistent host.
      if (request.hostBootId !== this.options.bootId || this.queues.size || this.list().some(pane => pane.state !== "exited")) throw Error("Pane host still has live or unconfirmed work");
      this.closing = true;
      return { hostBootId: this.options.bootId, shutdown: true };
    }
    const id = request.action === "open" ? request.launch.paneId : request.paneId;
    const queue = this.queues.get(id) ?? { tail: Promise.resolve(), count: 0 };
    if (queue.count >= 16) throw Error("Pane operation queue is full");
    queue.count++; this.queues.set(id, queue);
    const operation = queue.tail.catch(() => {}).then(async () => {
      if (this.closing || !this.options.online() || !current()) throw Error("Pane runtime is disconnected");
      return request.action === "open" ? this.open(request) : request.action === "recover" ? this.recover(request) : this.operate(request, current);
    });
    queue.tail = operation;
    try { return await operation; }
    finally { if (--queue.count === 0 && this.queues.get(id) === queue) this.queues.delete(id); }
  }
  /** The profile folder for a launch that names one (checked, never created here); undefined when it names none. */
  private credentialHome(launch: RuntimePaneLaunch): string | undefined {
    if (launch.credentialProfile === undefined) return undefined;
    if (!this.options.credentialHome) throw new CredentialProfileRefusal("This pane host cannot select a credential profile. Close its panes so the Runtime starts a new host, then try again.");
    try { return this.options.credentialHome(launch.cli, launch.credentialProfile); }
    catch (error) { throw new CredentialProfileRefusal(error instanceof Error ? error.message : "Credential profile is unavailable"); }
  }
  private async admitCredentialProfile(launch: RuntimePaneLaunch): Promise<string | undefined> {
    const home = this.credentialHome(launch);
    if (home === undefined) return undefined;
    if (!this.options.credentialLogin) throw new CredentialProfileRefusal("This pane host cannot confirm a credential profile's sign-in, so nothing was started.");
    const loggedIn = await this.options.credentialLogin(launch.cli, home, launch.credentialProfile!);
    if (loggedIn !== true) throw new CredentialProfileRefusal(credentialLoginRequired(launch.cli, launch.credentialProfile!, loggedIn).message);
    if (this.closing) throw Error("Pane host stopped during launch");
    return home;
  }
  /** Transcripts and conversation proofs live under the profile's own folder; a launch without a profile keeps the Runtime's own roots. */
  private transcriptRoots(launch: RuntimePaneLaunch): ReturnType<typeof nativePaneTranscriptRoots> | undefined {
    const home = this.credentialHome(launch);
    return home ? nativePaneTranscriptRoots(withCredentialProfile(nativeCliEnvironment(), launch.cli, home)) : undefined;
  }
  private async open(request: Extract<RuntimePaneRequest, { action: "open" }>): Promise<RuntimePaneOpenResult> {
    const { launch, operationId } = request;
    const digest = RuntimePaneStore.digest(launch);
    const existing = this.options.store.get(launch.paneId);
    if (existing) {
      if (existing.openOperationId !== operationId || existing.openDigest !== digest) throw Error("Pane id already belongs to another launch");
      const live = this.live.get(launch.paneId);
      if (!live && existing.snapshot.state !== "exited") throw Error("Pane launch outcome is unknown; no replacement was started");
      return { ...structuredClone(live?.record.snapshot ?? existing.snapshot), reattached: true };
    }
    // Before any reservation: a profile that is missing or signed out here consumes no pane identity, so the same open works once it is fixed.
    const credentialHome = await this.admitCredentialProfile(launch);
    this.list();
    const rows = this.options.store.list();
    const limit = this.options.maxAgents();
    if (!Number.isInteger(limit) || limit < 1 || limit > 16) throw Error("Invalid machine pane limit");
    if (launch.launchId && rows.some(row => row.snapshot.launchId === launch.launchId)) throw Error("Pane launch identity already belongs to another pane");
    const record: RuntimePaneRecord = {
      ...(this.options.systemBootId ? { systemBootId: this.options.systemBootId } : {}),
      launch, openDigest: digest, openOperationId: operationId, bootId: this.options.bootId,
      snapshot: { hostBootId: this.options.bootId, paneId: launch.paneId, agentId: launch.agentId, instance: launch.instance, launchId: launch.launchId ?? randomUUID(), columns: launch.columns, rows: launch.rows,
        state: "starting", seq: 0, outputAt: 0, commandSequence: 0 },
    };
    const sessionId = launch.sessionId ?? (launch.cli === "claude-code" ? record.snapshot.launchId : undefined);
    if (sessionId) record.snapshot.sessionId = sessionId;
    if (rows.some(row => row.launch.agentId === launch.agentId && row.snapshot.state !== "exited")
      || rows.filter(row => row.snapshot.state !== "exited").length >= limit) {
      // A durable tombstone consumes this open identity. Even a lost refusal ACK cannot turn its retry into a launch.
      // Never issue this proof for a spawn exception: the factory may have created a child before throwing.
      record.snapshot.state = "exited"; record.snapshot.noLaunch = true;
      this.options.store.put(record);
      return { ...structuredClone(record.snapshot), reattached: false };
    }
    if (launch.generalWorkspace) this.general.verify({ action: "general-workspace", ...launch.generalWorkspace, instance: launch.instance, cli: launch.cli }, launch.cwd);
    // Synchronous reservation before the first await: parallel opens cannot oversubscribe the machine.
    this.options.store.put(record);
    let process: RuntimePaneProcess | undefined;
    try {
      const owner: NativePaneOwner = { directory: this.options.store.directory, launchId: record.snapshot.launchId, ...(credentialHome ? { credentialHome } : {}) };
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
        // Invalidate observations when bytes arrive, not later when the VT parser finishes. A queued repaint
        // already makes an old composer proof unsafe, even while capture or parser completion is awaiting.
        record.snapshot.seq++; record.snapshot.outputAt = Date.now();
        live.parsed = screen.write(data).then(() => {
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
      return { ...structuredClone(record.snapshot), reattached: false };
    } catch (error) {
      if (process) { try { process.kill(); } catch { /* retain uncertain reservation */ } }
      // A launch factory may fail after creating a native child. Only onExit proves there is no process.
      if (record.snapshot.state !== "exited") record.snapshot.state = "unknown";
      this.options.store.put(record);
      throw error;
    }
  }
  private recover(request: Extract<RuntimePaneRequest, { action: "recover" }>): RuntimePaneSnapshot {
    const record = this.options.store.get(request.paneId);
    if (!record || record.snapshot.launchId !== request.launchId || record.snapshot.hostBootId !== request.hostBootId) throw Error("Recovery needs the exact retained pane with no live host owner");
    if (record.snapshot.state === "exited") return structuredClone(record.snapshot);
    if (this.live.has(request.paneId) || record.snapshot.state !== "unknown" || record.bootId === this.options.bootId || request.confirmedStopped !== true) throw Error("The retained pane is not eligible for stopped-process recovery");
    record.snapshot.state = "exited"; record.snapshot.exitProof = "admin-confirmed";
    delete record.snapshot.exitCode; this.options.store.put(record);
    return structuredClone(record.snapshot);
  }
  private async operate(request: Exclude<RuntimePaneRequest, { action: "list" | "open" | "shutdown" | "recover" | "general-workspace" }>, current: () => boolean): Promise<unknown> {
    const live = this.live.get(request.paneId);
    const stored = this.options.store.get(request.paneId);
    if (!stored || stored.snapshot.launchId !== request.launchId) throw Error("Pane launch identity is stale");
    if (request.action === "snapshot") return structuredClone(live?.record.snapshot ?? stored.snapshot);
    if (request.action === "session-proof") {
      const { launch, snapshot } = live?.record ?? stored;
      if (!["claude-code", "codex"].includes(launch.cli) || snapshot.state !== "exited" || snapshot.noLaunch || !snapshot.sessionId) throw Error("Session proof requires an exited supported pane");
      let settled = false, timer: ReturnType<typeof setTimeout> | undefined;
      const lease = () => !settled && !this.closing && this.options.online() && current();
      const read = this.options.sessionProof
        ? this.options.sessionProof(launch, snapshot.sessionId, lease)
        : (launch.cli === "codex" ? nativeCodexSessionState : nativeClaudeSessionState)(launch.cwd, snapshot.sessionId, lease, this.transcriptRoots(launch));
      try {
        const state = await Promise.race([read, new Promise<"unknown">(done => { timer = setTimeout(() => done("unknown"), 1500); })]);
        return { snapshot: structuredClone(snapshot), state: lease() && ["absent", "saved", "unknown"].includes(state) ? state : "unknown" };
      } catch { return { snapshot: structuredClone(snapshot), state: "unknown" }; }
      finally { settled = true; clearTimeout(timer); void read.catch(() => {}); }
    }
    if (!live && request.action === "capture" && stored.snapshot.state === "exited") return { snapshot: structuredClone(stored.snapshot), text: "" };
    if (!live) throw Error("Pane process is not owned by this runner; its reservation is retained");
    const record = live.record;
    if (request.action === "output") return live.output.read(request.offset, record.snapshot.state === "exited");
    await live.parsed;
    if (request.action === "capture") {
      const seq=record.snapshot.seq,text=await live.screen.capture(request);
      if(seq!==record.snapshot.seq)throw Error("Pane changed during capture; observe it again");
      return {snapshot:structuredClone(record.snapshot),text};
    }
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
    delete record.snapshot.inputRefused;
    if((request.action==="input"||request.action==="key"||request.action==="edit")&&request.expectedSeq!==record.snapshot.seq){
      // Positively no input. Consume this command identity: a lost refusal ACK must never become a later key.
      record.snapshot.inputRefused=true;record.lastCommand.state="applied";this.options.store.put(record);return structuredClone(record.snapshot);
    }
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
    live.transcript ??= this.options.transcript?.(launch, snapshot.sessionId) ?? new NativePaneTranscriptReader(launch.cli, launch.cwd, snapshot.sessionId, this.transcriptRoots(launch));
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
