/** Runs on Windows Node, including when its parent is AgEnD inside WSL.
 * Built-ins only: this file must not load AgEnD's Linux native dependencies.
 * One JSON request, then optional cancellation, over stdin; JSON events over stdout.
 */
import { execFile, spawn } from "./child-process.js";
import type { ChildProcess } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, hostname, tmpdir } from "node:os";
import { dirname, join, resolve, win32 } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import { runtimeFacts, type RuntimeDefaultLoginCli } from "./cli-registry.js";
import { nativeUpdateGuard, boundNativeModelOptions, buildNativeInvocation, isNativeProviderId, nativeMcpServerConfig, nativeProvider, NATIVE_PROVIDER_IDS, parseNativeAuthResult, parseNativeModels, validateNativeMcpConnection, validateNativeModel, type NativeMcpLaunch, type NativeModelOption, type NativeProviderDescriptor, type NativeProviderId } from "./windows-cli-providers.js";
import { claudeDocumentedModels } from "./model-catalog-defaults.js";
import { identityOf, parseClaudeAuthStatus, type AccountIdentity } from "./claude-auth-status.js";
import { credentialProfileLaunch, credentialProfileStore, isCredentialProfileCli, type CredentialProfileCli } from "./runtime-credential-profiles.js";
import { readAntigravityIdentityIn } from "./antigravity-identity.js";
import { MANAGED_CLI_ROOT_ENV, managedCliExecutable } from "./runtime-cli-install.js";

const exec = promisify(execFile);
export const NATIVE_CLI_IDS = NATIVE_PROVIDER_IDS;
export type NativeCliId = NativeProviderId;
export interface NativeCliRow {
  id: NativeCliId; path: string | null; version: string | null; authenticated: boolean | null; runnable: boolean;
  supports: NativeProviderDescriptor["supports"]; readOnlySupport: boolean;
  permissionNote: string; models: NativeModelOption[]; reason?: string;
  /** Coordinator-derived (cc3ce4fe), never trusted from a runner: whether this persistent-pane CLI's version is audited. */
  paneVerification?: "verified" | "unverified" | "denied" | "invalid";
  modelsSource?: "cli-cache" | "official-catalog" | "cli-list" | "unavailable";
  /** Claude Code only: the masked e-mail and plan of the default sign-in, taken from the same `auth status` answer as `authenticated`. */
  identity?: AccountIdentity;
}
const SIGN_IN_FIRST = "Sign in to this Windows CLI before running a task";
/**
 * AGEND-113: a row with a newer word on its sign-in (a check the computer was just asked for, see `WindowsCliBridge.noteAuthenticated`). What follows from `authenticated` is derived again the way
 * the probe derives it: runnable unless signed out, and the "sign in first" reason only for a row that has no other reason.
 */
export function withAuthenticated(row: NativeCliRow, authenticated: boolean): NativeCliRow {
  if (row.authenticated === authenticated) return row;
  const { reason, ...rest } = row;
  const next: NativeCliRow = { ...rest, authenticated, runnable: row.supports.execution && authenticated !== false };
  const kept = reason === SIGN_IN_FIRST ? undefined : reason;
  const why = kept ?? (authenticated === false ? SIGN_IN_FIRST : undefined);
  return why ? { ...next, reason: why } : next;
}
export interface NativeTaskInput { requestId: string; cli: NativeProviderId; cwd: string; prompt: string; sandbox: "read-only" | "workspace-write"; model?: string }

const AGENT_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export function validWindowsAgentId(value: unknown): value is string { return typeof value === "string" && AGENT_ID.test(value); }

/** A private, durable workspace. Only a server-generated agent UUID chooses its final segment. */
export function prepareNativeWorkspace(agentId: unknown, home = homedir()): string {
  if (!validWindowsAgentId(agentId)) throw new Error("Invalid Windows agent id");
  let current = realpathSync(home);
  for (const segment of [".agend", "workspaces", agentId]) {
    const next = join(current, segment);
    try { mkdirSync(next, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const entry = lstatSync(next);
    if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error("Managed Windows workspace must be a real directory, not a link");
    const actual = realpathSync(next);
    const comparable = (value: string): string => process.platform === "win32" ? resolve(value).toLowerCase() : resolve(value);
    if (comparable(actual) !== comparable(next)) throw new Error("Managed Windows workspace escaped its directory");
    current = actual;
  }
  return current;
}

/** A native, drive-qualified directory. UNC/device paths and control bytes are not part of this MVP. */
export function validWindowsDirectory(value: unknown): value is string {
  return typeof value === "string" && value.length <= 1024 && /^[a-z]:[\\/]/i.test(value)
    && !/[\x00-\x1f\x7f]/.test(value) && win32.isAbsolute(value);
}
export function validateNativeTask(value: unknown): NativeTaskInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Task must be an object");
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some(k => !["requestId", "cli", "cwd", "prompt", "sandbox", "model"].includes(k))) throw new Error("Unknown task field");
  if (typeof v.requestId !== "string" || !/^[a-z0-9-]{16,80}$/i.test(v.requestId)) throw new Error("Invalid requestId");
  if (!isNativeProviderId(v.cli)) throw new Error("Unknown Windows CLI provider");
  const provider = nativeProvider(v.cli);
  if (!provider.supports.execution) throw new Error(provider.reason || "Windows CLI execution is not supported");
  if (!validWindowsDirectory(v.cwd)) throw new Error("Enter an absolute Windows drive path, for example J:\\Project\\Game");
  if (typeof v.prompt !== "string" || !v.prompt.trim() || v.prompt.length > 16_384 || v.prompt.includes("\0")) throw new Error("Prompt must contain 1–16384 characters");
  if (v.sandbox !== "read-only" && v.sandbox !== "workspace-write") throw new Error("Invalid sandbox mode");
  if (v.sandbox === "read-only" && !provider.readOnlySupport) throw new Error(`${provider.name} cannot guarantee read-only execution; choose native CLI permissions instead`);
  const model = validateNativeModel(v.model);
  return { requestId: v.requestId, cli: v.cli, cwd: v.cwd, prompt: v.prompt, sandbox: v.sandbox, ...(model ? { model } : {}) };
}
export function codexTaskArgs(input: NativeTaskInput, resumeSessionId?: string): string[] {
  if (input.cli !== "codex") throw new Error("Codex task arguments require Codex");
  return buildNativeInvocation(input, { resumeSessionId }).args;
}
export function codexEventText(line: string): string | null {
  try {
    const e = JSON.parse(line);
    if (e.type === "item.completed" && e.item?.type === "agent_message" && typeof e.item.text === "string") return e.item.text;
    if ((e.type === "error" || e.type === "turn.failed") && typeof (e.message ?? e.error?.message) === "string") return `Error: ${e.message ?? e.error.message}`;
    if (e.type === "item.completed" && e.item?.type === "command_execution") {
      return [e.item.command, e.item.aggregated_output].filter(x => typeof x === "string").join("\n");
    }
  } catch { /* Non-protocol output is never an instruction or a completion proof. */ }
  return null;
}

