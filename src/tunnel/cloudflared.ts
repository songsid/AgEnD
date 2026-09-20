/**
 * Cloudflare Quick Tunnel as a transport, and only a transport.
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
import { spawn, type ChildProcess } from "node:child_process";
import { accessSync, constants as fsConstants } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { probeProcess } from "../web-terminal.js";
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
export function validateQuickTunnelUrl(candidate: string): string | null {
  if (candidate.length > 200) return null;
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
  if (!QUICK_TUNNEL_HOST.test(url.hostname)) return null;
  return `https://${url.hostname}`;
}

/**
 * Pull candidate URLs out of a chunk of child output.
 *
 * Splits on whitespace and `|` — the box-drawing cloudflared prints its URL
 * inside — and neither can occur within a URL, so a token is the complete thing
 * the child printed. Nothing is trimmed off the ends: trimming punctuation is
 * how `https://evil.example/#.trycloudflare.com` becomes acceptable.
 */
export function extractTunnelUrl(text: string): string | null {
  // Strip ANSI first so colouring around the URL does not become part of it.
  const plain = text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");
  for (const token of plain.split(/[\s|"',]+/)) {
    if (!token.startsWith("https://")) continue;
    const valid = validateQuickTunnelUrl(token);
    if (valid) return valid;
  }
  return null;
}

/** Bounded: a child that never prints a URL must not grow our memory. */
const MAX_BUFFERED_OUTPUT = 64 * 1024;

function resolveBinary(name: string, env: NodeJS.ProcessEnv): string | null {
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

export interface CloudflaredOptions {
  binaryName?: string;
  /** Test seam: the real one spawns a process. */
  spawnProcess?: typeof spawn;
  /** Test seam for the readiness GET. */
  fetchPage?: (url: string, signal: AbortSignal) => Promise<{ status: number; contentType: string; body: string }>;
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
        detail: `${this.binaryName} is not on PATH. Install it from Cloudflare's documentation; AgEnD never downloads it for you.`,
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

    const spawnProcess = this.opts.spawnProcess ?? spawn;
    let child: ChildProcess;
    try {
      child = spawnProcess(pre.binaryPath, [
        "tunnel",
        "--no-autoupdate",
        "--config", "/dev/null",
        "--url", ctx.origin.origin,
      ], {
        // No shell, ever: the arguments are fixed and one of them is an origin.
        shell: false,
        env: minimalChildEnv(this.env),
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      throw new TunnelStartError("spawn-failed", `could not start ${this.binaryName}: ${(err as Error).message}`);
    }

    const state = new CloudflaredHandle(child, this.opts);
    try {
      const base = await state.awaitUrl(deadline, ctx.signal, now);
      const pageUrl = `${base}${ctx.pagePath}`;
      await this.probeReady(pageUrl, ctx, deadline, now);
      state.publish(base, pageUrl);
      return state;
    } catch (err) {
      // A child exists. Its death has to be proven before this failure can be
      // reported as a clean one, or a fallback would run beside a live tunnel.
      const stopped = await state.stop("startup failed");
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

  private async probeReady(pageUrl: string, ctx: TunnelStartContext, deadline: number, now: () => number): Promise<void> {
    const fetchPage = this.opts.fetchPage ?? defaultFetchPage;
    let lastDetail = "no attempt completed";
    while (now() < deadline) {
      if (ctx.signal.aborted) throw new TunnelStartError("cancelled", "cancelled during readiness probe");
      const attempt = new AbortController();
      const timer = setTimeout(() => attempt.abort(), Math.max(1, Math.min(5_000, deadline - now())));
      try {
        const res = await fetchPage(pageUrl, attempt.signal);
        if (res.status === 200 && res.contentType.startsWith("text/html") && res.body.includes(ctx.readinessMarker)) {
          return;
        }
        lastDetail = `status ${res.status}, content-type ${res.contentType || "(none)"}`;
      } catch (err) {
        lastDetail = (err as Error).message;
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

async function defaultFetchPage(url: string, signal: AbortSignal): Promise<{ status: number; contentType: string; body: string }> {
  // `manual`: a redirect is not this page, and following one would let the edge
  // decide what we call ready.
  const res = await fetch(url, { signal, redirect: "manual", cache: "no-store" });
  return {
    status: res.status,
    contentType: res.headers.get("content-type") ?? "",
    body: res.status === 200 ? await res.text() : "",
  };
}

class CloudflaredHandle implements TunnelHandle {
  readonly provider = "cloudflared";
  readonly visibility = "public" as const;
  baseUrl = "";
  pageUrl = "";
  readonly pid: number | null;
  readonly identity: string | null;

  private buffered = "";
  private urlResolved: ((base: string) => void) | null = null;
  private foundBase: string | null = null;
  private exit: TunnelExit | null = null;
  private exitListeners = new Set<(exit: TunnelExit) => void>();
  private published = false;
  private stopping: Promise<TunnelStopResult> | null = null;

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
      if (this.foundBase) return;
      this.buffered = (this.buffered + String(chunk)).slice(-MAX_BUFFERED_OUTPUT);
      const base = extractTunnelUrl(this.buffered);
      if (!base) return;
      this.foundBase = base;
      this.urlResolved?.(base);
    };
    child.stdout?.on("data", absorb);
    child.stderr?.on("data", absorb);
    child.on("exit", (code, signal) => {
      this.exit = { code, signal };
      if (this.published) for (const listener of this.exitListeners) listener(this.exit);
    });
    child.on("error", () => { /* surfaced through the startup deadline */ });
  }

  publish(base: string, pageUrl: string): void {
    this.baseUrl = base;
    this.pageUrl = pageUrl;
    this.published = true;
  }

  async awaitUrl(deadline: number, signal: AbortSignal, now: () => number): Promise<string> {
    if (this.foundBase) return this.foundBase;
    return new Promise<string>((resolve, reject) => {
      const settle = (fn: () => void) => { cleanup(); fn(); };
      const timer = setTimeout(
        () => settle(() => reject(new TunnelStartError("timeout", "cloudflared did not print a usable tunnel URL in time"))),
        Math.max(1, deadline - now()),
      );
      const onAbort = () => settle(() => reject(new TunnelStartError("cancelled", "cancelled while waiting for the tunnel URL")));
      const onExit = () => settle(() => reject(new TunnelStartError("no-url", "cloudflared exited before printing a tunnel URL")));
      const cleanup = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        this.child.off("exit", onExit);
        this.urlResolved = null;
      };
      this.urlResolved = base => settle(() => resolve(base));
      signal.addEventListener("abort", onAbort, { once: true });
      this.child.on("exit", onExit);
      if (this.exit) onExit();
      else if (signal.aborted) onAbort();
    });
  }

  onUnexpectedExit(listener: (exit: TunnelExit) => void): () => void {
    this.exitListeners.add(listener);
    return () => { this.exitListeners.delete(listener); };
  }

  /** Single-flight: a second caller joins the first rather than re-signalling. */
  stop(reason: string): Promise<TunnelStopResult> {
    this.stopping ??= this.doStop(reason);
    return this.stopping;
  }

  private async doStop(reason: string): Promise<TunnelStopResult> {
    void reason;
    this.exitListeners.clear();
    if (this.exit) return { confirmed: true };
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
