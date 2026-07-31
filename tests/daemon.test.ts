import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Daemon } from "../src/daemon.js";
import type { InstanceConfig } from "../src/types.js";
import { ClaudeCodeBackend } from "../src/backend/claude-code.js";
import { AntigravityBackend } from "../src/backend/antigravity.js";
import { createBackend } from "../src/backend/factory.js";
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import pino from "pino";
import type { Logger } from "../src/logger.js";

const rootLogger = pino({ level: "silent" }) as Logger;

const makeConfig = (): InstanceConfig => ({
  working_directory: "/tmp/test",
  restart_policy: { max_retries: 10, backoff: "exponential", reset_after: 300 },
  context_guardian: { restart_threshold_pct: 80, max_age_hours: 4, grace_period_ms: 600_000 },
  memory: { auto_summarize: false, watch_memory_dir: false, backup_to_sqlite: false },
  log_level: "info",
});

describe("Daemon", () => {
  it("creates transport-free children from one injected fleet logger", () => {
    const child = vi.fn(() => pino({ level: "silent" }));
    const sharedRoot = { child } as unknown as Logger;
    const before = process.listenerCount("exit");

    for (let i = 0; i < 30; i++) {
      new Daemon(`shared-${i}`, makeConfig(), `/tmp/shared-${i}`, false, undefined, undefined, sharedRoot);
    }

    expect(child).toHaveBeenCalledTimes(30);
    expect(child).toHaveBeenNthCalledWith(1, { instance: "shared-0" }, { level: "info" });
    expect(process.listenerCount("exit")).toBe(before);
  });

  it("constructs with valid config", () => {
    const backend = new ClaudeCodeBackend("/tmp/ccd-test-instance");
    const daemon = new Daemon("test", makeConfig(), "/tmp/ccd-test-instance", false, backend, undefined, rootLogger);
    expect(daemon).toBeDefined();
  });

  it("constructs with topic mode flag", () => {
    const backend = new ClaudeCodeBackend("/tmp/ccd-test-instance");
    const daemon = new Daemon("test", makeConfig(), "/tmp/ccd-test-instance", true, backend, undefined, rootLogger);
    expect(daemon).toBeDefined();
  });

  it("injects the effective runtime identity into backend instructions", () => {
    const instanceDir = "/tmp/codex-runtime-identity";
    const backend = createBackend("codex", instanceDir);
    const daemon = new Daemon(
      "classic-codex",
      { ...makeConfig(), backend: "codex", model: "gpt-5.6-sol" },
      instanceDir,
      true,
      backend,
      undefined,
      rootLogger,
      { kind: "classic", backend: "codex", model: "gpt-5.6-sol" },
    );

    const config = (daemon as any).buildBackendConfig();

    expect(config.instructions)
      .toContain("Runtime: kind=classic, backend=codex, model=gpt-5.6-sol.");
    expect(config.mcpServers.agend.env).toMatchObject({
      AGEND_INSTANCE_KIND: "classic",
      AGEND_BACKEND: "codex",
      AGEND_MODEL: "gpt-5.6-sol",
    });
  });

  it("sends agy's verified two-stage Ctrl+C shutdown sequence", async () => {
    const backend = new AntigravityBackend("/tmp/agy-test-instance");
    const daemon = new Daemon("agy-test", makeConfig(), "/tmp/agy-test-instance", false, backend, undefined, rootLogger);
    const sendSpecialKey = vi.fn().mockResolvedValue(true);
    (daemon as any).tmux = {
      sendKeys: vi.fn().mockResolvedValue(true),
      sendSpecialKey,
    };

    await (daemon as any).sendQuitSequence();

    expect(backend.getQuitCommand()).toBeNull();
    expect(sendSpecialKey.mock.calls).toEqual([["C-c"], ["C-c"]]);
  });
});

