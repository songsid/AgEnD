import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FleetManager } from "../src/fleet-manager.js";
import { authorizeExplicitInstanceRemoval } from "../src/instance-removal.js";
import type { TopicPresence } from "../src/channel/types.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

function fakeAdapter(
  id: string,
  probe: (topicId: string) => Promise<TopicPresence>,
  health: { status: "connected" | "retrying" | "stopped"; isReady: boolean; generation: number } = {
    status: "connected",
    isReady: true,
    generation: 1,
  },
) {
  const adapter = new EventEmitter() as EventEmitter & Record<string, unknown>;
  Object.assign(adapter, {
    id,
    type: "discord",
    probeTopicPresence: vi.fn(probe),
    getHealthSnapshot: () => ({ ...health, reconnectCount: 0 }),
  });
  return { adapter: adapter as any, health };
}

describe("topic cleanup data-loss firewall", () => {
  let dataDir: string;
  let workDir: string;
  let fleetPath: string;

  beforeEach(() => {
    dataDir = join(tmpdir(), `agend-topic-cleanup-${process.pid}-${Date.now()}-${Math.random()}`);
    workDir = join(dataDir, "repo", "worker");
    mkdirSync(workDir, { recursive: true });
    writeFileSync(join(workDir, "untracked.txt"), "must survive\n");
    fleetPath = join(dataDir, "fleet.yaml");
    writeFileSync(fleetPath, "sentinel fleet config must survive\n");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dataDir, { recursive: true, force: true });
  });

  function fleet(instances: Record<string, Record<string, unknown>> = {
    worker: { working_directory: workDir, topic_id: "topic-1", channel_id: "owner" },
  }) {
    const fm = new FleetManager(dataDir);
    fm.fleetConfig = {
      channels: [{ id: "owner", type: "discord", mode: "topic", bot_token_env: "BOT", group_id: "guild" }],
      defaults: {},
      instances,
    } as any;
    for (const [name, config] of Object.entries(instances)) {
      if (config.topic_id != null) fm.routing.register(String(config.topic_id), { kind: "instance", name });
    }
    (fm as any).notifyFleetError = vi.fn();
    return fm;
  }

  function install(fm: FleetManager, adapter: any) {
    (fm.adapters as Map<string, any>).set("owner", adapter);
  }

  it("keeps config, route, and real files when the owning adapter is offline", async () => {
    const fm = fleet();
    const { adapter } = fakeAdapter("owner", async () => ({ status: "missing", evidence: "should-not-run" }), {
      status: "retrying", isReady: false, generation: 4,
    });
    install(fm, adapter);
    const remove = vi.spyOn(fm.lifecycle, "remove");

    await (fm as any).runTopicCleanup(0);
    await (fm as any).runTopicCleanup(0);

    expect(adapter.probeTopicPresence).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(fm.routing.resolve("topic-1")).toEqual({ kind: "instance", name: "worker" });
    expect(fm.fleetConfig!.instances.worker).toBeDefined();
    expect((fm as any).notifyFleetError).toHaveBeenCalledTimes(1);
    expect(readFileSync(fleetPath, "utf8")).toBe("sentinel fleet config must survive\n");
    expect(readFileSync(join(workDir, "untracked.txt"), "utf8")).toBe("must survive\n");
  });

  it.each([
    { status: "unknown", reason: "empty-channel-view" } as const,
    { status: "unknown", reason: "provider-probe-failed" } as const,
  ])("treats $reason as unknown and changes no durable state", async result => {
    const fm = fleet();
    const { adapter } = fakeAdapter("owner", async () => result);
    install(fm, adapter);
    const before = JSON.stringify(fm.fleetConfig);
    const remove = vi.spyOn(fm.lifecycle, "remove");

    await (fm as any).runTopicCleanup(0);

    expect(remove).not.toHaveBeenCalled();
    expect(JSON.stringify(fm.fleetConfig)).toBe(before);
    expect(fm.routing.resolve("topic-1")).toBeDefined();
    expect((fm as any).notifyFleetError).toHaveBeenCalledTimes(1);
    expect(existsSync(join(workDir, "untracked.txt"))).toBe(true);
  });

  it("uses the route owner's adapter instead of the primary adapter", async () => {
    const fm = fleet({
      worker: { working_directory: workDir, topic_id: "topic-1", channel_id: "secondary" },
    });
    fm.fleetConfig!.channels!.push({ id: "secondary", type: "discord", mode: "topic", bot_token_env: "BOT2", group_id: "guild-2" } as any);
    const primary = fakeAdapter("owner", async () => ({ status: "missing", evidence: "wrong-owner" }));
    const secondary = fakeAdapter("secondary", async () => ({ status: "present", generation: 1 }));
    install(fm, primary.adapter);
    (fm.adapters as Map<string, any>).set("secondary", secondary.adapter);

    await (fm as any).runTopicCleanup(0);

    expect(primary.adapter.probeTopicPresence).not.toHaveBeenCalled();
    expect(secondary.adapter.probeTopicPresence).toHaveBeenCalledWith("topic-1");
    expect(fm.routing.resolve("topic-1")).toBeDefined();
  });

  it("quarantines one confirmed missing route without deleting any user data", async () => {
    const sourceDir = join(dataDir, "source");
    rmSync(workDir, { recursive: true, force: true });
    mkdirSync(sourceDir, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: sourceDir });
    execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: sourceDir });
    execFileSync("git", ["config", "user.name", "AgEnD Test"], { cwd: sourceDir });
    writeFileSync(join(sourceDir, "tracked.txt"), "tracked\n");
    execFileSync("git", ["add", "tracked.txt"], { cwd: sourceDir });
    execFileSync("git", ["commit", "-qm", "fixture"], { cwd: sourceDir });
    execFileSync("git", ["worktree", "add", "-q", "-b", "worker-branch", workDir], { cwd: sourceDir });
    writeFileSync(join(workDir, "untracked.txt"), "must survive\n");
    const fm = fleet({
      worker: {
        working_directory: workDir,
        worktree_source: sourceDir,
        topic_id: "topic-1",
        channel_id: "owner",
      },
    });
    const { adapter } = fakeAdapter("owner", async () => ({
      status: "missing", generation: 1, evidence: "discord-unknown-channel",
    }));
    install(fm, adapter);
    const remove = vi.spyOn(fm.lifecycle, "remove");
    const before = JSON.stringify(fm.fleetConfig);

    await (fm as any).runTopicCleanup(0);

    expect(fm.routing.resolve("topic-1")).toBeUndefined();
    expect(remove).not.toHaveBeenCalled();
    expect(JSON.stringify(fm.fleetConfig)).toBe(before);
    expect(readFileSync(fleetPath, "utf8")).toBe("sentinel fleet config must survive\n");
    expect(readFileSync(join(workDir, "untracked.txt"), "utf8")).toBe("must survive\n");
    expect(execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: sourceDir, encoding: "utf8" }))
      .toContain(`worktree ${workDir}`);
  });

  it("treats multiple missing topics in one pass as an outage and quarantines none", async () => {
    const secondDir = join(dataDir, "repo", "worker-2");
    mkdirSync(secondDir, { recursive: true });
    writeFileSync(join(secondDir, "untracked.txt"), "second survives\n");
    const fm = fleet({
      worker: { working_directory: workDir, topic_id: "topic-1", channel_id: "owner" },
      "worker-2": { working_directory: secondDir, topic_id: "topic-2", channel_id: "owner" },
    });
    const { adapter } = fakeAdapter("owner", async () => ({
      status: "missing", generation: 1, evidence: "discord-unknown-channel",
    }));
    install(fm, adapter);

    await (fm as any).runTopicCleanup(0);

    expect(fm.routing.resolve("topic-1")).toBeDefined();
    expect(fm.routing.resolve("topic-2")).toBeDefined();
    expect((fm as any).notifyFleetError).toHaveBeenCalledTimes(1);
    expect(readFileSync(join(workDir, "untracked.txt"), "utf8")).toBe("must survive\n");
    expect(readFileSync(join(secondDir, "untracked.txt"), "utf8")).toBe("second survives\n");
  });

  it("rejects stale missing evidence when the adapter generation changes", async () => {
    const fm = fleet();
    const gate = deferred<TopicPresence>();
    const created = fakeAdapter("owner", () => gate.promise);
    install(fm, created.adapter);
    const scan = (fm as any).runTopicCleanup(0);
    await vi.waitFor(() => expect(created.adapter.probeTopicPresence).toHaveBeenCalled());
    created.health.generation = 2;
    gate.resolve({ status: "missing", generation: 1, evidence: "discord-unknown-channel" });
    await scan;

    expect(fm.routing.resolve("topic-1")).toBeDefined();
  });

  it("coalesces overlapping scans and iterates a fixed route snapshot", async () => {
    const fm = fleet();
    const gate = deferred<TopicPresence>();
    const { adapter } = fakeAdapter("owner", () => gate.promise);
    install(fm, adapter);

    const first = (fm as any).scheduleTopicCleanup(0);
    const second = (fm as any).scheduleTopicCleanup(0);
    fm.fleetConfig!.instances.late = { working_directory: workDir, topic_id: "topic-late", channel_id: "owner" } as any;
    fm.routing.register("topic-late", { kind: "instance", name: "late" });
    gate.resolve({ status: "present", generation: 1 });
    await Promise.all([first, second]);

    expect(adapter.probeTopicPresence).toHaveBeenCalledTimes(1);
    expect(adapter.probeTopicPresence).toHaveBeenCalledWith("topic-1");
  });

  it("ignores a channelDelete event while reconnecting and never probes or deletes", async () => {
    const fm = fleet();
    const { adapter } = fakeAdapter("owner", async () => ({
      status: "missing", generation: 8, evidence: "discord-unknown-channel",
    }), { status: "retrying", isReady: false, generation: 8 });
    install(fm, adapter);
    const remove = vi.spyOn(fm.lifecycle, "remove");
    (fm as any).bindTopicClosedHandler(adapter, "owner", "test.topic_closed");

    adapter.emit("topic_closed", { chatId: "guild", threadId: "topic-1" });
    await Promise.resolve();

    expect(adapter.probeTopicPresence).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(fm.routing.resolve("topic-1")).toBeDefined();
    expect(readFileSync(join(workDir, "untracked.txt"), "utf8")).toBe("must survive\n");
  });

  it("requires REST-confirmed missing evidence for channelDelete and only quarantines", async () => {
    const fm = fleet();
    const result = { status: "present", generation: 1 } as TopicPresence;
    const { adapter } = fakeAdapter("owner", async () => result);
    install(fm, adapter);
    const remove = vi.spyOn(fm.lifecycle, "remove");
    (fm as any).bindTopicClosedHandler(adapter, "owner", "test.topic_closed");

    adapter.emit("topic_closed", { chatId: "guild", threadId: "topic-1" });
    await vi.waitFor(() => expect(adapter.probeTopicPresence).toHaveBeenCalledTimes(1));
    expect(fm.routing.resolve("topic-1")).toBeDefined();

    adapter.probeTopicPresence.mockResolvedValue({
      status: "missing", generation: 1, evidence: "discord-unknown-channel",
    });
    adapter.emit("topic_closed", { chatId: "guild", threadId: "topic-1" });
    await vi.waitFor(() => expect(fm.routing.resolve("topic-1")).toBeUndefined());

    expect(fm.routing.resolve("topic-1")).toBeUndefined();
    expect(remove).not.toHaveBeenCalled();
    expect(fm.fleetConfig!.instances.worker).toBeDefined();
    expect(readFileSync(fleetPath, "utf8")).toBe("sentinel fleet config must survive\n");
    expect(existsSync(join(workDir, "untracked.txt"))).toBe(true);
  });

  it("rejects destructive removal without an explicit capability and accepts authorized teardown", async () => {
    const fm = fleet();
    await expect(fm.lifecycle.remove("worker", undefined as any)).rejects.toThrow(/explicit authorization/);
    const remove = vi.spyOn(fm.lifecycle, "remove").mockResolvedValue();

    await expect(fm.removeInstance("worker", undefined as any)).rejects.toThrow(/explicit authorization/);
    expect(remove).not.toHaveBeenCalled();

    await fm.removeInstance("worker", authorizeExplicitInstanceRemoval("dashboard-confirmed"));
    expect(remove).toHaveBeenCalledWith("worker", expect.objectContaining({ source: "dashboard-confirmed" }));
  });
});
