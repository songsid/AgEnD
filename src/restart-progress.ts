import type { ChannelAdapter } from "./channel/types.js";
import { t } from "./locale.js";
import { updateElapsedSeconds } from "./update-progress.js";
import { runBeforeDeadline, type DeadlineResult } from "./deadline.js";
import {
  UPDATE_MARKER_MAX_AGE_MS,
  updateReceiptOf,
  type UpdateMarker,
  type UpdateProgressState,
  type UpdateReceipt,
} from "./update-marker.js";

export interface RestartProgressTarget {
  /** Initial adapter generation, when one already exists. Update recovery may
   * start with no adapter object and rely solely on resolveAdapter(). */
  adapter?: ChannelAdapter;
  /**
   * Re-resolve the adapter at delivery time. Adapter startup recovery replaces
   * a failed adapter object in FleetManager, so a progress message adopted
   * across process restart must not stay pinned to the stopped generation.
   */
  resolveAdapter?: () => ChannelAdapter | undefined;
  chatId: string;
  threadId?: string;
}

export interface RestartProgressSummary {
  running: number;
  total: number;
  version: string;
  pausedNames: string[];
  failedNames?: string[];
  /** Instances whose background work this restart/update ended (#1716); all modes. */
  backgroundWorkEndedNames?: string[];
  /** Optional non-fatal cleanup note (e.g. old system copy left behind); update mode only. */
  warningText?: string;
  /** Verbatim manual cleanup command; rendered as its own code line, update mode only. */
  warningCommand?: string;
}

type ProgressLogger = {
  warn(data: unknown, message: string): void;
  error?(data: unknown, message: string): void;
};

export interface RestartProgressOptions {
  mode?: RestartProgressMode;
}

export type RestartProgressMode = "restart" | "update" | "reload";

const TERMINAL_DELIVERY_RETRY_MS = 1_000;
export const RESTART_PROGRESS_TERMINAL_TIMEOUT_MS = 30_000;
/** Minimum ms between non-terminal progress edits (throttle window). */
export const PROGRESS_THROTTLE_MS = 2_500;
/**
 * #2175: Telegram allows a bot about 20 messages a minute in one group, edits included, and every topic of a forum
 * group shares it with the fleet's other startup messages. The 1 Hz update ticker drew 429s whose retry_after outlasted
 * the terminal budget, leaving "Starting... 13/14" as the last word. Progress edits to Telegram are spaced this far
 * apart (10 a minute); the newest frame is the one sent.
 */
export const TELEGRAM_PROGRESS_EDIT_SPACING_MS = 6_000;
/**
 * #2175: how long a terminal state that could not land within RESTART_PROGRESS_TERMINAL_TIMEOUT_MS (a 429 window
 * longer than that, or the adapter not ready yet) keeps being retried in the background — after startup, never
 * holding it. #2213: a network outage at fleet start (an update over a dropped link) is retried too; 30 minutes
 * covers an ordinary outage without posting a completion long after anyone looked.
 */
export const TERMINAL_BACKGROUND_WINDOW_MS = 30 * 60_000;
const TERMINAL_BACKGROUND_RETRY_MS = 15_000;
/** #2175: a 429 window must leave this much of the terminal budget for the attempt after it, else it is deferred. */
const TERMINAL_ATTEMPT_MARGIN_MS = 5_000;

function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return minutes > 0 ? `${minutes}m ${remainder}s` : `${seconds}s`;
}

/** Extract retry-after milliseconds from a Telegram 429 GrammyError, or 0. */
function retryAfterMs(err: unknown): number {
  if (err instanceof Error) {
    const e = err as Error & {
      error_code?: number;
      parameters?: { retry_after?: number };
    };
    if (e.error_code === 429 && typeof e.parameters?.retry_after === "number") {
      return e.parameters.retry_after * 1_000;
    }
  }
  return 0;
}

/** #1716: the shared background-work line for the completion and every fallback path. */
export function formatBackgroundWorkEndedLine(names: readonly string[]): string {
  return `⚠️ Background work was running and was ended: ${names.join(", ")}`;
}

