import { EventEmitter } from "node:events";

export class HangDetector extends EventEmitter {
  private lastActivityTs = 0;
  private lastStatuslineTs = 0;
  private lastInboundTs = 0;
  private hungEmitted = false;
  private checkTimer: ReturnType<typeof setInterval> | null = null;
  private timeoutMs: number;

  constructor(timeoutMinutes: number) {
    super();
    this.timeoutMs = timeoutMinutes * 60 * 1000;
  }

  recordActivity(): void {
    this.lastActivityTs = Date.now();
    if (this.hungEmitted) {
      this.hungEmitted = false;
    }
  }

  recordInbound(): void {
    this.lastInboundTs = Date.now();
  }

  recordStatuslineUpdate(): void {
    this.lastStatuslineTs = Date.now();
  }

  isHung(): boolean {
    if (this.lastActivityTs === 0) return false;
    if (this.lastInboundTs === 0) return false;
    const now = Date.now();
    // Only flag as hung if:
    // 1. There's an inbound that hasn't been answered (no activity since inbound)
    // 2. Timeout has elapsed since that inbound
    const noActivitySinceInbound = this.lastActivityTs < this.lastInboundTs;
    const stale = now - this.lastInboundTs > this.timeoutMs;
    return stale && noActivitySinceInbound;
  }

  start(intervalMs = 60_000): void {
    this.checkTimer = setInterval(() => {
      if (this.isHung() && !this.hungEmitted) {
        this.hungEmitted = true;
        this.emit("hang");
      }
    }, intervalMs);
  }

  stop(): void {
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = null;
    }
  }
}
