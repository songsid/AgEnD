import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from "vitest";
import { FleetManager } from "../src/fleet-manager.js";
import { AccessManager } from "../src/channel/access-manager.js";
import { join } from "node:path";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import type { ChannelAdapter } from "../src/channel/types.js";

/** The members of FleetManager this test reaches into, named once. */
type Internals = {
  collabInstances: Set<string>;
  topicCommands: {
    handleInstanceCommand: (...args: unknown[]) => Promise<boolean>;
    handleGeneralCommand: (...args: unknown[]) => Promise<boolean>;
  };
  sendCancelButton: (...args: unknown[]) => Promise<void>;
  handleInboundMessage: (msg: unknown) => Promise<void>;
};

/**
 * A bot message crosses two gates, and they are not the same gate.
 *
 * `botMessageDropReason` decides whether this adapter's copy is dropped before
 * the dedup claim; it lets the copy through when the adapter is open OR collab
 * is on for the instance. Access control runs next, and there the two arms part
 * company: an open adapter admits outright, while a locked one still requires
 * the sender on its allowlist.
 *
 * So collab on a locked adapter does not admit a bot — it only declines to drop
 * the copy, and the refusal happens a few lines later under a different message.
 * The comment used to say "allow if collab enabled OR access mode is open",
 * which reads as though the two were equivalent. These tests hold the real
 * behaviour so the comment cannot drift back.
 */
describe("bot messages: the collab gate and the access gate are different gates", () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = join(tmpdir(), `ccd-collab-${Date.now()}-${Math.random()}`); mkdirSync(tmpDir, { recursive: true }); });
  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  const OPEN = { mode: "open" as const, allowed_users: [] as string[], max_pending_codes: 5, code_expiry_minutes: 10 };
  const LOCKED = { mode: "locked" as const, allowed_users: [] as string[], max_pending_codes: 5, code_expiry_minutes: 10 };

  function setup(access: typeof OPEN | typeof LOCKED, opts: { collab?: boolean } = {}) {
    const fm = new FleetManager(tmpDir);
    const adapter = {
      id: "discord", type: "discord",
      react: vi.fn().mockResolvedValue(undefined),
      sendText: vi.fn().mockResolvedValue({ messageId: "m", chatId: "guild" }),
    } as unknown as ChannelAdapter;
    const channelConfig = { id: "discord", type: "discord", mode: "topic", group_id: "guild", access };
    fm.fleetConfig = {
      defaults: {}, channels: [channelConfig],
      instances: { worker: { working_directory: tmpDir, topic_id: "topic-1" } },
      // A minimal config: one channel, one instance bound to one topic. Widened
      // through `unknown` because it states only the fields these gates read.
    } as unknown as FleetManager["fleetConfig"];
    fm.adapter = adapter;
    fm.worlds.set("discord", {
      id: "discord", adapter, channelConfig, groupId: "guild",
      accessManager: new AccessManager(access, join(tmpDir, "access.json")),
    } as unknown as Parameters<typeof fm.worlds.set>[1]);
    fm.routing.rebuild(fm.fleetConfig!);
    const internals = fm as unknown as Internals;
    if (opts.collab) internals.collabInstances.add("worker");

    vi.spyOn(internals.topicCommands, "handleInstanceCommand").mockResolvedValue(false);
    vi.spyOn(internals.topicCommands, "handleGeneralCommand").mockResolvedValue(false);
    vi.spyOn(internals, "sendCancelButton").mockResolvedValue(undefined);
    const deliver = vi.spyOn(fm, "deliverToInstance").mockResolvedValue(undefined);
    const debug = vi.spyOn(fm.logger, "debug");
    const info = vi.spyOn(fm.logger, "info");
    return { fm, deliver, debug, info };
  }

  const botMessage = () => ({
    source: "discord", adapterId: "discord", chatId: "guild", threadId: "topic-1",
    messageId: "bot-1", userId: "bot-777", username: "some-bot",
    text: "posted by a bot", isBotMessage: true, timestamp: new Date(),
  });

  const feed = (fm: FleetManager) =>
    (fm as unknown as Internals).handleInboundMessage(botMessage());

  const logged = (spy: MockInstance, needle: string) =>
    spy.mock.calls.some((c: unknown[]) => String(c[1] ?? "").includes(needle));
  const droppedByFilter = (debug: MockInstance) => logged(debug, "dropped before the dedup claim");

  it("drops the copy at the first gate when the adapter is locked and collab is off", async () => {
    const { fm, deliver, debug } = setup(LOCKED);

    await feed(fm);

    expect(droppedByFilter(debug), "this one never reaches access control").toBe(true);
    expect(deliver).not.toHaveBeenCalled();
  });

  it("passes the first gate with collab on — and is still refused by access control", async () => {
    // The asymmetry the comment used to hide. Collab only declines to drop the
    // copy; the bot's id is not on the locked adapter's allowlist, so the
    // message dies at the next gate, under a different log line entirely.
    const { fm, deliver, debug, info } = setup(LOCKED, { collab: true });

    await feed(fm);

    expect(droppedByFilter(debug), "collab means the filter lets it through").toBe(false);
    expect(logged(info, "Access DENIED"), "and access control is what refuses it").toBe(true);
    expect(deliver, "so it is never delivered").not.toHaveBeenCalled();
  });

  it("is delivered on an open adapter, with no collab needed", async () => {
    // The other arm: open admits at BOTH gates, which is why the two are not
    // interchangeable.
    const { fm, deliver, debug } = setup(OPEN);

    await feed(fm);

    expect(droppedByFilter(debug)).toBe(false);
    expect(deliver, "an open adapter really does admit a bot message").toHaveBeenCalled();
  });
});
