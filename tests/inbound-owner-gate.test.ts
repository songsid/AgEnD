import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { FleetManager } from "../src/fleet-manager.js";
import { AccessManager } from "../src/channel/access-manager.js";
import { join } from "node:path";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

/**
 * A fleet topic is served by one instance, and that instance is answered by one
 * adapter. When several bots share a guild they each receive their own copy of
 * every message, so the adapter that happens to arrive first must not be the one
 * that decides — the instance's own adapter and its own access policy should.
 * #707 established that for bot messages; the same rule belongs on every kind.
 */
describe("inbound messages are settled by the owning adapter", () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = join(tmpdir(), `ccd-og-${Date.now()}-${Math.random()}`); mkdirSync(tmpDir, { recursive: true }); });
  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  const OPEN = { mode: "open" as const, allowed_users: [] as string[] };
  const LOCKED = { mode: "locked" as const, allowed_users: [] as string[] };

  function setup(opts: { primary: any; persona: any; boundTo?: string }) {
    const fm = new FleetManager(tmpDir);
    const mk = (id: string) => ({ id, type: "discord", react: vi.fn().mockResolvedValue(undefined),
      sendText: vi.fn().mockResolvedValue({ messageId: "m", chatId: "guild" }) } as any);
    const cfg = (id: string, access: any) => ({ id, type: "discord", mode: "topic", group_id: "guild", access });
    const primaryCfg = cfg("discord", opts.primary);
    const personaCfg = cfg("grok-persona", opts.persona);
    fm.fleetConfig = { defaults: {}, channels: [primaryCfg, personaCfg],
      instances: { worker: { working_directory: tmpDir, topic_id: "topic-1",
        ...(opts.boundTo ? { channel_id: opts.boundTo } : {}) } } } as any;
    const a1 = mk("discord"), a2 = mk("grok-persona");
    fm.adapter = a1;
    fm.worlds.set("discord", { id: "discord", adapter: a1, channelConfig: primaryCfg, groupId: "guild",
      accessManager: new AccessManager(opts.primary, join(tmpDir, "a1.json")) } as any);
    fm.worlds.set("grok-persona", { id: "grok-persona", adapter: a2, channelConfig: personaCfg, groupId: "guild",
      accessManager: new AccessManager(opts.persona, join(tmpDir, "a2.json")) } as any);
    fm.routing.rebuild(fm.fleetConfig);
    vi.spyOn((fm as any).topicCommands, "handleInstanceCommand").mockResolvedValue(false);
    vi.spyOn((fm as any).topicCommands, "handleGeneralCommand").mockResolvedValue(false);
    vi.spyOn(fm as any, "sendCancelButton").mockResolvedValue(undefined);
    return { fm, deliver: vi.spyOn(fm, "deliverToInstance").mockResolvedValue(undefined) };
  }

  const human = (adapterId: string) => ({
    source: "discord", adapterId, chatId: "guild", threadId: "topic-1",
    messageId: "same-message", userId: "user-1", username: "someone",
    text: "hello", timestamp: new Date(),
  });

  async function feed(fm: FleetManager, order: string[]) {
    for (const id of order) await (fm as any).handleInboundMessage(human(id));
  }

  it("an owner that allows the user is not starved by a stricter sibling", async () => {
    // worker is answered by the persona, which allows this user; channels[0] does not.
    const { fm, deliver } = setup({ primary: LOCKED, persona: OPEN, boundTo: "grok-persona" });
    await feed(fm, ["discord", "grok-persona"]);
    expect(deliver, "the owner allows this user, so it must be delivered").toHaveBeenCalledTimes(1);
  });

  it("delivers identically whichever adapter reports the message first", async () => {
    for (const order of [["discord", "grok-persona"], ["grok-persona", "discord"]]) {
      const { fm, deliver } = setup({ primary: LOCKED, persona: OPEN, boundTo: "grok-persona" });
      await feed(fm, order);
      expect(deliver, `order ${order}`).toHaveBeenCalledTimes(1);
    }
  });

  // An adapter that fails to start — a missing token returns before its world and
  // AccessManager are created — leaves the topic's owner resolvable but its policy
  // unavailable, while sibling bots stay alive and still receive the copy.
  it("refuses when the owner is known but its access policy is unavailable", async () => {
    const { fm, deliver } = setup({ primary: OPEN, persona: LOCKED, boundTo: "grok-persona" });
    fm.worlds.delete("grok-persona");
    await feed(fm, ["discord"]);
    expect(deliver, "an unavailable owner policy must not fall back to a sibling").not.toHaveBeenCalled();
    expect((fm as any).recentMessageIds.size, "and must not consume the key").toBe(0);
  });

  it("refuses when the owner world is missing and there is no fleet-wide manager", async () => {
    const { fm, deliver } = setup({ primary: OPEN, persona: LOCKED, boundTo: "grok-persona" });
    fm.worlds.delete("grok-persona");
    (fm as any).accessManager = null;      // no fleet-wide fallback either
    await feed(fm, ["discord"]);
    expect(deliver, "must not skip access control entirely").not.toHaveBeenCalled();
  });

  it("never substitutes the fleet-wide policy for a resolved owner's", async () => {
    // The owner is running but carries no access policy of its own. The
    // fleet-wide manager belongs to a different adapter, so it must not be
    // borrowed to judge this topic — that is the same substitution as borrowing
    // a sibling's.
    const { fm, deliver } = setup({ primary: OPEN, persona: OPEN, boundTo: "grok-persona" });
    (fm.worlds.get("grok-persona") as any).accessManager = undefined;
    (fm as any).accessManager = new AccessManager(LOCKED, join(tmpDir, "fleetwide.json"));
    await feed(fm, ["discord"]);
    expect(deliver, "the fleet-wide policy must not be applied to an owned topic").toHaveBeenCalledTimes(1);
  });

  it("a refused message does not consume the shared dedup key", async () => {
    // Keeps the ordering invariant structural: only copies that are actually
    // processed claim the key. Without it, a refusal would still consume the key
    // and any later copy would be discarded as a duplicate — which is how a
    // sibling could starve the owner if the verdict ever became adapter-specific
    // again.
    const { fm } = setup({ primary: LOCKED, persona: LOCKED, boundTo: "grok-persona" });
    await feed(fm, ["grok-persona"]);
    expect((fm as any).recentMessageIds.size, "a refused copy must not claim the key").toBe(0);
  });

  it("an accepted message does claim the key, so a sibling copy is not re-processed", async () => {
    const { fm, deliver } = setup({ primary: OPEN, persona: OPEN, boundTo: "grok-persona" });
    await feed(fm, ["grok-persona", "discord"]);
    expect((fm as any).recentMessageIds.size).toBe(1);
    expect(deliver, "exactly once across both copies").toHaveBeenCalledTimes(1);
  });

  it("a permissive sibling does not settle a message for a stricter owner", async () => {
    // worker is answered by the persona, which does NOT allow this user.
    const { fm, deliver } = setup({ primary: OPEN, persona: LOCKED, boundTo: "grok-persona" });
    await feed(fm, ["discord", "grok-persona"]);
    expect(deliver, "the owner's policy governs, so nothing is delivered").not.toHaveBeenCalled();
  });
});
