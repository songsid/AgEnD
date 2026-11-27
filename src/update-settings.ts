/**
 * `updates.*` in fleet.yaml (design #4480 §6). Phase 1 stores the mode and only *Ask me* acts;
 * *Automatically when idle* is accepted and ignored until Phase 5. Pause windows hold an idle
 * wait (they do not cancel it). A pin means nothing is offered.
 */
export interface UpdatePauseWindow {
  days: number[];
  from: string;
  to: string;
}

export interface UpdatesSettings {
  mode?: "ask" | "auto-when-idle";
  pause?: UpdatePauseWindow[];
  pin?: string | null;
  /** Hours, 1..168. Absent means 24. */
  maxIdleWait?: number;
}

export interface ResolvedUpdates {
  mode: "ask" | "auto-when-idle";
  pause: UpdatePauseWindow[];
  pin: string | null;
  maxIdleWait: number;
}

export const DEFAULT_MAX_IDLE_WAIT_HOURS = 24;
const HOUR = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function resolveUpdates(raw: UpdatesSettings | undefined): ResolvedUpdates {
  const wait = raw?.maxIdleWait;
  return {
    mode: raw?.mode === "auto-when-idle" ? "auto-when-idle" : "ask",
    pause: raw?.pause ?? [],
    pin: typeof raw?.pin === "string" && raw.pin.trim() ? raw.pin.trim() : null,
    maxIdleWait: typeof wait === "number" && Number.isInteger(wait) && wait >= 1 && wait <= 168 ? wait : DEFAULT_MAX_IDLE_WAIT_HOURS,
  };
}