describe("Daemon backend-native input queue delivery", () => {
  function makeDeliveryDaemon(backendName: "codex" | "claude-code", idle: boolean, pane = "") {
    const instanceDir = join(tmpdir(), `agend-queued-input-${backendName}-${Date.now()}-${Math.random()}`);
    mkdirSync(instanceDir, { recursive: true });
    writeFileSync(join(instanceDir, "window-id"), "@queued");

    const backend = createBackend(backendName, instanceDir);
    const control = {
      isIdle: vi.fn(() => idle),
      waitUntilIdle: vi.fn().mockResolvedValue(undefined),
      hasOutputSince: vi.fn(() => false),
    };
    const daemon = new Daemon(
      `${backendName}-queue-test`,
      makeConfig(),
      instanceDir,
      false,
      backend,
      control as any,
      rootLogger,
    );
    const tmux = {
      pasteBuffer: vi.fn().mockResolvedValue(true),
      sendSpecialKey: vi.fn().mockResolvedValue(true),
      capturePane: vi.fn().mockResolvedValue(pane),
    };
    (daemon as any).tmux = tmux;
    (daemon as any).firstDeliveryDelay = { consume: () => 0 };

    return { backend, control, daemon, instanceDir, tmux };
  }

  it("hands busy Codex input to its native queue with exactly one Enter when paste is visible", async () => {
    const { backend, control, daemon, instanceDir, tmux } = makeDeliveryDaemon(
      "codex",
      false,
      "thinking…\n↳ queued work",
    );
    const queued = vi.fn();
    const delivered = vi.fn();
    const confirmed = vi.fn();
    daemon.on("message_queued", queued);
    daemon.on("message_delivered", delivered);
    daemon.on("message_confirmed", confirmed);

    try {
      expect(backend.supportsQueuedInput?.()).toBe(true);

      const result = await (daemon as any).deliverMessage("queued work", {
        chatId: "chat",
        messageId: "message",
      });

      expect(result).toBe(true);
      expect(control.waitUntilIdle).not.toHaveBeenCalled();
      expect(control.hasOutputSince).not.toHaveBeenCalled();
      expect(tmux.pasteBuffer).toHaveBeenCalledTimes(1);
      expect(tmux.pasteBuffer).toHaveBeenCalledWith("queued work");
      expect(tmux.capturePane).toHaveBeenCalledOnce();
      expect(tmux.sendSpecialKey).toHaveBeenCalledTimes(1);
      expect(tmux.sendSpecialKey).toHaveBeenCalledWith("Enter");
      expect(queued).toHaveBeenCalledOnce();
      expect(delivered).toHaveBeenCalledOnce();
      expect(confirmed).toHaveBeenCalledOnce();
    } finally {
      rmSync(instanceDir, { recursive: true, force: true });
    }
  });

  it("re-delivers via idle gate when busy Codex paste is silently swallowed", async () => {
    // First capture (post busy-paste) empty → silent loss; after idle-gated
    // re-paste the text appears (or busy confirm succeeds).
    const { control, daemon, instanceDir, tmux } = makeDeliveryDaemon("codex", false, "");
    tmux.capturePane
      .mockResolvedValueOnce("working… redrawing…") // no text, no ↳
      .mockResolvedValue("↳ queued work that was swallowed");
    const confirm = vi.fn().mockResolvedValue(true);
    (daemon as any).confirmBusyAfterEnter = confirm;
    const failed = vi.fn();
    const confirmed = vi.fn();
    daemon.on("message_failed", failed);
    daemon.on("message_confirmed", confirmed);

    try {
      const result = await (daemon as any).deliverMessage("queued work that was swallowed", {
        chatId: "chat",
        messageId: "message",
      });

      expect(result).toBe(true);
      expect(control.waitUntilIdle).toHaveBeenCalledOnce();
      expect(tmux.pasteBuffer).toHaveBeenCalledTimes(2);
      expect(tmux.sendSpecialKey.mock.calls.filter((c: string[]) => c[0] === "Enter").length).toBeGreaterThanOrEqual(2);
      expect(confirm).toHaveBeenCalled();
      expect(confirmed).toHaveBeenCalledOnce();
      expect(failed).not.toHaveBeenCalled();
    } finally {
      rmSync(instanceDir, { recursive: true, force: true });
    }
  });

  it("emits message_failed when idle-gated redelivery also cannot land the paste", async () => {
    const { control, daemon, instanceDir, tmux } = makeDeliveryDaemon("codex", false, "still busy redraw");
    const confirm = vi.fn().mockResolvedValue(false);
    (daemon as any).confirmBusyAfterEnter = confirm;
    const failed = vi.fn();
    daemon.on("message_failed", failed);

    try {
      const result = await (daemon as any).deliverMessage("vanishing payload text", {
        chatId: "chat",
        messageId: "message",
      });

      expect(result).toBe(false);
      expect(control.waitUntilIdle).toHaveBeenCalledOnce();
      expect(tmux.pasteBuffer).toHaveBeenCalledTimes(2);
      expect(failed).toHaveBeenCalledOnce();
    } finally {
      rmSync(instanceDir, { recursive: true, force: true });
    }
  });

  it("keeps the idle gate and confirmation path for backends without a native queue", async () => {
    const { backend, control, daemon, instanceDir, tmux } = makeDeliveryDaemon("claude-code", false);
    const confirm = vi.fn().mockResolvedValue(true);
    (daemon as any).confirmBusyAfterEnter = confirm;

    try {
      expect(backend.supportsQueuedInput?.()).toBeUndefined();

      const result = await (daemon as any).deliverMessage("wait for idle");

      expect(result).toBe(true);
      expect(control.waitUntilIdle).toHaveBeenCalledOnce();
      expect(tmux.sendSpecialKey).toHaveBeenCalledTimes(1);
      expect(confirm).toHaveBeenCalledOnce();
    } finally {
      rmSync(instanceDir, { recursive: true, force: true });
    }
  });

  it("retains swallowed-Enter confirmation for Codex when it starts idle", async () => {
    const { control, daemon, instanceDir, tmux } = makeDeliveryDaemon("codex", true);
    const confirm = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    (daemon as any).confirmBusyAfterEnter = confirm;

    try {
      const result = await (daemon as any).deliverMessage("normal idle submission");

      expect(result).toBe(true);
      expect(control.waitUntilIdle).not.toHaveBeenCalled();
      expect(confirm).toHaveBeenCalledTimes(2);
      expect(tmux.sendSpecialKey).toHaveBeenCalledTimes(2);
    } finally {
      rmSync(instanceDir, { recursive: true, force: true });
    }
  });
});

