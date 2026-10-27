/**
 * #2661: an instance's Office level, from its lifetime work — what the Office's name-tag badge and profile card show.
 *
 * - Work tokens: uncached input + cache writes (5 min, 1 h, and a CLI's own write count) + output, over the instance's
 *   whole recorded life. Cache reads are left out: they are most of nearly every total and would make everyone the same
 *   level. Requests are counted beside them (the card's "today").
 * - Level = floor(√(work ÷ LEVEL.UNIT)), no cap: fast early, slower later (1M ≈ Lv 3, 260M ≈ Lv 50, 1B = Lv 100).
 * - Where it comes from: the usage store the usage report reads (#2122) — the rollup's days up to its checkpoint, the
 *   ledger's hours after it (each hour counted once), and the lifetime file's total of the days pruned past 400
 *   (usage-rollup.ts UsageLifetime; a day row it already carries is skipped), so a level never drops as history ages
 *   out. Nothing new is collected or read: no transcript.
 * - Estimated backends (Kiro: text size, not token counts) count too; `estimated` says some of the work was estimated.
 * - First seen: the earliest local date with recorded work or requests (the usage store's own record, so a fleet older
 *   than its usage collection shows when collection began).
 * - Cost: one pass over each instance's rows and hours (at most ~400 days × sources and 31 days of hours), worked out by
 *   the cache service on request and reused for OFFICE_LEVELS_TTL_MS (fleet-manager.ts officeLevels) — never per frame,
 *   per render or per page.
 */
import type { HourTotals, Ledger } from "./cache-ledger.js";
import { ESTIMATED_BACKENDS } from "./usage-report.js";
import { hourSources, localDate, type UsageDays, type UsageLifetime } from "./usage-rollup.js";

export const LEVEL = { UNIT: 100_000 } as const;
/** How long a worked-out set of levels is reused before the next request works it out again. */
export const OFFICE_LEVELS_TTL_MS = 60_000;

/** The work in a totals entry ([requests, uncached, read, write5m, write1h, write, output]): everything but reads. */
export const workOf = (t: HourTotals): number => t[1] + t[3] + t[4] + t[5] + t[6];
/** The level `work` tokens reach. */
export const levelOf = (work: number): number => Math.floor(Math.sqrt(Math.max(0, work) / LEVEL.UNIT));

export interface OfficeLevel {
  level: number;
  /** Lifetime work tokens. */
  workTokens: number;
  /** Some of it was estimated (ESTIMATED_BACKENDS), not measured. */
  estimated: boolean;
  /** The fleet zone's today: work tokens and requests. */
  today: { workTokens: number; requests: number };
  /** The earliest local date (YYYY-MM-DD) with recorded work, or null when there is none. */
  firstSeen: string | null;
}

export interface OfficeLevelsInput {
  now: number;
  /** The fleet's day zone (usageZone). */
  zone: string;
  /** Read only here: the live ledger and rollup may be passed (nothing is kept or changed). */
  instances: Array<{ name: string; ledger: Pick<Ledger, "hours">; days: UsageDays; life: UsageLifetime }>;
}

const dict = <T>(): Record<string, T> => Object.create(null) as Record<string, T>;

/** Every instance's level, by name. */
export function officeLevels(input: OfficeLevelsInput): Record<string, OfficeLevel> {
  const today = localDate(input.now, input.zone);
  const out = dict<OfficeLevel>();
  for (const { name, ledger, days, life } of input.instances) {
    let work = 0, estimated = false, todayWork = 0, todayRequests = 0, first: string | null = null;
    const count = (backend: string, date: string, t: HourTotals): void => {
      const w = workOf(t);
      if (w <= 0 && t[0] <= 0) return;
      work += w;
      if (w > 0 && ESTIMATED_BACKENDS.has(backend)) estimated = true;
      if (first === null || date < first) first = date;
      if (date === today) { todayWork += w; todayRequests += t[0]; }
    };
    if (life.first !== null) for (const [be, t] of Object.entries(life.by)) count(be, life.first, t);
    for (const row of days.rows) {
      if (life.through !== null && row.date <= life.through) continue;   // carried already (a crash before the prune)
      for (const t of Object.values(row.m)) count(row.be, row.date, t);
    }
    for (const [hk, hour] of Object.entries(ledger.hours)) {
      const h = Number(hk);
      if (h <= days.checkpoint) continue;                    // already in the rollup: counted once (usage-rollup.ts)
      const date = localDate(h, input.zone);
      for (const src of hourSources(hour)) for (const t of Object.values(src.m)) count(src.backend, date, t);
    }
    out[name] = { level: levelOf(work), workTokens: work, estimated, today: { workTokens: todayWork, requests: todayRequests }, firstSeen: first };
  }
  return out;
}

/**
 * What a viewer may read of the levels: the level alone (share links, a viewer the usage report is not served to), or
 * the whole entry. `names`: only these (a share's people); omitted, every one.
 */
export function levelsFor(levels: Record<string, OfficeLevel>, detail: boolean, names?: ReadonlySet<string>): Record<string, Partial<OfficeLevel> & { level: number }> {
  const out = dict<Partial<OfficeLevel> & { level: number }>();
  for (const [name, l] of Object.entries(levels)) {
    if (names && !names.has(name)) continue;
    out[name] = detail ? { ...l, today: { ...l.today } } : { level: l.level };
  }
  return out;
}
