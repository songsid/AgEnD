import { describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FleetManager } from "../src/fleet-manager.js";
import { TELEGRAM_ALLOWED_UPDATES } from "../src/channel/adapters/telegram.js";
import type { InboundReaction } from "../src/channel/types.js";

// #408: AgEnD could send reactions but never receive them. Reactions arrive as
// adapter `reaction` events and are delivered as ordinary inbound messages, so they
// reuse routing, dedup, the idle gate and delivery confirmation.

const reaction = (over: Partial<InboundReaction> = {}): InboundReaction => ({
  source: "discord",
  adapterId: "discord",
  chatId: "guild-1",
  threadId: "chan-1",
  messageId: "msg-99",
  userId: "user-7",
  username: "hanhanv",
  emoji: "👍",
  action: "add",
  timestamp: new Date("2026-08-01T00:00:00Z"),
  ...over,
});

// `routed` is required rather than defaulted: passing `undefined` to a defaulted
// parameter re-applies the default, which silently made the unrouted case route.
function makeFleet(routed: string | null = "alpha") {
  const fm = new FleetManager(mkdtempSync(join(tmpdir(), "agend-react-")));
  const deliver = vi.fn().mockResolvedValue(undefined);
  const internals = fm as unknown as {
    resolveSlashTarget(channelId: string, adapterId?: string): string | undefined;
    deliverToInstance(name: string, payload: Record<string, unknown>): Promise<void>;
    eventLog: unknown;
    handleInboundReaction(r: InboundReaction): Promise<void>;
  };
  internals.resolveSlashTarget = () => routed ?? undefined;
  internals.deliverToInstance = deliver;
  internals.eventLog = { logActivity: vi.fn(), insert: vi.fn() };
  return { internals, deliver };
}

describe("handleInboundReaction", () => {
  it("delivers an approval reaction to the routed instance", async () => {
    const { internals, deliver } = makeFleet();
    await internals.handleInboundReaction(reaction());

    expect(deliver).toHaveBeenCalledOnce();
    const [name, payload] = deliver.mock.calls[0] as [string, Record<string, unknown>];
    expect(name).toBe("alpha");
    expect(payload.type).toBe("fleet_inbound");
    expect(payload.content).toContain("[reaction:👍]");
    expect(payload.content).toContain("hanhanv");
    // The agent must be able to tell WHICH of its messages was reacted to.
    expect(payload.content).toContain("msg-99");
  });

  it("carries message_id in meta so react/edit_message can target it", async () => {
    const { internals, deliver } = makeFleet();
    await internals.handleInboundReaction(reaction());
    const meta = (deliver.mock.calls[0][1] as { meta: Record<string, string> }).meta;
    expect(meta.message_id).toBe("msg-99");
    expect(meta.requires_reply).toBe("false");
  });

  it("never sets chat_id, so a reaction cannot become the agent's reply target", async () => {
    // A reaction is not a chat message; letting it overwrite lastChatId would send
    // the next reply into the wrong place.
    const { internals, deliver } = makeFleet();
    await internals.handleInboundReaction(reaction());
    const meta = (deliver.mock.calls[0][1] as { meta: Record<string, string> }).meta;
    expect(meta.chat_id).toBe("");
    expect(meta.thread_id).toBe("");
  });

  it("wakes a paused instance only for approval emojis", async () => {
    const approval = makeFleet();
    await approval.internals.handleInboundReaction(reaction({ emoji: "👍" }));
    expect((approval.deliver.mock.calls[0][1] as { meta: Record<string, string> }).meta.no_wake).toBeUndefined();

    const thumbsDown = makeFleet();
    await thumbsDown.internals.handleInboundReaction(reaction({ emoji: "👎" }));
    expect((thumbsDown.deliver.mock.calls[0][1] as { meta: Record<string, string> }).meta.no_wake).toBeUndefined();
  });

  it("marks every other emoji no_wake, so chatter cannot cost a turn", async () => {
    for (const emoji of ["🎉", "❤️", "😂", "eyes"]) {
      const { internals, deliver } = makeFleet();
      await internals.handleInboundReaction(reaction({ emoji }));
      const meta = (deliver.mock.calls[0][1] as { meta: Record<string, string> }).meta;
      expect(meta.no_wake, emoji).toBe("true");
    }
  });

  it("reports a removed reaction distinctly from an added one", async () => {
    const { internals, deliver } = makeFleet();
    await internals.handleInboundReaction(reaction({ action: "remove" }));
    expect(deliver.mock.calls[0][1].content).toContain("removed their reaction");
  });

  it("ignores a reaction in an unrouted channel", async () => {
    const { internals, deliver } = makeFleet(null);
    await internals.handleInboundReaction(reaction());
    expect(deliver).not.toHaveBeenCalled();
  });

  it("swallows a delivery failure — a reaction is not worth an error", async () => {
    const { internals } = makeFleet();
    (internals as unknown as { deliverToInstance: unknown }).deliverToInstance =
      vi.fn().mockRejectedValue(new Error("ipc gone"));
    await expect(internals.handleInboundReaction(reaction())).resolves.toBeUndefined();
  });
});

describe("Telegram allowed_updates", () => {
  it("includes message_reaction, which is absent from Telegram's default set", () => {
    expect(TELEGRAM_ALLOWED_UPDATES).toContain("message_reaction");
  });

  it("still lists every update type the adapter handles", () => {
    // Passing allowed_updates FREEZES the set: anything omitted silently stops
    // arriving. These are the types with live bot.on() handlers.
    expect(TELEGRAM_ALLOWED_UPDATES).toContain("message");
    expect(TELEGRAM_ALLOWED_UPDATES).toContain("callback_query");
  });
});
