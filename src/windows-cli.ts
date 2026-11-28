import {nativeExecInputRequestDigest,validateNativeExecInputClaim,validateNativeExecInputProof,type NativeExecInputClaim,type NativeExecInputProof} from "./native-exec-input.js";
/** Opt-in, single-task Windows CLI bridge. The existing Linux fleet remains unchanged. */
import { localWindowsCliEnabled, remoteRuntimeEnabled } from "./runtime-switches.js";
import { spawn, execFile } from "./child-process.js";
import { detectWsl, realHost, windowsReach, type WindowsReachProblem, type WslHost } from "./wsl-host.js";
import type { ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync } from "node:fs";
import { atomicWriteFileSync } from "./atomic-write.js";
import { dirname, join, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { validWindowsAgentId, validWindowsDirectory, validateNativeTask, withAuthenticated, type NativeCliRow, type NativeTaskInput } from "./windows-cli-worker.js";
import { isCredentialProfileCli, type CredentialProfileReport } from "./runtime-credential-profiles.js";
import { nativeProvider, isNativeProviderId, parseNativeProviderEvent, validateNativeMcpConnection, type NativeMcpConnection, type NativeProviderId } from "./windows-cli-providers.js";
import { assertPersonalTask, personalTaskFailure, type PersonalTaskFailure } from "./runtime-personal-protocol.js";

const exec = promisify(execFile);
/** `probedAt`: when an administrator last ran detection (ms), null when it never ran — then `clis` is empty. */
export interface WindowsCliProbe {
  clis: NativeCliRow[]; home: string; probedAt: number | null; hostname?: string;
  personalFolder?: string;
  /** Named CLI sign-ins kept on that computer: names and a signed-in yes/no only. Reported by a Runtime; absent for an older one. */
  credentialProfiles?: CredentialProfileReport;
}
/**
 * alpha.2 (#3004, dev-claude's rig): whether a runner's CLI inventory is a real report. A just-paired runner's hello
 * carries a placeholder — `{ clis: [], home: "", probedAt: null }` — that says nothing about what is installed: it is
 * as missing as no inventory at all, and the coordinator asks that runner for its report.
 */
export function inventoryProbed(probe: WindowsCliProbe | null | undefined): boolean {
  return !!probe && (typeof probe.probedAt === "number" || probe.clis.length > 0);
}
export interface WindowsCliTask {
  id: string; cli: NativeProviderId; model?: string; cwd: string; sandbox: NativeTaskInput["sandbox"];
  status: "starting" | "running" | "cancelling" | "completed" | "failed" | "cancelled";
  startedAt: number; finishedAt?: number; output: string; error?: string;
  threadId?: string; outcomeConfirmed?: boolean;
  /** Owned worker input evidence, never inferred from a starting or terminal status. */
  execInputProof?: Readonly<NativeExecInputProof>;
  /** Only the dedicated personal profile supplies this field, after terminal process completion. */
  answer?: string;
  personalFailure?: PersonalTaskFailure;
}
export interface WindowsRunOptions {
  execInput?: Readonly<NativeExecInputClaim>;
  onInputWritten?(proof:Readonly<NativeExecInputProof>):void;
  personal?: true;
  answerOnly?: true;
  resumeSessionId?: string; onSettled?: (task: WindowsCliTask) => void; mcp?: NativeMcpConnection; context?: string; machineId?: string;
  /** A credential profile NAME for a paired Runtime computer. It is only a name: that computer's Runtime turns it into its own folder. */
  credentialProfile?: string;
  /** Set only by a Runtime's own bridge, after it resolved `credentialProfile` under its profile root. Never an AgEnD-side or network value. */
  credentialHome?: string;
}
/** The conversation store uses this port for both the existing local worker and paired runtimes. */
export interface WindowsCliExecutor {
  probe(options?: {force?: boolean; machineId?: string}): Promise<WindowsCliProbe>;
  prepareWorkspace(agentId: string, authorized?: () => boolean, machineId?: string): Promise<string>;
  start(value: unknown, authorized?: () => boolean, options?: WindowsRunOptions): WindowsCliTask;
  get(id: string): WindowsCliTask | null;
  list(): WindowsCliTask[];
  hasActiveTask(machineId?: string): boolean;
  cancel(id: string): WindowsCliTask;
  releaseUnknown(id: string): void;
  close(): void;
  idleForRequestContext?():boolean;
  retireForRequestContext?():void;
}
/** `cwd`: set only when this process's own working directory is gone: every Windows process then starts from it. */
export interface WindowsTransport { executable: string; args: string[]; cwd?: string }
export type WindowsLauncher = () => Promise<WindowsTransport>;
const MAX_TASKS = 20;
const TEXT_LIMIT = 64 * 1024;
/** M-2239 P1-2: the last detection, kept across restarts; never refreshed on a timer or a read. */
export const WINDOWS_CLI_INVENTORY_FILE = "windows-cli-inventory.json";
const NEVER_PROBED: WindowsCliProbe = { clis: [], home: "", probedAt: null };

/** Either Windows runtime is on (M-2255: Settings → Runtime, or its environment override): the native agent plumbing. */
export function windowsCliEnabled(): boolean { return localWindowsCliEnabled() || remoteRuntimeEnabled(); }
/** M-2255: what a local Windows operation says while "Use this PC's Windows CLIs" is off. */
export const LOCAL_WINDOWS_CLI_OFF = "This PC's Windows CLIs are turned off. Turn them on in Settings → Runtime.";
/**
 * M-2255: the one place a local Windows process starts from (detection, a workspace, a task): it asks the switch each
 * time, so turning "Use this PC's Windows CLIs" off starts nothing more on this PC — whatever else is on.
 */
export async function switchedWindowsTransport(): Promise<WindowsTransport> {
  admitLocalWindowsCli();
  return nativeWindowsTransport();
}
/**
 * #2955 review (Prism P2): finding the transport awaits (PowerShell, wslpath), and the switch can be turned off
 * meanwhile — its close is queued after the save. So the switch is asked again synchronously right before the spawn.
 */
export function admitLocalWindowsCli(): void { if (!localWindowsCliEnabled()) throw new Error(LOCAL_WINDOWS_CLI_OFF); }
/**
 * Why this host can't start Windows programs. `code` is for the dashboard, which says what to do about it in
 * the person's language; `message` stays the English sentence for a log or a CLI. Never a raw `spawn … ENOENT`.
 */
export type WindowsBridgeProblem = WindowsReachProblem | "powershell-failed" | "node-missing" | "wslpath-failed";
export class WindowsBridgeUnavailableError extends Error {
  constructor(readonly code: WindowsBridgeProblem, message: string, options?: { cause?: unknown; detail?: string }) { super(message, options?.cause === undefined ? undefined : { cause: options.cause }); this.name = "WindowsBridgeUnavailableError"; if (options?.detail) this.detail = options.detail; }
  /** One short fact about what failed (an exit code, a timeout): never a command line or a path. */
  detail?: string;
}
export const WINDOWS_BRIDGE_MESSAGES: Record<WindowsBridgeProblem, string> = {
  "not-wsl": "This AgEnD is not running on Windows or in WSL, so this computer has no Windows CLIs to detect. Run AgEnD on Windows or in WSL, or connect a Windows computer as a Runtime (Settings → Runtime → Connect a computer).",
  "interop-off": "This WSL cannot start Windows programs (interop is off). Set `[interop] enabled=true` in /etc/wsl.conf, run `wsl --shutdown` from Windows, then open WSL again and detect again.",
  "powershell-missing": "Windows PowerShell (powershell.exe) was not found from this WSL. Check that the Windows drive is mounted at /mnt/c (`ls /mnt/c/Windows`) and that Windows' PATH is not turned off (`appendWindowsPath` in /etc/wsl.conf), then detect again.",
  "powershell-failed": "Windows PowerShell was found but could not be started. Run `powershell.exe -NoProfile -Command echo ok` in this WSL to see why, then detect again.",
  "node-missing": "Install Windows Node.js and put node.exe on Windows PATH, then detect again.",
  "wslpath-failed": "WSL could not translate the path of Windows Node.js or of AgEnD's Windows worker (wslpath failed). Run `wslpath -w ~` in this WSL to see why, then detect again.",
};
const windowsBridgeError = (code: WindowsBridgeProblem, cause?: unknown) => new WindowsBridgeUnavailableError(code, WINDOWS_BRIDGE_MESSAGES[code], cause === undefined ? undefined : { cause, ...(execFailure(cause) ? { detail: execFailure(cause) } : {}) });
/** `execFile`'s failure as a few words: it timed out, was killed, could not start (errno name), or exited with a code. */
function execFailure(error: unknown): string {
  const e = error as { killed?: boolean; signal?: string; code?: unknown } | null;
  if (!e || typeof e !== "object") return "";
  if (e.killed || e.signal) return e.signal ? `stopped (${e.signal})` : "stopped (timed out)";
  if (typeof e.code === "number") return `exit code ${e.code}`;
  return typeof e.code === "string" && /^[A-Z0-9_]{3,20}$/.test(e.code) ? e.code : "";
}

/** What the Windows side of this Linux looks like: the sync facts, plus `wslpath`'s word for the system PowerShell when they find none. */
export interface WindowsTransportDeps {
  platform: NodeJS.Platform;
  host: () => WslHost;
  /** This process's working directory, or null when it no longer exists. */
  cwd: () => string | null;
  /** Windows PowerShell's path as WSL names it, from `wslpath -u`, or null. Only asked when the usual places have none. */
  wslpath: (windowsPath: string, options: { cwd?: string }) => Promise<string | null>;
  run: (file: string, args: string[], options: { timeout: number; maxBuffer: number; encoding: "utf8"; cwd?: string }) => Promise<{ stdout: string | Buffer; stderr?: string | Buffer }>;
}
const SYSTEM_POWERSHELL_WINDOWS_PATH = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const realTransportDeps = (): WindowsTransportDeps => ({
  platform: process.platform, host: realHost,
  cwd: () => { try { return process.cwd(); } catch { return null; } },
  wslpath: async (windowsPath, options) => { try { return String((await exec("wslpath", ["-u", windowsPath], { timeout: 5000, maxBuffer: 8192, encoding: "utf8", ...options })).stdout).trim() || null; } catch { return null; } },
  run: (file, args, options) => exec(file, args, options),
});
/** `over` replaces only the facts it names (a test gives a WSL host and keeps the real `run`); with none, every fact is this host's. */
export async function nativeWindowsTransport(over: Partial<WindowsTransportDeps> = {}): Promise<WindowsTransport> {
  const deps: WindowsTransportDeps = { ...realTransportDeps(), ...over };
  const worker = join(dirname(fileURLToPath(import.meta.url)), "windows-cli-worker.js");
  if (deps.platform === "win32") return { executable: process.execPath, args: [worker] };
  if (deps.platform !== "linux") throw windowsBridgeError("not-wsl");
  // Linux is not always WSL: a container or a plain server has no /mnt/c, and spawn then says only `ENOENT` for the path.
  const host = deps.host();
  // A daemon whose own working directory was deleted (a removed checkout it was started from) cannot start a .exe, nor
  // `wslpath`: WSL cannot turn the cwd into a Windows path, and PowerShell / cmd exit 1 saying nothing. `/` always exists.
  // Every process from here on — PowerShell, both wslpath calls, and the worker itself (the transport carries it) — uses it.
  const cwd: { cwd?: string } = deps.cwd() === null ? { cwd: "/" } : {};
  let reach = windowsReach(host);
  if (!reach.ok && reach.problem !== "interop-off" && detectWsl(host).wsl) reach = windowsReach(host, await deps.wslpath(SYSTEM_POWERSHELL_WINDOWS_PATH, cwd));
  if (!reach.ok) throw windowsBridgeError(reach.problem);
  const script = '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $n = Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1; [Console]::Write($n.Source)';
  let r: Awaited<ReturnType<WindowsTransportDeps["run"]>>;
  try {
    r = await deps.run(reach.powershell, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { timeout: 8000, maxBuffer: 8192, encoding: "utf8", ...cwd });
  } catch (error) {
    // Get-Command found no node.exe (a non-zero exit with its error text); anything else is PowerShell itself failing to start or to answer.
    if (/node\.exe/i.test(String((error as { stderr?: unknown })?.stderr ?? ""))) throw windowsBridgeError("node-missing", error);
    throw windowsBridgeError("powershell-failed", error);
  }
  const node = String(r.stdout).trim();
  if (!/^[a-z]:\\.*\\node\.exe$/i.test(node) || /[\r\n\0]/.test(node)) throw windowsBridgeError("node-missing");
  let nodePath: string, workerPath: string;
  try {
    [nodePath, workerPath] = (await Promise.all([node, worker].map(p => deps.run("wslpath", [p === node ? "-u" : "-w", p], { timeout: 5000, maxBuffer: 8192, encoding: "utf8", ...cwd })))).map(out => String(out.stdout).trim()) as [string, string];
  } catch (error) {
    // Never `Command failed: wslpath -w /home/…`: that is a command line and a local path.
    throw windowsBridgeError("wslpath-failed", error);
  }
  if (!nodePath || !workerPath) throw windowsBridgeError("wslpath-failed");
  return { executable: nodePath, args: [workerPath], ...cwd };
}

export class WindowsCliBridge {
  private retired=false;
  idleForRequestContext():boolean{return this.idleForUpdate();}
  retireForRequestContext():void{if(!this.idleForUpdate())throw Error("Windows CLI workers are not physically idle");this.retired=true;this.close();}
  private requireOpen():void{if(this.retired)throw Error("Windows CLI factory is retired");}
  private tasks = new Map<string, { input: NativeTaskInput; task: WindowsCliTask; personal: boolean; answerOnly: boolean; execInput?: Readonly<NativeExecInputClaim> }>();
  private submitted = new Set<string>();
  private child: ChildProcess | null = null;
  private active: string | null = null;
  private pendingProbe: Promise<WindowsCliProbe> | null = null;
  private workerGeneration = 0;
  private readonly pendingWorkers = new Map<ChildProcess, () => void>();
  private readonly physicalWorkers = new Set<ChildProcess>();
  private cachedProbe: WindowsCliProbe | null;
  /**
   * `inventoryFile`: where the last detection is kept (absent: memory only). `admit` (M-2255, #2955 review): asked
   * synchronously immediately before each Windows process starts — after every await — and throws to refuse it; the
   * coordinator's bridge passes this PC's switch (admitLocalWindowsCli), the standalone runner passes nothing.
   */
  constructor(private readonly launcher: WindowsLauncher = nativeWindowsTransport, private readonly inventoryFile?: string,
    readonly admit?: () => void, private readonly personal = false, private readonly personalFolder?: string) {
    this.cachedProbe = inventoryFile ? readInventory(inventoryFile) : null;
  }

  list(): WindowsCliTask[] { return [...this.tasks.values()].map(v => visible(v.task)).reverse(); }
  hasActiveTask(): boolean { return this.active !== null; }
  /** A terminal snapshot or rejected request alone is not proof that its worker has physically closed. */
  idleForUpdate(): boolean { return this.active === null && !this.pendingProbe && this.pendingWorkers.size === 0 && this.physicalWorkers.size === 0; }
  get(id: string): WindowsCliTask | null { const task = this.tasks.get(id)?.task; return task ? visible(task) : null; }
  /**
   * M-2239 P1-2: the last detection, as it was — starting nothing. Only `force` (an administrator's explicit "Detect
   * again") starts the Windows CLIs, once each, with their own "do not update" switches. Never on a timer or a read.
   * `authorized` (the requester's live check) is asked again after the Windows transport is found and before the worker
   * starts, as for a workspace or a task (#2937 review): authority revoked meanwhile starts nothing.
   */
  async probe(options: { force?: boolean } = {}, authorized: () => boolean = () => true): Promise<WindowsCliProbe> {
    this.requireOpen();
    if (!options.force) return structuredClone(this.pendingProbe ? await this.pendingProbe : this.cachedProbe ?? NEVER_PROBED);
    this.pendingProbe ??= this.doProbe(authorized).then(value => {
      this.cachedProbe = structuredClone(value);
      if (this.inventoryFile) writeInventory(this.inventoryFile, value);
      return value;
    }).finally(() => { this.pendingProbe = null; });
    // Neither callers nor another request may mutate a cached/pending result.
    return structuredClone(await this.pendingProbe);
  }
  /**
   * AGEND-113: a sign-in check that was just asked of this computer (`agy models` by its exit code, after a sign-in made from the dashboard) is the newest word on that CLI's login, so the last
   * detection's row says it from now on, in memory and in the file: a Runtime that reports its cached inventory again (a reconnect, another account's change) must not take the dashboard back
   * to what was true before the sign-in. A detection (Detect again) still overrides it. A CLI that was never detected has no row to correct, and the same answer changes nothing.
   */
  noteAuthenticated(id: string, authenticated: boolean): void {
    const probe = this.cachedProbe;
    const at = probe ? probe.clis.findIndex(row => row.id === id) : -1;
    if (!probe || at < 0 || probe.clis[at]!.authenticated === authenticated) return;
    const clis = probe.clis.slice(); clis[at] = withAuthenticated(clis[at]!, authenticated);
    this.cachedProbe = { ...probe, clis };
    if (this.inventoryFile) writeInventory(this.inventoryFile, this.cachedProbe);
  }
  async prepareWorkspace(agentId: string, authorized: () => boolean = () => true): Promise<string> {
    this.requireOpen();
    if (!validWindowsAgentId(agentId)) throw new Error("Invalid Windows agent id");
    const value = await this.workerResult({ op: "workspace", agentId }, 15_000, authorized);
    if (value.type !== "workspace" || value.agentId !== agentId || !validWindowsDirectory(value.cwd)
      || win32.basename(value.cwd).toLowerCase() !== agentId.toLowerCase()
      || win32.basename(win32.dirname(value.cwd)).toLowerCase() !== "workspaces"
      || win32.basename(win32.dirname(win32.dirname(value.cwd))).toLowerCase() !== ".agend") throw new Error(String(value.message || "Invalid Windows workspace response"));
    if (!authorized()) throw new Error("Authorization expired while creating the Windows workspace");
    return value.cwd;
  }
  async refreshModels(cli: string, authorized: () => boolean = () => true): Promise<{models:import("./windows-cli-providers.js").NativeModelOption[];source:string}> {
    if (!isNativeProviderId(cli)) throw Error("Model refresh is not supported by this Windows CLI");
    const value = await this.workerResult({op:"models",cli},25_000,authorized);
    if (!authorized() || value.type !== "models" || !Array.isArray(value.models)) throw Error("Windows model refresh failed");
    return {models:value.models as import("./windows-cli-providers.js").NativeModelOption[],source:String(value.source)};
  }
  private async doProbe(authorized: () => boolean): Promise<WindowsCliProbe> {
    if(this.personal&&!validWindowsDirectory(this.personalFolder))throw Error("Personal Runtime detection needs its local folder binding");
    const value = await this.workerResult({ op: "probe", ...(this.personal ? { personal: true as const,folder:this.personalFolder } : {}) }, this.personal?120_000:60_000, authorized);
    if (value.type !== "probe" || !Array.isArray(value.clis) || typeof value.home !== "string") throw new Error(String(value.message || "Windows CLI probe failed"));
    return { clis: value.clis, home: value.home, probedAt: Date.now(), ...inventoryHostname(value.hostname) };
  }
  private async workerResult(request: { op: "models"; cli: string } | { op: "probe"; personal?: true;folder?:string } | { op: "workspace"; agentId: string }, timeoutMs: number, authorized: () => boolean = () => true): Promise<Record<string, unknown>> {
    if (!authorized()) throw new Error("Authorization expired before the Windows operation started");
    const generation = this.workerGeneration;
    const transport = await this.launcher();
    if (generation !== this.workerGeneration) throw new Error("Windows operation was cancelled");
    if (!authorized()) throw new Error("Authorization expired before the Windows operation started");
    this.admit?.();                                  // no await between this and spawn
    return new Promise((resolve, reject) => {
      const child = spawn(transport.executable, transport.args, { stdio: ["pipe", "pipe", "pipe"], ...(transport.cwd ? { cwd: transport.cwd } : {}) });
      this.physicalWorkers.add(child); child.once("close", () => this.physicalWorkers.delete(child));
      let text = "", settled = false;
      const timer = setTimeout(() => { child.kill(); finish(new Error(`Windows CLI ${request.op} timed out`)); }, timeoutMs);
      const finish = (error?: Error, value?: Record<string, unknown>): void => {
        if (settled) return; settled = true; clearTimeout(timer); this.pendingWorkers.delete(child);
        if (error) reject(error); else resolve(value!);
      };
      this.pendingWorkers.set(child, () => { child.kill(); finish(new Error(`Windows CLI ${request.op} was cancelled`)); });
      child.on("error", e => finish(e));
      child.stdout!.setEncoding("utf8").on("data", (part: string) => {
        text += part;
        if (text.length > TEXT_LIMIT) { child.kill(); finish(new Error("Invalid Windows CLI worker response")); }
      });
      child.stderr!.resume();
      child.on("close", () => {
        try {
          const value = JSON.parse(text.trim());
          if (!value || typeof value !== "object" || Array.isArray(value) || value.type !== request.op) throw new Error(value?.message || `Windows CLI ${request.op} failed`);
          finish(undefined, value);
        } catch (e) { finish(e instanceof Error ? e : new Error(`Windows CLI ${request.op} failed`)); }
      });
      // Keep stdin open: its EOF is the worker's parent-liveness signal.
      child.stdin!.write(`${JSON.stringify(request)}\n`);
    });
  }
  start(value: unknown, authorized: () => boolean = () => true, options: WindowsRunOptions = {}): WindowsCliTask {
    this.requireOpen();
    const input = validateNativeTask(value);
    const execInput=options.execInput===undefined?undefined:validateNativeExecInputClaim(options.execInput);
    if(execInput && (execInput.requestId!==input.requestId || execInput.requestSha256!==nativeExecInputRequestDigest(input,options)
      ||!options.onInputWritten) || !execInput && options.onInputWritten)throw Error("Native exec input composition changed");
    if(execInput)options={...options,execInput};
    if (this.personal && options.personal !== true) throw Error("This Runtime accepts personal-agent tasks only");
    if (options.answerOnly && !options.personal) throw Error("Answer only requires a personal Runtime");
    if (options.personal) assertPersonalTask(input, options as unknown as Record<string, unknown>);
    if (options.mcp) options = {...options,mcp:validateNativeMcpConnection(options.mcp)};
    if (options.context !== undefined && (typeof options.context !== "string" || options.context.length > 2000 || options.context.includes("\0"))) throw new Error("Invalid native task context");
    if (options.credentialHome !== undefined && (!isCredentialProfileCli(input.cli) || !validWindowsDirectory(options.credentialHome))) throw new Error("Invalid credential profile folder");
    const old = this.tasks.get(input.requestId);
    if (old) {
      if (JSON.stringify(old.execInput??null)!==JSON.stringify(execInput??null))throw Error("requestId already belongs to another native input claim");
      if (JSON.stringify(old.input) !== JSON.stringify(input) || old.personal !== !!options.personal || old.answerOnly !== !!options.answerOnly) throw new Error("requestId already belongs to another task");
      return visible(old.task);
    }
    if (this.submitted.has(input.requestId)) throw new Error("This requestId was already used; its task history has expired");
    // M-2239 P1-2: a task starts no probe; the administrator's last detection says whether this CLI can run here.
    const detected = this.cachedProbe?.clis.find(row => row.id === input.cli);
    if (!detected) throw new Error("Detect the Windows CLIs first (Settings → Windows CLI → Detect again)");
    if (!detected.runnable) throw new Error(detected.reason || "This Windows CLI could not run at the last detection; detect again after fixing it");
    if (options.mcp && !detected.supports?.mcp) throw new Error("Update this Windows CLI and detect it again to use scoped AgEnD MCP tools");
    if(options.answerOnly && (!["sandbox-unavailable","profile-unavailable"].includes(detected.personalStatus??"") || detected.answerOnlyStatus!=="ready"))throw Error("Answer only has not passed on this computer");
    if (input.sandbox === "read-only" && !detected.readOnlySupport) throw new Error("The installed Windows CLI cannot enforce the selected read-only policy");
    if (this.submitted.size >= 4096) throw new Error("Preview request limit reached; restart AgEnD before submitting new tasks");
    if (this.active) throw new Error("A Windows CLI task is already running");
    const task: WindowsCliTask = { id: input.requestId, cli: input.cli, ...(input.model ? { model: input.model } : {}), cwd: input.cwd, sandbox: input.sandbox, status: "starting", startedAt: Date.now(), output: "" };
    // Reserve before any await: retries and competing requests cannot launch another process.
    this.active = task.id;
    this.submitted.add(task.id);
    this.tasks.set(task.id, { input, task, personal: !!options.personal, answerOnly: !!options.answerOnly, ...(execInput?{execInput}:{}) });
    if (this.tasks.size > MAX_TASKS) this.tasks.delete(this.tasks.keys().next().value!);
    void this.run(input, task, authorized, options);
    return visible(task);
  }
  cancel(id: string): WindowsCliTask {
    const task = this.tasks.get(id)?.task;
    if (!task) throw new Error("Task not found");
    if (this.active === id) {
      // #2945 CI: an outcome the worker already reported (it closes next) is not overwritten; the cancel is still sent.
      if (!SETTLED.includes(task.status)) task.status = "cancelling";
      this.child?.stdin?.write('{"cancel":true}\n');
      // The reservation is kept until the physical worker closes.
    }
    return visible(task);
  }
  close(): void {
    this.workerGeneration++;
    for (const cancel of this.pendingWorkers.values()) cancel();
    this.pendingWorkers.clear();
    if (this.active) this.cancel(this.active);
    this.child?.stdin?.end();
  }
  releaseUnknown(id: string): void {
    if (this.active !== id) return;
    const task = this.tasks.get(id)?.task;
    if (this.child || !task?.finishedAt || task.outcomeConfirmed !== false) throw new Error("Windows process is still connected; cancel it first");
    this.active = null;
  }
  private async run(input: NativeTaskInput, task: WindowsCliTask, authorized: () => boolean, options: WindowsRunOptions): Promise<void> {
    try {
      const transport = await this.launcher();
      if (task.status === "cancelling") { task.status = "cancelled"; task.outcomeConfirmed = true; task.finishedAt = Date.now(); this.active = null; return; }
      if (!authorized()) throw new Error("Web authorization expired before the Windows task started");
      this.admit?.();                                // no await between this and spawn (the executor runs at once)
      await new Promise<void>((resolve) => {
        const child = this.child = spawn(transport.executable, transport.args, { stdio: ["pipe", "pipe", "pipe"], ...(transport.cwd ? { cwd: transport.cwd } : {}) });
        this.physicalWorkers.add(child); child.once("close", () => this.physicalWorkers.delete(child));
        let wire = "", provider = "", stderr = "", received = 0, finished = false, turnCompleted = false, mainStarted = false;
        const fail = (message: string): void => { if (options.personal) delete task.answer; task.error = message.slice(0,8192); if (task.status !== "cancelling") task.status = "failed"; };
        const append = (text: string): void => { task.output = (task.output + text + (input.cli === "grok" ? "" : "\n")).slice(-TEXT_LIMIT); };
        const providerEvent = (line: string): void => {
          const event = parseNativeProviderEvent(input.cli, line);
          if (event?.text) append(event.text);
          if (event?.sessionId) {
            if (options.resumeSessionId && event.sessionId !== options.resumeSessionId) { fail("Windows CLI resumed a different conversation"); child.stdin!.end(); }
            else task.threadId = event.sessionId;
          }
          if (event?.completed) turnCompleted = true;
          if (event?.failed) fail(event.error || "Windows CLI task failed");
        };
        const timer = setTimeout(() => { fail("Windows worker did not finish within five minutes"); this.cancel(task.id); child.stdin!.end(); }, 310_000);
        child.on("error", e => fail(e.message));
        child.stdout!.setEncoding("utf8").on("data", (part: string) => {
          received += Buffer.byteLength(part);
          if (received > 2 * 1024 * 1024) { fail("Windows worker output limit exceeded"); child.stdin!.end(); return; }
          wire += part;
          let at: number;
          while ((at = wire.indexOf("\n")) >= 0) {
            const line = wire.slice(0, at); wire = wire.slice(at + 1);
            try {
              const e = JSON.parse(line);
              if (e.type === "started") {mainStarted=true;if(task.status === "starting")task.status = "running";}
              if (e.type === "input-written") {
                if(!options.execInput||!mainStarted||finished)throw Error("Unexpected native exec input proof");
                const proof=validateNativeExecInputProof(e.proof,options.execInput);
                if(proof.transport!==nativeProvider(input.cli).promptTransport)throw Error("Native exec input transport differs");
                if(task.execInputProof){if(JSON.stringify(task.execInputProof)!==JSON.stringify(proof))throw Error("Native exec input proof changed");}
                else {task.execInputProof=proof;options.onInputWritten?.(proof);}
              }
              if (!options.personal && e.type === "stdout" && typeof e.text === "string") {
                provider += e.text;
                let end: number;
                while ((end = provider.indexOf("\n")) >= 0) {
                  const line = provider.slice(0,end); provider = provider.slice(end+1);
                  providerEvent(line);
                }
              }
              if (!options.personal && e.type === "stderr" && typeof e.text === "string") stderr = (stderr + e.text).slice(-8192);
              if (e.type === "error") {
                if (options.personal) task.personalFailure = personalTaskFailure(e.reason) ? e.reason : "failed";
                fail(options.personal ? `Personal agent: ${task.personalFailure}` : String(e.message));
                if (e.terminal === true) finished = true;
              }
              if (e.type === "finished") {
                if (options.personal) {
                  if (!task.error && task.status !== "cancelling" && e.personal?.ok === true && e.code === 0 && !e.cancelled && typeof e.personal.answer === "string"
                    && e.personal.answer.trim() && Buffer.byteLength(e.personal.answer) <= 64 * 1024) {
                    task.answer = e.personal.answer; turnCompleted = true;
                  } else if (!task.error && task.status !== "cancelling") {
                    task.personalFailure = personalTaskFailure(e.personal?.reason) ? e.personal.reason : "protocol";
                    fail(`Personal agent: ${task.personalFailure}`);
                  }
                }
                if (provider.trim()) { providerEvent(provider); provider = ""; }
                finished = true;
                if (task.status === "cancelling" || e.cancelled) task.status = "cancelled";
                else if (task.status !== "failed") task.status = e.code === 0 && turnCompleted ? "completed" : "failed";
                if (e.code === 0 && !turnCompleted && task.status !== "cancelled" && !task.error) task.error = "CLI exited without a turn-completed event; task outcome is unknown";
                if (e.code !== 0 && !task.error && task.status !== "cancelled") task.error = options.personal ? "Personal agent failed" : stderr || "Windows CLI exited without completing the task";
              }
            } catch { fail("Invalid Windows worker event"); child.stdin!.end(); }
          }
        });
        child.stderr!.setEncoding("utf8").on("data", (s: string) => { if (!options.personal) stderr = (stderr+s).slice(-8192); });
        child.on("close", () => {
          clearTimeout(timer);
          if (!finished) { task.status = "failed"; fail(stderr || task.error || "Worker connection ended; task outcome is unknown. Verify the Windows process before restarting AgEnD; do not retry automatically."); }
          task.finishedAt = Date.now(); this.child = null;
          task.outcomeConfirmed = finished;
          // Losing the worker is not proof its native descendants stopped. Keep the slot blocked in that case.
          if (finished) this.active = null;
          resolve();
        });
        child.stdin!.write(`${JSON.stringify({ op: "run", task: input, ...(options.execInput?{execInput:options.execInput}:{}), ...(options.personal ? { personal: true, ...(options.answerOnly ? { answerOnly: true } : {}) } : {}), ...(options.resumeSessionId ? { resumeSessionId: options.resumeSessionId } : {}),...(options.mcp ? {mcp:options.mcp} : {}),...(options.context ? {context:options.context} : {}),...(options.credentialHome ? {credentialHome:options.credentialHome} : {}) })}\n`);
      });
    } catch (e) { task.error = e instanceof Error ? e.message : "Windows CLI launch failed"; task.status = "failed"; task.outcomeConfirmed = true; task.finishedAt = Date.now(); this.active = null; }
    finally { try { options.onSettled?.(visible(task)); } catch (e) { task.error = `Could not save Windows conversation: ${e instanceof Error ? e.message : e}`; task.status = "failed"; } }
  }
}

const SETTLED: readonly WindowsCliTask["status"][] = ["completed", "failed", "cancelled"];
/**
 * #2945 CI: the worker's "finished" line (or a failure) decides the outcome before its process closes, and finishedAt is
 * set only on close. Until then a snapshot reports the task as still running: a settled status without finishedAt is
 * one the coordinator refuses — it dropped the machine, which then cancelled the run that had just finished.
 */
function visible(task: WindowsCliTask): WindowsCliTask {
  if (!task.finishedAt || task.status !== "completed" || task.outcomeConfirmed !== true) {
    const { answer: _answer, ...pending } = task; return { ...pending, ...(!task.finishedAt && SETTLED.includes(task.status) ? { status: "running" as const } : {}) };
  }
  return { ...task };
}

const bridges = new WeakMap<object, WindowsCliBridge>();
export function windowsBridgeFor(owner: object & { dataDir?: string }): WindowsCliBridge {
  let bridge = bridges.get(owner);
  if (!bridge) { bridge = new WindowsCliBridge(switchedWindowsTransport, owner.dataDir ? join(owner.dataDir, WINDOWS_CLI_INVENTORY_FILE) : undefined, admitLocalWindowsCli); bridges.set(owner, bridge); }
  return bridge;
}

/** Older inventories have no computer name. Never substitute the coordinator's or browser's hostname. */
function inventoryHostname(value: unknown): { hostname?: string } {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 255 && !/[\x00-\x1f\x7f]/.test(value)
    ? { hostname: value.trim() } : {};
}
function readInventory(file: string): WindowsCliProbe | null {
  try {
    const value: unknown = JSON.parse(readFileSync(file, "utf8"));
    const v = value as Partial<WindowsCliProbe> | null;
    return v && Array.isArray(v.clis) && typeof v.home === "string" && typeof v.probedAt === "number" ? { clis: v.clis, home: v.home, probedAt: v.probedAt, ...inventoryHostname(v.hostname) } : null;
  } catch { return null; }
}
function writeInventory(file: string, value: WindowsCliProbe): void {
  try { atomicWriteFileSync(file, JSON.stringify(value), { mode: 0o600 }); } catch { /* kept in memory; detected again after a restart */ }
}
export function closeWindowsBridge(owner: object): void { bridges.get(owner)?.close(); }

/** No constructor/start is allowed while replacing a retained local factory. */
export function retireWindowsBridgeForRequestContext(owner:object):void {
  const bridge=bridges.get(owner);if(!bridge)return;
  bridge.retireForRequestContext();if(bridges.get(owner)!==bridge)throw Error("Windows CLI factory owner changed");bridges.delete(owner);
}

/** Inspect only an existing cached worker factory; never construct one to ask whether it is idle. */
export function windowsBridgeRequestContextIdle(owner:object):boolean{return bridges.get(owner)?.idleForRequestContext()??true;}