/** One terminal text shared by the in-place edit and FleetManager fallback. */
export function formatRestartProgressCompletion(
  mode: RestartProgressMode,
  summary: RestartProgressSummary,
  startedAt: number,
  now = Date.now(),
): string {
  const elapsed = formatElapsed(now - startedAt);
  const lines = mode === "update"
    ? [t("update.progress.complete", summary.version, summary.running, summary.total, updateElapsedSeconds(startedAt, now))]
    : mode === "reload"
      ? [t("restart.progress.complete_summary", summary.version, summary.running, summary.total, updateElapsedSeconds(startedAt, now))]
      : [`✅ Fleet ready — ${summary.running}/${summary.total} instances running (${elapsed}) · v${summary.version}`];
  if (summary.pausedNames.length) {
    lines.push(`⏸ Paused (${summary.pausedNames.length}): ${summary.pausedNames.join(", ")}`);
  }
  if (summary.failedNames?.length) {
    lines.push(`⚠️ Failed (${summary.failedNames.length}): ${summary.failedNames.join(", ")}`);
  }
  if (summary.backgroundWorkEndedNames?.length) {
    lines.push(formatBackgroundWorkEndedLine(summary.backgroundWorkEndedNames));
  }
  if (mode === "update" && summary.warningText) lines.push("", `⚠️ ${summary.warningText}`);
  if (mode === "update" && summary.warningCommand) lines.push(`\`$ ${summary.warningCommand}\``);
  return lines.join("\n");
}

/**
 * #1660: pure cleanup-watch decision for the post-completion marker watch.
 * The caller owns the side effects; this only classifies:
 * - append: the owed outcome landed on the same receipt — render it.
 * - release: done silent, or the updater died past the max age — clear it.
 * - drop: the receipt is gone or belongs to another operation — leave the
 *   marker to its own lifecycle, stop watching.
 * - wait: outcome still owed and fresh — touch nothing (never stage-edit; the
 *   completion summary is already posted).
 */
export type CleanupWatchVerdict =
  | { action: "append"; warning: string; cleanupCommand?: string }
  | { action: "release" }
  | { action: "drop" }
  | { action: "wait" };

export function cleanupWatchVerdict(
  marker: (UpdateMarker & { progress: UpdateProgressState }) | null,
  receipt: UpdateReceipt,
  now = Date.now(),
): CleanupWatchVerdict {
  const current = marker ? updateReceiptOf(marker) : null;
  if (!current || current.startedAt !== receipt.startedAt
    || current.messageId !== receipt.messageId || current.operation !== receipt.operation) {
    return { action: "drop" };
  }
  // Age first: a recorded-but-undelivered warning still obeys the watch
  // limit (Prism c) — otherwise a permanently refusing adapter pins the tick.
  if (now - receipt.startedAt > UPDATE_MARKER_MAX_AGE_MS) return { action: "release" };
  const progress = (marker as UpdateMarker & { progress: UpdateProgressState }).progress;
  if (progress.cleanup === "done") {
    return progress.warning
      ? { action: "append", warning: progress.warning, cleanupCommand: progress.cleanupCommand }
      : { action: "release" };
  }
  return { action: "wait" };
}

/** #2175: the background terminal retry's state; `text` is what the message should finally say. */
interface DeferredTerminal {
  text: string;
  timer: ReturnType<typeof setTimeout> | null;
  giveUpAt: number;
}

/** One General-topic message that is edited throughout a fleet startup. */
export class RestartProgress {
  readonly enabled: boolean;
  private ready = 0;
  private target: RestartProgressTarget | null = null;
  private messageId: string | null = null;
  private lastReportedReady = 0;
  private updateTimer: ReturnType<typeof setInterval> | null = null;
  /** At most one provider edit is active and one newest progress frame waits
   * behind it. This prevents a slow adapter from accumulating 1 Hz history. */
  private progressEditWorker: Promise<void> | null = null;
  private pendingProgressText: string | null = null;
  private finished = false;
  private readonly mode: RestartProgressMode;
  /** Timestamp of the last successfully dispatched non-terminal progress edit. */
  private lastProgressEditAt = -PROGRESS_THROTTLE_MS;
  /** setTimeout handle for the next throttle-deferred progress edit. */
  private throttleTimer: ReturnType<typeof setTimeout> | null = null;
  /** Resolves the active drainProgressEdits backoff sleep early when finish() is called. */
  private wakeBackoff: (() => void) | null = null;
  /** #2175: the end of the newest 429 window the provider named; no edit is sent before it. */
  private rateLimitedUntil = 0;
  /** #2175: when the last progress edit was sent (Telegram pacing). */
  private lastEditSentAt = Number.NEGATIVE_INFINITY;
  /** #2175: the background terminal retry, while one is owed. */
  private deferredTerminal: DeferredTerminal | null = null;
  /** #2175: the last terminal text the provider acknowledged on the message. */
  private landedText: string | null = null;

