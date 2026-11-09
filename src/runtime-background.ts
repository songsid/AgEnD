/**
 * the Windows Runtime keeps running in the background after it has connected, so closing the window that started it does not disconnect it.
 *
 * Nothing here is a service and nothing needs administrator rights. The pieces:
 *   - a rotating log (`%LOCALAPPDATA%\agend-runtime\logs\<profile>\runtime.log`, a few megabytes in all) that a background Runtime writes its own output to,
 *   - the launcher: it starts one detached `runtime-cli.js run` for a profile (through Windows PowerShell's Start-Process, see below) and waits (a bounded
 *     time) until that one says it is connected, in a small state file in the profile folder,
 *   - the stop request: a small file in the profile folder that the background Runtime watches, because a detached Windows process has no console and
 *     no signal that lets it stop gracefully (a hard kill would skip the orderly stop of its account processes and its profile lock),
 *   - what `status` needs: whether a profile has a live instance, its PID and mode, and the profiles this computer knows about.
 * One instance per profile is the profile lock's job (`RuntimeClientStore.lock`); a second start finds it and says "already running".
 */
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { atomicWriteFileSync } from "./atomic-write.js";
import { execFile } from "./child-process.js";
import type { RuntimeClientStore } from "./runtime-client-store.js";
import { readPaneSystemBootId, reusedRuntimeLockPid } from "./runtime-pane-boot.js";

/** Set (to 1) in the environment of a Runtime that runs detached: its output goes to the log file and it watches for a stop request. */
export const RUNTIME_BACKGROUND_ENV = "AGEND_RUNTIME_BACKGROUND";
export const RUNTIME_LOG_FILE = "runtime.log";
/** One file at most this big, then it is renamed to .1 and a new one begins. */
export const RUNTIME_LOG_MAX_BYTES = 2 * 1024 * 1024;
/** Rotated files kept next to the live one, so a profile's logs never take more than (KEEP + 1) * MAX_BYTES. */
export const RUNTIME_LOG_KEEP = 5;
export const RUNTIME_STOP_REQUEST_FILE = "stop-request.json";
export const RUNTIME_INSTANCE_FILE = "instance.json";
export const RUNTIME_AUTOSTART_FILE = "autostart.json";
const PROFILE_NOTE_FILE = "profile.json";

type Environment = Record<string, string | undefined>;
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }

/* ------------------------------------------------------------------ folders and names */

/** `%LOCALAPPDATA%\agend-runtime`: where the installer puts versions, and where logs go. Without LOCALAPPDATA, the same place under the home folder. */
export function runtimeDataRoot(env: Environment, home: string): string {
  const local = env.LOCALAPPDATA;
  return resolve(local && local.length ? join(local, "agend-runtime") : join(home, "AppData", "Local", "agend-runtime"));
}
export function runtimeLogsRoot(env: Environment, home: string): string { return join(runtimeDataRoot(env, home), "logs"); }
const comparable = (path: string): string => resolve(path).replace(/[\\/]+$/, "").toLowerCase();
function labelPart(text: string): string { return text.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "_").slice(0, 64) || "profile"; }
/**
 * A short, stable, file-name-safe name for a profile folder: `default` for `~\.agend-runtime`, the per-server folder name (`host-port`) for
 * `~\.agend-runtime\profiles\<name>`, and `custom-<folder>-<8 hex of the full path>` for anything chosen with --profile or AGEND_RUNTIME_HOME.
 * It names the log folder and the scheduled task, so two different profiles never share either.
 */
export function runtimeProfileLabel(directory: string, home: string): string {
  const base = resolve(join(home, ".agend-runtime")), dir = resolve(directory);
  if (comparable(dir) === comparable(base)) return "default";
  if (comparable(dirname(dir)) === comparable(join(base, "profiles"))) return labelPart(basename(dir));
  return `custom-${labelPart(basename(dir))}-${createHash("sha256").update(comparable(dir)).digest("hex").slice(0, 8)}`;
}
export function runtimeLogDirectory(env: Environment, home: string, directory: string): string { return join(runtimeLogsRoot(env, home), runtimeProfileLabel(directory, home)); }

/* ------------------------------------------------------------------ the log */

