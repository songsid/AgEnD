/**
 * M-2738 (#3332): updating AgEnD from the web — what the page is told and the rules it follows. The update itself is
 * the one chat `/update` runs (FleetManager.launchInstalledUpdate: the installed `agend`, verified, launched
 * independently, on its own channel); nothing here installs anything.
 *
 * - Offer: the same rules as the "update available" notice (FleetManager.checkForUpdates): the target is what the
 *   install's own channel offers. A beta install is never offered a stable (#2775). An alpha install told about a newer
 *   STABLE gets it shown with no button: a plain `agend update` stays on @alpha, and switching lines is not offered on
 *   the web (the leader's D2).
 * - Progress: update-in-progress.json, the marker the updater already writes its stages into. A web-started update's
 *   target is WEB_UPDATE_TARGET (no chat message: the chat progress monitor and the new fleet's completion leave it alone).
 * - Failure: the page says a user-level cause; the updater's own words (which may name host paths) only in the log view.
 */
import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { installedChannel, updateNoticeKey, type UpdateChannel } from "./update-check.js";
import type { UpdateMarker, UpdateProgressStage, UpdateProgressState, UpdateProgressTarget } from "./update-marker.js";

/**
 * The version this process runs, read once as it loads (at fleet start): never the package.json on disk later, which an
 * update replaces under the running fleet (missing for a moment, then the new version before the restart). Null: unknown.
 */
export const RUNNING_AGEND_VERSION: string | null = (() => {
  try {
    const v = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: unknown }).version;
    return typeof v === "string" && v ? v : null;
  } catch { return null; }
})();

/** The adapter id of a web-started update's progress target: no channel adapter has it, so no chat message is edited. */
export const WEB_UPDATE_ADAPTER = "web-update";
export function webUpdateTarget(startedAt: number): UpdateProgressTarget {
  // S-92: a web surface (no chat message): every reader of the marker that knows `surface: "web"` leaves its chat alone.
  return { surface: "web", adapterId: WEB_UPDATE_ADAPTER, chatId: "web", messageId: `web-update:${startedAt}` };
}
/** Known by its web surface (#3373 review P3: never by the id alone, which a chat connection could also be called). */
export function isWebUpdateTarget(target: UpdateProgressTarget | undefined | null): boolean {
  return target?.surface === "web" && target.adapterId === WEB_UPDATE_ADAPTER;
}

export interface UpdateOffer {
  version: string;
  /** The channel the offered version is on. */
  channel: UpdateChannel;
  /** A plain `agend update` installs it: the page offers Update. False: shown, no button (an alpha's newer stable). */
  installable: boolean;
}

/**
 * The offer for `target`, as checkForUpdates picked it (`fromChannel`: it came from the install's own dist-tag), or null
 * when nothing newer should be shown. `newer` is the caller's own "target > current" (the notice's comparison).
 */
export function updateOffer(current: string, target: string | null | undefined, fromChannel: boolean, newer: boolean): UpdateOffer | null {
  if (!target || !newer) return null;
  const key = fromChannel ? "update.available_current" : updateNoticeKey(current, target);
  if (!key) return null;
  return { version: target, channel: fromChannel ? installedChannel(current) : installedChannel(target), installable: key === "update.available_current" };
}

/** What the page says a failure was, never the updater's own words. */
export type WebUpdateCause = "network" | "permission" | "other";
export function failureCause(error: string | undefined): WebUpdateCause {
  const e = error ?? "";
  // M-2797: npm's own agent names its timeouts too (a silent connection, one that never connects or answers).
  if (/\bE(NOTFOUND|AI_AGAIN|TIMEDOUT|CONNREFUSED|CONNRESET|NETUNREACH|HOSTUNREACH|IDLETIMEOUT|CONNECTIONTIMEOUT|RESPONSETIMEOUT|TRANSFERTIMEOUT)\b|getaddrinfo|socket hang up|network|fetch failed|registry|timeout reached/i.test(e)) return "network";
  if (/\bE(ACCES|PERM)\b|permission denied|operation not permitted/i.test(e)) return "permission";
  return "other";
}

export interface WebUpdateProgress {
  stage: UpdateProgressStage;
  failed_stage?: UpdateProgressStage;
  cause?: WebUpdateCause;
  started_at: number;
  version?: string;
  /** Started from the web (else from chat `/update`). */
  web: boolean;
}

/** How long a finished (failed / complete) marker is still shown. */
export const SETTLED_SHOWN_MS = 24 * 60 * 60_000;

/** The page's view of an update marker: an update's (never a `/restart full`'s), and a settled one only for a day. */
export function webProgressOf(marker: (UpdateMarker & { progress: UpdateProgressState }) | null, now = Date.now()): WebUpdateProgress | null {
  if (!marker || marker.progress.operation === "full-restart") return null;
  const p = marker.progress;
  const settled = p.stage === "failed" || p.stage === "complete";
  if (settled && !(now - marker.startedAt >= 0 && now - marker.startedAt < SETTLED_SHOWN_MS)) return null;
  return {
    stage: p.stage,
    ...(p.failedStage ? { failed_stage: p.failedStage } : {}),
    ...(p.stage === "failed" ? { cause: failureCause(p.error) } : {}),
    started_at: marker.startedAt,
    ...(p.version ? { version: p.version } : {}),
    web: isWebUpdateTarget(p.target),
  };
}

/** The end of the update log, at most `max` bytes (the log view). Null when there is none. */
export function readLogTail(path: string, max = 32 * 1024): string | null {
  let fd: number;
  try { fd = openSync(path, "r"); } catch { return null; }
  try {
    const size = statSync(path).size;
    const start = Math.max(0, size - max);
    const buf = Buffer.alloc(size - start);
    const n = readSync(fd, buf, 0, buf.length, start);
    let text = buf.subarray(0, n).toString("utf8");
    if (start > 0) text = text.slice(text.indexOf("\n") + 1);
    return text;
  } catch { return null; } finally { closeSync(fd); }
}

/** What the fleet gives the web routes. */
export interface WebUpdateHost {
  /** The running version, the last check's offer, and when it was checked (null: not yet). */
  updateState(): { current: string | null; offer: UpdateOffer | null; checkedAt: number | null; checkFailed: boolean };
  /** Look now (no chat notice); rate-limited by the caller's host. */
  checkUpdateNow(): Promise<{ ok: true } | { ok: false; status: number; error: string }>;
  updateProgress(): WebUpdateProgress | null;
  /**
   * Start the update for `person` (a fleet admin's web session); the same answer again for the same `key`. `stillAllowed`
   * asks whether that session is still current and an admin's: checked again right before the updater is launched.
   */
  startWebUpdate(key: string, person: string, stillAllowed: () => boolean): Promise<{ ok: true } | { ok: false; status: number; error: string }>;
  updateLog(): { text: string | null; error: string | null };
}