export interface NativeCliExecutable { path: string; command: string; args: string[] }
interface NativeCommandOutput { ok: boolean; text: string }
/**
 * M-2239 P3-6: what a Windows CLI may see of the worker's environment — an allowlist, never "everything but". Windows'
 * own system and user variables a program needs to start, find files and reach the network (proxy, certificates),
 * the locale, and a CLI's own config directory when it names a Windows path. Nothing else: no fleet secret, provider
 * API key, bot token or AgEnD setting reaches a native CLI, whatever the host put in the environment.
 */
const NATIVE_ENV_ALLOWED = new Set([
  // Windows itself: where it is, how it finds programs, who and where the user is.
  "SYSTEMROOT", "WINDIR", "SYSTEMDRIVE", "COMSPEC", "PATH", "PATHEXT", "TEMP", "TMP", "OS",
  "USERPROFILE", "USERNAME", "USERDOMAIN", "USERDOMAIN_ROAMINGPROFILE", "COMPUTERNAME", "HOMEDRIVE", "HOMEPATH", "LOGONSERVER",
  "APPDATA", "LOCALAPPDATA", "PROGRAMDATA", "ALLUSERSPROFILE", "PUBLIC",
  "PROGRAMFILES", "PROGRAMFILES(X86)", "PROGRAMW6432", "COMMONPROGRAMFILES", "COMMONPROGRAMFILES(X86)", "COMMONPROGRAMW6432",
  "PROCESSOR_ARCHITECTURE", "PROCESSOR_IDENTIFIER", "PROCESSOR_LEVEL", "PROCESSOR_REVISION", "NUMBER_OF_PROCESSORS",
  "DRIVERDATA", "PSMODULEPATH",
  // The network the user configured: proxies and certificate stores.
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR",
  // Language and terminal.
  "LANG", "LANGUAGE", "TZ", "TERM", "COLORTERM", "NO_COLOR", "FORCE_COLOR",
]);
/** A CLI's own config directory: kept when it is the Windows user's (a drive path), never a WSL path. AGEND_MANAGED_CLI_ROOT (#3190 3b) is the Runtime's own folder of installed CLIs, so its helpers find them too. */
const NATIVE_ENV_WINDOWS_PATH = new Set([MANAGED_CLI_ROOT_ENV, "CODEX_HOME", "CLAUDE_CONFIG_DIR", "KIRO_HOME", "GEMINI_HOME", "GROK_HOME", "OPENCODE_CONFIG_DIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"]);
export function nativeCliEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    const name = key.toUpperCase();
    if (NATIVE_ENV_ALLOWED.has(name) || /^LC_[A-Z]+$/.test(name)) env[key] = value;
    else if (NATIVE_ENV_WINDOWS_PATH.has(name) && validWindowsDirectory(value)) env[key] = value;
  }
  // M-2239 P1-2: every CLI's own "do not update" switch, on every run (the Linux backends' NO_UPDATE_ENV, plus kiro and
  // muse's). codex and grok take theirs as argv (nativeUpdateGuard).
  env.DISABLE_AUTOUPDATER = "1";
  env.OPENCODE_DISABLE_AUTOUPDATE = "1";
  env.NO_UPDATE_NOTIFIER = "1";
  env.KIRO_NO_AUTO_UPDATE = "1";
  env.MUSE_UPDATE_INTERVAL_SECONDS = "31536000";
  return env;
}
/** Windows environment names are case-insensitive even when a JS snapshot preserves their spelling. */
function nativeEnvironmentValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const values = [...new Set(Object.entries(env).filter(([key,value]) => key.toUpperCase() === name && value !== undefined).map(([,value]) => value!))];
  if (values.length > 1) throw Error("Ambiguous native configuration home");
  return values[0];
}
async function output(file: string, args: string[], timeout = 5000, env: NodeJS.ProcessEnv = nativeCliEnvironment()): Promise<NativeCommandOutput> {
  try {
    const r = await exec(file, args, { env, encoding: "utf8", timeout, maxBuffer: 64 * 1024, windowsHide: true, shell: false });
    return { ok: true, text: `${r.stdout}\n${r.stderr}`.trim() };
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string };
    return { ok: false, text: `${e.stdout ?? ""}\n${e.stderr ?? ""}`.trim() };
  }
}
/**
 * AGEND-113: what a command ended with, as an exit code. `null` is "could not be asked" (it did not start, or ran out of time): never "signed out". Output is not returned at all, so
 * nothing the CLI prints (an account name, a path) can travel with it.
 */
async function exitCodeOf(file: string, args: string[], timeout: number, env: NodeJS.ProcessEnv): Promise<number | null> {
  try { await exec(file, args, { env, encoding: "utf8", timeout, maxBuffer: 64 * 1024, windowsHide: true, shell: false }); return 0; }
  catch (error) {
    const e = error as { code?: unknown; killed?: boolean };
    return !e.killed && typeof e.code === "number" ? e.code : null;
  }
}
/**
 * A CLI's own login on this computer, for one whose login is the computer's (cli-registry.ts: `runtime.signIn.profile === "none"`; Antigravity): its registry `authStatus` command (`agy models`: a
 * listing, never a login and never a model request) read by its exit code, as the host's `authCheck` reads it. Windows keeps that login in the Credential Manager under one fixed name, so there is
 * one answer per Windows user and no profile to ask about. true = exit 0, false = the CLI said no, null = it could not be asked. Started only because an administrator's request asked (a
 * sign-in's own checks): never on a timer or a read.
 */