export interface RotatingLogOptions { maxBytes?: number; keep?: number; now?: () => number }
/**
 * Appends timestamped lines to `<directory>\runtime.log`; when the file would pass `maxBytes` it becomes `.1` (the older ones move up, the oldest is deleted).
 * Several processes may write the same log in turn (the launcher, the Runtime, the process an update hands over to), so the size is read from disk each time.
 * A failure to write or rotate never throws: logging must not stop a Runtime. If a rotation keeps failing (another program holds the file) the live file is
 * emptied once it is twice the limit, so it cannot grow without bound either.
 */
export class RotatingLog {
  private readonly maxBytes: number;
  private readonly keep: number;
  private readonly now: () => number;
  constructor(readonly directory: string, options: RotatingLogOptions = {}) {
    this.maxBytes = options.maxBytes ?? RUNTIME_LOG_MAX_BYTES; this.keep = options.keep ?? RUNTIME_LOG_KEEP; this.now = options.now ?? Date.now;
  }
  get file(): string { return join(this.directory, RUNTIME_LOG_FILE); }
  rotatedFile(index: number): string { return `${this.file}.${index}`; }
  write(text: string, level: "info" | "error" = "info"): void {
    const stamp = new Date(this.now()).toISOString();
    const lines = text.split(/\r?\n/).filter(line => line.length > 0);
    if (!lines.length) return;
    const data = lines.map(line => `${stamp} ${level === "error" ? "ERROR " : ""}${line}\n`).join("");
    try {
      mkdirSync(this.directory, { recursive: true });
      const size = (() => { try { return statSync(this.file).size; } catch { return 0; } })();
      if (size > 0 && size + Buffer.byteLength(data) > this.maxBytes) this.rotate(size);
      appendFileSync(this.file, data);
    } catch { /* the log is best effort */ }
  }
  private rotate(size: number): void {
    try {
      rmSync(this.rotatedFile(this.keep), { force: true });
      for (let index = this.keep - 1; index >= 1; index--) if (existsSync(this.rotatedFile(index))) renameSync(this.rotatedFile(index), this.rotatedFile(index + 1));
      renameSync(this.file, this.rotatedFile(1));
    } catch {
      if (size > this.maxBytes * 2) { try { writeFileSync(this.file, ""); } catch { /* nothing more to do */ } }
    }
  }
  /** The last `count` lines, oldest first, reading back through the rotated files when the live one is short. */
  tail(count: number): string[] {
    const lines: string[] = [];
    for (const file of [this.file, ...Array.from({ length: this.keep }, (_, index) => this.rotatedFile(index + 1))]) {
      if (lines.length >= count) break;
      let text: string;
      try { if (!lstatSync(file).isFile()) continue; text = readFileSync(file, "utf8"); } catch { continue; }
      lines.unshift(...text.split(/\r?\n/).filter(line => line.length > 0).slice(-(count - lines.length)));
    }
    return lines.slice(-count);
  }
}

type WriteFunction = typeof process.stdout.write;
/** Sends everything this process writes to stdout and stderr to the log instead. Returns the function that puts the streams back. */
export function captureProcessOutput(log: RotatingLog, target: { stdout: { write: WriteFunction }; stderr: { write: WriteFunction } } = process): () => void {
  const original = { out: target.stdout.write, err: target.stderr.write };
  const redirect = (level: "info" | "error") => ((chunk: unknown, encoding?: unknown, callback?: unknown): boolean => {
    try { log.write(typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString("utf8"), level); } catch { /* best effort */ }
    const done = typeof encoding === "function" ? encoding : callback;
    if (typeof done === "function") (done as () => void)();
    return true;
  }) as WriteFunction;
  target.stdout.write = redirect("info"); target.stderr.write = redirect("error");
  return () => { target.stdout.write = original.out; target.stderr.write = original.err; };
}

/* ------------------------------------------------------------------ what a profile remembers */

