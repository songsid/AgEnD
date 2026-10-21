/**
 * Cloudflare quick/named connectors as a transport, and only a transport.
 *
 * The URL this produces is not a credential and nothing here authorizes
 * anything. What it must get right is narrower and harder: never run a shell,
 * never hand the child an environment it does not need, never believe a word of
 * its output that has not been through the validator, and never report a death
 * it has not proven.
 *
 * Verified flag shape against cloudflared's documented Quick Tunnel invocation;
 * `--config /dev/null` is load-bearing, because Cloudflare's own docs say a
 * `~/.cloudflared/config.yaml` can stop quick tunnels working, and we cannot
 * assume the operator's home is empty.
 */
import { publicTunnelHostname, validPublicTunnelToken } from "../public-tunnel-config.js";
import { spawn, type ChildProcess } from "node:child_process";
import { accessSync, constants as fsConstants } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { probeProcess } from "../web-terminal.js";
import { fetchViaPublicResolver, fetchViaSystemResolver, type ProbeResponse } from "./public-fetch.js";
import { classifyNamedTunnelOutput, classifyNamedTunnelProbeError, namedTunnelFailureMessage, type NamedTunnelFailureKind } from "./named-diagnostics.js";
import {
  TunnelStartError,
  TUNNEL_STARTUP_DEADLINE_MS,
  TUNNEL_STOP_GRACE_MS,
  type PreflightResult,
  type TunnelExit,
  type TunnelHandle,
  type TunnelProvider,
  type TunnelStartContext,
  type TunnelStopResult,
} from "./types.js";

/** A Quick Tunnel hostname is one label under trycloudflare.com. Nothing else. */
const QUICK_TUNNEL_HOST = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.trycloudflare\.com$/;

/**
 * Everything the child is allowed to inherit.
 *
 * It would otherwise get the whole environment of the shell that ran
 * `agend setup`, which on a developer machine routinely holds cloud
 * credentials. A tunnel needs to reach the internet; it does not need
 * AWS_SECRET_ACCESS_KEY to do it.
 */
const ENV_ALLOW_LIST = [
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY",
  "http_proxy", "https_proxy", "no_proxy",
  "SSL_CERT_FILE", "SSL_CERT_DIR",
] as const;

export function minimalChildEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const key of ENV_ALLOW_LIST) {
    const value = env[key];
    if (typeof value === "string" && value !== "") out[key] = value;
  }
  return out;
}

/**
 * The one URL shape this provider will accept.
 *
 * Strict on purpose, and against the whole token rather than a match inside it:
 * `https://evil.example/?next=https://x.trycloudflare.com/` contains a perfectly
 * good quick-tunnel URL and must still be refused, because what the child
 * actually printed was a link to evil.example.
 */
