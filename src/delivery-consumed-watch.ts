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
 * - only complete lines are parsed, each held to CONSUMED_WATCH.maxLineBytes before it is decoded; a longer one (TUI logs
 *   can run megabytes without a newline) is skipped whole — complete or not — and proves nothing; the lines after it
 *   are still judged;
 * - the number of watches in the process (the fleet) is capped; one over the cap is logged and not started;
 * - a transcript that does not grow is looked at less and less often, and every watch ends after a fixed lifetime,
 *   measured on the monotonic clock and checked again after every await (a read that returns late proves nothing).
 */
import { open, stat } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { transcriptDeltaDeliveryMarker, transcriptDeltaMarkerKind } from "./delivery-reconciliation.js";
import type { ConsumedVia } from "./delivery-outbox.js";
import { measureSyncWork } from "./sync-work-attribution.js";
import type { TranscriptLook } from "./transcript-delta-reader.js";

export const CONSUMED_WATCH = {
  /** Watches alive at once across the fleet. */
  maxWatchers: 32,
  /** Bytes one look reads past its offset. */
  chunkBytes: 256 * 1024,
  /** A line longer than this (without its newline) is never decoded: skipped. */
  maxLineBytes: 256 * 1024,
  /** First interval between looks. */
  tickMs: 5_000,
  /** Interval while a backlog is being read (the file is ahead of the offset). */
  catchUpMs: 50,
  /** Consecutive looks with no growth before the interval doubles… */
  idleLooksBeforeBackoff: 6,
  /** …up to this. */
  maxTickMs: 60_000,
  /** A watch ends after this long (monotonic) whatever it saw. */
  lifetimeMs: 30 * 60_000,
  /**
   * #3030: a watch that can tell when its CLI went idle ends "not taken" once the CLI has stayed idle this long with
   * the whole transcript read and no consumed marker: a queued message is submitted when the turn ends, so an idle CLI
   * that still has not written it did not take it.
   */
  notTakenIdleMs: 90_000,
};

interface ConsumedWatchCommon {
  deliveryId: string;
  attemptNo: number;
  backend: string;
  /** False once the attempt's CLI is no longer the one we wrote to (stop, pause, respawn): the watch ends quietly. */
  current(): boolean;
  /** The hit: record it (the outbox decides what it changes). */
  consumed(via: ConsumedVia, evidence: string): void;
  /** #3030: the leading marker to look for; default the delivery's own `[agend-delivery-id:<deliveryId>]`. */
  marker?: string;
  /**
   * #3030: how long (ms, monotonic) the CLI has been idle without a break, or null while it is busy or unknown. With
   * `notTaken`, an idle stretch of CONSUMED_WATCH.notTakenIdleMs after the transcript was read to its end, and no
   * consumed marker, ends the watch "not-taken".
   */
  idleForMs?(): number | null;
  notTaken?(): void;
  /** How long this watch lives (monotonic); default CONSUMED_WATCH.lifetimeMs. */
  lifetimeMs?: number;
  logger?: { info(obj: unknown, msg?: string): void; warn(obj: unknown, msg?: string): void; debug?(obj: unknown, msg?: string): void };
}
export type ConsumedWatchTarget = ConsumedWatchCommon & (
  | { path: string; offset: number; reader?: never }
  | { path?: never; offset?: never; reader: { look(): Promise<TranscriptLook>; readonly readPosition: number; close?(): void } }
);

type Ended = "consumed" | "fenced" | "unavailable" | "expired" | "stopped" | "not-taken";

/** One attempt's watch. Exported for its tests; the fleet starts watches through ConsumedWatchRegistry. */
export class ConsumedWatch {
  private offset: number;
  private carry: Buffer = Buffer.alloc(0);
  /** The current line overran maxLineBytes: discard bytes until the next newline. */
  private skippingLine = false;
  private idleLooks = 0;
  private interval = CONSUMED_WATCH.tickMs;
  private timer: NodeJS.Timeout | null = null;
  private readonly startedAt = performance.now();
  private ended = false;

  constructor(private readonly target: ConsumedWatchTarget, private readonly onEnd: (why: Ended) => void) {
    this.offset = target.offset ?? target.reader!.readPosition;
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
    this.target.reader?.close?.();
    this.onEnd(why);
  }

  /**
   * Whether this watch may still act, asked before the first await and again after each one: stopped, its CLI gone
   * (stop, pause, respawn) or its lifetime over ends it — a read that returns after any of those proves nothing.
   */
  private stillLive(): boolean {
    if (this.ended) return false;
    if (!this.target.current()) { this.end("fenced"); return false; }
    if (performance.now() - this.startedAt >= (this.target.lifetimeMs ?? CONSUMED_WATCH.lifetimeMs)) { this.end("expired"); return false; }
    return true;
  }

