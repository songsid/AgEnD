import type { ChannelAdapter } from "./channel/types.js";
import { t } from "./locale.js";
import { updateElapsedSeconds } from "./update-progress.js";

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
  /** Optional update-completion tip; ignored for ordinary restarts. */
  tipText?: string;
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

type DeadlineResult<T> =
  | { status: "fulfilled"; value: T }
  | { status: "rejected"; reason: unknown }
  | { status: "timeout" };

function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return minutes > 0 ? `${minutes}m ${remainder}s` : `${seconds}s`;
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
  if (mode === "update" && summary.tipText) lines.push("", summary.tipText);
  return lines.join("\n");
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
      this.queueProgressEdit();
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
      if (this.ready >= 5) this.queueProgressEdit();
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

  /** Deliver the terminal state. Returns true only after an edit or fresh fallback succeeds. */
  async finish(summary?: RestartProgressSummary): Promise<boolean> {
    if (!this.enabled) return false;
    // Capture the current worker before preventing it from starting any newer
    // pending frame. The terminal path waits for this exact edit so the final
    // edit cannot overtake an ordinary, healthy provider round trip.
    const progressEditWorker = this.progressEditWorker;
    this.finished = true;
    this.pendingProgressText = null;
    if (this.updateTimer) {
      clearInterval(this.updateTimer);
      this.updateTimer = null;
    }
    if (!this.target || !this.messageId) return false;
    const text = summary
      ? formatRestartProgressCompletion(this.mode, summary, this.startedAt)
      : `✅ Fleet ready — ${this.ready}/${this.total} instances started (${formatElapsed(Date.now() - this.startedAt)})`;
    return this.deliverTerminal(text, progressEditWorker);
  }

  get readyCount(): number { return this.ready; }

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
      try {
        await adapter.editMessage(target.chatId, messageId, text, target.threadId);
      } catch (err) {
        this.logger.warn({ err }, "Failed to edit fleet restart progress");
      }
    }
  }

  /**
   * A terminal state must mean "delivered", not merely "had a message id".
   * Wait through a bounded adapter-recovery window, re-resolving replacement
   * adapter objects each time. If editing the adopted message fails, post a
   * fresh completion message so the user is never left at the last X/N update.
   */
  private async deliverTerminal(text: string, progressEditWorker: Promise<void> | null): Promise<boolean> {
    const target = this.target;
    if (!target || !this.messageId) return false;
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
    if (!adapter) return this.terminalDeliveryFailed();

    const editAdapter = adapter;
    const edit = await this.beforeDeadline(
      () => editAdapter.editMessage(target.chatId, this.messageId!, text, target.threadId),
      deadline,
    );
    if (edit.status === "fulfilled") return true;
    if (edit.status === "rejected") {
      this.logger.warn({ err: edit.reason }, "Failed to edit fleet restart progress terminal state");
    } else {
      this.logger.warn({}, "Timed out editing fleet restart progress terminal state");
    }

    // The edit may have failed because the gateway dropped between the first
    // readiness probe and the write. Re-check and, if necessary, wait for the
    // replacement generation before the one and only fresh-send attempt.
    adapter = await this.waitForReadyAdapter(deadline);
    if (!adapter) return this.terminalDeliveryFailed();
    const sendAdapter = adapter;
    const sent = await this.beforeDeadline(
      () => sendAdapter.sendText(target.chatId, text, { threadId: target.threadId }),
      deadline,
    );
    if (sent.status === "fulfilled") {
      this.logger.warn({}, "Posted fresh fleet completion after terminal progress edit was unavailable");
      return true;
    }
    if (sent.status === "rejected") {
      this.logger.warn({ err: sent.reason }, "Failed to post fresh fleet completion after edit failure");
    } else {
      this.logger.warn({}, "Timed out posting fresh fleet completion after edit failure");
    }
    return this.terminalDeliveryFailed();
  }

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

  private async beforeDeadline<T>(start: () => Promise<T>, deadline: number): Promise<DeadlineResult<T>> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { status: "timeout" };
    let work: Promise<T>;
    try {
      work = start();
    } catch (reason) {
      return { status: "rejected", reason };
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<DeadlineResult<T>>(resolve => {
      timer = setTimeout(() => resolve({ status: "timeout" }), remaining);
      timer.unref?.();
    });
    const settled = work.then<DeadlineResult<T>, DeadlineResult<T>>(
      value => ({ status: "fulfilled", value }),
      reason => ({ status: "rejected", reason }),
    );
    const result = await Promise.race([settled, timeout]);
    if (timer) clearTimeout(timer);
    return result;
  }

  private terminalDeliveryFailed(): false {
    const data = { timeout_ms: RESTART_PROGRESS_TERMINAL_TIMEOUT_MS };
    if (this.logger.error) this.logger.error(data, "Fleet completion could not be delivered after adapter recovery wait");
    else this.logger.warn(data, "Fleet completion could not be delivered after adapter recovery wait");
    return false;
  }
}
