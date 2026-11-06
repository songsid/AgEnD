/** Standalone, outbound-only native runtime. Imports no Fleet, database, bot or Linux native dependency. */
import WebSocket from "ws";
import { readPaneSystemBootId, reusedRuntimeLockPid } from "./runtime-pane-boot.js";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { hostname } from "node:os";
import { randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { WindowsCliBridge, nativeWindowsTransport, WINDOWS_CLI_INVENTORY_FILE, type WindowsCliProbe, type WindowsCliTask, type WindowsRunOptions } from "./windows-cli.js";
import { probeCredentialProfileStatus, validateNativeTask, validWindowsAgentId, type CredentialProfileAnswer, type NativeTaskInput } from "./windows-cli-worker.js";
import { validNativeSessionId, type NativeMcpConnection } from "./windows-cli-providers.js";
import { RUNTIME_CREDENTIAL_CAPABILITY, credentialLoginRequired, credentialProfileReport, isCredentialProfileCli, listCredentialProfileNames, rememberCredentialStatus, requireCredentialProfile, credentialCacheStamp,
  assertCredentialProfileName, assertCredentialProfileCli, type CredentialProfileCli, type CredentialProfileReport } from "./runtime-credential-profiles.js";
import { RuntimeClientStore, runtimeJobDigest, validateRuntimeServer, type RuntimeCredentials, type RuntimeStoredJob } from "./runtime-client-store.js";
import { RUNTIME_ROTATE_PATH, RUNTIME_REINSTALL_CLOSE_PREFIX, runtimeClaimFingerprint } from "./runtime-protocol.js";
import { readRuntimeInfo } from "./runtime-build-info.js";
import { RemoteAccounts, type RemoteAccountsDeps, type RemoteInstaller } from "./runtime-remote-accounts.js";
import { CLI_INSTALL_CAPABILITY, REMOTE_SIGNIN_CAPABILITY } from "./runtime-remote-setup.js";
import { managedCliRoot, managedInstaller, nativeInstallSupported } from "./runtime-cli-install.js";
import { isRuntimeRemoteOperation } from "./runtime-protocol.js";
import { PANE_IN_PROCESS_DIRECTORY, paneLedgerFiles } from "./runtime-pane-store.js";
import { findCli, nativeCliEnvironment } from "./windows-cli-worker.js";
import { spawn as childSpawn } from "./child-process.js";
import { RuntimeUpdateActivity, type RuntimeUpdateFence } from "./runtime-update-activity.js";
import { parseRuntimeUpdateControl, RUNTIME_MANAGED_UPDATE_CAPABILITY, validRuntimeUpdateId, type RuntimeUpdateClientPhase, type RuntimeUpdateServerPhase } from "./runtime-update-protocol.js";
import { validatePaneMcpBody, type PaneMcpBody } from "./runtime-pane-mcp-protocol.js";
import { validateRuntimePaneRequest, validateRuntimePaneShutdown } from "./runtime-pane-protocol.js";
import type { PaneLinkOptions } from "./runtime-pane-link.js";
import type { RuntimePaneLink } from "./runtime-pane-link.js";
import type { RuntimePaneHost } from "./runtime-pane-host.js";
import type { RuntimePaneHostOptions } from "./runtime-pane-host.js";
export { RUNTIME_PANE_MODULES } from "./runtime-pane-assets.js";

export type RuntimeStopKind = "refused" | "revoked" | "replaced" | "rejected" | "incompatible" | "reinstall";
export interface RuntimeStopReason { kind: RuntimeStopKind; /** The close reason AgEnD gave, when it gave one. */ detail?: string }
const REPAIR = "run .\\agend-runtime.cmd disconnect in this folder (add the same --profile if you used one), then double-click connect-agend.bat and enter a new pairing code.";
/** Plain-language cause and next step for a stop AgEnD caused. AgEnD answers an unknown and a revoked credential with the same bare 401, so "refused" covers both. */
export function describeRuntimeStop(reason: RuntimeStopReason): string {
  switch (reason.kind) {
    case "refused": return `${reason.detail === "HTTP 403" ? "The connection was refused with HTTP 403. If AgEnD's address goes through a proxy, check the proxy's settings too. " : ""}AgEnD did not accept this computer's saved connection, so the Runtime stopped. Open AgEnD Settings -> Runtime: if this computer is missing or revoked, or AgEnD's data was reset, it must be paired again; ${REPAIR} If the pairing was made against a different AgEnD address than this folder's, use the download that matches it.`;
    case "reinstall": return "AgEnD refused this Runtime because its version is not compatible with this AgEnD (it was installed from a different AgEnD release). Your pairing is kept. Re-run the install command shown in AgEnD Settings -> Runtime -> Connect a computer (Windows PowerShell tab) on this computer; it installs the matching Runtime next to this one and never deletes the version that is running. Then start it again with agend-runtime run (add the same --profile if you used one). If you installed from the ZIP, download the ZIP from the same page and double-click connect-agend.bat.";
    case "revoked": return `This computer was revoked in AgEnD Settings -> Runtime, so the Runtime stopped. To connect it again, ${REPAIR}`;
    case "replaced": return "This computer connected to AgEnD again from somewhere else, so AgEnD closed this connection. A pairing allows one live connection. Close the other Runtime window (or the other computer that uses a copy of this profile), then double-click connect-agend.bat again. Each computer needs its own pairing code.";
    case "incompatible": return "This Runtime could not understand a message from AgEnD, so it stopped. This usually means the Runtime and AgEnD are different versions, or the address points at something that is not this AgEnD. Download the Windows Runtime again from AgEnD Settings -> Runtime, extract it, and double-click connect-agend.bat.";
    case "rejected": return `AgEnD rejected a message from this Runtime${reason.detail ? ` (${reason.detail})` : ""}. Usual causes: leftover data from pairing this profile with a different AgEnD server, or a Runtime/AgEnD version mismatch. If this profile was used with another AgEnD server, ${REPAIR} If pairing reports an unfinished job from another pairing, follow that message: check that no CLI it started is still running, delete jobs.json in the profile folder, then pair again. Otherwise download the Windows Runtime again from AgEnD Settings -> Runtime, extract it, and double-click connect-agend.bat.`;
  }
}

export interface RuntimeBridge {
  probe(options?: { force?: boolean }): Promise<WindowsCliProbe>;
  prepareWorkspace(agentId: string): Promise<string>;
  start(value: unknown, authorized?: () => boolean, options?: WindowsRunOptions): WindowsCliTask;
  get(id: string): WindowsCliTask | null;
  cancel(id: string): WindowsCliTask;
  close(): void;
  releaseUnknown(id: string): void;
  /** Required positive physical proof for managed update. An old/injected bridge without it stays unavailable. */
  idleForUpdate?(): boolean;
}
interface Command { v: 1; type: "request"; id: string; operation: string; payload: Record<string, unknown> }
interface PendingTool { accept(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
export interface RuntimeClientOptions {
  store: RuntimeClientStore;
  bridge?: RuntimeBridge;
  report?: (message: string) => void;
  reconnectMs?: number;
  disconnectGraceMs?: number;
  pollMs?: number;
  /** Tests may use an isolated fake worker. Production always uses the Windows bridge. */
  socketFactory?: (url: string, credential: string) => WebSocket;
  /** Offline transport acceptance supplies its own process factory, never a public configuration field. */
  openPaneLink?: (options: PaneLinkOptions) => Promise<RuntimePaneLink>;
  createPaneHost?: (options: RuntimePaneHostOptions) => RuntimePaneHost;
  /**
   * This Runtime's credential profile root (<runtime home>\credential-profiles). Absent: the Runtime does not offer profiles, says so in its
   * capabilities, and refuses any run or terminal that names one.
   */
  credentialProfilesRoot?: string;
  /** Test seam; production asks the CLI itself (`claude auth status` under that profile's folder). */
  credentialLogin?: (cli: CredentialProfileCli, directory: string) => Promise<boolean | null>;
  /** Test seam for the same check with the account in it (masked e-mail, plan). Wins over `credentialLogin`. */
  credentialStatus?: (cli: CredentialProfileCli, directory: string) => Promise<CredentialProfileAnswer>;
  /** How often to look for a sign-in made by `agend-runtime login` in another window (default 5 s). */
  credentialWatchMs?: number;
  /**
   * #3190 Part 3a. Production leaves this out (native Windows only). A test, or the install work (3b), supplies pieces of the remote account
   * operations: the CLI lookup, the logout run, the CLI installer (its presence is what makes this Runtime report `cli-install`), the sign-in
   * process factory, and the folder-link inspector. Supplying anything here lets a non-Windows test Runtime offer `remote-signin`.
   */
  remoteAccounts?: Partial<Pick<RemoteAccountsDeps, "find" | "runLogout" | "installer" | "signIn" | "ownership" | "environment" | "now" | "switchWatchMs">> & { systemBootId?: () => Promise<string | undefined> };
  /** Internal supervisor seam, never a server-supplied configuration option. */
  managedUpdate?: { trialId?: string; authenticated?(value: { bootId: string; generation: number; updateProtocol?: 1; runtimeInfo: ReturnType<typeof readRuntimeInfo> }): void };
  /** Isolated tests can supply a private pane service. Production uses attach-only discovery and physical exit proof. */
  drainPaneHostForUpdate?(current: () => boolean): Promise<void>;
}
const MAX_FRAME = 256 * 1024;
const MAX_TOOL = 64 * 1024;
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function message(error: unknown): string { return error instanceof Error ? error.message.slice(0, 1000) : "Runtime operation failed"; }
interface CheckedRun { task: NativeTaskInput; resumeSessionId?: string; context?: string; mcp?: { tools: string[] }; credentialProfile?: string }
function checkedRun(value: unknown): CheckedRun {
  if (!object(value) || Object.keys(value).some(key => !["task", "resumeSessionId", "context", "mcp", "credentialProfile"].includes(key))) throw new Error("Invalid runtime run payload");
  const task = validateNativeTask(value.task);
  // A name and nothing else: a path, a drive letter or a control byte is not a profile name and is refused here, not "cleaned".
  if (value.credentialProfile !== undefined) { assertCredentialProfileName(value.credentialProfile); assertCredentialProfileCli(task.cli); }
  if (value.resumeSessionId !== undefined && !validNativeSessionId(task.cli, value.resumeSessionId)) throw new Error("Invalid native conversation ID");
  if (value.context !== undefined && (typeof value.context !== "string" || value.context.length > 2000 || value.context.includes("\0"))) throw new Error("Invalid native context");
  if (value.mcp !== undefined && (!object(value.mcp) || Object.keys(value.mcp).some(key => key !== "tools")
    || !Array.isArray(value.mcp.tools) || !value.mcp.tools.length || value.mcp.tools.length > 64
    || value.mcp.tools.some(tool => typeof tool !== "string" || !/^[a-z][a-z0-9_]{0,63}$/.test(tool)))) throw new Error("Invalid scoped MCP request");
  return { task, resumeSessionId: value.resumeSessionId as string | undefined, context: value.context as string | undefined,
    mcp: value.mcp as { tools: string[] } | undefined, ...(value.credentialProfile !== undefined ? { credentialProfile: value.credentialProfile as string } : {}) };
}
function jsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((accept, reject) => {
    let text = "", bytes = 0;
    req.setTimeout(10_000, () => { reject(new Error("MCP request timed out")); req.destroy(); });
    req.setEncoding("utf8");
    req.on("data", (part: string) => { bytes += Buffer.byteLength(part); if (bytes > MAX_TOOL) { reject(new Error("MCP request is too large")); req.destroy(); } else text += part; });
    req.on("error", reject);
    req.on("end", () => { try { accept(JSON.parse(text)); } catch { reject(new Error("Invalid MCP JSON")); } });
  });
}
export class RuntimeClient {
  readonly bootId = randomUUID();
  private readonly runtimeInfo: ReturnType<typeof readRuntimeInfo>;
  private readonly bridge: RuntimeBridge;
  private socket: WebSocket | null = null;
  private welcomed = false;
  private stopped = true;
  private closed = false;
  private unlock: (() => void) | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private graceTimer: ReturnType<typeof setTimeout> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private credentialWatch: ReturnType<typeof setInterval> | null = null;
  private credentialStamp = "";
  private credentials: RuntimeCredentials | null = null;
  private startupRotation: Promise<RuntimeCredentials> | null = null;
  private paneHost: RuntimePaneHost | RuntimePaneLink | null = null;
  private paneOpening: Promise<RuntimePaneHost | RuntimePaneLink> | null = null;
  private machinePaneLimit = 4;
  private paneEpoch = randomUUID();
  private readonly active = new Set<string>();
  /** Run id -> the credential profile it runs under, so removing or signing out a profile waits for its runs. */
  private readonly activeProfiles = new Map<string, string>();
  private remoteAccounts: RemoteAccounts | null = null;
  /** Ends a CLI install that is still running when this Runtime stops (the install's child process is the exact one it started). */
  private readonly installAbort = new AbortController();
  /** The Runtime's own installer (native Windows only): its closed table, its pinned versions and one install at a time. */
  private readonly managed: RemoteInstaller | null;
  private readonly snapshots = new Map<string, string>();
  private readonly pendingPaneTools = new Map<string, PendingTool>();
  private readonly pendingTools = new Map<string, PendingTool>();
  private readonly mcpTokens = new Map<string, { runId: string; tools: string[] }>();
  private mcpServer: Server | null = null;
  private mcpOpening: Promise<number> | null = null;
  private mcpPort = 0;
  private inventory: WindowsCliProbe | null = null;
  private readonly stoppedListeners = new Set<() => void>();
  private activity = new RuntimeUpdateActivity();
  private stopPromise: Promise<void> | undefined;
  private generation = 0;
  private updateProtocol = false;
  private preparingUpdate = false;
  private trialFence: RuntimeUpdateFence | undefined;
  private updateWait: { id: string; phases: RuntimeUpdateServerPhase[]; accept(phase: RuntimeUpdateServerPhase): void; reject(error: Error): void; timer: NodeJS.Timeout } | undefined;
  /** Set only when AgEnD ended the connection and the person must act; a local stop (Ctrl+C) leaves it undefined. */
  stopReason: RuntimeStopReason | undefined;
  /** The socket this Runtime itself closed with 1008 because it could not read AgEnD's frame; that is not AgEnD refusing us. */
  private selfClosed: WebSocket | null = null;
  constructor(private readonly options: RuntimeClientOptions) {
    this.managed = nativeInstallSupported() ? managedInstaller({ root: managedCliRoot(options.store.directory) }, () => this.installAbort.signal) : null;
    const info = readRuntimeInfo({ panes: process.platform === "win32" || !!options.createPaneHost || !!options.openPaneLink, install: !!options.remoteAccounts?.installer || nativeInstallSupported() });
    // Offered only when this client has a profile root to resolve names under; otherwise AgEnD must not ask for a profile.
    if (options.managedUpdate?.trialId !== undefined && !validRuntimeUpdateId(options.managedUpdate.trialId)) throw Error("Invalid Runtime update trial");
    this.runtimeInfo = { ...info, capabilities: [...info.capabilities.filter(name => options.credentialProfilesRoot || name !== RUNTIME_CREDENTIAL_CAPABILITY), ...(options.managedUpdate ? [RUNTIME_MANAGED_UPDATE_CAPABILITY] : [])] };
    // Remote account operations need the profile folder, and a way to run the Windows CLI (native Windows, or a test's own). `cli-install` also needs an installer.
    const remote = !!options.credentialProfilesRoot && (process.platform === "win32" || !!options.remoteAccounts);
    this.runtimeInfo = { ...this.runtimeInfo, capabilities: this.runtimeInfo.capabilities.filter(name => name === REMOTE_SIGNIN_CAPABILITY ? remote : name === CLI_INSTALL_CAPABILITY ? remote && !!(options.remoteAccounts?.installer || nativeInstallSupported()) : true) };
    this.bridge = options.bridge ?? new WindowsCliBridge(nativeWindowsTransport, join(options.store.directory, WINDOWS_CLI_INVENTORY_FILE));
  }
  private report(text: string): void { this.options.report?.(text); }
  online(): boolean { return !this.trialFence && this.welcomed && this.socket?.readyState === WebSocket.OPEN; }
  waitUntilStopped(): Promise<void> { return this.stopPromise ?? (this.stopped && this.closed ? Promise.resolve() : new Promise(done => this.stoppedListeners.add(done))); }
  async start(): Promise<void> {
    if (!this.stopped) return;
    if (this.stopPromise) { await this.stopPromise; this.stopPromise = undefined; this.activity = new RuntimeUpdateActivity(); }
    let credentials = this.options.store.credentials(); if (!credentials) throw new Error("Pair this runtime before connecting");
    validateRuntimeServer(credentials.server);
    this.stopped = false; this.closed = false; this.stopReason = undefined;
    try {
      const systemBootId = process.platform === "win32" ? await readPaneSystemBootId() : undefined;
      if (this.stopped) throw Error("Runtime start was cancelled");
      const reused = process.platform === "win32" ? await reusedRuntimeLockPid(this.options.store.lockHolder()) : undefined;
      if (this.stopped) throw Error("Runtime start was cancelled");
      this.unlock = this.options.store.lock(this.bootId, systemBootId, reused);
      if (credentials.pendingCredential) {
        const rotating = this.startupRotation = rotateRuntimeCredentials({ store: this.options.store });
        try { credentials = await rotating; } finally { if (this.startupRotation === rotating) this.startupRotation = null; }
      }
      if (this.stopped) throw Error("Runtime start was cancelled");
      this.options.store.adoptMachine(credentials.machineId);
      this.options.store.recoverInterrupted(); this.credentials = credentials;
      if (this.options.managedUpdate?.trialId) {
        this.trialFence = this.activity.tryFence(this.options.managedUpdate.trialId, () => !this.stopped, () => true);
        if (!this.trialFence) throw Error("Runtime trial admission is unavailable");
      }
      // Connect immediately, then publish the last administrator detection from the private profile.
      // A cached read starts no CLI. Only an explicit probe command with force:true performs detection.
      this.connect();
      // A foreground runtime must remain alive while an idle connection is down. Promises and unref'ed retry
      // timers do not keep Node running after the last socket closes; stop() owns and clears this liveness ref.
      this.pollTimer = setInterval(() => this.poll(), this.options.pollMs ?? 250);
      if (!this.trialFence) this.beginDiscovery();
    } catch (error) { this.stopped = true; this.unlock?.(); this.unlock = null; throw error; }
  }
  private connect(): void {
    if (this.stopped || !this.credentials) return;
    const url = validateRuntimeServer(this.credentials.server); url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = "/runtime/v1/connect";
    const socket = this.socket = this.options.socketFactory?.(url.href, this.credentials.credential)
      ?? new WebSocket(url.href, { headers: { Authorization: `Bearer ${this.credentials.credential}` }, followRedirects: false,
        maxPayload: MAX_FRAME, handshakeTimeout: 15_000, perMessageDeflate: false });
    this.welcomed = false; this.updateProtocol = false; this.paneEpoch = randomUUID();
    socket.on("open", () => {
      if (this.stopped || this.socket !== socket) { socket.close(); return; }
      this.send({ v: 1, type: "hello", bootId: this.bootId, name: this.credentials!.name, platform: process.platform, runtimeInfo: this.runtimeInfo,
        ...(this.trialFence ? { updateTrialId: this.trialFence.id } : {}),
        ...(process.platform === "win32" || this.options.createPaneHost || this.options.openPaneLink ? { paneProtocol: 1 } : {}),
        ...(this.inventory ? { inventory: this.inventory } : {}) });
    });
    socket.on("message", (bytes, binary) => {
      const size = Array.isArray(bytes) ? bytes.reduce((sum, part) => sum + part.byteLength, 0) : bytes.byteLength;
      if (binary || size > MAX_FRAME || this.socket !== socket) { this.selfClosed = socket; socket.close(1008, "Invalid runtime frame"); return; }
      void this.receive(bytes.toString()).catch(() => { this.selfClosed = socket; socket.close(1008, "Invalid runtime protocol"); });
    });
    socket.on("error", () => { /* close is the single reconnection path; never log credential-bearing errors */ });
    socket.on("unexpected-response", (_req, response) => {
      response.resume();
      if (response.statusCode === 401 || response.statusCode === 403) {
        this.report("Runtime credential was refused. Re-pair after the machine is authorized.");
        this.stopReason = { kind: "refused", ...(response.statusCode === 403 ? { detail: "HTTP 403" } : {}) };
        void this.stop();
      } else socket.terminate();
    });
    socket.on("close", (code,reason) => {
      if (this.socket !== socket) return;
      this.socket = null; this.welcomed = false; this.paneEpoch = randomUUID();
      if (this.updateWait) { const pending = this.updateWait; this.updateWait = undefined; clearTimeout(pending.timer); pending.reject(Error("Runtime update connection changed")); }
      if (this.paneHost && "connectionChanged" in this.paneHost) this.paneHost.connectionChanged();
      this.rejectTools();
      if (this.stopped) return;
      if (code === 1008) {
        const why = reason.toString().replace(/[^ -~]/g, "?").slice(0, 120);
        this.report(this.selfClosed === socket ? "This Runtime could not read a message from AgEnD and closed the connection." : `AgEnD closed the connection (code 1008${why ? `: ${why}` : ""}).`);
        this.stopReason = this.selfClosed === socket ? { kind: "incompatible" } : { kind: why === "Machine revoked" ? "revoked" : why === "Connection replaced" ? "replaced" : why.startsWith(RUNTIME_REINSTALL_CLOSE_PREFIX) ? "reinstall" : "rejected", ...(why ? { detail: why } : {}) };
        void this.stop({retirePanes:why==="Machine revoked"}); return;
      }
      this.report("Disconnected. Existing execution is not replayed; reconnecting…");
      if (!this.graceTimer) this.graceTimer = setTimeout(() => {
        this.graceTimer = null;
        for (const id of this.active) { try { this.bridge.cancel(id); } catch { /* state reconciles in poll */ } }
        this.report("The coordinator remained disconnected; cancellation was requested for the active execution.");
      }, this.options.disconnectGraceMs ?? 45_000);
      this.graceTimer.unref?.();
      const base = Math.min(30_000, 2000 * 2 ** Math.min(this.reconnectAttempt++, 4));
      const delay = this.options.reconnectMs ?? Math.min(30_000, Math.round(base * (0.75 + Math.random() * 0.5)));
      this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this.connect(); }, delay);
      this.reconnectTimer.unref?.();
    });
  }
  private send(value: unknown): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    const frame = JSON.stringify(value);
    if (Buffer.byteLength(frame) > MAX_FRAME) throw new Error("Runtime frame limit exceeded");
    if (this.socket.bufferedAmount > 2 * MAX_FRAME) { this.socket.close(1013, "Runtime backpressure"); return; }
    this.socket.send(frame);
  }
  private async receive(text: string): Promise<void> {
    const value: unknown = JSON.parse(text);
    if (!object(value) || value.v !== 1 || typeof value.type !== "string") throw new Error("Unsupported runtime protocol");
    if (value.type === "welcome") {
      if (value.machineId !== this.credentials?.machineId || !Number.isSafeInteger(value.generation)) throw new Error("Runtime machine identity mismatch");
      this.welcomed = true;
      this.generation = value.generation as number; this.updateProtocol = value.updateProtocol === 1;
      this.reconnectAttempt = 0;
      if (this.graceTimer) { clearTimeout(this.graceTimer); this.graceTimer = null; }
      this.report("Connected to AgEnD.");
      if (!this.trialFence) for (const job of this.options.store.list()) this.publish(job);
      this.options.managedUpdate?.authenticated?.({ bootId: this.bootId, generation: this.generation, ...(this.updateProtocol ? { updateProtocol: 1 } : {}), runtimeInfo: this.runtimeInfo });
      return;
    }
    if (value.type === "update.control") {
      const control = parseRuntimeUpdateControl(value, "server"), pending = this.updateWait;
      if (!pending || control.bootId !== this.bootId || control.generation !== this.generation || control.id !== pending.id || !pending.phases.includes(control.phase)) return;
      if (control.phase === "activated") {
        if (this.trialFence?.id !== control.id || !this.trialFence.current() || !this.locallyIdle()) throw Error("Runtime trial is no longer idle");
        this.trialFence.release(); this.trialFence = undefined;
        // Release synchronously: the server's next ordered frame may already contain ordinary work.
        for (const job of this.options.store.list()) this.publish(job);
        this.beginDiscovery();
      }
      this.updateWait = undefined; clearTimeout(pending.timer); pending.accept(control.phase); return;
    }
    if (value.type === "revoked") { this.report("This machine was revoked by AgEnD."); this.stopReason = { kind: "revoked" }; await this.stop({retirePanes:true}); return; }
    if (!this.welcomed) throw new Error("Runtime handshake is incomplete");
    if (value.type === "ping") { this.send({ v: 1, type: "pong" }); return; }
    if (value.type === "tool.result") {
      if (typeof value.id !== "string") throw new Error("Invalid tool reply");
      const pending = this.pendingTools.get(value.id); if (!pending) return;
      clearTimeout(pending.timer); this.pendingTools.delete(value.id);
      if (value.ok === true) pending.accept(value.result); else pending.reject(new Error("AgEnD MCP request was refused"));
      return;
    }
    if (value.type === "pane.tool.result") {
      if (Object.keys(value).some(key => !["v", "type", "id", "ok", "result"].includes(key)) || !validWindowsAgentId(value.id) || typeof value.ok !== "boolean") throw Error("Invalid pane MCP reply");
      const pending = this.pendingPaneTools.get(value.id); if (!pending) return;
      this.pendingPaneTools.delete(value.id); clearTimeout(pending.timer);
      if (value.ok) pending.accept(value.result); else pending.reject(Error("Pane MCP request was refused"));
      return;
    }
    if (value.type === "pane.request") {
      if (Object.keys(value).some(key => !["v", "type", "id", "maxAgents", "request"].includes(key))
        || typeof value.id !== "string" || !validWindowsAgentId(value.id) || !Number.isInteger(value.maxAgents)
        || (value.maxAgents as number) < 1 || (value.maxAgents as number) > 16) throw Error("Invalid pane transport envelope");
      const request = validateRuntimePaneRequest(value.request);
      this.machinePaneLimit = value.maxAgents as number;
      const epoch = this.paneEpoch;
      let leave: (() => void) | undefined;
      try {
        leave = this.activity.enter();
        const host = await this.panes();
        // A terminal for an agent with no profile of its own starts under this pairing's default profile, when there is one. The default is passed
        // beside the launch, not inside it: the host decides with it only for a pane that is new, so a pane that is already running reattaches
        // whatever the default has become since.
        const fallback = request.action === "open" && request.launch.credentialProfile === undefined ? this.credentialProfileFor(request.launch.cli, undefined) : undefined;
        const forHost = request.action === "open" && fallback !== undefined ? { ...request, defaultCredentialProfile: fallback } : request;
        const result = await host.request(forHost, () => epoch === this.paneEpoch && this.online());
        if(request.action==="shutdown"){
          validateRuntimePaneShutdown(result,request.hostBootId);
          // Explicit coordinator disable, not a disconnect: the next enabled request discovers a new host boot.
          // Retire this cache before sending the reply, including when that reply is lost under backpressure.
          if(this.paneHost===host){this.paneHost=null;this.paneOpening=null;}await host.stop();
        }
        this.send({ v: 1, type: "pane.response", id: value.id, ok: true, result });
      } catch (error) { this.send({ v: 1, type: "pane.response", id: value.id, ok: false, error: message(error) }); }
      finally { leave?.(); }
      return;
    }
    if (value.type === "account.request") {
      // Not journaled by AgEnD and not stored here: a sign-in's URL and code travel in these frames and nowhere else.
      if (Object.keys(value).some(key => !["v", "type", "id", "operation", "payload"].includes(key)) || typeof value.id !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(value.id)
        || !isRuntimeRemoteOperation(value.operation)) throw new Error("Invalid account request");
      try { this.send({ v: 1, type: "account.response", id: value.id, ok: true, result: await this.remote().handle(value.operation, value.payload) }); }
      catch (error) { this.send({ v: 1, type: "account.response", id: value.id, ok: false, error: message(error) }); }
      return;
    }
    if (value.type !== "request" || typeof value.id !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(value.id)
      || typeof value.operation !== "string" || !object(value.payload)) throw new Error("Invalid runtime request");
    const command = value as unknown as Command;
    try { this.send({ v: 1, type: "response", id: command.id, ok: true, result: await this.operation(command.operation, command.payload) }); }
    catch (error) { this.send({ v: 1, type: "response", id: command.id, ok: false, error: message(error) }); }
  }
  private publish(job: RuntimeStoredJob): void { if (this.online()) this.send({ v: 1, type: "task", seq: job.seq, task: job.task }); }
  private panes(): Promise<RuntimePaneHost | RuntimePaneLink> {
    // A detached host link is not a live cache. Rediscover on the next independent request; never replay this RPC.
    if (this.paneHost && "connected" in this.paneHost && !this.paneHost.connected()) { this.paneHost = null; this.paneOpening = null; }
    if (!this.paneOpening) {
      const output: RuntimePaneHostOptions["output"] = snapshot => { if (this.online()) this.send({ v: 1, type: "pane.output", snapshot }); };
      if (this.options.createPaneHost) this.paneOpening = import("./runtime-pane-store.js").then(({ RuntimePaneStore }) => {
        const store = new RuntimePaneStore(join(this.options.store.directory, PANE_IN_PROCESS_DIRECTORY)); store.recoverInterrupted();
        return this.paneHost = this.options.createPaneHost!({ store, bootId: this.bootId, online: () => !this.stopped && this.online(), maxAgents: () => this.machinePaneLimit, output });
      });
      else this.paneOpening = import("./runtime-pane-link.js").then(({ RuntimePaneLink }) => (this.options.openPaneLink ?? RuntimePaneLink.open.bind(RuntimePaneLink))({
        directory: this.options.store.directory, server: this.credentials!.server, machineId: this.credentials!.machineId,
        ...(this.options.credentialProfilesRoot ? { credentialRoot: this.options.credentialProfilesRoot } : {}),
        online: () => !this.stopped && this.online(), maxAgents: () => this.machinePaneLimit, epoch: () => this.paneEpoch, output, mcp: (body, current) => this.paneMcp(body, current),
      })).then(host => this.paneHost = host);
      const opening = this.paneOpening;
      void opening.catch(() => { if (this.paneOpening === opening) this.paneOpening = null; });
    }
    return this.paneOpening;
  }
  private paneMcp(raw: PaneMcpBody, current: () => boolean): Promise<unknown> { return this.activity.run(() => this.forwardPaneMcp(raw, current)); }
  private forwardPaneMcp(raw: PaneMcpBody, current: () => boolean): Promise<unknown> {
    const body = validatePaneMcpBody(raw), epoch = this.paneEpoch;
    if (!current() || !this.online() || this.pendingPaneTools.size >= 32) return Promise.reject(Error("Pane MCP transport is unavailable"));
    const id = randomUUID();
    return new Promise((accept, reject) => {
      const timer = setTimeout(() => { this.pendingPaneTools.delete(id); reject(Error("Pane MCP response is unconfirmed")); }, 85_000); timer.unref();
      this.pendingPaneTools.set(id, { timer, reject, accept: value => current() && this.online() && this.paneEpoch === epoch ? accept(value) : reject(Error("Pane MCP lease expired")) });
      try { this.send({ v: 1, type: "pane.tool.request", id, body }); }
      catch { this.pendingPaneTools.delete(id); clearTimeout(timer); reject(Error("Pane MCP response is unconfirmed")); }
    });
  }
  private update(task: WindowsCliTask): void {
    if (this.closed) return;
    const serialized = JSON.stringify(task);
    if (this.snapshots.get(task.id) === serialized) return;
    try {
      const job = this.options.store.update(task); this.snapshots.set(task.id, serialized); this.publish(job);
      if (task.finishedAt) { this.active.delete(task.id); this.activeProfiles.delete(task.id); this.closeMcp(task.id); }
    } catch {
      // A process whose state could not be committed must not continue accepting commands.
      this.report("Runtime execution state could not be saved. Stop and inspect the private runtime profile.");
      try { this.bridge.cancel(task.id); } catch { /* leave durable accepted state blocked */ }
      this.socket?.close(1011, "Runtime storage failed");
    }
  }
  private poll(): void { for (const id of this.active) { const task = this.bridge.get(id); if (task) this.update(task); } }
  /** Which profile a run uses: the one the agent named, else this pairing's default (Claude Code only), else none (the Runtime's own environment). */
  private credentialProfileFor(cli: string, named: string | undefined): string | undefined {
    if (named !== undefined) return named;
    return cli === "claude-code" && this.options.credentialProfilesRoot ? this.options.store.credentialDefault() : undefined;
  }
  private stamp(): string { return credentialCacheStamp(this.options.credentialProfilesRoot!, join(this.options.store.directory, "credential-default.json")); }
  /**
   * Re-report on its own after `agend-runtime login` / `profile default` (run in another window) changed the sign-in cache: the account shown
   * in AgEnD follows a profile that was signed in to another account, without an administrator pressing "Detect again". Reads the cache only.
   */
  private watchCredentialCache(): void {
    if (!this.options.credentialProfilesRoot) return;
    this.credentialStamp = this.stamp();
    this.credentialWatch = setInterval(() => {
      if (!this.activity.accepting) return;
      const now = this.stamp(); if (now === this.credentialStamp) return;
      this.credentialStamp = now; void this.refreshInventory(false).catch(() => {});
    }, this.options.credentialWatchMs ?? 5000);
    this.credentialWatch.unref?.();
  }
  private statusOf(cli: CredentialProfileCli, directory: string): Promise<CredentialProfileAnswer> {
    if (this.options.credentialStatus) return this.options.credentialStatus(cli, directory);
    if (this.options.credentialLogin) return this.options.credentialLogin(cli, directory).then(loggedIn => ({ loggedIn }));
    return probeCredentialProfileStatus(cli, directory);
  }
  private remember(root: string, cli: CredentialProfileCli, name: string, answer: CredentialProfileAnswer): void {
    rememberCredentialStatus(root, cli, name, answer); this.credentialStamp = this.stamp();   // our own write is not "another window"
  }
  /** The folder of a profile that exists AND is signed in on this computer; anything else refuses, never the default account. */
  private async credentialHome(cli: string, name: string): Promise<string> {
    const root = this.options.credentialProfilesRoot;
    if (!root) throw new Error("This Runtime has no credential profile folder, so it cannot select an account. Update or restart the Runtime.");
    if (!isCredentialProfileCli(cli)) throw new Error("Credential profiles on a Windows Runtime support Claude Code only");
    const directory = requireCredentialProfile(root, cli, name);
    const answer = await this.statusOf(cli, directory);
    this.remember(root, cli, name, answer);
    if (answer.loggedIn !== true) throw credentialLoginRequired(cli, name, answer.loggedIn);
    return directory;
  }
  /** Names and signed-in yes/no only. `force` (an explicit "Detect again") asks each profile's CLI; otherwise the last known answer is reported. */
  private async credentialReport(force: boolean): Promise<CredentialProfileReport | undefined> {
    const root = this.options.credentialProfilesRoot; if (!root) return undefined;
    if (force) for (const name of listCredentialProfileNames(root, "claude-code")) {
      try { this.remember(root, "claude-code", name, await this.statusOf("claude-code", requireCredentialProfile(root, "claude-code", name))); }
      catch { this.remember(root, "claude-code", name, { loggedIn: null }); }
    }
    let name: string | undefined; try { name = this.options.store.credentialDefault(); } catch { /* reported as no default; a run refuses with the real error */ }
    return credentialProfileReport(root, name);
  }
  private computerBoot: Promise<string | undefined> | undefined;
  /** The computer's boot identity, read once (it cannot change while this Runtime runs). Unknown is never evidence either way. */
  private systemBoot(): Promise<string | undefined> { return this.computerBoot ??= (this.options.remoteAccounts?.systemBootId ?? readPaneSystemBootId)().catch(() => undefined); }
  /**
   * Whether a task or terminal is running under this profile (case-insensitively: on Windows `Work` and `work` are one folder). Terminals come from the
   * pane ledgers (`paneLedgerFiles`: the pane host's own state folder in production, the in-process folder in tests; a missing ledger is "none").
   * A row recorded under another boot of the computer is a terminal that cannot still be running (the pane store treats it the same way), so a restart
   * does not leave it in the way. A ledger that cannot be read, or a default profile that cannot be read while a terminal needs it, is `unknown`: the
   * caller refuses with a message that says the state could not be confirmed, not that a terminal is running. A Claude Code terminal that names no
   * profile runs under this pairing's default, which the ledger does not hold.
   */
  private async profileInUse(name: string): Promise<"task" | "pane" | "unknown" | undefined> {
    const same = (other: unknown): boolean => typeof other === "string" && other.toLowerCase() === name.toLowerCase();
    for (const used of this.activeProfiles.values()) if (same(used)) return "task";
    let fallback: string | undefined, fallbackReadable = true; try { fallback = this.options.store.credentialDefault(); } catch { fallbackReadable = false; }
    let boot: string | undefined, bootRead = false, unknown = false;
    for (const file of paneLedgerFiles(this.options.store.directory)) {
      try {
        const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
        for (const row of object(raw) && object(raw.panes) ? Object.values(raw.panes) : []) {
          const launch = object(row) && object(row.launch) ? row.launch : undefined, snapshot = object(row) && object(row.snapshot) ? row.snapshot : undefined;
          if (!launch || snapshot?.state === "exited") continue;
          if (typeof (row as { systemBootId?: unknown }).systemBootId === "string") {
            if (!bootRead) { boot = await this.systemBoot(); bootRead = true; }
            if (boot && boot !== (row as { systemBootId: string }).systemBootId) continue;
          }
          if (same(launch.credentialProfile)) return "pane";
          if (launch.credentialProfile === undefined && launch.cli === "claude-code") { if (!fallbackReadable) unknown = true; else if (same(fallback)) return "pane"; }
        }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") unknown = true; }
    }
    return unknown ? "unknown" : undefined;
  }
  /** #3190 Part 3a: the remote account operations (switches, sign-in, sign-out, remove, install), built on first use. */
  private remote(): RemoteAccounts {
    const root = this.options.credentialProfilesRoot, extra = this.options.remoteAccounts;
    if (!root) throw new Error("This Runtime has no credential profile folder, so it cannot manage accounts. Update or restart the Runtime.");
    if (process.platform !== "win32" && !extra) throw new Error("Managing accounts from AgEnD needs native Windows Node, under the Windows user whose Claude Code this Runtime uses.");
    return this.remoteAccounts ??= new RemoteAccounts({
      pairingDirectory: this.options.store.directory, credentialRoot: root,
      status: (cli, directory) => this.statusOf(cli, directory),
      find: extra?.find ?? ((cli) => findCli(cli)),
      environment: extra?.environment ?? (() => nativeCliEnvironment()),
      runLogout: extra?.runLogout ?? ((executable, args, env) => new Promise(done => {
        // Output is not read, kept or logged: only whether the command ended well.
        const child = childSpawn(executable.command, [...executable.args, ...args], { env, shell: false, stdio: "ignore", windowsHide: true });
        const timer = setTimeout(() => { child.kill(); done(null); }, 30_000); timer.unref?.();
        child.on("error", () => { clearTimeout(timer); done(null); }); child.on("close", code => { clearTimeout(timer); done(code); });
      })),
      inUse: name => this.profileInUse(name), report: text => this.report(text),
      defaultProfile: () => { try { return this.options.store.credentialDefault(); } catch { return undefined; } },
      changed: () => { this.credentialStamp = this.stamp(); void this.refreshInventory(false).catch(() => {}); },
      // Native Windows installs from the Runtime's own closed table (3b); a test supplies its own installer.
      ...(extra?.installer ? { installer: extra.installer } : this.managed ? { installer: this.managed } : {}),
      ...(extra?.switchWatchMs ? { switchWatchMs: extra.switchWatchMs } : {}), ...(extra?.signIn ? { signIn: extra.signIn } : {}), ...(extra?.ownership ? { ownership: extra.ownership } : {}),
      ...(extra?.now ? { now: extra.now } : {}),
    });
  }
  private beginDiscovery(): void {
    void this.refreshInventory().catch(() => this.report("CLI discovery failed; refresh it from AgEnD after checking the local installation."));
    this.watchCredentialCache();
  }
  private refreshInventory(force = false): Promise<WindowsCliProbe> { return this.activity.run(() => this.readInventory(force)); }
  private async readInventory(force: boolean): Promise<WindowsCliProbe> {
    const probed = await this.bridge.probe({ force }), credentialProfiles = await this.credentialReport(force);
    const inventory = credentialProfiles ? { ...probed, credentialProfiles } : probed;
    this.inventory = inventory;
    if (this.online()) this.send({ v: 1, type: "inventory", inventory });
    return inventory;
  }
  /** Testable command surface. Mutation identity is committed before calling the native bridge. */
  operation(operation: string, payload: Record<string, unknown>): Promise<unknown> { return this.activity.run(() => this.ownedOperation(operation, payload)); }
  private async ownedOperation(operation: string, payload: Record<string, unknown>): Promise<unknown> {
    if (operation === "probe") {
      if (Object.keys(payload).some(key => key !== "force") || (payload.force !== undefined && typeof payload.force !== "boolean")) throw new Error("Invalid discovery request");
      return this.refreshInventory(payload.force === true);
    }
    if (operation === "workspace") {
      if (Object.keys(payload).some(key => key !== "agentId") || !validWindowsAgentId(payload.agentId)) throw new Error("Invalid workspace request");
      return { agentId: payload.agentId, cwd: await this.bridge.prepareWorkspace(payload.agentId) };
    }
    if (operation === "reconcile") {
      if (Object.keys(payload).length) throw new Error("Invalid reconciliation request");
      return { jobs: this.options.store.list().map(row => ({ seq: row.seq, task: row.task })) };
    }
    if (operation === "cancel" || operation === "recover") {
      if (typeof payload.runId !== "string" || Object.keys(payload).some(key => !["runId", ...(operation === "recover" ? ["confirmedStopped", "original"] : [])].includes(key))) throw new Error("Invalid execution operation");
      const stored = this.options.store.get(payload.runId);
      if (operation === "recover") {
        if (this.active.has(payload.runId)) throw new Error("The native execution is still connected; wait for cancellation");
        if (payload.confirmedStopped !== true) throw new Error("Confirm the execution stopped before recovery");
        const original = payload.original === undefined ? null : checkedRun(payload.original);
        if (original && original.task.requestId !== payload.runId) throw new Error("Recovery execution identity does not match the original run");
        const digest = original ? runtimeJobDigest(original) : null;
        if (stored && digest && stored.digest !== digest) throw new Error("Recovery arguments do not match the accepted execution");
        if (!stored) {
          if (!original || !digest) throw new Error("Unknown execution recovery needs its trusted original run");
          if (this.active.size) throw new Error("Wait for the active native execution before recovery");
          const task = original.task;
          // The coordinator may have durably submitted a run that never reached this client. Explicit manual
          // confirmation creates a terminal tombstone, never an execution, so a delayed retry cannot launch it.
          const accepted = this.options.store.accept({ id: task.requestId, cli: task.cli, cwd: task.cwd, sandbox: task.sandbox,
            ...(task.model ? { model: task.model } : {}), status: "failed", startedAt: Date.now(), finishedAt: Date.now(),
            outcomeConfirmed: true, output: "", error: "The unconfirmed execution was manually confirmed stopped before local acceptance; it will not be replayed." }, digest);
          this.publish(accepted.job); return accepted.job.task;
        }
        if (stored.task.finishedAt && stored.task.outcomeConfirmed === true) return stored.task;
        this.bridge.releaseUnknown(payload.runId);
        const job = this.options.store.recover(payload.runId, true); this.publish(job); return job.task;
      }
      if (!stored) throw new Error("Runtime execution not found");
      if (!this.active.has(payload.runId)) return stored.task;
      const task = this.bridge.cancel(payload.runId); this.update(task); return task;
    }
    if (operation !== "run") throw new Error("Unknown runtime operation");
    const run = checkedRun(payload), task = run.task;
    const digest = runtimeJobDigest(run);
    const accepted = this.options.store.accept({ id: task.requestId, cli: task.cli, cwd: task.cwd, sandbox: task.sandbox,
      ...(task.model ? { model: task.model } : {}), status: "starting", startedAt: Date.now(), output: "" }, digest);
    if (accepted.duplicate) return accepted.job.task;
    this.publish(accepted.job);
    try {
      // Fail closed, and as a confirmed failed turn: an unknown, unsigned or unusable profile never falls back to another account.
      const profile = this.credentialProfileFor(task.cli, run.credentialProfile);
      if (profile) this.activeProfiles.set(task.requestId, profile);
      const credentialHome = profile ? await this.credentialHome(task.cli, profile) : undefined;
      const mcp = payload.mcp ? await this.openMcp(task.requestId, (payload.mcp as { tools: string[] }).tools) : undefined;
      if (this.stopped || !this.online()) throw new Error("Runtime disconnected before native execution started");
      this.active.add(task.requestId);
      const initial = this.bridge.start(task, () => !this.stopped && this.online(), {
        ...(payload.resumeSessionId ? { resumeSessionId: payload.resumeSessionId as string } : {}),
        ...(payload.context ? { context: payload.context as string } : {}), ...(mcp ? { mcp } : {}), ...(credentialHome ? { credentialHome } : {}),
        onSettled: settled => this.update(settled),
      });
      this.update(initial); return this.options.store.get(task.requestId)!.task;
    } catch (error) {
      this.active.delete(task.requestId); this.activeProfiles.delete(task.requestId); this.closeMcp(task.requestId);
      const failed = { ...accepted.job.task, status: "failed" as const, error: message(error), finishedAt: Date.now(), outcomeConfirmed: true };
      this.update(failed); return failed;
    }
  }
  private locallyIdle(): boolean {
    return this.activity.pending === 0 && this.active.size === 0 && !this.options.store.blocked()
      && this.bridge.idleForUpdate?.() === true && this.pendingTools.size === 0 && this.pendingPaneTools.size === 0
      && !(this.paneOpening && !this.paneHost) && (this.socket?.bufferedAmount ?? 1) === 0;
  }
  private updateRpc(phase: RuntimeUpdateClientPhase, id: string, phases: RuntimeUpdateServerPhase[]): Promise<RuntimeUpdateServerPhase> {
    if (!this.welcomed || !this.updateProtocol || this.socket?.readyState !== WebSocket.OPEN || this.updateWait) return Promise.reject(Error("Runtime update negotiation is unavailable"));
    return new Promise((accept, reject) => {
      const pending = { id, phases, accept, reject, timer: setTimeout(() => {
        if (this.updateWait === pending) this.updateWait = undefined;
        reject(Error("Runtime update acknowledgement is unconfirmed"));
      }, 10_000) };
      pending.timer.unref(); this.updateWait = pending;
      try { this.send({ v: 1, type: "update.control", id, bootId: this.bootId, generation: this.generation, phase }); }
      catch (error) { this.updateWait = undefined; clearTimeout(pending.timer); reject(error); }
    });
  }
  /** Called only by the local supervisor. A timeout or disconnect never authorizes process replacement. */
  async prepareUpdate(id: string): Promise<boolean> {
    if (!validRuntimeUpdateId(id) || !this.options.managedUpdate || this.trialFence || this.preparingUpdate || !this.online() || !this.updateProtocol) return false;
    const socket = this.socket!, generation = this.generation;
    const current = () => !this.stopped && this.socket === socket && socket.readyState === WebSocket.OPEN && this.generation === generation;
    const fence = this.activity.tryFence(id, current, () => this.locallyIdle());
    if (!fence) return false;
    this.preparingUpdate = true; let committed = false;
    try {
      if (await this.updateRpc("prepare", id, ["prepared", "busy", "cancelled"]) !== "prepared") return false;
      if (this.options.drainPaneHostForUpdate) await this.options.drainPaneHostForUpdate(() => fence.current());
      else {
        const { RuntimePaneLink } = await import("./runtime-pane-link.js");
        const existing = this.paneHost instanceof RuntimePaneLink && this.paneHost.connected() ? this.paneHost : undefined;
        if (!existing && (this.options.createPaneHost || this.options.openPaneLink)) throw Error("Injected pane host requires its own positive idle proof");
        await RuntimePaneLink.drainExistingForUpdate({ directory: this.options.store.directory, server: this.credentials!.server, machineId: this.credentials!.machineId,
          online: () => current(), maxAgents: () => this.machinePaneLimit, epoch: () => this.paneEpoch, mcp: (body, owned) => this.paneMcp(body, owned) }, () => fence.current(), existing);
      }
      if (!fence.current() || !this.locallyIdle()) return false;
      if (await this.updateRpc("ready", id, ["commit", "busy", "cancelled"]) !== "commit") return false;
      fence.commit(); committed = true;
      await this.stop(); return true;
    } catch (error) { if (committed) throw error; return false; }
    finally {
      this.preparingUpdate = false;
      if (!committed) {
        try { if (!current() || await this.updateRpc("cancel", id, ["cancelled", "commit"]) !== "cancelled") socket.terminate(); }
        catch { socket.terminate(); }
        fence.release();
      }
    }
  }
  /** The parent persists activation intent before this call; an unconfirmed answer is never rollback permission. */
  async activateTrial(id: string): Promise<boolean> {
    if (this.trialFence?.id !== id || !this.locallyIdle()) return false;
    return await this.updateRpc("activate", id, ["activated", "busy", "cancelled"]) === "activated";
  }
  private async openMcp(runId: string, tools: string[]): Promise<NativeMcpConnection> {
    if (!this.mcpOpening) this.mcpOpening = new Promise<number>((accept, reject) => {
      const server = this.mcpServer = createServer((req, res) => {
        const reply = (status: number, value: unknown): void => { if (!res.writableEnded && !res.destroyed) { res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(value)); } };
        const header = req.headers["x-agend-native-token"];
        const entry = typeof header === "string" && /^[a-f0-9]{64}$/.test(header) ? this.mcpTokens.get(header) : undefined;
        if (req.method !== "POST" || req.url !== "/agent" || req.headers.origin !== undefined || req.headers.cookie !== undefined
          || !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress ?? "") || !entry
          || !this.active.has(entry.runId) || !this.online()) { req.resume(); reply(403, { error: "Runtime MCP capability is unavailable" }); return; }
        let leave: () => void;
        try { leave = this.activity.enter(); } catch { req.resume(); reply(503, { error: "Runtime update is pending" }); return; }
        const finished = new Promise<void>(done => {
          const settle = () => { res.off("finish", settle); res.off("close", settle); done(); };
          res.once("finish", settle); res.once("close", settle);
          if (res.destroyed || res.writableFinished) settle();
        });
        void jsonBody(req).then(async body => {
          if (!object(body) || body.op !== "native-mcp" || !["tools/list", "tools/call"].includes(String(body.method))
            || !object(body.params) || Object.keys(body).some(key => !["op", "method", "params", "callId"].includes(key))) throw new Error("Invalid runtime MCP request");
          if (body.method === "tools/call" && (!entry.tools.includes(String(body.params.name)) || !object(body.params.arguments)
            || typeof body.callId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(body.callId))) throw new Error("Runtime MCP tool is unavailable");
          const result = await this.toolCall(entry.runId, body);
          if (!this.active.has(entry.runId) || !this.online()) { reply(401, { error: "Runtime MCP capability expired" }); return; }
          if (Buffer.byteLength(JSON.stringify(result) ?? "") > MAX_TOOL) throw new Error("Runtime MCP result is too large");
          reply(200, result);
        }).catch(() => reply(403, { error: "Runtime MCP request was refused or its execution expired" })).finally(async () => { await finished; leave(); });
      });
      server.on("error", reject);
      server.listen(0, "127.0.0.1", () => { const address = server.address(); if (!address || typeof address === "string") { reject(new Error("Runtime MCP could not bind")); return; } this.mcpPort = address.port; accept(address.port); });
    });
    await this.mcpOpening;
    const token = randomBytes(32).toString("hex"); this.mcpTokens.set(token, { runId, tools: [...tools] });
    return { endpoint: `http://127.0.0.1:${this.mcpPort}/agent`, token, tools: [...tools] };
  }
  private closeMcp(runId: string): void { for (const [token, entry] of this.mcpTokens) if (entry.runId === runId) this.mcpTokens.delete(token); }
  private toolCall(runId: string, body: unknown): Promise<unknown> {
    if (!this.online()) return Promise.reject(new Error("Runtime is disconnected"));
    if (this.pendingTools.size >= 64) return Promise.reject(new Error("Runtime MCP call capacity reached"));
    const id = randomUUID();
    return new Promise((accept, reject) => {
      const timer = setTimeout(() => { this.pendingTools.delete(id); reject(new Error("AgEnD MCP request timed out")); }, 90_000); timer.unref?.();
      this.pendingTools.set(id, { accept, reject, timer });
      this.send({ v: 1, type: "tool.call", id, runId, body });
    });
  }
  private rejectTools(): void {
    for (const pending of this.pendingPaneTools.values()) { clearTimeout(pending.timer); pending.reject(Error("Pane MCP disconnected; no call was replayed")); }
    this.pendingPaneTools.clear();
    for (const pending of this.pendingTools.values()) { clearTimeout(pending.timer); pending.reject(new Error("Runtime disconnected")); } this.pendingTools.clear(); }
  stop(options:{retirePanes?:boolean}={}): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    if (this.stopped) return Promise.resolve();
    this.stopped = true; this.welcomed = false;
    this.installAbort.abort();
    this.activity.close();
    // Own cleanup before callbacks (bridge.close, pane cleanup) can re-enter stop().
    return this.stopPromise = Promise.resolve().then(() => this.stopOwned(options));
  }
  private async stopOwned(options:{retirePanes?:boolean}): Promise<void> {
    if (this.updateWait) { const pending = this.updateWait; this.updateWait = undefined; clearTimeout(pending.timer); pending.reject(Error("Runtime update stopped")); }
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.graceTimer) clearTimeout(this.graceTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.credentialWatch) clearInterval(this.credentialWatch);
    this.reconnectTimer = null; this.graceTimer = null; this.pollTimer = null; this.credentialWatch = null;
    this.rejectTools(); this.mcpTokens.clear(); this.bridge.close();
    const socket = this.socket; this.socket = null;
    if (socket) { socket.close(); if (socket.readyState !== WebSocket.CLOSED) socket.terminate(); }
    // A cancelled start may still finish its durable credential write. Do not release the profile to another writer.
    await this.startupRotation?.catch(() => {});
    // A sign-in that is open ends with the connection (its child is killed), and the folded counts of the audit log are written.
    await this.remoteAccounts?.stop().catch(() => {});
    await this.paneOpening?.then(async host=>{
      try{if(options.retirePanes&&"retireOwned" in host)await host.retireOwned();}
      finally{await host.stop();}
    }).catch(() => this.report("Pane cleanup is unconfirmed; its durable reservations remain held."));
    // Keep the profile lock until cancellation is confirmed or the journal is explicitly marked uncertain.
    const deadline = Date.now() + 5000;
    while (this.active.size && Date.now() < deadline) {
      this.poll();
      if (!this.active.size) break;
      await new Promise<void>(done => setTimeout(done, 50));
    }
    for (const id of this.active) {
      const old = this.options.store.get(id);
      if (old) this.update({ ...old.task, status: "failed", finishedAt: Date.now(), outcomeConfirmed: false,
        error: "Runtime stopped before native process shutdown was confirmed. Inspect processes before recovery." });
    }
    if (this.mcpServer) { const server = this.mcpServer; this.mcpServer = null; server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); }
    this.unlock?.(); this.unlock = null;
    this.closed = true;
    for (const done of this.stoppedListeners) done(); this.stoppedListeners.clear();
  }
}

