/**
 * Named CLI sign-ins ("credential profiles") for a Windows computer paired as a Runtime.
 *
 * AgEnD (the server) only ever sends a NAME. This module is the only place a name becomes a directory, and it does so under a
 * root the Runtime owns on this computer. A path, a drive letter, "..", a link or a device name can never be selected from the
 * outside. Sign-in data stays in the directory; only names (and a signed-in yes/no) are reported back.
 *
 * Built-ins only: it is loaded by the standalone Runtime and by AgEnD's server for the same name check.
 */
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, win32 } from "node:path";
import { atomicWriteFileSync } from "./atomic-write.js";
import { parseAccountIdentity, type AccountIdentity } from "./claude-auth-status.js";

/** Same shape as the Linux/WSL `credential_profile` (src/backend/credential-profile.ts), plus the Windows file-name hazards below. */
export const CREDENTIAL_PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** Reported in the Runtime's capabilities so an AgEnD never asks an older Runtime for a profile it would ignore. */
export const RUNTIME_CREDENTIAL_CAPABILITY = "credential-profiles";
/** Only Claude Code for now (`CLAUDE_CONFIG_DIR`). A new CLI is one more entry; the directory shape stays the same. */
export const CREDENTIAL_PROFILE_CLIS = Object.freeze({ "claude-code": "CLAUDE_CONFIG_DIR" } as const);
export type CredentialProfileCli = keyof typeof CREDENTIAL_PROFILE_CLIS;
export const CREDENTIAL_PROFILES_DIRECTORY = "credential-profiles";
const STATUS_FILE = "status.json";
/** Windows treats these as devices whatever the extension, and silently drops trailing dots/spaces: both would alias another name. */
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])(?:\..*)?$/i;

/**
 * A refusal whose text is ours and safe to show anywhere: it names a profile and a command, never a path, an account or a secret.
 * A pane host passes exactly this kind of message across its local link (anything else is flattened to a generic refusal).
 */
export class CredentialProfileRefusal extends Error { constructor(message: string) { super(message); this.name = "CredentialProfileRefusal"; } }
/**
 * `identity` (masked e-mail and plan) only for a profile that is signed in as an account; never present otherwise.
 * `created` (#3190 Part 3c): this Runtime made the folder and recorded it (`created.json`), so the dashboard may sign it in, sign it out and remove it when the
 * computer's owner allows; absent or false, the profile is only for the person at that computer. Absent also from a Runtime that does not report it.
 */
export interface CredentialProfileStatus { name: string; loggedIn: boolean | null; identity?: AccountIdentity; created?: boolean }
export interface CredentialProfileReport { profiles: CredentialProfileStatus[]; default?: string }

export function isCredentialProfileCli(value: unknown): value is CredentialProfileCli {
  return typeof value === "string" && Object.hasOwn(CREDENTIAL_PROFILE_CLIS, value);
}
/** True only for a name that is safe as a Linux profile name AND as a Windows folder name. */
export function validCredentialProfileName(value: unknown): value is string {
  return typeof value === "string" && CREDENTIAL_PROFILE_NAME.test(value) && !value.endsWith(".") && !WINDOWS_DEVICE.test(value);
}
export function assertCredentialProfileName(value: unknown): string {
  if (validCredentialProfileName(value)) return value;
  throw new Error("Credential profile names use 1-64 letters, digits, dots, hyphens or underscores, start with a letter or digit, and cannot end with a dot or be a Windows device name");
}
export function assertCredentialProfileCli(value: unknown): CredentialProfileCli {
  if (isCredentialProfileCli(value)) return value;
  throw new Error("Credential profiles on a Windows Runtime support Claude Code only");
}
/** Why a profile cannot be used for a run, with the next step on that computer. Never says which account or what is stored. */
export function credentialLoginRequired(cli: string, name: string, loggedIn: boolean | null): Error {
  return new Error(loggedIn === false
    ? `Credential profile "${name}" is not signed in on this computer. Sign in there: agend-runtime login ${cli} ${name}`
    : `This computer could not confirm that credential profile "${name}" is signed in, so nothing was started. Check it there: agend-runtime profile list`);
}
export function credentialProfilesRoot(runtimeHome: string): string { return join(runtimeHome, CREDENTIAL_PROFILES_DIRECTORY); }
/**
 * The directory a profile name stands for. Pure: it checks the name and joins; it never reads the disk. Whatever the name, the result is a
 * direct child of `<root>\<cli>`; anything that would land elsewhere (even by a future change to the name rule) is refused here.
 */
