/**
 * #2122 §5: the daily usage rollup — what the cache ledger (cache-ledger.ts, hourly, 31 days) no longer keeps, folded
 * into days so the usage report can go back up to 400 days. One file per instance, `usage-days.json`, beside the ledger.
 *
 * - Two tiers, one checkpoint: an hour is in the rollup if and only if it is at or before `checkpoint` (a UTC hour);
 *   otherwise it is only in the ledger. A view is the rollup up to the checkpoint plus the ledger after it.
 * - Fold, then prune: the hours about to leave the ledger and after the checkpoint are added to their days, the rollup
 *   is written (atomic rename) with the new checkpoint, and only then may the ledger drop hours at or before it
 *   (pruneLedger's `foldedThrough`). A crash between the two leaves those hours in both; the next fold skips them (they
 *   are at or before the checkpoint) and the prune finishes. A crash before the write moves nothing.
 * - Days at hour granularity: an hour belongs to the local date its start falls on in the fleet's zone (in a zone with
 *   a half-hour offset a day's edge falls on the hour that holds local midnight — said so on the page). Each day row
 *   records its zone; changing the zone re-buckets only the ledger's hours.
 * - Provenance: each row is one source — the backend whose reader read it and the credential profile it was read under
 *   (hourSources) — kept apart, so an instance that changes backend or profile never relabels what it read before.
 *   Hours counted before #2122 have no source: they are "unknown", never today's backend.
 * - Coverage: what the scanner has read, as merged UTC intervals — never inferred from missing hours (an idle hour has
 *   no bucket and is a real zero).
 * Messages are not here: they are counted in the delivery database (human-delivery-receipts.ts).
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { HourAgg, HourTotals, Ledger } from "./cache-ledger.js";

export const ROLLUP_KEEP_DAYS = 400;
const HOUR = 3_600_000;
const DAY = 86_400_000;
/** Coverage intervals kept per instance; beyond it the two oldest merge (an over-wide interval only hides a gap). */
export const COVERAGE_MAX = 64;

/**
 * One day row: its local date, the zone it was folded in, its source (backend, profile) → model|tier → totals, and
 * (#2122 §10.3) the reasoning part of those totals' output by model|tier, kept beside them (cache-ledger.ts `rs`).
 */
export interface DayRow { date: string; zone: string; be: string; pf: string; m: Record<string, HourTotals>; r?: Record<string, number>; c?: Record<string, number> }

/** Where an hour's totals were read: the backend whose reader read them ("unknown" before #2122), and the profile. */
/** `r`: the reasoning part of each model key's output; `c`: the cost the CLI reported for it (USD), where it did. */
export interface HourSource { backend: string; profile: string; m: Record<string, HourTotals>; r: Record<string, number>; c: Record<string, number> }
const READER_BACKEND: Record<string, string> = { claude: "claude-code", codex: "codex", kiro: "kiro-cli", grok: "grok", muse: "muse", opencode: "opencode", antigravity: "antigravity" };
/**
 * An hour's totals by source (cache-ledger.ts `src`), each exact. What `m` holds beyond them was counted before #2122:
 * one more source, backend and profile "unknown".
 */
export function hourSources(hour: HourAgg): HourSource[] {
  const out: HourSource[] = [];
  const known = dict<HourTotals>();
  for (const [sk, m] of Object.entries(hour.src ?? {})) {
    const colon = sk.indexOf(":");
    out.push({ backend: READER_BACKEND[sk.slice(0, colon)] ?? "unknown", profile: sk.slice(colon + 1), m, r: hour.rs?.[sk] ?? dict<number>(), c: hour.cs?.[sk] ?? dict<number>() });
    for (const [mk, t] of Object.entries(m)) add(known[mk] ??= [0, 0, 0, 0, 0, 0, 0], t);
  }
  const legacy = dict<HourTotals>();
  for (const [mk, t] of Object.entries(hour.m)) {
    const k = known[mk], rest = t.map((n, i) => n - (k?.[i] ?? 0)) as HourTotals;
    if (rest.some(n => n > 0)) legacy[mk] = rest.map(n => Math.max(0, n)) as HourTotals;
  }
  if (Object.keys(legacy).length) out.push({ backend: "unknown", profile: "unknown", m: legacy, r: dict<number>(), c: dict<number>() });
  return out;
}
export interface UsageDays {
  v: 1;
  /** The last UTC hour (ms) held here; -1: none yet. */
  checkpoint: number;
  rows: DayRow[];
  /** Merged UTC intervals [from, to] the scanner has read (§5.5). */
  coverage: Array<[number, number]>;
}

const dict = <T>(): Record<string, T> => Object.create(null) as Record<string, T>;
const add = (into: HourTotals, from: HourTotals): void => { for (let i = 0; i < 7; i++) into[i] = (into[i] ?? 0) + (from[i] ?? 0); };
export const emptyDays = (): UsageDays => ({ v: 1, checkpoint: -1, rows: [], coverage: [] });

