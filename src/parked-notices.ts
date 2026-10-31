import { existsSync, readFileSync } from "node:fs";
import { atomicWriteFileSync } from "./atomic-write.js";
import type { ChannelAdapter } from "./channel/types.js";
import type { Logger } from "./logger.js";

/**
 * #2897: the lifecycle of a held CLI dialog's "needs a human" notices.
 *
 * A parked dialog is reported in the instance's topic and in General. Before
 * this, each report was a fresh post that nobody ever took back: a dialog that
 * came and went piled up identical notices in General, and one clicked hours
 * later pointed at a pane that had long moved on. Now, like the Cancel button:
 * one live message per place, edited in place on a re-report, deleted when the
 * dialog is resolved (an adapter that cannot delete gets a "✓ resolved" edit),
 * and a ledger on disk so a fleet restart cannot orphan one.
 */

/** Where a notice was posted: the instance's own topic, or General. */
export type ParkedNoticePlace = "topic" | "general";

/** A posted notice — enough to edit or delete it later, from any process. */
export interface ParkedNoticeRow {
  instanceName: string;
  place: ParkedNoticePlace;
  adapterId: string;
  chatId: string;
  threadId?: string;
  messageId: string;
  /** Failed retire attempts so far (only on a row being retired). */
  attempts?: number;
}

export interface ParkedNoticeDeps {
  /** The ledger file. */
  file: string;
  logger: Logger;
  /** Post a new notice; null when there is nowhere to post it. Throws on a send failure. */
  post(instanceName: string, place: ParkedNoticePlace, text: string): Promise<Omit<ParkedNoticeRow, "instanceName" | "place"> | null>;
  /** The adapter that posted a row (by its world id); undefined when that world is gone. */
  adapterFor(adapterId: string): ChannelAdapter | undefined;
  /** The text a notice is edited to when its adapter cannot delete it. */
  resolvedText(): string;
  /** `text` as an edit of `row` sends it: place tokens rendered for its world (an edit carries no link entities). */
  render(row: ParkedNoticeRow, text: string): string;
}

export const PARKED_NOTICE_LEDGER_FILE = "parked-notices.json";
/** Between attempts to retire a notice whose delete (and resolved edit) failed. */
export const PARKED_NOTICE_RETRY_INTERVAL_MS = 5 * 60_000;
/** Attempts before a notice is given up on — counted across restarts. */
export const PARKED_NOTICE_MAX_ATTEMPTS = 4;

const keyOf = (instanceName: string, place: ParkedNoticePlace) => `${instanceName}\0${place}`;

export class ParkedNotices {
  /** The live notice per instance and place. */
  private readonly live = new Map<string, ParkedNoticeRow>();
  /** What each live notice says now (memory only: after a restart the sweep retires every row anyway). */
  private readonly shown = new WeakMap<ParkedNoticeRow, string>();
  /** Notices being retired whose last attempt failed, awaiting their retry. */
  private readonly retiring = new Set<ParkedNoticeRow>();
  private readonly retryTimers = new Map<ParkedNoticeRow, ReturnType<typeof setTimeout>>();
  /** Per place: every show/resolve runs after the previous one, so a resolve never races the post it must take back. */
  private readonly chains = new Map<string, Promise<void>>();
  private disposed = false;

  constructor(private readonly deps: ParkedNoticeDeps) {}

  /**
   * Show the notice for `instanceName` in `place`: edit the live one in place, else post one. A re-report that says
   * what the live notice already says touches nothing (an edit would only cost the Telegram link entities the post
   * carried). An edit that fails (the message was deleted by hand, or is too old to edit) posts a fresh one and
   * retires the old.
   */
  show(instanceName: string, place: ParkedNoticePlace, text: string): Promise<void> {
    return this.serial(keyOf(instanceName, place), async () => {
      const key = keyOf(instanceName, place);
      const current = this.live.get(key);
      if (current && this.shown.get(current) === text) return;
      if (current) {
        const adapter = this.deps.adapterFor(current.adapterId);
        try {
          if (!adapter) throw new Error("adapter gone");
          await adapter.editMessage(current.chatId, current.messageId, this.deps.render(current, text), current.threadId);
          this.shown.set(current, text);
          return;
        } catch (err) {
          this.deps.logger.debug({ err, instanceName, place }, "Parked-dialog notice edit failed — posting a fresh one");
          this.live.delete(key);
          void this.retire(current);
        }
      }
      let posted: Awaited<ReturnType<ParkedNoticeDeps["post"]>>;
      try {
        posted = await this.deps.post(instanceName, place, text);
      } catch (err) {
        this.deps.logger.warn({ err, instanceName, place }, "Failed to post parked-dialog notice");
        return;
      }
      if (!posted) return;
      const row: ParkedNoticeRow = { instanceName, place, ...posted };
      this.live.set(key, row);
      this.shown.set(row, text);
      this.persist();
    });
  }

