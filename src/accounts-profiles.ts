/**
 * #3212 PR 2: adding and removing a named account (a credential profile) on this host, from Settings → Accounts.
 *
 * Add creates `<AGEND_HOME>/credential-profiles/<backend>/<name>` (private to this account) and nothing else: signing it
 * in prepares it as a launch does (login-controller.ts, prepareCredentialProfileHome).
 *
 * Remove deletes that folder — its sign-in and, for Claude Code, its own copies of conversations — and is refused,
 * with nothing deleted, unless every one of these holds (the safeguards agreed on #3212, issuecomment-6684192752):
 * - no host agent, ClassicBot room or fleet default uses it (the caller passes who does; the refusal names them);
 * - the request names the profile again (the typed confirmation);
 * - it is one of the three profile backends and a valid, Windows-safe name;
 * - no sign-in for it is running (the caller asks the login controller);
 * - the folder is AgEnD's own: `<root>/<backend>/<name>` with no link at any level, each level a real directory owned
 *   by the account running AgEnD, and its real path exactly that place under the real root;
 * - it is not, does not contain and is not inside the CLI's default sign-in home.
 * The folder is renamed to a hidden sibling first, checked again to be the same folder, and only then deleted; the
 * delete never follows a link inside it (a relocated home links shared parts back to the default home).
 *
 * No path, file name or folder content leaves this module in an answer: refusals are codes, with names only.
 */
import { lstatSync, mkdirSync, readdirSync, realpathSync, renameSync, rmSync, type Stats } from "node:fs";
import { randomBytes } from "node:crypto";
import { join, relative, isAbsolute, sep } from "node:path";
import { credentialHomeSpec } from "./backend/credential-profile.js";
import { validCredentialProfileName } from "./runtime-credential-profiles.js";
import { PROFILE_CLIS } from "./accounts-view.js";

export const PROFILES_DIRECTORY = "credential-profiles";

/** Who still uses a profile: host agents, ClassicBot rooms (by key) and whether the fleet default names it. */
export interface ProfileUsers { agents: string[]; classic: string[]; fleetDefault: boolean }

export type AddRefusal = "backend" | "name" | "exists" | "case_clash" | "unsafe_root";
export type RemoveRefusal = "backend" | "name" | "confirm" | "in_use" | "users_unknown" | "signing_in" | "missing" | "unsafe" | "default_home" | "failed";

export type AddResult = { ok: true } | { ok: false; error: AddRefusal; clash?: string };
export type RemoveResult = { ok: true; keychainLeft?: true; identity?: { dev: number; ino: number } } | { ok: false; error: RemoveRefusal; users?: ProfileUsers };

export interface ProfileFs {
  /** The account running AgEnD; null where the platform has none (then ownership is not checked). */
  uid: number | null;
  /** The CLI's default sign-in home (credential-profile.ts sharedRoot), for the never-the-default-home check. */
  defaultHome(backend: string): string | null;
}

export const realFs = (): ProfileFs => ({
  uid: typeof process.getuid === "function" ? process.getuid() : null,
  defaultHome: backend => { try { return credentialHomeSpec(backend)?.sharedRoot() ?? null; } catch { return null; } },
});

const lst = (path: string): Stats | null => { try { return lstatSync(path); } catch { return null; } };
/** A real directory (never a link) owned by `uid` (when there is one). */
const ownDir = (st: Stats | null, uid: number | null): boolean => !!st && st.isDirectory() && !st.isSymbolicLink() && (uid === null || st.uid === uid);
/** `inner` is `outer` or below it. */
const within = (outer: string, inner: string): boolean => { const r = relative(outer, inner); return r === "" || (!r.startsWith("..") && !isAbsolute(r)); };
const realOrNull = (path: string): string | null => { try { return realpathSync(path); } catch { return null; } };

/** Every name that is (or would be) the same folder as `name` on a case-insensitive disk (Windows, default macOS). */
function caseClash(name: string, names: Iterable<string>): string | undefined {
  for (const other of names) if (other !== name && other.toLowerCase() === name.toLowerCase()) return other;
  return undefined;
}

/**
 * Create a profile's folder. `configured`: the profile names the configuration already refers to for this backend (an
 * agent, a room or the fleet default may name one whose folder does not exist yet).
 */
export function addAccountProfile(dataDir: string, backend: string, name: unknown, configured: Iterable<string> = [], fs: ProfileFs = realFs()): AddResult {
  if (!PROFILE_CLIS.has(backend)) return { ok: false, error: "backend" };
  if (!validCredentialProfileName(name)) return { ok: false, error: "name" };
  const root = join(dataDir, PROFILES_DIRECTORY), base = join(root, backend), home = join(base, name);
  // The two levels above are made here when missing, private; one that is a link (or not ours) is refused.
  for (const level of [root, base]) {
    if (!lst(level)) { try { mkdirSync(level, { mode: 0o700 }); } catch { /* checked below */ } }
    if (!ownDir(lst(level), fs.uid)) return { ok: false, error: "unsafe_root" };
  }
  const folders = (() => { try { return readdirSync(base); } catch { return []; } })();
  if (folders.includes(name)) return { ok: false, error: "exists" };
  const clash = caseClash(name, [...folders.filter(f => validCredentialProfileName(f)), ...configured]);
  if (clash) return { ok: false, error: "case_clash", clash };
  try { mkdirSync(home, { mode: 0o700 }); } catch (err) {
    return { ok: false, error: (err as NodeJS.ErrnoException).code === "EEXIST" ? "exists" : "unsafe_root" };
  }
  if (!ownDir(lst(home), fs.uid)) return { ok: false, error: "unsafe_root" };
  return { ok: true };
}

