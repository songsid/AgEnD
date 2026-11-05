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
    expect(planInstanceTopicDelete({ name: "room", instances, adapterId: "x", adapter: adapter("x", "telegram") as any, adapterIdOf: () => "x" }))
      .toEqual({ kind: "keep", reason: "the agent has no topic of its own (not a fleet.yaml agent)" });
  });
  it("topicFields: the line the dashboard shows", () => {
    expect(topicFields("w", null)).toEqual({});
    expect(topicFields("w", { deleted: true })).toEqual({ topic_deleted: true, topic_note: t("instance.topic_deleted", "w") });
    expect(topicFields("w", { deleted: false, reason: "topic not found" }))
      .toEqual({ topic_deleted: false, topic_reason: "topic not found", topic_note: t("instance.topic_kept", "w", "topic not found") });
  });
});
