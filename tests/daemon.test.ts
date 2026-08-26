import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Daemon, PaneStateMachine } from "../src/daemon.js";
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

  it("auto-confirms Kiro's clear prompt only after an armed /clear delivery", async () => {
    const backend = createBackend("kiro-cli", "/tmp/kiro-clear-confirm-test");
    const daemon = new Daemon(
      "kiro-clear-confirm",
      makeConfig(),
      "/tmp/kiro-clear-confirm-test",
      false,
      backend,
      undefined,
      rootLogger,
    );
    const tmux = {
      capturePane: vi.fn().mockResolvedValue(
        "Are you sure? This will erase the conversation history and cannot be undone. [y/n]:",
      ),
      sendKeys: vi.fn().mockResolvedValue(true),
      sendSpecialKey: vi.fn().mockResolvedValue(true),
    };
    (daemon as any).tmux = tmux;
    vi.spyOn(daemon as any, "wake").mockResolvedValue(undefined);
    const deliver = vi.spyOn(daemon as any, "deliverMessage").mockResolvedValue(true);

    (daemon as any).queueRawPaste("/clear", 0, true);
    await (daemon as any).pasteLock;

    expect(deliver).toHaveBeenCalledWith("/clear", undefined, { deliveryEpoch: 0 });
    expect(tmux.sendKeys).toHaveBeenCalledOnce();
    expect(tmux.sendKeys).toHaveBeenCalledWith("y");
    expect(tmux.sendSpecialKey).toHaveBeenCalledOnce();
    expect(tmux.sendSpecialKey).toHaveBeenCalledWith("Enter");

    tmux.sendKeys.mockClear();
    tmux.sendSpecialKey.mockClear();
    (daemon as any).queueRawPaste("/clear", 0, false);
    await (daemon as any).pasteLock;
    expect(tmux.sendKeys).not.toHaveBeenCalled();
    expect(tmux.sendSpecialKey).not.toHaveBeenCalled();
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

    await expect((daemon as any).sendQuitSequence()).resolves.toBe(true);

    expect(backend.getQuitCommand()).toBeNull();
    expect(sendSpecialKey.mock.calls).toEqual([["C-c"], ["C-c"]]);
  });

  it("stops agy gracefully with Ctrl+C twice before touching its process tree", async () => {
    const instanceDir = join(tmpdir(), `agy-graceful-stop-${Date.now()}-${Math.random()}`);
    mkdirSync(instanceDir, { recursive: true });
    const backend = new AntigravityBackend(instanceDir);
    const daemon = new Daemon(
      "agy-graceful-stop",
      { ...makeConfig(), working_directory: instanceDir },
      instanceDir,
      false,
      backend,
      undefined,
      rootLogger,
    );
    const sendSpecialKey = vi.fn().mockResolvedValue(true);
    const tmux = {
      sendKeys: vi.fn().mockResolvedValue(true),
      sendSpecialKey,
      getPaneStatus: vi.fn().mockResolvedValue({ alive: false, exitCode: 0 }),
      getWindowId: vi.fn(() => "@agy"),
      killWindow: vi.fn().mockResolvedValue(undefined),
    };
    (daemon as any).tmux = tmux;
    const killProcessTree = vi.spyOn(daemon as any, "killProcessTree").mockResolvedValue(undefined);

    try {
      await daemon.stop();

      expect(sendSpecialKey.mock.calls).toEqual([["C-c"], ["C-c"]]);
      expect(tmux.getPaneStatus).toHaveBeenCalledOnce();
      expect(killProcessTree).not.toHaveBeenCalled();
      expect(tmux.killWindow).toHaveBeenCalledOnce();
    } finally {
      rmSync(instanceDir, { recursive: true, force: true });
    }
  });

  it("falls back from an unresponsive graceful quit to SIGTERM then SIGKILL", async () => {
    vi.useFakeTimers();
    const instanceDir = join(tmpdir(), `agy-stop-fallback-${Date.now()}-${Math.random()}`);
    mkdirSync(instanceDir, { recursive: true });
    const backend = new AntigravityBackend(instanceDir);
    const daemon = new Daemon(
      "agy-stop-fallback",
      { ...makeConfig(), working_directory: instanceDir },
      instanceDir,
      false,
      backend,
      undefined,
      rootLogger,
    );
    const tmux = {
      sendKeys: vi.fn().mockResolvedValue(true),
      sendSpecialKey: vi.fn().mockResolvedValue(true),
      getPaneStatus: vi.fn().mockResolvedValue({ alive: true }),
      getWindowId: vi.fn(() => "@agy"),
      killWindow: vi.fn().mockResolvedValue(undefined),
    };
    (daemon as any).tmux = tmux;
    const killProcessTree = vi.spyOn(daemon as any, "killProcessTree").mockResolvedValue(undefined);

    try {
      const stopping = daemon.stop();
      await vi.runAllTimersAsync();
      await stopping;

      expect(killProcessTree.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
      expect(tmux.killWindow).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
      rmSync(instanceDir, { recursive: true, force: true });
    }
  });

  it("enables MCP by default for Antigravity and preserves explicit CLI mode", () => {
    const instanceDir = "/tmp/agy-mcp-default";
    const backend = new AntigravityBackend(instanceDir);
    const mcpDaemon = new Daemon(
      "agy-mcp",
      { ...makeConfig(), backend: "antigravity" },
      instanceDir,
      true,
      backend,
      undefined,
      rootLogger,
    );
    expect((mcpDaemon as any).buildBackendConfig().mcpServers.agend).toBeDefined();

    const cliDaemon = new Daemon(
      "agy-cli",
      { ...makeConfig(), backend: "antigravity", agent_mode: "cli" },
      instanceDir,
      true,
      backend,
      undefined,
      rootLogger,
    );
    expect((cliDaemon as any).buildBackendConfig().mcpServers).toEqual({});
  });
});

