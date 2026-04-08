import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";

/** Resolve the AgEnD data directory. Override with AGEND_HOME env var. */
export function getAgendHome(): string {
  return process.env.AGEND_HOME || join(homedir(), ".agend");
}

/** Tmux session name — unique per AGEND_HOME to avoid cross-instance interference. */
export function getTmuxSessionName(): string {
  const home = getAgendHome();
  const defaultHome = join(homedir(), ".agend");
  if (home === defaultHome) return "agend";
  return "agend-" + createHash("md5").update(home).digest("hex").slice(0, 6);
}