export interface RuntimeInstanceMarker { version: 1; pid: number; startedAt: number; mode: "background"; runtimeVersion?: string }
function readSmall(path: string): unknown {
  try { const entry = lstatSync(path); if (!entry.isFile() || entry.isSymbolicLink() || entry.size > 4096) return undefined; return JSON.parse(readFileSync(path, "utf8")); }
  catch { return undefined; }
}
export function readInstanceMarker(directory: string): RuntimeInstanceMarker | undefined {
  const raw = readSmall(join(directory, RUNTIME_INSTANCE_FILE));
  if (!object(raw) || raw.version !== 1 || !Number.isSafeInteger(raw.pid) || (raw.pid as number) <= 0 || !Number.isSafeInteger(raw.startedAt) || raw.mode !== "background") return undefined;
  return { version: 1, pid: raw.pid as number, startedAt: raw.startedAt as number, mode: "background", ...(typeof raw.runtimeVersion === "string" && raw.runtimeVersion.length <= 80 ? { runtimeVersion: raw.runtimeVersion } : {}) };
}
/** Written by a background Runtime once it holds the profile lock; `status` believes it only while its PID is the lock's. */
export function writeInstanceMarker(directory: string, pid: number, now = Date.now(), runtimeVersion?: string): void {
  try { atomicWriteFileSync(join(directory, RUNTIME_INSTANCE_FILE), JSON.stringify({ version: 1, pid, startedAt: now, mode: "background", ...(runtimeVersion ? { runtimeVersion } : {}) }), { mode: 0o600 }); }
  catch { /* status then shows the instance without its mode */ }
}
/** Removes the marker when it names `pid` (the process that wrote it); without a `pid`, whatever marker there is (the Runtime it named is known to be gone). */
export function clearInstanceMarker(directory: string, pid?: number): void {
  try { if (pid === undefined || readInstanceMarker(directory)?.pid === pid) unlinkSync(join(directory, RUNTIME_INSTANCE_FILE)); } catch { /* already gone */ }
}
/** `undefined`: never chosen, so the default (on) applies the first time a background connection succeeds. */
export function readAutostartPreference(directory: string): boolean | undefined {
  const raw = readSmall(join(directory, RUNTIME_AUTOSTART_FILE));
  return object(raw) && raw.version === 1 && typeof raw.enabled === "boolean" ? raw.enabled : undefined;
}
export function writeAutostartPreference(directory: string, enabled: boolean | undefined): void {
  const file = join(directory, RUNTIME_AUTOSTART_FILE);
  if (enabled === undefined) { try { unlinkSync(file); } catch { /* none */ } return; }
  atomicWriteFileSync(file, JSON.stringify({ version: 1, enabled }), { mode: 0o600 });
}

/* ------------------------------------------------------------------ which profiles exist */

export interface KnownProfile { label: string; directory: string }
/** Remembers where a profile lives so `status` and `stop` can find one that was chosen with --profile; a note in that profile's log folder, nothing else. */
export function noteRuntimeProfile(env: Environment, home: string, directory: string): void {
  try {
    const logs = runtimeLogDirectory(env, home, directory); mkdirSync(logs, { recursive: true });
    atomicWriteFileSync(join(logs, PROFILE_NOTE_FILE), JSON.stringify({ version: 1, profile: resolve(directory) }), { mode: 0o600 });
  } catch { /* only discovery of a custom profile suffers */ }
}
export function forgetRuntimeProfileNote(env: Environment, home: string, directory: string): void {
  try { unlinkSync(join(runtimeLogDirectory(env, home, directory), PROFILE_NOTE_FILE)); } catch { /* none */ }
}
function paired(directory: string): boolean { return existsSync(join(directory, "connection.json")); }
/** The default profile, the per-server ones under it, and the ones this computer was told about; only folders that hold a pairing or a live lock. */
export function discoverRuntimeProfiles(env: Environment, home: string): KnownProfile[] {
  const base = resolve(join(home, ".agend-runtime")), found = new Map<string, KnownProfile>();
  const add = (directory: string, always = false): void => {
    const dir = resolve(directory), key = comparable(dir);
    if (found.has(key) || !(always ? existsSync(dir) : paired(dir) || existsSync(join(dir, "runtime.lock")))) return;
    found.set(key, { label: runtimeProfileLabel(dir, home), directory: dir });
  };
  add(base, true);   // the default profile is listed whenever it exists, paired or not: it may hold sign-ins made before pairing
  try { for (const entry of readdirSync(join(base, "profiles"), { withFileTypes: true })) if (entry.isDirectory()) add(join(base, "profiles", entry.name)); } catch { /* none */ }
  try {
    for (const entry of readdirSync(runtimeLogsRoot(env, home), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const note = readSmall(join(runtimeLogsRoot(env, home), entry.name, PROFILE_NOTE_FILE));
      if (object(note) && note.version === 1 && typeof note.profile === "string" && note.profile.length < 1024) add(note.profile);
    }
  } catch { /* none */ }
  return [...found.values()].sort((a, b) => a.label.localeCompare(b.label));
}

/* ------------------------------------------------------------------ is it running */

export interface RuntimeInstance { state: "running" | "stopped"; pid?: number; /** `background`: started by this feature (detached). `foreground`: a window holds the lock. */ mode?: "background" | "foreground"; startedAt?: number }
export interface InstanceDeps {
  /** The Windows boot the lock must belong to; read once by a caller that checks several profiles. */
  systemBootId?: () => Promise<string | undefined>;
  reusedPid?: (holder: number) => Promise<number | undefined>;
  alive?: (pid: number) => boolean;
  platform?: NodeJS.Platform;
}
function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}
/** Same proof the profile lock itself uses (PID alive, same Windows boot, PID not reused by another program), without taking or changing the lock. */
export async function readRuntimeInstance(store: RuntimeClientStore, deps: InstanceDeps = {}): Promise<RuntimeInstance> {
  const lock = store.lockInfo();
  if (!lock) return { state: "stopped" };
  const platform = deps.platform ?? process.platform;
  if (platform === "win32" && lock.systemBootId) {
    const boot = await (deps.systemBootId ?? readPaneSystemBootId)();
    if (boot && boot !== lock.systemBootId) return { state: "stopped" };
  }
  if (!(deps.alive ?? pidAlive)(lock.pid)) return { state: "stopped" };
  if (platform === "win32" && lock.pid !== process.pid) {
    const reused = await (deps.reusedPid ?? (holder => reusedRuntimeLockPid(holder)))(lock.pid);
    if (reused === lock.pid) return { state: "stopped" };
  }
  const marker = readInstanceMarker(store.directory);
  return marker?.pid === lock.pid ? { state: "running", pid: lock.pid, mode: "background", startedAt: marker.startedAt } : { state: "running", pid: lock.pid, mode: "foreground" };
}

