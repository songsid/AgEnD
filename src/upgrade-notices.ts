/**
 * One-time notices for people who upgrade into a release that changed how AgEnD is used (#1366).
 *
 * The first is web chat (2.2): a fleet that has run 2.1 for months gives no sign that its agents can now be talked
 * to from a browser. The first time a fleet runs 2.2 or later, each chat platform's General is told once.
 *
 * What was announced where is recorded in `<AGEND_HOME>/upgrade-notices.json`: `{ "<notice>": ["<adapter id>", …] }`.
 * A notice is claimed in that file before it is sent, and the claim is released if the send fails, so the next start
 * tries again. When the file cannot be read or written, nothing is sent: a missed notice is better than one that
 * repeats on every restart.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "./backend/kiro-engine-ledger.js";

export const WEB_CHAT_NOTICE = "web-chat-2.2";
/** Where the web chat notice points a phone user, until the public link (#1367) gives them a menu option. */
export const WEB_REMOTE_DOCS_URL = "https://github.com/songsid/AgEnD/blob/main/docs/web-dashboard.md#reaching-it-from-elsewhere";

type NoticeState = Record<string, string[]>;

export function upgradeNoticesPath(dataDir: string): string {
  return join(dataDir, "upgrade-notices.json");
}

/**
 * Whether this version has web chat: 2.2 or later, prereleases included. The 2.2 betas (2.2.0-beta.N) are where
 * upgrading users first meet it, although SemVer orders them before 2.2.0. A version that does not parse (a dev
 * checkout says 1.22.0, an unknown one says "unknown") is not.
 */
export function hasWebChat(version: string): boolean {
  const m = /^(\d+)\.(\d+)\.\d+(?:[-+].*)?$/.exec(version.trim());
  if (!m) return false;
  const major = Number(m[1]), minor = Number(m[2]);
  return major > 2 || (major === 2 && minor >= 2);
}

/** The state, `{}` when there is no file yet, or null when it exists but cannot be read or understood. */
function readState(path: string): NoticeState | null {
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? {} : null;
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const state: NoticeState = {};
    for (const [notice, adapters] of Object.entries(parsed)) {
      if (!Array.isArray(adapters) || !adapters.every(a => typeof a === "string")) return null;
      state[notice] = adapters;
    }
    return state;
  } catch { return null; }
}

/**
 * Record that `notice` is being sent to `adapterId`. True only when this call recorded it: false when it was
 * recorded before, or when the file cannot be read or written (then the caller sends nothing).
 */
export function claimNotice(path: string, notice: string, adapterId: string): boolean {
  const state = readState(path);
  if (!state || state[notice]?.includes(adapterId)) return false;
  state[notice] = [...(state[notice] ?? []), adapterId];
  try { writeFileAtomic(path, JSON.stringify(state, null, 2) + "\n"); } catch { return false; }
  return true;
}

/** Undo a claim whose send failed, so the next start tries again. Best effort: false when it could not be undone. */
export function releaseNotice(path: string, notice: string, adapterId: string): boolean {
  const state = readState(path);
  if (!state) return false;
  const left = (state[notice] ?? []).filter(a => a !== adapterId);
  if (left.length > 0) state[notice] = left; else delete state[notice];
  try { writeFileAtomic(path, JSON.stringify(state, null, 2) + "\n"); } catch { return false; }
  return true;
}
