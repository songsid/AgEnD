import { NativePaneOutputLog } from "./native-pane-output-log.js";
import { validatePaneOutputBatch } from "./runtime-pane-output.js";
/** Coordinator-side pane handle. Remote PIDs are never exposed as local supervision targets. */
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { atomicWriteFileSync } from "./atomic-write.js";
import { runtimeJobDigest } from "./runtime-client-store.js";
import { PANE_EDIT_KEYS, validateRuntimePaneRequest, validateRuntimePaneSnapshot, validateRuntimePaneOpenResult, type PaneEditKey, type RuntimePaneCapture, type RuntimePaneLaunch, type RuntimePaneRequest, type RuntimePaneSnapshot } from "./runtime-pane-protocol.js";
import type { Pane, PaneHost, PaneInputProof, PaneInputDiagnostic, PaneKey, PaneObservation, PaneOutputEvent, PaneSize, PaneStatus } from "./pane-port.js";
import type { RuntimeCoordinatorEvent } from "./runtime-coordinator.js";
import { validateRuntimeTranscriptReference, validatePaneTranscriptBaseline, type PaneTranscriptBaseline, validatePaneTranscriptWireBatch, sameRuntimeTranscriptScope, type PaneTranscriptCursor, type PaneTranscriptWireBatch, type RuntimeTranscriptReference } from "./runtime-pane-transcript-protocol.js";
export interface PaneEndpoint {
  online(): boolean;
  call(request: RuntimePaneRequest): Promise<unknown>;
  subscribe(listener: (event: RuntimeCoordinatorEvent) => void): () => void;
  machineId: string;
}
interface OwnedPane { version: 1; machineId: string; launch: RuntimePaneLaunch; openId: string; snapshot?: RuntimePaneSnapshot; statusRequested?: boolean;
  pending?: Extract<RuntimePaneRequest, { action: "reconcile" }>; pendingClose?: Extract<RuntimePaneRequest, { action: "close" }> }
