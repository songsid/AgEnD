/**
 * delete_instance deletes the agent's own topic by default (user decision, beta.9), through the agent's OWN bot, and
 * says what the platform answered: topic_deleted is true only when the deletion went through, otherwise topic_reason.
 * The General topic and a shared topic are never deleted; a topic that cannot go never fails the agent's deletion.
 *
 * Real FleetManager + InstanceLifecycle.handleDelete + removeInstanceAndTopic; stub adapters (no Telegram/Discord
 * call); only the instance removal itself (stop, config, cleanup) is stubbed, and it records the order.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FleetManager } from "../src/fleet-manager.js";
import { describeTopicDeleteError, planInstanceTopicDelete, topicFields } from "../src/instance-topic-delete.js";
import { TopicCommands } from "../src/topic-commands.js";
import { DiscordAdapter } from "../src/channel/adapters/discord.js";
import { EventEmitter } from "node:events";
import { handleSettingsRequest } from "../src/settings-api.js";
import { t } from "../src/locale.js";

const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function adapter(id: string, type: "telegram" | "discord") {
  return { id, type, deleteTopic: vi.fn(async (_topicId: number | string) => {}) };
}

/** A Telegram bot (the primary) and a Discord bot; "worker" lives on Discord, "helper" on Telegram. */
function rig() {
  const dir = mkdtempSync(join(tmpdir(), "agend-del-topic-")); dirs.push(dir);
  const fm = new FleetManager(dir);
  const tg = adapter("tg-main", "telegram"), dc = adapter("dc-main", "discord");
  fm.fleetConfig = {
    defaults: {},
    channels: [
      { id: "tg-main", type: "telegram", mode: "topic", group_id: "-100123", bot_token_env: "TG_TOKEN" },
      { id: "dc-main", type: "discord", mode: "topic", group_id: "g1", bot_token_env: "DC_TOKEN" },
    ],
    instances: {
      general: { general_topic: true, topic_id: 1, working_directory: dir, channel_id: "tg-main" },
      helper: { topic_id: 77, working_directory: dir, channel_id: "tg-main" },
      worker: { topic_id: "998877", working_directory: dir, channel_id: "dc-main" },
    },
  } as any;
  fm.adapter = tg as any;
  fm.worlds.set("tg-main", { id: "tg-main", adapter: tg, groupId: "-100123", channelConfig: fm.fleetConfig!.channels![0] } as any);
  fm.worlds.set("dc-main", { id: "dc-main", adapter: dc, groupId: "g1", channelConfig: fm.fleetConfig!.channels![1] } as any);
  const order: string[] = [];
  const removed = vi.spyOn(fm, "removeInstance").mockImplementation(async (name: string) => {
    order.push(`removed ${name}`);
    delete fm.fleetConfig!.instances[name];                        // the entry goes with the removal, as in production
  });
  for (const a of [tg, dc]) a.deleteTopic.mockImplementation(async (id) => { order.push(`${a.id} deleteTopic ${id}`); });
  const del = (args: Record<string, unknown>) => new Promise<{ result: any; error?: string }>(resolve =>
    fm.lifecycle.handleDelete(args as never, (result, error) => resolve({ result, error })));
  return { fm, tg, dc, removed, order, del };
}