export async function probeDefaultLogin(cli: RuntimeDefaultLoginCli, find: (id: NativeCliId) => Promise<NativeCliExecutable | null> = findCli,
  run: (executable: NativeCliExecutable, args: string[], env: NodeJS.ProcessEnv) => Promise<number | null> = (entry, args, env) => exitCodeOf(entry.command, [...entry.args, ...args], 20_000, env)): Promise<boolean | null> {
  const status = runtimeFacts(cli, "authStatus");
  if (!status) return null;
  const executable = await find(cli);
  if (!executable) return null;
  const code = await run(executable, [...nativeUpdateGuard(cli), ...status.argv], nativeCliEnvironment());
  return code === null ? null : code === 0;
}
/**
 * AGEND-124: removes one Windows Credential Manager entry by name (`cmdkey /delete:<name>`), the entry a CLI keeps the computer's OWN login in (`runtime.signOut.credential`: `gemini:antigravity`, the one agy's own
 * `/logout` deletes). The name is the registry's, and is checked to be a plain target name (letters, digits and `:._-`) before it is put in an argument. The exit code is returned and nothing it prints: 0 deleted
 * it, 1 is "no such entry" (already signed out), null is "could not run". The caller asks the CLI whether it took.
 */
export async function deleteWindowsCredential(name: string, env: NodeJS.ProcessEnv = nativeCliEnvironment()): Promise<number | null> {
  if (!/^[A-Za-z0-9][A-Za-z0-9:._-]{0,63}$/.test(name)) throw new Error("Invalid credential entry name");
  return exitCodeOf(join(process.env.SystemRoot || "C:\\Windows", "System32", "cmdkey.exe"), [`/delete:${name}`], 15_000, env);
}
const NPM_CLI_TARGETS: Partial<Record<NativeCliId, readonly string[]>> = {
  codex: ["node_modules/@openai/codex/bin/codex.js"],
  "claude-code": ["node_modules/@anthropic-ai/claude-code/cli.js"],
  opencode: ["node_modules/opencode-ai/bin/opencode", "node_modules/@opencode/cli/bin/opencode.js"],
};
/** Recognize npm's known Node launcher only; never execute or interpret a .cmd file. */
export function npmCliShimTarget(id: NativeCliId, source: string): string | null {
  if (source.length > 32 * 1024 || !/\bnode(?:\.exe)?\b/i.test(source)) return null;
  const targets = NPM_CLI_TARGETS[id];
  if (!targets) return null;
  const references = [...source.matchAll(/"%dp0%[\\/]([^"\r\n]+)"/gi)];
  for (const match of references) {
    const target = match[1].replace(/\\/g, "/");
    if (targets.includes(target)) return target;
  }
  return null;
}
/**
 * Newer npm packages (Claude Code 2.1.x) ship a native executable and their `.cmd` shim runs it directly, without node.
 * Only this exact shim shape is recognized; the shim itself is never executed or interpreted.
 */