export class RuntimePanePort implements Pane {
  private record: OwnedPane;
  private tail: Promise<unknown> = Promise.resolve();
  private error: string | null = null;
  private closing: Promise<boolean> | undefined;
  private outputLog: NativePaneOutputLog | undefined;
  private lastObservation: RuntimePaneSnapshot | undefined;
  private inputCapture: RuntimePaneCapture | undefined;
  private inputNotSent = false;
  private inputDiagnostic: PaneInputDiagnostic | null = null;
  private consecutiveRefusals = 0;
  private refusalLogger?: (details: PaneInputDiagnostic) => void;
  setInputRefusalLogger(log: (details: PaneInputDiagnostic) => void): void { this.refusalLogger = log; }
  getLastInputDiagnostic(): PaneInputDiagnostic | null { return this.inputDiagnostic ? { ...this.inputDiagnostic } : null; }
  constructor(private endpoint: PaneEndpoint, private file: string, launch: RuntimePaneLaunch, private inputIsComposer: (screen: string) => boolean = () => false) {
    this.record = { version: 1, machineId: endpoint.machineId, launch, openId: randomUUID() };
    try {
      const stat = lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128 * 1024) throw Error("Unsafe coordinator pane receipt");
      const stored = JSON.parse(readFileSync(file, "utf8")) as OwnedPane;
      if (stored?.version !== 1 || stored.machineId !== endpoint.machineId || stored.launch?.agentId !== launch.agentId
        || stored.launch.instance !== launch.instance || runtimeJobDigest(stored.launch) !== runtimeJobDigest(launch)
        || !/^[a-f0-9-]{36}$/i.test(stored.openId) || stored.statusRequested !== undefined && typeof stored.statusRequested !== "boolean") throw Error("Coordinator pane receipt scope differs");
      if (stored.snapshot) validateRuntimePaneSnapshot(stored.snapshot);
      if (stored.pending) {
        const pending = validateRuntimePaneRequest(stored.pending);
        if (pending.action !== "reconcile" || !stored.snapshot || pending.paneId !== stored.snapshot.paneId
          || pending.launchId !== stored.snapshot.launchId || pending.sequence !== stored.snapshot.commandSequence + 1) throw Error("Pane command receipt scope differs");
      }
      if (stored.pendingClose) {
        const close = validateRuntimePaneRequest(stored.pendingClose);
        if (close.action !== "close" || !stored.snapshot || close.paneId !== stored.snapshot.paneId || close.launchId !== stored.snapshot.launchId) throw Error("Pane close receipt scope differs");
      }
      this.record = stored;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  private save(): void { atomicWriteFileSync(this.file, JSON.stringify(this.record), { mode: 0o600 }); }
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.catch(() => {}).then(operation); this.tail = result; return result;
  }
  private accept(value: unknown): RuntimePaneSnapshot {
    const snapshot = validateRuntimePaneSnapshot(value);
    const launch = this.record.launch;
    if (launch.launchId !== undefined && snapshot.launchId !== launch.launchId || snapshot.paneId !== launch.paneId || snapshot.agentId !== launch.agentId || snapshot.instance !== launch.instance
      || launch.sessionId !== undefined && snapshot.sessionId !== launch.sessionId
      || launch.cli === "claude-code" && snapshot.sessionId !== (launch.sessionId ?? snapshot.launchId)
      || this.record.snapshot && (snapshot.launchId !== this.record.snapshot.launchId || snapshot.hostBootId !== this.record.snapshot.hostBootId)
      || this.record.snapshot?.sessionId && snapshot.sessionId !== this.record.snapshot.sessionId
      || this.record.snapshot && snapshot.commandSequence < this.record.snapshot.commandSequence) throw Error("Pane ownership proof differs");
    return snapshot;
  }
  async open(): Promise<{ windowId: string; reattached: boolean }> {
    return this.serialize(async () => {
      if (this.closing || this.record.pendingClose) throw Error("Pane close outcome is retained; inspect its exit before starting again");
      this.save(); // The open identity exists before the runtime may spawn.
      const { reattached, ...raw } = validateRuntimePaneOpenResult(await this.endpoint.call({ action: "open", operationId: this.record.openId, launch: this.record.launch }));
      if (this.record.snapshot && !reattached) throw Error("Retained pane was not reattached by its host");
      const snapshot = this.accept(raw);
      this.record.snapshot = snapshot; this.save();
      // Exit/no-launch proof settles even an interrupted input or close. It is never permission to replay either.
      if (snapshot.state === "exited") {
        delete this.record.pending; delete this.record.pendingClose; this.save();
        throw Error(snapshot.noLaunch ? "Pane admission refused before launch" : "Retained pane has exited");
      }
      if (this.record.pending) {
        // Exact identity only. The host returns a prior applied result or holds an uncertain input; never resubmits it.
        const result = this.accept(await this.endpoint.call(this.record.pending));
        this.record.snapshot = result; delete this.record.pending; this.save();
      }
      if (snapshot.state !== "running") throw Error("Pane is not confirmed running");
      return { windowId: snapshot.paneId, reattached };
    });
  }
  /** Read-only recovery of an open whose ACK was lost. Never sends open or starts a process. */
  async inspectRetained(): Promise<RuntimePaneSnapshot> {
    return this.serialize(async () => {
      const launch = this.record.launch;
      if (!this.endpoint.online() || !launch.launchId) throw Error("Retained native owner is unavailable");
      const result = await this.endpoint.call({ action: "snapshot", paneId: launch.paneId, launchId: launch.launchId });
      const snapshot = this.accept(result);
      if (!this.endpoint.online()) throw Error("Retained native observation became disconnected");
      this.record.snapshot = snapshot; this.save(); return structuredClone(snapshot);
    });
  }
  /** Idempotent metadata binding; it never types into the CLI or replays an input. */
  async bindConversation(sessionId: string): Promise<RuntimePaneSnapshot> {
    return this.serialize(async () => {
      const before = this.record.snapshot;
      if (!before || !this.endpoint.online() || this.closing || this.record.pending || this.record.pendingClose) throw Error("Pane session owner is unavailable or its input needs reconciliation");
      const request = validateRuntimePaneRequest({ action: "bind-session", paneId: before.paneId, launchId: before.launchId, sessionId });
      const snapshot = this.accept(await this.endpoint.call(request));
      if (!this.endpoint.online() || snapshot.sessionId !== sessionId) throw Error("Pane conversation binding is unconfirmed");
      this.record.snapshot = snapshot; this.save(); return structuredClone(snapshot);
    });
  }
  /** Intent before the one automatic /status. A lost coordinator must inspect its result, never type it twice. */
  beginStatusRequest(): Promise<boolean> {
    return this.serialize(async () => {
      if (!this.endpoint.online() || this.closing || this.record.pending || this.record.pendingClose || this.record.snapshot?.state !== "running") throw Error("Status request owner is unconfirmed");
      if (this.record.statusRequested) return false;
      this.record.statusRequested = true; this.save(); return true;
    });
  }
  runtimeTranscriptReference(cursor: PaneTranscriptCursor): RuntimeTranscriptReference {
    const pane = this.record.snapshot;
    if (!pane?.sessionId || pane.sessionId !== cursor.sessionId) throw Error("Pane transcript conversation is not pinned");
    return validateRuntimeTranscriptReference({ version: 1, machineId: this.endpoint.machineId, hostBootId: pane.hostBootId,
      paneId: pane.paneId, launchId: pane.launchId, agentId: pane.agentId, provider: this.record.launch.cli, cursor });
  }
  async readTranscript(cursor: PaneTranscriptCursor, current: () => boolean = () => true): Promise<PaneTranscriptWireBatch> {
    const ref = this.runtimeTranscriptReference(cursor);
    if (!this.isTranscriptObservationCurrent(ref) || !current()) throw Error("Pane transcript observation is disconnected");
    const result = await this.endpoint.call({ action: "transcript", paneId: ref.paneId, launchId: ref.launchId, cursor: ref.cursor });
    if (!this.isTranscriptObservationCurrent(ref) || !current()) throw Error("Pane transcript observation became stale");
    return validatePaneTranscriptWireBatch(result, ref.cursor.sessionId);
  }
  async readTranscriptBaseline(cursor: PaneTranscriptCursor, current: () => boolean = () => true): Promise<PaneTranscriptBaseline> {
    const ref = this.runtimeTranscriptReference(cursor);
    if (!this.isTranscriptObservationCurrent(ref) || !current()) throw Error("Pane baseline observation is disconnected");
    const result = await this.endpoint.call({ action: "transcript-baseline", paneId: ref.paneId, launchId: ref.launchId, cursor: ref.cursor });
    if (!this.isTranscriptObservationCurrent(ref) || !current()) throw Error("Pane baseline observation became stale");
    return validatePaneTranscriptBaseline(result, ref.cursor.sessionId);
  }
  isTranscriptObservationCurrent(ref: RuntimeTranscriptReference): boolean {
    try {
      const pane = this.record.snapshot;
      return this.endpoint.online() && !this.closing && !this.record.pendingClose && !!pane && (pane.state === "running" || pane.state === "exited")
        && sameRuntimeTranscriptScope(ref, this.runtimeTranscriptReference(ref.cursor));
    } catch { return false; }
  }
  private async mutate(make: (snapshot: RuntimePaneSnapshot, expectedSeq: number) => RuntimePaneRequest, proof?: PaneInputProof, input = true): Promise<boolean> {
    return this.serialize(async () => {
      this.inputNotSent = false;
      try {
        if (!this.endpoint.online() || this.closing || this.record.snapshot?.state !== "running" || this.record.pending || this.record.pendingClose) throw Error("Pane input needs reconciliation");
        let expectedSeq = this.record.snapshot.seq;
        if (input) {
          // Internal delivery proof comes from the daemon's recognised runtime-dialog veto (#2990 policy).
          // Human dialog proof remains identity/cursor-bound. Composer-only and unproved callers keep the reader check.
          // Every policy still needs the exact last capture and carries its output seq to the host.
          let capture = proof ? this.inputCapture : undefined;
          if (!proof) {
            // A read refused during repaint precedes every mutation identity/write. Retry READS only, never input.
            const deadline = performance.now() + 2000;
            for (let attempt = 0; attempt < 5; attempt++) {
              if (!this.endpoint.online() || this.closing || this.record.pendingClose || this.record.snapshot?.state !== "running") break;
              try { capture = await this.captureCurrent(); } catch { /* No input request has been built or sent. */ }
              if (performance.now() >= deadline) { capture = undefined; break; }
              if (capture) break;
              if (attempt < 4) await new Promise(done => setTimeout(done, 100));
            }
            if (!capture) { this.inputNotSent = true; this.error = "Pane observation unavailable; no input was sent"; return false; }
          }
          if (!capture || (!capture.text.trim() && proof?.kind !== "delivery") || proof && capture.text !== proof.screen
            || (proof?.kind !== "dialog" && proof?.kind !== "delivery" && !this.inputIsComposer(capture.text))) {
            this.inputNotSent = true; this.error = "Pane input withheld: the intended composer or dialog is not verified"; return false;
          }
          expectedSeq = capture.snapshot.seq;
          if (!this.endpoint.online() || this.closing || this.record.pendingClose || this.record.snapshot?.state !== "running") return false;
        }
        const request = validateRuntimePaneRequest(make(this.record.snapshot, expectedSeq));
        if (proof?.kind === "delivery" && (request.action !== "key" || request.key !== "Enter")) throw Error("Delivery proof is only valid for Enter");
        if (!("operationId" in request) || !("sequence" in request) || !("paneId" in request)) throw Error("Expected pane mutation");
        this.record.pending = { action: "reconcile", paneId: request.paneId, launchId: request.launchId,
          operationId: request.operationId, sequence: request.sequence, digest: runtimeJobDigest(request) }; this.save();
        if (request.action === "input" || request.action === "key" || request.action === "edit") {
          this.inputDiagnostic = { expectedSeq: request.expectedSeq, observedSeq: null, operationId: request.operationId,
            commandSequence: request.sequence, action: request.action, retryCount: proof?.retryCount ?? this.consecutiveRefusals };
        }
        const snapshot = this.accept(await this.endpoint.call(request));
        this.record.snapshot = snapshot; delete this.record.pending; this.save(); this.error = null;
        if (this.inputDiagnostic?.operationId === request.operationId) this.inputDiagnostic.observedSeq = snapshot.seq;
        if (snapshot.inputRefused) {
          this.inputNotSent = true; this.error = "Pane changed after observation; input was not sent";
          if (request.action === "input" || request.action === "key" || request.action === "edit") {
            this.inputDiagnostic = { expectedSeq: request.expectedSeq, observedSeq: snapshot.seq, operationId: request.operationId,
              commandSequence: request.sequence, action: request.action, retryCount: proof?.retryCount ?? this.consecutiveRefusals };
            this.consecutiveRefusals++;
            try { this.refusalLogger?.({ ...this.inputDiagnostic }); } catch { /* Diagnostics never change a positive zero-input ACK. */ }
          }
          return false;
        }
        this.consecutiveRefusals = 0;
        return true;
      } catch { this.error = "Pane input outcome is unconfirmed; reconnect and inspect before retrying"; return false; }
    });
  }
  private target(snapshot: RuntimePaneSnapshot): { paneId: string; launchId: string; operationId: string; sequence: number } {
    return { paneId: snapshot.paneId, launchId: snapshot.launchId, operationId: randomUUID(), sequence: snapshot.commandSequence + 1 };
  }
  async createWindow(): Promise<string> { throw Error("Native panes require a typed configured launch, never a shell command"); }
  async respawnWindow(): Promise<void> { throw Error("Native pane replacement requires confirmed owned exit and a new launch receipt"); }
  async killWindow(): Promise<void> { if (!await this.killWindowConfirmed()) throw Error("Native pane exit is unconfirmed"); }
  async killWindowConfirmed(): Promise<boolean> {
    if (this.closing) return this.closing;
    this.closing = this.closeOwned().finally(() => { this.closing = undefined; });
    return this.closing;
  }
  private async closeOwned(): Promise<boolean> {
    try {
      const before = this.record.snapshot;
      if (!before) return false;
      // A prior exact host exit receipt remains positive proof after disconnect. It is never inferred from a lost link.
      if(this.lastObservation?.state==="exited"){
        const exited=this.accept(this.lastObservation);this.record.snapshot=exited;delete this.record.pending;delete this.record.pendingClose;this.save();return true;
      }
      if (!this.endpoint.online()) return false;
      const snapshot = this.accept(await this.endpoint.call({ action: "snapshot", paneId: before.paneId, launchId: before.launchId }));
      if (snapshot.state === "exited") {
        this.record.snapshot = snapshot; delete this.record.pending; delete this.record.pendingClose; this.save(); return true;
      }
      if (!this.record.pendingClose) {
        // Independent of an uncertain input RPC. Capture runs behind any accepted write on the host's pane queue.
        this.record.pendingClose = { action: "close", ...this.target(snapshot) }; this.save();
      }
      const result = this.accept(await this.endpoint.call(this.record.pendingClose));
      if (result.state !== "exited") return false;
      this.record.snapshot = result; delete this.record.pending; delete this.record.pendingClose; this.save();
      return true;
    } catch { this.error = "Pane close outcome is unconfirmed; its reservation is retained"; return false; }
  }
  async isWindowAlive(): Promise<boolean> { const status = await this.getPaneStatus(); if (!status) throw Error("Native pane observation is unconfirmed"); return status.alive; }
  async setRemainOnExit(): Promise<void> { /* Exit receipts are always retained by the runtime. */ }
  async getPaneStatus(): Promise<PaneStatus | null> {
    try {
      const before = this.record.snapshot; if (!before || !this.endpoint.online()) return null;
      const snapshot = this.accept(await this.endpoint.call({ action: "snapshot", paneId: before.paneId, launchId: before.launchId }));
      if (!this.endpoint.online()) return null; this.lastObservation = snapshot;
      return snapshot.state === "running" || snapshot.state === "exited" ? { alive: snapshot.state === "running", ...(snapshot.exitCode !== undefined ? { exitCode: snapshot.exitCode } : {}) } : null;
    } catch { return null; }
  }
  async getWindowGeometry(): Promise<PaneSize & { mode: string }> {
    await this.capture({}); const snapshot = this.record.snapshot!; return { columns: snapshot.columns, rows: snapshot.rows, mode: "native-pane" };
  }
  async getPaneInputMode(): Promise<"unknown"> { return "unknown"; }
  sendKeys(text: string, proof?: PaneInputProof): Promise<boolean> { return this.mutate((snapshot, expectedSeq) => ({ action: "input", ...this.target(snapshot), expectedSeq, kind: "literal", text }), proof); }
  async sendKeySequence(keys: readonly string[]): Promise<boolean> {
    if (!keys.length || keys.length > 64 || keys.some(key => !Object.hasOwn(PANE_EDIT_KEYS, key))) return false;
    return this.mutate((snapshot, expectedSeq) => ({ action: "edit", ...this.target(snapshot), expectedSeq, keys: [...keys] as PaneEditKey[] }));
  }
  sendSpecialKey(key: PaneKey, _timeoutMs?: number, proof?: PaneInputProof): Promise<boolean> { return this.mutate((snapshot, expectedSeq) => ({ action: "key", ...this.target(snapshot), expectedSeq, key }), proof); }
  async deleteBackward(count: number): Promise<boolean> {
    if (!Number.isInteger(count) || count <= 0) return true;
    if (count > 8192) return false;
    return this.mutate((snapshot, expectedSeq) => ({ action: "edit", ...this.target(snapshot), expectedSeq, keys: ["BSpace"], repeat: count }));
  }
  lastInputWasNotSent(): boolean { return this.inputNotSent && !this.record.pending; }
  getLastSendSpecialKeyError(): string | null { return this.error; }
  getLastPasteError(): string | null { return this.error; }
  isLastPasteFailureRecoverable(): boolean { return false; }
  async pasteText(text: string): Promise<boolean> {
    if (!await this.pasteBuffer(text)) return false;
    // Same settle margin as TmuxManager: Codex otherwise keeps the Enter inside its input/paste burst.
    // Exactly one Enter; an uncertain submission must never be "fixed" with a second bare Enter.
    await new Promise(resolve => setTimeout(resolve, 500));
    return this.sendSpecialKey("Enter");
  }
  async pasteBuffer(text: string, opts: { guard?: () => boolean; proof?: PaneInputProof } = {}): Promise<boolean> {
    if (opts.guard && !opts.guard()) return false;
    return this.mutate((snapshot, expectedSeq) => {
      if (opts.guard && !opts.guard()) throw Error("Delivery admission expired");
      return { action: "input", ...this.target(snapshot), expectedSeq, kind: "paste", text };
    }, opts.proof);
  }
  async pipeOutput(logPath: string): Promise<void> {
    this.closeOutput(); const snapshot = this.record.snapshot;
    if (!snapshot) throw Error("Native output owner is missing");
    const owner = runtimeJobDigest({ machine: this.endpoint.machineId, host: snapshot.hostBootId, pane: snapshot.paneId, launch: snapshot.launchId });
    const feed = new NativePaneOutputLog(logPath, owner, () => this.outputLog === feed && this.endpoint.online() && this.record.snapshot?.hostBootId === snapshot.hostBootId && this.record.snapshot?.launchId === snapshot.launchId,
      async offset => validatePaneOutputBatch(await this.endpoint.call({ action: "output", paneId: snapshot.paneId, launchId: snapshot.launchId, offset }), offset));
    this.outputLog = feed; try { await feed.start(); } catch (error) { this.closeOutput(); throw error; }
  }
  closeOutput(): void { this.outputLog?.stop(); this.outputLog = undefined; }
  private async captureCurrent(options: { history?: number; ansi?: boolean; joined?: boolean } = {}): Promise<RuntimePaneCapture> {
    if (!this.endpoint.online() || !this.record.snapshot) throw Error("Pane observation is disconnected");
    const result = await this.endpoint.call({ action: "capture", paneId: this.record.launch.paneId, launchId: this.record.snapshot.launchId, ...options }) as RuntimePaneCapture;
    const snapshot = this.accept(result?.snapshot);
    if (!this.endpoint.online() || typeof result.text !== "string") throw Error("Invalid or disconnected pane capture");
    // Capturing while an input awaits its response must never erase that input's durable identity.
    if (!this.record.pending) this.record.snapshot = snapshot;
    const capture = { snapshot, text: result.text };
    if (!options.history && !options.joined && !options.ansi) this.inputCapture = capture;
    return capture;
  }
  private async capture(options: { history?: number; ansi?: boolean; joined?: boolean }): Promise<string> {
    return (await this.captureCurrent(options)).text;
  }
  // Match TmuxManager's ordinary capture-pane -p. VT replay serialization is not detector-ready text.
  capturePane(): Promise<string> { return this.capture({}); }
  capturePaneWithHistory(lines = 50): Promise<string> { return this.capture({ history: lines }); }
  capturePaneJoined(lines = 0): Promise<string> { return this.capture({ history: lines, joined: true }); }
  getWindowId(): string { return this.record.snapshot?.paneId ?? ""; }
  /** A fresh authenticated endpoint proved the exact retained exit; retire an obsolete local relay without IO. */
  async recordConfirmedExit(raw: RuntimePaneSnapshot, current: () => void): Promise<void> {
    await this.serialize(async () => {
      current(); const snapshot = this.accept(raw);
      if (snapshot.state !== "exited") throw Error("Native exit evidence is not positive");
      this.record.snapshot = snapshot; this.lastObservation = snapshot; this.save();
    });
  }
  observedSnapshot(): RuntimePaneSnapshot | null { return this.lastObservation ? structuredClone(this.lastObservation) : this.ownedSnapshot(); }
  ownedSnapshot(): RuntimePaneSnapshot | null { return this.record.snapshot ? structuredClone(this.record.snapshot) : null; }
}

