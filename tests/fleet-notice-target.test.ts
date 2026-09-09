import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { FleetManager } from "../src/fleet-manager.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * On Telegram a group id is a chat, so posting straight to it works. On Discord
 * it is a *guild* id: the adapter then fetches a channel that does not exist and
 * the send fails with 10003 Unknown Channel, inside a catch handler where nobody
 * sees it. The daily summary had been doing that every night — 14 failures in
 * one log — so a Discord fleet never received one.
 *
 * Separately, a schedule stores where it was created apart from what it
 * triggers. Choosing the adapter from the target sends a Telegram chat id
 * through a Discord bot when the two differ.
 */
describe("fleet-wide notices resolve a postable target", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "agend-notice-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const discordCfg = (extra: Record<string, unknown> = {}) => ({
    id: "discord", type: "discord", mode: "topic", group_id: "guild-1", ...extra,
  });
  const telegramCfg = { id: "telegram", type: "telegram", mode: "topic", group_id: "-100777" };

  function makeFleet(channels: any[], instances: Record<string, any> = {}) {
    const fm = new FleetManager(dir) as any;
    fm.fleetConfig = { defaults: {}, channels, instances };
    for (const cfg of channels) {
      fm.worlds.set(cfg.id, {
        id: cfg.id, adapter: { id: cfg.id, sendText: vi.fn().mockResolvedValue({}) },
        channelConfig: cfg, groupId: String(cfg.group_id),
      });
    }
    fm.adapter = fm.worlds.get(channels[0].id)?.adapter;
    return fm;
  }

  it("uses the General topic as the channel on Discord, never the guild id", () => {
    const fm = makeFleet([discordCfg()], { gen: { general_topic: true, topic_id: "chan-general" } });
    const target = fm.fleetNoticeTarget();
    expect(target).toEqual({ chatId: "guild-1", opts: { threadId: "chan-general" } });
  });

  it("falls back to the configured general_channel_id on Discord", () => {
    const fm = makeFleet([discordCfg({ options: { general_channel_id: "chan-cfg" } })]);
    expect(fm.fleetNoticeTarget()).toEqual({ chatId: "guild-1", opts: { threadId: "chan-cfg" } });
  });

  it("refuses rather than posting to a bare Discord guild id", () => {
    // The old behaviour: sendText(guildId) with no thread — a guaranteed 10003.
    const fm = makeFleet([discordCfg()]);
    expect(fm.fleetNoticeTarget(), "no channel is knowable, so say so").toBeNull();
  });

  it("still posts straight to the group on Telegram, where that is a real chat", () => {
    const fm = makeFleet([telegramCfg]);
    expect(fm.fleetNoticeTarget()).toEqual({ chatId: "-100777", opts: {} });
  });

  it("notifyInstanceTopic reports that it could not post, instead of failing silently", () => {
    // Behavioural, not a source-text check: drive the real method for an
    // instance with neither a topic nor a classic channel and confirm it both
    // declines and says why.
    const fm = makeFleet([discordCfg()], { orphan: {} });
    const warn = vi.spyOn(fm.logger, "warn");

    const posted = fm.notifyInstanceTopic("orphan", "hello");

    expect(posted, "nothing was sent").toBe(false);
    expect(fm.adapter.sendText, "and nothing was sent to a guild id either").not.toHaveBeenCalled();
    const said = warn.mock.calls.some(c => String(c[1] ?? c[0] ?? "").includes("No postable target"));
    expect(said, "the reason must be logged").toBe(true);
  });

  it("postDailySummary posts to a channel, driven through the real method", () => {
    // Not a manual fleetNoticeTarget + sendText: reverting the call site to the
    // bare group id must fail this, which is the whole point of the change.
    const fm = makeFleet([discordCfg()], { gen: { general_topic: true, topic_id: "chan-general" } });

    fm.postDailySummary("summary");

    expect(fm.adapter.sendText).toHaveBeenCalledWith("guild-1", "summary", { threadId: "chan-general" });
  });

  it("postDailySummary says why it stayed silent when no channel is knowable", () => {
    const fm = makeFleet([discordCfg()]);
    const warn = vi.spyOn(fm.logger, "warn");

    fm.postDailySummary("summary");

    expect(fm.adapter.sendText, "a guild id is not a channel").not.toHaveBeenCalled();
    expect(warn.mock.calls.some(c => String(c[1] ?? c[0] ?? "").includes("Daily summary has no postable target"))).toBe(true);
  });
});