const NPM_NATIVE_TARGETS: Partial<Record<NativeCliId, { shim: string; packages: Partial<Record<string, readonly string[]>>; exe: string }>> = {
  "claude-code": {
    shim: "node_modules/@anthropic-ai/claude-code/bin/claude.exe",
    packages: { x64: ["@anthropic-ai/claude-code-win32-x64"], arm64: ["@anthropic-ai/claude-code-win32-arm64", "@anthropic-ai/claude-code-win32-x64"] },
    exe: "claude.exe",
  },
};
/** `npm i --ignore-scripts` leaves a ~500 byte placeholder at bin\claude.exe; the real binary is tens of MB. */
const NPM_NATIVE_MIN_BYTES = 1024 * 1024;
/** Claude Code's real binary is tens of MB; anything smaller is a placeholder that must never be executed. */
export function isUsableNativeBinarySize(id: NativeCliId, size: number): boolean {
  return !NPM_NATIVE_TARGETS[id] || size >= NPM_NATIVE_MIN_BYTES;
}
/** Same check on a file: a size that cannot be read (the file vanished after it was found) is not usable. */
export function isUsableNativeBinaryFile(id: NativeCliId, path: string, sizeOf: (path: string) => number): boolean {
  try { return isUsableNativeBinarySize(id, sizeOf(path)); } catch { return false; }
}
export function npmNativeShimTarget(id: NativeCliId, source: string): string | null {
  const native = NPM_NATIVE_TARGETS[id];
  if (!native || source.length > 32 * 1024) return null;
  for (const match of source.matchAll(/"%dp0%[\\/]([^"\r\n]+)"/gi)) {
    if (match[1].replace(/\\/g, "/") === native.shim) return native.shim;
  }
  return null;
}
/** The real native executable behind a recognized npm shim: the optional platform package first, then bin\claude.exe unless it is a placeholder. */
export function npmNativeExecutable(id: NativeCliId, shimDir: string, exists: (path: string) => boolean, sizeOf: (path: string) => number, arch: string = process.arch): string | null {
  const native = NPM_NATIVE_TARGETS[id];
  if (!native) return null;
  const root = win32.join(shimDir, "node_modules");
  const packageRoot = win32.join(shimDir, ...native.shim.split("/").slice(0, 3));
  const candidates: string[] = [];
  for (const pkg of native.packages[arch] ?? []) {
    const parts = pkg.split("/");
    candidates.push(win32.join(packageRoot, "node_modules", ...parts, native.exe), win32.join(root, ...parts, native.exe));
  }
  candidates.push(win32.join(shimDir, ...native.shim.split("/")));
  return candidates.find(path => exists(path) && isUsableNativeBinaryFile(id, path, sizeOf)) ?? null;
}
function isNativeFile(path: string): boolean {
  if (!validWindowsDirectory(path)) return false;
  try { return statSync(path).isFile(); } catch { return false; }
}
async function findNode(shim: string): Promise<string | null> {
  const sibling = win32.join(win32.dirname(shim), "node.exe");
  if (isNativeFile(sibling)) return sibling;
  const found = await output(join(process.env.SystemRoot || "C:\\Windows", "System32", "where.exe"), ["node.exe"]);
  const candidates = found.text.split(/\r?\n/);
  candidates.push(join(process.env.ProgramFiles || "C:\\Program Files", "nodejs", "node.exe"));
  return candidates.map(p => p.trim()).find(isNativeFile) ?? null;
}
export async function findCli(id: NativeCliId): Promise<NativeCliExecutable | null> {
  const provider = nativeProvider(id);
  // #3190 Part 3b: a CLI this Runtime installed from the dashboard (pinned to the audited version, verified before it was switched on) comes first.
  // The folder is the Runtime's own: it sets it in its process and passes it to the helpers it starts; AgEnD never names a path.
  const managedRoot = process.env[MANAGED_CLI_ROOT_ENV];
  if (managedRoot && validWindowsDirectory(managedRoot)) {
    const managed = managedCliExecutable(managedRoot, id);
    if (managed) return { path: managed.command, command: managed.command, args: managed.args };
  }
  const names = provider.binaryNames.flatMap(name => [name, ...(NPM_CLI_TARGETS[id] ? [name.replace(/\.exe$/i, ".cmd")] : [])]);
  const found = await Promise.all(names.map(name => output(join(process.env.SystemRoot || "C:\\Windows", "System32", "where.exe"), [name])));
  const candidates = found.flatMap(result => result.text.split(/\r?\n/));
  const home = homedir();
  const local = process.env.LOCALAPPDATA || join(home, "AppData", "Local");
  for (const name of names) candidates.push(join(home, ".local", "bin", name), join(process.env.APPDATA || join(home, "AppData", "Roaming"), "npm", name));
  if (id === "codex") candidates.push(
    join(local, "Programs", "OpenAI", "Codex", "bin", "codex.exe"),
    join(local, "OpenAI", "Codex", "bin", "codex.exe"),
  );
  if (id === "antigravity") candidates.push(join(local, "agy", "bin", "agy.exe"));
  if (id === "grok") candidates.push(join(home, ".grok", "bin", "grok.exe"));
  if (id === "opencode") candidates.push(join(home, ".opencode", "bin", "opencode.exe"));
  for (const candidate of candidates) {
    const p = candidate.trim();
    if (!isNativeFile(p)) continue;
    if (provider.binaryNames.some(name => win32.basename(p).toLowerCase() === name.toLowerCase())) {
      if (!isUsableNativeBinaryFile(id, p, path => statSync(path).size)) continue;
      return { path: p, command: p, args: [] };
    }
    if (/\.cmd$/i.test(p) && NPM_CLI_TARGETS[id]) {
      try {
        if (statSync(p).size > 32 * 1024) continue;
        const source = readFileSync(p, "utf8");
        if (npmNativeShimTarget(id, source)) {
          const exe = npmNativeExecutable(id, win32.dirname(p), isNativeFile, path => statSync(path).size);
          if (exe) return { path: p, command: exe, args: [] };
          continue;
        }
        const target = npmCliShimTarget(id, source);
        if (!target) continue;
        const script = win32.join(win32.dirname(p), target);
        if (!isNativeFile(script)) continue;
        const node = await findNode(p);
        if (node) return { path: p, command: node, args: [script] };
      } catch { /* An arbitrary batch wrapper is not a native Node CLI. */ }
    }
  }
  return null;
}
/**
 * Is a credential profile's directory signed in? Runs the CLI's own status command with that directory as its config home (never a login,
 * never a model request). true/false = the CLI answered; null = it could not be asked or did not say.
 */
export interface CredentialProfileAnswer { loggedIn: boolean | null; /** Masked e-mail and plan, when that answer has an account in it. */ identity?: AccountIdentity }
export async function probeCredentialProfileStatus(cli: CredentialProfileCli, directory: string, find: (id: NativeCliId) => Promise<NativeCliExecutable | null> = findCli,
  run: (executable: NativeCliExecutable, args: string[], env: NodeJS.ProcessEnv) => Promise<NativeCommandOutput> = (entry, args, env) => output(entry.command, [...entry.args, ...args], 15_000, env),
  /** The requester's live check (an install's consent and connection): asked before the CLI is looked for and again before its status program is started. */
  authorized?: () => boolean,
  /** The account's masked e-mail is read from its folder when it is signed in (a NAMED account of a CLI that keeps its sign-in in a file). The isolation probe's scratch folder never is. */
  withIdentity = true): Promise<CredentialProfileAnswer> {
  const provider = nativeProvider(cli);
  if (!isCredentialProfileCli(cli)) return { loggedIn: null };
  // A CLI that has no status command and answers with its model listing (Antigravity, `runtime.authStatus.source`): the listing's exit code and words, read by the shared parser, under the account's own launch.
  const listing = runtimeFacts(cli, "authStatus")?.source === "model-listing" ? runtimeFacts(cli, "authStatus")!.argv : null;
  if (!provider.authProbe && !listing) return { loggedIn: null };
  if (authorized && !authorized()) throw new Error("Authorization expired during CLI discovery");
  const executable = await find(cli);
  if (authorized && !authorized()) throw new Error("Authorization expired during CLI discovery");
  if (!executable) return { loggedIn: null };
  const launch = credentialProfileLaunch(nativeCliEnvironment(), cli, directory);
  if (listing) {
    // The arguments that name the account go right after the program (`agy --app_data_dir <folder> models`); the answer is asked once more when it says nothing (an empty reply), as the inventory's does.
    const args = [...launch.args, ...nativeUpdateGuard(cli), ...listing];
    let answer = await run(executable, args, launch.env);
    if (answer.ok && !answer.text.trim()) answer = await run(executable, args, launch.env);
    let loggedIn = parseNativeAuthResult(cli, answer.ok, answer.text);
    // A CLI that keeps a folder's sign-in in a file (the registry's `store`): "signed in" needs that plain file in the folder as evidence. Without it the CLI read the login from a store every folder shares (the Windows user's
    // own), which is not this account's, so the answer is "could not confirm" (never "signed in", and not "signed out" either).
    const store = credentialProfileStore(cli);
    if (loggedIn === true && store !== undefined) { try { const stat = lstatSync(join(directory, store)); if (!stat.isFile() || stat.isSymbolicLink()) loggedIn = null; } catch { loggedIn = null; } }
    // AGEND-124: the one field of the account's own token file that names the account, masked here (agy has no command that does): only for a folder the CLI just said is signed in, only when asked.
    const identity = withIdentity && loggedIn === true && store !== undefined ? readAntigravityIdentityIn(directory) : undefined;
    return { loggedIn, ...(identity ? { identity } : {}) };
  }
  const result = await run(executable, [...launch.args, ...nativeUpdateGuard(cli), ...provider.authProbe!], launch.env);
  const status = parseClaudeAuthStatus(result.text), identity = status.loggedIn === true && result.ok ? identityOf(status) : undefined;
  return { loggedIn: status.loggedIn, ...(identity ? { identity } : {}) };
}
/**
 * AGEND-124, before an Antigravity account's sign-in starts: whether the CLI really keeps a folder's sign-in in that folder. Antigravity keeps it in the Credential Manager unless the registry's `pin` makes it use the
 * folder's file, and the Credential Manager's entry is one for every folder: a sign-in run where the pin does not hold REPLACES the Windows user's own login. So the CLI is asked (`agy --app_data_dir <scratch> models`,
 * with the pin) about a SCRATCH folder that is empty by construction, under the Runtime's own folder (so a relative path to the CLI's home exists exactly when it does for an account's folder): only "signed out" proves the
 * pin holds. Never the account's own folder (one that has a token file already proves nothing about a CLI that stopped honouring the pin). An answer that could not be read is asked once more; still none: not proven.
 * The scratch folder is removed when the probe is over, and again a moment later (the CLI's background updater can write into it after it has answered).
 */