/** Passive output source. A disconnected link never proves idle; a reconnect resets all observation fences. */
export class RuntimePaneObservation extends EventEmitter implements PaneObservation {
  private remove: (() => void) | undefined;
  private resetAt = Date.now();
  private last = new Map<string, number>();
  private windows = new Set<string>();
  private wasOnline = false;
  private sweep: ReturnType<typeof setInterval> | undefined;
  constructor(private endpoint: PaneEndpoint, private owned: (id: string) => RuntimePaneSnapshot | null, private idleMs = 300) { super(); }
  start(): void {
    if (this.remove) return;
    this.wasOnline = this.endpoint.online();
    this.remove = this.endpoint.subscribe(event => {
      if (event.machineId !== this.endpoint.machineId) return;
      if (event.type === "machine") {
        const online = this.endpoint.online();
        if (online !== this.wasOnline) { this.wasOnline = online; this.resetAt = Date.now(); this.last.clear(); }
        return;
      }
      if (event.type !== "pane" || !event.pane || !this.windows.has(event.pane.paneId)) return;
      const expected = this.owned(event.pane.paneId);
      if (!expected || expected.launchId !== event.pane.launchId || expected.hostBootId !== event.pane.hostBootId || expected.agentId !== event.pane.agentId) return;
      const at = Date.now(); this.last.set(event.pane.paneId, at);
      this.emit(`output:${event.pane.paneId}`, { paneId: event.pane.paneId, windowId: event.pane.paneId, at } satisfies PaneOutputEvent);
    });
    // The ordinary daemon needs a second quiet capture (and recovery after a transient failed capture), even if
    // the CLI emits no further output. Like the tmux control client's sweep, this requests reads only: it is not
    // output or positive idle evidence, and a disconnected endpoint must remain blind.
    this.sweep = setInterval(() => { if (!this.isObservationBlind()) this.emit("safety_sweep"); }, 5_000);
    this.sweep.unref?.();
  }
  stop(): void { if (this.sweep) clearInterval(this.sweep); this.sweep = undefined; this.remove?.(); this.remove = undefined; this.last.clear(); this.windows.clear(); }
  async registerWindow(id: string): Promise<void> { this.windows.add(id); this.resetAt = Date.now(); }
  unregisterWindow(id: string): void { this.windows.delete(id); this.last.delete(id); }
  getObservationResetAt(): number { return this.resetAt; }
  isObservationBlind(): boolean { return !this.remove || !this.endpoint.online(); }
  isIdle(id: string): boolean { const last = this.last.get(id); return !this.isObservationBlind() && last !== undefined && Date.now() - last >= this.idleMs; }
  getLastOutputAt(id: string): number | undefined { return this.isObservationBlind() ? undefined : this.last.get(id); }
  hasOutputSince(id: string, ts: number): boolean { return !this.isObservationBlind() && (this.last.get(id) ?? 0) > ts; }
  private async wait(predicate: () => boolean, timeout = 10_000, abandoned?: () => boolean): Promise<boolean> {
    const end = performance.now() + timeout;
    while (performance.now() < end) { if (abandoned?.() || this.isObservationBlind()) return false; if (predicate()) return true; await new Promise(done => setTimeout(done, 25)); } return false;
  }
  waitForIdle(id: string, timeout?: number): Promise<boolean> { return this.wait(() => this.isIdle(id), timeout); }
  waitUntilIdle(id: string, timeout?: number, abandoned?: () => boolean): Promise<boolean> { return this.wait(() => this.isIdle(id), timeout, abandoned); }
  waitForOutput(id: string, timeout?: number): Promise<boolean> { const start = Date.now(); return this.wait(() => this.hasOutputSince(id, start), timeout); }
}

