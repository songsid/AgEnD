/**
 * #3212 PR 3: signing an account out from Settings → Accounts — the CLI's own logout, run exactly as a launch would run
 * the CLI for that account (the profile's variable from credentialProfileEnv, or nothing for the default sign-in).
 *
 * Checked offline per CLI (issuecomment-6700440777, -6700591696):
 * - Claude Code `auth logout` removes `.credentials.json` (macOS: its own Keychain item, named after the config dir) and
 *   the account block of `.claude.json`, but writes `backups/.claude.json.backup.<ms>` that still names the account —
 *   so those are deleted too: every one in a named profile's folder (AgEnD's own, re-checked to be the same folder after
 *   the logout), only the ones that were not there before it in the default sign-in's folder (the person's own files);
 * - Codex `logout` removes `auth.json`; Kiro `logout` clears its token rows. All three are idempotent and need no network.
 *
 * AgEnD never deletes a Keychain item itself: on macOS, an item with the account's service name still there after the
 * logout (more than one matched) is reported, and nothing more is deleted.
 *
 * Refused (nothing run): a CLI with no logout; no confirmation; an invalid name; a named profile's folder that is not
 * AgEnD's own (ownProfileFolder: Remove's checks); a sign-in for it running. No output of the CLI is kept or sent.
 */
import { lstatSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { credentialProfileEnv, credentialProfileHome } from "./backend/credential-profile.js";
import { claudeConfigDirFor, claudeKeychainService } from "./backend/claude-code.js";
import { validCredentialProfileName } from "./runtime-credential-profiles.js";
import { ownProfileFolder, realFs, type ProfileFs } from "./accounts-profiles.js";

/** The CLIs that can sign out from the dashboard, and how (their own logout; checked offline per CLI). */
export const SIGN_OUT: Readonly<Record<string, { binary: string; args: readonly string[] }>> = Object.freeze({
  "claude-code": { binary: "claude", args: ["auth", "logout"] },
  codex: { binary: "codex", args: ["logout"] },
  "kiro-cli": { binary: "kiro-cli", args: ["logout"] },
});
/** Claude Code's unsuffixed Keychain item: the default sign-in's (macOS). */
export const CLAUDE_DEFAULT_KEYCHAIN_SERVICE = "Claude Code-credentials";

export type SignOutRefusal = "unsupported" | "confirm" | "name" | "signing_in" | "missing" | "unsafe" | "default_home" | "failed";
export type SignOutResult = { ok: true; keychainLeft?: true } | { ok: false; error: SignOutRefusal };

export interface SignOutRequest {
  backend: string;
  /** null: the CLI's default sign-in. */
  profile: unknown;
  /** The person confirmed (the dialog named who stops). */
  confirm: unknown;
  /** A sign-in for this backend and account is running, or one for this backend is starting and its account is not known. */
  signingIn: boolean;
}

export interface SignOutDeps {
  /** Run the CLI (no shell, no input); its exit code. */
  run(binary: string, args: readonly string[], env: NodeJS.ProcessEnv): Promise<{ code: number | null }>;
  /**
   * #3305 review P2-3: whether this logout still owns the credential writer (its login-window claim is current). Asked
   * after the CLI ran, before anything is cleaned or reported: a fleet that stopped meanwhile (and perhaps started a
   * new sign-in) is not cleaned up after.
   */
  stillOwner?(): boolean;
  /** macOS: whether a Keychain item with this service name is reachable. */
  keychainHas(service: string): Promise<boolean>;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  fs: ProfileFs;
}

/**
 * The `.claude.json` backups in a config dir, as `<name>\0<inode>` (a file replaced under the same name is another one).
 * An empty set only when there is no backups folder at all; null when what is there could not be read completely
 * (#3305 review: unknown is not empty — a cleanup measured against an incomplete list could take the person's files).
 */
export function claudeBackups(configDir: string): Set<string> | null {
  const dir = join(configDir, "backups"), out = new Set<string>();
  let st;
  try { st = lstatSync(dir); } catch (err) { return (err as NodeJS.ErrnoException).code === "ENOENT" ? out : null; }
  if (!st.isDirectory() || st.isSymbolicLink()) return out;           // nothing the cleanup would touch
  let names: string[];
  try { names = readdirSync(dir); } catch { return null; }
  for (const name of names) {
    if (!name.startsWith(".claude.json.backup")) continue;
    try { out.add(`${name}\0${lstatSync(join(dir, name)).ino}`); } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") return null;   // gone meanwhile: not there; anything else: unknown
    }
  }
  return out;
}