/* ------------------------------------------------------------------ stop */

/** Asks the Runtime that holds this profile to stop, the way Ctrl+C would. The file holds nothing but the time. */
export function requestRuntimeStop(directory: string, now = Date.now()): void {
  atomicWriteFileSync(join(directory, RUNTIME_STOP_REQUEST_FILE), JSON.stringify({ version: 1, at: now }), { mode: 0o600 });
}
export function clearStopRequest(directory: string): void { try { unlinkSync(join(directory, RUNTIME_STOP_REQUEST_FILE)); } catch { /* none */ } }
/** Polls for a stop request. It is consumed (deleted) before `onStop` runs, so one request stops one Runtime. Returns the function that ends the watch. */
export function watchStopRequest(directory: string, onStop: () => void, intervalMs = 1000): () => void {
  const file = join(directory, RUNTIME_STOP_REQUEST_FILE);
  const timer = setInterval(() => {
    if (!existsSync(file)) return;
    try { unlinkSync(file); } catch { return; }
    clearInterval(timer); onStop();
  }, intervalMs);
  return () => clearInterval(timer);
}
export type StopOutcome = "not-running" | "stopped" | "timeout";
export interface StopOptions { timeoutMs?: number; pollMs?: number; deps?: InstanceDeps; sleep?: (ms: number) => Promise<void> }
/**
 * Stops the profile's background Runtime and waits until it is gone (its lock is released). A Runtime that is in the middle of handing over to a new version
 * is asked again, so the request is never lost in the hand-over. A Runtime that runs in a window (not detached) is refused: closing that window is the way.
 */
export async function stopRuntimeInstance(store: RuntimeClientStore, options: StopOptions = {}): Promise<StopOutcome> {
  const sleep = options.sleep ?? (ms => new Promise<void>(done => setTimeout(done, ms))), poll = options.pollMs ?? 250;
  const deadline = Date.now() + (options.timeoutMs ?? 30_000);
  let instance = await readRuntimeInstance(store, options.deps);
  if (instance.state !== "running") return "not-running";
  if (instance.mode === "foreground") throw new Error(`The Runtime for this profile (process ${instance.pid}) runs in a window, not in the background. Press Ctrl+C in that window, or close it.`);
  let lastAsk = 0;
  for (;;) {
    if (Date.now() - lastAsk >= 2000) { requestRuntimeStop(store.directory); lastAsk = Date.now(); }
    await sleep(poll);
    instance = await readRuntimeInstance(store, options.deps);
    if (instance.state !== "running") { clearStopRequest(store.directory); return "stopped"; }
    if (Date.now() >= deadline) return "timeout";
  }
}

/* ------------------------------------------------------------------ start */

