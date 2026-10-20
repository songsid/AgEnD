import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoginController, type LoginControllerDeps } from "../src/login-controller.js";
import { LoginWindowLock } from "../src/login-window-lock.js";
import { WebTerminalSession, type TerminalBackend } from "../src/web-terminal.js";
import { ManagedTunnel } from "../src/tunnel/manager.js";
import { CloudflaredProvider } from "../src/tunnel/cloudflared.js";
import { setLocale } from "../src/locale.js";

// Real controller/session/provider/lease, inert HTTP and child boundaries.
// No tmux, provider CLI, DNS, fetch or host process inspection is permitted.
type InertHttpServer = EventEmitter & {
  listen(port: number, bind: string, ready: () => void): void;
  address(): { port: number };
  close(done: () => void): void;
};
const http = vi.hoisted(() => ({ servers: [] as InertHttpServer[], listenError: null as Error | null,
  holdReady: false, ready: [] as Array<() => void> }));
vi.mock("node:http", async () => {
  const { EventEmitter } = await import("node:events");
  return { createServer: () => {
    const server = new EventEmitter() as InertHttpServer;
    server.listen = (_port: number, _bind: string, ready: () => void) => queueMicrotask(() => {
      if (http.listenError) server.emit("error", http.listenError);
      else if (http.holdReady) http.ready.push(ready);
      else ready();
    });
    server.address = () => ({ port: 43123 });
    server.close = vi.fn((done: () => void) => done());
    http.servers.push(server);
    return server;
  } };
});

class TunnelChild extends EventEmitter {
  pid: number | null = 424242;
  stdout = new PassThrough();
  stderr = new PassThrough();
  signals: string[] = [];
  kill(signal: string) { this.signals.push(signal); this.emit("exit", 0, signal); return true; }
}

const fixtures: Array<{ home: string; controller: LoginController }> = [];
function fixture(opts: { bind?: string; installError?: Error; readinessFails?: boolean; deadlineMs?: number; readyGate?: Promise<void> } = {}) {
  const home = mkdtempSync(join(tmpdir(), "agend-login-failure-"));
  const lock = new LoginWindowLock();
  const child = new TunnelChild();
  const backend: TerminalBackend = {
    start: vi.fn(async () => {}), kill: vi.fn(async () => {}),
    capture: async () => "", paneStatus: async () => ({ alive: true }),
    sendInput: async () => {}, resize: async () => {},
  };
  const sendText = vi.fn(async (_chat: string, _text: string) => ({ messageId: "m", chatId: "chat" }));
  const adapter = { type: "telegram", sendText, sendDirect: vi.fn(async () => ({ messageId: "d", chatId: "user" })) };
  const managed = new ManagedTunnel({ dataDir: home, probe: () => ({ kind: "gone" }) });
  let probeEntered = false;
  const provider = new CloudflaredProvider({
    binaryName: process.execPath, spawnProcess: (() => child) as never,
    probe: () => ({ kind: "gone" }), deadlineMs: opts.deadlineMs ?? (opts.readinessFails ? 150 : 3_000), graceMs: 1,
    fetchPage: async () => { probeEntered = true; await opts.readyGate; return { status: opts.readinessFails ? 503 : 200, contentType: "text/html", body: "ready" }; },
  });
  let session: WebTerminalSession;
  const deps: LoginControllerDeps = {
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    fleetConfig: () => ({ defaults: {}, instances: {}, hostname: "192.0.2.5", web_terminal: { bind: opts.bind } }) as never,
    isFleetAdmin: () => true, eventLog: () => null,
    recoverBackendInstances: async () => ({ woken: [], restarted: [], pending: [] }), postButtons: async () => {},
    claimWindow: b => lock.tryClaim("web", b), releaseWindow: c => { lock.release(c); },
    isClaimCurrent: c => lock.isCurrent(c), windowBusyMessage: () => lock.busyMessage(),
    createSession: (spec, events, logger) => (session = new WebTerminalSession(spec, events, backend, logger)),
    createTunnel: () => ({ start: ctx => managed.start(provider, { ...ctx, readinessMarker: "ready" }), stop: reason => managed.stop(reason) }),
    ensureCloudflared: async () => { if (opts.installError) throw opts.installError; return { path: process.execPath, source: "path" }; },
  };
  const controller = new LoginController(deps);
  const chat = { adapter: adapter as never, adapterId: "telegram", chatId: "chat", userId: "user" };
  // This is the same returned-message dispatch as /login and its confirmation button.
  const start = async (tunnel = false, profile?: string) => {
    const result = await controller.start("claude", chat, { skipAuthCheck: true, tunnel, ...(profile ? { profile } : {}) });
    if (result) await sendText("chat", result);
    return result;
  };
  const f = { home, child, backend, controller, start, sendText, adapter, lock, session: () => session!,
    text: () => sendText.mock.calls.map(c => c[1]).join("\n"), probeEntered: () => probeEntered };
  fixtures.push(f);
  return f;
}
beforeEach(() => { http.servers = []; http.listenError = null; http.holdReady = false; http.ready = []; setLocale("en"); });
afterEach(async () => {
  for (const f of fixtures.splice(0)) { await f.controller.shutdown(); rmSync(f.home, { recursive: true, force: true }); }
  vi.unstubAllEnvs();
});