  /**
   * #3030: the transcript is read to its end, nothing consumed it, and the CLI has stayed idle long enough: not taken.
   * The idle stretch is asked last, with every read already done — a turn that started meanwhile writes first.
   */
  private notTakenNow(): boolean {
    if (!this.target.notTaken || !this.target.idleForMs) return false;
    const idle = this.target.idleForMs();
    if (idle === null || idle < CONSUMED_WATCH.notTakenIdleMs) return false;
    this.target.notTaken();
    this.end("not-taken");
    return true;
  }

  /** One bounded look. Never throws; every outcome either schedules the next look or ends the watch. */
  async look(): Promise<void> {
    if (this.ended) return;
    try {
      if (!this.stillLive()) return;
      if (this.target.reader) {
        const before = this.offset, found = await this.target.reader.look();
        if (!this.stillLive()) return;
        this.offset = this.target.reader.readPosition;
        if (found === "user" || found === "absorbed") {
          this.target.consumed(found === "user" ? "turn" : "mid_turn", found === "user" ? "transcript-consumed:user-entry" : "transcript-consumed:absorbed-mid-turn");
          return this.end("consumed");
        }
        if (found === "unavailable") return this.end("unavailable");
        if (this.offset > before) { this.idleLooks = 0; return this.schedule(CONSUMED_WATCH.catchUpMs); }
        if (++this.idleLooks >= CONSUMED_WATCH.idleLooksBeforeBackoff) {
          this.idleLooks = 0; this.interval = Math.min(this.interval * 2, CONSUMED_WATCH.maxTickMs);
        }
        return this.schedule(this.interval);
      }
      let size: number;
      try { size = (await stat(this.target.path)).size; } catch { return this.end("unavailable"); }
      if (!this.stillLive()) return;
      if (size < this.offset) return this.end("unavailable"); // rotated or truncated below our offset
      if (size === this.offset) {
        if (this.carry.length === 0 && this.notTakenNow()) return;
        if (++this.idleLooks >= CONSUMED_WATCH.idleLooksBeforeBackoff) {
          this.idleLooks = 0;
          this.interval = Math.min(this.interval * 2, CONSUMED_WATCH.maxTickMs);
        }
        return this.schedule(this.interval);
      }
      this.idleLooks = 0;
      const length = Math.min(CONSUMED_WATCH.chunkBytes, size - this.offset);
      const chunk = await readAt(this.target.path, this.offset, length);
      if (!this.stillLive()) return;
      if (!chunk) return this.end("unavailable");
      this.offset += chunk.length;
      const found = measureSyncWork("consumedWatch.scan", () => this.scan(chunk));
      if (found) {
        this.target.consumed(found.via, found.evidence);
        return this.end("consumed");
      }
      if (this.offset >= size && this.carry.length === 0 && this.notTakenNow()) return;
      this.schedule(this.offset < size ? CONSUMED_WATCH.catchUpMs : this.interval);
    } catch (err) {
      this.target.logger?.warn({ err, deliveryId: this.target.deliveryId }, "Consumed-signal watch failed; it proves nothing either way");
      this.end("unavailable");
    }
  }

  /**
   * Complete lines of this chunk (plus the carried start of a line), judged once each. Every line is held to
   * maxLineBytes BEFORE it is decoded — one that completes past the cap is skipped like one that never completes —
   * and only the lines within it are parsed (#1201 review).
   */
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
    let found: { via: ConsumedVia; evidence: string } | null = null;
    if (lastNl < 0) {
      this.carry = buffer;
    } else {
      this.carry = buffer.subarray(lastNl + 1);
      const kept: Buffer[] = [];
      for (let start = 0; start <= lastNl;) {
        const nl = buffer.indexOf(0x0a, start);
        if (nl - start <= CONSUMED_WATCH.maxLineBytes) kept.push(buffer.subarray(start, nl + 1));
        start = nl + 1;
      }
      if (kept.length) {
        const text = Buffer.concat(kept).toString("utf8");
        const kind = this.target.marker
          ? transcriptDeltaMarkerKind(text, this.target.backend, this.target.marker)
          : transcriptDeltaDeliveryMarker(text, this.target.backend, this.target.deliveryId);
        if (kind === "user") found = { via: "turn", evidence: "transcript-consumed:user-entry" };
        else if (kind === "absorbed") found = { via: "mid_turn", evidence: "transcript-consumed:absorbed-mid-turn" };
      }
    }
    if (this.carry.length > CONSUMED_WATCH.maxLineBytes) {
      this.carry = Buffer.alloc(0);
      this.skippingLine = true;
    }
    return found;
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