export function validateQuickTunnelUrl(candidate: string, configuredHostname?: string): string | null {
  if (candidate.length > (configuredHostname ? 261 : 200)) return null;
  // Control characters never appear in a URL; their presence means the token
  // came out of an escape sequence or a mangled line, not a URL.
  if (/[\u0000-\u001f\u007f]/.test(candidate)) return null;
  let url: URL;
  try { url = new URL(candidate); } catch { return null; }
  if (url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  if (url.port) return null;
  if (url.search || url.hash) return null;
  if (url.pathname !== "/") return null;
  if (!QUICK_TUNNEL_HOST.test(url.hostname) && (!configuredHostname || publicTunnelHostname(configuredHostname) !== url.hostname)) return null;
  return `https://${url.hostname}`;
}

/**
 * Pull candidate URLs out of a chunk of child output.
 *
 * Whatever a token is, it has to be the *complete* thing the child printed —
 * validating a fragment is how `https://evil.example/?u=https://x.trycloudflare.com/`
 * becomes acceptable. So the two output shapes are handled as what they are
 * rather than smashed through one splitter:
 *
 * - A JSON log line is parsed as JSON, and each string value is a whole token.
 *   Splitting it on quotes and commas instead would pull a hostname out of a
 *   query string and call it the tunnel.
 * - Plain text is split on whitespace and `|` only, because that is what
 *   cloudflared draws its box with and neither can occur inside a URL. Quotes
 *   and commas are deliberately NOT separators: they can appear in a URL, so
 *   splitting on them shortens a hostile token into an acceptable one.
 */
/** How long an exit before a URL waits for cloudflared's last output to arrive (#1767). */
const OUTPUT_DRAIN_MS = 250;

/**
 * #1767: why cloudflared exited before printing a tunnel URL, from what it printed. `quick tunnel provisioning failed
 * with status 429` is Cloudflare rate-limiting new quick tunnels for this network; another status is a refused
 * provisioning; anything else keeps cloudflared's last line as the detail (logs only — never shown in a chat).
 */
export function exitBeforeUrl(output: string): TunnelStartError {
  const status = /quick tunnel provisioning failed with status (\d{3})/i.exec(output)?.[1];
  if (status === "429") return new TunnelStartError("rate-limited", "Cloudflare refused a new quick tunnel: HTTP 429 (rate limited)");
  if (status) return new TunnelStartError("provisioning-failed", `Cloudflare refused a new quick tunnel: HTTP ${status}`);
  const last = lastOutputLine(output);
  return new TunnelStartError("no-url", `cloudflared exited before printing a tunnel URL${last ? `: ${last}` : ""}`);
}

/** cloudflared's last non-empty output line, without colour codes, URLs or control characters, at most 200 chars. */
export function lastOutputLine(output: string): string {
  const lines = output.replace(/\x1b\[[0-9;]*m/g, "").split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const last = lines.at(-1) ?? "";
  return last.replace(/https?:\/\/\S+/g, "<url>").replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 200);
}

export function extractTunnelUrl(text: string): string | null {
  // Strip ANSI first so colouring around the URL does not become part of it.
  const plain = text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");
  for (const line of plain.split(/\r?\n/)) {
    const found = jsonLineUrl(line) ?? plainLineUrl(line);
    if (found) return found;
  }
  return null;
}

function plainLineUrl(line: string): string | null {
  for (const token of line.split(/[\s|]+/)) {
    const valid = validateQuickTunnelUrl(token);
    if (valid) return valid;
  }
  return null;
}

/** Depth-bounded: a log line is not a place to walk an arbitrary object graph. */
function jsonLineUrl(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(trimmed); } catch { return null; }
  const walk = (value: unknown, depth: number): string | null => {
    if (depth > 4) return null;
    if (typeof value === "string") return validateQuickTunnelUrl(value);
    if (Array.isArray(value)) {
      for (const item of value) { const hit = walk(item, depth + 1); if (hit) return hit; }
      return null;
    }
    if (value && typeof value === "object") {
      for (const item of Object.values(value)) { const hit = walk(item, depth + 1); if (hit) return hit; }
      return null;
    }
    return null;
  };
  return walk(parsed, 0);
}

/** Bounded: a child that never prints a URL must not grow our memory. */
const MAX_BUFFERED_OUTPUT = 64 * 1024;

export function resolveBinary(name: string, env: NodeJS.ProcessEnv): string | null {
  if (name.includes("/")) return isAbsolute(name) ? name : null;
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    try {
      accessSync(candidate, fsConstants.X_OK);
      return candidate;
    } catch { /* keep looking */ }
  }
  return null;
}

/**
 * How cloudflared reaches Cloudflare's edge.
 *
 * `http2` is the default because QUIC (UDP 7844) is blocked on many corporate
 * networks and VMs, and when it is blocked cloudflared spends a long time
 * failing over before it connects — or never does. http2 is TCP to the same
 * edge port number (7844, per Cloudflare's firewall documentation), which
 * networks that drop the UDP usually allow — but it is still an outbound port
 * a strict firewall can close, so "HTTPS works" does not imply it. `quic` and
 * `auto` (cloudflared's own choice) are for networks where that is known to be
 * better.
 */
export type CloudflaredProtocol = "http2" | "quic" | "auto";

export interface CloudflaredOptions {
  binaryName?: string;
  /** Dashboard-only remotely managed connector. Never put token in argv/errors. */
  named?: { hostname: string; token: string };
  protocol?: CloudflaredProtocol;
  /** Public resolvers the readiness probe asks first. Empty disables that path (system DNS only). */
  publicResolvers?: readonly string[];
  /** Test seam: the system-resolver fallback's fetch (the default path has to be bounded too). */
  fetchImpl?: typeof fetch;
  /** Test seams for the public-resolver probe. */
  resolve4?: (host: string) => Promise<string[]>;
  request?: typeof import("node:https").request;
  /** Test seam: the real one spawns a process. */
  spawnProcess?: typeof spawn;
  /** Test seam for the readiness GET. */
  fetchPage?: (url: string, signal: AbortSignal) => Promise<ProbeResponse>;
  now?: () => number;
  deadlineMs?: number;
  graceMs?: number;
  env?: NodeJS.ProcessEnv;
  /** Test seam: proving a death must be testable without a real process. */
  probe?: typeof probeProcess;
}