export async function probeCredentialIsolation(cli: CredentialProfileCli, scratchRoot: string, find?: Parameters<typeof probeCredentialProfileStatus>[2], run?: Parameters<typeof probeCredentialProfileStatus>[3],
  authorized?: () => boolean): Promise<boolean> {
  let scratch: string | null = null;
  try {
    mkdirSync(scratchRoot, { recursive: true, mode: 0o700 });
    scratch = mkdtempSync(join(scratchRoot, ".isolation-"));
    // The scratch folder is not an account: it never has its identity read (`withIdentity` false).
    let answer = (await probeCredentialProfileStatus(cli, scratch, find, run, authorized, false)).loggedIn;
    if (answer === null) answer = (await probeCredentialProfileStatus(cli, scratch, find, run, authorized, false)).loggedIn;
    return answer === false;
  } catch { return false; }
  finally {
    if (scratch) {
      const folder = scratch, remove = (): void => { try { rmSync(folder, { recursive: true, force: true }); } catch { /* a scratch folder */ } };
      remove();
      const again = setTimeout(remove, 3_000); again.unref?.();
    }
  }
}
/** Signed in or not, nothing else (the launch gate). */
export async function probeCredentialProfileLogin(cli: CredentialProfileCli, directory: string, find?: Parameters<typeof probeCredentialProfileStatus>[2], run?: Parameters<typeof probeCredentialProfileStatus>[3]): Promise<boolean | null> {
  return (await probeCredentialProfileStatus(cli, directory, find, run)).loggedIn;
}
const HELP_PROBES: Record<NativeCliId, { args: string[]; required: string[] }> = {
  codex: { args: ["exec", "--help"], required: ["--json", "--sandbox"] },
  "claude-code": { args: ["--help"], required: ["--print", "--output-format", "--input-format", "--permission-prompts"] },
  antigravity: { args: ["--help"], required: ["--input-format", "stream-json", "--output-format", "--conversation"] },
  grok: { args: ["--help"], required: ["--prompt-file", "--output-format", "streaming-json", "--resume"] },
  "kiro-cli": { args: ["chat", "--help"], required: ["--no-interactive", "--output-format", "stream-json", "--resume-id"] },
  opencode: { args: ["run", "--help"], required: ["--format", "json", "--session", "--dir"] },
  muse: { args: ["exec", "--help"], required: ["--json", "--prompt-file", "--session-id"] },
};
/** Explicit models-only discovery, on the execution computer. No launch/config writes or caller-supplied URL/argv. */
export async function refreshNativeModels(options: {
  cli: string; directory?: string; home?: string; environment?: NodeJS.ProcessEnv; authorized?: () => boolean;
  find?: (id: NativeCliId) => Promise<NativeCliExecutable | null>;
  run?: (entry: NativeCliExecutable, args: string[], env: NodeJS.ProcessEnv) => Promise<NativeCommandOutput>;
  request?: typeof fetch;
}): Promise<{ models: NativeModelOption[]; source: string }> {
  const check = (): void => { if (options.authorized && !options.authorized()) throw Error("Model discovery authorization expired"); };
  const env = options.environment ?? nativeCliEnvironment(), home = options.home ?? homedir();
  check();
  if (options.cli === "codex") {
    if (options.directory) throw Error("Native Codex named accounts are not supported");
    const directory = nativeEnvironmentValue(env, "CODEX_HOME") || join(home, ".codex");
    // Native custom providers/profiles have no proved discovery adapter. Never borrow the ambient OpenAI list.
    let toml = "";
    try { toml = readFileSync(join(directory, "config.toml"), "utf8"); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw Error("Model discovery config is unavailable"); }
    const auth = (): string | null => { try { return readFileSync(join(directory,"auth.json"),"utf8"); } catch(e) { if((e as NodeJS.ErrnoException).code==="ENOENT")return null; throw Error("Model discovery account is unavailable"); } };
    const account=auth();
    const root = toml.split(/^\s*\[/m)[0];
    if (/^\s*(?:profile|"profile"|'profile')\s*=/m.test(root) || /^\s*(?:model_provider|"model_provider"|'model_provider')\s*=/m.test(root) && !/^\s*(?:model_provider|"model_provider"|'model_provider')\s*=\s*["']openai["']\s*(?:#.*)?$/m.test(root)) throw Error("Native model provider could not be proved");
    const entry = await (options.find ?? findCli)("codex"); check();
    if (!entry) throw Error("Codex is not installed on this computer");
    const selected = { ...env };
    for (const key of Object.keys(selected)) if (key.toUpperCase() === "CODEX_HOME") delete selected[key];
    selected.CODEX_HOME = directory;
    const args = [...nativeUpdateGuard("codex"), "debug", "models"];
    const result = await (options.run ? options.run(entry, args, selected) : output(entry.command, [...entry.args, ...args], 15_000, selected)); check();
    if (!result.ok) throw Error("Model discovery failed");
    let now="";try{now=readFileSync(join(directory,"config.toml"),"utf8");}catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw Error("Model config is unavailable");}
    if(now!==toml || auth()!==account)throw Error("Model discovery account or provider changed");
    const models = readNativeCodexModels(home, selected); if (!models.length) throw Error("Model discovery returned no models");
    return { models: boundNativeModelOptions(models), source: "cli-list" };
  }
  if (options.cli !== "claude-code") {
    if (options.directory || !isNativeProviderId(options.cli) || !nativeProvider(options.cli).modelProbe) throw Error("Model refresh is not supported by this native CLI");
    const cli=options.cli,entry=await (options.find??findCli)(cli);check();if(!entry)throw Error("The selected CLI is not installed");
    const args=[...nativeUpdateGuard(cli),...nativeProvider(cli).modelProbe!];
    const result=await (options.run?options.run(entry,args,env):output(entry.command,[...entry.args,...args],15_000,env));check();
    if(!result.ok)throw Error("Model discovery failed");
    const models=boundNativeModelOptions(parseNativeModels(cli,result.text));if(!models.length)throw Error("Model discovery returned no models");
    return {models,source:"cli-list"};
  }
  const directory = options.directory || nativeEnvironmentValue(env, "CLAUDE_CONFIG_DIR") || join(home, ".claude");
  // A selected profile never falls back to another home, keychain, API key or ambient account.
  const file = join(directory, ".credentials.json"), info = lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024) throw Error("Model discovery credentials are unavailable");
  const credentialText = readFileSync(file,"utf8"), credentials = JSON.parse(credentialText);
  const token = credentials?.claudeAiOauth?.accessToken;
  if (typeof token !== "string" || !token || token.length > 16_384) throw Error("Model discovery credentials are unavailable");
  check();
  const response = await (options.request ?? fetch)("https://api.anthropic.com/v1/models?limit=100", {
    headers: { Authorization: `Bearer ${token}`, "anthropic-version": "2023-06-01", "anthropic-beta": "oauth-2025-04-20" },
    redirect: "error", signal: AbortSignal.timeout(8_000),
  }); check();
  if (!response.ok) throw Error("Model discovery failed");
  const reader = response.body?.getReader(); if (!reader) throw Error("Model discovery returned no data");
  let text = "", size = 0;
  try { for (;;) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.length; if (size > 128 * 1024) throw Error("Model discovery response is too large"); text += new TextDecoder().decode(chunk.value,{stream:true}); } }
  finally { await reader.cancel().catch(() => {}); }
  check();
  if (readFileSync(file,"utf8") !== credentialText || lstatSync(file).isSymbolicLink()) throw Error("Model discovery account changed");
  const raw = JSON.parse(text);
  if (!Array.isArray(raw?.data)) throw Error("Model discovery returned no models");
  const models: NativeModelOption[] = [];
  for (const row of raw.data.slice(0,100)) {
    if (!row || typeof row.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/.test(row.id)) continue;
    models.push({ id:row.id, name:row.id, ...(typeof row.display_name === "string" ? {description:row.display_name.slice(0,200)} : {}) });
  }
  if (!models.length) throw Error("Model discovery returned no models");
  return { models:boundNativeModelOptions([...models,...claudeDocumentedModels(null).map(m => ({id:m.id,name:m.label}))]), source:"account-api" };
}