  constructor(
    readonly total: number,
    private readonly startedAt: number,
    private readonly logger: ProgressLogger,
    options: RestartProgressOptions = {},
  ) {
    this.mode = options.mode ?? "restart";
    this.enabled = this.mode === "update" || this.mode === "reload" || total > 5;
  }

  /** May be called before the channel adapter is ready; progress is retained. */
  markReady(): void {
    if (!this.enabled || this.finished) return;
    this.ready = Math.min(this.total, this.ready + 1);
    if (this.messageId && this.ready - this.lastReportedReady >= 5) {
      this.maybeQueueProgressEdit();
    }
  }

  /** Post the one progress message once General and its adapter are available. */
  async start(target: RestartProgressTarget | null): Promise<boolean> {
    if (!this.enabled || !target || this.messageId || this.finished) return false;
    const adapter = this.resolveAdapter(target);
    if (!adapter) return false;
    this.target = target;
    try {
      const sent = await adapter.sendText(
        target.chatId,
        `🔄 Fleet restarting — ${this.total} instances starting...`,
        { threadId: target.threadId },
      );
      this.messageId = sent.messageId;
      if (this.ready >= 5) this.maybeQueueProgressEdit();
      this.updateTimer = setInterval(() => this.queueProgressEdit(), 30_000);
      this.updateTimer.unref?.();
      return true;
    } catch (err) {
      this.logger.warn({ err }, "Failed to post fleet restart progress");
      this.target = null;
      return false;
    }
  }

  /** Adopt the pre-update message after the new fleet process reconnects. */
  async resume(target: RestartProgressTarget | null, messageId: string): Promise<boolean> {
    if (!this.enabled || this.mode === "restart" || !target || !messageId || this.finished) return false;
    if (!target.adapter && !target.resolveAdapter) return false;
    this.target = target;
    this.messageId = messageId;
    // Do not let a stuck provider call hold fleet startup. The coalescing worker
    // owns this best-effort progress frame; finish() has its own hard deadline.
    this.scheduleProgressEdit(this.mode === "reload"
      ? t("restart.progress.starting", updateElapsedSeconds(this.startedAt))
      : t("update.progress.starting", updateElapsedSeconds(this.startedAt)));
    this.updateTimer = setInterval(() => this.queueProgressEdit(), 1_000);
    this.updateTimer.unref?.();
    return true;
  }

  /**
   * Deliver the terminal state. Returns true after an edit or fresh fallback succeeds, or when a passing obstacle (a
   * 429 window, an adapter not ready yet) handed it to the background retry (#2175) — which owns it from then on.
   */
  async finish(summary?: RestartProgressSummary): Promise<boolean> {
    if (!this.enabled) return false;
    // Capture the current worker before preventing it from starting any newer
    // pending frame. The terminal path waits for this exact edit so the final
    // edit cannot overtake an ordinary, healthy provider round trip.
    const progressEditWorker = this.progressEditWorker;
    this.finished = true;
    this.pendingProgressText = null;
    this.wakeBackoff?.();
    if (this.updateTimer) {
      clearInterval(this.updateTimer);
      this.updateTimer = null;
    }
    if (this.throttleTimer) {
      clearTimeout(this.throttleTimer);
      this.throttleTimer = null;
    }
    if (!this.target || !this.messageId) return false;
    const text = summary
      ? formatRestartProgressCompletion(this.mode, summary, this.startedAt)
      : `✅ Fleet ready — ${this.ready}/${this.total} instances started (${formatElapsed(Date.now() - this.startedAt)})`;
    return this.deliverTerminal(text, progressEditWorker);
  }

  /**
   * #2213: post the completion as a new message when there is no progress message to edit (fewer than six instances,
   * or its first post failed) — FleetManager's fallback. Same delivery as finish(): bounded at startup, then the
   * background retry once the adapter is ready again, and never a second post after one whose outcome is unknown.
   */
  async postCompletion(target: RestartProgressTarget, text: string): Promise<boolean> {
    this.finished = true;
    if (this.updateTimer) { clearInterval(this.updateTimer); this.updateTimer = null; }
    this.target = target;
    this.messageId = null;
    return this.deliverTerminal(text, null);
  }

