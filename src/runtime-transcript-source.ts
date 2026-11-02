/** Ordinary progress and turn events from the native runner's pinned session. No local path fallback. */
import type { TranscriptSource, TranscriptEvents } from "./transcript-sources.js";
import type { TranscriptTurnEvent } from "./transcript-turns.js";
import { codexTurnRecord, codexToolRecord, claudeTranscriptRecord, type CodexRecordState } from "./transcript-records.js";
import { decodeRuntimeTranscriptBatch, type RuntimeTranscriptPort } from "./runtime-transcript-delta-reader.js";
import { PANE_TRANSCRIPT_EMPTY_ANCHOR, validatePaneTranscriptBaseline, validateRuntimeTranscriptReference, type RuntimeTranscriptReference } from "./runtime-pane-transcript-protocol.js";
const empty = (): TranscriptEvents => ({ toolUses: [], toolResults: [], assistantTexts: [], records: [], turns: [] });
export class RuntimeTranscriptSource implements TranscriptSource {
  private reference: RuntimeTranscriptReference;
  private generation = 0;
  private stopped = false;
  private baseline = true;
  private followed = false;
  private deferred = false;
  private inFlight = false;
  private queue: Promise<unknown> = Promise.resolve();
  private state: CodexRecordState = { openTurnId: "", openTurn: null, turnKnown: false };
  private pendingTurns: TranscriptTurnEvent[] = [];
  private pending: TranscriptEvents = empty();
  private pendingBytes = 0;
  constructor(private readonly port: RuntimeTranscriptPort, reference: RuntimeTranscriptReference, private readonly allowDeferredFresh = false) {
    this.reference = validateRuntimeTranscriptReference(reference);
    if (this.reference.cursor.offset !== 0) throw Error("Native progress source requires a full baseline from its pinned session");
  }
  private serialized<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.catch(() => {}).then(work); this.queue = result; return result;
  }
  /** One bounded baseline look. Large existing transcripts continue baselining on polls, without replaying history. */
  async initialize(): Promise<void> { await this.serialized(async () => { await this.read(true); }); }
  following(): boolean { return this.followed && !this.stopped && this.port.isTranscriptObservationCurrent(this.reference); }
  turnStateKnown(): boolean { return this.following() && !this.baseline && this.state.turnKnown; }
  currentPath(): null { return null; }
  async checkpoint(): Promise<null> { return null; }
  takeTurns(): TranscriptTurnEvent[] { return this.pendingTurns.splice(0); }
  close(): void { this.stopped = true; this.generation++; this.followed = false; this.pending = empty(); this.pendingBytes = 0; this.pendingTurns = []; }
  reset(): void {
    this.generation++; this.stopped = false; this.baseline = true; this.followed = false;
    this.reference = { ...this.reference, cursor: { sessionId: this.reference.cursor.sessionId, offset: 0, fileId: this.reference.cursor.fileId,
      anchor: PANE_TRANSCRIPT_EMPTY_ANCHOR } }; this.deferred = false;
    this.state = { openTurnId: "", openTurn: null, turnKnown: false }; this.pending = empty(); this.pendingBytes = 0; this.pendingTurns = [];
  }
  async poll(): Promise<TranscriptEvents> {
    return this.serialized(async () => {
      const events = await this.read(false), queued = this.pending; this.pending = empty(); this.pendingBytes = 0;
      queued.toolUses.push(...events.toolUses); queued.toolResults.push(...events.toolResults); queued.assistantTexts.push(...events.assistantTexts);
      queued.records!.push(...events.records!); queued.turns!.push(...this.takeTurns(), ...events.turns!);
      return queued;
    });
  }
  /** Drain only a few frames; if work is still arriving, hold this delivery rather than paste against an old offset. */
  async runtimeCheckpoint(): Promise<RuntimeTranscriptReference | null> {
    return this.serialized(async () => {
      for (let n = 0; n < 8; n++) {
        // Keep bounded progress between checkpoint and next monitor poll. Never retain an unbounded history replay.
        if (this.pendingBytes > 512 * 1024 || this.pendingTurns.length + this.pending.toolUses.length + this.pending.toolResults.length + this.pending.assistantTexts.length + this.pending.records!.length > 2048) {
          this.followed = false; throw Error("Native transcript progress awaits its monitor poll");
        }
        const events = await this.read(false);
        this.pendingBytes += Buffer.byteLength(JSON.stringify(events));
        this.pending.toolUses.push(...events.toolUses); this.pending.toolResults.push(...events.toolResults); this.pending.assistantTexts.push(...events.assistantTexts);
        this.pending.records!.push(...events.records!); this.pendingTurns.push(...events.turns!);
        if (!this.baseline && (this.following() || this.deferred && this.reference.cursor.fileId === null
          && this.port.isTranscriptObservationCurrent(this.reference))) return structuredClone(this.reference);
      }
      return null;
    });
  }
  private async read(initial: boolean): Promise<TranscriptEvents> {
    if (this.stopped || !this.port.isTranscriptObservationCurrent(this.reference)) { this.followed = false; return empty(); }
    if (this.inFlight) { this.followed = false; return empty(); }
    const epoch = this.generation, before = structuredClone(this.reference);
    let abandoned = false, timer: ReturnType<typeof setTimeout> | undefined;
    const current = (): boolean => !abandoned && !this.stopped && epoch === this.generation && this.port.isTranscriptObservationCurrent(before);
    this.inFlight = true;
    const baselining = this.baseline && !!this.port.readTranscriptBaseline;
    const read = (baselining ? this.port.readTranscriptBaseline!(before.cursor, current) : this.port.readTranscript(before.cursor, current)).finally(() => { this.inFlight = false; });
    try {
      const raw = await Promise.race([read, new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 1000); timer.unref?.(); })]);
      if (raw === null) { this.followed = false; return empty(); }
      if (!current()) return empty();
      if (baselining) {
        const batch = validatePaneTranscriptBaseline(raw, before.cursor.sessionId);
        if (before.cursor.fileId && batch.cursor.fileId !== before.cursor.fileId || batch.cursor.offset < before.cursor.offset) throw Error("Native baseline identity differs");
        if (batch.state === "pending") {
          this.followed = false;
          if (initial && this.allowDeferredFresh && before.cursor.fileId === null) { this.baseline = false; this.deferred = true; }
          return empty();
        }
        this.reference = { ...before, cursor: batch.cursor }; this.baseline = false; this.followed = batch.complete; this.deferred = false;
        this.state = { turnKnown: batch.turnKnown, openTurn: batch.openTurn, openTurnId: batch.openTurn ?? "" };
        if (batch.openTurn) this.pendingTurns.push({ kind: "start", turnId: batch.openTurn });
        return empty();
      }
      const { batch, text } = decodeRuntimeTranscriptBatch(raw, before.cursor);
      if (batch.state === "pending") {
        this.followed = false;
        if (initial && this.allowDeferredFresh && before.cursor.fileId === null) { this.baseline = false; this.deferred = true; }
        return empty();
      }
      const events = empty(), wasBaseline = this.baseline;
      if (batch.gap) {
        if (!wasBaseline && this.state.openTurn) events.turns!.push({ kind: "retract", turnId: this.state.openTurn });
        this.state = { openTurnId: "", openTurn: null, turnKnown: false };
      } else if (before.cursor.offset === 0) this.state.turnKnown = true;
      for (const line of text.split(/\r?\n/)) if (line) {
        const entry = JSON.parse(line);
        if (before.provider === "codex") {
          // After a gap an orphan end proves no closed turn. Only a subsequent start re-establishes the ledger.
          const orphanEnd = !this.state.turnKnown && entry.type === "event_msg" && ["task_complete", "turn_aborted"].includes(entry.payload?.type);
          if (!orphanEnd) codexTurnRecord(entry, this.state, events.turns!);
          if (!wasBaseline) codexToolRecord(entry, events);
        } else if (!wasBaseline) claudeTranscriptRecord(entry, (...record) => events.records!.push(record));
      }
      this.reference = { ...before, cursor: batch.cursor }; this.followed = batch.complete; this.deferred = false;
      if (wasBaseline) {
        if (batch.complete) {
          this.baseline = false;
          if (this.state.openTurn) this.pendingTurns.push({ kind: "start", turnId: this.state.openTurn });
        }
        return empty();
      }
      return events;
    } catch (error) { if (epoch === this.generation) this.followed = false; throw error; }
    finally { abandoned = true; clearTimeout(timer); void read.catch(() => {}); }
  }
}