describe("Daemon backend-native input queue delivery", () => {
  function makeDeliveryDaemon(backendName: "codex" | "claude-code" | "kiro-cli" | "antigravity", idle: boolean, pane = "") {
    const instanceDir = join(tmpdir(), `agend-queued-input-${backendName}-${Date.now()}-${Math.random()}`);
    mkdirSync(instanceDir, { recursive: true });
    writeFileSync(join(instanceDir, "window-id"), "@queued");

    const backend = createBackend(backendName, instanceDir);
    const control = {
      isIdle: vi.fn(() => idle),
      // Resolves true = the pane reached idle. It returns a boolean now so a wedged
      // pane can be reported as a delivery failure instead of silently absorbing
      // the queue; see the "wedged pane" case below.
      waitUntilIdle: vi.fn().mockResolvedValue(true),
      hasOutputSince: vi.fn(() => false),
      // Adaptive paste settle: no observable output → it degrades to the fixed
      // fallback delay, which these tests already zero via firstDeliveryDelay.
      getLastOutputAt: vi.fn(() => undefined),
      getObservationResetAt: vi.fn(() => 0),
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

  it("drops pre-cancel channel and raw deliveries but keeps post-cancel input", async () => {
    const { daemon, instanceDir } = makeDeliveryDaemon("claude-code", true);
    let releaseFirst!: () => void;
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>(resolve => { markFirstStarted = resolve; });
    const firstBlocked = new Promise<void>(resolve => { releaseFirst = resolve; });
    const delivered: string[] = [];
    let calls = 0;
    (daemon as any).deliverMessage = vi.fn(async (text: string) => {
      delivered.push(text);
      if (++calls === 1) {
        markFirstStarted();
        await firstBlocked;
      }
      return true;
    });
    const meta = { from_instance: "sender", user: "sender", chat_id: "" };

    try {
      daemon.pushChannelMessage("already started", meta);
      await firstStarted;

      daemon.pushChannelMessage("queued before cancel", meta);
      (daemon as any).queueRawPaste("silent schedule before cancel");
      daemon.clearPendingDeliveries();

      // New input can arrive before the current PTY transaction finishes. It
      // captures the new epoch and must survive behind the invalidated entries.
      daemon.pushChannelMessage("late IPC delivery from old epoch", meta, undefined, 0);
      daemon.pushChannelMessage("user input after cancel", meta);
      (daemon as any).queueRawPaste("silent schedule after cancel");
      releaseFirst();
      await (daemon as any).pasteLock;

      expect(delivered.some(text => text.includes("already started"))).toBe(true);
      expect(delivered.some(text => text.includes("queued before cancel"))).toBe(false);
      expect(delivered.some(text => text.includes("late IPC delivery from old epoch"))).toBe(false);
      expect(delivered).not.toContain("silent schedule before cancel");
      expect(delivered.some(text => text.includes("user input after cancel"))).toBe(true);
      expect(delivered).toContain("silent schedule after cancel");
    } finally {
      rmSync(instanceDir, { recursive: true, force: true });
    }
  });

  it("cancels a delivery that entered the idle wait but has not pasted yet", async () => {
    const { control, daemon, instanceDir, tmux } = makeDeliveryDaemon("claude-code", false);
    let releaseIdleWait!: (idle: boolean) => void;
    control.waitUntilIdle.mockImplementation(() => new Promise<boolean>(resolve => {
      releaseIdleWait = resolve;
    }));

    try {
      daemon.pushChannelMessage("waiting but not pasted", {
        from_instance: "sender", user: "sender", chat_id: "",
      });
      await vi.waitFor(() => expect(control.waitUntilIdle).toHaveBeenCalledOnce());

      daemon.clearPendingDeliveries();
      releaseIdleWait(true);
      await (daemon as any).pasteLock;

      expect(tmux.pasteBuffer).not.toHaveBeenCalled();
    } finally {
      rmSync(instanceDir, { recursive: true, force: true });
    }
  });

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

  it("does not make Antigravity wait 30s for an unchanged periodic footer redraw", async () => {
    const idlePane = "────────\n>\n────────\nContext 16% used";
    const { backend, control, daemon, instanceDir, tmux } = makeDeliveryDaemon("antigravity", false, idlePane);
    const machine = new PaneStateMachine(backend.getReadyPattern(), 600_000, 0, backend.getBusyPattern?.());
    machine.observe(idlePane, 500);
    (daemon as any).instanceStateMachine = machine;
    (daemon as any).instanceState = "idle";
    control.getLastOutputAt.mockReturnValue(1_000);
    const confirm = vi.fn().mockResolvedValue(true);
    (daemon as any).confirmBusyAfterEnter = confirm;

    try {
      expect(backend.hasPeriodicPaneRedraw?.()).toBe(true);
      // A stale idle observation must not bypass either newer output or a
      // control reconnect. Only a post-redraw capture makes the pane trusted.
      expect((daemon as any).isPaneIdleForDelivery("@queued")).toBe(false);
      machine.observe(idlePane, 2_000);
      expect((daemon as any).isPaneIdleForDelivery("@queued")).toBe(true);
      control.getObservationResetAt.mockReturnValue(2_500);
      expect((daemon as any).isPaneIdleForDelivery("@queued")).toBe(false);
      control.getObservationResetAt.mockReturnValue(0);

      expect(await (daemon as any).deliverMessage("deliver despite cosmetic redraw")).toBe(true);
      expect(control.waitUntilIdle).not.toHaveBeenCalled();
      expect(tmux.pasteBuffer).toHaveBeenCalledOnce();
    } finally {
      rmSync(instanceDir, { recursive: true, force: true });
    }
  });

  it("always retries the first post-restart Enter for Kiro before trusting redraw output", async () => {
    const { backend, daemon, instanceDir, tmux } = makeDeliveryDaemon("kiro-cli", true);
    // Simulate the regression: Kiro's final startup redraw makes the pane look
    // busy even though it swallowed the first Enter. The ordinary conditional
    // confirmation would therefore return true and never send the retry.
    const confirm = vi.fn().mockResolvedValue(true);
    (daemon as any).confirmBusyAfterEnter = confirm;
    (daemon as any).firstDeliveryDelay = { consume: () => 501 };

    try {
      expect(backend.supportsQueuedInput?.()).toBeUndefined();
      expect(backend.requiresDeliveryEnterRetry?.()).toBe(true);

      const result = await (daemon as any).deliverMessage("first message after restart");

      expect(result).toBe(true);
      expect(tmux.pasteBuffer).toHaveBeenCalledOnce();
      expect(tmux.sendSpecialKey.mock.calls.filter((call: string[]) => call[0] === "Enter")).toHaveLength(2);
      expect(confirm).toHaveBeenCalledOnce();
    } finally {
      rmSync(instanceDir, { recursive: true, force: true });
    }
  });

  it("retries Enter on later Kiro deliveries too — the swallow is not startup-only", async () => {
    // DELIBERATE ASSERTION FLIP (was: "does not add the Kiro-only retry to later
    // deliveries"). v2.1.2 stable field report: on a slow WSL2 host a large paste
    // is still rendering when the single Enter lands, kiro's legacy input swallows
    // it, and the paste's own late output satisfies confirmBusyAfterEnter — the
    // message is confirmed while its text sits unsubmitted. A bare extra Enter is
    // a no-op for kiro at an empty prompt AND during generation (verified live),
    // so every delivery gets the defensive retry.
    const { daemon, instanceDir, tmux } = makeDeliveryDaemon("kiro-cli", true);
    const confirm = vi.fn().mockResolvedValue(true);
    (daemon as any).confirmBusyAfterEnter = confirm;
    (daemon as any).firstDeliveryDelay = { consume: () => 500 };

    try {
      expect(await (daemon as any).deliverMessage("later message")).toBe(true);
      expect(tmux.sendSpecialKey.mock.calls.filter((call: string[]) => call[0] === "Enter")).toHaveLength(2);
    } finally {
      rmSync(instanceDir, { recursive: true, force: true });
    }
  });

  it("does not add the Kiro retry to backends without the capability", async () => {
    const { daemon, instanceDir, tmux } = makeDeliveryDaemon("claude-code", true);
    const confirm = vi.fn().mockResolvedValue(true);
    (daemon as any).confirmBusyAfterEnter = confirm;
    (daemon as any).firstDeliveryDelay = { consume: () => 500 };

    try {
      expect(await (daemon as any).deliverMessage("plain message")).toBe(true);
      expect(tmux.sendSpecialKey.mock.calls.filter((call: string[]) => call[0] === "Enter")).toHaveLength(1);
    } finally {
      rmSync(instanceDir, { recursive: true, force: true });
    }
  });

  it("reports a delivery failure when the pane never frees up", async () => {
    // waitUntilIdle used to have no timeout at all: a wedged pane held the
    // pasteLock forever and every message behind it queued silently, with no ❌ and
    // no log — the caller believed delivery was merely slow.
    const { control, daemon, instanceDir, tmux } = makeDeliveryDaemon("claude-code", false);
    control.waitUntilIdle.mockResolvedValue(false);
    const failed = vi.fn();
    daemon.on("message_failed", failed);

    try {
      const result = await (daemon as any).deliverMessage("into a wedged pane", {
        chatId: "chat",
        messageId: "message",
      });

      expect(result).toBe(false);
      expect(failed).toHaveBeenCalledOnce();
      // Nothing was pasted into the wedged CLI, where it would have sat
      // unsubmitted and had the next message land on top of it.
      expect(tmux.pasteBuffer).not.toHaveBeenCalled();
    } finally {
      rmSync(instanceDir, { recursive: true, force: true });
    }
  });

  it("reports a failure when both Enters are swallowed instead of claiming success", async () => {
    // The message is sitting UNSUBMITTED in the CLI's input box. This used to
    // return true, leaving the reaction at 👀 forever while the next delivery
    // pasted on top — submitting two messages as one.
    const { daemon, instanceDir, tmux } = makeDeliveryDaemon("claude-code", true);
    (daemon as any).confirmBusyAfterEnter = vi.fn().mockResolvedValue(false);
    const failed = vi.fn();
    const confirmed = vi.fn();
    daemon.on("message_failed", failed);
    daemon.on("message_confirmed", confirmed);

    try {
      const result = await (daemon as any).deliverMessage("never submitted", {
        chatId: "chat",
        messageId: "message",
      });

      expect(result).toBe(false);
      expect(failed).toHaveBeenCalledOnce();
      expect(confirmed).not.toHaveBeenCalled();
      expect(tmux.sendSpecialKey).toHaveBeenCalledTimes(2); // original + one retry
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
    // pause: instance-lifecycle pauses (or defers to idle) on this action, so the
    // instance stops re-sending context into a CLI that can only fail.
    expect(events[0].action).toBe("pause");
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

describe("Daemon /steer delivery", () => {
  function makeSteerDaemon(backendName: "claude-code" | "codex", idle: boolean, pane = "") {
    const instanceDir = join(tmpdir(), `agend-steer-${backendName}-${Date.now()}-${Math.random()}`);
    mkdirSync(instanceDir, { recursive: true });
    writeFileSync(join(instanceDir, "window-id"), "@steer");

    const backend = createBackend(backendName, instanceDir);
    const control = {
      isIdle: vi.fn(() => idle),
      waitUntilIdle: vi.fn().mockResolvedValue(true),
      hasOutputSince: vi.fn(() => true),
      getLastOutputAt: vi.fn(() => undefined),
      getObservationResetAt: vi.fn(() => 0),
    };
    const daemon = new Daemon(
      `${backendName}-steer-test`,
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
    return { control, daemon, tmux };
  }

  it("pastes into a BUSY non-queue CLI immediately instead of waiting for idle", async () => {
    // The point of /steer: claude-code has no supportsQueuedInput, so a normal
    // delivery would block on waitUntilIdle. steer takes the immediate-paste
    // transaction (the same one codex native-queue handoff uses), whose pane
    // visibility check confirms the text landed.
    const { control, daemon, tmux } = makeSteerDaemon(
      "claude-code", false,
      "✻ thinking…\n[STEERING — mid-task course correction from the user. Fold this into the CURRENT work.]",
    );
    const confirmed = vi.fn();
    daemon.on("message_confirmed", confirmed);

    const result = await (daemon as any).deliverMessage(
      "[STEERING — mid-task course correction from the user. Fold this into the CURRENT work.]\n[user:han] focus",
      { chatId: "c", messageId: "m" },
      { steer: true },
    );

    expect(result).toBe(true);
    expect(control.waitUntilIdle).not.toHaveBeenCalled();
    expect(tmux.pasteBuffer).toHaveBeenCalledTimes(1);
    expect(confirmed).toHaveBeenCalled();
  }, 15_000);

  it("falls back to the idle-gated queue when the busy TUI swallows the paste", async () => {
    // kiro-style swallow: the pasted text never shows up in the pane. The steer
    // must degrade to "next message after this turn", not vanish silently.
    const { control, daemon, tmux } = makeSteerDaemon("claude-code", false, "✻ thinking… nothing else");
    const confirmed = vi.fn();
    daemon.on("message_confirmed", confirmed);

    const result = await (daemon as any).deliverMessage(
      "[STEERING] steer that will be swallowed by the TUI redraw",
      { chatId: "c", messageId: "m" },
      { steer: true },
    );

    expect(result).toBe(true);
    expect(control.waitUntilIdle).toHaveBeenCalled(); // the fallback path
    expect(tmux.pasteBuffer).toHaveBeenCalledTimes(2); // busy paste + idle re-paste
    expect(confirmed).toHaveBeenCalled();
  }, 15_000);

  it("delivers steer to an IDLE pane exactly like a normal message", async () => {
    const { control, daemon, tmux } = makeSteerDaemon("claude-code", true);
    const result = await (daemon as any).deliverMessage("steer while idle", undefined, { steer: true });
    expect(result).toBe(true);
    expect(control.waitUntilIdle).not.toHaveBeenCalled();
    expect(tmux.pasteBuffer).toHaveBeenCalledTimes(1);
  }, 15_000);

  it("steerMessage wraps content with the STEERING banner and the normal [user:] format", async () => {
    const { daemon } = makeSteerDaemon("claude-code", true);
    const seen: Array<{ formatted: string; opts: unknown }> = [];
    (daemon as any).deliverMessage = vi.fn(async (formatted: string, _s: unknown, opts: unknown) => {
      seen.push({ formatted, opts });
      return true;
    });
    (daemon as any).wake = vi.fn(async () => {});

    (daemon as any).steerMessage("focus on tests", {
      chat_id: "chat-9", message_id: "msg-9", user: "han", user_id: "u1",
      thread_id: "topic-9", adapter_id: "discord-main", source: "discord",
    });
    await (daemon as any).steerLock;

    expect(seen).toHaveLength(1);
    const { formatted, opts } = seen[0];
    expect(opts).toMatchObject({ steer: true });
    expect(formatted).toContain("[STEERING");
    // Identical wrapper to a queued inbound (#528 trap 6): user prefix with
    // source and id, handoff metadata, and the reply-tool instruction.
    expect(formatted).toContain("[user:han via discord, id:u1] focus on tests");
    expect(formatted).toContain("(message_id: msg-9)");
    expect(formatted).toContain("Reply using the reply tool");
  });

  it("btwMessage submits a reply-capable side-question wrapper instead of native /btw", async () => {
    const { daemon } = makeSteerDaemon("claude-code", true);
    const deliverMessage = vi.fn().mockResolvedValue(true);
    (daemon as any).deliverMessage = deliverMessage;
    (daemon as any).wake = vi.fn(async () => {});

    (daemon as any).btwMessage("what changed?", {
      chat_id: "chat-9", message_id: "msg-9", user: "han", user_id: "u1",
      thread_id: "topic-9", adapter_id: "discord-main", source: "discord",
    });
    await (daemon as any).steerLock;

    expect(deliverMessage).toHaveBeenCalledOnce();
    expect(deliverMessage).toHaveBeenCalledWith(
      expect.any(String),
      { chatId: "topic-9", messageId: "msg-9" },
      expect.objectContaining({ steer: true }),
    );
    const pasted = String(deliverMessage.mock.calls[0][0]);
    expect(pasted).toContain("[BTW — side question from the user.");
    expect(pasted).toContain("[user:han via discord, id:u1] what changed?");
    expect(pasted).toContain("Reply using the reply tool");
    expect(pasted).not.toContain("/btw what changed?");
    expect(pasted).not.toContain("[STEERING");
  });

  it("submits the BTW wrapper immediately to a busy Claude pane", async () => {
    const formatted = "[BTW — side question from the user.]\n[user:han] side question";
    const { control, daemon, tmux } = makeSteerDaemon("claude-code", false, formatted);

    const result = await (daemon as any).deliverMessage(
      formatted,
      undefined,
      { steer: true },
    );

    expect(result).toBe(true);
    expect(control.waitUntilIdle).not.toHaveBeenCalled();
    expect(tmux.pasteBuffer).toHaveBeenCalledWith(formatted);
  }, 15_000);
});