/** Minutes from midnight for `HH:MM`, or null. */
function minutes(value: string): number | null {
  const m = HOUR.exec(value);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/**
 * True when `now` (the fleet machine's local clock) sits in a pause window.
 * `from === to` is empty. A window that passes midnight (`22:00`–`06:00`) wraps.
 */
export function inUpdatePause(pause: readonly UpdatePauseWindow[], now: Date): boolean {
  const day = now.getDay();
  const at = now.getHours() * 60 + now.getMinutes();
  for (const window of pause) {
    if (!window.days.includes(day)) continue;
    const from = minutes(window.from);
    const to = minutes(window.to);
    if (from === null || to === null || from === to) continue;
    if (from < to) { if (at >= from && at < to) return true; }
    else if (at >= from || at < to) return true;
  }
  return false;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Drop fields the validator rejects so a bad section cannot change runtime behaviour. */
export function updatesFromRaw(raw: unknown): UpdatesSettings | undefined {
  if (raw === undefined) return undefined;
  if (!isObject(raw)) return undefined;
  const out: UpdatesSettings = {};
  if (raw.mode === "ask" || raw.mode === "auto-when-idle") out.mode = raw.mode;
  if (Array.isArray(raw.pause)) {
    const pause: UpdatePauseWindow[] = [];
    for (const row of raw.pause) {
      if (!isObject(row) || !Array.isArray(row.days) || typeof row.from !== "string" || typeof row.to !== "string") continue;
      const days = row.days.filter((d): d is number => typeof d === "number" && Number.isInteger(d) && d >= 0 && d <= 6);
      if (days.length !== row.days.length || new Set(days).size !== days.length || days.length === 0) continue;
      if (!HOUR.test(row.from) || !HOUR.test(row.to) || row.from === row.to) continue;
      pause.push({ days, from: row.from, to: row.to });
    }
    if (pause.length === raw.pause.length) out.pause = pause;
  }
  if (raw.pin === null) out.pin = null;
  else if (typeof raw.pin === "string" && raw.pin.trim() && raw.pin.length <= 128) out.pin = raw.pin.trim();
  if (typeof raw.maxIdleWait === "number" && Number.isInteger(raw.maxIdleWait) && raw.maxIdleWait >= 1 && raw.maxIdleWait <= 168) out.maxIdleWait = raw.maxIdleWait;
  return out;
}

export function updatesProblems(raw: unknown): Array<{ path: string; message: string }> {
  if (raw === undefined) return [];
  const problems: Array<{ path: string; message: string }> = [];
  const err = (path: string, message: string) => problems.push({ path, message });
  if (!isObject(raw)) { err("updates", "must be a mapping"); return problems; }
  for (const key of Object.keys(raw)) {
    if (key !== "mode" && key !== "pause" && key !== "pin" && key !== "maxIdleWait") err(`updates.${key}`, "unknown key (mode, pause, pin, maxIdleWait)");
  }
  if (raw.mode !== undefined && raw.mode !== "ask" && raw.mode !== "auto-when-idle") err("updates.mode", 'must be "ask" or "auto-when-idle"');
  if (raw.pause !== undefined && !Array.isArray(raw.pause)) err("updates.pause", "must be a list");
  else if (Array.isArray(raw.pause)) {
    raw.pause.forEach((row, i) => {
      const path = `updates.pause.${i}`;
      if (!isObject(row)) { err(path, "must be a mapping of days, from, to"); return; }
      for (const key of Object.keys(row)) if (key !== "days" && key !== "from" && key !== "to") err(`${path}.${key}`, "unknown key (days, from, to)");
      if (!Array.isArray(row.days) || row.days.length === 0 || row.days.some(d => typeof d !== "number" || !Number.isInteger(d) || d < 0 || d > 6) || new Set(row.days).size !== row.days.length) {
        err(`${path}.days`, "must be whole days 0 (Sunday) through 6, with no repeats");
      }
      if (typeof row.from !== "string" || !HOUR.test(row.from)) err(`${path}.from`, "must be HH:MM (00:00–23:59)");
      if (typeof row.to !== "string" || !HOUR.test(row.to)) err(`${path}.to`, "must be HH:MM (00:00–23:59)");
      if (typeof row.from === "string" && row.from === row.to) err(`${path}.to`, "must differ from from");
    });
  }
  if (raw.pin !== undefined && raw.pin !== null && (typeof raw.pin !== "string" || !raw.pin.trim() || raw.pin.length > 128)) err("updates.pin", "must be a version string, or null");
  if (raw.maxIdleWait !== undefined && (typeof raw.maxIdleWait !== "number" || !Number.isInteger(raw.maxIdleWait) || raw.maxIdleWait < 1 || raw.maxIdleWait > 168)) {
    err("updates.maxIdleWait", "must be a whole number of hours from 1 to 168");
  }
  return problems;
}

/**
 * M-3770 1.4: Settings → Version and update's partial patch of `updates.*` (PUT /api/settings/fleet/updates; the settings
 * transaction classifies the same result, settings-effect.ts). Only the four keys; `pin: null` removes the pin; the result
 * is validated as fleet.yaml is.
 */
export function applyUpdatesPatch(current: unknown, body: unknown):
  | { ok: true; next: Record<string, unknown>; keys: string[]; patch: Record<string, unknown> }
  | { ok: false; error: string; problems?: Array<{ path: string; message: string }> } {
  if (!isObject(body)) return { ok: false, error: "updates: a mapping of mode, pause, pin, maxIdleWait" };
  const keys = Object.keys(body);
  if (!keys.length || keys.some(k => k !== "mode" && k !== "pause" && k !== "pin" && k !== "maxIdleWait")) return { ok: false, error: "updates: only mode, pause, pin, maxIdleWait" };
  const next: Record<string, unknown> = { ...(isObject(current) ? current : {}), ...body };
  if (next.pin === null) delete next.pin;
  const problems = updatesProblems(next);
  if (problems.length) return { ok: false, error: "invalid_updates", problems };
  return { ok: true, next, keys, patch: body };
}

/**
 * #4487 review P1: which keys of an `updates.*` change let an update go ahead that would not have before — those are held
 * for confirmation; a change that only holds updates back applies at once.
 * - mode: to "auto-when-idle" (Phase 5's automatic updates).
 * - pin: removed or changed (an offer the pin held back comes through); setting one where there was none only holds back.
 * - pause: a window removed or changed (a waiting update may start in it); only adding windows holds back.
 * - maxIdleWait: never — past it AgEnD asks again; it never starts an update.
 */
export function updatesLoosened(before: unknown, after: unknown): string[] {
  const a = resolveUpdates(updatesFromRaw(before)), b = resolveUpdates(updatesFromRaw(after));
  const out: string[] = [];
  if (b.mode === "auto-when-idle" && a.mode !== "auto-when-idle") out.push("mode");
  if (a.pin !== null && a.pin !== b.pin) out.push("pin");
  const key = (w: UpdatePauseWindow) => JSON.stringify([[...w.days].sort((x, y) => x - y), w.from, w.to]);
  const kept = new Set(b.pause.map(key));
  if (a.pause.some(w => !kept.has(key(w)))) out.push("pause");
  return out;
}
