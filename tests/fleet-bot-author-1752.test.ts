import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { FleetManager } from "../src/fleet-manager.js";
import { AccessManager } from "../src/channel/access-manager.js";
import { ClassicChannelManager } from "../src/classic-channel-manager.js";
import { captureSpawnHoldReply } from "../src/spawn-hold-reply.js";
import { t } from "../src/locale.js";
import { join } from "node:path";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

/**
 * #1752, seen live: two Discord bots of one fleet share a guild. A user wrote in the leader's topic, the sibling bot
 * (not the leader's) won the inbound dedup race, and the 96% usage warning went out from that sibling. The leader's
 * own adapter then took the sibling's post — a bot message, admitted by open mode / collab — as a user turn.
 *
 * The instance's own bot speaks for it; a post by any bot this fleet runs is never input to a fleet topic.
 */
describe("#1752: sibling fleet bots in a shared guild", () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = join(tmpdir(), `ccd-1752-${Date.now()}-${Math.random()}`); mkdirSync(tmpDir, { recursive: true }); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); vi.restoreAllMocks(); });

  const OPEN = { mode: "open" as const, allowed_users: [] as string[], max_pending_codes: 5, code_expiry_minutes: 10 };
  const OWNER_BOT = "bot-igshan", SIBLING_BOT = "bot-musk";

  function setup(opts: { collab?: boolean } = {}) {
    const fm = new FleetManager(tmpDir);
    const mk = (id: string) => ({ id, type: "discord", react: vi.fn().mockResolvedValue(undefined),
      sendText: vi.fn().mockResolvedValue({ messageId: "m", chatId: "guild" }) } as any);
    const cfg = (id: string) => ({ id, type: "discord", mode: "topic", group_id: "guild", access: OPEN });
    const siblingCfg = cfg("musk"), ownerCfg = cfg("igshan");
    // The sibling is channels[0]; the leader is bound to the other bot, as on the host fleet.
    fm.fleetConfig = { defaults: {}, channels: [siblingCfg, ownerCfg],
      instances: { leader: { working_directory: tmpDir, topic_id: "topic-1", channel_id: "igshan" } } } as any;
    const owner = mk("igshan"), sibling = mk("musk");
    fm.adapter = sibling;
    fm.worlds.set("musk", { id: "musk", adapter: sibling, channelConfig: siblingCfg, groupId: "guild", botUserId: SIBLING_BOT,
      accessManager: new AccessManager(OPEN, join(tmpDir, "musk.json")) } as any);
    fm.worlds.set("igshan", { id: "igshan", adapter: owner, channelConfig: ownerCfg, groupId: "guild", botUserId: OWNER_BOT,
      accessManager: new AccessManager(OPEN, join(tmpDir, "igshan.json")) } as any);
    fm.routing.rebuild(fm.fleetConfig!);
    if (opts.collab) (fm as any).collabInstances.add("leader");
    vi.spyOn((fm as any).topicCommands, "handleInstanceCommand").mockResolvedValue(false);
    vi.spyOn((fm as any).topicCommands, "handleGeneralCommand").mockResolvedValue(false);
    vi.spyOn(fm as any, "sendCancelButton").mockResolvedValue(undefined);
    const deliver = vi.spyOn(fm, "deliverToInstance").mockResolvedValue(undefined);
    const debug = vi.spyOn(fm.logger, "debug");
    return { fm, owner, sibling, deliver, debug };
  }

  const human = (adapterId: string, messageId = "human-1") => ({
    source: "discord", adapterId, chatId: "guild", threadId: "topic-1",
    messageId, userId: "user-1", username: "han", text: "hello", timestamp: new Date(),
  });
  /** The sibling's post as the owner's adapter sees it (a bot never receives its own messages). */
  const siblingPost = () => ({
    source: "discord", adapterId: "igshan", chatId: "guild", threadId: "topic-1",
    messageId: "bot-post-1", userId: SIBLING_BOT, username: "馬斯克Bot",
    text: "⚠️ usage at 96%", isBotMessage: true, timestamp: new Date(),
  });
  const feed = (fm: FleetManager, msg: unknown) => (fm as any).handleInboundMessage(msg);

  it("the usage warning goes out through the instance's own bot and topic, not the dedup winner", async () => {
    const { fm, owner, sibling } = setup();
    vi.spyOn((fm as any).statuslineWatcher, "getRateLimits").mockReturnValue({ five_hour_pct: 10, seven_day_pct: 96 });
    // The sibling's copy arrives first and wins dedup; the owner's copy is then a duplicate.
    await feed(fm, human("musk"));
    await feed(fm, human("igshan"));
    const warning = t("rate_limit.weekly", "leader", 96);
    expect(owner.sendText).toHaveBeenCalledWith("guild", warning, { threadId: "topic-1" });
    expect(sibling.sendText, "the dedup winner must not speak for the leader").not.toHaveBeenCalled();
  });

  it("a post by a sibling fleet bot in a fleet topic is not delivered, even with open mode and collab", async () => {
    const { fm, deliver, debug } = setup({ collab: true });
    await feed(fm, siblingPost());
    expect(deliver).not.toHaveBeenCalled();
    expect(debug).toHaveBeenCalledWith(expect.objectContaining({ author: SIBLING_BOT, threadId: "topic-1" }),
      "Inbound dropped: authored by one of this fleet's own bots in a fleet topic");
  });

  it("in a ClassicBot room, a sibling fleet bot still reaches this bot's agent (same-channel multi-bot collab)", async () => {
    const { fm } = setup();
    const classic = new ClassicChannelManager(tmpDir, fm.logger);
    classic.setPrimaryAdapterId("musk");
    classic.register("room-1", "igshan", "classic-a", "A", "owner");
    classic.toggleCollab("room-1", "igshan");
    fm.classicChannels = classic;
    const handled = vi.spyOn(fm as any, "handleClassicChannelMessage").mockResolvedValue(undefined);
    await feed(fm, { ...siblingPost(), threadId: "room-1" });
    expect(handled).toHaveBeenCalledWith("classic-a", expect.objectContaining({ userId: SIBLING_BOT }));
  });

  it("a bot this fleet does not run is still admitted by collab", async () => {
    const { fm, deliver } = setup({ collab: true });
    await feed(fm, { ...siblingPost(), userId: "bot-someone-else", username: "CI" });
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it("a human message is still delivered, once, whichever bot reports it first", async () => {
    for (const order of [["musk", "igshan"], ["igshan", "musk"]]) {
      const { fm, deliver } = setup({ collab: true });
      for (const id of order) await feed(fm, human(id));
      expect(deliver, `order ${order}`).toHaveBeenCalledTimes(1);
      expect(deliver.mock.calls[0][0]).toBe("leader");
    }
  });

  it("reply context stays canonicalised to the instance's own bot when a sibling wins dedup", async () => {
    const { fm, deliver } = setup();
    await feed(fm, human("musk"));
    const inbound = deliver.mock.calls[0][1] as { meta: { adapter_id: string } };
    expect(inbound.meta.adapter_id).toBe("igshan");
  });

  it("a held-action notice for a fleet topic comes from the instance's own bot", async () => {
    const { fm, owner, sibling, deliver } = setup();
    deliver.mockImplementation(async () => { captureSpawnHoldReply(() => true)?.(); });
    await feed(fm, human("musk"));
    await vi.waitFor(() => expect(owner.sendText).toHaveBeenCalledWith("guild", t("memory.action_held"), { threadId: "topic-1" }));
    expect(sibling.sendText).not.toHaveBeenCalled();
  });
});
