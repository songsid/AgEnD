/**
 * #3066 §1d: the weekly quota readings over time — the history the capacity estimate (§1) matches against the tokens each
 * account used. Only the readings AgEnD already makes (get_usage, the usage page, the Discord presence refresh, the
 * 30-minute background read): never an extra vendor call of its own.
 *
 * One JSON line per change: a weekly metric's percent or its reset time moved since the last line for that (provider,
 * metric). A week is at most ~100 steps of a whole percent, so ≤ ~110 lines an account-week (~1–3 KB). Kept 12 weeks,
 * and never over 2 MB (the oldest lines go first). Written off the fleet's thread (fs/promises), one write at a time.
 * `usage-quota-history.jsonl` in AGEND_HOME.
 */
import { appendFile, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgendHome } from "../paths.js";
import type { ProviderUsage } from "./providers.js";

export interface QuotaReading {
  /** When the reading was made (ms). */
  t: number;
  /** The usage row's id: "claude", "claude:hsinlin", "codex:yanxianchen", … — one account. */
  provider: string;
  /** The credential profile, when the row has one. */
  profile?: string;
  /** The metric's label: "Weekly", "Sonnet (weekly)", … */
  metric: string;
  /** Percent used (0–100, as the vendor reports it). */
  used: number;
  /** When this window resets (ISO), or null when the vendor did not say. */
  resetsAt: string | null;
  windowMs: number | null;
}

export const QUOTA_HISTORY_KEEP_MS = 12 * 7 * 24 * 3_600_000;
export const QUOTA_HISTORY_MAX_BYTES = 2 * 1024 * 1024;
/** A window of a day or longer is a quota worth matching (the five-hour session window is not). */
const MIN_WINDOW_MS = 24 * 3_600_000;

let fileOf: (() => string) | null = () => join(getAgendHome(), "usage-quota-history.jsonl");
/** The last reading written per (provider, metric): what a new one is compared with. */
const last = new Map<string, { used: number; resetsAt: string | null }>();
let loaded = false;
let chain: Promise<void> = Promise.resolve();

const keyOf = (provider: string, metric: string): string => `${provider}\u0000${metric}`;

/** A line from the file, checked whole (it is not trusted): null when it is not a reading. */
export function parseQuotaReading(line: string): QuotaReading | null {
  let v: unknown;
  try { v = JSON.parse(line); } catch { return null; }
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  if (typeof r.t !== "number" || !Number.isFinite(r.t) || typeof r.provider !== "string" || typeof r.metric !== "string"
    || typeof r.used !== "number" || !Number.isFinite(r.used) || !(r.resetsAt === null || typeof r.resetsAt === "string")
    || !(r.windowMs === null || (typeof r.windowMs === "number" && Number.isFinite(r.windowMs)))
    || !(r.profile === undefined || typeof r.profile === "string")) return null;
  return { t: r.t, provider: r.provider, ...(r.profile !== undefined ? { profile: r.profile } : {}), metric: r.metric, used: r.used,
    resetsAt: r.resetsAt as string | null, windowMs: r.windowMs as number | null };
}

/** The weekly-or-longer percent metrics of a good read, as readings at `now`. */
export function quotaReadingsOf(p: ProviderUsage, now: number): QuotaReading[] {
  if (p.status !== "ok") return [];
  const out: QuotaReading[] = [];
  for (const m of p.metrics) {
    if (m.type !== "percent" || typeof m.used !== "number" || !Number.isFinite(m.used)) continue;
    if (typeof m.windowMs !== "number" || m.windowMs < MIN_WINDOW_MS) continue;
    out.push({ t: now, provider: p.id, ...(p.profile ? { profile: p.profile } : {}), metric: m.label, used: m.used,
      resetsAt: typeof m.resetsAt === "string" ? m.resetsAt : null, windowMs: m.windowMs });
  }
  return out;
}

async function load(path: string): Promise<void> {
  if (loaded) return;
  loaded = true;
  let text = "";
  try { text = await readFile(path, "utf8"); } catch { return; }      // none yet
  for (const line of text.split("\n")) {
    const r = line ? parseQuotaReading(line) : null;
    if (r) last.set(keyOf(r.provider, r.metric), { used: r.used, resetsAt: r.resetsAt });
  }
}

/** Keep the last 12 weeks, and the file under its cap (oldest first out). Rewritten atomically. */
async function prune(path: string, now: number): Promise<void> {
  let size = 0;
  try { size = (await stat(path)).size; } catch { return; }
  if (size <= QUOTA_HISTORY_MAX_BYTES) return;
  const lines = (await readFile(path, "utf8")).split("\n").filter((l) => {
    const r = l ? parseQuotaReading(l) : null;
    return r !== null && r.t >= now - QUOTA_HISTORY_KEEP_MS;
  });
  let bytes = lines.reduce((n, l) => n + Buffer.byteLength(l) + 1, 0), from = 0;
  while (bytes > QUOTA_HISTORY_MAX_BYTES * 0.9 && from < lines.length) bytes -= Buffer.byteLength(lines[from++]!) + 1;
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, lines.slice(from).map((l) => `${l}\n`).join(""), { mode: 0o600 });
  await rename(tmp, path);
}

/**
 * Record a good read's weekly readings: a line for each metric whose percent or reset time changed since its last line.
 * Never throws and never blocks the caller: the write is queued (one at a time) and a failure only loses this reading.
 */
export function recordQuotaReadings(p: ProviderUsage, now = Date.now()): void {
  if (!fileOf) return;
  const readings = quotaReadingsOf(p, now);
  if (!readings.length) return;
  const path = fileOf();
  chain = chain.then(async () => {
    await load(path);
    const fresh = readings.filter((r) => {
      const was = last.get(keyOf(r.provider, r.metric));
      return !was || was.used !== r.used || was.resetsAt !== r.resetsAt;
    });
    if (!fresh.length) return;
    await appendFile(path, fresh.map((r) => `${JSON.stringify(r)}\n`).join(""), { mode: 0o600 });
    for (const r of fresh) last.set(keyOf(r.provider, r.metric), { used: r.used, resetsAt: r.resetsAt });
    await prune(path, now);
  }).catch(() => { /* a reading lost; the next one is written */ });
}

/** Every reading kept, oldest first (§1 reads it). Unreadable lines are skipped. */
export async function readQuotaHistory(): Promise<QuotaReading[]> {
  if (!fileOf) return [];
  await chain;
  let text = "";
  try { text = await readFile(fileOf(), "utf8"); } catch { return []; }
  return text.split("\n").map((l) => (l ? parseQuotaReading(l) : null)).filter((r): r is QuotaReading => r !== null).sort((a, b) => a.t - b.t);
}

/** Tests: write to `path` (null: nowhere), starting from what that file holds; resolves when queued writes are done. */
export async function setQuotaHistoryFileForTests(path: string | null): Promise<void> {
  await chain;
  fileOf = path === null ? null : () => path;
  last.clear();
  loaded = false;
}
/** Tests (usage-api's fetcher seam): record nothing, at once — never into the real AGEND_HOME. */
export function quotaHistoryOffForTests(): void { fileOf = null; last.clear(); loaded = false; }
/** Tests: wait for the queued writes. */
export function flushQuotaHistory(): Promise<void> { return chain; }
