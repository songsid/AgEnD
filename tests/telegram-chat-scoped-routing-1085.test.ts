/**
 * #1085: Telegram routing keyed on topic id alone. Telegram numbers topics per
 * group, so topic 30 of any group the bot was in reached the instance owning
 * topic 30 of the fleet's group (魚機組 topic 30 → 阿金), and a group that never
 * ran /start was bound by coincidence. A Telegram topic is a fleet topic only
 * in the fleet's own group (chat_id == group_id); elsewhere the message is a
 * ClassicBot candidate keyed by chat id, served only if /start registered it.
 */
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FleetManager } from "../src/fleet-manager.js";

const FLEET_GROUP = "-1001111111111";
const FOREIGN_GROUP = "-1003903467272"; // 魚機組-AI代理人集合
const OPEN = { mode: "open", allowed_users: [] as string[] };

let dir: string;
beforeEach(() => { dir = join(tmpdir(), `agend-1085-${Date.now()}-${Math.random()}`); mkdirSync(dir, { recursive: true }); });
afterEach(() => { vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); });

function tgAdapter(id: string) {
  return { id, type: "telegram", react: vi.fn().mockResolvedValue(undefined), unreact: vi.fn().mockResolvedValue(undefined),
    sendText: vi.fn().mockResolvedValue({ messageId: "m", chatId: "c" }) } as any;
}

function setup(opts: { secondTelegramWorld?: boolean; discord?: boolean } = {}) {
  const fm = new FleetManager(dir);
  const tgCfg: any = { id: "tg", type: "telegram", mode: "topic", group_id: FLEET_GROUP, access: OPEN };
  const channels: any[] = [tgCfg];
  const instances: any = {
    general: { working_directory: dir, topic_id: 1, general_topic: true },
    "kennel-akin": { working_directory: dir, topic_id: 30 }, // 阿金
  };
  const tg = tgAdapter("tg");
  fm.adapter = tg;
  fm.worlds.set("tg", { id: "tg", adapter: tg, channelConfig: tgCfg, groupId: FLEET_GROUP, botUsername: "fleetbot" } as any);
  if (opts.secondTelegramWorld) {
    const tg2Cfg: any = { id: "tg2", type: "telegram", mode: "topic", group_id: "-1002222222222", access: OPEN };
    channels.push(tg2Cfg);
    instances["other-world"] = { working_directory: dir, topic_id: 30, channel_id: "tg2" };
    fm.worlds.set("tg2", { id: "tg2", adapter: tgAdapter("tg2"), channelConfig: tg2Cfg, groupId: "-1002222222222", botUsername: "bot2" } as any);
  }
  if (opts.discord) {
    const dcCfg: any = { id: "dc", type: "discord", mode: "topic", group_id: "guild", access: OPEN };
    channels.push(dcCfg);
    instances["dc-worker"] = { working_directory: dir, topic_id: "30", channel_id: "dc" };
    fm.worlds.set("dc", { id: "dc", adapter: { ...tgAdapter("dc"), type: "discord" }, channelConfig: dcCfg, groupId: "guild" } as any);
  }
  fm.fleetConfig = { defaults: {}, channels, instances } as any;
  fm.routing.rebuild(fm.fleetConfig!);
  vi.spyOn((fm as any).topicCommands, "handleInstanceCommand").mockResolvedValue(false);
  vi.spyOn((fm as any).topicCommands, "handleGeneralCommand").mockResolvedValue(false);
  const unbound = vi.spyOn((fm as any).topicCommands, "handleUnboundTopic").mockImplementation(() => {});
  vi.spyOn(fm as any, "sendCancelButton").mockResolvedValue(undefined);
  const deliver = vi.spyOn(fm, "deliverToInstance").mockResolvedValue(undefined);
  const classic = vi.spyOn(fm as any, "handleClassicChannelMessage").mockResolvedValue(undefined);
  return { fm, deliver, unbound, classic };
}

let seq = 0;
const tgMsg = (over: Record<string, unknown> = {}) => ({
  source: "telegram", adapterId: "tg", chatId: FLEET_GROUP, threadId: "30",
  messageId: `m${++seq}`, userId: "u1", username: "han", text: "hello", timestamp: new Date(), ...over,
});
const feed = (fm: FleetManager, m: object) => (fm as any).handleInboundMessage(m);
const deliveredTo = (deliver: any) => deliver.mock.calls.map((c: any[]) => c[0]);