describe("adapterForChat", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "agend-chat-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function makeFleet() {
    const fm = new FleetManager(dir) as any;
    const channels = [
      { id: "discord", type: "discord", mode: "topic", group_id: "guild-1" },
      { id: "grok-persona", type: "discord", mode: "topic", group_id: "guild-1" },
      { id: "telegram", type: "telegram", mode: "topic", group_id: "-100777" },
    ];
    fm.fleetConfig = { defaults: {}, channels, instances: {} };
    for (const cfg of channels) {
      fm.worlds.set(cfg.id, {
        id: cfg.id, adapter: { id: cfg.id, sendText: vi.fn() },
        channelConfig: cfg, groupId: String(cfg.group_id),
      });
    }
    return fm;
  }

  it("picks the adapter that owns the chat, across platforms", () => {
    // A Telegram group scheduling a Discord-topic instance: the notice must go
    // out through Telegram, not through the target instance's Discord bot.
    expect(makeFleet().adapterForChat("-100777").id).toBe("telegram");
  });

  it("prefers the primary when several bots share one guild", () => {
    // Otherwise a persona becomes the voice announcing fleet scheduling.
    expect(makeFleet().adapterForChat("guild-1").id).toBe("discord");
  });

  it("returns undefined for a chat no adapter owns, so the caller can fall back", () => {
    expect(makeFleet().adapterForChat("unknown-chat")).toBeUndefined();
  });
});

/**
 * The wiring, not just the resolver: adapterForChat's own tests keep passing if
 * notifySourceTopic stops calling it, which is the same gap that let the
 * original defect ship.
 */
describe("notifySourceTopic (through the real method)", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "agend-sched-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function makeFleet() {
    const fm = new FleetManager(dir) as any;
    const channels = [
      { id: "discord", type: "discord", mode: "topic", group_id: "guild-1" },
      { id: "telegram", type: "telegram", mode: "topic", group_id: "-100777" },
    ];
    // The target instance lives in a Discord topic; the schedule was created
    // from a Telegram group — exactly the live configuration that failed.
    fm.fleetConfig = { defaults: {}, channels, instances: { worker: { topic_id: "chan-x" } } };
    for (const cfg of channels) {
      fm.worlds.set(cfg.id, {
        id: cfg.id, adapter: { id: cfg.id, sendText: vi.fn().mockResolvedValue({}) },
        channelConfig: cfg, groupId: String(cfg.group_id),
      });
    }
    fm.adapter = fm.worlds.get("discord").adapter;
    return fm;
  }

  const schedule = {
    id: "s1", label: "nightly", target: "worker",
    reply_chat_id: "-100777", reply_thread_id: "245",
  } as any;

  it("announces through the adapter that owns the source chat, not the target's", () => {
    const fm = makeFleet();

    fm.notifySourceTopic(schedule);

    const tg = fm.worlds.get("telegram").adapter.sendText;
    const dc = fm.worlds.get("discord").adapter.sendText;
    expect(tg, "the Telegram source must be answered by the Telegram bot").toHaveBeenCalledTimes(1);
    expect(dc, "the target's Discord bot cannot reach that chat").not.toHaveBeenCalled();
    expect(tg.mock.calls[0][0]).toBe("-100777");
    expect(tg.mock.calls[0][2]).toEqual({ threadId: "245" });
  });

  it("still works when the schedule's source is the same platform as the target", () => {
    const fm = makeFleet();

    fm.notifySourceTopic({ ...schedule, reply_chat_id: "guild-1", reply_thread_id: "chan-x" });

    expect(fm.worlds.get("discord").adapter.sendText).toHaveBeenCalledTimes(1);
    expect(fm.worlds.get("telegram").adapter.sendText).not.toHaveBeenCalled();
  });
});

/**
 * B1: the General used for a fleet notice must belong to the same adapter as the
 * group it is posted into. Picking the first General in the instance map gave a
 * Telegram group id carrying a Discord channel as its thread, and made the
 * result depend on map insertion order.
 */
