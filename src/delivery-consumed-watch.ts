/**
 * #1201: a late, quiet "consumed" signal for a delivery the CLI took into its own queue — a steer, or a hand-off into
 * a busy CLI's native queue. Such a delivery settles `delivered` (accepted into the CLI's input) or `uncertain` long
 * before the model reads it: Claude Code takes a queued message at the next tool boundary or when the turn ends, which
 * can be minutes later, and records it in its transcript then. The watcher reads the transcript from the attempt's
 * checkpoint and, on the delivery's exact marker in a consumed shape (transcriptDeltaDeliveryMarker: a user entry, or
 * Claude's absorbed-mid-turn queued command), records it through the outbox (DeliveryOutbox.markConsumed).
 *
 * Positive evidence only: a hit upgrades; a miss, an unreadable file, a fence or the end of the watch change nothing.
 *
 * It runs on the fleet's event loop, so it is built not to be felt there (#1235):
 * - every read is async and bounded: one look reads at most CONSUMED_WATCH.chunkBytes from where the previous one
 *   stopped, and a larger backlog continues on the following looks;
 * - only complete lines are parsed; a line longer than CONSUMED_WATCH.maxLineBytes (TUI logs can run megabytes
 *   without a newline) is skipped whole — it cannot be judged, so it proves nothing;
 * - the number of watches in the process (the fleet) is capped; one over the cap is logged and not started;
 * - a transcript that does not grow is looked at less and less often, and every watch ends after a fixed lifetime.
 */
import { open, stat } from "node:fs/promises";
import { transcriptDeltaDeliveryMarker } from "./delivery-reconciliation.js";
import type { ConsumedVia } from "./delivery-outbox.js";

export const CONSUMED_WATCH = {
  /** Watches alive at once across the fleet. */
  maxWatchers: 32,
  /** Bytes one look reads past its offset. */
  chunkBytes: 256 * 1024,
  /** A line this long cannot be parsed within one look's budget: skipped. */
  maxLineBytes: 256 * 1024,
  /** First interval between looks. */
  tickMs: 5_000,
  /** Interval while a backlog is being read (the file is ahead of the offset). */
  catchUpMs: 50,
  /** Consecutive looks with no growth before the interval doubles… */
  idleLooksBeforeBackoff: 6,
  /** …up to this. */
  maxTickMs: 60_000,
  /** A watch ends after this long whatever it saw. */
  lifetimeMs: 30 * 60_000,
};

export interface ConsumedWatchTarget {
  deliveryId: string;
  attemptNo: number;
  backend: string;
  path: string;
  offset: number;
  /** False once the attempt's CLI is no longer the one we wrote to (stop, pause, respawn): the watch ends quietly. */
  current(): boolean;
  /** The hit: record it (the outbox decides what it changes). */
  consumed(via: ConsumedVia, evidence: string): void;
  logger?: { info(obj: unknown, msg?: string): void; warn(obj: unknown, msg?: string): void; debug?(obj: unknown, msg?: string): void };
}

type Ended = "consumed" | "fenced" | "unavailable" | "expired" | "stopped";

/** One attempt's watch. Exported for its tests; the fleet starts watches through ConsumedWatchRegistry. */
export class ConsumedWatch {
  private offset: number;
  private carry: Buffer = Buffer.alloc(0);
  /** The current line overran maxLineBytes: discard bytes until the next newline. */
  private skippingLine = false;
  private idleLooks = 0;
  private interval = CONSUMED_WATCH.tickMs;
  private timer: NodeJS.Timeout | null = null;
  private readonly startedAt = Date.now();
  private ended = false;

  constructor(private readonly target: ConsumedWatchTarget, private readonly onEnd: (why: Ended) => void) {
    this.offset = target.offset;
  }

  start(): void { this.schedule(CONSUMED_WATCH.tickMs); }

  /** Where the next look reads from (tests). */
  get position(): number { return this.offset; }
  /** The interval between looks the watch is at now (tests). */
  get currentInterval(): number { return this.interval; }
  /** Bytes of an unfinished line held between looks — never more than CONSUMED_WATCH.maxLineBytes (tests). */
  get carriedBytes(): number { return this.carry.length; }

  stop(): void { this.end("stopped"); }

  private schedule(ms: number): void {
    if (this.ended) return;
    this.timer = setTimeout(() => { void this.look(); }, ms);
    this.timer.unref?.();
  }

  private end(why: Ended): void {
    if (this.ended) return;
    this.ended = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.onEnd(why);
  }

