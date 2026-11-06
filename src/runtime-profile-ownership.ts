/**
 * #3190 Part 3a, upstream conditions Q4 and Q7: a fleet admin may sign out or remove only a profile THIS Runtime created, and the proof is
 * evidence, not where the folder happens to sit.
 *
 *  - Evidence of creation: when the Runtime itself creates a profile folder it records the name in `<profile root>\created.json`. A folder
 *    the Runtime has no record of (made by hand, or by an older Runtime) is never touched remotely, whatever its name or place.
 *  - Place: under this pairing's fixed root, a valid name, a real directory, and NO LINK AT ANY LEVEL: the pairing folder, the profile root,
 *    the CLI folder, the profile folder and everything inside it. On Windows a junction or any other reparse point counts as a link.
 *  - Never the Windows user's own sign-in: even a request that somehow names it (it is not under the root, so it cannot) is refused here.
 *
 * Built-ins only: part of the Runtime bundle.
 */
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { atomicWriteFileSync } from "./atomic-write.js";
import { assertCredentialProfileCli, assertCredentialProfileName, credentialProfileDirectory, ensureCredentialProfile, forgetCredentialStatus, isCredentialProfileCli, type CredentialProfileCli } from "./runtime-credential-profiles.js";

export const CREATED_PROFILES_FILE = "created.json";
const MAX_LEDGER_BYTES = 64 * 1024;
const MAX_WALK_ENTRIES = 20_000;
const BACKUP = /^\.claude\.json\.backup(?:[.\-_][A-Za-z0-9._-]{0,64})?$/;

/** A refusal whose text is ours: it names a profile and what to do, never a path, an account or a secret. */
export class ProfileOwnershipRefusal extends Error {
  constructor(message: string, readonly reason: "unsupported" | "not_owned" | "not_found" | "link" | "invalid_request" | "in_use" | "default_profile") { super(message); this.name = "ProfileOwnershipRefusal"; }
}
const dictionary = <T>(): Record<string, T> => Object.create(null) as Record<string, T>;

/** What this Runtime created: names, by CLI. A null-prototype map, so `constructor` and `toString` are names, not properties. */
function readLedger(root: string): Record<string, Record<string, number>> {
  const result = dictionary<Record<string, number>>();
  try {
    const path = join(root, CREATED_PROFILES_FILE), stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_LEDGER_BYTES) return result;
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    const created = value && typeof value === "object" && (value as { version?: unknown }).version === 1 ? (value as { created?: unknown }).created : undefined;
    if (!created || typeof created !== "object" || Array.isArray(created)) return result;
    for (const cli of Object.keys(created)) {
      const rows = (created as Record<string, unknown>)[cli]; if (!isCredentialProfileCli(cli) || !rows || typeof rows !== "object" || Array.isArray(rows)) continue;
      const copy = result[cli] = dictionary<number>();
      for (const name of Object.keys(rows)) { const at = (rows as Record<string, unknown>)[name]; try { assertCredentialProfileName(name); } catch { continue; } if (typeof at === "number" && Number.isFinite(at)) copy[name] = at; }
    }
  } catch { /* unreadable: nothing is recorded, so nothing is removable remotely */ }
  return result;
}
function writeLedger(root: string, ledger: Record<string, Record<string, number>>): void {
  const plain: Record<string, Record<string, number>> = {};
  for (const cli of Object.keys(ledger)) plain[cli] = Object.fromEntries(Object.entries(ledger[cli]));
  mkdirSync(root, { recursive: true, mode: 0o700 });
  atomicWriteFileSync(join(root, CREATED_PROFILES_FILE), JSON.stringify({ version: 1, created: plain }), { mode: 0o600 });
}
export function isCreatedProfile(root: string, cli: CredentialProfileCli, name: string): boolean {
  const rows = readLedger(root)[cli]; return !!rows && Object.hasOwn(rows, name);
}
export function recordCreatedProfile(root: string, cli: CredentialProfileCli, name: string, now = Date.now()): void {
  assertCredentialProfileName(name);
  const ledger = readLedger(root); (ledger[cli] ??= dictionary<number>())[name] = now; writeLedger(root, ledger);
}
export function forgetCreatedProfile(root: string, cli: CredentialProfileCli, name: string): void {
  const ledger = readLedger(root); if (!ledger[cli] || !Object.hasOwn(ledger[cli], name)) return;
  delete ledger[cli][name]; writeLedger(root, ledger);
}
/**
 * Creates a profile folder AND records that this Runtime made it. A folder that was already there is not claimed: it stays local-only.
 * (`created` tells the caller which case it was, for the audit record.)
 */
