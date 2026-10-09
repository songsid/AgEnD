/**
 * Claude rate limits read from what the CLI already knows.
 *
 * Every claude-code instance writes `statusline.json` on each turn, and that
 * file carries the same 5-hour and weekly percentages the usage API returns:
 *
 *   "rate_limits": {
 *     "five_hour": { "used_percentage": 29, "resets_at": 1785669000 },
 *     "seven_day": { "used_percentage": 22, "resets_at": 1786147200 }
 *   }
 *
 * (`resets_at` is epoch **seconds** in the real files; the parser below also
 * accepts milliseconds and ISO strings so a format change is not an outage.)
 *
 * This source costs no token and no API call. When it is present, though, is
 * decided entirely by the CLI, and reading its 2.1.220 binary pins that down:
 * the statusline payload includes `rate_limits` only when the CLI's own cache
 * of the `anthropic-ratelimit-unified-{5h,7d}-*` response headers is non-empty,
 * and that cache is cleared unless the session is first-party Anthropic
 * (not Bedrock/Vertex) and authenticating with an OAuth token carrying the
 * `user:inference` scope. So:
 *
 * - interactive `/login` and `CLAUDE_CODE_OAUTH_TOKEN` (incl. `setup-token`)
 *   both qualify — the env-token path defaults its scopes to exactly
 *   `["user:inference"]`;
 * - a plain `ANTHROPIC_API_KEY` login does NOT, and never writes the field;
 * - it is also absent until the process has received its first API response,
 *   so a freshly started or idle instance has no reading yet.
 *
 * What it never carries is the plan name, the per-model weekly windows, which
 * window is currently binding, or extra-usage credits; only the API has those.
 *
 * Merge rule across instances: **the freshest file wins.** Every instance on
 * this machine shares one account, so they are all observing the same counter;
 * when two readings disagree the newer one is simply the more recent
 * observation. Taking the maximum instead would be wrong precisely when it
 * matters — a pre-reset 95% from an hour ago would drown out a fresh 4%.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { getAgendHome } from "../paths.js";

/** Older than this and we would rather say nothing — see isFresh below. */
export const STATUSLINE_MAX_AGE_MS = 60 * 60_000;

export interface StatuslineWindow {
  usedPercent: number;
  /** Epoch ms, or null when the file has no usable reset time. */
  resetsAtMs: number | null;
}

export interface StatuslineRateLimits {
  fiveHour: StatuslineWindow | null;
  sevenDay: StatuslineWindow | null;
  /** Which instance the reading came from — shown when the data is not fresh. */
  instance: string;
  /** When that instance last wrote the file. */
  observedAtMs: number;
}

/** A statusline window's `resets_at` as epoch ms, or null when it has no usable reset time. */
export function statuslineResetsAtMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    // Seconds in practice; tolerate milliseconds so a format change is not an outage.
    return Math.abs(value) < 1e10 ? value * 1000 : value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = new Date(value).getTime();
    if (!Number.isNaN(parsed)) return parsed;
  }
  return null;
}

function parseWindow(raw: unknown, now: number): StatuslineWindow | null {
  const w = raw as { used_percentage?: unknown; resets_at?: unknown } | undefined;
  if (typeof w?.used_percentage !== "number" || !Number.isFinite(w.used_percentage)) return null;

  const resetsAtMs = statuslineResetsAtMs(w.resets_at);

  // A window whose reset time has passed has rolled over: the percentage in the
  // file describes a window that no longer exists. Reporting it would show a
  // scary 95% for a quota that is actually empty.
  if (resetsAtMs !== null && resetsAtMs <= now) return null;

  return { usedPercent: w.used_percentage, resetsAtMs };
}

function readOne(dir: string, name: string, now: number): StatuslineRateLimits | null {
  const file = join(dir, name, "statusline.json");
  let observedAtMs: number;
  let raw: string;
  try {
    observedAtMs = statSync(file).mtimeMs;
    raw = readFileSync(file, "utf-8");
  } catch {
    return null; // no statusline: not a claude-code instance, or it never ran
  }

  let parsed: { rate_limits?: unknown };
  try { parsed = JSON.parse(raw) as { rate_limits?: unknown }; } catch { return null; }

  // The CLI writes this file mid-turn, so a truncated read is normal, not a bug.
  const rl = parsed.rate_limits as { five_hour?: unknown; seven_day?: unknown } | undefined;
  if (!rl) return null;

  const fiveHour = parseWindow(rl.five_hour, now);
  const sevenDay = parseWindow(rl.seven_day, now);
  if (!fiveHour && !sevenDay) return null;

  return { fiveHour, sevenDay, instance: name, observedAtMs };
}

/**
 * The most recent rate-limit reading any claude-code instance has written, or
 * null when no instance has one worth using.
 */
export function readStatuslineRateLimits(
  agendHome: string = getAgendHome(),
  now: number = Date.now(),
): StatuslineRateLimits | null {
  const instancesDir = join(agendHome, "instances");
  let names: string[];
  try {
    names = readdirSync(instancesDir);
  } catch {
    return null;
  }

  let best: StatuslineRateLimits | null = null;
  for (const name of names) {
    const reading = readOne(instancesDir, name, now);
    if (!reading) continue;
    // Too old to trust: the window may have reset since, and an over-report is
    // the failure that makes people stop believing the panel.
    if (now - reading.observedAtMs > STATUSLINE_MAX_AGE_MS) continue;
    if (!best || reading.observedAtMs > best.observedAtMs) best = reading;
  }
  return best;
}
