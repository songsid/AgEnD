/**
 * #1629: the one rate limiter for every agent appearance write — theme, effect, widget and mod (r2 (c), r4) — and the
 * fleet-wide switch. Shared by the theme tools (B1) and the effect tools (B2): one budget per instance, not one each.
 *
 * - change: at least 30 s between accepted changes and at most 10 in a rolling hour (set_web_theme, apply/remove of an
 *   effect or widget, an agent's own reset);
 * - upload: at most 3 in a rolling hour (theme assets, effects and widgets, proposed mods together);
 * - data: a placed widget's new values (r4-4) — at least 10 s apart and at most 180 in a rolling hour, a budget of its
 *   own, so a widget showing progress never spends the theme's changes.
 *
 * Only accepted calls count: a handler asks `check` before it validates, and `record`s only after its write is on
 * disk, all in one synchronous stretch (a refused or invalid call, or a failed write, costs nothing). The clock is
 * monotonic, so a wall-clock jump neither opens nor closes the window; a fleet restart clears it (documented).
 * The human's reset, lock and removals are never limited.
 */

export type AppearanceBucket = "change" | "upload" | "data";
export const APPEARANCE_LIMITS = { changeGapMs: 30_000, changesPerHour: 10, uploadsPerHour: 3, dataGapMs: 10_000, dataPerHour: 180 } as const;
const HOUR_MS = 60 * 60 * 1000;

export type LimitVerdict = { ok: true } | { ok: false; error: "rate_limited"; retry_after_s: number };

export class AppearanceLimiter {
  private readonly changes = new Map<string, number[]>();
  private readonly uploads = new Map<string, number[]>();
  private readonly data = new Map<string, number[]>();
  constructor(private readonly now: () => number = () => performance.now(), private readonly limits = APPEARANCE_LIMITS) {}

  private recent(map: Map<string, number[]>, instance: string, now: number): number[] {
    const kept = (map.get(instance) ?? []).filter(t => now - t < HOUR_MS);
    if (kept.length) map.set(instance, kept); else map.delete(instance);
    return kept;
  }
  private waitMs(instance: string, buckets: readonly AppearanceBucket[], now: number): number {
    const waits: number[] = [];
    if (buckets.includes("change")) {
      const c = this.recent(this.changes, instance, now);
      const last = c.at(-1);
      if (last !== undefined && now - last < this.limits.changeGapMs) waits.push(this.limits.changeGapMs - (now - last));
      if (c.length >= this.limits.changesPerHour) waits.push(HOUR_MS - (now - c[0]!));
    }
    if (buckets.includes("upload")) {
      const u = this.recent(this.uploads, instance, now);
      if (u.length >= this.limits.uploadsPerHour) waits.push(HOUR_MS - (now - u[0]!));
    }
    if (buckets.includes("data")) {
      const d = this.recent(this.data, instance, now);
      const last = d.at(-1);
      if (last !== undefined && now - last < this.limits.dataGapMs) waits.push(this.limits.dataGapMs - (now - last));
      if (d.length >= this.limits.dataPerHour) waits.push(HOUR_MS - (now - d[0]!));
    }
    return waits.length ? Math.max(...waits) : 0;
  }

  /** Would these buckets admit a call now? Changes nothing. */
  check(instance: string, buckets: readonly AppearanceBucket[]): LimitVerdict {
    const wait = this.waitMs(instance, buckets, this.now());
    return wait > 0 ? { ok: false, error: "rate_limited", retry_after_s: Math.ceil(wait / 1000) } : { ok: true };
  }
  /** Count an accepted call — only after its write succeeded. */
  record(instance: string, buckets: readonly AppearanceBucket[]): void {
    const now = this.now();
    if (buckets.includes("change")) this.changes.set(instance, [...this.recent(this.changes, instance, now), now]);
    if (buckets.includes("upload")) this.uploads.set(instance, [...this.recent(this.uploads, instance, now), now]);
    if (buckets.includes("data")) this.data.set(instance, [...this.recent(this.data, instance, now), now]);
  }
  /** What an agent sees in get_web_theme (and B2's tools): what is left, and when the next change may come. */
  remaining(instance: string): { changes: number; uploads: number; retry_after_s: number; widget_data: number; widget_data_retry_after_s: number } {
    const now = this.now();
    return {
      changes: Math.max(0, this.limits.changesPerHour - this.recent(this.changes, instance, now).length),
      uploads: Math.max(0, this.limits.uploadsPerHour - this.recent(this.uploads, instance, now).length),
      retry_after_s: Math.ceil(this.waitMs(instance, ["change"], now) / 1000),
      widget_data: Math.max(0, this.limits.dataPerHour - this.recent(this.data, instance, now).length),
      widget_data_retry_after_s: Math.ceil(this.waitMs(instance, ["data"], now) / 1000),
    };
  }
  /** An instance removed: its counters go with it. */
  forget(instance: string): void { this.changes.delete(instance); this.uploads.delete(instance); this.data.delete(instance); }
}

/** `web.themes.agent_edit` (default true): false turns every agent appearance write off, fleet-wide; stored choices stay. */
export function agentAppearanceEditAllowed(web: { themes?: { agent_edit?: boolean } } | undefined | null): boolean {
  return web?.themes?.agent_edit !== false;
}
