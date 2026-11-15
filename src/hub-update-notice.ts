/**
 * M-3140 (docs/design/hub-fleet-versions.md §3.3, chat): when a Hub's recommended version first applies to this Fleet, one
 * message in General with Update now; while the Fleet is still behind, a reminder 7 days later and every 7 days after —
 * never daily (a daily nag is how notices get muted). A new recommendation (another Hub, revision or version) is new: told
 * at once. Kept in one small file in the data directory, so a restart neither repeats nor forgets it.
 */
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import type { HubRecommendedUpdate } from "./hub/recommendation-model.js";

export const HUB_UPDATE_NOTICE_FILE = "hub-update-notice.json";
export const HUB_UPDATE_REMIND_MS = 7 * 24 * 60 * 60 * 1000;

export interface HubNoticeState { key: string; at: number }

export function hubNoticeKey(advice: Pick<HubRecommendedUpdate, "hubId" | "revision" | "version">): string {
  return `${advice.hubId}:${advice.revision}:${advice.version}`;
}

/** Whether to post now: advice newer than what runs, and either not yet told or told at least 7 days ago. */
export function hubNoticeDue(state: HubNoticeState | null, advice: HubRecommendedUpdate | null, current: string | null, now: number,
  newer: (a: string, b: string) => boolean): boolean {
  if (!advice || !current || !newer(advice.version, current)) return false;
  if (!state || state.key !== hubNoticeKey(advice)) return true;
  return now - state.at >= HUB_UPDATE_REMIND_MS;
}

export function readHubNoticeState(path: string): HubNoticeState | null {
  try {
    const v = JSON.parse(readFileSync(path, "utf8")) as Partial<HubNoticeState>;
    return typeof v.key === "string" && typeof v.at === "number" && Number.isFinite(v.at) ? { key: v.key, at: v.at } : null;
  } catch { return null; }
}

export function writeHubNoticeState(path: string, state: HubNoticeState): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
  renameSync(tmp, path);
}