describe("delete_instance's topic (beta.9)", () => {
  it("by default the topic is deleted — through the agent's own bot (Discord here), never the primary (Telegram)", async () => {
    const { tg, dc, order, del } = rig();
    const { result } = await del({ name: "worker" });
    expect(result).toEqual({ success: true, name: "worker", topic_deleted: true });
    expect(dc.deleteTopic).toHaveBeenCalledExactlyOnceWith("998877");
    expect(tg.deleteTopic).not.toHaveBeenCalled();
    expect(order).toEqual(["removed worker", "dc-main deleteTopic 998877"]);      // planned before, deleted after the removal
  });

  it("the Telegram agent's topic goes through the Telegram bot", async () => {
    const { tg, dc, del } = rig();
    expect((await del({ name: "helper" })).result).toEqual({ success: true, name: "helper", topic_deleted: true });
    expect(tg.deleteTopic).toHaveBeenCalledExactlyOnceWith(77);
    expect(dc.deleteTopic).not.toHaveBeenCalled();
  });

  it("delete_topic: false keeps the topic, and says so", async () => {
    const { tg, dc, removed, del } = rig();
    const { result } = await del({ name: "worker", delete_topic: false });
    expect(result).toEqual({ success: true, name: "worker", topic_deleted: false, topic_reason: "kept (delete_topic: false)" });
    expect(removed).toHaveBeenCalledOnce();
    expect(dc.deleteTopic).not.toHaveBeenCalled();
    expect(tg.deleteTopic).not.toHaveBeenCalled();
  });

  it("a refusal is reported with its reason — the agent is deleted all the same (Telegram without Manage Topics)", async () => {
    const { tg, removed, del } = rig();
    tg.deleteTopic.mockRejectedValueOnce(Object.assign(new Error("Call to 'deleteForumTopic' failed!"),
      { description: "Bad Request: not enough rights to manage topics", error_code: 400 }));
    const { result, error } = await del({ name: "helper" });
    expect(error).toBeUndefined();
    expect(result).toEqual({ success: true, name: "helper", topic_deleted: false, topic_reason: "the Telegram bot lacks the Manage Topics admin right" });
    expect(removed).toHaveBeenCalledOnce();
  });

  it("the agent's bot is gone: nothing is deleted through another bot", async () => {
    const { fm, tg, dc, del } = rig();
    fm.worlds.delete("dc-main");
    const { result } = await del({ name: "worker" });
    expect(result.topic_deleted).toBe(false);
    expect(result.topic_reason).toMatch(/bot is not connected/);
    expect(tg.deleteTopic).not.toHaveBeenCalled();
    expect(dc.deleteTopic).not.toHaveBeenCalled();
  });

  it("the General topic is refused: General itself, an agent on Telegram's topic 1, and an agent sharing General's topic", async () => {
    const { fm, tg, del } = rig();
    expect((await del({ name: "general" })).error).toBe("Cannot delete the General instance");
    fm.fleetConfig!.instances.root = { topic_id: 1, working_directory: "/tmp", channel_id: "tg-main" } as any;
    expect((await del({ name: "root" })).result).toMatchObject({ topic_deleted: false, topic_reason: "the General topic is never deleted" });
    expect(tg.deleteTopic).not.toHaveBeenCalled();
  });

  it("Telegram's topic 1 is refused on its own (no other agent configured on it)", async () => {
    const { fm, tg, del } = rig();
    delete fm.fleetConfig!.instances.general;                       // the shared-topic guard has nothing to match
    fm.fleetConfig!.instances.root = { topic_id: 1, working_directory: "/tmp", channel_id: "tg-main" } as any;
    expect((await del({ name: "root" })).result).toMatchObject({ topic_deleted: false, topic_reason: "the General topic is never deleted" });
    expect(tg.deleteTopic).not.toHaveBeenCalled();
  });

  it("a topic another agent of the same bot uses is kept", async () => {
    const { fm, tg, del } = rig();
    fm.fleetConfig!.instances.twin = { topic_id: 77, working_directory: "/tmp", channel_id: "tg-main" } as any;
    expect((await del({ name: "helper" })).result).toMatchObject({ topic_deleted: false, topic_reason: "the topic is also used by twin" });
    expect(tg.deleteTopic).not.toHaveBeenCalled();
  });

  it("the removal itself failing leaves the topic alone", async () => {
    const { fm, removed, dc } = rig();
    removed.mockRejectedValueOnce(new Error("stop failed"));
    // handleDelete rejects (its caller answers the tool with the error), as before.
    await expect(fm.lifecycle.handleDelete({ name: "worker" } as never, () => {})).rejects.toThrow("stop failed");
    expect(dc.deleteTopic).not.toHaveBeenCalled();
  });
});