describe("Daemon snapshot", () => {
  let tmpDir: string;
  let daemon: Daemon;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `ccd-daemon-snap-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    const backend = new ClaudeCodeBackend(tmpDir);
    daemon = new Daemon("test-snap", makeConfig(), tmpDir, false, backend, undefined, rootLogger);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writeRotationSnapshot creates rotation-state.json", () => {
    const snapshot = daemon.writeRotationSnapshot("context_full");
    const filePath = join(tmpDir, "rotation-state.json");
    expect(existsSync(filePath)).toBe(true);
    const written = JSON.parse(readFileSync(filePath, "utf-8"));
    expect(written.instance).toBe("test-snap");
    expect(written.reason).toBe("context_full");
    expect(snapshot.instance).toBe("test-snap");
  });

  it("buildSnapshotPrompt reads snapshot and deletes file", () => {
    // Write a snapshot file
    const snapshotData = {
      instance: "test-snap",
      reason: "max_age",
      created_at: new Date().toISOString(),
      working_directory: "/tmp/test",
      context_pct: 75,
      recent_user_messages: [{ text: "hello", ts: new Date().toISOString() }],
    };
    const filePath = join(tmpDir, "rotation-state.json");
    writeFileSync(filePath, JSON.stringify(snapshotData));
    expect(existsSync(filePath)).toBe(true);

    const result = (daemon as any).buildSnapshotPrompt();
    expect(result).toContain("Previous Session Snapshot");
    expect(result).toContain("max_age");
    expect(result).toContain("hello");

    // File is deleted after consumption to prevent stale re-injection on restart
    expect(existsSync(filePath)).toBe(false);
    // In-memory flag prevents re-injection within same daemon lifecycle
    expect((daemon as any).snapshotConsumed).toBe(true);
  });

  it("buildSnapshotPrompt returns null when no snapshot exists", () => {
    const result = (daemon as any).buildSnapshotPrompt();
    expect(result).toBeNull();
  });

  it("snapshotConsumed flag resets when new snapshot is written", () => {
    daemon.writeRotationSnapshot("context_full");
    const first = (daemon as any).buildSnapshotPrompt();
    expect(first).not.toBeNull();
    expect((daemon as any).snapshotConsumed).toBe(true);
    // Writing a new snapshot resets the flag
    daemon.writeRotationSnapshot("crash");
    expect((daemon as any).snapshotConsumed).toBe(false);
    const second = (daemon as any).buildSnapshotPrompt();
    expect(second).not.toBeNull();
  });
});

describe("Daemon failover cooldown", () => {
  let tmpDir: string;
  let daemon: Daemon;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `ccd-daemon-failover-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    const backend = new ClaudeCodeBackend(tmpDir);
    daemon = new Daemon("test-failover", makeConfig(), tmpDir, false, backend, undefined, rootLogger);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("suppresses failover errors within cooldown window", () => {
    // Simulate a recent failover
    (daemon as any).lastFailoverAt = Date.now();

    // The cooldown should be active (5 minutes)
    const cooldownMs = (Daemon as any).FAILOVER_COOLDOWN_MS;
    expect(cooldownMs).toBe(5 * 60_000);
    expect(Date.now() - (daemon as any).lastFailoverAt).toBeLessThan(cooldownMs);
  });

  it("allows failover after cooldown expires", () => {
    // Simulate a failover that happened 6 minutes ago
    (daemon as any).lastFailoverAt = Date.now() - 6 * 60_000;

    const cooldownMs = (Daemon as any).FAILOVER_COOLDOWN_MS;
    expect(Date.now() - (daemon as any).lastFailoverAt).toBeGreaterThan(cooldownMs);
  });

  it("lastFailoverAt starts at 0 (no cooldown on fresh daemon)", () => {
    expect((daemon as any).lastFailoverAt).toBe(0);
  });
});