export class CloudflaredProvider implements TunnelProvider {
  readonly name = "cloudflared";

  constructor(private readonly opts: CloudflaredOptions = {}) {}

  private get env(): NodeJS.ProcessEnv { return this.opts.env ?? process.env; }
  private get binaryName(): string { return this.opts.binaryName ?? "cloudflared"; }

  async preflight(signal: AbortSignal): Promise<PreflightResult> {
    if (signal.aborted) return { ok: false, errorKind: "cancelled", detail: "cancelled before preflight" };
    const path = resolveBinary(this.binaryName, this.env);
    if (!path) {
      return {
        ok: false,
        errorKind: "binary-missing",
        detail: `${this.binaryName} is not on PATH (and AgEnD's own copy was not provided).`,
      };
    }
    try {
      accessSync(path, fsConstants.X_OK);
    } catch {
      return { ok: false, errorKind: "binary-not-executable", detail: `${path} is not executable` };
    }
    return { ok: true, binaryPath: path };
  }

  async start(ctx: TunnelStartContext): Promise<TunnelHandle> {
    const now = this.opts.now ?? Date.now;
    const deadlineMs = this.opts.deadlineMs ?? TUNNEL_STARTUP_DEADLINE_MS;
    // One budget for spawn, URL and readiness together. Per-step timeouts are
    // how a startup that "never times out" happens: each step resets the clock.
    const deadline = Math.min(now() + deadlineMs, ctx.expiresAt);

    if (ctx.origin.hostname !== "127.0.0.1" || ctx.origin.protocol !== "http:") {
      throw new TunnelStartError("bad-url", `refusing to expose ${ctx.origin.origin}: only http://127.0.0.1:<port> may be tunnelled`);
    }

    const pre = await this.preflight(ctx.signal);
    if (!pre.ok) throw new TunnelStartError(pre.errorKind, pre.detail);

    const named = this.opts.named;
    const namedBase = named ? validateQuickTunnelUrl(`https://${named.hostname}`, named.hostname) : null;
    if (named && (!namedBase || !validPublicTunnelToken(named.token))) throw new TunnelStartError("bad-url", "invalid named tunnel settings");
    const spawnProcess = this.opts.spawnProcess ?? spawn;
    let child: ChildProcess;
    try {
      const protocol = this.opts.protocol ?? "http2";
      child = spawnProcess(pre.binaryPath, [
        "tunnel",
        "--no-autoupdate",
        "--config", "/dev/null",
        ...(protocol === "auto" ? [] : ["--protocol", protocol]),
        ...(named ? ["run"] : ["--url", ctx.origin.origin]),
      ], {
        // No shell, ever: the arguments are fixed and one of them is an origin.
        shell: false,
        env: { ...minimalChildEnv(this.env), ...(named ? { TUNNEL_TOKEN: named.token } : {}) },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      throw new TunnelStartError("spawn-failed", named ? "could not start named tunnel" : `could not start ${this.binaryName}: ${(err as Error).message}`);
    }

    const state = new CloudflaredHandle(child, this.opts);
    let namedReadinessFailure: NamedTunnelFailureKind | undefined;
    try {
      const base = namedBase ?? await state.awaitUrl(deadline, ctx.signal, now);
      const pageUrl = `${base}${ctx.pagePath}`;
      // After the validator, before the probe: cloudflared passes the public
      // Host through to the origin, so the origin has to be expecting it or it
      // will refuse our own readiness check.
      ctx.onCandidateHost?.(new URL(base).host);
      await this.probeReady(pageUrl, ctx, deadline, now, () => state.hasExited, () => state.checkOutput(),
        kind => { namedReadinessFailure = kind; });
      // A probe can succeed against a tunnel that has already died (the edge answers for a while) or been
      // cancelled. Publishing that would hand back a handle whose exit nobody will ever be told about.
      if (ctx.signal.aborted) throw new TunnelStartError("cancelled", "cancelled before the tunnel was published");
      state.checkOutput();
      if (state.hasExited) throw new TunnelStartError("no-url", "cloudflared exited before the tunnel became ready");
      state.publish(base, pageUrl);
      return state;
    } catch (err) {
      // A child exists. Its death has to be proven before this failure can be
      // reported as a clean one, or a fallback would run beside a live tunnel.
      const exitedBeforeStop = state.hasExited;
      const stopped = await state.stop("startup failed");
      // Named connectors can echo credentials in arbitrary vendor diagnostics.
      // None of that output or the underlying spawn/fetch error crosses here.
      if (named) {
        if (exitedBeforeStop) await state.drainOutput();
        const originalKind = err instanceof TunnelStartError ? err.errorKind : "spawn-failed";
        const kind = originalKind === "cancelled" ? originalKind : state.namedFailureKind() ?? namedReadinessFailure ?? originalKind;
        throw new TunnelStartError(kind, namedTunnelFailureMessage(kind) ?? "named tunnel failed; check the connector token, hostname and published application route",
          stopped.confirmed ? undefined : { pid: stopped.pid, identity: stopped.identity });
      }
      if (!stopped.confirmed) {
        throw new TunnelStartError(
          err instanceof TunnelStartError ? err.errorKind : "spawn-failed",
          `${(err as Error).message}; and the tunnel process could not be confirmed stopped`,
          { pid: stopped.pid, identity: stopped.identity },
        );
      }
      throw err;
    }
  }

  private async probeReady(pageUrl: string, ctx: TunnelStartContext, deadline: number, now: () => number, isDead: () => boolean, checkOutput: () => void, namedFailure: (kind: NamedTunnelFailureKind) => void): Promise<void> {
    const fetchPage = this.opts.fetchPage ?? ((url: string, signal: AbortSignal) => fetchViaPublicResolver(url, signal, {
      resolvers: this.opts.publicResolvers,
      resolve4: this.opts.resolve4,
      request: this.opts.request,
      fallback: (u, sig) => fetchViaSystemResolver(u, sig, this.opts.fetchImpl),
    }));
    let lastDetail = "no attempt completed";
    while (now() < deadline) {
      checkOutput();
      if (ctx.signal.aborted) throw new TunnelStartError("cancelled", "cancelled during readiness probe");
      // No point asking the edge about a tunnel whose process is gone.
      if (isDead()) throw new TunnelStartError("no-url", "cloudflared exited while waiting for the tunnel to become ready");
      const attempt = new AbortController();
      const timer = setTimeout(() => attempt.abort(), Math.max(1, Math.min(5_000, deadline - now())));
      try {
        const res = await fetchPage(pageUrl, attempt.signal);
        if (res.status === 200 && res.contentType.startsWith("text/html") && res.body.includes(ctx.readinessMarker)) {
          return;
        }
        if (this.opts.named) {
          if (res.status === 404) namedFailure("named-route-missing");
          else if (res.status === 502) namedFailure("named-origin-unreachable");
          else if (res.status === 200) namedFailure("named-hostname-mismatch");
        }
        lastDetail = `status ${res.status}, content-type ${res.contentType || "(none)"}`;
      } catch (err) {
        lastDetail = err instanceof Error ? err.message : "request failed";
        if (this.opts.named) {
          const kind = classifyNamedTunnelProbeError(err, this.opts.named.token);
          if (kind) namedFailure(kind);
        }
      } finally {
        clearTimeout(timer);
      }
      // The edge takes a moment to learn the hostname; a failure here is
      // expected early and only fatal at the deadline.
      await new Promise<void>(r => setTimeout(r, 500));
    }
    throw new TunnelStartError("readiness-failed", `the public URL never served this page (${lastDetail})`);
  }
}

class CloudflaredHandle implements TunnelHandle {
  readonly provider = "cloudflared";
  readonly visibility = "public" as const;
  baseUrl = "";
  pageUrl = "";
  readonly pid: number | null;
  readonly identity: string | null;

  private buffered = "";
  /** Its stdout and stderr have ended: everything it printed has been absorbed (#1767). */
  private outputClosed = false;
  private urlResolved: ((base: string) => void) | null = null;
  private foundBase: string | null = null;
  private exit: TunnelExit | null = null;
  /**
   * A spawn that failed before a process existed.
   *
   * Node reports this as `error` and never as `exit`, and leaves `pid`
   * undefined. Without handling it the start waits out its whole deadline and
   * then cannot prove a death — for a process that was never created, which
   * would hold the lease and block every later tunnel over nothing.
   */
  private spawnError: Error | null = null;
  private exitListeners = new Set<(exit: TunnelExit) => void>();
  private published = false;
  /** Set once we asked it to stop: from then on an exit is expected, never "unexpected". */
  private stopRequested = false;
  private stopping: Promise<TunnelStopResult> | null = null;
  private outputError = false;
  private outputFailed: (() => void) | null = null;
  private failureListeners = new Set<(kind: "transport-failed") => void>();

  constructor(
    private readonly child: ChildProcess,
    private readonly opts: CloudflaredOptions,
  ) {
    this.pid = child.pid ?? null;
    // Recorded now, not at stop time: the fingerprint of the process we
    // actually started is the only thing that makes a later kill safe.
    const probeFn = opts.probe ?? probeProcess;
    const probe = (this.pid !== null ? probeFn(this.pid) : { kind: "unknown" as const });
    this.identity = probe.kind === "identified" ? probe.identity : null;

    const absorb = (chunk: Buffer | string) => {
      if (this.foundBase || this.published) return;
      this.buffered = (this.buffered + String(chunk)).slice(-MAX_BUFFERED_OUTPUT);
      if (this.opts.named) return; // Kept private and bounded, used only for a closed failure classification.
      const base = extractTunnelUrl(this.buffered);
      if (!base) return;
      this.foundBase = base;
      this.urlResolved?.(base);
    };
    child.stdout?.on("data", absorb);
    child.stderr?.on("data", absorb);
    const onOutputError = () => {
      if (this.outputError) return;
      this.outputError = true;
      this.outputFailed?.();
      if (this.published && !this.stopRequested) {
        for (const listener of this.failureListeners) listener("transport-failed");
      }
    };
    // Pipes emit errors independently of ChildProcess. Keep these listeners
    // even after stop; a queued pipe error must never escape during teardown.
    child.stdout?.on("error", onOutputError);
    child.stderr?.on("error", onOutputError);
    child.on("close", () => { this.outputClosed = true; });
    child.on("exit", (code, signal) => {
      this.exit = { code, signal };
      if (this.published) for (const listener of this.exitListeners) listener(this.exit);
    });
    child.on("error", err => {
      this.spawnError = err as Error;
      if (this.pid === null) this.spawnFailed?.(this.spawnError);
    });
  }

  namedFailureKind(): NamedTunnelFailureKind | undefined {
    return this.opts.named ? classifyNamedTunnelOutput(this.buffered, this.opts.named.token) : undefined;
  }
  /** An exit may precede the last pipe chunk; never wait beyond the existing bounded drain budget. */
  async drainOutput(): Promise<void> {
    if (this.outputClosed) return;
    await new Promise<void>(resolve => {
      const finish = () => { clearTimeout(timer); this.child.off("close", finish); resolve(); };
      const timer = setTimeout(finish, OUTPUT_DRAIN_MS);
      this.child.once("close", finish);
      if (this.outputClosed) finish();
    });
  }

  private spawnFailed: ((err: Error) => void) | null = null;

  /** True when we can prove no process was ever created. */
  private get neverStarted(): boolean {
    return this.pid === null && this.spawnError !== null;
  }

  get hasExited(): boolean { return this.exit !== null; }

  publish(base: string, pageUrl: string): void {
    this.baseUrl = base;
    this.pageUrl = pageUrl;
    this.published = true;
    if (this.opts.named) this.buffered = ""; // No startup evidence is needed once readiness has been proven.
  }

  async awaitUrl(deadline: number, signal: AbortSignal, now: () => number): Promise<string> {
    this.checkOutput();
    if (this.foundBase) return this.foundBase;
    if (this.neverStarted) {
      throw new TunnelStartError("spawn-failed", `could not start cloudflared: ${this.spawnError!.message}`);
    }
    return new Promise<string>((resolve, reject) => {
      const settle = (fn: () => void) => { cleanup(); fn(); };
      const timer = setTimeout(
        () => settle(() => reject(new TunnelStartError("timeout", "cloudflared did not print a usable tunnel URL in time"))),
        Math.max(1, deadline - now()),
      );
      const onAbort = () => settle(() => reject(new TunnelStartError("cancelled", "cancelled while waiting for the tunnel URL")));
      // #1767: why it exited is in what it printed last — read once its output has been delivered ("exit" can come
      // before the last "data"): a refused provisioning (429 = rate limited) is not a missing URL, and never a timeout.
      const onExit = () => {
        const finish = () => settle(() => reject(exitBeforeUrl(this.buffered)));
        if (this.outputClosed) finish();
        else { this.child.once("close", finish); setTimeout(finish, OUTPUT_DRAIN_MS); }
      };
      // A spawn that never produced a process must not wait out the deadline:
      // there is nothing to wait for, and the delay is what turns a missing
      // binary into a blocked lease.
      const onSpawnFail = (err: Error) => settle(() => reject(
        new TunnelStartError("spawn-failed", `could not start cloudflared: ${err.message}`),
      ));
      const cleanup = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        this.child.off("exit", onExit);
        this.urlResolved = null;
        this.spawnFailed = null;
        this.outputFailed = null;
      };
      this.urlResolved = base => settle(() => resolve(base));
      this.spawnFailed = onSpawnFail;
      this.outputFailed = () => settle(() => reject(new TunnelStartError("transport-failed", "cloudflared output stream failed")));
      signal.addEventListener("abort", onAbort, { once: true });
      this.child.on("exit", onExit);
      if (this.exit) onExit();
      else if (this.neverStarted) onSpawnFail(this.spawnError!);
      else if (signal.aborted) onAbort();
    });
  }

  checkOutput(): void {
    if (this.opts.named && this.spawnError) throw new TunnelStartError("spawn-failed", "named tunnel process failed");
    if (this.outputError) throw new TunnelStartError("transport-failed", "cloudflared output stream failed");
  }

  onFailure(listener: (kind: "transport-failed") => void): () => void {
    this.failureListeners.add(listener);
    if (this.outputError && !this.stopRequested) {
      queueMicrotask(() => { if (this.failureListeners.has(listener) && !this.stopRequested) listener("transport-failed"); });
    }
    return () => { this.failureListeners.delete(listener); };
  }

  onUnexpectedExit(listener: (exit: TunnelExit) => void): () => void {
    this.exitListeners.add(listener);
    // An exit that happened before anyone was listening is still an unexpected exit: replaying it closes the
    // gap between "published" and "listener attached", so a tunnel that died in that window is not silent.
    // (A stop() clears the listeners, so an exit we asked for is never replayed.)
    if (this.published && this.exit && !this.stopRequested) {
      const exit = this.exit;
      queueMicrotask(() => { if (this.exitListeners.has(listener)) listener(exit); });
    }
    return () => { this.exitListeners.delete(listener); };
  }

  /** Single-flight: a second caller joins the first rather than re-signalling. */
  stop(reason: string): Promise<TunnelStopResult> {
    this.stopping ??= this.doStop(reason);
    return this.stopping;
  }

  private async doStop(reason: string): Promise<TunnelStopResult> {
    void reason;
    this.stopRequested = true;
    this.exitListeners.clear();
    this.failureListeners.clear();
    if (this.exit) return { confirmed: true };
    // Proven, not assumed: Node reported the spawn itself failed and never
    // handed us a pid, so there is no process. Reporting this as unconfirmed
    // would hold the lease against a child that does not exist.
    if (this.neverStarted) return { confirmed: true };
    if (this.pid === null) {
      return { confirmed: false, reason: "the process was never given a pid", pid: null, identity: null };
    }
    const probe = this.opts.probe ?? probeProcess;
    const graceMs = this.opts.graceMs ?? TUNNEL_STOP_GRACE_MS;

    for (const signal of ["SIGTERM", "SIGKILL"] as const) {
      try { this.child.kill(signal); } catch { /* may have exited between checks */ }
      const exited = await this.waitForExit(graceMs);
      if (exited) return { confirmed: true };
      const after = probe(this.pid);
      if (after.kind === "gone") return { confirmed: true };
      // The pid belongs to something else now, so ours is gone — and we must
      // not send it the next signal.
      if (after.kind === "identified" && this.identity && after.identity !== this.identity) {
        return { confirmed: true };
      }
    }
    return {
      confirmed: false,
      // Never "stopped": a kill() that did not throw proves nothing, and this
      // sentence is what stops a caller writing "closed safely" in a log.
      reason: "the process did not exit after SIGTERM and SIGKILL, and is still running under its original identity",
      pid: this.pid,
      identity: this.identity,
    };
  }

  private waitForExit(ms: number): Promise<boolean> {
    if (this.exit) return Promise.resolve(true);
    return new Promise<boolean>(resolve => {
      const timer = setTimeout(() => { this.child.off("exit", onExit); resolve(false); }, ms);
      const onExit = () => { clearTimeout(timer); resolve(true); };
      this.child.once("exit", onExit);
    });
  }
}