  get readyCount(): number { return this.ready; }

  /**
   * Throttle non-terminal progress edits so at most one fires every
   * PROGRESS_THROTTLE_MS. If called too soon after the last edit, schedule a
   * deferred fire instead of sending immediately. This prevents every markReady()
   * call from generating an editMessage request and triggering Telegram 429s.
   */
  private maybeQueueProgressEdit(): void {
    if (this.finished || !this.target || !this.messageId) return;
    const now = Date.now();
    const msSinceLast = now - this.lastProgressEditAt;
    if (msSinceLast >= PROGRESS_THROTTLE_MS) {
      this.lastProgressEditAt = now;
      this.queueProgressEdit();
    } else if (!this.throttleTimer) {
      // Schedule a deferred fire once the throttle window expires so the latest
      // state (not a stale snapshot) is sent when the window opens.
      const delay = PROGRESS_THROTTLE_MS - msSinceLast;
      this.throttleTimer = setTimeout(() => {
        this.throttleTimer = null;
        this.lastProgressEditAt = Date.now();
        this.queueProgressEdit();
      }, delay);
      this.throttleTimer.unref?.();
    }
    // else: a deferred fire is already pending — it will pick up the latest state
  }

  private queueProgressEdit(): void {
    if (this.finished || !this.target || !this.messageId) return;
    this.lastReportedReady = this.ready;
    const text = this.mode === "update"
      ? t("update.progress.instances", this.ready, this.total, updateElapsedSeconds(this.startedAt))
      : this.mode === "reload"
        ? t("restart.progress.instances", this.ready, this.total, updateElapsedSeconds(this.startedAt))
        : `🔄 Fleet restarting — ${this.ready}/${this.total} ready...`;
    this.scheduleProgressEdit(text);
  }

  private resolveAdapter(target = this.target): ChannelAdapter | undefined {
    if (!target) return undefined;
    return target.resolveAdapter ? target.resolveAdapter() : target.adapter;
  }

  private adapterReady(adapter: ChannelAdapter): boolean {
    const health = adapter.getHealthSnapshot?.();
    return !health || health.isReady;
  }

  /** Tail-only coalescing for non-terminal progress. */
  private scheduleProgressEdit(text: string): void {
    if (this.finished || !this.target || !this.messageId) return;
    this.pendingProgressText = text;
    if (this.progressEditWorker) return;
    const worker = this.drainProgressEdits();
    this.progressEditWorker = worker;
    const complete = () => {
      if (this.progressEditWorker === worker) this.progressEditWorker = null;
      if (!this.finished && this.pendingProgressText != null) this.scheduleProgressEdit(this.pendingProgressText);
    };
    void worker.then(complete, err => {
      this.logger.warn({ err }, "Fleet restart progress worker failed");
      complete();
    });
  }

  private async drainProgressEdits(): Promise<void> {
    while (!this.finished) {
      const text = this.pendingProgressText;
      if (text == null) return;
      this.pendingProgressText = null;
      const target = this.target;
      const messageId = this.messageId;
      const adapter = this.resolveAdapter(target);
      if (!target || !messageId || !adapter || !this.adapterReady(adapter)) continue;
      // #2175: Telegram's spacing (a 429 window is slept through below); the newest frame is sent when it opens.
      const openAt = adapter.type === "telegram" ? this.lastEditSentAt + TELEGRAM_PROGRESS_EDIT_SPACING_MS : 0;
      if (openAt > Date.now()) {
        this.pendingProgressText ??= text;
        await this.interruptibleSleep(openAt - Date.now());
        continue;
      }
      try {
        this.lastEditSentAt = Date.now();
        await adapter.editMessage(target.chatId, messageId, text, target.threadId);
      } catch (err) {
        const backoffMs = retryAfterMs(err);
        if (backoffMs > 0) {
          this.rateLimitedUntil = Math.max(this.rateLimitedUntil, Date.now() + backoffMs);
          this.logger.warn({ retryAfterMs: backoffMs }, "Fleet restart progress edit throttled (429); backing off");
          // A 429 answered after finish() began: the window is the terminal path's now (it waits it out or defers);
          // sleeping here would only spend the terminal budget on this worker.
          if (this.finished) return;
          // Re-queue the current frame (unless a newer one arrived) so the loop
          // retries this edit after the backoff window.
          if (this.pendingProgressText == null) this.pendingProgressText = text;
          await this.interruptibleSleep(backoffMs);
        } else {
          this.logger.warn({ err }, "Failed to edit fleet restart progress");
        }
      }
    }
  }

