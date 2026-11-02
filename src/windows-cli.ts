/** Opt-in, single-task Windows CLI bridge. The existing Linux fleet remains unchanged. */
import { spawn, execFile } from "./child-process.js";
import type { ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { validWindowsAgentId, validWindowsDirectory, validateNativeTask, type NativeCliRow, type NativeTaskInput } from "./windows-cli-worker.js";
import { parseNativeProviderEvent, validateNativeMcpConnection, type NativeMcpConnection, type NativeProviderId } from "./windows-cli-providers.js";

const exec = promisify(execFile);
export interface WindowsCliProbe { clis: NativeCliRow[]; home: string }
export interface WindowsCliTask {
  id: string; cli: NativeProviderId; model?: string; cwd: string; sandbox: NativeTaskInput["sandbox"];
  status: "starting" | "running" | "cancelling" | "completed" | "failed" | "cancelled";
  startedAt: number; finishedAt?: number; output: string; error?: string;
  threadId?: string; outcomeConfirmed?: boolean;
}
export interface WindowsRunOptions { resumeSessionId?: string; onSettled?: (task: WindowsCliTask) => void; mcp?: NativeMcpConnection; context?: string }
export interface WindowsTransport { executable: string; args: string[] }
export type WindowsLauncher = () => Promise<WindowsTransport>;
const MAX_TASKS = 20;
const TEXT_LIMIT = 64 * 1024;
export const WINDOWS_CLI_PROBE_TTL_MS = 60_000;

export function windowsCliEnabled(): boolean { return process.env.AGEND_WINDOWS_CLI === "1"; }
export async function nativeWindowsTransport(): Promise<WindowsTransport> {
  const worker = join(dirname(fileURLToPath(import.meta.url)), "windows-cli-worker.js");
  if (process.platform === "win32") return { executable: process.execPath, args: [worker] };
  if (process.platform !== "linux") throw new Error("Windows CLI bridge requires WSL on this host");
  const powershell = "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";
  const script = '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $n = Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1; [Console]::Write($n.Source)';
  const r = await exec(powershell, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { timeout: 8000, maxBuffer: 8192, encoding: "utf8" });
  const node = String(r.stdout).trim();
  if (!/^[a-z]:\\.*\\node\.exe$/i.test(node) || /[\r\n\0]/.test(node)) throw new Error("Install Windows Node.js and put node.exe on Windows PATH");
  const [nodePath, workerPath] = await Promise.all([node, worker].map(p => exec("wslpath", [p === node ? "-u" : "-w", p], { timeout: 5000, maxBuffer: 8192, encoding: "utf8" })));
  return { executable: String(nodePath.stdout).trim(), args: [String(workerPath.stdout).trim()] };
}

export class WindowsCliBridge {
  private tasks = new Map<string, { input: NativeTaskInput; task: WindowsCliTask }>();
  private submitted = new Set<string>();
  private child: ChildProcess | null = null;
  private active: string | null = null;
  private pendingProbe: Promise<WindowsCliProbe> | null = null;
  private cachedProbe: { value: WindowsCliProbe; expiresAt: number } | null = null;
  constructor(private readonly launcher: WindowsLauncher = nativeWindowsTransport) {}

  list(): WindowsCliTask[] { return [...this.tasks.values()].map(v => ({ ...v.task })).reverse(); }
  hasActiveTask(): boolean { return this.active !== null; }
  get(id: string): WindowsCliTask | null { const task = this.tasks.get(id)?.task; return task ? { ...task } : null; }
  async probe(options: { force?: boolean } = {}): Promise<WindowsCliProbe> {
    if (options.force) this.cachedProbe = null;
    if (!this.pendingProbe && this.cachedProbe && Date.now() < this.cachedProbe.expiresAt) return structuredClone(this.cachedProbe.value);
    this.pendingProbe ??= this.doProbe().then(value => {
      this.cachedProbe = { value: structuredClone(value), expiresAt: Date.now() + WINDOWS_CLI_PROBE_TTL_MS };
      return value;
    }).finally(() => { this.pendingProbe = null; });
    // Neither callers nor another request may mutate a cached/pending result.
    return structuredClone(await this.pendingProbe);
  }
  async prepareWorkspace(agentId: string, authorized: () => boolean = () => true): Promise<string> {
    if (!validWindowsAgentId(agentId)) throw new Error("Invalid Windows agent id");
    const value = await this.workerResult({ op: "workspace", agentId }, 15_000, authorized);
    if (value.type !== "workspace" || value.agentId !== agentId || !validWindowsDirectory(value.cwd)
      || win32.basename(value.cwd).toLowerCase() !== agentId.toLowerCase()
      || win32.basename(win32.dirname(value.cwd)).toLowerCase() !== "workspaces"
      || win32.basename(win32.dirname(win32.dirname(value.cwd))).toLowerCase() !== ".agend") throw new Error(String(value.message || "Invalid Windows workspace response"));
    if (!authorized()) throw new Error("Authorization expired while creating the Windows workspace");
    return value.cwd;
  }
  private async doProbe(): Promise<WindowsCliProbe> {
    const value = await this.workerResult({ op: "probe" }, 60_000);
    if (value.type !== "probe" || !Array.isArray(value.clis) || typeof value.home !== "string") throw new Error(String(value.message || "Windows CLI probe failed"));
    return { clis: value.clis, home: value.home };
  }
  private async workerResult(request: { op: "probe" } | { op: "workspace"; agentId: string }, timeoutMs: number, authorized: () => boolean = () => true): Promise<Record<string, unknown>> {
    if (!authorized()) throw new Error("Authorization expired before the Windows operation started");
    const transport = await this.launcher();
    if (!authorized()) throw new Error("Authorization expired before the Windows operation started");
    return new Promise((resolve, reject) => {
      const child = spawn(transport.executable, transport.args, { stdio: ["pipe", "pipe", "pipe"] });
      let text = "", settled = false;
      const timer = setTimeout(() => { child.kill(); finish(new Error(`Windows CLI ${request.op} timed out`)); }, timeoutMs);
      const finish = (error?: Error, value?: Record<string, unknown>): void => {
        if (settled) return; settled = true; clearTimeout(timer);
        if (error) reject(error); else resolve(value!);
      };
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
    const input = validateNativeTask(value);
    if (options.mcp) options = {...options,mcp:validateNativeMcpConnection(options.mcp)};
    if (options.context !== undefined && (typeof options.context !== "string" || options.context.length > 2000 || options.context.includes("\0"))) throw new Error("Invalid native task context");
    const old = this.tasks.get(input.requestId);
    if (old) {
      if (JSON.stringify(old.input) !== JSON.stringify(input)) throw new Error("requestId already belongs to another task");
      return { ...old.task };
    }
    if (this.submitted.has(input.requestId)) throw new Error("This requestId was already used; its task history has expired");
    if (this.submitted.size >= 4096) throw new Error("Preview request limit reached; restart AgEnD before submitting new tasks");
    if (this.active) throw new Error("A Windows CLI task is already running");
    const task: WindowsCliTask = { id: input.requestId, cli: input.cli, ...(input.model ? { model: input.model } : {}), cwd: input.cwd, sandbox: input.sandbox, status: "starting", startedAt: Date.now(), output: "" };
    // Reserve before any await: retries and competing requests cannot launch another process.
    this.active = task.id;
    this.submitted.add(task.id);
    this.tasks.set(task.id, { input, task });
    if (this.tasks.size > MAX_TASKS) this.tasks.delete(this.tasks.keys().next().value!);
    void this.run(input, task, authorized, options);
    return { ...task };
  }
  cancel(id: string): WindowsCliTask {
    const task = this.tasks.get(id)?.task;
    if (!task) throw new Error("Task not found");
    if (this.active === id) {
      task.status = "cancelling";
      this.child?.stdin?.write('{"cancel":true}\n');
      // The reservation is kept until the physical worker closes.
    }
    return { ...task };
  }
  close(): void {
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
      await new Promise<void>((resolve) => {
        const child = this.child = spawn(transport.executable, transport.args, { stdio: ["pipe", "pipe", "pipe"] });
        let wire = "", provider = "", stderr = "", received = 0, finished = false, turnCompleted = false;
        const fail = (message: string): void => { task.error = message.slice(0,8192); if (task.status !== "cancelling") task.status = "failed"; };
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
              if (e.type === "started" && task.status === "starting") task.status = "running";
              if (e.type === "stdout" && typeof e.text === "string") {
                provider += e.text;
                let end: number;
                while ((end = provider.indexOf("\n")) >= 0) {
                  const line = provider.slice(0,end); provider = provider.slice(end+1);
                  providerEvent(line);
                }
              }
              if (e.type === "stderr" && typeof e.text === "string") stderr = (stderr + e.text).slice(-8192);
              if (e.type === "error") { fail(String(e.message)); if (e.terminal === true) finished = true; }
              if (e.type === "finished") {
                if (provider.trim()) { providerEvent(provider); provider = ""; }
                finished = true;
                if (task.status === "cancelling" || e.cancelled) task.status = "cancelled";
                else if (task.status !== "failed") task.status = e.code === 0 && turnCompleted ? "completed" : "failed";
                if (e.code === 0 && !turnCompleted && task.status !== "cancelled" && !task.error) task.error = "CLI exited without a turn-completed event; task outcome is unknown";
                if (e.code !== 0 && !task.error && task.status !== "cancelled") task.error = stderr || "Windows CLI exited without completing the task";
              }
            } catch { fail("Invalid Windows worker event"); child.stdin!.end(); }
          }
        });
        child.stderr!.setEncoding("utf8").on("data", (s: string) => { stderr = (stderr+s).slice(-8192); });
        child.on("close", () => {
          clearTimeout(timer);
          if (!finished) { task.status = "failed"; fail(stderr || task.error || "Worker connection ended; task outcome is unknown. Verify the Windows process before restarting AgEnD; do not retry automatically."); }
          task.finishedAt = Date.now(); this.child = null;
          task.outcomeConfirmed = finished;
          // Losing the worker is not proof its native descendants stopped. Keep the slot blocked in that case.
          if (finished) this.active = null;
          resolve();
        });
        child.stdin!.write(`${JSON.stringify({ op: "run", task: input, ...(options.resumeSessionId ? { resumeSessionId: options.resumeSessionId } : {}),...(options.mcp ? {mcp:options.mcp} : {}),...(options.context ? {context:options.context} : {}) })}\n`);
      });
    } catch (e) { task.error = e instanceof Error ? e.message : "Windows CLI launch failed"; task.status = "failed"; task.outcomeConfirmed = true; task.finishedAt = Date.now(); this.active = null; }
    finally { try { options.onSettled?.({ ...task }); } catch (e) { task.error = `Could not save Windows conversation: ${e instanceof Error ? e.message : e}`; task.status = "failed"; } }
  }
}

const bridges = new WeakMap<object, WindowsCliBridge>();
export function windowsBridgeFor(owner: object): WindowsCliBridge {
  let bridge = bridges.get(owner); if (!bridge) { bridge = new WindowsCliBridge(); bridges.set(owner, bridge); } return bridge;
}
export function closeWindowsBridge(owner: object): void { bridges.get(owner)?.close(); }