/** Set for the process the launcher starts: the id it looks for in the state file, so it never believes a word from an older start. */
export const RUNTIME_LAUNCH_ID_ENV = "AGEND_RUNTIME_LAUNCH_ID";
export const RUNTIME_BACKGROUND_STATE_FILE = "background-state.json";
export type BackgroundStatus = "ready" | "already-running" | "failed";
export interface BackgroundState { version: 1; launchId: string; pid: number; status: BackgroundStatus; message?: string; at: number }
const LAUNCH_ID = /^[a-f0-9]{16,64}$/;
/** The background Runtime's word to whoever started it: written (atomically) into the profile folder, only when it was started with a launch id. */
export function reportBackgroundState(directory: string, env: Environment, state: { status: BackgroundStatus; message?: string; pid?: number }, now = Date.now()): void {
  const launchId = env[RUNTIME_LAUNCH_ID_ENV];
  if (!launchId || !LAUNCH_ID.test(launchId)) return;
  const value: BackgroundState = { version: 1, launchId, pid: state.pid ?? process.pid, status: state.status, ...(state.message ? { message: state.message.slice(0, 1000) } : {}), at: now };
  try { atomicWriteFileSync(join(directory, RUNTIME_BACKGROUND_STATE_FILE), JSON.stringify(value), { mode: 0o600 }); } catch { /* the launcher then waits out its time and says "not connected yet" */ }
}
export function readBackgroundState(directory: string): BackgroundState | undefined {
  const raw = readSmall(join(directory, RUNTIME_BACKGROUND_STATE_FILE));
  if (!object(raw) || raw.version !== 1 || typeof raw.launchId !== "string" || !LAUNCH_ID.test(raw.launchId) || !Number.isSafeInteger(raw.pid) || !["ready", "already-running", "failed"].includes(raw.status as string)) return undefined;
  return { version: 1, launchId: raw.launchId, pid: raw.pid as number, status: raw.status as BackgroundStatus, ...(typeof raw.message === "string" ? { message: raw.message } : {}), at: Number(raw.at) || 0 };
}
export function clearBackgroundState(directory: string): void { try { unlinkSync(join(directory, RUNTIME_BACKGROUND_STATE_FILE)); } catch { /* none */ } }

