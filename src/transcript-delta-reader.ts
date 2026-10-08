/**
 * #1379: read a CLI transcript forward from a delivery's checkpoint, looking for that delivery's own marker, in looks
 * that are bounded in bytes and in time — because the submission proof that uses it polls every 250 ms while holding
 * the pane lock and the delivery lane:
 * - one look reads at most TRANSCRIPT_PROOF_READ.chunkBytes past where the previous completed look stopped, and only
 *   complete lines are decoded, each held to maxLineBytes first (a longer one is skipped whole and proves nothing);
 * - one look settles within lookBudgetMs. A read that has not finished by then is abandoned: its result, when it does
 *   come, is dropped whole (neither its bytes nor its verdict are applied), and while it is still outstanding the next
 *   look reports "pending" rather than starting a second read.
 * Positive only: the verdict is this delivery's exact marker in a consumed or queued shape, or nothing.
 */
import { open, stat } from "node:fs/promises";
import { transcriptDeltaDeliveryMarker, type TranscriptMarkerKind } from "./delivery-reconciliation.js";

export const TRANSCRIPT_PROOF_READ = {
  /** Bytes one look reads past the reader's position. */
  chunkBytes: 256 * 1024,
  /** A line longer than this (without its newline) is never decoded: skipped. */
  maxLineBytes: 256 * 1024,
  /** A look settles within this; a slower read is abandoned and its late result dropped. */
  lookBudgetMs: 250,
};

export type TranscriptLook = TranscriptMarkerKind | "no-match" | "unavailable" | "pending";

export class TranscriptDeltaReader {
  private position: number;
  private carry: Buffer = Buffer.alloc(0);
  private skippingLine = false;
  private inFlight = false;

  constructor(private readonly path: string, offset: number, private readonly backend: string, private readonly deliveryId: string) {
    this.position = offset;
  }

  /** Where the next look reads from (tests). */
  get readPosition(): number { return this.position; }

  /** One bounded look. Never throws. */
  async look(): Promise<TranscriptLook> {
    if (this.inFlight) return "pending";
    this.inFlight = true;
    let abandoned = false;
    let timer: NodeJS.Timeout | undefined;
    const read = this.readChunk().finally(() => { this.inFlight = false; });
    const budget = new Promise<"timeout">(resolve => {
      timer = setTimeout(() => resolve("timeout"), TRANSCRIPT_PROOF_READ.lookBudgetMs);
      timer.unref?.();
    });
    try {
      const got = await Promise.race([read, budget]);
      if (got === "timeout") { abandoned = true; return "pending"; }
      if (got === "unavailable") return "unavailable";
      if (got === null) return "no-match";
      this.position += got.length;
      return this.scan(got) ?? "no-match";
    } catch {
      return "unavailable";
    } finally {
      if (timer) clearTimeout(timer);
      // An abandoned read's result is dropped whole when it lands: nothing above applied it.
      if (abandoned) read.catch(() => {});
    }
  }

  /** The next chunk past the position (null: nothing new), without touching the reader's state. */
  private async readChunk(): Promise<Buffer | null | "unavailable"> {
    let size: number;
    try { size = (await stat(this.path)).size; } catch { return "unavailable"; }
    if (size < this.position) return "unavailable"; // truncated or replaced below the checkpoint
    if (size === this.position) return null;
    const length = Math.min(TRANSCRIPT_PROOF_READ.chunkBytes, size - this.position);
    let fh;
    try { fh = await open(this.path, "r"); } catch { return "unavailable"; }
    try {
      const buffer = Buffer.alloc(length);
      let read = 0;
      while (read < length) {
        const { bytesRead } = await fh.read(buffer, read, length - read, this.position + read);
        if (bytesRead === 0) break;
        read += bytesRead;
      }
      return buffer.subarray(0, read);
    } catch {
      return "unavailable";
    } finally {
      await fh.close().catch(() => {});
    }
  }

  /** The complete lines of this chunk (and the carried start of one), each within the cap, judged once. */
  private scan(chunk: Buffer): TranscriptMarkerKind | null {
    let data = chunk;
    if (this.skippingLine) {
      const nl = data.indexOf(0x0a);
      if (nl < 0) return null;
      data = data.subarray(nl + 1);
      this.skippingLine = false;
    }
    const buffer = this.carry.length ? Buffer.concat([this.carry, data]) : data;
    const lastNl = buffer.lastIndexOf(0x0a);
    let found: TranscriptMarkerKind | null = null;
    if (lastNl < 0) {
      this.carry = buffer;
    } else {
      this.carry = buffer.subarray(lastNl + 1);
      const kept: Buffer[] = [];
      for (let start = 0; start <= lastNl;) {
        const nl = buffer.indexOf(0x0a, start);
        if (nl - start <= TRANSCRIPT_PROOF_READ.maxLineBytes) kept.push(buffer.subarray(start, nl + 1));
        start = nl + 1;
      }
      if (kept.length) found = transcriptDeltaDeliveryMarker(Buffer.concat(kept).toString("utf8"), this.backend, this.deliveryId) ?? null;
    }
    if (this.carry.length > TRANSCRIPT_PROOF_READ.maxLineBytes) {
      this.carry = Buffer.alloc(0);
      this.skippingLine = true;
    }
    return found;
  }
}