describe("the reasons (describeTopicDeleteError)", () => {
  it("Telegram", () => {
    const tg = (description: string) => describeTopicDeleteError("telegram", { description });
    expect(tg("Bad Request: not enough rights to manage topics")).toBe("the Telegram bot lacks the Manage Topics admin right");
    expect(tg("Bad Request: CHAT_ADMIN_REQUIRED")).toBe("the Telegram bot lacks the Manage Topics admin right");
    expect(tg("Bad Request: TOPIC_ID_INVALID")).toBe("topic not found");
    expect(tg("Bad Request: the chat is not a forum")).toBe("the group is not a forum");
    expect(describeTopicDeleteError("telegram", new Error("the General topic is never deleted"))).toBe("the General topic is never deleted");
    expect(tg("Bad Request: something new")).toBe("the telegram API refused: Bad Request: something new");
  });
  it("Discord", () => {
    expect(describeTopicDeleteError("discord", Object.assign(new Error("Missing Permissions"), { code: 50013 }))).toBe("the Discord bot lacks the Manage Channels permission");
    expect(describeTopicDeleteError("discord", Object.assign(new Error("Unknown Channel"), { code: 10003 }))).toBe("topic not found");
  });
});

describe("the plan and the dashboard's answer", () => {
  const instances = { a: { topic_id: 5, working_directory: "/tmp" } } as any;
  it("an agent without a fleet.yaml entry (a ClassicBot room) has no topic of its own here", () => {
    expect(planInstanceTopicDelete({ name: "room", instances, adapterId: "x", adapter: adapter("x", "telegram") as any,
      destinationOf: () => null, generalDestinations: () => new Set() }))
      .toEqual({ kind: "keep", reason: "the agent has no topic of its own (not a fleet.yaml agent)" });
  });
  it("topicFields: the line the dashboard shows", () => {
    expect(topicFields("w", null)).toEqual({});
    expect(topicFields("w", { deleted: true })).toEqual({ topic_deleted: true, topic_note: t("instance.topic_deleted", "w") });
    expect(topicFields("w", { deleted: false, reason: "topic not found" }))
      .toEqual({ topic_deleted: false, topic_reason: "topic not found", topic_note: t("instance.topic_kept", "w", "topic not found") });
  });
});

