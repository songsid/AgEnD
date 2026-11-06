import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { getAgendHome } from "../paths.js";

/** Per-instance record that grok's weekly-limit picker was seen, and when AgEnD may Try Again. */
export const GROK_WEEKLY_RESET_FILE = "grok-weekly-reset";
const GROK_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export type GrokWeeklyResetRecord = { pausedAt: number; resetAt: number; tryAgainConsumed?: boolean };

export function readGrokWeeklyReset(instanceDir: string): GrokWeeklyResetRecord | null {
  try {
    const v = JSON.parse(readFileSync(join(instanceDir, GROK_WEEKLY_RESET_FILE), "utf8")) as { pausedAt?: unknown; resetAt?: unknown; tryAgainConsumed?: unknown };
    const pausedAt = Number(v?.pausedAt), resetAt = Number(v?.resetAt);
    if (!Number.isFinite(pausedAt) || pausedAt <= 0 || !Number.isFinite(resetAt) || resetAt <= 0) return null;
    return { pausedAt, resetAt, ...(v?.tryAgainConsumed === true ? { tryAgainConsumed: true } : {}) };
  } catch {
    return null;
  }
}

export function grokWeeklyResetDue(instanceDir: string, now = Date.now()): boolean {
  const rec = readGrokWeeklyReset(instanceDir);
  return rec !== null && now >= rec.resetAt;
}

export function writeGrokWeeklyReset(instanceDir: string, rec: GrokWeeklyResetRecord): void {
  writeFileSync(join(instanceDir, GROK_WEEKLY_RESET_FILE), JSON.stringify(rec), { encoding: "utf8", mode: 0o600 });
}

export function clearGrokWeeklyReset(instanceDir: string): void {
  try { unlinkSync(join(instanceDir, GROK_WEEKLY_RESET_FILE)); } catch { /* absent */ }
}

/**
 * Last grok weekly `resetsAt` from fleet-wide `usage-quota-history.jsonl`, else a week from `now`.
 * Never a time that has already passed. The file is host-wide: if more than one grok account or credential
 * has written a Weekly-limit row, this can belong to another account. An early Try Again re-shows the
 * picker and then Shift+x pauses, so the cost is bounded.
 */
export function inferGrokWeeklyResetAt(now: number): number {
  let best: number | null = null;
  try {
    const text = readFileSync(join(getAgendHome(), "usage-quota-history.jsonl"), "utf8");
    for (const line of text.split("\n")) {
      if (!line) continue;
      let v: unknown;
      try { v = JSON.parse(line); } catch { continue; }
      if (!v || typeof v !== "object") continue;
      const r = v as { provider?: unknown; metric?: unknown; resetsAt?: unknown };
      if (r.provider !== "grok" || r.metric !== "Weekly limit" || typeof r.resetsAt !== "string") continue;
      const t = Date.parse(r.resetsAt);
      if (Number.isFinite(t)) best = t;
    }
  } catch { /* no history yet */ }
  return best !== null && best > now ? best : now + GROK_WEEK_MS;
}

export function noteGrokWeeklyLimitSeen(instanceDir: string, now = Date.now()): void {
  const rec = readGrokWeeklyReset(instanceDir);
  // Keep a clock that is still ahead, and a due clock that has not yet Try Again'd (so the next
  // scan can still select it). After Try Again has been consumed for this episode, Shift+x starts
  // a new pause window — re-arm only then.
  if (rec && (now < rec.resetAt || !rec.tryAgainConsumed)) return;
  try {
    writeGrokWeeklyReset(instanceDir, { pausedAt: now, resetAt: inferGrokWeeklyResetAt(now) });
  } catch { /* matcher-only tests pass a path that may not exist */ }
}

/** This reset episode has already sent Try Again. Survives the daemon's one-slot autoResolvedDialogKey. */
export function markGrokWeeklyTryAgainConsumed(instanceDir: string): void {
  const rec = readGrokWeeklyReset(instanceDir);
  if (!rec || rec.tryAgainConsumed) return;
  try {
    writeGrokWeeklyReset(instanceDir, { ...rec, tryAgainConsumed: true });
  } catch { /* matcher-only tests pass a path that may not exist */ }
}
