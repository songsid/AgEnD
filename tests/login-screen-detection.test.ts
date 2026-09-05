import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";
import { Daemon } from "../src/daemon.js";
import { InstanceLifecycle, type LifecycleContext } from "../src/instance-lifecycle.js";
import { LOGIN_FLOWS, setAuthCheckRunnerForTests } from "../src/login-flows.js";

afterEach(() => setAuthCheckRunnerForTests(null));

function makeDaemon(backend: string, readyPattern = /READY-NEVER-MATCHES-\d{40}/) {
  const instanceDir = mkdtempSync(join(tmpdir(), "agend-login-screen-"));
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const daemon = new Daemon("auth-test", {
    working_directory: "/tmp",
    backend,
    restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
    context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 },
    log_level: "silent",
  } as any, instanceDir, false, {
    binaryName: backend,
    getReadyPattern: () => readyPattern,
    getStartupDialogs: () => [],
  } as any, undefined, { child: () => logger } as any);
  return { daemon, instanceDir };
}

describe("startup login-screen detection", () => {
  it("every login flow declares a binary-verified login-screen pattern", () => {
    for (const flow of Object.values(LOGIN_FLOWS)) {
      expect(flow.loginScreenPattern, flow.backend).toBeInstanceOf(RegExp);
    }
    expect(LOGIN_FLOWS["codex"].loginScreenPattern!.test("  Sign in with ChatGPT to continue.")).toBe(true);
    expect(LOGIN_FLOWS["grok"].loginScreenPattern!.test("Not logged in. Run `grok login`.")).toBe(true);
    expect(LOGIN_FLOWS["claude-code"].loginScreenPattern!.test("Select login method:")).toBe(true);
    expect(LOGIN_FLOWS["antigravity"].loginScreenPattern!.test("You are not logged into Antigravity.")).toBe(true);
  });

  it("a codex sign-in screen reports one auth error and stops the retry loop", async () => {
    const { daemon, instanceDir } = makeDaemon("codex");
    try {
      const capturePane = vi.fn(async () => "Welcome to Codex\n  Sign in with ChatGPT to continue.\n> Sign in with ChatGPT");
      (daemon as any).tmux = { capturePane, isWindowAlive: async () => true };
      const errors: any[] = [];
      daemon.on("pty_error", e => errors.push(e));

      const ready = await (daemon as any).dismissDialogsUntilReady(3_000, 0);
      expect(ready).toBe(true); // spawn completes; recovery is /login, not a respawn loop
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatchObject({ type: "auth_error", action: "pause" });
      expect((daemon as any).authFailureUnresolved).toBe(true);
      // The screen persists — a later pass must not spam a second report.
      await (daemon as any).dismissDialogsUntilReady(2_000, 0);
      expect(errors).toHaveLength(1);
    } finally {
      rmSync(instanceDir, { recursive: true, force: true });
    }
  });

  it("a normal ready pane never triggers the login-screen path", async () => {
    const { daemon, instanceDir } = makeDaemon("codex", /❯/);
    try {
      (daemon as any).tmux = { capturePane: async () => "codex ready\n❯ ", isWindowAlive: async () => true };
      const errors: any[] = [];
      daemon.on("pty_error", e => errors.push(e));
      expect(await (daemon as any).dismissDialogsUntilReady(3_000, 0)).toBe(true);
      expect(errors).toHaveLength(0);
    } finally {
      rmSync(instanceDir, { recursive: true, force: true });
    }
  });
});

