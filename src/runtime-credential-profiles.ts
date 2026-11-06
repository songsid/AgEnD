/**
 * Named CLI sign-ins ("credential profiles") for a Windows computer paired as a Runtime.
 *
 * AgEnD (the server) only ever sends a NAME. This module is the only place a name becomes a directory, and it does so under a
 * root the Runtime owns on this computer. A path, a drive letter, "..", a link or a device name can never be selected from the
 * outside. Sign-in data stays in the directory; only names (and a signed-in yes/no) are reported back.
 *
 * Built-ins only: it is loaded by the standalone Runtime and by AgEnD's server for the same name check.
 */
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFileSync } from "./atomic-write.js";

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

export interface CredentialProfileStatus { name: string; loggedIn: boolean | null }
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
/** The directory a profile name stands for. Pure: it checks the name and joins; it never reads the disk. */
export function credentialProfileDirectory(root: string, cli: unknown, name: unknown): string {
  return join(root, assertCredentialProfileCli(cli), assertCredentialProfileName(name));
}
function realDirectory(path: string, what: string): void {
  let stat; try { stat = lstatSync(path); } catch { throw new Error(`${what} does not exist`); }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${what} must be a real folder, not a link`);
}
/**
 * The directory of a profile that already exists. Fail closed: an unknown name, a name that is not a folder, or a link is an error
 * with its next step. There is deliberately no "use the default account instead".
 */
export function requireCredentialProfile(root: string, cli: unknown, name: unknown): string {
  const checked = assertCredentialProfileName(name), directory = credentialProfileDirectory(root, cli, checked);
  realDirectory(join(root, assertCredentialProfileCli(cli)), "The credential profile folder");
  try { realDirectory(directory, `Credential profile "${checked}"`); }
  catch { throw new Error(`Credential profile "${checked}" does not exist on this computer. Create and sign in to it here: agend-runtime login ${String(cli)} ${checked}`); }
  return directory;
}
/** Creates (or confirms) a profile folder, private to this Windows user. Names that differ only by case are the same folder on Windows, so they are refused. */
export function ensureCredentialProfile(root: string, cli: unknown, name: unknown): string {
  const checked = assertCredentialProfileName(name), kind = assertCredentialProfileCli(cli), directory = credentialProfileDirectory(root, kind, checked);
  for (const path of [root, join(root, kind)]) { mkdirSync(path, { recursive: true, mode: 0o700 }); realDirectory(path, "The credential profile folder"); }
  const clash = listCredentialProfileNames(root, kind).find(other => other.toLowerCase() === checked.toLowerCase() && other !== checked);
  if (clash) throw new Error(`Credential profile "${checked}" would be the same folder as "${clash}" on Windows; use that name or choose another`);
  mkdirSync(directory, { recursive: true, mode: 0o700 }); realDirectory(directory, `Credential profile "${checked}"`);
  return directory;
}
/** Names of the profile folders that exist, from the disk (the truth). Anything that is not a real folder with a valid name is not listed. */
export function listCredentialProfileNames(root: string, cli: unknown): string[] {
  const base = join(root, assertCredentialProfileCli(cli));
  try { realDirectory(base, "The credential profile folder"); } catch { return []; }
  return readdirSync(base, { withFileTypes: true }).filter(entry => entry.isDirectory() && !entry.isSymbolicLink() && validCredentialProfileName(entry.name)).map(entry => entry.name).sort((a, b) => a.localeCompare(b));
}

type StatusFile = { version: 1; checkedAt: Record<string, Record<string, { loggedIn: boolean | null; at: number }>> };
function readStatusFile(root: string): StatusFile {
  try {
    const path = join(root, STATUS_FILE), stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) return { version: 1, checkedAt: {} };
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (value && typeof value === "object" && (value as StatusFile).version === 1 && typeof (value as StatusFile).checkedAt === "object" && (value as StatusFile).checkedAt) return value as StatusFile;
  } catch { /* an unreadable cache is "unknown", never an error */ }
  return { version: 1, checkedAt: {} };
}
/** The last sign-in check this computer made for a profile (`login`, `profile list`, an explicit "Detect again"). Null when it has not been checked. */
export function cachedCredentialLogin(root: string, cli: CredentialProfileCli, name: string): boolean | null {
  const row = readStatusFile(root).checkedAt[cli]?.[name];
  return row && typeof row.loggedIn === "boolean" ? row.loggedIn : null;
}
export function rememberCredentialLogin(root: string, cli: CredentialProfileCli, name: string, loggedIn: boolean | null, now = Date.now()): void {
  const file = readStatusFile(root); (file.checkedAt[cli] ??= {})[name] = { loggedIn, at: now };
  try { mkdirSync(root, { recursive: true, mode: 0o700 }); atomicWriteFileSync(join(root, STATUS_FILE), JSON.stringify(file), { mode: 0o600 }); } catch { /* a cache; the next check writes it again */ }
}
/** What this computer tells AgEnD: names and a signed-in yes/no (null = not checked yet). No path, e-mail, account or token. */
export function credentialProfileReport(root: string, defaultName?: string): CredentialProfileReport {
  const kind: CredentialProfileCli = "claude-code";
  const profiles = listCredentialProfileNames(root, kind).map(name => ({ name, loggedIn: cachedCredentialLogin(root, kind, name) }));
  return { profiles, ...(defaultName && profiles.some(row => row.name === defaultName) ? { default: defaultName } : {}) };
}
/** Bounded, closed parse of what a Runtime reports: only names and a signed-in yes/no. Anything else (a path, an e-mail) is a protocol error. */
export function parseCredentialProfileReport(value: unknown): CredentialProfileReport {
  const fail = (): never => { throw new Error("Invalid credential profile report"); };
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => key !== "profiles" && key !== "default") || !Array.isArray(input.profiles) || input.profiles.length > 64) return fail();
  const seen = new Set<string>(), profiles: CredentialProfileStatus[] = [];
  for (const row of input.profiles) {
    if (!row || typeof row !== "object" || Array.isArray(row)) return fail();
    const item = row as Record<string, unknown>;
    if (Object.keys(item).some(key => key !== "name" && key !== "loggedIn") || !validCredentialProfileName(item.name) || ![true, false, null].includes(item.loggedIn as boolean | null) || seen.has(item.name.toLowerCase())) return fail();
    seen.add(item.name.toLowerCase()); profiles.push({ name: item.name, loggedIn: item.loggedIn as boolean | null });
  }
  if (input.default !== undefined && (!validCredentialProfileName(input.default) || !profiles.some(row => row.name === input.default))) return fail();
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
export function credentialProfileExists(root: string, cli: CredentialProfileCli, name: string): boolean {
  try { return existsSync(requireCredentialProfile(root, cli, name)); } catch { return false; }
}