/** One configured agent's host facade. Session/PID APIs never cross the machine boundary as local process evidence. */
export class RuntimePaneHostPort implements PaneHost {
  readonly executionHost = "remote" as const;
  constructor(readonly pane: RuntimePanePort, private endpoint: PaneEndpoint) {}
  bind(_session: string, id: string): Pane {
    if (id && id !== this.pane.getWindowId()) throw Error("Pane selector is outside this agent's launch");
    return this.pane;
  }
  async ensureSession(): Promise<void> { if (!this.endpoint.online()) throw Error("Native pane machine is offline"); }
  async sessionExists(): Promise<boolean> { return this.endpoint.online(); }
  async sessionExistsStrict(): Promise<boolean> { if (!this.endpoint.online()) throw Error("Native pane machine observation is unknown"); return true; }
  async killSession(): Promise<void> { await this.pane.killWindow(); }
  async getServerPid(): Promise<null> { return null; }
  async listWindows(): Promise<Array<{ id: string; name: string }>> {
    const owned = this.pane.ownedSnapshot(); if (!owned) return [];
    const result = await this.endpoint.call({ action: "list" }) as { panes?: unknown[] };
    if (!Array.isArray(result?.panes)) throw Error("Invalid pane list");
    const matched = result.panes.map(validateRuntimePaneSnapshot).find(row => row.paneId === owned.paneId);
    if (!matched) throw Error("Owned pane is missing; replacement requires reconciliation");
    if (matched.agentId !== owned.agentId || matched.launchId !== owned.launchId || matched.hostBootId !== owned.hostBootId || matched.state === "unknown") throw Error("Owned pane identity is unconfirmed");
    return matched.state === "exited" ? [] : [{ id: matched.paneId, name: matched.instance }];
  }
  listWindowsStrict(): Promise<Array<{ id: string; name: string }>> { return this.listWindows(); }
  async getPanePid(): Promise<null> { return null; }
  async listPanePids(): Promise<Array<{ pid: number; window: string }>> { return []; }
}