export function createRuntimeProfile(root: string, cli: unknown, name: unknown): { directory: string; created: boolean } {
  const kind = assertCredentialProfileCli(cli), checked = assertCredentialProfileName(name);
  const existed = existsSync(credentialProfileDirectory(root, kind, checked));
  const directory = ensureCredentialProfile(root, kind, checked);
  if (!existed) recordCreatedProfile(root, kind, checked);
  return { directory, created: !existed };
}

/** Which of these paths are links or other reparse points. Windows only has more than the lstat answer, so only Windows is asked. */
export type ReparseInspector = (paths: readonly string[]) => readonly boolean[];
/**
 * Windows: `[IO.File]::GetAttributes` has the ReparsePoint bit (0x400) set for a junction, a symbolic link, a OneDrive placeholder or any other
 * reparse point, which Node's lstat does not always report. The paths go through the child's environment (`|` cannot be in a Windows path), never
 * into a command line. Fail closed: if the answer cannot be read, the caller is told it could not be proven.
 */
export const windowsReparseInspector: ReparseInspector = paths => {
  const system = process.env.SystemRoot || "C:\\Windows";
  const out = execFileSync(join(system, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-Command", "$ErrorActionPreference='Stop'; foreach ($p in $env:AGEND_CHECK_PATHS.Split('|')) { if (([int][System.IO.File]::GetAttributes($p) -band 0x400) -ne 0) { '1' } else { '0' } }"],
    { env: { SystemRoot: system, AGEND_CHECK_PATHS: paths.join("|") }, encoding: "utf8", timeout: 20_000, windowsHide: true });
  const rows = out.split(/\r?\n/).filter(Boolean);
  if (rows.length !== paths.length || rows.some(row => row !== "0" && row !== "1")) throw new Error("Reparse point check was unreadable");
  return rows.map(row => row === "1");
};
const noReparseInspector: ReparseInspector = paths => paths.map(() => false);
const same = (a: string, b: string): boolean => process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
function notLink(path: string, what: string): void {
  let stat; try { stat = lstatSync(path); } catch { throw new ProfileOwnershipRefusal(`${what} does not exist`, "not_found"); }
  if (stat.isSymbolicLink()) throw new ProfileOwnershipRefusal(`${what} is a link, so nothing is changed there`, "link");
  if (!stat.isDirectory()) throw new ProfileOwnershipRefusal(`${what} is not a real folder`, "link");
}
/** Everything inside, never followed: a link anywhere in the tree refuses the whole operation (a delete must not leave the folder). */
function assertNoLinksInside(directory: string): void {
  const pending = [directory]; let seen = 0;
  while (pending.length) {
    const next = pending.pop()!;
    for (const entry of readdirSync(next, { withFileTypes: true })) {
      if (++seen > MAX_WALK_ENTRIES) throw new ProfileOwnershipRefusal("This profile folder holds too many files to check for links, so nothing is changed", "link");
      const path = join(next, entry.name), stat = lstatSync(path);
      if (stat.isSymbolicLink() || entry.isSymbolicLink()) throw new ProfileOwnershipRefusal("This profile folder holds a link, so nothing is changed there", "link");
      if (stat.isDirectory()) pending.push(path);
    }
  }
}
export interface OwnedProfileOptions { inspect?: ReparseInspector; /** The Windows user's own sign-in homes, which are never a profile. */ protectedHomes?: readonly string[] }
/**
 * The folder of a profile that this Runtime created and that is where it should be, with no link at any level. Throws a
 * ProfileOwnershipRefusal otherwise; nothing is read from or written to the profile.
 */
export function requireOwnedProfile(pairingDirectory: string, root: string, cli: unknown, name: unknown, options: OwnedProfileOptions = {}): string {
  if (!isCredentialProfileCli(cli)) throw new ProfileOwnershipRefusal("Credential profiles on a Windows Runtime support Claude Code only. Codex may keep its sign-in in the Windows Credential Manager, which a profile folder cannot hold or remove, so it is not offered yet", "unsupported");
  let checked: string; try { checked = assertCredentialProfileName(name); } catch { throw new ProfileOwnershipRefusal("That is not a valid credential profile name", "invalid_request"); }
  const directory = credentialProfileDirectory(root, cli, checked);
  if (!isCreatedProfile(root, cli, checked)) {
    throw new ProfileOwnershipRefusal(existsSync(directory) ? `Credential profile "${checked}" was not created by this Runtime, so it can only be changed on this computer` : `Credential profile "${checked}" does not exist on this computer`,
      existsSync(directory) ? "not_owned" : "not_found");
  }
  const levels = [pairingDirectory, root, join(root, cli), directory];
  for (const [index, path] of levels.entries()) notLink(path, ["This Runtime's folder", "The credential profile folder", "The CLI's profile folder", `Credential profile "${checked}"`][index]);
  let flags: readonly boolean[];
  try { flags = (options.inspect ?? (process.platform === "win32" ? windowsReparseInspector : noReparseInspector))(levels); }
  catch { throw new ProfileOwnershipRefusal("This computer could not confirm that the profile folder has no link in its path, so nothing is changed", "link"); }
  if (flags.length !== levels.length || flags.some(Boolean)) throw new ProfileOwnershipRefusal("The profile folder or one above it is a link or junction, so nothing is changed there", "link");
  // Where it really is, against where it should be: any redirect not reported above still fails here.
  const real = realpathSync(directory), expected = join(realpathSync(pairingDirectory), "credential-profiles", cli, checked);
  if (!same(real, expected)) throw new ProfileOwnershipRefusal(`Credential profile "${checked}" is not inside this Runtime's profile folder`, "link");
  const own = [join(homedir(), ".claude"), ...(options.protectedHomes ?? [])];
  for (const home of own) { try { if (same(realpathSync(home), real)) throw new ProfileOwnershipRefusal("That is this Windows user's own sign-in, which is never changed from AgEnD", "not_owned"); } catch (error) { if (error instanceof ProfileOwnershipRefusal) throw error; } }
  assertNoLinksInside(directory);
  return directory;
}
/** Deletes only `<profile root>\<cli>\<name>` after requireOwnedProfile, then forgets it (record and cached sign-in), and proves it is gone. */
export function removeOwnedProfile(pairingDirectory: string, root: string, cli: unknown, name: unknown, options: OwnedProfileOptions = {}): void {
  const directory = requireOwnedProfile(pairingDirectory, root, cli, name, options), kind = cli as CredentialProfileCli, checked = name as string;
  rmSync(directory, { recursive: true, force: false, maxRetries: 3, retryDelay: 50 });
  if (existsSync(directory)) throw new Error("The profile folder could not be fully removed");
  forgetCreatedProfile(root, kind, checked); forgetCredentialStatus(root, kind, checked);
}
/**
 * `backups\.claude.json.backup*` in an owned profile: Claude Code keeps copies of its settings file there, and they carry the previous account's
 * identity after a sign-out. Only regular files with that name are deleted, nothing is followed. Returns how many.
 */
export function deleteProfileBackups(directory: string): number {
  const backups = join(directory, "backups");
  let stat; try { stat = lstatSync(backups); } catch { return 0; }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new ProfileOwnershipRefusal("This profile's backups folder is a link, so nothing is changed there", "link");
  let removed = 0;
  for (const entry of readdirSync(backups, { withFileTypes: true })) {
    if (!BACKUP.test(entry.name)) continue;
    const path = join(backups, entry.name), file = lstatSync(path);
    if (!file.isFile() || file.isSymbolicLink()) throw new ProfileOwnershipRefusal("A backup entry is not a plain file, so nothing more is changed there", "link");
    unlinkSync(path); removed++;
  }
  return removed;
}