describe("a Telegram topic is a fleet topic only inside the fleet's group (#1085)", () => {
  it("compatibility: topic 30 of the fleet group still reaches its instance", async () => {
    const { fm, deliver } = setup();
    await feed(fm, tgMsg());
    expect(deliveredTo(deliver)).toEqual(["kennel-akin"]);
  });

  it("the report: topic 30 of another group never reaches 阿金", async () => {
    const { fm, deliver, unbound } = setup();
    await feed(fm, tgMsg({ chatId: FOREIGN_GROUP, text: "魚機組的訊息" }));
    expect(deliver).not.toHaveBeenCalled();
    expect(unbound).not.toHaveBeenCalled(); // and no "unbound topic" prompt in a stranger's group
  });

  it("an un-started group is not auto-bound: any topic number, nothing is delivered", async () => {
    const { fm, deliver } = setup();
    for (const threadId of ["1", "30", "77"]) await feed(fm, tgMsg({ chatId: FOREIGN_GROUP, threadId }));
    expect(deliver).not.toHaveBeenCalled();
  });

  it("a foreign group that ran /start is served by ITS ClassicBot agent, keyed by chat id, not by the topic number", async () => {
    const { fm, deliver, classic } = setup();
    const { ClassicChannelManager } = await import("../src/classic-channel-manager.js");
    const pino = (await import("pino")).default;
    const cm = new ClassicChannelManager(dir, pino({ level: "silent" }) as any);
    cm.setPrimaryAdapterId("tg");
    cm.register(FOREIGN_GROUP, "tg", "classic-fish", "魚機組", "owner", "claude-code");
    fm.classicChannels = cm;
    await feed(fm, tgMsg({ chatId: FOREIGN_GROUP, text: "@fleetbot 你好" }));
    expect(deliveredTo(deliver)).not.toContain("kennel-akin");
    expect(classic).toHaveBeenCalledWith("classic-fish", expect.objectContaining({ chatId: FOREIGN_GROUP }));
  });

  it("a bot message from another group's topic is dropped, not delivered", async () => {
    const { fm, deliver } = setup();
    await feed(fm, tgMsg({ chatId: FOREIGN_GROUP, isBotMessage: true, userId: "bot-x" }));
    expect(deliver).not.toHaveBeenCalled();
  });

  it("the access gate is not decided by the coincidental topic owner", async () => {
    const { fm } = setup();
    expect((fm as any).governingAccess(tgMsg({ chatId: FOREIGN_GROUP }), (fm as any).inboundRouteThreadId(tgMsg({ chatId: FOREIGN_GROUP }))))
      .toEqual({ adapterId: "tg", authoritative: false });
    expect((fm as any).governingAccess(tgMsg(), "30")).toEqual({ adapterId: "tg", authoritative: true });
  });

  it("two Telegram fleet groups numbering topics alike: each group's topic 30 reaches its own instance", async () => {
    const { fm, deliver } = setup({ secondTelegramWorld: true });
    await feed(fm, tgMsg());                                                   // fleet group 1, received by tg
    await feed(fm, tgMsg({ adapterId: "tg2", chatId: "-1002222222222" }));     // fleet group 2, received by tg2
    expect(deliver.mock.calls.map((c: any[]) => [c[0], c[1]?.meta?.chat_id])).toEqual([
      ["kennel-akin", FLEET_GROUP],
      ["other-world", "-1002222222222"],
    ]);
  });

  it("…and the access gate of group 1's topic 30 is its own instance's adapter, not the other world's", async () => {
    const { fm } = setup({ secondTelegramWorld: true });
    expect((fm as any).governingAccess(tgMsg(), "30")).toEqual({ adapterId: "tg", authoritative: true });
    expect((fm as any).governingAccess(tgMsg({ adapterId: "tg2", chatId: "-1002222222222" }), "30"))
      .toEqual({ adapterId: "tg2", authoritative: true });
  });

  it("two bots that each own a ClassicBot agent in the same foreign forum group both get their copy (dedup is per bot there)", async () => {
    const { fm, classic } = setup({ secondTelegramWorld: true });
    const { ClassicChannelManager } = await import("../src/classic-channel-manager.js");
    const pino = (await import("pino")).default;
    const cm = new ClassicChannelManager(dir, pino({ level: "silent" }) as any);
    cm.setPrimaryAdapterId("tg");
    cm.register(FOREIGN_GROUP, "tg", "classic-a", "魚機組", "owner", "claude-code");
    cm.register(FOREIGN_GROUP, "tg2", "classic-b", "魚機組", "owner", "claude-code");
    fm.classicChannels = cm;
    const same = { chatId: FOREIGN_GROUP, messageId: "shared-1", text: "大家好" };
    await feed(fm, tgMsg({ ...same, adapterId: "tg" }));
    await feed(fm, tgMsg({ ...same, adapterId: "tg2" }));
    expect(classic.mock.calls.map((c: any[]) => c[0]).sort()).toEqual(["classic-a", "classic-b"]);
  });

  it("Discord is unchanged: its channel ids are global", async () => {
    const { fm, deliver } = setup({ discord: true });
    await feed(fm, { source: "discord", adapterId: "dc", chatId: "guild", threadId: "30", messageId: "d1",
      userId: "u1", username: "han", text: "hi", timestamp: new Date() });
    expect(deliveredTo(deliver)).toContain("dc-worker");
  });

  it("an instance whose own Telegram world has no group_id never matches a message's chat", async () => {
    const { fm, deliver } = setup({ secondTelegramWorld: true });
    delete (fm.fleetConfig as any).channels[1].group_id;          // tg2 without a group
    (fm.fleetConfig as any).instances["other-world"].topic_id = 40;
    fm.routing.rebuild(fm.fleetConfig!);
    await feed(fm, tgMsg({ threadId: "40" }));                     // fleet group 1, topic 40 (owned only by tg2's instance)
    expect(deliver).not.toHaveBeenCalled();
  });

  it("a bot message in a topic owned only by another world's instance is dropped at the bot gate", async () => {
    const { fm, deliver, unbound } = setup({ secondTelegramWorld: true });
    (fm.fleetConfig as any).instances["other-world"].topic_id = 77;
    fm.routing.rebuild(fm.fleetConfig!);
    await feed(fm, tgMsg({ threadId: "77", isBotMessage: true, userId: "bot-x" }));  // group 1 topic 77; 77 is group 2's
    expect(deliver).not.toHaveBeenCalled();
    expect(unbound).not.toHaveBeenCalled();
  });

  it("without a group_id, no Telegram thread is a fleet topic (fail closed at the first gate)", () => {
    const { fm } = setup();
    delete (fm.fleetConfig as any).channels[0].group_id;
    expect((fm as any).inboundRouteThreadId(tgMsg())).toBeUndefined();
  });

  it("a Telegram channel with no group_id routes no topic (it could not serve one)", async () => {
    const { fm, deliver } = setup();
    delete (fm.fleetConfig as any).channels[0].group_id;
    await feed(fm, tgMsg());
    expect(deliver).not.toHaveBeenCalled();
  });
});


