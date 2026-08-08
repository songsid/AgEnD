import type { ChannelAdapter } from "./channel/types.js";
import { t } from "./locale.js";
import { updateElapsedSeconds } from "./update-progress.js";

export interface RestartProgressTarget {
  adapter: ChannelAdapter;
  chatId: string;
  threadId?: string;
}

export interface RestartProgressSummary {
  running: number;
  total: number;
  version: string;
  pausedNames: string[];
  failedNames?: string[];
}

type ProgressLogger = {
  warn(data: unknown, message: string): void;
};

export interface RestartProgressOptions {
  mode?: "restart" | "update";
}

function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return minutes > 0 ? `${minutes}m ${remainder}s` : `${seconds}s`;
}

/** One General-topic message that is edited throughout a fleet startup. */
export class RestartProgress {
  readonly enabled: boolean;
  private ready = 0;
  private target: RestartProgressTarget | null = null;
  private messageId: string | null = null;
  private lastReportedReady = 0;
  private updateTimer: ReturnType<typeof setInterval> | null = null;
  private editChain: Promise<void> = Promise.resolve();
  private finished = false;
  private readonly mode: "restart" | "update";

  constructor(
    readonly total: number,
    private readonly startedAt: number,
    private readonly logger: ProgressLogger,
    options: RestartProgressOptions = {},
  ) {
    this.mode = options.mode ?? "restart";
    this.enabled = this.mode === "update" || total > 5;
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
    this.target = target;
    try {
      const sent = await target.adapter.sendText(
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
    if (!this.enabled || this.mode !== "update" || !target || !messageId || this.finished) return false;
    this.target = target;
    this.messageId = messageId;
    this.enqueueEdit(t("update.progress.starting", updateElapsedSeconds(this.startedAt)));
    await this.editChain;
    this.updateTimer = setInterval(() => this.queueProgressEdit(), 1_000);
    this.updateTimer.unref?.();
    return true;
  }

  /** Edit the original message to its terminal state. Returns true if it existed. */
  async finish(summary?: RestartProgressSummary): Promise<boolean> {
    if (!this.enabled) return false;
    this.finished = true;
    if (this.updateTimer) {
      clearInterval(this.updateTimer);
      this.updateTimer = null;
    }
    if (!this.target || !this.messageId) return false;
    const elapsed = formatElapsed(Date.now() - this.startedAt);
    const lines = this.mode === "update" && summary
      ? [t("update.progress.complete", summary.version, summary.running, summary.total, updateElapsedSeconds(this.startedAt))]
      : summary
        ? [`✅ Fleet ready — ${summary.running}/${summary.total} instances running (${elapsed}) · v${summary.version}`]
        : [`✅ Fleet ready — ${this.ready}/${this.total} instances started (${elapsed})`];
    if (summary?.pausedNames.length) {
      lines.push(`⏸ Paused (${summary.pausedNames.length}): ${summary.pausedNames.join(", ")}`);
    }
    if (summary?.failedNames?.length) {
      lines.push(`⚠️ Failed (${summary.failedNames.length}): ${summary.failedNames.join(", ")}`);
    }
    this.enqueueEdit(lines.join("\n"));
    await this.editChain;
    return true;
  }

  get readyCount(): number { return this.ready; }

  private queueProgressEdit(): void {
    if (this.finished || !this.target || !this.messageId) return;
    this.lastReportedReady = this.ready;
    const text = this.mode === "update"
      ? t("update.progress.instances", this.ready, this.total, updateElapsedSeconds(this.startedAt))
      : `🔄 Fleet restarting — ${this.ready}/${this.total} ready...`;
    this.enqueueEdit(text);
  }

  private enqueueEdit(text: string): void {
    const target = this.target;
    const messageId = this.messageId;
    if (!target || !messageId) return;
    this.editChain = this.editChain
      .then(() => target.adapter.editMessage(target.chatId, messageId, text, target.threadId))
      .catch(err => this.logger.warn({ err }, "Failed to edit fleet restart progress"));
  }
}
