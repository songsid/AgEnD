import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { FleetManager } from "../src/fleet-manager.js";
import { ClassicChannelManager } from "../src/classic-channel-manager.js";
import { join } from "node:path";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

/**
 * Two Discord bots share one guild: a fleet adapter with `access.mode: open`
 * and a ClassicBot persona with no access block. Both receive the same webhook
 * message (author.bot === true).
 *
 * Dedup used to claim the shared key before the per-adapter bot filter ran, so
 * whichever adapter arrived first decided the message's fate: when the persona
 * won the race its copy was dropped by the filter *and* the fleet adapter's
 * copy was then discarded as a duplicate. The webhook vanished silently.
 */
describe("webhook messages survive whichever adapter wins the dedup race", () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = join(tmpdir(), `ccd-wh-${Date.now()}-${Math.random()}`); mkdirSync(tmpDir, { recursive: true }); });
  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  const OPEN = { mode: "open", allowed_users: [] as string[] };

  function setup(opts: { personaAccess?: any; primaryAccess?: any; worldOrder?: "reverse"; boundTo?: string } = {}) {
    const fm = new FleetManager(tmpDir);
    const mk = (id: string) => ({ id, type: "discord", react: vi.fn().mockResolvedValue(undefined),
      sendText: vi.fn().mockResolvedValue({ messageId: "m", chatId: "guild" }) } as any);
    const fleetCfg: any = { id: "discord", type: "discord", mode: "topic", group_id: "guild" };
    if (opts.primaryAccess !== null) fleetCfg.access = opts.primaryAccess ?? OPEN;
    const personaCfg: any = { id: "grok-persona", type: "discord", mode: "topic", group_id: "guild" };
    if (opts.personaAccess) personaCfg.access = opts.personaAccess;   // null => no access block
    const a1 = mk("discord"), a2 = mk("grok-persona");
    fm.fleetConfig = { defaults: {}, channels: [fleetCfg, personaCfg],
      instances: { worker: { working_directory: tmpDir, topic_id: "topic-1",
        ...(opts.boundTo ? { channel_id: opts.boundTo } : {}) } } } as any;
    fm.adapter = a1;
    const w1 = ["discord", { id: "discord", adapter: a1, channelConfig: fleetCfg, groupId: "guild" }] as const;
    const w2 = ["grok-persona", { id: "grok-persona", adapter: a2, channelConfig: personaCfg, groupId: "guild" }] as const;
    for (const [k, v] of (opts.worldOrder === "reverse" ? [w2, w1] : [w1, w2])) fm.worlds.set(k, v as any);
    fm.routing.rebuild(fm.fleetConfig);
    vi.spyOn((fm as any).topicCommands, "handleInstanceCommand").mockResolvedValue(false);
    vi.spyOn((fm as any).topicCommands, "handleGeneralCommand").mockResolvedValue(false);
    vi.spyOn(fm as any, "sendCancelButton").mockResolvedValue(undefined);
    return { fm, deliver: vi.spyOn(fm, "deliverToInstance").mockResolvedValue(undefined) };
  }

  const msg = (adapterId: string, over: Record<string, unknown> = {}) => ({
    source: "discord", adapterId, chatId: "guild", threadId: "topic-1",
    messageId: "same-webhook-message", userId: "webhook-999", username: "CI",
    text: "deploy finished", timestamp: new Date(), isBotMessage: true, ...over,
  });

  async function feed(fm: FleetManager, order: string[], over: Record<string, unknown> = {}) {
    for (const id of order) await (fm as any).handleInboundMessage(msg(id, over));
  }

  it("delivers when the persona adapter arrives first (the reported bug)", async () => {
    const { fm, deliver } = setup();
    await feed(fm, ["grok-persona", "discord"]);
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it("delivers when the fleet adapter arrives first", async () => {
    const { fm, deliver } = setup();
    await feed(fm, ["discord", "grok-persona"]);
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it("delivers exactly once when BOTH adapters would otherwise accept it", async () => {
    // Keying the dedup per-adapter for bot messages would double-deliver here.
    const { fm, deliver } = setup({ personaAccess: OPEN });
    await feed(fm, ["grok-persona", "discord"]);
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it("lets the PRIMARY adapter take it regardless of arrival order", async () => {
    for (const order of [["grok-persona", "discord"], ["discord", "grok-persona"]]) {
      const { fm, deliver } = setup({ personaAccess: OPEN });
      const debug = vi.spyOn(fm.logger, "debug");
      await feed(fm, order);
      expect(deliver, `order ${order}`).toHaveBeenCalledTimes(1);
      // The discarded copy must be the persona's, whichever arrived first.
      const drop = debug.mock.calls.find(c => String(c[1] ?? "").includes("dropped before the dedup claim"));
      expect(drop, `order ${order}`).toBeDefined();
      expect((drop![0] as any).adapterId, `order ${order}`).toBe("grok-persona");
      expect(String((drop![0] as any).reason)).toContain("not the adapter bound to");
    }
  });

  it("picks the primary from channels[0], not from world insertion order", async () => {
    // The persona world is registered FIRST here while channels[0] is still the
    // fleet adapter. Inferring the primary from Map insertion order — which
    // getPrimaryAdapterId's contract forbids — would hand the webhook to the
    // persona and let it speak in a fleet topic.
    const { fm, deliver } = setup({ personaAccess: OPEN, worldOrder: "reverse" });
    const debug = vi.spyOn(fm.logger, "debug");
    await feed(fm, ["grok-persona", "discord"]);
    expect(deliver).toHaveBeenCalledTimes(1);
    // meta.adapter_id is canonicalized to the primary either way, so assert on
    // which copy was DISCARDED — that is what the primary choice actually moves.
    const drop = debug.mock.calls.find(c => String(c[1] ?? "").includes("dropped before the dedup claim"));
    expect(drop, "the persona copy must be the discarded one").toBeDefined();
    expect((drop![0] as any).adapterId).toBe("grok-persona");
  });

  it("an instance bound to a NON-default adapter is served by that adapter", async () => {
    // The A-vs-B discriminator. Under a fleet-global primary (channels[0]) this
    // instance's own bot would be judged "not primary" and its webhook dropped,
    // leaving the instance unreachable. The primary is per-instance: the adapter
    // the instance is bound to.
    const { fm, deliver } = setup({ personaAccess: OPEN, boundTo: "grok-persona" });
    const debug = vi.spyOn(fm.logger, "debug");
    await feed(fm, ["discord", "grok-persona"]);
    expect(deliver, "the bound adapter must serve it").toHaveBeenCalledTimes(1);
    // The discarded copy is the unbound one, even though it is channels[0].
    const drop = debug.mock.calls.find(c => String(c[1] ?? "").includes("dropped before the dedup claim"));
    expect(drop).toBeDefined();
    expect((drop![0] as any).adapterId).toBe("discord");
    expect(String((drop![0] as any).reason)).toContain("bound to worker");
  });

  it("serves a bound instance in either arrival order, exactly once", async () => {
    for (const order of [["discord", "grok-persona"], ["grok-persona", "discord"]]) {
      const { fm, deliver } = setup({ personaAccess: OPEN, boundTo: "grok-persona" });
      await feed(fm, order);
      expect(deliver, `order ${order}`).toHaveBeenCalledTimes(1);
    }
  });

  it("an open NON-owner adapter cannot deliver for an owner that declines", async () => {
    // The owner is bound to the persona and declines (no access block, collab
    // off); channels[0] is open. The open sibling must not stand in for it —
    // that would apply the wrong adapter's access policy to the owner's topic.
    const { fm, deliver } = setup({ primaryAccess: OPEN, personaAccess: null, boundTo: "grok-persona" });
    const debug = vi.spyOn(fm.logger, "debug");
    await feed(fm, ["discord", "grok-persona"]);
    expect(deliver, "no adapter may deliver here").not.toHaveBeenCalled();
    const reasons = debug.mock.calls
      .filter(c => String(c[1] ?? "").includes("dropped before the dedup claim"))
      .map(c => String((c[0] as any).reason));
    expect(reasons.some(r => r.includes("not the adapter bound to")), "the open sibling is dropped for not owning the topic").toBe(true);
  });

  it("falls back to channels[0] when the instance is not bound", async () => {
    const { fm, deliver } = setup({ personaAccess: OPEN });   // no channel_id
    const debug = vi.spyOn(fm.logger, "debug");
    await feed(fm, ["grok-persona", "discord"]);
    expect(deliver).toHaveBeenCalledTimes(1);
    const drop = debug.mock.calls.find(c => String(c[1] ?? "").includes("dropped before the dedup claim"));
    expect((drop![0] as any).adapterId).toBe("grok-persona");
  });

  it("does not fall back to a persona when the primary itself declines", async () => {
    // primary is open only via access; make it decline by removing that.
    const { fm, deliver } = setup({ personaAccess: OPEN, primaryAccess: null });
    await feed(fm, ["grok-persona", "discord"]);
    expect(deliver, "primary declines -> nobody answers").not.toHaveBeenCalled();
  });

  it("routes the surviving copy to the single fleet instance for the topic", async () => {
    const { fm, deliver } = setup();
    await feed(fm, ["grok-persona", "discord"]);
    expect(deliver.mock.calls[0][0]).toBe("worker");
  });

  it("logs why a copy was dropped, without consuming the dedup key", async () => {
    const { fm } = setup();
    const debug = vi.spyOn(fm.logger, "debug");
    await feed(fm, ["grok-persona"]);
    const dropped = debug.mock.calls.find(c => String(c[1] ?? "").includes("dropped before the dedup claim"));
    expect(dropped, "expected a drop log for the persona adapter").toBeDefined();
    expect((dropped![0] as any).adapterId).toBe("grok-persona");
    expect(String((dropped![0] as any).reason)).toContain("not the adapter bound to");
  });

  it("still drops a classic bot message when that bot's collab is off", async () => {
    // The filter moved ahead of the dedup claim; its decisions must be unchanged.
    const { fm } = setup();
    const classic = new ClassicChannelManager(tmpDir, fm.logger);
    classic.setPrimaryAdapterId("discord");
    classic.register("topic-1", "discord", "classic-a", "A", "owner");
    fm.classicChannels = classic;                       // collab left OFF
    const debug = vi.spyOn(fm.logger, "debug");
    await feed(fm, ["discord"]);
    const drop = debug.mock.calls.find(c => String(c[1] ?? "").includes("dropped before the dedup claim"));
    expect(drop, "collab off must drop the copy at the filter").toBeDefined();
    expect(String((drop![0] as any).reason)).toContain("collab off");
  });

  it("still drops a classic bot message when this bot owns no agent there", async () => {
    const { fm } = setup();
    const classic = new ClassicChannelManager(tmpDir, fm.logger);
    classic.setPrimaryAdapterId("discord");
    classic.register("topic-1", "grok-persona", "classic-b", "B", "owner");
    classic.toggleCollab("topic-1", "grok-persona");
    fm.classicChannels = classic;
    const debug = vi.spyOn(fm.logger, "debug");
    await feed(fm, ["discord"]);                        // the bot with no agent
    const drop = debug.mock.calls.find(c => String(c[1] ?? "").includes("dropped before the dedup claim"));
    expect(drop, "a bot with no agent here must be dropped").toBeDefined();
    expect(String((drop![0] as any).reason)).toContain("owns no agent");
  });

  it("still drops a bot message in a thread no instance is routed to", async () => {
    const { fm, deliver } = setup();
    const debug = vi.spyOn(fm.logger, "debug");
    await (fm as any).handleInboundMessage(msg("discord", { threadId: "unrouted-topic" }));
    const drop = debug.mock.calls.find(c => String(c[1] ?? "").includes("dropped before the dedup claim"));
    expect(drop, "an unrouted thread must be dropped").toBeDefined();
    expect(String((drop![0] as any).reason)).toContain("no instance routed");
    expect(deliver).not.toHaveBeenCalled();
  });

  // The Telegram no-thread branch moved with the rest of the filter and had no
  // coverage anywhere in the suite; pin it so the relocation stays faithful.
  describe("telegram classic (no threadId) bot messages", () => {
    function tgSetup(access?: any) {
      const fm = new FleetManager(tmpDir);
      const adapter = { id: "telegram", type: "telegram", react: vi.fn().mockResolvedValue(undefined),
        sendText: vi.fn().mockResolvedValue({ messageId: "m", chatId: "-100" }) } as any;
      const cfg: any = { id: "telegram", type: "telegram", mode: "topic", group_id: "-100" };
      if (access) cfg.access = access;
      fm.fleetConfig = { defaults: {}, channels: [cfg], instances: {} } as any;
      fm.adapter = adapter;
      fm.worlds.set("telegram", { id: "telegram", adapter, channelConfig: cfg, groupId: "-100", botUsername: "OurBot" } as any);
      fm.routing.rebuild(fm.fleetConfig);
      return fm;
    }
    const tgMsg = (text: string) => ({
      source: "telegram", adapterId: "telegram", chatId: "12345", threadId: undefined,
      messageId: "tg-1", userId: "999", username: "OtherBot", text,
      timestamp: new Date(), isBotMessage: true,
    });

    it("drops a bot message that neither mentions us nor arrives on an open adapter", async () => {
      const fm = tgSetup();
      const debug = vi.spyOn(fm.logger, "debug");
      await (fm as any).handleInboundMessage(tgMsg("just chatting"));
      const drop = debug.mock.calls.find(c => String(c[1] ?? "").includes("dropped before the dedup claim"));
      expect(drop, "should be dropped").toBeDefined();
      expect(String((drop![0] as any).reason)).toContain("does not mention us");
      // The core of the fix: a dropped copy must not consume the shared key.
      expect((fm as any).recentMessageIds.size, "dropped copy must not claim the key").toBe(0);
    });

    it("accepts a bot message that @mentions our bot", async () => {
      const fm = tgSetup();
      const debug = vi.spyOn(fm.logger, "debug");
      await (fm as any).handleInboundMessage(tgMsg("hey @OurBot please look"));
      const drop = debug.mock.calls.find(c => String(c[1] ?? "").includes("dropped before the dedup claim"));
      expect(drop, "a mention must pass the filter").toBeUndefined();
      // Surviving the filter means the copy went on to claim the dedup key.
      expect((fm as any).recentMessageIds.size, "accepted copy must claim the key").toBe(1);
    });

    it("accepts any bot message when the adapter is open", async () => {
      const fm = tgSetup(OPEN);
      const debug = vi.spyOn(fm.logger, "debug");
      await (fm as any).handleInboundMessage(tgMsg("no mention here"));
      const drop = debug.mock.calls.find(c => String(c[1] ?? "").includes("dropped before the dedup claim"));
      expect(drop, "open adapter must pass the filter").toBeUndefined();
      expect((fm as any).recentMessageIds.size, "accepted copy must claim the key").toBe(1);
    });
  });

  it("leaves human-message dedup semantics untouched", async () => {
    for (const order of [["discord", "grok-persona"], ["grok-persona", "discord"]]) {
      const { fm, deliver } = setup();
      await feed(fm, order, { isBotMessage: false, userId: "human-1" });
      expect(deliver, `order ${order}`).toHaveBeenCalledTimes(1);
    }
  });

  it("keeps the per-adapter dedup exception for classic channels", async () => {
    // Two bots own separate agents in one classic channel, so each must process
    // its OWN copy — the dedup key stays adapter-scoped there. (Classic collab
    // messages are handled inline rather than via deliverToInstance, so assert
    // on both copies surviving dedup rather than on the delivery spy.)
    const { fm } = setup();
    const classic = new ClassicChannelManager(tmpDir, fm.logger);
    classic.setPrimaryAdapterId("discord");
    classic.register("topic-1", "discord", "classic-a", "A", "owner");
    classic.register("topic-1", "grok-persona", "classic-b", "B", "owner");
    classic.toggleCollab("topic-1", "discord");
    classic.toggleCollab("topic-1", "grok-persona");
    fm.classicChannels = classic;
    const info = vi.spyOn(fm.logger, "info");
    const debug = vi.spyOn(fm.logger, "debug");

    await feed(fm, ["grok-persona", "discord"]);

    const handled = info.mock.calls.filter(c => String(c[1] ?? c[0] ?? "").includes("Collab mode message"));
    expect(handled, "both bots must handle their own copy").toHaveLength(2);
    const deduped = debug.mock.calls.filter(c => String(c[1] ?? "").includes("Duplicate inbound"));
    expect(deduped, "neither classic copy may be dropped as a duplicate").toHaveLength(0);
    // The fleet-topic primary rule must not reach classic: grok-persona is NOT
    // the primary adapter, and dropping it here would silence @馬斯克Bot in its
    // own channel.
    const primaryDrops = debug.mock.calls.filter(c => String((c[0] as any)?.reason ?? "").includes("not the adapter bound to"));
    expect(primaryDrops, "the primary rule must not apply to classic channels").toHaveLength(0);
  });
});