describe("RoutingEngine keeps every owner of a topic id (#1085)", async () => {
  const { RoutingEngine } = await import("../src/routing-engine.js");
  it("resolveAll lists both owners; unregister by name keeps the other; resolve stays the last registered", () => {
    const r = new RoutingEngine();
    r.register(30, { kind: "instance", name: "a" });
    r.register(30, { kind: "instance", name: "b" });
    expect(r.resolveAll("30").map(t => t.name)).toEqual(["a", "b"]);
    expect(r.resolve("30")?.name).toBe("b");
    r.unregister(30, "b");
    expect(r.resolveAll("30").map(t => t.name)).toEqual(["a"]);
    expect(r.resolve("30")?.name).toBe("a");
    r.unregister(30, "a");
    expect(r.resolveAll("30")).toEqual([]);
    expect(r.resolve("30")).toBeUndefined();
  });
  it("unregister without a name removes every owner (the old behaviour)", () => {
    const r = new RoutingEngine();
    r.register(30, { kind: "instance", name: "a" });
    r.register(30, { kind: "instance", name: "b" });
    r.unregister(30);
    expect(r.resolveAll("30")).toEqual([]);
  });
  it("re-registering the same name does not duplicate it; a direct map write is still visible", () => {
    const r = new RoutingEngine();
    r.register(30, { kind: "instance", name: "a" });
    r.register(30, { kind: "instance", name: "a" });
    expect(r.resolveAll("30")).toHaveLength(1);
    r.map.set("31", { kind: "instance", name: "bound" });
    expect(r.resolveAll("31").map(t => t.name)).toEqual(["bound"]);
  });
  it("rebuild forgets owners that are no longer configured", () => {
    const r = new RoutingEngine();
    r.rebuild({ instances: { a: { topic_id: 30 }, b: { topic_id: 30 } } } as any);
    r.rebuild({ instances: { b: { topic_id: 30 } } } as any);
    expect(r.resolveAll("30").map(t => t.name)).toEqual(["b"]);
  });
    it("rebuild lists every instance on a topic id", () => {
    const r = new RoutingEngine();
    r.rebuild({ instances: { a: { topic_id: 30 }, b: { topic_id: 30 }, g: { topic_id: 1, general_topic: true } } } as any);
    expect(r.resolveAll("30").map(t => t.name)).toEqual(["a", "b"]);
    expect(r.resolve("1")).toEqual({ kind: "general", name: "g" });
  });
});