  /** A sleep finish() can cut short (it then delivers the terminal state itself). */
  private interruptibleSleep(ms: number): Promise<void> {
    return new Promise<void>(resolve => {
      const t = setTimeout(() => { this.wakeBackoff = null; resolve(); }, ms);
      (t as NodeJS.Timeout).unref?.();
      this.wakeBackoff = () => { clearTimeout(t); this.wakeBackoff = null; resolve(); };
    });
  }

  /**
   * A terminal state must mean "delivered", not merely "had a message id".
   * Wait through a bounded adapter-recovery window, re-resolving replacement
   * adapter objects each time. If editing the adopted message fails, post a
   * fresh completion message so the user is never left at the last X/N update.
   * 429 responses are retried with their retry-after delay up to the deadline.
   */
  private async deliverTerminal(text: string, progressEditWorker: Promise<void> | null): Promise<boolean> {
    const target = this.target;
    if (!target) return false;
    const deadline = Date.now() + RESTART_PROGRESS_TERMINAL_TIMEOUT_MS;

    if (progressEditWorker) {
      const drained = await this.beforeDeadline(() => progressEditWorker, deadline);
      if (drained.status === "timeout") {
        this.logger.warn({}, "Timed out waiting for the in-flight fleet progress edit before terminal delivery");
        return this.terminalDeliveryFailed();
      }
      if (drained.status === "rejected") {
        this.logger.warn({ err: drained.reason }, "Fleet progress edit worker rejected before terminal delivery");
      }
    }

    let adapter = await this.waitForReadyAdapter(deadline);
    if (!adapter) return this.adapterNotReady(text);

    // Retry terminal edit with 429-aware backoff until the deadline (#2213: no message to edit → straight to the post).
    const after = this.messageId ? " after edit failure" : "";
    while (this.messageId) {
      // #2175: a 429 window still open from the progress edits (finish() cut that sleep short) is waited out here;
      // one that outlasts the budget goes to the background retry instead of an edit the provider would refuse.
      if (this.rateLimitedUntil > Date.now()) {
        if (this.rateLimitedUntil + TERMINAL_ATTEMPT_MARGIN_MS > deadline) return this.deferTerminal(text, this.rateLimitedUntil, "rate limited (429)");
        await new Promise<void>(resolve => { const t = setTimeout(resolve, this.rateLimitedUntil - Date.now()); (t as NodeJS.Timeout).unref?.(); });
        adapter = await this.waitForReadyAdapter(deadline);
        if (!adapter) return this.adapterNotReady(text);
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      const editAdapter = adapter;
      const editing = Promise.resolve().then(() => editAdapter.editMessage(target.chatId, this.messageId!, text, target.threadId));
      const edit = await this.beforeDeadline(() => editing, deadline);
      if (edit.status === "fulfilled") { this.landedText = text; return true; }
      if (edit.status === "timeout") {
        this.logger.warn({}, "Timed out editing fleet restart progress terminal state");
        // #2213: it may still land — no fresh post beside it; its own settlement decides what comes next.
        return this.awaitOutcome(text, editing, false);
      }
      // rejected
      const backoff = retryAfterMs(edit.reason);
      if (backoff > 0) {
        this.rateLimitedUntil = Math.max(this.rateLimitedUntil, Date.now() + backoff);
        if (this.rateLimitedUntil + TERMINAL_ATTEMPT_MARGIN_MS > deadline) return this.deferTerminal(text, this.rateLimitedUntil, "rate limited (429)");
        const wait = Math.min(backoff, deadline - Date.now());
        if (wait > 0) {
          this.logger.warn({ retryAfterMs: backoff }, "Fleet restart terminal edit throttled (429); will retry");
          await new Promise<void>(resolve => {
            const t = setTimeout(resolve, wait);
            (t as NodeJS.Timeout).unref?.();
          });
          // Re-resolve adapter after backoff (it may have rotated)
          adapter = await this.waitForReadyAdapter(deadline);
          if (!adapter) return this.adapterNotReady(text);
          continue;
        }
      }
      this.logger.warn({ err: edit.reason }, "Failed to edit fleet restart progress terminal state");
      break;
    }

    // The edit may have failed because the gateway dropped between the first
    // readiness probe and the write. Re-check and, if necessary, wait for the
    // replacement generation before the one and only fresh-send attempt.
    adapter = await this.waitForReadyAdapter(deadline);
    if (!adapter) return this.adapterNotReady(text);
    const sendAdapter = adapter;
    const posting = Promise.resolve().then(() => sendAdapter.sendText(target.chatId, text, { threadId: target.threadId }));
    const sent = await this.beforeDeadline(() => posting, deadline);
    if (sent.status === "fulfilled") {
      this.landedText = text;
      const hadMessage = this.messageId !== null;
      this.messageId = sent.value.messageId;
      if (hadMessage) this.logger.warn({}, "Posted fresh fleet completion after terminal progress edit was unavailable");
      return true;
    }
    if (sent.status === "rejected") {
      const sendBackoff = retryAfterMs(sent.reason);
      if (sendBackoff > 0) {
        this.rateLimitedUntil = Math.max(this.rateLimitedUntil, Date.now() + sendBackoff);
        return this.deferTerminal(text, this.rateLimitedUntil, "rate limited (429)");
      }
      // #2213: refused (an outage's fetch failure, a network error): nothing landed — the background retry owns it.
      this.logger.warn({ err: sent.reason }, `Failed to post fresh fleet completion${after}`);
      return this.deferTerminal(text, Date.now() + TERMINAL_BACKGROUND_RETRY_MS, "delivery refused");
    }
    this.logger.warn({}, `Timed out posting fresh fleet completion${after}`);
    // #2213: it may still land: a second post could duplicate it, so only its own settlement decides.
    return this.awaitOutcome(text, posting, true);
  }

  /**
   * #2213: a terminal call that did not settle by its deadline may still land. Nothing else is written until it
   * settles: refused, the background retry takes over (within TERMINAL_BACKGROUND_WINDOW_MS); landed, done. One that
   * never settles within the window is given up loudly. Returns true: the completion is owed here.
   */
  private awaitOutcome(text: string, call: Promise<unknown>, posted: boolean): true {
    const state: DeferredTerminal = { text, timer: null, giveUpAt: Date.now() + TERMINAL_BACKGROUND_WINDOW_MS };
    this.deferredTerminal = state;
    this.logger.warn({ timeout_ms: RESTART_PROGRESS_TERMINAL_TIMEOUT_MS },
      "Fleet completion call did not settle in time — waiting for its outcome before any other write");
    state.timer = setTimeout(() => {
      state.timer = null;
      if (this.deferredTerminal !== state) return;
      this.deferredTerminal = null;
      this.loud({ window_ms: TERMINAL_BACKGROUND_WINDOW_MS }, "Fleet completion call never settled in the background window — its outcome is unknown");
    }, TERMINAL_BACKGROUND_WINDOW_MS);
    state.timer.unref?.();
    call.then(value => {
      const id = posted ? (value as { messageId?: unknown } | undefined)?.messageId : undefined;
      if (typeof id === "string" && this.deferredTerminal === state) this.messageId = id;
      this.settleLate(state, text, true);
    }, reason => this.settleLate(state, text, false, reason));
    return true;
  }

  /**
   * #2175: the terminal state could not land within the startup budget for a reason that passes — a 429 window, or
   * the adapter not ready yet. Startup goes on; this retries after it (edit in place, else a new message) until
   * TERMINAL_BACKGROUND_WINDOW_MS, each failure at warn and the give-up at error. Returns true: the completion is owed
   * by this retry, so a caller must not post a second one into the same refusing chat.
   *
   * It is the message's only writer from here on: one provider call at a time; a newer text (replaceTerminalText)
   * is written after the call in flight settles; and a call whose outcome is still unknown at its deadline is never
   * followed by another write (a duplicate or an overwrite could follow) — it is logged loudly, and only its own
   * late settlement may write the newer text it missed.
   */
  private deferTerminal(text: string, at: number, reason: string): true {
    const state: DeferredTerminal = {
      text, timer: null, giveUpAt: Date.now() + TERMINAL_BACKGROUND_WINDOW_MS,
    };
    this.deferredTerminal = state;
    this.logger.warn({ reason, retryInMs: Math.max(0, at - Date.now()) },
      "Fleet completion could not land yet — retrying in the background");
    this.scheduleDeferred(state, at);
    return true;
  }

  private scheduleDeferred(state: DeferredTerminal, when: number): void {
    if (this.deferredTerminal !== state) return;
    if (when > state.giveUpAt) {
      this.deferredTerminal = null;
      this.loud({ window_ms: TERMINAL_BACKGROUND_WINDOW_MS }, "Fleet completion could not be delivered in the background window");
      return;
    }
    state.timer = setTimeout(() => { state.timer = null; void this.attemptDeferred(state); }, Math.max(0, when - Date.now()));
    state.timer.unref?.();
  }

  /** One provider call for the deferred terminal; resolves "unknown" when its deadline passes unsettled. */
  private async deferredCall<T>(call: () => Promise<T>, onLate: (ok: boolean, value?: T, reason?: unknown) => void)
    : Promise<{ status: "fulfilled"; value: T } | { status: "rejected"; reason: unknown } | { status: "unknown" }> {
    const op = Promise.resolve().then(call);
    let late = false;
    op.then(v => { if (late) onLate(true, v); }, reason => { if (late) onLate(false, undefined, reason); });
    const result = await this.beforeDeadline(() => op, Date.now() + RESTART_PROGRESS_TERMINAL_TIMEOUT_MS);
    if (result.status === "timeout") {
      late = true;
      return { status: "unknown" };
    }
    return result.status === "fulfilled" ? { status: "fulfilled", value: result.value } : { status: "rejected", reason: result.reason };
  }

  /** A call that settled after its deadline: the message holds `sent` if it landed; write a newer text it missed. */
  private settleLate(state: DeferredTerminal, sent: string, ok: boolean, reason?: unknown): void {
    if (this.deferredTerminal !== state) return;
    if (state.timer) { clearTimeout(state.timer); state.timer = null; }
    if (!ok) {
      // Settled as refused: nothing landed, so another write is safe again — after the window a 429 names.
      const backoff = retryAfterMs(reason);
      if (backoff > 0) this.rateLimitedUntil = Math.max(this.rateLimitedUntil, Date.now() + backoff);
      this.logger.warn({ err: reason }, "A fleet completion call that had timed out was refused; retrying in the background");
      this.scheduleDeferred(state, Math.max(Date.now() + TERMINAL_BACKGROUND_RETRY_MS, this.rateLimitedUntil));
      return;
    }
    this.landedText = sent;
    if (state.text !== sent) {
      this.logger.warn({}, "A late fleet completion call landed; writing the newer text it missed");
      this.scheduleDeferred(state, Math.max(Date.now(), this.rateLimitedUntil));
      return;
    }
    this.deferredTerminal = null;
    this.logger.warn({}, "Fleet completion delivered late (a call that had timed out settled)");
  }

  private async attemptDeferred(state: DeferredTerminal): Promise<void> {
    if (this.deferredTerminal !== state) return;
    const target = this.target;
    if (!target) { this.deferredTerminal = null; return; }
    const adapter = this.resolveAdapter();
    if (!adapter || !this.adapterReady(adapter)) return this.scheduleDeferred(state, Date.now() + TERMINAL_BACKGROUND_RETRY_MS);
    if (this.messageId === null) return this.postDeferred(state, adapter, target);
    const sent = state.text;
    const messageId = this.messageId;
    const edit = await this.deferredCall(() => adapter.editMessage(target.chatId, messageId, sent, target.threadId),
      (ok, _value, reason) => this.settleLate(state, sent, ok, reason));
    if (this.deferredTerminal !== state) return;
    if (edit.status === "unknown") {
      return this.loud({ timeout_ms: RESTART_PROGRESS_TERMINAL_TIMEOUT_MS },
        "Background fleet completion edit did not settle — not retried, its outcome is unknown");
    }
    if (edit.status === "fulfilled") return this.deferredDelivered(state, sent, "Fleet completion delivered late (background retry)");
    const editBackoff = retryAfterMs(edit.reason);
    if (editBackoff > 0) {
      this.rateLimitedUntil = Math.max(this.rateLimitedUntil, Date.now() + editBackoff);
      this.logger.warn({ retryAfterMs: editBackoff }, "Fleet completion still throttled (429); retrying in the background");
      return this.scheduleDeferred(state, this.rateLimitedUntil);
    }
    this.logger.warn({ err: edit.reason }, "Background fleet completion edit failed; posting it as a new message");
    return this.postDeferred(state, adapter, target);
  }

  /** The background retry's new message: no message to edit, or its edit was refused. */
  private async postDeferred(state: DeferredTerminal, adapter: ChannelAdapter, target: RestartProgressTarget): Promise<void> {
    const fresh = state.text;
    const posted = await this.deferredCall(() => adapter.sendText(target.chatId, fresh, { threadId: target.threadId }),
      (ok, value, reason) => {
        if (ok && value) this.messageId = value.messageId;
        this.settleLate(state, fresh, ok, reason);
      });
    if (this.deferredTerminal !== state) return;
    if (posted.status === "unknown") {
      return this.loud({ timeout_ms: RESTART_PROGRESS_TERMINAL_TIMEOUT_MS },
        "Background fleet completion message did not settle — not retried, its outcome is unknown");
    }
    if (posted.status === "fulfilled") {
      // Later writers (a newer text) edit the message that now carries the completion.
      this.messageId = posted.value.messageId;
      return this.deferredDelivered(state, fresh, "Fleet completion posted late as a new message (background retry)");
    }
    const sendBackoff = retryAfterMs(posted.reason);
    if (sendBackoff > 0) this.rateLimitedUntil = Math.max(this.rateLimitedUntil, Date.now() + sendBackoff);
    this.logger.warn({ err: posted.reason }, "Background fleet completion message failed; retrying");
    this.scheduleDeferred(state, Math.max(this.rateLimitedUntil, Date.now() + TERMINAL_BACKGROUND_RETRY_MS));
  }

  private deferredDelivered(state: DeferredTerminal, sent: string, message: string): void {
    this.logger.warn({}, message);
    this.landedText = sent;
    if (state.text !== sent) return this.scheduleDeferred(state, Math.max(Date.now(), this.rateLimitedUntil));
    if (state.timer) clearTimeout(state.timer);
    this.deferredTerminal = null;
  }

  private loud(data: Record<string, unknown>, message: string): void {
    if (this.logger.error) this.logger.error(data, message);
    else this.logger.warn(data, message);
  }

  /**
   * #2175: no ready adapter by the deadline. One that is not ready (a gateway still connecting) passes — the
   * background retry takes it; one that is ready means the budget went to a provider call that never settled, which
   * stays a loud failure as before.
   */
  private adapterNotReady(text: string): boolean {
    const adapter = this.resolveAdapter();
    if (adapter && this.adapterReady(adapter)) return this.terminalDeliveryFailed();
    return this.deferTerminal(text, Date.now() + TERMINAL_BACKGROUND_RETRY_MS, "adapter not ready");
  }

  /**
   * #2175: hand a newer text for the same message (the completion with a cleanup warning) to the background retry
   * while it owns the message, so the two never race on it. False when nothing is owed: the caller writes it itself.
   */
  replaceTerminalText(text: string): boolean {
    const state = this.deferredTerminal;
    if (!state) return false;
    state.text = text;
    return true;
  }

  /**
   * #2175: whether this exact text is known to have landed on the message (the provider acknowledged it). A text
   * handed over with replaceTerminalText is not landed until then.
   */
  terminalLanded(text: string): boolean { return this.landedText === text; }

  /** #2175: whether the terminal state is still owed by the background retry. */
  get terminalDeferred(): boolean { return this.deferredTerminal !== null; }

  private async waitForReadyAdapter(deadline: number): Promise<ChannelAdapter | undefined> {
    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return undefined;
      const adapter = this.resolveAdapter();
      if (adapter && this.adapterReady(adapter)) return adapter;
      await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, Math.min(TERMINAL_DELIVERY_RETRY_MS, remaining));
        timer.unref?.();
      });
    }
  }

  private beforeDeadline<T>(start: () => Promise<T>, deadline: number): Promise<DeadlineResult<T>> {
    return runBeforeDeadline(start, deadline);
  }

  private terminalDeliveryFailed(): false {
    const data = { timeout_ms: RESTART_PROGRESS_TERMINAL_TIMEOUT_MS };
    if (this.logger.error) this.logger.error(data, "Fleet completion could not be delivered after adapter recovery wait");
    else this.logger.warn(data, "Fleet completion could not be delivered after adapter recovery wait");
    return false;
  }
}