/**
 * The backups `claude auth logout` leaves that still name the account: all of them (`all`: a named profile's folder,
 * AgEnD's own), or only those not in `except` (the default sign-in's folder: what was there before the logout is the
 * person's own — #3305 review P2-4: by identity, never by time).
 */
export function removeClaudeBackups(configDir: string, which: { all: true } | { except: ReadonlySet<string> }): number {
  const dir = join(configDir, "backups");
  let names: string[];
  try { const st = lstatSync(dir); if (!st.isDirectory() || st.isSymbolicLink()) return 0; names = readdirSync(dir); } catch { return 0; }
  let n = 0;
  for (const name of names) {
    if (!name.startsWith(".claude.json.backup")) continue;
    const path = join(dir, name);
    try {
      const st = lstatSync(path);
      if (!st.isFile()) continue;                                  // never a link or a folder
      if (!("all" in which) && which.except.has(`${name}\0${st.ino}`)) continue;
      rmSync(path); n++;
    } catch { /* gone already */ }
  }
  return n;
}

/** A directory's real path and identity, or null (missing, not a directory). */
function dirIdentity(path: string): { real: string; dev: number; ino: number } | null {
  try { const real = realpathSync(path), st = lstatSync(real); return st.isDirectory() ? { real, dev: st.dev, ino: st.ino } : null; } catch { return null; }
}

export async function signOutAccount(dataDir: string, req: SignOutRequest, deps: Partial<SignOutDeps> & Pick<SignOutDeps, "run" | "keychainHas">): Promise<SignOutResult> {
  const d: SignOutDeps = { platform: process.platform, env: process.env, fs: realFs(), ...deps };
  const how = Object.hasOwn(SIGN_OUT, req.backend) ? SIGN_OUT[req.backend]! : null;
  if (!how) return { ok: false, error: "unsupported" };
  if (req.confirm !== true) return { ok: false, error: "confirm" };
  const profile = req.profile ?? null;
  if (profile !== null && !validCredentialProfileName(profile)) return { ok: false, error: "name" };
  let identity: { dev: number; ino: number } | null = null;
  if (profile !== null) {
    const own = ownProfileFolder(dataDir, req.backend, profile, d.fs);
    if (!own.ok) return own;
    identity = { dev: own.st.dev, ino: own.st.ino };
  }
  if (req.signingIn) return { ok: false, error: "signing_in" };
  const env: NodeJS.ProcessEnv = { ...d.env, ...(profile !== null ? credentialProfileEnv(dataDir, req.backend, profile) ?? {} : {}) };
  const configDir = profile !== null ? credentialProfileHome(dataDir, "claude-code", profile) : claudeConfigDirFor(null);
  // #3305 review P1 (default folder): the folder is the one seen before the logout — its real path and identity — and
  // its backups then are the person's own. Cleanup happens in that directory only, never in one put at its path meanwhile.
  const seen = req.backend === "claude-code" && profile === null ? dirIdentity(configDir) : null;
  const before = seen ? claudeBackups(seen.real) : null;
  let code: number | null;
  try { ({ code } = await d.run(how.binary, how.args, env)); } catch { return { ok: false, error: "failed" }; }
  if (code !== 0) return { ok: false, error: "failed" };
  if (d.stillOwner && !d.stillOwner()) return { ok: false, error: "failed" };
  // #3305 review P1: the folder checked before the wait must be the one cleaned after it — the same directory (device
  // and inode), still AgEnD's own with no link on the way. A folder swapped meanwhile is refused and left alone.
  if (profile !== null) {
    const again = ownProfileFolder(dataDir, req.backend, profile, d.fs);
    if (!again.ok || again.st.dev !== identity!.dev || again.st.ino !== identity!.ino) return { ok: false, error: "unsafe" };
  }
  if (req.backend !== "claude-code") return { ok: true };
  if (profile !== null) removeClaudeBackups(configDir, { all: true });
  else {
    // No folder before the logout, or its backups could not be listed completely: nothing is bound to clean — nothing is
    // deleted (the backup this logout wrote stays; the person's own are never at risk).
    if (seen && before) {
      const now = dirIdentity(configDir);
      if (!now || now.real !== seen.real || now.dev !== seen.dev || now.ino !== seen.ino) return { ok: false, error: "unsafe" };
      removeClaudeBackups(seen.real, { except: before });
    }
  }
  if (d.platform === "darwin") {
    const service = profile !== null ? claudeKeychainService(configDir) : CLAUDE_DEFAULT_KEYCHAIN_SERVICE;
    let left = false;
    try { left = await d.keychainHas(service); } catch { left = false; }
    if (left) return { ok: true, keychainLeft: true };
  }
  return { ok: true };
}