describe("/login failures stay within their session", () => {
  it("a session finishing before held listen readiness still closes the late listener", async () => {
    http.holdReady = true;
    const f = fixture();
    const starting = f.start();
    await vi.waitFor(() => expect(http.ready).toHaveLength(1));
    await f.session().cancel("test finish");
    expect(f.controller.isActive()).toBe(false);
    expect(f.lock.isHeld).toBe(false);
    expect(http.servers[0].close).not.toHaveBeenCalled();
    http.ready[0]();
    expect(await starting).toBeNull();
    expect(http.servers[0].close, "finished session must not leave a listener alive").toHaveBeenCalledOnce();
    expect(f.sendText).toHaveBeenCalledOnce();
    expect(f.adapter.sendDirect).not.toHaveBeenCalled();
  });

  it("normal listen readiness followed by session finish closes its listener", async () => {
    const f = fixture();
    await f.start();
    expect(http.servers[0].close).not.toHaveBeenCalled();
    await f.session().cancel("test finish");
    expect(http.servers[0].close).toHaveBeenCalledOnce();
    expect(f.lock.isHeld).toBe(false);
  });

  it("late listen cleanup cannot release a newer login's window", async () => {
    http.holdReady = true;
    const f = fixture();
    const oldStart = f.start();
    await vi.waitFor(() => expect(http.ready).toHaveLength(1));
    await f.session().cancel("old finish");
    http.holdReady = false;
    await f.start();
    http.ready[0]();
    await oldStart;
    expect(http.servers[0].close).toHaveBeenCalledOnce();
    expect(http.servers[1].close).not.toHaveBeenCalled();
    expect(f.controller.isActive()).toBe(true);
    expect(f.lock.isHeld).toBe(true);
  });

  it("a listener error after listening closes the login and tells Telegram what to do", async () => {
    const f = fixture();
    await f.start();
    expect(() => http.servers[0].emit("error", Object.assign(new Error("private detail"), { code: "EMFILE" }))).not.toThrow();
    await vi.waitFor(() => expect(f.controller.isActive()).toBe(false));
    expect(f.text()).toContain("browser terminal listener stopped");
    expect(f.text()).toContain("/login");
    expect(f.text()).not.toContain("private detail");
    expect(f.lock.isHeld).toBe(false);
    expect(f.backend.kill).toHaveBeenCalledOnce();
    // Late errors from the closed listener remain handled; no second report.
    const n = f.sendText.mock.calls.length;
    expect(() => http.servers[0].emit("error", new Error("late"))).not.toThrow();
    expect(f.sendText).toHaveBeenCalledTimes(n);
  });

  it.each(["stdout", "stderr"] as const)("cloudflared %s error before URL rejects into a chat reason, not an uncaught error", async stream => {
    const f = fixture();
    const starting = f.start(true);
    await vi.waitFor(() => expect(f.child[stream].listenerCount("data")).toBeGreaterThan(0));
    expect(() => f.child[stream].emit("error", new Error("secret tunnel host"))).not.toThrow();
    await starting;
    expect(f.text()).toContain("cloudflared output connection failed");
    expect(f.text()).toContain("/login");
    expect(f.text()).not.toContain("secret tunnel host");
    expect(f.controller.isActive()).toBe(false);
    expect(f.lock.isHeld).toBe(false);
    expect(f.child.signals).toContain("SIGTERM");
  });

  it("a loopback link explains why it cannot be opened directly from a phone", async () => {
    const f = fixture();
    await f.start();
    expect(f.text()).toContain("127.0.0.1");
    expect(f.text()).toContain("this machine only");
    expect(f.text()).toContain("SSH");
    expect(f.text()).toContain("public link");
  });

  it("a configured LAN bind failure reports the reason and a next step", async () => {
    http.listenError = Object.assign(new Error("private host"), { code: "EADDRNOTAVAIL" });
    const f = fixture({ bind: "192.0.2.99" });
    await f.start();
    expect(f.text()).toContain("EADDRNOTAVAIL");
    expect(f.text()).toContain("web_terminal.bind");
    expect(f.text()).toContain("/login");
    expect(f.text()).not.toContain("private host");
    expect(f.lock.isHeld).toBe(false);
    expect(f.adapter.sendDirect).not.toHaveBeenCalled();
  });

  it("a non-loopback link gives firewall, WSL and HTTP troubleshooting without claiming remote reachability", async () => {
    const f = fixture({ bind: "0.0.0.0" });
    await f.start();
    expect(f.text()).toContain("firewall");
    expect(f.text()).toContain("WSL");
    expect(f.text()).toContain("http://");
    expect(f.text()).not.toContain("this machine only");
  });

  it.each(["stdout", "stderr"] as const)("normal public connect works, then a late %s error ends it with a reason", async stream => {
    const f = fixture();
    const starting = f.start(true);
    await vi.waitFor(() => expect(f.child.stdout.listenerCount("data")).toBeGreaterThan(0));
    f.child.stdout.write("https://test-only.trycloudflare.com\n");
    await starting;
    expect(f.controller.isActive()).toBe(true);
    expect(f.adapter.sendDirect).toHaveBeenCalledTimes(2);
    expect(f.child.signals).toEqual([]);
    expect(() => f.child[stream].emit("error", new Error("late secret"))).not.toThrow();
    await vi.waitFor(() => expect(f.controller.isActive()).toBe(false));
    expect(f.text()).toContain("cloudflared output connection failed");
    expect(f.text()).toContain("/login");
    expect(f.text()).not.toContain("late secret");
    expect(f.child.signals).toContain("SIGTERM");
    expect(f.lock.isHeld).toBe(false);
  });

  it.each([
    ["429", "rate limited"],
    ["503", "refused to create"],
    ["no-url", "exited before opening"],
  ])("cloudflared %s exit is explained in chat", async (status, reason) => {
    const f = fixture();
    const starting = f.start(true);
    await vi.waitFor(() => expect(f.child.stderr.listenerCount("data")).toBeGreaterThan(0));
    if (status !== "no-url") f.child.stderr.write(`quick tunnel provisioning failed with status ${status}\n`);
    f.child.emit("exit", 1, null); f.child.emit("close");
    await starting;
    expect(f.text()).toContain(reason);
    expect(f.text()).toContain("/login");
    expect(f.controller.isActive()).toBe(false);
    expect(f.lock.isHeld).toBe(false);
    expect(f.adapter.sendDirect).not.toHaveBeenCalled();
  });

  it("a public URL that never serves the page reports failed readiness and stops the child", async () => {
    const f = fixture({ readinessFails: true });
    const starting = f.start(true);
    await vi.waitFor(() => expect(f.child.stdout.listenerCount("data")).toBeGreaterThan(0));
    f.child.stdout.write("https://test-only.trycloudflare.com\n");
    await starting;
    expect(f.text()).toContain("never became reachable");
    expect(f.text()).toContain("/login");
    expect(f.child.signals).toContain("SIGTERM");
    expect(f.lock.isHeld).toBe(false);
  });

  it("a missing cloudflared download fails before opening any session or listener", async () => {
    const f = fixture({ installError: Object.assign(new Error("private download"), { kind: "download-failed" }) });
    await f.start(true);
    expect(f.text()).toContain("could not be downloaded");
    expect(f.text()).toContain("/login");
    expect(f.backend.start).not.toHaveBeenCalled();
    expect(http.servers).toHaveLength(0);
    expect(f.lock.isHeld).toBe(false);
  });

  it("a silent cloudflared times out with a chat reason and confirmed cleanup", async () => {
    const f = fixture({ deadlineMs: 30 });
    await f.start(true);
    expect(f.text()).toContain("took too long");
    expect(f.text()).toContain("/login");
    expect(f.child.signals).toContain("SIGTERM");
    expect(f.lock.isHeld).toBe(false);
  });

  it("a failed cloudflared spawn has no child to kill and reports that it could not start", async () => {
    const f = fixture();
    f.child.pid = null;
    const starting = f.start(true);
    await vi.waitFor(() => expect(f.child.listenerCount("error")).toBeGreaterThan(0));
    f.child.emit("error", Object.assign(new Error("private binary"), { code: "ENOENT" }));
    await starting;
    expect(f.text()).toContain("could not be started");
    expect(f.text()).toContain("/login");
    expect(f.text()).not.toContain("private binary");
    expect(f.child.signals).toEqual([]);
    expect(f.lock.isHeld).toBe(false);
  });

  it("a listener error while the tunnel is pending cancels it and reports once without publishing a link", async () => {
    const f = fixture();
    const starting = f.start(true);
    await vi.waitFor(() => expect(f.child.stdout.listenerCount("data")).toBeGreaterThan(0));
    expect(() => http.servers[0].emit("error", new Error("injected"))).not.toThrow();
    await starting;
    await vi.waitFor(() => expect(f.text()).toContain("browser terminal listener stopped"));
    expect(f.sendText).toHaveBeenCalledOnce();
    expect(f.adapter.sendDirect).not.toHaveBeenCalled();
    expect(f.child.signals).toContain("SIGTERM");
    expect(f.lock.isHeld).toBe(false);
  });

  it("an output error during readiness cannot publish a tunnel after the probe returns", async () => {
    let ready!: () => void;
    const f = fixture({ readyGate: new Promise<void>(resolve => { ready = resolve; }) });
    const starting = f.start(true);
    await vi.waitFor(() => expect(f.child.stdout.listenerCount("data")).toBeGreaterThan(0));
    f.child.stdout.write("https://test-only.trycloudflare.com\n");
    await vi.waitFor(() => expect(f.probeEntered()).toBe(true));
    f.child.stderr.emit("error", new Error("during readiness"));
    ready();
    await starting;
    expect(f.text()).toContain("cloudflared output connection failed");
    expect(f.adapter.sendDirect).not.toHaveBeenCalled();
    expect(f.child.signals).toContain("SIGTERM");
    expect(f.lock.isHeld).toBe(false);
  });

  it("a named Claude profile has the same failure boundary and keeps its login command isolated", async () => {
    const f = fixture();
    vi.stubEnv("HOME", f.home);
    vi.stubEnv("AGEND_HOME", f.home);
    const starting = f.start(true, "work");
    await vi.waitFor(() => expect(f.child.stdout.listenerCount("data")).toBeGreaterThan(0));
    expect(f.session().spec.command).toContain("CLAUDE_CONFIG_DIR=");
    expect(f.session().spec.command).toContain(f.home);
    f.child.stdout.emit("error", new Error("private profile failure"));
    await starting;
    expect(f.text()).toContain("cloudflared output connection failed");
    expect(f.text()).toContain("/login");
    expect(f.lock.isHeld).toBe(false);
  });
});