describe("fleetNoticeTarget picks the General of the right adapter", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "agend-dual-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const dc = { id: "discord", type: "discord", mode: "topic", group_id: "guild-1" };
  const tg = { id: "telegram", type: "telegram", mode: "topic", group_id: "-100777" };

  function dualFleet(order: "dc-first" | "tg-first") {
    const fm = new FleetManager(dir) as any;
    const generals = order === "dc-first"
      ? {
        "general-dc": { general_topic: true, topic_id: "dc-channel" },
        "general-tg": { general_topic: true, topic_id: "9", channel_id: "telegram" },
      }
      : {
        "general-tg": { general_topic: true, topic_id: "9", channel_id: "telegram" },
        "general-dc": { general_topic: true, topic_id: "dc-channel" },
      };
    fm.fleetConfig = { defaults: {}, channels: [dc, tg], instances: generals };
    for (const cfg of [dc, tg]) {
      fm.worlds.set(cfg.id, { id: cfg.id, adapter: { id: cfg.id, sendText: vi.fn() }, channelConfig: cfg, groupId: String(cfg.group_id) });
    }
    fm.adapter = fm.worlds.get("discord").adapter;
    return fm;
  }

  for (const order of ["dc-first", "tg-first"] as const) {
    it(`keeps each platform's target self-consistent (${order})`, () => {
      const fm = dualFleet(order);

      expect(fm.fleetNoticeTarget("telegram"),
        "a Telegram group must never carry a Discord channel as its thread")
        .toEqual({ chatId: "-100777", opts: { threadId: "9" } });
      expect(fm.fleetNoticeTarget("discord"))
        .toEqual({ chatId: "guild-1", opts: { threadId: "dc-channel" } });
    });
  }
});

/**
 * B2: both schedule notices must route by the chat they post into, and neither
 * may fall back to the target's adapter — that fallback IS the misroute.
 */
describe("schedule notices route to the source chat", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "agend-sched2-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function makeFleet(instances: Record<string, any> = {}) {
    const fm = new FleetManager(dir) as any;
    const channels = [
      { id: "discord", type: "discord", mode: "topic", group_id: "guild-1" },
      { id: "grok-persona", type: "discord", mode: "topic", group_id: "guild-1" },
      { id: "telegram", type: "telegram", mode: "topic", group_id: "-100777" },
    ];
    fm.fleetConfig = { defaults: {}, channels, instances: { worker: { topic_id: "chan-x" }, ...instances } };
    for (const cfg of channels) {
      fm.worlds.set(cfg.id, { id: cfg.id, adapter: { id: cfg.id, sendText: vi.fn().mockResolvedValue({}) }, channelConfig: cfg, groupId: String(cfg.group_id) });
    }
    fm.adapter = fm.worlds.get("discord").adapter;
    return fm;
  }
  const sent = (fm: any, id: string) => fm.worlds.get(id).adapter.sendText;

  const base = { id: "s1", label: "nightly", source: "tg-maker", target: "worker",
    reply_chat_id: "-100777", reply_thread_id: "245" } as any;

  it("sends a FAILURE notice through the source platform, not the target's", () => {
    // Previously notifyScheduleFailure used the target adapter outright, so a
    // Telegram-created schedule announced its failure through the Discord bot.
    const fm = makeFleet();

    fm.notifyScheduleFailure(base);

    expect(sent(fm, "telegram")).toHaveBeenCalledTimes(1);
    expect(sent(fm, "discord"), "the target's bot cannot reach that chat").not.toHaveBeenCalled();
  });

  it("does not fall back to the target adapter when the source chat is unknown", () => {
    const fm = makeFleet();
    const warn = vi.spyOn(fm.logger, "warn");
    const orphan = { ...base, reply_chat_id: "chat-nobody-owns" };

    fm.notifySourceTopic(orphan);
    fm.notifyScheduleFailure(orphan);

    for (const id of ["discord", "grok-persona", "telegram"]) {
      expect(sent(fm, id), `${id} must not be used as a fallback`).not.toHaveBeenCalled();
    }
    expect(warn.mock.calls.filter(c => String(c[1] ?? "").includes("No adapter can reach")).length).toBe(2);
  });

  it("a Classic source bound to a persona answers as that persona, not the primary", () => {
    // sol's ruling: Classic keeps its own adapter identity. The primary may not
    // even have access to that channel, and would be the wrong voice if it did.
    const fm = makeFleet({ "classic-persona-maker": { channel_id: "grok-persona" } });
    const schedule = { ...base, source: "classic-persona-maker", reply_chat_id: "guild-1", reply_thread_id: "chan-p" };

    fm.notifySourceTopic(schedule);

    expect(sent(fm, "grok-persona"), "the persona created it and must answer").toHaveBeenCalledTimes(1);
    expect(sent(fm, "discord"), "the primary must not speak for it").not.toHaveBeenCalled();
  });
});