describe("Daemon error monitor recovery", () => {
  let tmpDir: string;
  let daemon: Daemon;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `agend-error-monitor-${process.pid}-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    const backend = new ClaudeCodeBackend(tmpDir);
    daemon = new Daemon("test-errors", makeConfig(), tmpDir, false, backend, undefined, rootLogger);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("re-notifies after the recovery deadline when ready never matches", () => {
    const errors: unknown[] = [];
    daemon.on("pty_error", error => errors.push(error));
    const pattern = {
      pattern: /AUTH_EXPIRED/,
      type: "auth_error",
      action: "notify",
      message: "login required",
    };
    const now = 1_000_000;
    const timeout = (Daemon as any).ERROR_RECOVERY_TIMEOUT_MS;

    (daemon as any).evaluateErrorPatterns("AUTH_EXPIRED", [pattern], /READY/, now);
    expect(errors).toHaveLength(1);
    expect((daemon as any).errorWaitingForRecovery).toBe(true);

    (daemon as any).evaluateErrorPatterns("AUTH_EXPIRED", [pattern], /READY/, now + timeout);
    expect(errors).toHaveLength(1);

    (daemon as any).evaluateErrorPatterns("AUTH_EXPIRED", [pattern], /READY/, now + timeout + 1);
    expect(errors).toHaveLength(2);
    expect((daemon as any).errorRecoveryDeadlineAt).toBe(now + 2 * timeout + 1);
  });

  it("emits the real Codex quota pattern's formatted message through pty_error", () => {
    // Drives the actual daemon emit path with the actual backend pattern, so
    // neither the regex nor the message formatting is a test-local copy.
    const messages: string[] = [];
    daemon.on("pty_error", ({ message }) => messages.push(message));
    const patterns = createBackend("codex", tmpDir).getErrorPatterns!();
    const pane = "⚠ Heads up, you have less than 5% of your monthly limit left. Run /status for a\nbreakdown.";

    (daemon as any).evaluateErrorPatterns(pane, patterns, /READY/, 1_000_000);

    expect(messages).toEqual(["Codex monthly limit: less than 5% left"]);
  });

  it("falls back to the static message when a formatter throws", () => {
    const messages: string[] = [];
    daemon.on("pty_error", ({ message }) => messages.push(message));
    const pattern = {
      pattern: /BOOM (\d+)/,
      type: "quota",
      action: "notify",
      message: "static fallback",
      formatMessage: () => { throw new Error("bad formatter"); },
    };

    (daemon as any).evaluateErrorPatterns("BOOM 42", [pattern], /READY/, 1_000_000);

    expect(messages).toEqual(["static fallback"]);
  });

  it("emits a pty_error for the Codex workspace-credits line", () => {
    // Real backend patterns + the real emit path, including the wrapped tail.
    const events: { type: string; action: string; message: string }[] = [];
    daemon.on("pty_error", (e: any) => events.push(e));
    const patterns = createBackend("codex", tmpDir).getErrorPatterns!();
    const pane = "■ Your workspace is out of credits. Ask your workspace owner to refill in\norder to continue.";

    (daemon as any).evaluateErrorPatterns(pane, patterns, /READY/, 1_000_000);

    expect(events).toHaveLength(1);
    expect(events[0].action).toBe("notify");
    expect(events[0].message).toBe("Codex workspace credits exhausted — workspace owner must refill");
  });

  it("tracks count and cooldown independently for patterns with the same type", () => {    const messages: string[] = [];
    daemon.on("pty_error", ({ message }) => messages.push(message));
    const patterns = [
      { pattern: /LOGIN_EXPIRED/, type: "auth_error", action: "notify", message: "login", skipRecoveryWait: true },
      { pattern: /API_UNAUTHORIZED/, type: "auth_error", action: "notify", message: "api", skipRecoveryWait: true },
    ];
    const now = 1_000_000;

    (daemon as any).evaluateErrorPatterns("LOGIN_EXPIRED", patterns, /READY/, now);
    (daemon as any).evaluateErrorPatterns("API_UNAUTHORIZED", patterns, /READY/, now + 1);

    expect(messages).toEqual(["login", "api"]);
    expect((daemon as any).lastErrorCount.size).toBe(2);
    expect((daemon as any).lastErrorNotifiedAt.size).toBe(2);
  });

  it("absorbs the exact active pattern on recovery when types are shared", () => {
    const patterns = [
      { pattern: /LOGIN_EXPIRED/, type: "auth_error", action: "notify", message: "login" },
      { pattern: /API_UNAUTHORIZED/, type: "auth_error", action: "notify", message: "api" },
    ];
    const now = 1_000_000;
    const loginKey = (Daemon as any).errorPatternKey(patterns[0]);
    const apiKey = (Daemon as any).errorPatternKey(patterns[1]);

    (daemon as any).evaluateErrorPatterns("API_UNAUTHORIZED", patterns, /READY/, now);
    (daemon as any).evaluateErrorPatterns("API_UNAUTHORIZED\nREADY", patterns, /READY/, now + 1);

    expect((daemon as any).lastErrorCount.get(apiKey)).toBe(1);
    expect((daemon as any).lastErrorCount.has(loginKey)).toBe(false);
    expect((daemon as any).errorWaitingForRecovery).toBe(false);
  });

  it("continues to later patterns when the first is in cooldown", () => {
    const messages: string[] = [];
    daemon.on("pty_error", ({ message }) => messages.push(message));
    const patterns = [
      { pattern: /FIRST_ERROR/, type: "auth_error", action: "notify", message: "first", skipRecoveryWait: true },
      { pattern: /SECOND_ERROR/, type: "model_error", action: "notify", message: "second", skipRecoveryWait: true },
    ];
    const now = 1_000_000;
    const firstKey = (Daemon as any).errorPatternKey(patterns[0]);
    (daemon as any).lastErrorNotifiedAt.set(firstKey, now);

    (daemon as any).evaluateErrorPatterns("FIRST_ERROR\nSECOND_ERROR", patterns, /READY/, now + 1);

    expect(messages).toEqual(["second"]);
    expect((daemon as any).lastErrorCount.has(firstKey)).toBe(false);
  });

  it("clears the recovery gate after a crash respawn reaches running", () => {
    (daemon as any).errorWaitingForRecovery = true;
    (daemon as any).errorDetectedAt = 100;
    (daemon as any).errorRecoveryDeadlineAt = 200;
    (daemon as any).activeErrorPatternKey = "auth_error:AUTH";

    (daemon as any).setProcessStatus("crashed");
    (daemon as any).setProcessStatus("running");

    expect((daemon as any).errorWaitingForRecovery).toBe(false);
    expect((daemon as any).errorRecoveryDeadlineAt).toBe(0);
    expect((daemon as any).activeErrorPatternKey).toBeNull();
  });
});