  /** One bounded look. Never throws; every outcome either schedules the next look or ends the watch. */
  async look(): Promise<void> {
    if (this.ended) return;
    try {
      if (!this.target.current()) return this.end("fenced");
      if (Date.now() - this.startedAt >= CONSUMED_WATCH.lifetimeMs) return this.end("expired");
      let size: number;
      try { size = (await stat(this.target.path)).size; } catch { return this.end("unavailable"); }
      if (size < this.offset) return this.end("unavailable"); // rotated or truncated below our offset
      if (size === this.offset) {
        if (++this.idleLooks >= CONSUMED_WATCH.idleLooksBeforeBackoff) {
          this.idleLooks = 0;
          this.interval = Math.min(this.interval * 2, CONSUMED_WATCH.maxTickMs);
        }
        return this.schedule(this.interval);
      }
      this.idleLooks = 0;
      const length = Math.min(CONSUMED_WATCH.chunkBytes, size - this.offset);
      const chunk = await readAt(this.target.path, this.offset, length);
      if (!chunk) return this.end("unavailable");
      this.offset += chunk.length;
      const found = this.scan(chunk);
      if (found) {
        if (!this.target.current()) return this.end("fenced");
        this.target.consumed(found.via, found.evidence);
        return this.end("consumed");
      }
      this.schedule(this.offset < size ? CONSUMED_WATCH.catchUpMs : this.interval);
    } catch (err) {
      this.target.logger?.warn({ err, deliveryId: this.target.deliveryId }, "Consumed-signal watch failed; it proves nothing either way");
      this.end("unavailable");
    }
  }

  /** Complete lines of this chunk (plus the carried start of a line), judged once each. */
  private scan(chunk: Buffer): { via: ConsumedVia; evidence: string } | null {
    let data = chunk;
    if (this.skippingLine) {
      const nl = data.indexOf(0x0a);
      if (nl < 0) return null;            // still inside the oversized line
      data = data.subarray(nl + 1);
      this.skippingLine = false;
    }
    const buffer = this.carry.length ? Buffer.concat([this.carry, data]) : data;
    const lastNl = buffer.lastIndexOf(0x0a);
    if (lastNl < 0) {
      this.carry = buffer;
    } else {
      this.carry = buffer.subarray(lastNl + 1);
      const complete = buffer.subarray(0, lastNl + 1).toString("utf8");
      const kind = transcriptDeltaDeliveryMarker(complete, this.target.backend, this.target.deliveryId);
      if (kind === "user") return { via: "turn", evidence: "transcript-consumed:user-entry" };
      if (kind === "absorbed") return { via: "mid_turn", evidence: "transcript-consumed:absorbed-mid-turn" };
    }
    if (this.carry.length > CONSUMED_WATCH.maxLineBytes) {
      this.carry = Buffer.alloc(0);
      this.skippingLine = true;
    }
    return null;
  }
}

async function readAt(path: string, offset: number, length: number): Promise<Buffer | null> {
  let fh;
  try { fh = await open(path, "r"); } catch { return null; }
  try {
    const buffer = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      const { bytesRead } = await fh.read(buffer, read, length - read, offset + read);
      if (bytesRead === 0) break;
      read += bytesRead;
    }
    return buffer.subarray(0, read);
  } catch {
    return null;
  } finally {
    await fh.close().catch(() => {});
  }
}

/** The fleet's watches (one process): started per attempt, capped, ended by their own look or by stopAll. */
export class ConsumedWatchRegistry {
  private readonly active = new Map<string, ConsumedWatch>();

  get size(): number { return this.active.size; }

  /** Starts a watch for this attempt; false when one runs already or the fleet is at the cap (logged). */
  start(target: ConsumedWatchTarget): boolean {
    const key = `${target.deliveryId}#${target.attemptNo}`;
    if (this.active.has(key)) return false;
    if (this.active.size >= CONSUMED_WATCH.maxWatchers) {
      target.logger?.warn({ deliveryId: target.deliveryId, active: this.active.size, cap: CONSUMED_WATCH.maxWatchers },
        "Consumed-signal watch not started: the fleet is at its watch cap (the delivery keeps its current state)");
      return false;
    }
    const watch = new ConsumedWatch(target, why => {
      this.active.delete(key);
      target.logger?.debug?.({ deliveryId: target.deliveryId, why }, "Consumed-signal watch ended");
    });
    this.active.set(key, watch);
    watch.start();
    return true;
  }

  /** For tests and shutdown: end every watch without a verdict. */
  stopAll(): void {
    for (const watch of [...this.active.values()]) watch.stop();
  }
}

export const consumedWatches = new ConsumedWatchRegistry();