describe("a registered Telegram forum ClassicBot keeps the topic end to end (#1085 review)", async () => {
  const { ClassicChannelManager } = await import("../src/classic-channel-manager.js");
  const pino = (await import("pino")).default;

  async function classicFleet() {
    const s = setup();
    s.classic.mockRestore(); // the real ClassicBot handler from here on
    vi.spyOn(ClassicChannelManager, "logMessage").mockImplementation(() => {});
    vi.spyOn(s.fm as any, "getRecentChatLog").mockReturnValue("");
    vi.spyOn(s.fm as any, "sendCancelButton").mockResolvedValue(undefined);
    const cm = new ClassicChannelManager(dir, pino({ level: "silent" }) as any);
    cm.setPrimaryAdapterId("tg");
    cm.register(FOREIGN_GROUP, "tg", "classic-fish", "魚機組", "owner", "claude-code");
    s.fm.classicChannels = cm;
    return s;
  }

  async function replyAs(fm: FleetManager, meta: Record<string, string>) {
    await (fm as any).handleOutboundFromInstance("classic-fish", {
      type: "fleet_outbound", tool: "reply", requestId: 1, adapterId: meta.adapter_id,
      args: { chat_id: meta.chat_id, thread_id: meta.thread_id, text: "回覆" },
    });
  }

  it("a message in topic 30 of the group: delivery meta, reply context and the real reply all keep topic 30", async () => {
    const { fm, deliver } = await classicFleet();
    await feed(fm, tgMsg({ chatId: FOREIGN_GROUP, threadId: "30", text: "@fleetbot hello" }));
    expect(deliveredTo(deliver)).toEqual(["classic-fish"]);
    const meta = (deliver.mock.calls[0][1] as any).meta;
    expect(meta).toMatchObject({ chat_id: FOREIGN_GROUP, thread_id: "30" });
    expect((fm as any).lastInboundMsg.get("classic-fish")).toMatchObject({ chatId: FOREIGN_GROUP, threadId: "30" });
    await replyAs(fm, meta);
    const send = (fm.worlds.get("tg") as any).adapter.sendText;
    await vi.waitFor(() => expect(send).toHaveBeenCalled());
    expect(send.mock.calls[0][0]).toBe(FOREIGN_GROUP);
    expect(send.mock.calls[0][2]).toMatchObject({ threadId: "30" });
  });

  it("a threadless Telegram ClassicBot group is unchanged: the reply goes to the chat with no thread", async () => {
    const { fm, deliver } = await classicFleet();
    await feed(fm, tgMsg({ chatId: FOREIGN_GROUP, threadId: undefined, text: "@fleetbot hello" }));
    const meta = (deliver.mock.calls[0][1] as any).meta;
    expect(meta.thread_id).toBe(FOREIGN_GROUP); // the registry key, as before
    await replyAs(fm, meta);
    const send = (fm.worlds.get("tg") as any).adapter.sendText;
    await vi.waitFor(() => expect(send).toHaveBeenCalled());
    expect(send.mock.calls[0][0]).toBe(FOREIGN_GROUP);
    expect(send.mock.calls[0][2]?.threadId).toBeUndefined();
  });
});

describe("a Discord ClassicBot still replies only in its own channel (#1085 review)", async () => {
  const { ClassicChannelManager } = await import("../src/classic-channel-manager.js");
  const pino = (await import("pino")).default;
  it("a thread_id naming another channel is cleared, as before", async () => {
    const { fm } = setup({ discord: true });
    const cm = new ClassicChannelManager(dir, pino({ level: "silent" }) as any);
    cm.setPrimaryAdapterId("dc");
    cm.register("dc-chan", "dc", "classic-dc", "room", "owner", "claude-code");
    fm.classicChannels = cm;
    await (fm as any).handleOutboundFromInstance("classic-dc", {
      type: "fleet_outbound", tool: "reply", requestId: 1, adapterId: "dc",
      args: { chat_id: "guild", thread_id: "some-other-channel", text: "hi" },
    });
    const send = (fm.worlds.get("dc") as any).adapter.sendText;
    await vi.waitFor(() => expect(send).toHaveBeenCalled());
    expect(send.mock.calls[0][0]).toBe("dc-chan");
    expect(send.mock.calls[0][2]?.threadId).toBeUndefined();
  });
});