export interface NativeProbeOptions {
  find?: (id: NativeCliId) => Promise<NativeCliExecutable | null>;
  run?: (executable: NativeCliExecutable, args: string[]) => Promise<NativeCommandOutput>;
  /** Tests can isolate account metadata without reading the user's real cache. */
  readModels?: (id: NativeCliId, version: string | null) => NativeModelOption[];
}

/** Read Codex's own account-aware cache. No token files or model requests are involved. */
export function readNativeCodexModels(home = homedir(), env = nativeCliEnvironment()): NativeModelOption[] {
  try {
    const configured = nativeEnvironmentValue(env, "CODEX_HOME");
    const modelHome = configured && validWindowsDirectory(configured) ? configured : join(home, ".codex");
    const path = join(modelHome, "models_cache.json");
    if (statSync(path).size > 4 * 1024 * 1024) return [];
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { models?: unknown }).models)) return [];
    const models = new Map<string, NativeModelOption>();
    for (const value of (parsed as { models: unknown[] }).models) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const item = value as Record<string, unknown>;
      if (item.visibility === "hide" || item.hidden === true || typeof item.slug !== "string") continue;
      const id = item.slug.trim();
      if (models.has(id) || !id || id.length > 160 || !/^[A-Za-z0-9][A-Za-z0-9._:/[\]\-]*$/.test(id)) continue;
      const name = typeof item.display_name === "string" ? item.display_name.trim().slice(0, 200) : "";
      const description = typeof item.description === "string" ? item.description.trim().slice(0, 300) : "";
      models.set(id, { id, ...(name ? { name } : {}), ...(description ? { description } : {}) });
      if (models.size >= 200) break;
    }
    return [...models.values()];
  } catch { return []; }
}

