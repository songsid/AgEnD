/**
 * #3212 PR 3: signing an account out from Settings → Accounts — the CLI's own logout, run exactly as a launch would run
 * the CLI for that account (the profile's variable from credentialProfileEnv, or nothing for the default sign-in).
 *
 * Checked offline per CLI (issuecomment-6700440777, -6700591696):
 * - Claude Code `auth logout` removes `.credentials.json` (macOS: its own Keychain item, named after the config dir) and
 *   the account block of `.claude.json`, but writes `backups/.claude.json.backup.<ms>` that still names the account —
 *   so those are deleted too: every one in a named profile's folder (AgEnD's own), only the ones this logout wrote in the
 *   default sign-in's folder (older backups there are the person's own files);
 * - Codex `logout` removes `auth.json`; Kiro `logout` clears its token rows. All three are idempotent and need no network.
 *
 * AgEnD never deletes a Keychain item itself: on macOS, an item with the account's service name still there after the
 * logout (more than one matched) is reported, and nothing more is deleted.
 *
 * Refused (nothing run): a CLI with no logout; no confirmation; an invalid name; a named profile's folder that is not
 * AgEnD's own (ownProfileFolder: Remove's checks); a sign-in for it running. No output of the CLI is kept or sent.
 */
import { lstatSync, readdirSync, rmSync } from "node:fs";
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
  /** macOS: whether a Keychain item with this service name is reachable. */
  keychainHas(service: string): Promise<boolean>;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  /** Wall clock (ms), to tell the backups this logout wrote. */
  now(): number;
  fs: ProfileFs;
}

/** The backups `claude auth logout` leaves that still name the account: all of them (`all`), or those written since `since`. */
export function removeClaudeBackups(configDir: string, which: { all: true } | { since: number }): number {
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
      if (!("all" in which) && st.mtimeMs < which.since) continue;
      rmSync(path); n++;
    } catch { /* gone already */ }
  }
  return n;
}

export async function signOutAccount(dataDir: string, req: SignOutRequest, deps: Partial<SignOutDeps> & Pick<SignOutDeps, "run" | "keychainHas">): Promise<SignOutResult> {
  const d: SignOutDeps = { platform: process.platform, env: process.env, now: Date.now, fs: realFs(), ...deps };
  const how = Object.hasOwn(SIGN_OUT, req.backend) ? SIGN_OUT[req.backend]! : null;
  if (!how) return { ok: false, error: "unsupported" };
  if (req.confirm !== true) return { ok: false, error: "confirm" };
  const profile = req.profile ?? null;
  if (profile !== null && !validCredentialProfileName(profile)) return { ok: false, error: "name" };
  if (profile !== null) {
    const own = ownProfileFolder(dataDir, req.backend, profile, d.fs);
    if (!own.ok) return own;
  }
  if (req.signingIn) return { ok: false, error: "signing_in" };
  const env: NodeJS.ProcessEnv = { ...d.env, ...(profile !== null ? credentialProfileEnv(dataDir, req.backend, profile) ?? {} : {}) };
  const started = d.now() - 2_000;
  let code: number | null;
  try { ({ code } = await d.run(how.binary, how.args, env)); } catch { return { ok: false, error: "failed" }; }
  if (code !== 0) return { ok: false, error: "failed" };
  if (req.backend !== "claude-code") return { ok: true };
  const configDir = profile !== null ? credentialProfileHome(dataDir, "claude-code", profile) : claudeConfigDirFor(null);
  removeClaudeBackups(configDir, profile !== null ? { all: true } : { since: started });
  if (d.platform === "darwin") {
    const service = profile !== null ? claudeKeychainService(configDir) : CLAUDE_DEFAULT_KEYCHAIN_SERVICE;
    let left = false;
    try { left = await d.keychainHas(service); } catch { left = false; }
    if (left) return { ok: true, keychainLeft: true };
  }
  return { ok: true };
}