describe("MCP-died auth gate", () => {
  function deadMcpDir(): string {
    const instanceDir = mkdtempSync(join(tmpdir(), "agend-mcp-dead-"));
    // A syntactically valid pid that cannot exist (beyond pid_max).
    writeFileSync(join(instanceDir, "channel.mcp.pid"), "3999999");
    return instanceDir;
  }

  it("suppresses auto-restart and flags authSuspected while auth is unresolved", () => {
    const { daemon } = makeDaemon("codex");
    const instanceDir = deadMcpDir();
    (daemon as any).instanceDir = instanceDir;
    try {
      (daemon as any).authFailureUnresolved = true;
      const events: any[] = [];
      daemon.on("mcp_died", e => events.push(e));
      // Codex holds the FIRST dead sighting back one tick in case the CLI is
      // merely swapping its MCP child (#663); the second tick confirms a loss.
      (daemon as any).checkMcpServerAlive();
      (daemon as any).checkMcpServerAlive();
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ autoRestart: false, authSuspected: true });
      expect((daemon as any).mcpRestartPending).toBe(false);
    } finally {
      rmSync(instanceDir, { recursive: true, force: true });
    }
  });

  it("keeps the normal auto-restart when auth is fine", async () => {
    const { daemon } = makeDaemon("codex");
    const instanceDir = deadMcpDir();
    (daemon as any).instanceDir = instanceDir;
    try {
      const events: any[] = [];
      const restartRequests: any[] = [];
      daemon.on("mcp_died", e => events.push(e));
      daemon.on("mcp_restart_requested", e => restartRequests.push(e));
      vi.useFakeTimers();
      (daemon as any).checkMcpServerAlive();
      (daemon as any).checkMcpServerAlive(); // see the #663 deferral above
      expect(events[0]).toMatchObject({ autoRestart: true, authSuspected: false });
      // The test daemon idles, so the armed revival fires — after the bounded
      // replacement grace at the chokepoint (#663).
      await vi.advanceTimersByTimeAsync(2_500);
      expect(restartRequests).toHaveLength(1);
      vi.useRealTimers();
    } finally {
      (daemon as any).clearMcpRestartRequest();
      rmSync(instanceDir, { recursive: true, force: true });
    }
  });
});

describe("mcp_died notification priority", () => {
  function lifecycle() {
    const notifyInstanceTopic = vi.fn();
    const ctx = {
      fleetConfig: { instances: { worker: { backend: "codex" } }, defaults: {} },
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      eventLog: null,
      isPlannedRestart: () => false,
      notifyInstanceTopic,
      webhookEmit: vi.fn(),
      clearCancelButton: vi.fn(),
      checkModelFailover() {},
      restartSingleInstance: async () => {},
      getInstanceDir: (n: string) => `/nonexistent/${n}`,
    } as unknown as LifecycleContext;
    const lc = new InstanceLifecycle(ctx);
    const daemon = Object.assign(new EventEmitter(), { requestPauseWhenIdle: vi.fn() });
    lc.attachIncidentHandlers("worker", daemon as any);
    return { daemon, notifyInstanceTopic };
  }

  it("authSuspected swaps the MCP message for the 🔑 /login hint without re-probing", async () => {
    const runner = vi.fn(async () => ({ code: 0, output: "" }));
    setAuthCheckRunnerForTests(runner);
    const { daemon, notifyInstanceTopic } = lifecycle();
    daemon.emit("mcp_died", { name: "worker", pid: 123, autoRestart: false, authSuspected: true });
    await vi.waitFor(() => expect(notifyInstanceTopic).toHaveBeenCalledTimes(1));
    const text = String(notifyInstanceTopic.mock.calls[0][1]);
    expect(text).toContain("🔑");
    expect(text).toContain("/login codex");
    expect(text).not.toContain("MCP server 已終止");
    expect(runner).not.toHaveBeenCalled();
  });

  it("without suspicion, a failing probe still swaps the message", async () => {
    setAuthCheckRunnerForTests(async () => ({ code: 1, output: "Not logged in" }));
    const { daemon, notifyInstanceTopic } = lifecycle();
    daemon.emit("mcp_died", { name: "worker", pid: 123, autoRestart: true });
    await vi.waitFor(() => expect(notifyInstanceTopic).toHaveBeenCalledTimes(1));
    expect(String(notifyInstanceTopic.mock.calls[0][1])).toContain("🔑");
  });

  it("a passing probe keeps the accurate MCP report", async () => {
    setAuthCheckRunnerForTests(async () => ({ code: 0, output: "Logged in" }));
    const { daemon, notifyInstanceTopic } = lifecycle();
    daemon.emit("mcp_died", { name: "worker", pid: 123, autoRestart: true });
    await vi.waitFor(() => expect(notifyInstanceTopic).toHaveBeenCalledTimes(1));
    const text = String(notifyInstanceTopic.mock.calls[0][1]);
    expect(text).toContain("MCP server 已終止");
    expect(text).not.toContain("🔑");
  });
});