function readNativeModels(id: NativeCliId, version: string | null): NativeModelOption[] {
  if (id === "codex") return readNativeCodexModels();
  if (id === "claude-code") return claudeDocumentedModels(version).map(({ id, label, description }) => ({ id, name: label, ...(description ? { description } : {}) }));
  return [];
}
/** #2078: muse's launcher writes its version beside itself (`.muse-version`); read it, never start muse to ask. */
function staticMuseVersion(launcher: string): string | null {
  try {
    const text = readFileSync(join(dirname(launcher), ".muse-version"), "utf8").trim();
    return /^[0-9][0-9A-Za-z.+-]{0,40}$/.test(text) ? text : null;
  } catch { return null; }
}
async function probeNativeCli(id: NativeCliId, options: NativeProbeOptions, includeModels: boolean): Promise<{ row: NativeCliRow; executable: NativeCliExecutable | null }> {
  const provider = nativeProvider(id);
  const executable = await (options.find ?? findCli)(id);
  const base = { id, supports: { ...provider.supports,mcp:false }, readOnlySupport: provider.readOnlySupport, permissionNote: provider.permissionNote, models: [] as NativeModelOption[] };
  if (!executable) return { executable, row: { ...base, path: null, version: null, authenticated: null, runnable: false, reason: `${provider.name} CLI is not installed on Windows` } };
  const run = options.run ?? ((entry: NativeCliExecutable, args: string[]) => output(entry.command, [...entry.args, ...args]));
  const helpProbe = HELP_PROBES[id];
  // Separate providers are discovered concurrently. Calls to the same native binary
  // must be sequential: concurrent Windows startup/status calls can exit zero with
  // empty redirected streams (observed with Codex, agy and Grok).
  // Every probe argv carries the CLI's own "do not update" switch (M-2239 P1-2).
  const nonempty = async (rest: string[]): Promise<NativeCommandOutput> => {
    const args = [...nativeUpdateGuard(id), ...rest];
    const result = await run(executable, args);
    return result.ok && !result.text.trim() ? run(executable, args) : result;
  };
  // #2078: muse is never started for a probe — `muse --version` once updated its own launcher. Its version is read from
  // the file beside the launcher; its headless protocol is taken on trust (a task that fails says so).
  if (id === "muse") {
    const version = staticMuseVersion(executable.path);
    return { executable, row: { ...base, path: executable.path, version, authenticated: null, runnable: provider.supports.execution,
      supports: { ...base.supports }, models: [], modelsSource: "unavailable",
      ...(version ? {} : { reason: "Muse is never started for detection; its version file was not found" }) } };
  }
  const version = await nonempty(["--version"]);
  const help = await nonempty(helpProbe.args);
  const auth = provider.authProbe ? await nonempty([...provider.authProbe]) : null;
  const listing = includeModels && provider.modelProbe ? await nonempty([...provider.modelProbe]) : null;
  // A CLI whose registry `authStatus.source` is `model-listing` (Antigravity) has no status command, but the model listing it is asked for anyway says whether it is signed in: "Please sign in to view available models" with a failing exit. Read from that
  // one answer (no extra process); a listing that fails for any other reason (the network) says nothing, and is never "signed out".
  const authenticated = auth ? parseNativeAuthResult(id, auth.ok, auth.text) : runtimeFacts(id, "authStatus")?.source === "model-listing" && listing ? parseNativeAuthResult(id, listing.ok, listing.text) : null;
  // The same answer says which account it is (Claude Code only; an API key or a signed-out answer has none). Masked here, before it is stored or sent.
  const identity = id === "claude-code" && auth?.ok && authenticated === true ? identityOf(parseClaudeAuthStatus(auth.text)) : undefined;
  const compatible = help.ok && helpProbe.required.every(flag => help.text.includes(flag));
  const readOnlySupport = base.readOnlySupport && (id !== "claude-code" || ["--tools", "--strict-mcp-config", "--mcp-config"].every(flag => help.text.includes(flag)));
  const versionAvailable = version.ok && Boolean(version.text.trim());
  const versionText = versionAvailable ? version.text.split(/\r?\n/)[0].slice(0, 120) : null;
  const models = boundNativeModelOptions(!includeModels ? [] : listing?.ok ? parseNativeModels(id, listing.text) : (options.readModels ?? readNativeModels)(id, versionText));
  const reason = !versionAvailable ? "The Windows CLI version check returned no usable output" : !help.ok || !help.text.trim() ? "The Windows CLI help check returned no usable output" : !compatible ? "Update this Windows CLI: the installed version lacks the required headless JSON protocol"
    : !provider.supports.execution ? provider.reason : authenticated === false ? SIGN_IN_FIRST : undefined;
  const row: NativeCliRow = {
    ...base, path: executable.path, version: versionText,
    authenticated, readOnlySupport, supports: { ...base.supports, execution: base.supports.execution && compatible && versionAvailable,
      mcp:provider.supports.mcp === true && compatible && versionAvailable && (id === "codex" ? help.text.includes("--config") : ["--mcp-config","--strict-mcp-config","--allowedTools"].every(flag => help.text.includes(flag))) },
    models, modelsSource: models.length ? id === "codex" ? "cli-cache" : id === "claude-code" ? "official-catalog" : "cli-list" : "unavailable",
    ...(identity ? { identity } : {}),
    runnable: versionAvailable && compatible && provider.supports.execution && authenticated !== false,
    ...(reason ? { reason } : {}),
  };
  return { row, executable };
}
export async function probeNativeClis(options: NativeProbeOptions = {}): Promise<{ clis: NativeCliRow[]; home: string; hostname: string }> {
  const results = await Promise.all(NATIVE_CLI_IDS.map(id => probeNativeCli(id, options, true)));
  return { clis: results.map(result => result.row), home: homedir(), hostname: hostname() };
}