  /** The dialog is resolved (gone, answered) or the instance stopped/restarted: take its notices back. */
  resolve(instanceName: string): Promise<void> {
    const places: ParkedNoticePlace[] = ["topic", "general"];
    return Promise.all(places.map(place => this.serial(keyOf(instanceName, place), async () => {
      const key = keyOf(instanceName, place);
      const row = this.live.get(key);
      if (!row) return;
      this.live.delete(key);
      await this.retire(row);
    }))).then(() => undefined);
  }

  /** Whether `instanceName` has a live notice (in any place). */
  hasLive(instanceName: string): boolean {
    return this.live.has(keyOf(instanceName, "topic")) || this.live.has(keyOf(instanceName, "general"));
  }

  /**
   * Retire every notice the previous process left: nothing it posted can still be live from this process's point
   * of view (the daemons start with fresh state and re-report a dialog that is still there). Run once adapters are up.
   */
  async sweep(): Promise<void> {
    let rows: ParkedNoticeRow[];
    try {
      if (!existsSync(this.deps.file)) return;
      const parsed: unknown = JSON.parse(readFileSync(this.deps.file, "utf-8"));
      rows = Array.isArray(parsed) ? parsed.filter(isRow) : [];
    } catch (err) {
      this.deps.logger.warn({ err }, "Parked-dialog notice ledger unreadable — dropping it");
      rows = [];
    }
    // The retiring set holds these until each attempt settles, so the ledger written meanwhile still lists them.
    for (const row of rows) this.retiring.add(row);
    this.persist();
    await Promise.all(rows.map(row => this.retire(row)));
  }

  /** Stop retry timers (fleet shutdown). Rows still being retired stay in the ledger for the next process. */
  dispose(): void {
    this.disposed = true;
    for (const timer of this.retryTimers.values()) clearTimeout(timer);
    this.retryTimers.clear();
  }

  /** Delete the row's message; an adapter that cannot delete (or whose delete fails) gets the resolved edit instead. */
  private async retire(row: ParkedNoticeRow): Promise<void> {
    this.retiring.add(row);
    this.persist();
    const adapter = this.deps.adapterFor(row.adapterId);
    let done = false;
    let lastErr: unknown = new Error("adapter gone");
    if (adapter) {
      if (adapter.deleteMessage) {
        try {
          await adapter.deleteMessage(row.chatId, row.messageId, row.threadId);
          done = true;
        } catch (err) { lastErr = err; }
      }
      if (!done) {
        try {
          await adapter.editMessage(row.chatId, row.messageId, this.deps.resolvedText(), row.threadId);
          done = true;
        } catch (err) { lastErr = err; }
      }
    }
    if (done) {
      this.retiring.delete(row);
      this.persist();
      return;
    }
    row.attempts = (row.attempts ?? 0) + 1;
    if (row.attempts >= PARKED_NOTICE_MAX_ATTEMPTS) {
      this.retiring.delete(row);
      this.persist();
      this.deps.logger.warn({ err: lastErr, instanceName: row.instanceName, place: row.place, messageId: row.messageId },
        `Parked-dialog notice could not be retired after ${PARKED_NOTICE_MAX_ATTEMPTS} attempts — giving up`);
      return;
    }
    this.persist();
    this.deps.logger.warn({ err: lastErr, instanceName: row.instanceName, place: row.place, attempt: row.attempts },
      "Parked-dialog notice could not be retired — will retry");
    if (this.disposed) return;
    const timer = setTimeout(() => { this.retryTimers.delete(row); void this.retire(row); }, PARKED_NOTICE_RETRY_INTERVAL_MS);
    timer.unref?.();
    this.retryTimers.set(row, timer);
  }

  private serial(key: string, step: () => Promise<void>): Promise<void> {
    const next = (this.chains.get(key) ?? Promise.resolve()).then(step, step);
    const settled = next.catch(err => { this.deps.logger.warn({ err }, "Parked-dialog notice step failed"); });
    this.chains.set(key, settled);
    void settled.then(() => { if (this.chains.get(key) === settled) this.chains.delete(key); });
    return settled;
  }

  private persist(): void {
    try {
      // Atomic: a torn ledger is dropped by the sweep, which would orphan exactly the notices it exists to retire.
      atomicWriteFileSync(this.deps.file, JSON.stringify([...this.live.values(), ...this.retiring]), { mode: 0o600 });
    } catch (err) {
      this.deps.logger.debug({ err }, "Parked-dialog notice ledger write failed");
    }
  }
}

function isRow(v: unknown): v is ParkedNoticeRow {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  return typeof r.instanceName === "string" && (r.place === "topic" || r.place === "general")
    && typeof r.adapterId === "string" && typeof r.chatId === "string" && typeof r.messageId === "string"
    && (r.threadId === undefined || typeof r.threadId === "string")
    && (r.attempts === undefined || typeof r.attempts === "number");
}