const forbiddenInStartScript = /["\r\n\0]/;
/**
 * The PowerShell that starts the Runtime. Start-Process (ShellExecute) hands the new process no inherited handle, which is the point: a process that Node
 * starts detached still inherits every inheritable handle of its parent on Windows, among them the pipes of whoever called this command (an AI agent's
 * shell, CI), and that caller then waits for the Runtime to end because the pipe never closes. Measured on Windows: the same call returns after 0.3 s through
 * Start-Process and after as long as the Runtime lives without it. The new process keeps this environment, has a hidden console of its own (closing the
 * window that ran this command does not reach it) and, being a child of nobody, outlives the Task Scheduler task that may have run this command.
 */
export function powershellStartScript(input: { execPath: string; cliPath: string; profile: string }): string {
  for (const part of [input.execPath, input.cliPath, input.profile]) if (forbiddenInStartScript.test(part)) throw new Error(`The path ${JSON.stringify(part)} contains a quote or a line break, so the Runtime cannot be started from it in the background. Use --foreground, or move the Runtime or the profile folder.`);
  const quoted = (text: string): string => `'${text.replace(/'/g, "''")}'`;
  const args = `"${input.cliPath}" run --profile "${input.profile}"`;
  return `$ErrorActionPreference = 'Stop'; $p = Start-Process -FilePath ${quoted(input.execPath)} -ArgumentList ${quoted(args)} -WorkingDirectory ${quoted(input.profile)} -WindowStyle Hidden -PassThru; [Console]::Out.Write('AGEND_PID=' + $p.Id)`;
}
export interface StartDetachedInput { script: string; env: Environment; cwd: string }
export type StartDetached = (input: StartDetachedInput) => Promise<{ pid?: number; error?: string }>;
/** Runs the script in a Windows PowerShell of its own (hidden, no profile, no prompt) and reads the process id it prints. */
export const startDetachedWindows: StartDetached = input => new Promise(done => {
  const exe = join(process.env.SystemRoot || process.env.windir || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  execFile(exe, ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-EncodedCommand", Buffer.from(input.script, "utf16le").toString("base64")],
    { windowsHide: true, timeout: 30_000, maxBuffer: 64 * 1024, encoding: "utf8", shell: false, env: input.env as NodeJS.ProcessEnv, cwd: input.cwd }, (error, stdout, stderr) => {
      const pid = Number(/AGEND_PID=(\d+)/.exec(String(stdout ?? ""))?.[1]);
      if (!error && Number.isSafeInteger(pid) && pid > 0) { done({ pid }); return; }
      const said = `${String(stderr ?? "")}\n${String(stdout ?? "")}`.replace(/\s+/g, " ").trim().slice(0, 300);
      done({ error: error ? `${(error as Error).message.split("\n")[0]}${said ? ` (${said})` : ""}` : `PowerShell did not report the new process${said ? ` (${said})` : ""}` });
    });
});

export type BackgroundLaunchResult =
  | { kind: "started"; pid: number; connected: boolean }
  | { kind: "already-running"; pid?: number }
  | { kind: "failed"; message: string };
export interface BackgroundLaunchOptions {
  store: RuntimeClientStore;
  /** The `runtime-cli.js` to run. */
  cliPath: string;
  execPath?: string;
  env?: Environment;
  /** How long to wait for "connected". The Runtime keeps trying after that; the caller then says it has not connected yet. */
  waitMs?: number;
  pollMs?: number;
  /** Test seams. */
  start?: StartDetached;
  alive?: (pid: number) => boolean;
  sleep?: (ms: number) => Promise<void>;
  launchId?: string;
  log?: RotatingLog;
}
/**
 * Starts the profile's Runtime as its own detached, windowless process and waits until it reports (in the state file, under this launch's own id) that AgEnD
 * welcomed it, that another Runtime already holds the profile, or that it failed; or until it is gone, or until `waitMs` is over (then it is "started, not
 * connected yet": it keeps trying by itself). Nothing but the profile folder is handed to it: no pairing code, token or credential.
 */
export async function launchBackgroundRuntime(options: BackgroundLaunchOptions): Promise<BackgroundLaunchResult> {
  const directory = options.store.directory, log = options.log, sleep = options.sleep ?? (ms => new Promise<void>(done => setTimeout(done, ms)));
  const done = (result: BackgroundLaunchResult): BackgroundLaunchResult => {
    log?.write(result.kind === "started" ? `Background Runtime started (process ${result.pid}${result.connected ? ", connected" : ", not connected yet"}).`
      : result.kind === "already-running" ? `A Runtime already runs for this profile${result.pid ? ` (process ${result.pid})` : ""}.` : `Background Runtime did not start: ${result.message}`);
    return result;
  };
  const launchId = options.launchId ?? randomBytes(12).toString("hex");
  let script: string;
  try { script = powershellStartScript({ execPath: options.execPath ?? process.execPath, cliPath: options.cliPath, profile: directory }); }
  catch (error) { return done({ kind: "failed", message: error instanceof Error ? error.message : "The Runtime could not be started" }); }
  clearBackgroundState(directory);
  const started = await (options.start ?? startDetachedWindows)({ script, cwd: directory, env: { ...(options.env ?? process.env), [RUNTIME_BACKGROUND_ENV]: "1", [RUNTIME_LAUNCH_ID_ENV]: launchId } });
  if (started.error || !started.pid) return done({ kind: "failed", message: `The Runtime could not be started in the background: ${started.error ?? "no process was created"}. Use connect --foreground to keep it in this window.` });
  const pid = started.pid, alive = options.alive ?? pidAlive, deadline = Date.now() + (options.waitMs ?? 30_000), poll = options.pollMs ?? 200;
  for (;;) {
    const state = readBackgroundState(directory);
    if (state?.launchId === launchId) {
      if (state.status === "ready") return done({ kind: "started", pid, connected: true });
      if (state.status === "already-running") return done({ kind: "already-running", ...(state.pid ? { pid: state.pid } : {}) });
      return done({ kind: "failed", message: state.message || "The Runtime stopped before it connected. Run agend-runtime logs to see why." });
    }
    if (!alive(pid)) {
      // it may have written its word just before ending
      const last = readBackgroundState(directory);
      if (last?.launchId === launchId && last.status !== "ready") continue;
      return done({ kind: "failed", message: "The background Runtime stopped before it connected. Run agend-runtime logs to see why." });
    }
    if (Date.now() >= deadline) return done({ kind: "started", pid, connected: false });
    await sleep(poll);
  }
}
