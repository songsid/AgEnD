import { join } from "node:path";
import { homedir, userInfo } from "node:os";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";

/** Resolve the AgEnD data directory. Override with AGEND_HOME env var. */
export function getAgendHome(): string {
  return process.env.AGEND_HOME || join(homedir(), ".agend");
}

/**
 * The user's real AgEnD home: `.agend` in the home directory from the
 * password database, NOT `$HOME`. A test or throwaway fleet that changes HOME
 * (and AGEND_HOME with it) must not be mistaken for the user's own fleet.
 * Null when the password database cannot be read: falling back to homedir()
 * would trust `$HOME` again (#1128 review), so then no home is the default.
 */
function realDefaultAgendHome(): string | null {
  try { return join(userInfo().homedir, ".agend"); } catch { return null; }
}

/**
 * Whether this process's AgEnD home is the user's real default one — the only
 * home that uses tmux's default socket and the plain "agend" session (#1126).
 *
 * Before, "default" meant `AGEND_HOME === $HOME/.agend`. A throwaway fleet run
 * with HOME and AGEND_HOME both pointed at a scratch directory matched that,
 * attached to the LIVE fleet's default tmux server, and its startup cleanup
 * killed 16 live windows as "orphaned" (2026-10-03). Comparing against the
 * real home closes that, and changes nothing for anyone whose AGEND_HOME is
 * unset or set to their real ~/.agend: their socket and session names stay.
 */
export function isDefaultAgendHome(home: string = getAgendHome()): boolean {
  // Exact string comparison, as before: only WHICH home it is compared with
  // changed, so no existing AGEND_HOME value moves to another socket. An
  // unknown real home is never matched: the fleet gets an isolated socket.
  const real = realDefaultAgendHome();
  return real !== null && home === real;
}

function isolatedSuffix(home: string): string {
  // sha256 instead of md5: this hash is not security-critical (we just need a
  // short stable suffix so two custom AGEND_HOME values don't collide on the
  // tmux session/socket namespace), but md5 trips FIPS-mode Node and security
  // scanners.
  return "agend-" + createHash("sha256").update(home).digest("hex").slice(0, 6);
}

/** Tmux session name — unique per AGEND_HOME to avoid cross-instance interference. */
export function getTmuxSessionName(): string {
  const home = getAgendHome();
  return isDefaultAgendHome(home) ? "agend" : isolatedSuffix(home);
}

/**
 * Tmux socket name for -L flag. Null only for the user's real default home
 * (tmux's default socket, as always); any other AgEnD home gets a socket of
 * its own, so it can never reach — and clean up — another fleet's server.
 */
export function getTmuxSocketName(): string | null {
  const home = getAgendHome();
  return isDefaultAgendHome(home) ? null : isolatedSuffix(home);
}

/** Ensure an auto-created workspace has a .git directory (best effort). */
export function ensureWorkspaceGit(dir: string): void {
  if (!existsSync(join(dir, ".git"))) {
    // Treat user-supplied paths as one argument, never shell syntax. The option
    // terminator also keeps relative names such as "--bare" from becoming flags.
    try { execFileSync("git", ["init", "--", dir], { stdio: "ignore" }); } catch { /* best effort */ }
  }
}