describe("#3055 review (Prism): ownership by physical destination, every General, and the fleet as it is at the platform call", () => {
  /** A second Telegram bot, in the SAME group as the first. */
  function addSecondTelegramBot(r: ReturnType<typeof rig>, groupId = "-100123") {
    const tg2 = adapter("tg-two", "telegram");
    r.fm.fleetConfig!.channels!.push({ id: "tg-two", type: "telegram", mode: "topic", group_id: groupId, bot_token_env: "TG2" } as any);
    r.fm.worlds.set("tg-two", { id: "tg-two", adapter: tg2, groupId, channelConfig: r.fm.fleetConfig!.channels![2] } as any);
    return tg2;
  }

  it("P1-1: two bots in one Telegram group share topic 77 — deleting one agent keeps the other's topic", async () => {
    const r = rig(); const tg2 = addSecondTelegramBot(r);
    r.fm.fleetConfig!.instances.twin = { topic_id: 77, working_directory: "/tmp", channel_id: "tg-two" } as any;
    expect((await r.del({ name: "helper" })).result).toMatchObject({ topic_deleted: false, topic_reason: "the topic is also used by twin" });
    expect(r.tg.deleteTopic).not.toHaveBeenCalled();
    expect(tg2.deleteTopic).not.toHaveBeenCalled();
  });

  it("P1-1 control: the same topic number in ANOTHER group is another topic — deleted", async () => {
    const r = rig(); addSecondTelegramBot(r, "-100999");
    r.fm.fleetConfig!.instances.twin = { topic_id: 77, working_directory: "/tmp", channel_id: "tg-two" } as any;
    expect((await r.del({ name: "helper" })).result).toEqual({ success: true, name: "helper", topic_deleted: true });
    expect(r.tg.deleteTopic).toHaveBeenCalledExactlyOnceWith(77);
  });

  it("P1-2: a secondary Discord connection's configured General channel is refused, with no General agent on it", async () => {
    const r = rig();
    (r.fm.fleetConfig!.channels![1] as any).options = { general_channel_id: "998877" };   // worker's channel IS that General
    expect((await r.del({ name: "worker" })).result).toMatchObject({ topic_deleted: false, topic_reason: "the General topic is never deleted" });
    expect(r.dc.deleteTopic).not.toHaveBeenCalled();
  });

  it("P1-2: the Discord adapter itself refuses its General channel — before fetching anything", async () => {
    const fetch = vi.fn();
    const self = { generalChannelId: "555555555555555555", readyClient: async () => ({ channels: { fetch } }) };
    await expect(DiscordAdapter.prototype.deleteTopic.call(self as never, "555555555555555555")).rejects.toThrow("the General topic is never deleted");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("P1-3: an agent bound to the topic while the removal was awaited keeps it (the plan is re-checked at the platform call)", async () => {
    const r = rig();
    r.removed.mockImplementationOnce(async (name: string) => {
      delete r.fm.fleetConfig!.instances[name];
      r.fm.fleetConfig!.instances.newcomer = { topic_id: "998877", working_directory: "/tmp", channel_id: "dc-main" } as any;
    });
    expect((await r.del({ name: "worker" })).result).toMatchObject({ topic_deleted: false, topic_reason: "the topic is also used by newcomer" });
    expect(r.dc.deleteTopic).not.toHaveBeenCalled();
  });

  it("P1-3: the bot rebuilt while the removal was awaited — the old adapter is not used", async () => {
    const r = rig(); const rebuilt = adapter("dc-main", "discord");
    r.removed.mockImplementationOnce(async (name: string) => {
      delete r.fm.fleetConfig!.instances[name];
      r.fm.worlds.set("dc-main", { id: "dc-main", adapter: rebuilt, groupId: "g1", channelConfig: r.fm.fleetConfig!.channels![1] } as any);
    });
    expect((await r.del({ name: "worker" })).result).toMatchObject({ topic_deleted: false, topic_reason: expect.stringContaining("bot changed") });
    expect(r.dc.deleteTopic).not.toHaveBeenCalled();
    expect(rebuilt.deleteTopic).not.toHaveBeenCalled();
  });

  it("P1-3: while the platform call runs, binding that topic is refused; afterwards it is free again", async () => {
    const r = rig();
    let release!: () => void, during = false;
    r.dc.deleteTopic.mockImplementationOnce(() => new Promise<void>(res => { during = r.fm.isTopicDeletionInFlight("998877"); release = res; }));
    const pending = r.del({ name: "worker" });
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    expect(during).toBe(true);
    const bind = new TopicCommands({ fleetConfig: r.fm.fleetConfig, isTopicDeletionInFlight: (id: string) => r.fm.isTopicDeletionInFlight(id) } as any);
    await expect(bind.bindAndStart("/tmp/x", "998877")).rejects.toThrow("being deleted");
    release();
    expect((await pending).result.topic_deleted).toBe(true);
    expect(r.fm.isTopicDeletionInFlight("998877")).toBe(false);
  });
});

describe("#3055 review r2 (Prism P1-3): every binding door is held while the platform call runs; a same-name replacement is an owner", () => {
  /** Run worker's deletion with the Discord call held; returns the release and the pending result. */
  async function heldDeletion(r: ReturnType<typeof rig>) {
    let release!: () => void;
    r.dc.deleteTopic.mockImplementationOnce(() => new Promise<void>(res => { release = res; }));
    const pending = r.del({ name: "worker" });
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    return { release: () => release(), pending };
  }
  /** The real Settings handler, admitted (no gateway context), on the rig's fleet. */
  function settingsPatch(r: ReturnType<typeof rig>, name: string, body: unknown) {
    const save = vi.fn();
    const ctx: any = { fleetConfig: r.fm.fleetConfig, dataDir: dirs.at(-1)!, webToken: "t".repeat(48), webSessions: undefined,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, getRawFleetConfig: () => r.fm.fleetConfig, saveFleetConfig: save,
      lifecycle: { isPaused: () => false, pause: vi.fn(), wake: vi.fn() },
      topicBindingInFlight: (inst: any) => r.fm.topicBindingInFlight(inst) };
    return new Promise<{ status: number; body: any; saved: number }>((resolve) => {
      const req: any = new EventEmitter(); req.method = "PATCH"; req.url = `/api/settings/fleet/instances/${name}`; req.headers = {}; req.destroy = vi.fn();
      const res: any = { destroyed: false, headersSent: false, setHeader: vi.fn(), once: vi.fn(), writeHead(status: number) { this.status = status; this.headersSent = true; },
        end(text: string) { resolve({ status: this.status, body: JSON.parse(text), saved: save.mock.calls.length }); } };
      expect(handleSettingsRequest(req, res, new URL(req.url, "http://localhost"), ctx)).toBe(true);
      queueMicrotask(() => { req.emit("data", Buffer.from(JSON.stringify(body))); req.emit("end"); });
    });
  }

  it("Settings: binding another agent to the topic being deleted is refused (409), nothing saved; the deletion finishes", async () => {
    const r = rig();
    r.fm.fleetConfig!.instances.keeper = { topic_id: 5, working_directory: "/tmp", channel_id: "dc-main" } as any;
    const held = await heldDeletion(r);
    const patched = await settingsPatch(r, "keeper", { topic_id: "998877" });
    expect([patched.status, patched.body.error, patched.saved]).toEqual([409, "topic_deletion_in_flight", 0]);
    expect(r.fm.fleetConfig!.instances.keeper.topic_id).toBe(5);
    held.release();
    expect((await held.pending).result.topic_deleted).toBe(true);
    expect((await settingsPatch(r, "keeper", { topic_id: "998877" })).status).toBe(200);    // over: free again
  });

  it("Settings control: the same thread number in ANOTHER Telegram group is not held", async () => {
    const r = rig();
    const tg2 = adapter("tg-two", "telegram");
    r.fm.fleetConfig!.channels!.push({ id: "tg-two", type: "telegram", mode: "topic", group_id: "-100999", bot_token_env: "TG2" } as any);
    r.fm.worlds.set("tg-two", { id: "tg-two", adapter: tg2, groupId: "-100999", channelConfig: r.fm.fleetConfig!.channels![2] } as any);
    let release!: () => void;
    r.tg.deleteTopic.mockImplementationOnce(() => new Promise<void>(res => { release = res; }));
    const pending = r.del({ name: "helper" });                        // topic 77 in -100123, being deleted
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    expect(r.fm.topicBindingInFlight({ channel_id: "tg-main", topic_id: 77 })).toBe(true);
    expect(r.fm.topicBindingInFlight({ channel_id: "tg-two", topic_id: 77 })).toBe(false);
    r.fm.fleetConfig!.instances.other = { topic_id: 3, working_directory: "/tmp", channel_id: "tg-two" } as any;
    expect((await settingsPatch(r, "other", { topic_id: 77 })).status).toBe(200);
    release(); await pending;
  });

  it("a connection is not re-pointed (verified rebind) while one of its topics is being deleted; nothing is rebuilt", async () => {
    const r = rig();
    const rebuild = vi.spyOn(r.fm as any, "rebuildAdapterForBinding").mockResolvedValue(undefined);
    const held = await heldDeletion(r);
    const job: any = { connectionId: "dc-main", id: "j1", status: "running" };
    await (r.fm as any).runConnectionBindingApply(job, { group_id: "g2" });
    expect([job.result, rebuild.mock.calls.length]).toEqual(["rolled_back", 0]);
    held.release(); await held.pending;
    const after: any = { connectionId: "dc-main", id: "j2", status: "running" };
    await (r.fm as any).runConnectionBindingApply(after, { group_id: "g2" });
    expect([after.result, rebuild.mock.calls.length]).toEqual(["applied", 1]);
  });

  it("a replacement under the SAME name, bound to the topic while the removal was awaited, keeps it", async () => {
    const r = rig();
    r.removed.mockImplementationOnce(async (name: string) => {
      delete r.fm.fleetConfig!.instances[name];
      r.fm.fleetConfig!.instances.worker = { topic_id: "998877", working_directory: "/tmp", channel_id: "dc-main" } as any;
    });
    expect((await r.del({ name: "worker" })).result).toMatchObject({ topic_deleted: false, topic_reason: "the topic is also used by worker" });
    expect(r.dc.deleteTopic).not.toHaveBeenCalled();
  });
});
