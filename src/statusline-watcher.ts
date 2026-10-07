import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { CostGuard } from "./cost-guard.js";
import type { Logger } from "./logger.js";

export interface RateLimitData { five_hour_pct: number; seven_day_pct: number; }
export interface StatuslineWatcherContext {
  readonly logger: Logger;
  readonly costGuard: CostGuard | null;
  getInstanceDir(name: string): string;
  notifyInstanceTopic(name: string, text: string): void;
  checkModelFailover(name: string, fiveHourPct: number): void;
}
interface WatchRegistration { timer: ReturnType<typeof setInterval>; pending: boolean; }

/** Async per-instance reads, at most four physical reads and one pending read per registration. */
export class StatuslineWatcher {
  private watchers = new Map<string, WatchRegistration>();
  private rateLimits = new Map<string, RateLimitData>();
  private queue: Array<{ name: string; registration: WatchRegistration }> = [];
  private active = 0;
  private static readonly POLL_MS = 10_000;
  private static readonly CONCURRENCY = 4;
  constructor(private ctx: StatuslineWatcherContext) {}

  watch(name: string): void {
    if (this.watchers.has(name)) return;
    const registration: WatchRegistration = { timer: setInterval(() => {
      if (registration.pending) return;
      registration.pending = true;
      this.queue.push({ name, registration });
      this.pump();
    }, StatuslineWatcher.POLL_MS), pending: false };
    this.watchers.set(name, registration);
  }

  private pump(): void {
    while (this.active < StatuslineWatcher.CONCURRENCY && this.queue.length) {
      const { name, registration } = this.queue.shift()!;
      if (this.watchers.get(name) !== registration) continue;
      this.active++;
      void this.poll(name, registration).finally(() => {
        this.active--;
        registration.pending = false;
        this.pump();
      });
    }
  }

  private async poll(name: string, registration: WatchRegistration): Promise<void> {
    try {
      const raw = await readFile(join(this.ctx.getInstanceDir(name), "statusline.json"), "utf8");
      // An unwatch/rewatch is a new instance generation even under the same name.
      if (this.watchers.get(name) !== registration) return;
      const data = JSON.parse(raw);
      if (data.cost?.total_cost_usd != null) this.ctx.costGuard?.updateCost(name, data.cost.total_cost_usd);
      const rl = data.rate_limits;
      if (rl) {
        const prev = this.rateLimits.get(name);
        const newSevenDay = rl.seven_day?.used_percentage ?? 0;
        if (prev?.seven_day_pct === 100 && newSevenDay < 100) {
          this.ctx.notifyInstanceTopic(name, `✅ ${name} weekly usage limit has reset — instance is available again.`);
          this.ctx.logger.info({ name }, "Weekly rate limit recovered");
        }
        this.rateLimits.set(name, { five_hour_pct: rl.five_hour?.used_percentage ?? 0, seven_day_pct: newSevenDay });
        this.ctx.checkModelFailover(name, rl.five_hour?.used_percentage ?? 0);
      }
    } catch { /* absent, mid-write, or unavailable file: next scheduled poll */ }
  }

  getRateLimits(name: string): RateLimitData | undefined { return this.rateLimits.get(name); }
  has(name: string): boolean { return this.watchers.has(name); }
  unwatch(name: string, preserveRateLimits = false): void {
    const registration = this.watchers.get(name);
    if (registration) { clearInterval(registration.timer); this.watchers.delete(name); }
    this.queue = this.queue.filter(item => item.name !== name);
    if (!preserveRateLimits) this.rateLimits.delete(name);
  }
  stopAll(): void {
    for (const registration of this.watchers.values()) clearInterval(registration.timer);
    this.watchers.clear(); this.queue = []; this.rateLimits.clear();
  }
}
