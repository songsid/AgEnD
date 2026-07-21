import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { FleetManager, resolveReplyThreadId } from "../src/fleet-manager.js";
import { TopicCommands } from "../src/topic-commands.js";
import { join, basename } from "node:path";
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import yaml from "js-yaml";

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