export function credentialProfileDirectory(root: string, cli: unknown, name: unknown): string {
  const base = join(root, assertCredentialProfileCli(cli)), directory = join(base, assertCredentialProfileName(name));
  const inside = relative(base, directory);
  if (!inside || inside.startsWith("..") || isAbsolute(inside) || win32.isAbsolute(inside) || inside.includes("/") || inside.includes("\\")) throw new Error("A credential profile must stay inside this Runtime's profile folder");
  return directory;
}
function realDirectory(path: string, what: string): void {
  let stat; try { stat = lstatSync(path); } catch { throw new Error(`${what} does not exist`); }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${what} must be a real folder, not a link`);
}
const same = (a: string, b: string): boolean => process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
/** Valid-named folders under `<root>\<cli>`, exactly as the disk spells them (real folders only, no links). */
function profileFolders(root: string, cli: CredentialProfileCli): string[] {
  const base = join(root, cli);
  try { realDirectory(base, "The credential profile folder"); } catch { return []; }
  return readdirSync(base, { withFileTypes: true }).filter(entry => entry.isDirectory() && !entry.isSymbolicLink() && validCredentialProfileName(entry.name)).map(entry => entry.name);
}
/** Folders whose names differ only by letter case are the same folder on Windows: such a name is ambiguous, so it is neither listed nor usable. */
function ambiguousFolders(names: readonly string[]): Set<string> {
  const groups = new Map<string, string[]>();
  for (const name of names) { const key = name.toLowerCase(); groups.set(key, [...(groups.get(key) ?? []), name]); }
  return new Set([...groups.values()].filter(group => group.length > 1).flat());
}
/**
 * The directory of a profile that already exists. Fail closed: an unknown name, a name that is only a case variant of another, an ambiguous
 * one, a name that is not a folder, or a link is an error with its next step. There is deliberately no "use the default account instead".
 */
export function requireCredentialProfile(root: string, cli: unknown, name: unknown): string {
  const checked = assertCredentialProfileName(name), kind = assertCredentialProfileCli(cli), directory = credentialProfileDirectory(root, kind, checked);
  const missing = new Error(`Credential profile "${checked}" does not exist on this computer. Create and sign in to it here: agend-runtime login ${kind} ${checked}`);
  const folders = profileFolders(root, kind);
  if (!folders.includes(checked)) {
    // Windows would silently open "Work" for "work": say which one exists instead of aliasing it.
    const alias = folders.find(other => other.toLowerCase() === checked.toLowerCase());
    throw alias ? new Error(`Credential profile "${checked}" does not exist on this computer; "${alias}" does, and names are different if only the letter case differs. Use "${alias}".`) : missing;
  }
  if (ambiguousFolders(folders).has(checked)) throw new Error(`Credential profile "${checked}" is ambiguous: another folder differs from it only by letter case. Remove one of them from this Runtime's credential-profiles folder.`);
  realDirectory(directory, `Credential profile "${checked}"`);
  // A junction or a link anywhere on the way would have lstat above report a link; this also proves the real location is the fixed root's child.
  const real = realpathSync(directory), expected = join(realpathSync(join(root, kind)), checked);
  if (!same(real, expected)) throw new Error(`Credential profile "${checked}" is not inside this Runtime's profile folder`);
  return directory;
}
/** Creates (or confirms) a profile folder, private to this Windows user. Names that differ only by case are the same folder on Windows, so they are refused. */
export function ensureCredentialProfile(root: string, cli: unknown, name: unknown): string {
  const checked = assertCredentialProfileName(name), kind = assertCredentialProfileCli(cli), directory = credentialProfileDirectory(root, kind, checked);
  for (const path of [root, join(root, kind)]) { mkdirSync(path, { recursive: true, mode: 0o700 }); realDirectory(path, "The credential profile folder"); }
  const clash = profileFolders(root, kind).find(other => other.toLowerCase() === checked.toLowerCase() && other !== checked);
  if (clash) throw new Error(`Credential profile "${checked}" would be the same folder as "${clash}" on Windows; use that name or choose another`);
  mkdirSync(directory, { recursive: true, mode: 0o700 }); realDirectory(directory, `Credential profile "${checked}"`);
  return directory;
}
/** The name of an existing profile folder that differs from this one only by letter case (the same folder on Windows), if any: such a name cannot be created. */
export function credentialProfileCaseClash(root: string, cli: unknown, name: unknown): string | undefined {
  const checked = assertCredentialProfileName(name);
  return profileFolders(root, assertCredentialProfileCli(cli)).find(other => other.toLowerCase() === checked.toLowerCase() && other !== checked);
}
/** Names of the profile folders that exist, from the disk (the truth). Not listed: anything that is not a real folder with a valid name, and any name that is ambiguous by letter case. */
export function listCredentialProfileNames(root: string, cli: unknown): string[] {
  const folders = profileFolders(root, assertCredentialProfileCli(cli)), ambiguous = ambiguousFolders(folders);
  return folders.filter(name => !ambiguous.has(name)).sort((a, b) => a.localeCompare(b));
}

