import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { FleetManager, resolveReplyThreadId } from "../src/fleet-manager.js";
import { TopicCommands } from "../src/topic-commands.js";
import { join, basename } from "node:path";
import { mkdirSync, rmSync, writeFileSync, readFileSync, symlinkSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import yaml from "js-yaml";
import { ClassicChannelManager, getClassicBackendChoices } from "../src/classic-channel-manager.js";
import { KNOWN_BACKENDS } from "../src/config-validator.js";

describe("FleetManager", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `ccd-fleet-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("detects stopped instance (no PID)", () => {
    const fm = new FleetManager(tmpDir);
    mkdirSync(join(tmpDir, "instances/test"), { recursive: true });
    expect(fm.getInstanceStatus("test")).toBe("stopped");
  });

  it("detects crashed instance (stale PID)", () => {
    const fm = new FleetManager(tmpDir);
    const dir = join(tmpDir, "instances/test");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "daemon.pid"), "99999999");
    expect(fm.getInstanceStatus("test")).toBe("crashed");
  });

  it("reports an auto-paused daemon separately from running", () => {
    const fm = new FleetManager(tmpDir);
    vi.spyOn(fm.lifecycle, "isPaused").mockReturnValue(true);
    expect(fm.getInstanceStatus("test")).toBe("paused");
  });

  it("caches daemon execution-state snapshots for status surfaces", () => {
    const fm = new FleetManager(tmpDir);
    fm.fleetConfig = { defaults: {}, instances: { test: { working_directory: "/tmp" } } };
    vi.spyOn(fm.lifecycle, "isPaused").mockReturnValue(false);

    (fm as any).cacheInstanceExecutionState("test", {
      state: "working",
      unchangedForMs: 250,
      observedAt: 1_000,
      stateChangedAt: 750,
    });

    expect(fm.getInstanceExecutionState("test")).toBe("working");
    expect((fm.getSysInfo().instances.find(i => i.name === "test") as any)?.state).toBe("working");
  });

  it("does not expose a stale execution state while paused", () => {
    const fm = new FleetManager(tmpDir);
    (fm as any).cacheInstanceExecutionState("test", { state: "idle" });
    vi.spyOn(fm.lifecycle, "isPaused").mockReturnValue(true);
    expect(fm.getInstanceExecutionState("test")).toBeNull();
  });

  it("builds ClassicBot backend choices without deprecated or test-only backends", () => {
    const choices = getClassicBackendChoices();
    expect(choices.map(choice => choice.id)).toEqual(
      KNOWN_BACKENDS.filter(backend => backend !== "mock" && backend !== "gemini-cli"),
    );
    expect(choices.find(choice => choice.id === "grok")?.label).toBe("grok ⚠️");
    expect(choices.some(choice => choice.id === "mock")).toBe(false);
  });

  it("marks backend menu labels from the fleet process PATH", async () => {
    const originalPath = process.env.PATH;
    const binDir = join(tmpDir, "test-bin");
    mkdirSync(binDir);
    symlinkSync(execFileSync("which", ["which"], { encoding: "utf8" }).trim(), join(binDir, "which"));
    writeFileSync(join(binDir, "codex"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(binDir, "codex"), 0o755);
    process.env.PATH = binDir;
    try {
      const fm = new FleetManager(tmpDir);
      const classicChannels = new ClassicChannelManager(tmpDir, fm.logger);
      classicChannels.setPrimaryAdapterId("telegram");
      fm.classicChannels = classicChannels;
      vi.spyOn(fm as any, "startClassicInstance").mockResolvedValue(undefined);
      const promptUser = vi.fn().mockResolvedValue("menu-1");
      const adapter = {
        id: "telegram",
        type: "telegram",
        promptUser,
        editMessageRemoveButtons: vi.fn().mockResolvedValue(undefined),
      } as any;

      await (fm as any).beginClassicBackendSelection({
        command: "start",
        channelId: "12345",
        channelName: "test-room",
        userId: "owner",
        respond: vi.fn().mockResolvedValue(undefined),
      }, adapter);
      const choices = promptUser.mock.calls[0][2] as Array<{ id: string; label: string }>;
      expect(choices.find(choice => choice.id.endsWith(":codex"))?.label).toBe("✅ codex");
      expect(choices.find(choice => choice.id.endsWith(":claude-code"))?.label).toBe("❌ claude-code");

      const codex = choices.find(choice => choice.id.endsWith(":codex"))!;
      await (fm as any).handleClassicBackendSelection({
        callbackData: codex.id,
        chatId: "12345",
        messageId: "menu-1",
        userId: "owner",
      });
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("warns for a missing Discord slash-choice backend but still attempts startup", async () => {
    const originalPath = process.env.PATH;
    const binDir = join(tmpDir, "empty-test-bin");
    mkdirSync(binDir);
    symlinkSync(execFileSync("which", ["which"], { encoding: "utf8" }).trim(), join(binDir, "which"));
    process.env.PATH = binDir;
    try {
      const fm = new FleetManager(tmpDir);
      const classicChannels = new ClassicChannelManager(tmpDir, fm.logger);
      classicChannels.setPrimaryAdapterId("discord");
      fm.classicChannels = classicChannels;
      const start = vi.spyOn(fm as any, "startClassicInstance").mockResolvedValue(undefined);
      const respond = vi.fn().mockResolvedValue(undefined);
      const adapter = { id: "discord", type: "discord" } as any;

      await (fm as any).handleClassicStartSlash({
        command: "start",
        channelId: "channel-1",
        channelName: "test-room",
        guildId: "guild-1",
        userId: "owner",
        options: { backend: "opencode" },
        respond,
      }, "discord", adapter);

      expect(respond.mock.calls[0][0]).toContain("opencode");
      expect(respond.mock.calls[0][0]).toContain("curl -fsSL https://opencode.ai/install | bash");
      expect(respond).toHaveBeenCalledTimes(2);
      expect(respond.mock.calls.at(-1)?.[0]).toContain("opencode");
      expect(start).toHaveBeenCalledWith(expect.any(String), "opencode", undefined, undefined);
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("persists a directly selected ClassicBot backend before starting", async () => {
    const fm = new FleetManager(tmpDir);
    const classicChannels = new ClassicChannelManager(tmpDir, fm.logger);
    classicChannels.setPrimaryAdapterId("telegram");
    fm.classicChannels = classicChannels;
    const start = vi.spyOn(fm as any, "startClassicInstance").mockResolvedValue(undefined);

    await fm.handleClassicStart("12345", "test-room", "user-1", undefined, "telegram", "grok");

    expect(classicChannels.get("12345", "telegram")?.backend).toBe("grok");
    expect(start).toHaveBeenCalledWith(expect.any(String), "grok", undefined, undefined);
    expect(readFileSync(join(tmpDir, "classicBot.yaml"), "utf8")).toContain("backend: grok");
  });

  it("accepts a pending backend choice only from the user who issued /start", async () => {
    const fm = new FleetManager(tmpDir);
    const classicChannels = new ClassicChannelManager(tmpDir, fm.logger);
    classicChannels.setPrimaryAdapterId("telegram");
    fm.classicChannels = classicChannels;
    const start = vi.spyOn(fm as any, "startClassicInstance").mockResolvedValue(undefined);
    const promptUser = vi.fn().mockResolvedValue("menu-1");
    const editMessageRemoveButtons = vi.fn().mockResolvedValue(undefined);
    const adapter = { id: "telegram", type: "telegram", promptUser, editMessageRemoveButtons } as any;

    await (fm as any).beginClassicBackendSelection({
      command: "start",
      channelId: "12345",
      channelName: "test-room",
      userId: "owner",
      respond: vi.fn().mockResolvedValue(undefined),
    }, adapter);
    const codex = promptUser.mock.calls[0][2].find((choice: { id: string }) => choice.id.endsWith(":codex"));

    await (fm as any).handleClassicBackendSelection({
      callbackData: codex.id,
      chatId: "12345",
      messageId: "menu-1",
      userId: "someone-else",
    });
    expect(start).not.toHaveBeenCalled();

    await (fm as any).handleClassicBackendSelection({
      callbackData: codex.id,
      chatId: "12345",
      messageId: "menu-1",
      userId: "owner",
    });
    expect(classicChannels.get("12345", "telegram")?.backend).toBe("codex");
    expect(start).toHaveBeenCalledOnce();
    expect(editMessageRemoveButtons).toHaveBeenCalledWith("12345", "menu-1", expect.any(String));
  });

  it("falls back to the configured backend when the selection times out", async () => {
    vi.useFakeTimers();
    try {
      const fm = new FleetManager(tmpDir);
      fm.fleetConfig = { defaults: { backend: "kiro-cli" }, instances: {} };
      const classicChannels = new ClassicChannelManager(tmpDir, fm.logger);
      classicChannels.setPrimaryAdapterId("telegram");
      fm.classicChannels = classicChannels;
      const start = vi.spyOn(fm as any, "startClassicInstance").mockResolvedValue(undefined);
      const adapter = {
        id: "telegram",
        type: "telegram",
        promptUser: vi.fn().mockResolvedValue("menu-1"),
        editMessageRemoveButtons: vi.fn().mockResolvedValue(undefined),
      } as any;

      await (fm as any).beginClassicBackendSelection({
        command: "start",
        channelId: "12345",
        channelName: "test-room",
        userId: "owner",
        respond: vi.fn().mockResolvedValue(undefined),
      }, adapter);
      await vi.advanceTimersByTimeAsync(60_000);

      expect(start).toHaveBeenCalledWith(expect.any(String), "kiro-cli", undefined, undefined);
      expect(classicChannels.get("12345", "telegram")?.backend).toBeUndefined();
      expect(adapter.editMessageRemoveButtons).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("wakes a paused instance before IPC delivery", async () => {
    const fm = new FleetManager(tmpDir);
    const order: string[] = [];
    vi.spyOn(fm.lifecycle, "isPaused").mockReturnValue(true);
    vi.spyOn(fm.lifecycle, "wake").mockImplementation(async () => { order.push("wake"); });
    fm.instanceIpcClients.set("test", {
      connected: true,
      send: () => { order.push("send"); },
    } as any);

    await fm.deliverToInstance("test", { type: "fleet_inbound", content: "hello" });
    expect(order).toEqual(["wake", "send"]);
  });

  it("reports wake failure without delivering", async () => {
    const fm = new FleetManager(tmpDir);
    const send = vi.fn();
    vi.spyOn(fm.lifecycle, "isPaused").mockReturnValue(true);
    vi.spyOn(fm.lifecycle, "wake").mockRejectedValue(new Error("wake ready timeout"));
    fm.instanceIpcClients.set("test", { connected: true, send } as any);

    await expect(fm.deliverToInstance("test", { type: "fleet_inbound" })).rejects.toThrow("wake ready timeout");
    expect(send).not.toHaveBeenCalled();
  });

  it("builds routing table from config", () => {
    const fm = new FleetManager(tmpDir);
    const configPath = join(tmpDir, "fleet.yaml");
    writeFileSync(configPath, `
channel:
  type: telegram
  mode: topic
  bot_token_env: BOT
  group_id: -100
  access:
    mode: locked
    allowed_users: [1]
instances:
  proj-a:
    working_directory: /tmp/a
    topic_id: 42
  proj-b:
    working_directory: /tmp/b
    topic_id: 87
  proj-c:
    working_directory: /tmp/c
`);
    fm.loadConfig(configPath);
    const table = fm.buildRoutingTable();
    expect(table.get("42")).toEqual({ kind: "instance", name: "proj-a" });
    expect(table.get("87")).toEqual({ kind: "instance", name: "proj-b" });
    expect(table.size).toBe(2); // proj-c has no topic_id
  });

  it("marks the General topic as non-probeable in the routing table", () => {
    const fm = new FleetManager(tmpDir);
    const configPath = join(tmpDir, "fleet.yaml");
    writeFileSync(configPath, `
channel:
  type: telegram
  mode: topic
  bot_token_env: BOT
  group_id: -100
  access:
    mode: locked
    allowed_users: [1]
instances:
  general:
    working_directory: /tmp/general
    topic_id: 1
    general_topic: true
`);
    fm.loadConfig(configPath);
    const table = fm.buildRoutingTable();
    expect(table.get("1")).toEqual({ kind: "general", name: "general" });
  });

  it("createForumTopic delegates to adapter.createTopic", async () => {
    const fm = new FleetManager(tmpDir);

    // No adapter set — should throw
    await expect(fm.createForumTopic("my-topic")).rejects.toThrow("Adapter does not support topic creation");

    // Set a mock adapter with createTopic
    fm.adapter = {
      createTopic: async (name: string) => {
        expect(name).toBe("my-topic");
        return 999;
      },
    } as any;

    const threadId = await fm.createForumTopic("my-topic");
    expect(threadId).toBe(999);
  });

  it("does not default replies to thread 1 for the General instance", () => {
    const threadId = resolveReplyThreadId(undefined, {
      working_directory: "/tmp/general",
      topic_id: 1,
      general_topic: true,
      restart_policy: { max_retries: 1, backoff: "linear", reset_after: 1 },
      context_guardian: {
        threshold_percentage: 60,
        max_idle_wait_ms: 300_000,
        completion_timeout_ms: 60_000,
        grace_period_ms: 600_000,
        max_age_hours: 8,
      },
      memory: { auto_summarize: true, watch_memory_dir: true, backup_to_sqlite: true },
      log_level: "info",
    });
    expect(threadId).toBeUndefined();
  });

  it("defaults replies to the instance topic for normal instances", () => {
    const threadId = resolveReplyThreadId(undefined, {
      working_directory: "/tmp/proj",
      topic_id: 42,
      restart_policy: { max_retries: 1, backoff: "linear", reset_after: 1 },
      context_guardian: {
        threshold_percentage: 60,
        max_idle_wait_ms: 300_000,
        completion_timeout_ms: 60_000,
        grace_period_ms: 600_000,
        max_age_hours: 8,
      },
      memory: { auto_summarize: true, watch_memory_dir: true, backup_to_sqlite: true },
      log_level: "info",
    });
    expect(threadId).toBe("42");
  });

  it("resolves threadId from sender's topic_id when sender is a fleet instance", () => {
    // Simulates: senderSessionName = "kiro-dev-leader" exists in fleetConfig
    // Should use kiro-dev-leader's topic_id (99), not IPC owner's (42)
    const fleetInstances: Record<string, any> = {
      codex: { topic_id: 42, working_directory: "/tmp/codex" },
      "kiro-dev-leader": { topic_id: 99, working_directory: "/tmp/kiro" },
    };
    const senderSessionName = "kiro-dev-leader";
    const instanceName = "codex"; // IPC channel owner

    const senderInstanceName = senderSessionName && fleetInstances[senderSessionName]
      ? senderSessionName : null;
    const routingConfig = senderInstanceName
      ? fleetInstances[senderInstanceName]
      : (senderSessionName ? undefined : fleetInstances[instanceName]);
    const threadId = resolveReplyThreadId(undefined, routingConfig);

    expect(threadId).toBe("99");
  });

  it("falls back to general topic when sender is not in fleetConfig", () => {
    // Simulates: senderSessionName = "unknown-session" not in fleetConfig
    // Should return undefined (general topic), NOT IPC owner's topic_id
    const fleetInstances: Record<string, any> = {
      codex: { topic_id: 42, working_directory: "/tmp/codex" },
    };
    const senderSessionName = "unknown-session";
    const instanceName = "codex";

    const senderInstanceName = senderSessionName && fleetInstances[senderSessionName]
      ? senderSessionName : null;
    const routingConfig = senderInstanceName
      ? fleetInstances[senderInstanceName]
      : (senderSessionName ? undefined : fleetInstances[instanceName]);
    const threadId = resolveReplyThreadId(undefined, routingConfig);

    expect(threadId).toBeUndefined();
  });

  it("uses IPC owner's topic_id when no senderSessionName", () => {
    // Simulates: no external session, normal instance outbound
    const fleetInstances: Record<string, any> = {
      codex: { topic_id: 42, working_directory: "/tmp/codex" },
    };
    const senderSessionName = undefined;
    const instanceName = "codex";

    const senderInstanceName = senderSessionName && fleetInstances[senderSessionName as string]
      ? senderSessionName : null;
    const routingConfig = senderInstanceName
      ? fleetInstances[senderInstanceName]
      : (senderSessionName ? undefined : fleetInstances[instanceName]);
    const threadId = resolveReplyThreadId(undefined, routingConfig);

    expect(threadId).toBe("42");
  });

  it("saveFleetConfig preserves all optional user-configured fields", () => {
    const fm = new FleetManager(tmpDir);
    const configPath = join(tmpDir, "fleet.yaml");
    writeFileSync(configPath, `
channel:
  type: telegram
  mode: topic
  bot_token_env: BOT
  group_id: -100
  access:
    mode: locked
    allowed_users: [1]
instances:
  my-proj:
    working_directory: /tmp/my-proj
    topic_id: 10
    description: "A test instance"
    tags: [code-reviewer, researcher]
    model: claude-opus-4-6
    model_failover: [sonnet]
    worktree_source: /tmp/source-repo
    backend: claude-code
    skipPermissions: true
    lightweight: true
    memory_directory: /tmp/memory
`);
    fm.loadConfig(configPath);
    fm.saveFleetConfig();

    const saved = yaml.load(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    const inst = (saved.instances as Record<string, unknown>)["my-proj"] as Record<string, unknown>;

    expect(inst.description).toBe("A test instance");
    expect(inst.tags).toEqual(["code-reviewer", "researcher"]);
    expect(inst.model).toBe("claude-opus-4-6");
    expect(inst.model_failover).toEqual(["sonnet"]);
    expect(inst.worktree_source).toBe("/tmp/source-repo");
    expect(inst.backend).toBe("claude-code");
    expect(inst.skipPermissions).toBe(true);
    expect(inst.lightweight).toBe(true);
    expect(inst.memory_directory).toBe("/tmp/memory");
    // Core fields still present
    expect(inst.working_directory).toBe("/tmp/my-proj");
    expect(inst.topic_id).toBe(10);
  });

  it("losslessly patches a changed setting and preserves comments and unknown fields", () => {
    const fm = new FleetManager(tmpDir);
    const configPath = join(tmpDir, "fleet.yaml");
    writeFileSync(configPath, `# fleet header
defaults:
  model: fallback-model
instances:
  my-proj:
    working_directory: /tmp/my-proj
    model: old-model # model comment
    auto_pause_after: 10 # keep this override
    future_option: enabled
`);

    fm.loadConfig(configPath);
    fm.fleetConfig!.instances["my-proj"].model = "new-model";
    fm.saveFleetConfig();

    const text = readFileSync(configPath, "utf8");
    expect(text).toContain("# fleet header");
    expect(text).toContain("# keep this override");
    expect(text).toContain("# model comment");
    const saved = yaml.load(text) as any;
    expect(saved.instances["my-proj"].auto_pause_after).toBe(10);
    expect(saved.instances["my-proj"].future_option).toBe("enabled");
    expect(saved.instances["my-proj"].model).toBe("new-model");

    const reloaded = new FleetManager(tmpDir);
    reloaded.loadConfig(configPath);
    expect(reloaded.fleetConfig!.instances["my-proj"].auto_pause_after).toBe(10);
    expect(reloaded.fleetConfig!.instances["my-proj"].model).toBe("new-model");
  });

  it("persists explicit instance overrides even when they equal inherited defaults", () => {
    const fm = new FleetManager(tmpDir);
    const configPath = join(tmpDir, "fleet.yaml");
    writeFileSync(configPath, `defaults:
  auto_pause_after: 30
  hang_detector:
    enabled: true
    timeout_minutes: 15
  tool_set: full
  log_level: info
instances:
  worker:
    working_directory: /tmp/worker
`);
    fm.loadConfig(configPath);

    fm.saveFleetConfig([
      { path: ["instances", "worker", "auto_pause_after"], value: 30 },
      { path: ["instances", "worker", "hang_detector", "timeout_minutes"], value: 15 },
      { path: ["instances", "worker", "tool_set"], value: "full" },
      { path: ["instances", "worker", "log_level"], value: "info" },
    ]);

    const saved = yaml.load(readFileSync(configPath, "utf8")) as any;
    expect(saved.instances.worker.auto_pause_after).toBe(30);
    expect(saved.instances.worker.hang_detector.timeout_minutes).toBe(15);
    expect(saved.instances.worker.tool_set).toBe("full");
    expect(saved.instances.worker.log_level).toBe("info");

    const reloaded = new FleetManager(tmpDir);
    reloaded.loadConfig(configPath);
    expect(reloaded.fleetConfig!.instances.worker.auto_pause_after).toBe(30);
    expect(reloaded.fleetConfig!.instances.worker.hang_detector.timeout_minutes).toBe(15);
    expect(reloaded.fleetConfig!.instances.worker.tool_set).toBe("full");
    expect(reloaded.fleetConfig!.instances.worker.log_level).toBe("info");
  });

  it("keeps a legacy channel in its original shape when patching access", () => {
    const fm = new FleetManager(tmpDir);
    const configPath = join(tmpDir, "fleet.yaml");
    writeFileSync(configPath, `channel:
  type: telegram
  mode: topic
  bot_token_env: BOT
  custom_adapter_option: keep-me
  access:
    mode: locked
    allowed_users: [1]
instances: {}
`);
    fm.loadConfig(configPath);
    fm.fleetConfig!.channel!.access.allowed_users.push(2);
    fm.saveFleetConfig();

    const saved = yaml.load(readFileSync(configPath, "utf8")) as any;
    expect(saved.channels).toBeUndefined();
    expect(saved.channel.access.allowed_users).toEqual([1, 2]);
    expect(saved.channel.custom_adapter_option).toBe("keep-me");
  });
});

describe("TopicCommands", () => {
  it("handleGeneralCommand returns false for non-commands", async () => {
    const adapter = { sendText: vi.fn() };
    const tc = new TopicCommands({ adapter } as any);
    const result = await tc.handleGeneralCommand({ text: "hello", chatId: "1", messageId: "1", username: "u", userId: "1", timestamp: new Date() } as any);
    expect(result).toBe(false);
  });

  it("ignores topic deletion for the General instance", async () => {
    const logger = { debug: vi.fn(), info: vi.fn() };
    const removeInstance = vi.fn();
    const tc = new TopicCommands({
      logger,
      removeInstance,
      routingTable: new Map([["1", { kind: "general", name: "general" }]]),
      fleetConfig: {
        defaults: {},
        instances: {
          general: {
            working_directory: "/tmp/general",
            topic_id: 1,
            general_topic: true,
            restart_policy: { max_retries: 1, backoff: "linear", reset_after: 1 },
            context_guardian: {
              threshold_percentage: 60,
              max_idle_wait_ms: 300_000,
              completion_timeout_ms: 60_000,
              grace_period_ms: 600_000,
              max_age_hours: 8,
            },
            memory: { auto_summarize: true, watch_memory_dir: true, backup_to_sqlite: true },
            log_level: "info",
          },
        },
      },
    } as any);

    await tc.handleTopicDeleted("1");

    expect(removeInstance).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalled();
  });
});