async function post(server: URL, path: string, body: unknown, signal?: AbortSignal, credential?: string): Promise<{ status: number; data: Record<string, unknown> }> {
  const response = await fetch(new URL(path, server), { method: "POST", redirect: "error", headers: { "Content-Type": "application/json", ...(credential ? { Authorization: `Bearer ${credential}` } : {}) },
    body: JSON.stringify(body), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000) });
  let text = "", bytes = 0;
  if (response.body) for await (const part of response.body) { bytes += part.byteLength; if (bytes > MAX_TOOL) throw new Error("Runtime pairing response is too large"); text += new TextDecoder().decode(part); }
  let data: unknown; try { data = JSON.parse(text); } catch { throw new Error("Invalid runtime pairing response"); }
  if (!object(data)) throw new Error("Invalid runtime pairing response");
  return { status: response.status, data };
}
/** Caller holds the profile lock. Persist the candidate before wire; either credential can recover a lost response. */
export async function rotateRuntimeCredentials(input: { store: RuntimeClientStore; signal?: AbortSignal }): Promise<RuntimeCredentials> {
  let saved = input.store.credentials(); if (!saved) throw Error("Pair this runtime before rotating its credential");
  if (!saved.pendingCredential) {
    saved = { ...saved, pendingCredential: randomBytes(32).toString("hex") };
    input.store.saveCredentials(saved);
  }
  const server = validateRuntimeServer(saved.server), candidate = saved.pendingCredential!;
  for (const credential of [saved.credential, candidate]) {
    const response = await post(server, RUNTIME_ROTATE_PATH, { machineId: saved.machineId, credential: candidate }, input.signal, credential);
    if (response.status === 200 && response.data.status === "rotated" && response.data.machineId === saved.machineId) {
      const { pendingCredential: _, ...current } = saved;
      const completed = { ...current, credential: candidate }; input.store.saveCredentials(completed); return completed;
    }
    if (response.status !== 401 && response.status !== 429) break;
  }
  throw Error("Runtime credential rotation was not confirmed. The saved candidate is retained; retry rotate before connecting.");
}
export async function pairRuntime(input: { server: string; code: string; name: string; store: RuntimeClientStore; signal?: AbortSignal; report?: (text: string) => void; pollMs?: number }): Promise<RuntimeCredentials> {
  const server = validateRuntimeServer(input.server);
  if (!input.code.trim() || input.code.length > 256 || /[\x00-\x1f]/.test(input.code) || !input.name.trim() || input.name.length > 100) throw new Error("Enter a valid pairing code and machine name");
  input.store.assertCanPair();
  const paired = await post(server, "/runtime/v1/pair", { code: input.code.trim(), name: input.name.trim(), platform: process.platform, hostname: hostname() }, input.signal);
  if (paired.status !== 201 || paired.data.status !== "pending" || typeof paired.data.machineId !== "string" || typeof paired.data.claimSecret !== "string") throw new Error(`Runtime pairing was refused (HTTP ${paired.status})`);
  const deadline = Math.min(Date.now() + 10 * 60_000, typeof paired.data.expiresAt === "number" ? paired.data.expiresAt : Infinity);
  const fingerprint = runtimeClaimFingerprint(paired.data.claimSecret);
  input.report?.(`Pairing fingerprint: ${fingerprint}. Compare it with AgEnD Settings → Runtime before approving this machine; waiting for approval…`);
  while (!input.signal?.aborted && Date.now() < deadline) {
    const claimed = await post(server, "/runtime/v1/claim", { machineId: paired.data.machineId, claimSecret: paired.data.claimSecret }, input.signal);
    if (claimed.status === 200 && claimed.data.status === "approved" && claimed.data.machineId === paired.data.machineId
      && typeof claimed.data.credential === "string" && /^[A-Za-z0-9._-]{16,256}$/.test(claimed.data.credential)) {
      const credentials = { server: server.origin, machineId: paired.data.machineId, credential: claimed.data.credential, name: input.name.trim() };
      // Save first: the one-time credential cannot be issued again. A ledger that changed since the check above is reported after it is safe.
      input.store.saveCredentials(credentials);
      try { input.store.adoptMachine(credentials.machineId, true); }
      catch (error) { throw new Error(`The computer was paired and its credential is saved. ${error instanceof Error ? error.message : "Its job ledger could not be updated."}`); } input.report?.("Runtime paired. Its machine credential was saved in the private local profile."); return credentials;
    }
    if (claimed.status !== 202 || claimed.data.status !== "pending") throw new Error(`Runtime approval was refused or expired (HTTP ${claimed.status})`);
    await new Promise<void>((accept, reject) => {
      const timer = setTimeout(() => { input.signal?.removeEventListener("abort", abort); accept(); }, input.pollMs ?? 1500);
      const abort = (): void => { clearTimeout(timer); reject(new Error("Runtime pairing cancelled")); };
      input.signal?.addEventListener("abort", abort, { once: true });
    });
  }
  throw new Error(input.signal?.aborted ? "Runtime pairing was cancelled" : "Runtime pairing expired before the computer was approved. Open AgEnD Settings -> Runtime, then double-click connect-agend.bat again and enter a new pairing code.");
}

import type {} from "./runtime-pane-stdio.js";