/**
 * The last sign-in answer for each profile. A profile name is data, not a property: `constructor`, `toString` and `hasOwnProperty` are valid
 * names, so the maps are read and written with Object.hasOwn on null-prototype objects (and `__proto__` is not a valid name at all).
 */
type StatusRow = { loggedIn: boolean | null; at: number; identity?: AccountIdentity };
type StatusFile = { version: 1; checkedAt: Record<string, Record<string, StatusRow>> };
const dictionary = <T>(): Record<string, T> => Object.create(null) as Record<string, T>;
function readStatusFile(root: string): StatusFile {
  const file: StatusFile = { version: 1, checkedAt: dictionary() };
  try {
    const path = join(root, STATUS_FILE), stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) return file;
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    const checked = value && typeof value === "object" && (value as StatusFile).version === 1 ? (value as StatusFile).checkedAt : undefined;
    if (!checked || typeof checked !== "object") return file;
    for (const cli of Object.keys(checked)) {
      const rows = (checked as Record<string, unknown>)[cli]; if (!isCredentialProfileCli(cli) || !rows || typeof rows !== "object") continue;
      const copy = file.checkedAt[cli] = dictionary<StatusRow>();
      for (const name of Object.keys(rows)) {
        const row = (rows as Record<string, unknown>)[name] as Partial<StatusRow> | null;
        if (validCredentialProfileName(name) && row && typeof row === "object" && (typeof row.loggedIn === "boolean" || row.loggedIn === null) && typeof row.at === "number") {
          // An identity that is not in its masked form (a hostile or hand-edited file) is dropped, never reported.
          let identity: AccountIdentity | undefined; try { identity = row.identity === undefined ? undefined : parseAccountIdentity(row.identity); } catch { identity = undefined; }
          copy[name] = { loggedIn: row.loggedIn, at: row.at, ...(identity && row.loggedIn === true ? { identity } : {}) };
        }
      }
    }
  } catch { /* an unreadable cache is "unknown", never an error */ }
  return file;
}
/** The last sign-in check this computer made for a profile (`login`, `profile list`, an explicit "Detect again"). Null when it has not been checked. */
export function cachedCredentialLogin(root: string, cli: CredentialProfileCli, name: string): boolean | null {
  const rows = readStatusFile(root).checkedAt[cli];
  return rows && Object.hasOwn(rows, name) ? rows[name].loggedIn : null;
}
/** The last answer with its account, for a profile checked before; null when it never was. */
export function cachedCredentialStatus(root: string, cli: CredentialProfileCli, name: string): { loggedIn: boolean | null; identity?: AccountIdentity } | null {
  const rows = readStatusFile(root).checkedAt[cli];
  if (!rows || !Object.hasOwn(rows, name)) return null;
  const { loggedIn, identity } = rows[name]; return { loggedIn, ...(identity ? { identity } : {}) };
}
/** A sign-in answer with no account in it (the launch gate's yes/no, a test seam): it also forgets any account remembered before. */
export function rememberCredentialLogin(root: string, cli: CredentialProfileCli, name: string, loggedIn: boolean | null, now = Date.now()): void {
  rememberCredentialStatus(root, cli, name, { loggedIn }, now);
}
export function rememberCredentialStatus(root: string, cli: CredentialProfileCli, name: string, answer: { loggedIn: boolean | null; identity?: AccountIdentity }, now = Date.now()): void {
  assertCredentialProfileName(name);
  const identity = answer.loggedIn === true && answer.identity ? parseAccountIdentity(answer.identity) : undefined;
  const file = readStatusFile(root); (file.checkedAt[cli] ??= dictionary<StatusRow>())[name] = { loggedIn: answer.loggedIn, at: now, ...(identity ? { identity } : {}) };
  const plain: Record<string, Record<string, StatusRow>> = {};
  for (const kind of Object.keys(file.checkedAt)) plain[kind] = Object.fromEntries(Object.entries(file.checkedAt[kind]));
  try { mkdirSync(root, { recursive: true, mode: 0o700 }); atomicWriteFileSync(join(root, STATUS_FILE), JSON.stringify({ version: 1, checkedAt: plain }), { mode: 0o600 }); } catch { /* a cache; the next check writes it again */ }
}
/** Forgets what was cached for a profile that no longer exists (its account included), so a removed name is never reported again. */
export function forgetCredentialStatus(root: string, cli: CredentialProfileCli, name: string): void {
  const file = readStatusFile(root), rows = file.checkedAt[cli];
  if (!rows || !Object.hasOwn(rows, name)) return;
  delete rows[name];
  const plain: Record<string, Record<string, StatusRow>> = {};
  for (const kind of Object.keys(file.checkedAt)) plain[kind] = Object.fromEntries(Object.entries(file.checkedAt[kind]));
  try { atomicWriteFileSync(join(root, STATUS_FILE), JSON.stringify({ version: 1, checkedAt: plain }), { mode: 0o600 }); } catch { /* a cache; the next check writes it again */ }
}
/** What this computer tells AgEnD: names and a signed-in yes/no (null = not checked yet). No path, e-mail, account or token. */
export function credentialProfileReport(root: string, defaultName?: string, created?: (name: string) => boolean): CredentialProfileReport {
  const kind: CredentialProfileCli = "claude-code";
  const profiles = listCredentialProfileNames(root, kind).map(name => { const known = cachedCredentialStatus(root, kind, name);
    return { name, loggedIn: known?.loggedIn ?? null, ...(known?.identity ? { identity: known.identity } : {}), ...(created ? { created: created(name) } : {}) }; });
  return { profiles, ...(defaultName && profiles.some(row => row.name === defaultName) ? { default: defaultName } : {}) };
}
/** Bounded, closed parse of what a Runtime reports: only names and a signed-in yes/no. Anything else (a path, an e-mail) is a protocol error. */
export function parseCredentialProfileReport(value: unknown): CredentialProfileReport {
  // The field that was wrong, never its value: a rejected report may carry an unmasked e-mail, and an error must not repeat it.
  const fail = (field = "report"): never => { throw new Error(`Invalid credential profile report: ${field}`); };
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => key !== "profiles" && key !== "default") || !Array.isArray(input.profiles) || input.profiles.length > 64) return fail();
  const seen = new Set<string>(), profiles: CredentialProfileStatus[] = [];
  for (const row of input.profiles) {
    if (!row || typeof row !== "object" || Array.isArray(row)) return fail("profile");
    const item = row as Record<string, unknown>;
    if (Object.keys(item).some(key => key !== "name" && key !== "loggedIn" && key !== "identity" && key !== "created")) return fail("profile field");
    if (item.created !== undefined && typeof item.created !== "boolean") return fail("created");
    if (!validCredentialProfileName(item.name) || ![true, false, null].includes(item.loggedIn as boolean | null) || seen.has(item.name.toLowerCase())) return fail("name or loggedIn");
    // The account is only a masked e-mail and a plan, and only for a signed-in profile; an unmasked e-mail is a protocol error.
    if (item.identity !== undefined && item.loggedIn !== true) return fail("identity");
    let identity: AccountIdentity | undefined;
    try { identity = item.identity === undefined ? undefined : parseAccountIdentity(item.identity); }
    catch (error) { return fail(`identity ${/^Invalid account identity: (identity|unknown field|maskedEmail|plan|apiKey)$/.exec((error as Error).message)?.[1] ?? "invalid"}`); }
    seen.add(item.name.toLowerCase()); profiles.push({ name: item.name, loggedIn: item.loggedIn as boolean | null, ...(identity ? { identity } : {}), ...(item.created !== undefined ? { created: item.created as boolean } : {}) });
  }
  if (input.default !== undefined && (!validCredentialProfileName(input.default) || !profiles.some(row => row.name === input.default))) return fail("default");
  return { profiles, ...(input.default !== undefined ? { default: input.default as string } : {}) };
}
/**
 * The environment of one CLI run on this computer, with the profile's directory in the CLI's own variable. Any ambient value of that
 * variable (whatever its letter case) is removed first, so a profile can never be combined with, or lose to, another account.
 */
export function withCredentialProfile(env: NodeJS.ProcessEnv, cli: unknown, directory: string): NodeJS.ProcessEnv {
  const variable = CREDENTIAL_PROFILE_CLIS[assertCredentialProfileCli(cli)], out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) if (key.toUpperCase() !== variable) out[key] = value;
  out[variable] = directory;
  return out;
}
/**
 * A cheap fingerprint of what `agend-runtime login` / `profile default` last wrote for this pairing (the sign-in cache and the default's file),
 * so a running Runtime notices a sign-in made in another window and re-reports it without being asked.
 */
export function credentialCacheStamp(root: string, defaultFile?: string): string {
  const one = (path: string): string => { try { const stat = lstatSync(path); return `${stat.mtimeMs}:${stat.size}`; } catch { return "-"; } };
  return `${one(join(root, STATUS_FILE))}|${defaultFile ? one(defaultFile) : "-"}`;
}
export function credentialProfileExists(root: string, cli: CredentialProfileCli, name: string): boolean {
  try { return existsSync(requireCredentialProfile(root, cli, name)); } catch { return false; }
}
