/** Runs on Windows Node, including when its parent is AgEnD inside WSL.
 * Built-ins only: this file must not load AgEnD's Linux native dependencies.
 * One JSON request, then optional cancellation, over stdin; JSON events over stdout.
 */
import { execFile, spawn } from "./child-process.js";
import type { ChildProcess } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve, win32 } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import { nativeUpdateGuard, boundNativeModelOptions, buildNativeInvocation, isNativeProviderId, nativeMcpServerConfig, nativeProvider, NATIVE_PROVIDER_IDS, parseNativeAuthResult, parseNativeModels, validateNativeMcpConnection, validateNativeModel, type NativeMcpLaunch, type NativeModelOption, type NativeProviderDescriptor, type NativeProviderId } from "./windows-cli-providers.js";
import { claudeDocumentedModels } from "./model-catalog-defaults.js";

const exec = promisify(execFile);
export const NATIVE_CLI_IDS = NATIVE_PROVIDER_IDS;
export type NativeCliId = NativeProviderId;
export interface NativeCliRow {
  id: NativeCliId; path: string | null; version: string | null; authenticated: boolean | null; runnable: boolean;
  supports: NativeProviderDescriptor["supports"]; readOnlySupport: boolean;
  permissionNote: string; models: NativeModelOption[]; reason?: string;
  modelsSource?: "cli-cache" | "official-catalog" | "cli-list" | "unavailable";
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
/** A CLI's own config directory: kept when it is the Windows user's (a drive path), never a WSL path. */
const NATIVE_ENV_WINDOWS_PATH = new Set(["CODEX_HOME", "CLAUDE_CONFIG_DIR", "KIRO_HOME", "GEMINI_HOME", "GROK_HOME", "OPENCODE_CONFIG_DIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"]);
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
async function output(file: string, args: string[], timeout = 5000): Promise<NativeCommandOutput> {
  try {
    const r = await exec(file, args, { env: nativeCliEnvironment(), encoding: "utf8", timeout, maxBuffer: 64 * 1024, windowsHide: true, shell: false });
    return { ok: true, text: `${r.stdout}\n${r.stderr}`.trim() };
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string };
    return { ok: false, text: `${e.stdout ?? ""}\n${e.stderr ?? ""}`.trim() };
  }
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
    if (provider.binaryNames.some(name => win32.basename(p).toLowerCase() === name.toLowerCase())) return { path: p, command: p, args: [] };
    if (/\.cmd$/i.test(p) && NPM_CLI_TARGETS[id]) {
      try {
        if (statSync(p).size > 32 * 1024) continue;
        const target = npmCliShimTarget(id, readFileSync(p, "utf8"));
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
const HELP_PROBES: Record<NativeCliId, { args: string[]; required: string[] }> = {
  codex: { args: ["exec", "--help"], required: ["--json", "--sandbox"] },
  "claude-code": { args: ["--help"], required: ["--print", "--output-format", "--input-format", "--permission-prompts"] },
  antigravity: { args: ["--help"], required: ["--input-format", "stream-json", "--output-format", "--conversation"] },
  grok: { args: ["--help"], required: ["--prompt-file", "--output-format", "streaming-json", "--resume"] },
  "kiro-cli": { args: ["chat", "--help"], required: ["--no-interactive", "--output-format", "stream-json", "--resume-id"] },
  opencode: { args: ["run", "--help"], required: ["--format", "json", "--session", "--dir"] },
  muse: { args: ["exec", "--help"], required: ["--json", "--prompt-file", "--session-id"] },
};
export interface NativeProbeOptions {
  find?: (id: NativeCliId) => Promise<NativeCliExecutable | null>;
  run?: (executable: NativeCliExecutable, args: string[]) => Promise<NativeCommandOutput>;
  /** Tests can isolate account metadata without reading the user's real cache. */
  readModels?: (id: NativeCliId, version: string | null) => NativeModelOption[];
}

/** Read Codex's own account-aware cache. No token files or model requests are involved. */
export function readNativeCodexModels(home = homedir(), env = nativeCliEnvironment()): NativeModelOption[] {
  const modelHome = env.CODEX_HOME && validWindowsDirectory(env.CODEX_HOME) ? env.CODEX_HOME : join(home, ".codex");
  try {
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
  const authenticated = auth ? parseNativeAuthResult(id, auth.ok, auth.text) : null;
  const compatible = help.ok && helpProbe.required.every(flag => help.text.includes(flag));
  const readOnlySupport = base.readOnlySupport && (id !== "claude-code" || ["--tools", "--strict-mcp-config", "--mcp-config"].every(flag => help.text.includes(flag)));
  const versionAvailable = version.ok && Boolean(version.text.trim());
  const versionText = versionAvailable ? version.text.split(/\r?\n/)[0].slice(0, 120) : null;
  const models = boundNativeModelOptions(!includeModels ? [] : listing?.ok ? parseNativeModels(id, listing.text) : (options.readModels ?? readNativeModels)(id, versionText));
  const reason = !versionAvailable ? "The Windows CLI version check returned no usable output" : !help.ok || !help.text.trim() ? "The Windows CLI help check returned no usable output" : !compatible ? "Update this Windows CLI: the installed version lacks the required headless JSON protocol"
    : !provider.supports.execution ? provider.reason : authenticated === false ? "Sign in to this Windows CLI before running a task" : undefined;
  const row: NativeCliRow = {
    ...base, path: executable.path, version: versionText,
    authenticated, readOnlySupport, supports: { ...base.supports, execution: base.supports.execution && compatible && versionAvailable,
      mcp:provider.supports.mcp === true && compatible && versionAvailable && (id === "codex" ? help.text.includes("--config") : ["--mcp-config","--strict-mcp-config","--allowedTools"].every(flag => help.text.includes(flag))) },
    models, modelsSource: models.length ? id === "codex" ? "cli-cache" : id === "claude-code" ? "official-catalog" : "cli-list" : "unavailable",
    runnable: versionAvailable && compatible && provider.supports.execution && authenticated !== false,
    ...(reason ? { reason } : {}),
  };
  return { row, executable };
}
export async function probeNativeClis(options: NativeProbeOptions = {}): Promise<{ clis: NativeCliRow[]; home: string }> {
  const results = await Promise.all(NATIVE_CLI_IDS.map(id => probeNativeCli(id, options, true)));
  return { clis: results.map(result => result.row), home: homedir() };
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
        child = spawn(executable.command, [...executable.args, ...invocation.args], { cwd: input.cwd, env: { ...nativeCliEnvironment(), ...invocation.env }, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
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
