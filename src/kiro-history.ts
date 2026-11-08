/** #3450: crash-recoverable automatic import, separate from the recent scanner's cursors.
 * A page's rows and keyset advance in one atomic file. A ready job is immutable; its lifetime receipt is written
 * before its rollup, then a compact done marker. Retrying any of these writes never re-adds the lifetime totals.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Ledger } from "./cache-ledger.js";
import type { KiroHistoryCursor } from "./kiro-history-scan.js";
import { localDate, type DayRow, type UsageDays, type UsageLifetime } from "./usage-rollup.js";

export interface KiroHistoryJob {
  v: 1; binding: string; before: string; zone: string; profile: string;
  phase: "scanning" | "ready" | "done"; cursor: KiroHistoryCursor; rows: DayRow[];
}
export const historyBinding = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function historyBefore(cutoff: number, zone: string, days: UsageDays, life: UsageLifetime, ledger: Ledger): string {
  // Whole days only: never fill the unrecorded portion of an already recorded/boundary day. Existing carried
  // lifetime days cannot be reconstructed individually; conservatively stay before its earliest recorded day too.
  const dates = [localDate(Math.floor(cutoff / 3_600_000) * 3_600_000, zone), ...days.rows.map(r => r.date),
    ...Object.keys(ledger.hours).map(h => localDate(Number(h), zone))];
  if (life.first) dates.push(life.first);
  else if (life.through) dates.push(life.through);
  return dates.reduce((a, b) => a < b ? a : b);
}
export function mergeHistoryRows(into: DayRow[], rows: DayRow[]): void {
  const byKey = new Map(into.map(r => [JSON.stringify([r.date, r.zone, r.be, r.pf]), r]));
  for (const r of rows) {
    const key = JSON.stringify([r.date, r.zone, r.be, r.pf]);
    let dest = byKey.get(key);
    if (!dest) { dest = structuredClone(r); into.push(dest); byKey.set(key, dest); continue; }
    for (const [model, t] of Object.entries(r.m)) {
      const sum = dest.m[model] ??= [0, 0, 0, 0, 0, 0, 0];
      for (let n = 0; n < 7; n++) sum[n] = sum[n]! + t[n]!;
    }
  }
}
export function applyHistoryLifetime(life: UsageLifetime, job: KiroHistoryJob): void {
  if (life.kiroBackfill === job.binding) return;
  if (life.kiroBackfill) throw new Error("Kiro history already imported for this instance");
  for (const r of job.rows) {
    const total = life.by[r.be] ??= [0, 0, 0, 0, 0, 0, 0];
    for (const t of Object.values(r.m)) for (let n = 0; n < 7; n++) total[n] = total[n]! + t[n]!;
    if (life.first === null || r.date < life.first) life.first = r.date;
    if (life.through === null || r.date > life.through) life.through = r.date;
  }
  life.kiroBackfill = job.binding;
}
export function applyHistoryDays(days: UsageDays, job: KiroHistoryJob): void {
  const present = new Set(days.rows.map(r => r.date));
  // A retry after the lifetime write uses the same immutable rows. Skip the entire date, even if its existing
  // profile/model differs: filling only part of a recorded date could double count a pre-upgrade estimate.
  days.rows.push(...structuredClone(job.rows.filter(r => !present.has(r.date))));
}
export async function readHistoryJob(path: string): Promise<KiroHistoryJob | null> {
  try {
    const job = JSON.parse(await readFile(path, "utf8")) as KiroHistoryJob;
    if (job.v !== 1 || !/^[a-f0-9]{64}$/.test(job.binding) || !/^\d{4}-\d{2}-\d{2}$/.test(job.before) ||
      !["scanning", "ready", "done"].includes(job.phase) || !Array.isArray(job.rows) || !job.cursor ||
      !["classic", "tui"].includes(job.cursor.phase) || typeof job.cursor.key !== "string" || typeof job.cursor.id !== "string" ||
      typeof job.zone !== "string" || typeof job.profile !== "string") throw new Error("Invalid Kiro history progress");
    for (const row of job.rows) {
      if (!row || !/^\d{4}-\d{2}-\d{2}$/.test(row.date) || row.date >= job.before || row.zone !== job.zone ||
        row.be !== "kiro-cli" || row.pf !== job.profile || !row.m || typeof row.m !== "object" ||
        !Object.values(row.m).every(t => Array.isArray(t) && t.length === 7 && t.every(n => Number.isFinite(n) && n >= 0)))
        throw new Error("Invalid Kiro history rows");
    }
    return job;
  } catch (e) { if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return null; throw e; }
}
export async function writeHistoryJob(path: string, job: KiroHistoryJob): Promise<boolean> {
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(tmp, JSON.stringify(job), { mode: 0o600 }); await rename(tmp, path); return true;
  } catch { return false; }
}
