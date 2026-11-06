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
import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { atomicWriteFileSync } from "./atomic-write.js";
import { spawn } from "./child-process.js";
import { assertCredentialProfileCli, assertCredentialProfileName, credentialProfileDirectory, ensureCredentialProfile, forgetCredentialStatus, isCredentialProfileCli, type CredentialProfileCli } from "./runtime-credential-profiles.js";

export const CREATED_PROFILES_FILE = "created.json";
const MAX_LEDGER_BYTES = 64 * 1024;
const MAX_WALK_ENTRIES = 20_000;
const BACKUP = /^\.claude\.json\.backup(?:[.\-_][A-Za-z0-9._-]{0,64})?$/;

/** A refusal whose text is ours: it names a profile and what to do, never a path, an account or a secret. */
export class ProfileOwnershipRefusal extends Error {
  constructor(message: string, readonly reason: "unsupported" | "not_owned" | "not_found" | "link" | "invalid_request" | "in_use" | "default_profile" | "unconfirmed") { super(message); this.name = "ProfileOwnershipRefusal"; }
}
const present = (path: string): boolean => { try { lstatSync(path); return true; } catch { return false; } };
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
export type ReparseInspector = (paths: readonly string[]) => readonly boolean[] | Promise<readonly boolean[]>;
/**
 * Windows: `[IO.File]::GetAttributes` has the ReparsePoint bit (0x400) set for a junction, a symbolic link, a OneDrive placeholder or any other
 * reparse point, which Node's lstat does not always report. The paths go through the child's environment (`|` cannot be in a Windows path), never
 * into a command line. Asynchronous (a slow PowerShell must not stop the Runtime's connection), its stderr and stdin are discarded (its errors
 * carry paths), and its environment is the minimum Windows PowerShell 5.1 needs to start: `SystemRoot` and `windir` (module and assembly lookup),
 * `TEMP`/`TMP` (its own scratch use) and a `PATH` that holds System32 only. Nothing from the Runtime's environment, so no setting of the computer's
 * own can redirect it. Fail closed: when the answer cannot be read, the caller is told it could not be proven.
 */
