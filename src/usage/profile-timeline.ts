/**
 * #3066 §1d: which credential profile a Codex instance ran under, and since when — so its usage is told by account. A
 * Codex rollout does not say which login wrote it (so its hours were all "unrecorded"); AgEnD does know which profile it
 * launched each Codex under. Each launch appends `{ t, profile }` to the instance's `codex-profile-timeline.json`; the
 * usage scan tags each turn with the profile in effect at its time (the latest entry at or before it). A switch of
 * profile is a relaunch, so a turn is never between two entries of one run. Turns from before the first entry stay
 * "unrecorded" — history is never guessed.
 *
 * Small (≤ 200 entries, the oldest dropped) and written off the fleet's thread, atomically.
 */
import { readFile, rename, writeFile } from "node:fs/promises";

export interface ProfileSpan { t: number; profile: string }
export const PROFILE_TIMELINE_FILE = "codex-profile-timeline.json";
export const PROFILE_TIMELINE_MAX = 200;
export const PROFILE_UNRECORDED = "unrecorded";

/** The file's entries, checked and sorted (an unreadable or missing file: none). */
export async function readProfileTimeline(path: string): Promise<ProfileSpan[]> {
  let v: unknown;
  try { v = JSON.parse(await readFile(path, "utf8")); } catch { return []; }
  const list = v && typeof v === "object" && !Array.isArray(v) && Array.isArray((v as { spans?: unknown }).spans) ? (v as { spans: unknown[] }).spans : [];
  return list.filter((e): e is ProfileSpan => !!e && typeof e === "object" && typeof (e as ProfileSpan).t === "number"
    && Number.isFinite((e as ProfileSpan).t) && typeof (e as ProfileSpan).profile === "string" && (e as ProfileSpan).profile !== "")
    .map((e) => ({ t: e.t, profile: e.profile })).sort((a, b) => a.t - b.t);
}

const writes = new Map<string, Promise<void>>();
/**
 * A launch under `profile` at `t`. One write at a time per file; nothing is added when the last entry already names the
 * same profile. Never throws: a lost entry leaves that run's turns under the previous entry's profile (or unrecorded).
 */
export function recordProfileLaunch(path: string, profile: string, t = Date.now()): Promise<void> {
  const next = (writes.get(path) ?? Promise.resolve()).then(async () => {
    const spans = await readProfileTimeline(path);
    if (spans.at(-1)?.profile === profile) return;
    const kept = [...spans, { t, profile }].slice(-PROFILE_TIMELINE_MAX);
    const tmp = `${path}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify({ v: 1, spans: kept }), { mode: 0o600 });
    await rename(tmp, path);
  }).catch(() => { /* this launch is not recorded */ });
  writes.set(path, next);
  return next;
}

/** The profile in effect at `t`: the latest entry at or before it, else "unrecorded". */
export function profileAt(spans: readonly ProfileSpan[], t: number): string {
  let found = PROFILE_UNRECORDED;
  for (const s of spans) { if (s.t <= t) found = s.profile; else break; }
  return found;
}
