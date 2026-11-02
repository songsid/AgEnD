/** Positive-only delivery proof over a runner-owned transcript. Never opens a coordinator path. */
import type { RuntimePanePort } from "./runtime-pane-port.js";
import type { TranscriptLook } from "./transcript-delta-reader.js";
import { transcriptDeltaNeedle, type TranscriptNeedle } from "./transcript-needles.js";
import { validatePaneTranscriptWireBatch, validateRuntimeTranscriptReference, type RuntimeTranscriptReference,
  type PaneTranscriptCursor, type PaneTranscriptWireBatch } from "./runtime-pane-transcript-protocol.js";
export type RuntimeTranscriptPort = Pick<RuntimePanePort, "readTranscript" | "isTranscriptObservationCurrent">;

/** Validate both the closed frame and its relation to the exact checkpoint requested. */
export function decodeRuntimeTranscriptBatch(raw: unknown, before: PaneTranscriptCursor): { batch: PaneTranscriptWireBatch; text: string } {
  const batch = validatePaneTranscriptWireBatch(raw, before.sessionId), after = batch.cursor;
  const data = Buffer.from(batch.data, "base64"), delta = after.offset - before.offset;
  if (delta < 0 || before.fileId && after.fileId !== before.fileId || data.length > delta || !batch.gap && data.length !== delta
    || batch.state === "pending" && (after.offset !== before.offset || after.fileId !== before.fileId || after.anchor !== before.anchor || after.skipping !== before.skipping)
    || delta === 0 && (after.anchor !== before.anchor || after.skipping !== before.skipping)) throw Error("Runtime transcript checkpoint response differs");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(data);
  if (text && !text.endsWith("\n")) throw Error("Runtime transcript response ended inside a record");
  // A malformed record may hide a turn boundary or a delivery marker: never skip it silently.
  for (const line of text.split(/\r?\n/)) if (line) {
    const record = JSON.parse(line);
    if (!record || typeof record !== "object" || Array.isArray(record)) throw Error("Runtime transcript contains a non-record");
  }
  return { batch, text };
}

export class RuntimeTranscriptDeltaReader {
  private reference: RuntimeTranscriptReference;
  private inFlight = false;
  private closed = false;
  private gap = false;
  constructor(private readonly port: RuntimeTranscriptPort, reference: RuntimeTranscriptReference, private readonly needle: TranscriptNeedle) {
    this.reference = validateRuntimeTranscriptReference(reference);
  }
  get readPosition(): number { return this.reference.cursor.offset; }
  close(): void { this.closed = true; }
  async look(): Promise<TranscriptLook> {
    if (this.closed || !this.port.isTranscriptObservationCurrent(this.reference)) return "unavailable";
    if (this.inFlight) return "pending";
    this.inFlight = true;
    const before = structuredClone(this.reference);
    let abandoned = false, timer: ReturnType<typeof setTimeout> | undefined;
    const current = (): boolean => !abandoned && !this.closed && this.port.isTranscriptObservationCurrent(before);
    const read = this.port.readTranscript(before.cursor, current).finally(() => { this.inFlight = false; });
    try {
      const got = await Promise.race([read, new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 250); timer.unref?.(); })]);
      if (got === null) { abandoned = true; return "pending"; }
      if (!current()) return "unavailable";
      const { batch, text } = decodeRuntimeTranscriptBatch(got, before.cursor);
      if (batch.state === "pending") return "pending";
      const proof = transcriptDeltaNeedle(text, before.provider, this.needle);
      this.reference = { ...before, cursor: batch.cursor }; this.gap ||= batch.gap;
      // A genuine complete user record after a gap remains positive evidence. Missing records prove no absence.
      return proof ?? (this.gap ? "unavailable" : "no-match");
    } catch { return "unavailable"; }
    finally { abandoned = true; clearTimeout(timer); void read.catch(() => {}); }
  }
}
