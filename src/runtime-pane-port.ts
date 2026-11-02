/** Coordinator-side pane handle. Remote PIDs are never exposed as local supervision targets. */
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { atomicWriteFileSync } from "./atomic-write.js";
import { runtimeJobDigest } from "./runtime-client-store.js";
import { PANE_EDIT_KEYS, validateRuntimePaneRequest, validateRuntimePaneSnapshot, type PaneEditKey, type RuntimePaneCapture, type RuntimePaneLaunch, type RuntimePaneRequest, type RuntimePaneSnapshot } from "./runtime-pane-protocol.js";
import type { Pane, PaneHost, PaneKey, PaneObservation, PaneOutputEvent, PaneSize, PaneStatus } from "./pane-port.js";
import type { RuntimeCoordinatorEvent } from "./runtime-coordinator.js";
export interface PaneEndpoint {
  online(): boolean;
  call(request: RuntimePaneRequest): Promise<unknown>;
  subscribe(listener: (event: RuntimeCoordinatorEvent) => void): () => void;
  machineId: string;
}
interface OwnedPane { version: 1; machineId: string; launch: RuntimePaneLaunch; openId: string; snapshot?: RuntimePaneSnapshot; pending?: Extract<RuntimePaneRequest, { action: "reconcile" }> }
export class RuntimePanePort implements Pane {
  private record: OwnedPane;
  private tail: Promise<unknown> = Promise.resolve();
  private error: string | null = null;
  constructor(private endpoint: PaneEndpoint, private file: string, launch: RuntimePaneLaunch) {
    this.record = { version: 1, machineId: endpoint.machineId, launch, openId: randomUUID() };
    try {
      const stat = lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128 * 1024) throw Error("Unsafe coordinator pane receipt");
      const stored = JSON.parse(readFileSync(file, "utf8")) as OwnedPane;
      if (stored?.version !== 1 || stored.machineId !== endpoint.machineId || stored.launch?.agentId !== launch.agentId
        || stored.launch.instance !== launch.instance || runtimeJobDigest(stored.launch) !== runtimeJobDigest(launch)
        || !/^[a-f0-9-]{36}$/i.test(stored.openId)) throw Error("Coordinator pane receipt scope differs");
      if (stored.snapshot) validateRuntimePaneSnapshot(stored.snapshot);
      if (stored.pending) {
        const pending = validateRuntimePaneRequest(stored.pending);
        if (pending.action !== "reconcile" || !stored.snapshot || pending.paneId !== stored.snapshot.paneId
          || pending.launchId !== stored.snapshot.launchId || pending.sequence !== stored.snapshot.commandSequence + 1) throw Error("Pane command receipt scope differs");
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
      || this.record.snapshot && (snapshot.launchId !== this.record.snapshot.launchId || snapshot.hostBootId !== this.record.snapshot.hostBootId)
      || this.record.snapshot && snapshot.commandSequence < this.record.snapshot.commandSequence) throw Error("Pane ownership proof differs");
    return snapshot;
  }
  async open(): Promise<{ windowId: string; reattached: boolean }> {
    return this.serialize(async () => {
      const reattached = !!this.record.snapshot;
      this.save(); // The open identity exists before the runtime may spawn.
      const snapshot = this.accept(await this.endpoint.call({ action: "open", operationId: this.record.openId, launch: this.record.launch }));
      this.record.snapshot = snapshot; this.save();
      if (this.record.pending) {
        // Exact identity only. The host returns a prior applied result or holds an uncertain input; never resubmits it.
        const result = this.accept(await this.endpoint.call(this.record.pending));
        this.record.snapshot = result; delete this.record.pending; this.save();
      }
      if (snapshot.state !== "running") throw Error("Pane is not confirmed running");
      return { windowId: snapshot.paneId, reattached };
    });
  }
  private async mutate(make: (snapshot: RuntimePaneSnapshot) => RuntimePaneRequest): Promise<boolean> {
    return this.serialize(async () => {
      try {
        if (!this.endpoint.online() || !this.record.snapshot || this.record.pending) throw Error("Pane input needs reconciliation");
        const request = validateRuntimePaneRequest(make(this.record.snapshot));
        if (!("operationId" in request) || !("sequence" in request) || !("paneId" in request)) throw Error("Expected pane mutation");
        this.record.pending = { action: "reconcile", paneId: request.paneId, launchId: request.launchId,
          operationId: request.operationId, sequence: request.sequence, digest: runtimeJobDigest(request) }; this.save();
        const snapshot = this.accept(await this.endpoint.call(request));
        this.record.snapshot = snapshot; delete this.record.pending; this.save(); this.error = null;
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
  async killWindowConfirmed(): Promise<boolean> { return await this.mutate(snapshot => ({ action: "close", ...this.target(snapshot) })) && this.record.snapshot?.state === "exited"; }
  async isWindowAlive(): Promise<boolean> { const status = await this.getPaneStatus(); if (!status) throw Error("Native pane observation is unconfirmed"); return status.alive; }
  async setRemainOnExit(): Promise<void> { /* Exit receipts are always retained by the runtime. */ }
  async getPaneStatus(): Promise<PaneStatus | null> {
    try { await this.capture({}); return this.record.snapshot?.state === "unknown" ? null : { alive: this.record.snapshot?.state === "running", ...(this.record.snapshot?.exitCode !== undefined ? { exitCode: this.record.snapshot.exitCode } : {}) }; }
    catch { return null; }
  }
  async getWindowGeometry(): Promise<PaneSize & { mode: string }> {
    await this.capture({}); const snapshot = this.record.snapshot!; return { columns: snapshot.columns, rows: snapshot.rows, mode: "native-pane" };
  }
  async getPaneInputMode(): Promise<"unknown"> { return "unknown"; }
  sendKeys(text: string): Promise<boolean> { return this.mutate(snapshot => ({ action: "input", ...this.target(snapshot), kind: "literal", text })); }
  async sendKeySequence(keys: readonly string[]): Promise<boolean> {
    if (!keys.length || keys.length > 64 || keys.some(key => !Object.hasOwn(PANE_EDIT_KEYS, key))) return false;
    return this.mutate(snapshot => ({ action: "edit", ...this.target(snapshot), keys: [...keys] as PaneEditKey[] }));
  }
  sendSpecialKey(key: PaneKey): Promise<boolean> { return this.mutate(snapshot => ({ action: "key", ...this.target(snapshot), key })); }
  async deleteBackward(count: number): Promise<boolean> {
    if (!Number.isInteger(count) || count <= 0) return true;
    if (count > 8192) return false;
    return this.mutate(snapshot => ({ action: "edit", ...this.target(snapshot), keys: ["BSpace"], repeat: count }));
  }
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
  async pasteBuffer(text: string, opts: { guard?: () => boolean } = {}): Promise<boolean> {
    if (opts.guard && !opts.guard()) return false;
    return this.mutate(snapshot => {
      if (opts.guard && !opts.guard()) throw Error("Delivery admission expired");
      return { action: "input", ...this.target(snapshot), kind: "paste", text };
    });
  }
  async pipeOutput(): Promise<void> { throw Error("Native output streaming has not been attached"); }
  private async capture(options: { history?: number; ansi?: boolean; joined?: boolean }): Promise<string> {
    if (!this.endpoint.online() || !this.record.snapshot) throw Error("Pane observation is disconnected");
    const result = await this.endpoint.call({ action: "capture", paneId: this.record.launch.paneId, launchId: this.record.snapshot.launchId, ...options }) as RuntimePaneCapture;
    const snapshot = this.accept(result?.snapshot);
    if (typeof result.text !== "string") throw Error("Invalid pane capture");
    // Capturing while an input awaits its response must never erase that input's durable identity.
    if (!this.record.pending) this.record.snapshot = snapshot;
    return result.text;
  }
  // Match TmuxManager's ordinary capture-pane -p. VT replay serialization is not detector-ready text.
  capturePane(): Promise<string> { return this.capture({}); }
  capturePaneWithHistory(lines = 50): Promise<string> { return this.capture({ history: lines }); }
  capturePaneJoined(lines = 0): Promise<string> { return this.capture({ history: lines, joined: true }); }
  getWindowId(): string { return this.record.snapshot?.paneId ?? ""; }
  ownedSnapshot(): RuntimePaneSnapshot | null { return this.record.snapshot ? structuredClone(this.record.snapshot) : null; }
}

/** Passive output source. A disconnected link never proves idle; a reconnect resets all observation fences. */
export class RuntimePaneObservation extends EventEmitter implements PaneObservation {
  private remove: (() => void) | undefined;
  private resetAt = Date.now();
  private last = new Map<string, number>();
  private windows = new Set<string>();
  private wasOnline = false;
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
  }
  stop(): void { this.remove?.(); this.remove = undefined; this.last.clear(); this.windows.clear(); }
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
