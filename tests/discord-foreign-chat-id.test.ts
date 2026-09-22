import { describe, expect, it, vi } from "vitest";
import { DiscordAdapter } from "../src/channel/adapters/discord.js";
import { Daemon } from "../src/daemon.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A schedule created in the Telegram world stored that world's reply
 * coordinates and targeted a Discord instance, so the Discord bot was asked for
 * `/channels/245` — a Telegram forum topic. Discord answered 10003 "Unknown
 * Channel", which reads as "that channel is gone" and sent the investigation
 * after the gateway and the channel cache instead of the routing.
 *
 * The routing fix is upstream (fleet-manager stops seeding a foreign world's
 * coordinates). This is the net under it: say what is actually wrong, at the
 * point of the send, for any id that is positively another platform's.
 */
function adapter() {
  const fetch = vi.fn();
  const a = new DiscordAdapter({
    id: "discord",
    botToken: "t",
    accessManager: { canRead: () => true, canWrite: () => true } as any,
    inboxDir: mkdtempSync(join(tmpdir(), "agend-discord-foreign-")),
    guildId: "1496407196106494055",
    registerCommands: false,
    clientFactory: () => ({ isReady: () => true, channels: { fetch }, on: () => {}, once: () => {} }) as any,
  } as any);
  return { a: a as any, fetch };
}

describe("Discord adapter rejects another world's chat id", () => {
  it("names a Telegram forum topic instead of asking Discord for it", async () => {
    const { a, fetch } = adapter();
    await expect(a.sendText("245", "hi")).rejects.toThrow(/Telegram chat or forum topic id/);
    expect(fetch, "no point asking Discord about an id that cannot be its own").not.toHaveBeenCalled();
  });

  it("names a Telegram group id (negative)", async () => {
    const { a, fetch } = adapter();
    await expect(a.sendText("-1003833855730", "hi")).rejects.toThrow(/Telegram group id/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("catches it on the thread id too, which is what actually failed live", async () => {
    const { a, fetch } = adapter();
    // The live shape: a real guild id paired with a Telegram topic as thread.
    await expect(a.sendText("1496407196106494055", "hi", { threadId: "245" } as any))
      .rejects.toThrow(/245/);
    expect(fetch).not.toHaveBeenCalled();
  });

  // Only a POSITIVE identification may reject. A non-numeric id proves nothing
  // about which world it came from, and rejecting those would change this
  // adapter's contract for ids that reach Discord correctly today.
  it("passes a normal snowflake through to Discord", async () => {
    const { a, fetch } = adapter();
    fetch.mockResolvedValue({ isTextBased: () => true, send: vi.fn().mockResolvedValue({ id: "m1" }) });
    await a.sendText("1503382159321464899", "hi");
    expect(fetch).toHaveBeenCalledWith("1503382159321464899");
  });

  it("does not reject a non-numeric id it cannot attribute", async () => {
    const { a, fetch } = adapter();
    fetch.mockResolvedValue({ isTextBased: () => true, send: vi.fn().mockResolvedValue({ id: "m1" }) });
    await a.sendText("some-classic-channel", "hi");
    expect(fetch).toHaveBeenCalledWith("some-classic-channel");
  });
});

/**
 * The daemon half of the same hazard. A chat context and the adapter that can
 * address it are a pair; the daemon stores them separately and inbound meta
 * does not always carry an adapter id. Keeping the previous adapter alongside a
 * NEW chat asserts a pairing nobody supplied — which is how one platform's chat
 * id ends up addressed by another platform's bot.
 */
describe("daemon keeps chat context and its adapter paired", () => {
  function daemon() {
    const dir = mkdtempSync(join(tmpdir(), "agend-lastchat-"));
    return new Daemon("lastchat-test", {
      working_directory: "/tmp",
      restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
      context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 },
      log_level: "silent",
    } as any, dir, false, undefined, undefined, { child: () => ({ debug() {}, info() {}, warn() {}, error() {} }) } as any) as any;
  }

  /** pushChannelMessage returns early without a pane; it only needs to exist. */
  function withPane(d: any) {
    d.tmux = { pasteBuffer: async () => true, sendSpecialKey: async () => true, capturePane: async () => "" };
    return d;
  }

  it("drops a stale adapter when a new chat arrives without one", () => {
    const d = withPane(daemon());
    d.pushChannelMessage("first", { chat_id: "-1003833855730", thread_id: "245", adapter_id: "telegram", user: "u" });
    expect(d.lastAdapterId).toBe("telegram");

    // A different chat, no adapter named: the telegram binding is not evidence
    // about this one.
    d.pushChannelMessage("second", { chat_id: "1496407196106494055", thread_id: "1503382159321464899", user: "u" });
    expect(d.lastChatId).toBe("1496407196106494055");
    expect(d.lastAdapterId, "an unproven pairing must not be carried over").toBeUndefined();
  });

  it("keeps the adapter when the same chat speaks again without naming one", () => {
    const d = withPane(daemon());
    d.pushChannelMessage("first", { chat_id: "1496407196106494055", adapter_id: "discord", user: "u" });
    d.pushChannelMessage("again", { chat_id: "1496407196106494055", user: "u" });
    expect(d.lastAdapterId, "same chat — the binding still holds").toBe("discord");
  });

  it("carries the bound adapter into schedule creation IPC metadata", () => {
    const d = daemon();
    const socket = {} as any;
    const broadcasts: any[] = [];
    d.socketSessionNames.set(socket, d.name);
    d.lastChatId = "guild-1";
    d.lastThreadId = "channel-1";
    d.lastAdapterId = "persona-discord";
    d.ipcServer = {
      broadcast: vi.fn((message: any) => {
        broadcasts.push(message);
        // Complete the request so the production timeout does not keep this
        // test alive and the response path is exercised too.
        d.pendingIpcRequests.get(message.fleetRequestId)?.({ result: "ok" });
      }),
      send: vi.fn(),
    };

    d.handleToolCall({
      tool: "create_schedule",
      requestId: 1,
      args: { cron: "0 9 * * *", message: "ping" },
    }, socket);

    expect(broadcasts[0]).toMatchObject({
      type: "fleet_schedule_create",
      meta: {
        chat_id: "guild-1",
        thread_id: "channel-1",
        adapter_id: "persona-discord",
      },
    });
  });
});
