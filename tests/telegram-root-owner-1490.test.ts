import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";

const spawned = vi.hoisted(() => [] as Array<{ command: string; args: string[]; options: any }>);
vi.mock("node:child_process", async original => ({
  ...await original<typeof import("node:child_process")>(),
  spawn: vi.fn((command: string, args: string[], options: unknown) => {
    spawned.push({ command, args, options });
    return Object.assign(new EventEmitter(), { unref: vi.fn() });
  }),
}));
vi.mock("../src/update-dispatch.js", async original => ({
  ...await original<typeof import("../src/update-dispatch.js")>(),
  resolveInstalledAgend: vi.fn(async () => ({ ok: true, agend: "/fixture/agend", version: "2.2.0" })),
}));
// A proven non-service fixture. Keep the real planner, without host proc/CLI probes.
vi.mock("../src/update-launch.js", async original => {
  const real = await original<typeof import("../src/update-launch.js")>();
  return { ...real, resolveUpdateLaunch: (path: string) => real.resolveUpdateLaunch(path,
    { ...real.defaultUpdateLaunchDeps, platform: "linux", cgroup: async () => "0::/\n" }) };
});
import { FleetManager } from "../src/fleet-manager.js";
import { AccessManager } from "../src/channel/access-manager.js";
import { t } from "../src/locale.js";