/** A rollup read back from disk; anything that is not one is empty. */
export function reviveDays(raw: unknown): UsageDays {
  const d = emptyDays();
  if (!raw || typeof raw !== "object" || (raw as UsageDays).v !== 1) return d;
  const r = raw as UsageDays;
  if (Number.isSafeInteger(r.checkpoint)) d.checkpoint = r.checkpoint;
  if (Array.isArray(r.rows)) for (const row of r.rows) {
    if (!row || typeof row.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(row.date) || typeof row.zone !== "string" || typeof row.be !== "string" || typeof row.pf !== "string") continue;
    const m = dict<HourTotals>();
    for (const [k, t] of Object.entries(row.m ?? {})) if (Array.isArray(t) && t.length === 7 && t.every(n => Number.isFinite(n))) m[k] = t as HourTotals;
    const beside = (raw: unknown): Record<string, number> => {
      const out = dict<number>();
      for (const [k, n] of Object.entries((raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>)) if (m[k] && typeof n === "number" && Number.isFinite(n) && n > 0) out[k] = n;
      return out;
    };
    const r = beside(row.r), c = beside(row.c);
    d.rows.push({ date: row.date, zone: row.zone, be: row.be, pf: row.pf, m, ...(Object.keys(r).length ? { r } : {}), ...(Object.keys(c).length ? { c } : {}) });
  }
  if (Array.isArray(r.coverage)) for (const c of r.coverage) if (Array.isArray(c) && c.length === 2 && Number.isFinite(c[0]) && Number.isFinite(c[1]) && c[0] <= c[1]) d.coverage.push([c[0], c[1]]);
  return d;
}

/** The local date (YYYY-MM-DD) an instant falls on in `zone` (an IANA name; an unknown one is UTC). */
export function localDate(t: number, zone: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(t));
  } catch {
    return new Date(t).toISOString().slice(0, 10);
  }
}


/**
 * Fold the ledger's hours that are about to leave it (older than `cutoff`) and after the checkpoint into their days.
 * Mutates `days`; returns whether anything moved. Never folds an hour at or before the checkpoint (it is already here),
 * so a fold repeated after a crash adds nothing twice.
 */
export function foldHours(days: UsageDays, ledger: Ledger, cutoff: number, zone: string): boolean {
  const hours = Object.keys(ledger.hours).map(Number).filter(h => h + HOUR <= cutoff && h > days.checkpoint).sort((a, b) => a - b);
  if (!hours.length) return false;
  const index = new Map(days.rows.map((r, i) => [`${r.date}\u0000${r.zone}\u0000${r.be}\u0000${r.pf}`, i]));
  for (const h of hours) {
    const date = localDate(h, zone);
    for (const src of hourSources(ledger.hours[String(h)]!)) {
      const key = `${date}\u0000${zone}\u0000${src.backend}\u0000${src.profile}`;
      let i = index.get(key);
      if (i === undefined) { i = days.rows.push({ date, zone, be: src.backend, pf: src.profile, m: dict<HourTotals>() }) - 1; index.set(key, i); }
      const row = days.rows[i]!;
      for (const [mk, tot] of Object.entries(src.m)) add(row.m[mk] ??= [0, 0, 0, 0, 0, 0, 0], tot);
      for (const [mk, n] of Object.entries(src.r)) { const r = row.r ??= dict<number>(); r[mk] = (r[mk] ?? 0) + n; }
      for (const [mk, n] of Object.entries(src.c)) { const c = row.c ??= dict<number>(); c[mk] = (c[mk] ?? 0) + n; }
    }
  }
  days.checkpoint = hours[hours.length - 1]!;
  return true;
}

/** Drop day rows older than the rollup keeps (by date, against `now` in `zone`). */
export function pruneDays(days: UsageDays, now: number, zone: string): boolean {
  const oldest = localDate(now - ROLLUP_KEEP_DAYS * DAY, zone);
  const before = days.rows.length;
  days.rows = days.rows.filter(r => r.date >= oldest);
  const cov = days.coverage.filter(([, to]) => to >= now - ROLLUP_KEEP_DAYS * DAY);
  const changed = days.rows.length !== before || cov.length !== days.coverage.length;
  days.coverage = cov;
  return changed;
}

/** Record that the scanner has read [from, to]: merged into the intervals, at most COVERAGE_MAX of them. */
export function addCoverage(days: UsageDays, from: number, to: number): void {
  if (!(from <= to)) return;
  const all = [...days.coverage, [from, to] as [number, number]].sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const [a, b] of all) {
    const last = merged[merged.length - 1];
    if (last && a <= last[1] + HOUR) last[1] = Math.max(last[1], b);
    else merged.push([a, b]);
  }
  while (merged.length > COVERAGE_MAX) { const [x, y] = merged.splice(0, 2); merged.unshift([x![0], y![1]]); }
  days.coverage = merged;
}

/** Whether the scanner has read the hour starting at `h`. */
export const covered = (days: UsageDays, h: number): boolean => days.coverage.some(([a, b]) => h + HOUR > a && h <= b);

export async function readDays(path: string): Promise<UsageDays> {
  try { return reviveDays(JSON.parse(await readFile(path, "utf8"))); } catch { return emptyDays(); }
}

/** Written whole and renamed into place (0600): a crash leaves the old file or the new one, never a mix. */
export async function writeDays(path: string, days: UsageDays): Promise<boolean> {
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(tmp, JSON.stringify(days), { mode: 0o600 });
    await rename(tmp, path);
    return true;
  } catch { return false; }
}