async function workerMain(): Promise<void> {
  const emit = (value: unknown): void => { process.stdout.write(`${JSON.stringify(value)}\n`); };
  const finish = (value: unknown, code: number): void => { process.stdout.write(`${JSON.stringify(value)}\n`, () => process.exit(code)); };
  if (process.platform !== "win32") { emit({ type: "error", message: "The native CLI worker must run on Windows Node" }); return; }
  process.chdir(homedir());
  let first = true, child: ChildProcess | null = null, stopping = false, killing = false, completed = false, disconnected = false, bytes = 0;
  const stop = (): void => {
    stopping = true;
    if (killing || !child?.pid || child.exitCode !== null || child.signalCode !== null) return;
    killing = true;
    // Only the process created by this worker; never process-name matching or a shared adb/server PID.
    const kill = spawn(join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe"), ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    kill.on("error", () => { child?.kill(); });
  };
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.on("close", () => { disconnected = true; if (!completed) stop(); });
  const timeout = setTimeout(() => { emit({ type: "error", message: "Task exceeded the five-minute preview limit" }); stop(); }, 300_000);
  timeout.unref();
  lines.on("line", (line) => {
    if (!first) { if (line === '{"cancel":true}') stop(); return; }
    first = false;
    void (async () => {
      if (Buffer.byteLength(line) > 80_000) throw new Error("Request too large");
      const request = JSON.parse(line);
      if (request.op === "models") {
        if (Object.keys(request).some(k => !["op","cli"].includes(k)) || !isNativeProviderId(request.cli)) throw Error("Invalid model refresh request");
        const result = await refreshNativeModels({cli:request.cli,authorized:()=>!disconnected&&!stopping}); completed=true; finish({type:"models",...result},0); return;
      }
      if (request.op === "probe") { const result = await probeNativeClis(); completed = true; finish({ type: "probe", ...result }, 0); return; }
      if (request.op === "workspace") {
        if (Object.keys(request).some(key => !["op", "agentId"].includes(key)) || !validWindowsAgentId(request.agentId)) throw new Error("Invalid Windows workspace request");
        if (disconnected || stopping) throw new Error("Windows workspace request was cancelled");
        const cwd = prepareNativeWorkspace(request.agentId);
        completed = true; clearTimeout(timeout); finish({ type: "workspace", agentId: request.agentId, cwd }, 0); return;
      }
      if (request.op !== "run") throw new Error("Unknown Windows worker operation");
      const input = validateNativeTask(request.task);
      const mcp = request.mcp === undefined ? undefined : validateNativeMcpConnection(request.mcp);
      // Set only by this computer's own Runtime after it turned a profile NAME into a folder under its profile root; AgEnD never sends it.
      let credentialHome: string | undefined;
      if (request.credentialHome !== undefined) {
        if (!isCredentialProfileCli(input.cli) || !validWindowsDirectory(request.credentialHome)) throw new Error("Invalid credential profile folder");
        if (!existsSync(request.credentialHome) || !statSync(request.credentialHome).isDirectory()) throw new Error("The credential profile folder does not exist on this computer");
        credentialHome = request.credentialHome;
      }
      if (request.context !== undefined && (typeof request.context !== "string" || request.context.length > 2000 || request.context.includes("\0"))) throw new Error("Invalid native task context");
      if (!existsSync(input.cwd) || !statSync(input.cwd).isDirectory()) throw new Error("Windows working directory does not exist");
      // M-2239 P1-2: a task starts no probe (no --version, --help, sign-in or model listing): AgEnD's bridge already
      // checked this CLI against the administrator's last detection. Here only: the CLI is still installed.
      const executable = await findCli(input.cli);
      if (!executable) throw new Error(`${nativeProvider(input.cli).name} CLI is not installed on Windows`);
      if (disconnected || stopping) { completed = true; finish({ type: "finished", code: null, cancelled: true }, 1); return; }
      let tempDirectory: string | undefined, promptFile: string | undefined, connectionFile: string | undefined, mcpConfigFile: string | undefined;
      const createdFiles:string[]=[];
      let code: number | null = null;
      const prompt = request.context ? `${input.prompt}\n\nAgEnD task context:\n${request.context}` : input.prompt;
      try {
        if (nativeProvider(input.cli).promptTransport === "file" || mcp) tempDirectory = mkdtempSync(join(tmpdir(), "agend-windows-cli-"));
        if (nativeProvider(input.cli).promptTransport === "file") {
          promptFile = join(tempDirectory!, "prompt.txt");
          writeFileSync(promptFile, prompt, { encoding: "utf8", mode: 0o600, flag: "wx" });
          createdFiles.push(promptFile);
        }
        let launch:NativeMcpLaunch|undefined;
        if (mcp) {
          connectionFile = join(tempDirectory!,"connection.json");
          mcpConfigFile = join(tempDirectory!,"mcp.json");
          launch = {nodePath:process.execPath,helperPath:join(dirname(fileURLToPath(import.meta.url)),"windows-native-mcp.js"),connectionPath:connectionFile,configPath:mcpConfigFile,tools:mcp.tools,serverName:`agend_native_${randomBytes(6).toString("hex")}`};
          writeFileSync(connectionFile,JSON.stringify(mcp),{encoding:"utf8",mode:0o600,flag:"wx"});
          createdFiles.push(connectionFile);
          writeFileSync(mcpConfigFile,JSON.stringify(nativeMcpServerConfig(launch)),{encoding:"utf8",mode:0o600,flag:"wx"});
          createdFiles.push(mcpConfigFile);
        }
        const invocation = buildNativeInvocation({...input,prompt}, { resumeSessionId: request.resumeSessionId, promptFile,mcp:launch });
        // A named account's launch: its variable (Claude Code), or the pin and the folder argument that go right after the program (Antigravity).
        const profile = credentialHome ? credentialProfileLaunch(nativeCliEnvironment(), input.cli, credentialHome) : { env: nativeCliEnvironment(), args: [] as string[] };
        child = spawn(executable.command, [...executable.args, ...profile.args, ...invocation.args], { cwd: input.cwd, env: { ...profile.env, ...invocation.env }, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
        child.stdin!.on("error", () => stop());
        child.stdout!.on("error", () => stop());
        child.stderr!.on("error", () => stop());
        const bounded = (type: string, chunk: string): void => {
          bytes += Buffer.byteLength(chunk);
          if (bytes > 1024 * 1024) { if (!stopping) emit({ type: "error", message: "Task output exceeded the preview limit" }); stop(); }
          else emit({ type, text: chunk });
        };
        child.stdout!.setEncoding("utf8").on("data", c => bounded("stdout", c));
        child.stderr!.setEncoding("utf8").on("data", c => bounded("stderr", c));
        child.on("error", e => emit({ type: "error", message: e.message }));
        child.on("spawn", () => { emit({ type: "started", executable: executable.path, cwd: input.cwd }); if (stopping || disconnected) stop(); });
        const closed = new Promise<number | null>(done => child!.on("close", exitCode => { completed = true; clearTimeout(timeout); done(exitCode); }));
        child.stdin!.end(invocation.stdin, "utf8");
        code = await closed;
      } finally {
        // Only our exact prompt and empty directory; never recursively remove CLI-created files.
        for(const path of createdFiles) { try { unlinkSync(path); } catch { /* already removed or locked */ } }
        if (tempDirectory) { try { rmdirSync(tempDirectory); } catch { /* leave unexpected files intact */ } }
      }
      finish({ type: "finished", code, cancelled: stopping }, code === 0 && !stopping ? 0 : 1);
    })().catch(error => {
      const message = error instanceof Error ? error.message : "Worker failed";
      if (child?.pid) { emit({ type: "error", message }); stop(); }
      else { completed = true; finish({ type: "error", terminal: true, message }, 1); }
    });
  });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void workerMain();