const GROUP = "-100149014", A = "tg-a", B = "tg-b", ADMIN_A = "111", ADMIN_B = "222";
const dirs: string[] = [], managers: FleetManager[] = [];
afterEach(() => {
  vi.restoreAllMocks(); spawned.length = 0;
  for (const fm of managers.splice(0)) { fm.stormWindow.shutdown(); fm.spawnGate.shutdown(); }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function rig(twoGenerals: boolean) {
  const dir = mkdtempSync(join(tmpdir(), "agend-root-owner-")); dirs.push(dir);
  const fm = new FleetManager(dir); managers.push(fm);
  const any = fm as any;
  const replies: Array<{ adapter: string; text: string }> = [];
  const adapter = (id: string) => ({ id, type: "telegram",
    sendText: vi.fn(async (_chat: string, text: string) => {
      replies.push({ adapter: id, text }); return { messageId: "notice", chatId: GROUP };
    }), editMessage: vi.fn().mockResolvedValue(undefined), react: vi.fn().mockResolvedValue(undefined),
  });
  const a = adapter(A), b = adapter(B);
  const channels = [a, b].map((adapter, i) => ({ id: adapter.id, type: "telegram", mode: "topic", group_id: GROUP,
    access: { mode: "open", allowed_users: [i === 0 ? ADMIN_A : ADMIN_B] } }));
  fm.fleetConfig = { defaults: { backend: "codex" }, channels, instances: {
    general_a: { working_directory: dir, channel_id: A, general_topic: true, topic_id: 1 },
    ...(twoGenerals ? { general_b: { working_directory: dir, channel_id: B, general_topic: true, topic_id: 2 } } : {}),
  } } as any;
  fm.adapter = a as any;
  for (const [index, bot] of [a, b].entries()) {
    fm.adapters.set(bot.id, bot as any);
    fm.worlds.set(bot.id, { id: bot.id, adapter: bot, channelConfig: channels[index], groupId: GROUP,
      botUsername: bot.id === A ? "AlphaBot" : "BetaBot",
      accessManager: new AccessManager(channels[index]!.access as any, join(dir, bot.id + ".json")),
    } as any);
  }
  for (const name of Object.keys(fm.fleetConfig!.instances)) any.daemons.set(name, {});
  fm.routing.rebuild(fm.fleetConfig!);
  const restart = vi.spyOn(fm, "requestFullRestart").mockResolvedValue(true);
  vi.spyOn(fm, "beginUpdateProgress").mockImplementation(() => {});
  vi.spyOn(any, "deliverToInstance").mockResolvedValue(undefined);
  vi.spyOn(any, "reactMessageStatus").mockImplementation(() => {});
  vi.spyOn(any, "warnIfRateLimited").mockImplementation(() => {});
  async function copy(id: string, text: string, userId: string, messageId: string | undefined = "shared",
    location: { chatId?: string; threadId?: string } = {}) {
    await any.handleInboundMessage({ source: "telegram", adapterId: id, chatId: location.chatId ?? GROUP, threadId: location.threadId,
      messageId, userId, username: "Admin", text, isBotMessage: false, timestamp: new Date() });
  }
  return { fm, any, a, b, channels, replies, restart, copy };
}

async function trace(twoGenerals: boolean, order: string[], command: string, userId: string) {
  const r = rig(twoGenerals), start = spawned.length;
  for (const adapter of order) await r.copy(adapter, command, userId);
  return { restarts: r.restart.mock.calls.map(args => args[0].id), updates: spawned.slice(start).map(call => call.options.env.AGEND_RESTART_ORIGIN),
    replies: r.replies };
}

describe("#1490 row14: forum-root authority must not depend on the dedup race", () => {
  for (const command of ["/restart full", "/update"]) {
    it(`two Generals: sibling-admin authority is arrival-independent for ${command}`, async () => {
      const ownerFirst = await trace(true, [A, B], command, ADMIN_B);
      const siblingFirst = await trace(true, [B, A], command, ADMIN_B);
      expect(siblingFirst).toEqual(ownerFirst);
      expect(ownerFirst.restarts).toEqual([]);
      expect(ownerFirst.updates).toEqual([]);
      expect(ownerFirst.replies).toEqual([{ adapter: A, text: t("not_authorized") }]);
    });
    it(`one General: a sibling cannot silently consume ${command}`, async () => {
      const result = await trace(false, [B, A], command, ADMIN_A);
      if (command === "/update") expect(result.updates).toHaveLength(1);
      else expect(result.restarts).toEqual([A]);
    });
    it(`an explicitly addressed owner retains its own admin: ${command}`, async () => {
      const addressed = command.replace(/^(\/\w+)/, "$1@BetaBot");
      const result = await trace(true, [A, B], addressed, ADMIN_B);
      if (command === "/update") expect(result.updates).toEqual([`command /update by ${B}:${ADMIN_B}`]);
      else expect(result.restarts).toEqual([B]);
    });
  }
  it("a suffix cannot borrow the other bot's administrator", async () => {
    const r = rig(true);
    await r.copy(B, "/restart@AlphaBot full", ADMIN_B);
    await r.copy(A, "/restart@AlphaBot full", ADMIN_B);
    expect(r.restart).not.toHaveBeenCalled();
    expect(r.replies).toEqual([{ adapter: A, text: t("not_authorized") }]);
  });
  it.each([[A, B], [B, A]])("bare primary authority runs exactly once, arrival %s then %s", async (first, second) => {
    const r = rig(true);
    await r.copy(first, "/restart full", ADMIN_A);
    await r.copy(second, "/restart full", ADMIN_A);
    expect(r.restart.mock.calls.map(args => args[0].id)).toEqual([A]);
    expect(r.any.recentMessageIds.size).toBe(1);
  });
  it("instance order and runtime Map order do not replace the configured primary", async () => {
    const r = rig(true), instances = r.fm.fleetConfig!.instances;
    r.fm.fleetConfig!.instances = { general_b: instances.general_b!, general_a: instances.general_a! };
    const reversedDaemons = [...r.any.daemons].reverse();
    r.any.daemons.clear();
    for (const [name, daemon] of reversedDaemons) r.any.daemons.set(name, daemon);
    const reversedWorlds = [...r.fm.worlds].reverse();
    r.fm.worlds.clear();
    for (const [id, world] of reversedWorlds) r.fm.worlds.set(id, world);
    await r.copy(B, "/restart full", ADMIN_B);
    expect(r.any.recentMessageIds.size).toBe(0);
    await r.copy(A, "/restart full", ADMIN_B);
    expect(r.restart).not.toHaveBeenCalled();
    expect(r.replies).toEqual([{ adapter: A, text: t("not_authorized") }]);
  });
  it("without a primary General in this group, config order chooses the same-group General", async () => {
    const r = rig(true), instances = r.fm.fleetConfig!.instances;
    r.fm.fleetConfig!.channels!.unshift({ id: "elsewhere", type: "telegram", group_id: "-100999" } as any);
    r.fm.fleetConfig!.instances = { general_b: instances.general_b!, general_a: instances.general_a! };
    await r.copy(A, "/restart full", ADMIN_B);
    expect(r.any.recentMessageIds.size).toBe(0);
    await r.copy(B, "/restart full", ADMIN_B);
    expect(r.restart.mock.calls.map(args => args[0].id)).toEqual([B]);
  });
  it.each([false, true])("a stopped configured owner never fails over to a sibling (explicit=%s)", async explicit => {
    const r = rig(true);
    r.any.daemons.delete("general_a");
    const command = explicit ? "/restart@AlphaBot full" : "/restart full";
    await r.copy(B, command, ADMIN_B);
    await r.copy(A, command, ADMIN_A);
    expect(r.restart).not.toHaveBeenCalled();
    expect(r.replies).toEqual([]);
    expect(r.any.recentMessageIds.size).toBe(0);
  });
  it("an unresolved configured General is held rather than skipped in favor of a sibling", async () => {
    const r = rig(true);
    r.fm.fleetConfig!.instances.general_a!.channel_id = "unknown";
    await r.copy(B, "/restart full", ADMIN_B);
    await r.copy(A, "/restart full", ADMIN_A);
    expect(r.restart).not.toHaveBeenCalled();
    expect(r.any.recentMessageIds.size).toBe(0);
  });
  it("a stopped primary does not prevent explicitly addressing a live sibling", async () => {
    const r = rig(true);
    r.any.daemons.delete("general_a");
    await r.copy(B, "/restart@BetaBot full", ADMIN_B);
    expect(r.restart.mock.calls.map(args => args[0].id)).toEqual([B]);
  });
  it("no message ID does not admit a non-owner bare copy", async () => {
    const r = rig(true);
    // Undefined passed through the explicit inbound boundary, not a new dedup key.
    await r.any.handleInboundMessage({ source: "telegram", adapterId: B, chatId: GROUP,
      text: "/restart full", userId: ADMIN_B, timestamp: new Date(), isBotMessage: false });
    expect(r.restart).not.toHaveBeenCalled();
    expect(r.replies).toEqual([]);
    expect(r.any.recentMessageIds.size).toBe(0);
  });
  it("unknown or ambiguous authenticated usernames never authorize an explicit suffix", async () => {
    const r = rig(true);
    r.fm.worlds.get(A)!.botUsername = undefined;
    await r.copy(A, "/restart@AlphaBot full", ADMIN_A, "unknown-name");
    r.fm.worlds.get(A)!.botUsername = "BetaBot";
    await r.copy(A, "/restart@BetaBot full", ADMIN_A, "same-name");
    await r.copy(B, "/restart@BetaBot full", ADMIN_B, "same-name");
    expect(r.restart).not.toHaveBeenCalled();
    expect(r.any.recentMessageIds.size).toBe(0);
  });
  it("a General in another group does not become this group's bare target", async () => {
    const r = rig(true);
    r.channels[0]!.group_id = "-100999";
    (r.fm.worlds.get(A)! as any).groupId = "-100999";
    await r.copy(B, "/restart full", ADMIN_B);
    expect(r.restart.mock.calls.map(args => args[0].id)).toEqual([B]);
  });
  it("the sibling's own General topic retains its own authority", async () => {
    const r = rig(true);
    await r.copy(A, "/restart full", ADMIN_B, "own-topic", { threadId: "2" });
    await r.copy(B, "/restart full", ADMIN_B, "own-topic", { threadId: "2" });
    expect(r.restart.mock.calls.map(args => args[0].id)).toEqual([B]);
  });
  it("ordinary root text retains receiving-General routing", async () => {
    const r = rig(true);
    await r.copy(B, "ordinary conversation", ADMIN_B);
    expect(r.any.deliverToInstance).toHaveBeenCalledWith("general_b", expect.anything());
    expect(r.restart).not.toHaveBeenCalled();
  });
  it("non-root scopes keep their own selection path", () => {
    const r = rig(true);
    const msg = { source: "telegram", adapterId: B, chatId: GROUP, text: "/restart full" };
    expect(r.any.telegramRootCommandTarget({ ...msg, source: "discord" }, undefined)).toBeUndefined();
    expect(r.any.telegramRootCommandTarget({ ...msg, chatId: "222" }, undefined)).toBeUndefined();
    expect(r.any.telegramRootCommandTarget({ ...msg, chatId: "-100foreign" }, undefined)).toBeUndefined();
    expect(r.any.telegramRootCommandTarget(msg, "2")).toBeUndefined();
  });
});
