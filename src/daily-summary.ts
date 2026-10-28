import { Cron } from "croner";
import type { EventLog } from "./event-log.js";
import type { DailySummaryConfig } from "./types.js";
import { formatCents } from "./cost-guard.js";
import { resolveTz, localWallToUtcDb, localTodayDate } from "./tz-utils.js";

export class DailySummary {
  private job: Cron | null = null;

  constructor(
    private config: DailySummaryConfig,
    private timezone: string,
    /** Every day at the configured time: the report's text, or null when the report is off (#2804). */
    private onSummary: (text: string | null) => void,
    private getSummaryText: () => string,
  ) {}

  /**
   * #2804: the clock always runs — the daily housekeeping (log and inbox rotation) rides on it — and the report is
   * built and handed on only when `enabled`.
   */
  start(): void {
    const cron = `${this.config.minute} ${this.config.hour} * * *`;
    this.job = new Cron(cron, { timezone: this.timezone }, () => {
      this.onSummary(this.config.enabled ? this.getSummaryText() : null);
    });
  }

  stop(): void {
    this.job?.stop();
    this.job = null;
  }

  static generateText(
    eventLog: EventLog,
    instances: string[],
    costCentsMap: Map<string, number>,
    fleetTotalCents: number,
  ): string {
    // Local day boundary: events since LOCAL midnight today, converted to the
    // UTC string event-db stores (matches chat-log / fleet.log local convention).
    const tz = resolveTz();
    const today = localTodayDate(tz);
    const since = localWallToUtcDb(`${today} 00:00:00`, tz);
    const todayEvents = eventLog.query({ since, limit: 1000 });

    const lines: string[] = [`📊 Daily Report — ${today}`, ""];

    for (const name of instances) {
      const instanceEvents = todayEvents.filter(e => e.instance_name === name);
      const hangs = instanceEvents.filter(e => e.event_type === "hang_detected").length;
      const deferred = instanceEvents.filter(e => e.event_type === "schedule_deferred").length;
      const costCents = costCentsMap.get(name) ?? 0;

      let line = `${name}: ${formatCents(costCents)}`;
      if (deferred > 0) line += `, ${deferred} deferred`;

      const anomalies: string[] = [];
      if (hangs > 0) anomalies.push(`${hangs} hang${hangs > 1 ? "s" : ""}`);
      if (anomalies.length > 0) line += ` ⚠️ ${anomalies.join(", ")}`;

      lines.push(line);
    }

    lines.push("");
    lines.push(`Total: ${formatCents(fleetTotalCents)}`);

    return lines.join("\n");
  }
}