export const windowsReparseInspector = (paths: readonly string[]): Promise<readonly boolean[]> => new Promise((done, fail) => {
  const system = process.env.SystemRoot || "C:\\Windows", temp = process.env.TEMP || process.env.TMP || join(system, "Temp");
  const child = spawn(join(system, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-Command", "$ErrorActionPreference='Stop'; foreach ($p in $env:AGEND_CHECK_PATHS.Split('|')) { if (([int][System.IO.File]::GetAttributes($p) -band 0x400) -ne 0) { '1' } else { '0' } }"],
    { env: { SystemRoot: system, windir: system, TEMP: temp, TMP: temp, PATH: join(system, "System32"), AGEND_CHECK_PATHS: paths.join("|") }, stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
  let out = ""; const timer = setTimeout(() => { child.kill(); fail(new Error("Reparse point check timed out")); }, 20_000); timer.unref?.();
  child.stdout?.on("data", chunk => { out = (out + chunk.toString()).slice(0, 4096); });
  child.on("error", () => { clearTimeout(timer); fail(new Error("Reparse point check could not start")); });
  child.on("close", code => {
    clearTimeout(timer);
    const rows = out.split(/\r?\n/).filter(Boolean);
    if (code !== 0 || rows.length !== paths.length || rows.some(row => row !== "0" && row !== "1")) { fail(new Error("Reparse point check was unreadable")); return; }
    done(rows.map(row => row === "1"));
  });
});
const noReparseInspector: ReparseInspector = paths => paths.map(() => false);
const NOT_PROVEN = "This computer could not confirm that the profile folder has no link in its path, so nothing is changed. If this keeps happening, Windows PowerShell may be unavailable or restricted (for example by a constrained language mode) for this Windows user";
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
export interface OwnedProfileOptions {
  inspect?: ReparseInspector;
  /** The Windows user's own sign-in homes, which are never a profile. */
  protectedHomes?: readonly string[];
  /** Test seam: runs between the checks and the delete, where a hostile process on the same computer could swap the folder. */
  afterChecks?: () => void;
}
/**
 * The folder of a profile that this Runtime created and that is where it should be, with no link at any level. Throws a
 * ProfileOwnershipRefusal otherwise; nothing is read from or written to the profile.
 */
export async function requireOwnedProfile(pairingDirectory: string, root: string, cli: unknown, name: unknown, options: OwnedProfileOptions = {}): Promise<string> {
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
  try { flags = await (options.inspect ?? (process.platform === "win32" ? windowsReparseInspector : noReparseInspector))(levels); }
  catch { throw new ProfileOwnershipRefusal(NOT_PROVEN, "link"); }
  if (flags.length !== levels.length || flags.some(Boolean)) throw new ProfileOwnershipRefusal("The profile folder or one above it is a link or junction, so nothing is changed there", "link");
  // Where it really is, against where it should be: any redirect not reported above still fails here.
  const real = realpathSync(directory), expected = join(realpathSync(pairingDirectory), "credential-profiles", cli, checked);
  if (!same(real, expected)) throw new ProfileOwnershipRefusal(`Credential profile "${checked}" is not inside this Runtime's profile folder`, "link");
  const own = [join(homedir(), ".claude"), ...(options.protectedHomes ?? [])];
  for (const home of own) { try { if (same(realpathSync(home), real)) throw new ProfileOwnershipRefusal("That is this Windows user's own sign-in, which is never changed from AgEnD", "not_owned"); } catch (error) { if (error instanceof ProfileOwnershipRefusal) throw error; } }
  assertNoLinksInside(directory);
  return directory;
}
/**
 * Deletes only `<profile root>\<cli>\<name>`, after requireOwnedProfile. The checks and the delete are not one atomic step, and something running as
 * the same Windows user could swap the folder for a junction in between. So the folder is first RENAMED to a unique name beside it (renaming a
 * junction renames the junction itself, never what it points to), the renamed thing is checked again (a real folder, no link, no reparse point,
 * nothing linked inside), and only then deleted. Any failure puts the name back, so the profile is still there to retry. Then the record and the
 * cached sign-in are forgotten, and the folder is proven gone.
 */
export async function removeOwnedProfile(pairingDirectory: string, root: string, cli: unknown, name: unknown, options: OwnedProfileOptions = {}): Promise<void> {
  const directory = await requireOwnedProfile(pairingDirectory, root, cli, name, options), kind = cli as CredentialProfileCli, checked = name as string;
  options.afterChecks?.();
  const expectedBase = join(realpathSync(pairingDirectory), "credential-profiles", kind);
  // A leading dot is not a valid profile name, so the temporary name can never be one, and is never listed or selected.
  const moved = join(dirname(directory), `.removing-${randomBytes(8).toString("hex")}`);
  renameSync(directory, moved);
  let restored = true;
  const restore = (): void => { try { renameSync(moved, directory); } catch { restored = !present(moved); /* else left under its temporary name, which is not a profile */ } };
  try {
    // The folder above it, again, after the rename: a CLI folder swapped for a link in the meantime would have taken the rename elsewhere.
    if (!same(realpathSync(dirname(moved)), expectedBase) || !same(realpathSync(moved), join(expectedBase, basename(moved)))) throw new ProfileOwnershipRefusal(`Credential profile "${checked}" is not inside this Runtime's profile folder`, "link");
    notLink(moved, `Credential profile "${checked}"`);
    let flags: readonly boolean[]; try { flags = await (options.inspect ?? (process.platform === "win32" ? windowsReparseInspector : noReparseInspector))([moved]); } catch { throw new ProfileOwnershipRefusal(NOT_PROVEN, "link"); }
    if (flags.length !== 1 || flags[0]) throw new ProfileOwnershipRefusal("The profile folder is a link or junction, so nothing is changed there", "link");
    assertNoLinksInside(moved);
    rmSync(moved, { recursive: true, force: false, maxRetries: 3, retryDelay: 50 });
  } catch (error) {
    restore();
    // Neither deleted nor put back: say where it is, locally (`agend-runtime profile list` names it). Nothing here deletes or restores it by itself.
    if (!restored) throw new Error("The profile folder could not be removed or put back and is left under a temporary name; see agend-runtime profile list on that computer");
    throw error;
  }
  if (existsSync(moved) || existsSync(directory)) throw new Error("The profile folder could not be fully removed");
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

/** Folders a removal began and could not finish (renamed to `.removing-<hex>`, then neither deleted nor put back). They may still hold a sign-in. */
export function listRemovalLeftovers(root: string, cli: unknown): string[] {
  const base = join(root, assertCredentialProfileCli(cli));
  try {
    if (!lstatSync(base).isDirectory()) return [];
    return readdirSync(base, { withFileTypes: true }).filter(entry => entry.isDirectory() && !entry.isSymbolicLink() && /^\.removing-[a-f0-9]{16}$/.test(entry.name)).map(entry => entry.name).sort();
  } catch { return []; }
}
