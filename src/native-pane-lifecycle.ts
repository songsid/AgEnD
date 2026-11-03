/** Optional native adapter for the ordinary Daemon. The runner retains processes across coordinator detach. */
import type { CliBackend } from "./backend/types.js";
import { createNativePaneBackend } from "./backend/native-pane.js";
import type { Pane, PaneHost, PaneObservation } from "./pane-port.js";
import { RuntimePanePort, RuntimePaneHostPort, RuntimePaneObservation, type PaneEndpoint } from "./runtime-pane-port.js";
import { RuntimeTranscriptSource } from "./runtime-transcript-source.js";
import { RuntimeTranscriptDeltaReader } from "./runtime-transcript-delta-reader.js";
import type { RuntimeTranscriptPort } from "./runtime-transcript-delta-reader.js";
import { PANE_TRANSCRIPT_EMPTY_ANCHOR, type RuntimeTranscriptReference } from "./runtime-pane-transcript-protocol.js";
import type { TranscriptSource } from "./transcript-sources.js";
import type { TranscriptNeedle } from "./transcript-needles.js";
import type { RuntimePaneLaunch, RuntimePaneSnapshot } from "./runtime-pane-protocol.js";
export interface NativePaneAcquisition { pane: Pane; source: TranscriptSource; disposition: "reattached" | "resumed" | "fresh" }
export interface NativePaneLifecycle {
  bindDaemon?(daemon: import("./daemon.js").Daemon): void;
  readonly host: PaneHost;
  readonly observation: PaneObservation;
  readonly backend: CliBackend;
  acquire(assertCurrent: () => void): Promise<NativePaneAcquisition>;
  release(intent: "detach" | "close"): Promise<void>;
  proofReader(reference: RuntimeTranscriptReference, needle: TranscriptNeedle): RuntimeTranscriptDeltaReader;
  current(reference?: RuntimeTranscriptReference): boolean;
  mcpProof(): "alive" | "dead" | "unknown";
  checkpointSession(): void;
  snapshot?(): RuntimePaneSnapshot | null;
}
export interface NativePaneLifecycleOptions {
  endpoint: PaneEndpoint;
  receiptFile: string;
  launch: RuntimePaneLaunch;
  /** Checks switches, exact audited provider version, configuration, and the current daemon admission. */
  admit(): void;
  /** Must reserve the legacy profile activeId before the first remote spawn. */
  reserve(launchId: string): void;
  pin(launchId: string, sessionId: string): void;
  exited(snapshot: RuntimePaneSnapshot): void;
  mcpProof(): "alive" | "dead" | "unknown";
  releaseAuthority(): void;
  bindDaemon?(daemon: import("./daemon.js").Daemon): void;
}
export class RuntimeNativePaneLifecycle implements NativePaneLifecycle {
  readonly port: RuntimePanePort;
  readonly host: RuntimePaneHostPort;
  readonly observation: RuntimePaneObservation;
  readonly backend: CliBackend;
  private detached = false;
  private releasedExit = false;
  private source: RuntimeTranscriptSource | undefined;
  private readonly transcriptPort: RuntimeTranscriptPort;
  constructor(private options: NativePaneLifecycleOptions) {
    if (!options.launch.launchId) throw Error("Native daemon requires a reserved launch identity");
    this.port = new RuntimePanePort(options.endpoint, options.receiptFile, options.launch, screen => {
      const backend = this.backend;
      if ([...(backend.getStartupDialogs?.() ?? []), ...(backend.getRuntimeDialogs?.() ?? [])].some(dialog => dialog.pattern.test(screen) && (!dialog.isActive || dialog.isActive(screen)))) return false;
      return backend.readInputRow ? backend.readInputRow(screen) != null : backend.isDeliveryInputReadyPane?.(screen) === true;
    });
    this.transcriptPort = { isTranscriptObservationCurrent: reference => this.current(reference),
      readTranscriptBaseline: (cursor, current) => this.port.readTranscriptBaseline(cursor, () => !this.detached && (current?.() ?? true)),
      readTranscript: (cursor, current) => this.port.readTranscript(cursor, () => !this.detached && (current?.() ?? true)) };
    this.host = new RuntimePaneHostPort(this.port, options.endpoint);
    this.observation = new RuntimePaneObservation(options.endpoint, () => this.port.ownedSnapshot());
    this.backend = createNativePaneBackend(options.launch.cli, () => ({ sessionId: this.port.ownedSnapshot()?.sessionId ?? null,
      cwd: options.launch.cwd, contextPercentage: null, statusLineItems: ["context-remaining"], resumes: !!options.launch.sessionId || !!this.port.ownedSnapshot()?.sessionId }));
  }
  bindDaemon(daemon: import("./daemon.js").Daemon): void { this.options.bindDaemon?.(daemon); }
  current(reference?: RuntimeTranscriptReference): boolean {
    if (this.detached || !this.options.endpoint.online()) return false;
    if (reference) return this.port.isTranscriptObservationCurrent(reference);
    return this.port.ownedSnapshot()?.state === "running";
  }
  snapshot(): RuntimePaneSnapshot | null { return this.port.observedSnapshot(); }
  mcpProof(): "alive" | "dead" | "unknown" { return this.current() ? this.options.mcpProof() : "unknown"; }
  checkpointSession(): void {
    const pane = this.port.ownedSnapshot();
    if (pane?.sessionId) this.options.pin(pane.launchId, pane.sessionId);
  }
  private ready(text: string): boolean {
    const backend = this.backend;
    return (backend.isDeliveryInputReadyPane?.(text) ?? backend.getReadyPattern().test(text)) && !backend.getBusyPattern?.()?.test(text)
      && ![...(backend.getStartupDialogs?.() ?? []), ...(backend.getRuntimeDialogs?.() ?? [])].some(dialog => dialog.pattern.test(text) && (!dialog.isActive || dialog.isActive(text)));
  }
  private async codexIdentity(assertCurrent: () => void, reattached: boolean): Promise<void> {
    const expected = this.port.ownedSnapshot()?.sessionId;
    // A reattached live pane may be busy. Its durable pin is already tied to that same launch: never type /status into it.
    if (reattached) {
      if (expected) return;
      throw Error("Reattached native conversation is unconfirmed; retained status needs inspection, no startup input was sent");
    }
    // Output can invalidate a capture while the VT parser is settling. Retrying a read cannot replay input;
    // admission, the exact pane owner and the original wall-clock deadline still apply to every attempt.
    const observe = async (deadline: number, history = false): Promise<string> => {
      for (;;) {
        assertCurrent(); this.options.admit();
        try { const text = history ? await this.port.capturePaneJoined(200) : await this.port.capturePane(); assertCurrent(); return text; }
        catch (error) { assertCurrent(); this.options.admit(); if (!this.current() || performance.now() >= deadline) throw error; }
        await new Promise(resolve => setTimeout(resolve, 250));
      }
    };
    let text = "", until = performance.now() + 120_000;
    while (true) {
      text = await observe(until);
      if (this.ready(text)) break;
      if (performance.now() >= until) throw Error("Native Codex composer needs attention before conversation verification");
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    const readId = (pane: string): string | null => {
      const matches = [...pane.matchAll(/\bSession:\s*([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\b/gi)];
      return matches.length === 1 ? matches[0][1] : null;
    };
    let id: string | null = null;
    if (await this.port.beginStatusRequest()) {
      assertCurrent();
      // This fixed CLI command must be typed: a bracketed slash-command paste is literal prompt text in Codex.
      // Only a positive zero-input refusal admits another attempt; a lost response keeps the durable one-shot hold.
      const send = async (write: () => Promise<boolean>, message: string): Promise<void> => {
        for (let attempt = 0; attempt < 4; attempt++) {
          assertCurrent(); this.options.admit();
          if (!this.current()) throw Error(message);
          if (await write()) return;
          if (!this.port.lastInputWasNotSent() || attempt === 3) throw Error(message);
          await new Promise(resolve => setTimeout(resolve, 250));
        }
      };
      await send(() => this.port.sendKeys("/status"), "Native status input is unconfirmed");
      await new Promise(resolve => setTimeout(resolve, 500)); assertCurrent(); this.options.admit();
      await send(async () => {
        const screen = await observe(performance.now() + 15_000); assertCurrent(); this.options.admit();
        if (!this.ready(screen) || !/^[ \t]*[>›][ \t]*\/status[ \t]*$/m.test(screen)) throw Error("Native status composer changed; no Enter was sent");
        return this.port.sendSpecialKey("Enter", undefined, { kind: "composer", screen });
      }, "Native status submission is unconfirmed");
      until = performance.now() + 15_000;
      while (true) {
        text = await observe(until, true); id = readId(text);
        if (id && this.ready(text)) break;
        if (performance.now() >= until) throw Error("Native session status identity was not confirmed; no second Enter was sent");
        await new Promise(resolve => setTimeout(resolve, 250));
      }
    } else {
      id = readId(await observe(performance.now() + 15_000, true)); assertCurrent();
      if (!id) throw Error("Native session status request is retained; inspect its outcome before another input");
    }
    if (expected && id !== expected) throw Error("Native resume displayed a different conversation; its original pin is retained");
    await this.port.bindConversation(id); assertCurrent();
  }
  async acquire(assertCurrent: () => void): Promise<NativePaneAcquisition> {
    if (this.detached) throw Error("Native daemon lease was detached");
    assertCurrent(); this.options.admit(); this.options.reserve(this.options.launch.launchId!);
    const opened = await this.port.open(); assertCurrent(); this.options.admit();
    this.observation.start(); await this.observation.registerWindow(opened.windowId); assertCurrent();
    if (this.options.launch.cli === "codex") await this.codexIdentity(assertCurrent, opened.reattached);
    this.checkpointSession(); assertCurrent();
    const pane = this.port.ownedSnapshot(); if (!pane?.sessionId) throw Error("Native conversation is not pinned");
    this.source ??= new RuntimeTranscriptSource(this.transcriptPort, this.port.runtimeTranscriptReference({ sessionId: pane.sessionId, offset: 0, fileId: null, anchor: PANE_TRANSCRIPT_EMPTY_ANCHOR }), !this.options.launch.sessionId);
    return { pane: this.port, source: this.source, disposition: opened.reattached ? "reattached" : this.options.launch.sessionId ? "resumed" : "fresh" };
  }
  proofReader(reference: RuntimeTranscriptReference, needle: TranscriptNeedle): RuntimeTranscriptDeltaReader {
    if (!this.current(reference)) throw Error("Native delivery transcript owner is unavailable");
    return new RuntimeTranscriptDeltaReader(this.transcriptPort, reference, needle);
  }
  async release(intent: "detach" | "close"): Promise<void> {
    if (this.detached) {
      if (intent === "close" && !this.releasedExit) throw Error("Native close lease was detached; refresh its current owner first");
      return;
    }
    // Detaching revokes coordinator tool authority but preserves the runner, its helper and the profile reservation.
    if (intent === "close") {
      const pane = this.port.ownedSnapshot() ?? await this.port.inspectRetained();
      if (pane.state !== "exited" && !await this.port.killWindowConfirmed()) throw Error("Native pane exit is unconfirmed; its reservation is retained");
      const exited = this.port.ownedSnapshot(); if (exited && !this.releasedExit) { this.options.exited(exited); this.releasedExit = true; }
    }
    this.detached = true; this.port.closeOutput(); this.source?.close(); this.observation.stop(); this.options.releaseAuthority();
  }
}