export interface RemoveRequest {
  backend: string;
  name: unknown;
  /** What the person typed: must be the name itself. */
  confirm: unknown;
  /** Who uses it now (the configuration's view; host agents only). */
  users: ProfileUsers;
  /** A sign-in for this backend and profile is running (or one for this backend is starting and its profile is not known). */
  signingIn: boolean;
  /** Who uses it could not be read completely (ClassicBot's settings unreadable or malformed): nothing proves it unused. */
  usersUnknown?: boolean;
}

/**
 * The folder of an existing profile, when it is AgEnD's own (Remove's and Sign out's check): `<root>/<backend>/<name>`,
 * each level a real directory (never a link) owned by this account, its real path exactly that place under the real
 * root, and neither the CLI's default sign-in home nor inside or around it. `name` must already be valid.
 */
export function ownProfileFolder(dataDir: string, backend: string, name: string, fs: ProfileFs = realFs()):
  { ok: true; base: string; home: string; st: Stats; realRoot: string } | { ok: false; error: "missing" | "unsafe" | "default_home" } {
  const root = join(dataDir, PROFILES_DIRECTORY), base = join(root, backend), home = join(base, name);
  const st = lst(home);
  if (!st) return { ok: false, error: "missing" };
  // Each level: a real directory, never a link, owned by this account.
  if (!ownDir(lst(root), fs.uid) || !ownDir(lst(base), fs.uid) || !ownDir(st, fs.uid)) return { ok: false, error: "unsafe" };
  const realRoot = realOrNull(root), real = realOrNull(home);
  if (!realRoot || !real || real !== join(realRoot, backend, name)) return { ok: false, error: "unsafe" };
  const dflt = fs.defaultHome(backend);
  if (dflt) {
    const realDefault = realOrNull(dflt) ?? dflt;
    if (within(realDefault, real) || within(real, realDefault)) return { ok: false, error: "default_home" };
  }
  return { ok: true, base, home, st, realRoot };
}

/** Remove a profile's folder, or refuse (nothing deleted). See the module comment for every rule. */
export function removeAccountProfile(dataDir: string, req: RemoveRequest, fs: ProfileFs = realFs(), opts: { dryRun?: boolean; expect?: { dev: number; ino: number } } = {}): RemoveResult {
  const { backend, name } = req;
  if (!PROFILE_CLIS.has(backend)) return { ok: false, error: "backend" };
  if (!validCredentialProfileName(name)) return { ok: false, error: "name" };
  if (req.confirm !== name) return { ok: false, error: "confirm" };
  const u = req.users;
  if (u.agents.length || u.classic.length || u.fleetDefault) return { ok: false, error: "in_use", users: u };
  if (req.usersUnknown) return { ok: false, error: "users_unknown" };
  if (req.signingIn) return { ok: false, error: "signing_in" };
  const own = ownProfileFolder(dataDir, backend, name, fs);
  if (!own.ok) return own;
  const { base, home, st, realRoot } = own;
  // #3305 review P2-2: after a wait, the folder must be the one the dry run proved (the same directory).
  if (opts.expect && (st.dev !== opts.expect.dev || st.ino !== opts.expect.ino)) return { ok: false, error: "unsafe" };
  // #3212 PR 3: every check above, nothing changed — the caller runs what must come first (macOS: Claude Code's own
  // logout), then calls again with `expect` (this folder's identity) for the real removal.
  if (opts.dryRun) return { ok: true, identity: { dev: st.dev, ino: st.ino } };
  // Out of sight first (a hidden name the listing never shows), then the same folder again, then deleted.
  const parked = join(base, `.removing-${name}-${randomBytes(6).toString("hex")}`);
  try { renameSync(home, parked); } catch { return { ok: false, error: "failed" }; }
  const moved = lst(parked);
  if (!moved || !ownDir(moved, fs.uid) || moved.ino !== st.ino || moved.dev !== st.dev || realOrNull(parked) !== join(realRoot, backend, parked.slice(base.length + sep.length))) {
    try { renameSync(parked, home); } catch { /* left hidden; never deleted */ }
    return { ok: false, error: "unsafe" };
  }
  // rmSync never follows a link: a link inside (a relocated home's shared parts) is removed, its target left alone.
  try { rmSync(parked, { recursive: true, force: false }); } catch { return { ok: false, error: "failed" }; }
  return { ok: true };
}
