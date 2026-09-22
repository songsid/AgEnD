import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FleetManager } from "../src/fleet-manager.js";

const dirs: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeAdapter(id = "primary", type = "discord") {
  const adapter = new EventEmitter() as any;
  adapter.id = id;
  adapter.type = type;
  adapter.topology = type === "discord" ? "channels" : "topics";
  adapter.stop = vi.fn(async () => {});
  adapter.start = vi.fn(async () => {});
  adapter.setChatId = vi.fn();
  adapter.verifyBinding = vi.fn(async (groupId: string, channelId?: string) => ({
    group_id: groupId,
    group_name: "Target guild",
    channel_id: channelId ?? null,
    channel_name: channelId ? "general" : null,
    can_view: true,
    can_send: true,
  }));
  return adapter;
}

function manager() {
  const dir = mkdtempSync(join(tmpdir(), "agend-fleet-binding-")); dirs.push(dir);
  const fm = new FleetManager(dir) as any;
  fm.configPath = join(dir, "fleet.yaml");
  writeFileSync(fm.configPath, "channels:\n  - id: primary\n    type: discord\n    mode: topic\n    bot_token_env: DISCORD_BOT_TOKEN\n    group_id: '111111111111111111'\n    options:\n      general_channel_id: '222222222222222222'\n    access:\n      mode: locked\n      allowed_users: ['admin']\ninstances:\n  agent:\n    backend: claude-code\n    working_directory: /tmp\n    channel_id: primary\n    topic_id: '333333333333333333'\ndefaults: {}\n");
  fm.fleetConfig = {
    channels: [{ id: "primary", type: "discord", mode: "topic", bot_token_env: "DISCORD_BOT_TOKEN", group_id: "111111111111111111", options: { general_channel_id: "222222222222222222" }, access: { mode: "locked", allowed_users: ["admin"] } }],
    instances: { agent: { backend: "claude-code", working_directory: "/tmp", channel_id: "primary", topic_id: "333333333333333333" } }, defaults: {},
  };
  fm.rawFleetConfig = structuredClone(fm.fleetConfig);
  fm.savedFleetConfigSnapshot = structuredClone(fm.fleetConfig);
  const old = makeAdapter();
  fm.adapters.set("primary", old); fm.adapter = old;
  fm.adapterState.set("primary", { status: "connected", retryCount: 0 });
  return { fm, old, dir };
}

async function verify(fm: any, key = "binding_key") {
  return fm.verifyConnectionBinding({
    connectionId: "primary",
    binding: { group_id: "999999999999999999", general_channel_id: "888888888888888888" },
    sessionBinding: "session", idempotencyKey: key,
  });
}

describe("connection binding rebind", () => {
  it("requires a positive provider verification challenge", async () => {
    const { fm } = manager();
    const result = fm.startConnectionBindingApply({ connectionId: "primary", verificationId: "missing", sessionBinding: "session", idempotencyKey: "binding_key" });
    expect(result).toEqual({ error: expect.stringContaining("expired") });
  });

  it("keeps the old binding and unrelated config while the replacement is not ready", async () => {
    const { fm, old } = manager();
    const checked = await verify(fm);
    expect(checked.ok).toBe(true);
    let resolveStart!: () => void;
    fm.startSingleAdapter = vi.fn(async (_fleet: unknown, candidate: any, onStarted?: () => void) => {
      const fresh = makeAdapter();
      fm.adapters.set("primary", fresh); fm.adapter = fresh;
      await new Promise<void>(resolve => { resolveStart = resolve; });
      onStarted?.();
      void candidate;
    });
    const result = fm.startConnectionBindingApply({ connectionId: "primary", verificationId: checked.verification_id, sessionBinding: "session", idempotencyKey: "binding_key" });
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(fm.fleetConfig.channels[0].group_id).toBe("111111111111111111");
    expect(fm.fleetConfig.channels[0].access.allowed_users).toEqual(["admin"]);
    resolveStart();
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(result.job.status).toBe("done");
    expect(fm.fleetConfig.channels[0].group_id).toBe("999999999999999999");
    expect(typeof fm.fleetConfig.channels[0].group_id).toBe("string");
    expect(fm.fleetConfig.channels[0].access.allowed_users).toEqual(["admin"]);
    expect(fm.fleetConfig.instances.agent.topic_id).toBe("333333333333333333");
    expect(old.stop).toHaveBeenCalled();
  });

  it("does not commit a failed replacement or mutate topics/allowlist", async () => {
    const { fm } = manager();
    const checked = await verify(fm, "binding_fail");
    let starts = 0;
    fm.startSingleAdapter = vi.fn(async (_fleet: unknown, _candidate: unknown, onStarted?: () => void) => {
      starts++;
      if (starts === 1) throw new Error("target unavailable");
      const restored = makeAdapter();
      fm.adapters.set("primary", restored); fm.adapter = restored;
      onStarted?.();
    });
    const result = fm.startConnectionBindingApply({ connectionId: "primary", verificationId: checked.verification_id, sessionBinding: "session", idempotencyKey: "binding_fail" });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(result.job.result).toBe("rolled_back");
    expect(fm.fleetConfig.channels[0].group_id).toBe("111111111111111111");
    expect(fm.fleetConfig.channels[0].options.general_channel_id).toBe("222222222222222222");
    expect(fm.fleetConfig.channels[0].access.allowed_users).toEqual(["admin"]);
    expect(fm.fleetConfig.instances.agent.topic_id).toBe("333333333333333333");
    expect(readFileSync(join(fm.configPath), "utf8")).toContain("111111111111111111");
  });

  it("rejects a challenge when the adapter generation changes after verify", async () => {
    const { fm } = manager();
    const checked = await verify(fm, "binding_generation");
    fm.connectionSecretGenerations.set("primary", 7);
    const result = fm.startConnectionBindingApply({ connectionId: "primary", verificationId: checked.verification_id, sessionBinding: "session", idempotencyKey: "binding_generation" });
    expect(result).toEqual({ error: expect.stringContaining("does not match") });
  });
});
