import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FleetManager } from "../src/fleet-manager.js";
import { EventLog } from "../src/event-log.js";
import { TELEGRAM_ALLOWED_UPDATES } from "../src/channel/adapters/telegram.js";
import type { InboundReaction } from "../src/channel/types.js";

// #408 gave AgEnD inbound reactions; #432 changes what they are. A reaction is
// context, not a message: it never triggers an agent turn. It queues in the event
// log and rides into the instance's NEXT real message as one compact leading line,
// then is marked consumed.

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
  const dir = mkdtempSync(join(tmpdir(), "agend-react-"));
  const fm = new FleetManager(dir);
  const deliver = vi.fn().mockResolvedValue(undefined);
  const eventLog = new EventLog(join(dir, "events.db"));
  const internals = fm as unknown as {
    resolveSlashTarget(channelId: string, adapterId?: string): string | undefined;
    deliverToInstance(name: string, payload: Record<string, unknown>): Promise<void>;
    eventLog: EventLog;
    handleInboundReaction(r: InboundReaction): Promise<void>;
    pendingReactionsMeta(name: string): { meta: Record<string, string>; consume: () => void };
  };
  internals.resolveSlashTarget = () => routed ?? undefined;
  internals.deliverToInstance = deliver;
  internals.eventLog = eventLog;
  const cleanup = () => { eventLog.close(); rmSync(dir, { recursive: true, force: true }); };
  return { internals, deliver, eventLog, cleanup };
}

describe("handleInboundReaction stores instead of delivering", () => {
  it("never delivers — a reaction must not cost an agent turn", async () => {
    const { internals, deliver, cleanup } = makeFleet();
    try {
      // Approval emoji or chatter, added or removed: none of it is a message.
      for (const r of [reaction(), reaction({ emoji: "🎉" }), reaction({ action: "remove" })]) {
        await internals.handleInboundReaction(r);
      }
      expect(deliver).not.toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });

  it("queues every emoji, not only approvals", async () => {
    const { internals, cleanup } = makeFleet();
    try {
      await internals.handleInboundReaction(reaction({ emoji: "👍" }));
      await internals.handleInboundReaction(reaction({ emoji: "❓", username: "user2", messageId: "msg-3" }));

      const pending = internals.eventLog.pendingReactions("alpha");
      expect(pending?.summary).toBe("msg msg-99: 👍 from hanhanv | msg msg-3: ❓ from user2");
    } finally {
      cleanup();
    }
  });

  it("groups by message and collapses duplicates within one", async () => {
    // The message id is the point: the agent can match `msg <id>` against the
    // message_id its own inbound blocks rendered, and know WHICH reply was
    // reacted to. Repeats of the same emoji on the same message collapse to ×N.
    const { internals, cleanup } = makeFleet();
    try {
      await internals.handleInboundReaction(reaction({ messageId: "msg-A" }));
      await internals.handleInboundReaction(reaction({ messageId: "msg-A" }));
      await internals.handleInboundReaction(reaction({ messageId: "msg-B", emoji: "🎉" }));

      expect(internals.eventLog.pendingReactions("alpha")?.summary)
        .toBe("msg msg-A: 👍×2 from hanhanv | msg msg-B: 🎉 from hanhanv");
    } finally {
      cleanup();
    }
  });

  it("nets out an add followed by a remove", async () => {
    const { internals, cleanup } = makeFleet();
    try {
      await internals.handleInboundReaction(reaction());
      await internals.handleInboundReaction(reaction({ action: "remove" }));

      // The user visibly took the 👍 back; reporting it would misinform the agent.
      expect(internals.eventLog.pendingReactions("alpha")).toBeNull();
    } finally {
      cleanup();
    }
  });

  it("ignores a reaction in an unrouted channel", async () => {
    const { internals, cleanup } = makeFleet(null);
    try {
      await internals.handleInboundReaction(reaction());
      expect(internals.eventLog.pendingReactions("alpha")).toBeNull();
    } finally {
      cleanup();
    }
  });
});

describe("pending reactions ride the next real message", () => {
  it("summarises with counts and consumes only via the callback", async () => {
    const { internals, cleanup } = makeFleet();
    try {
      await internals.handleInboundReaction(reaction());
      await internals.handleInboundReaction(reaction({ messageId: "msg-100" }));
      await internals.handleInboundReaction(reaction({ emoji: "❓", username: "user2" }));

      const expected = "msg msg-99: 👍 from hanhanv, ❓ from user2 | msg msg-100: 👍 from hanhanv";
      const first = internals.pendingReactionsMeta("alpha");
      expect(first.meta.pending_reactions).toBe(expected);

      // Fetch alone must not consume: a delivery that fails after summarising
      // keeps the reactions queued for the next message.
      const again = internals.pendingReactionsMeta("alpha");
      expect(again.meta.pending_reactions).toBe(expected);

      first.consume();
      expect(internals.pendingReactionsMeta("alpha").meta).toEqual({});
    } finally {
      cleanup();
    }
  });

  it("adds zero context when nothing is pending", () => {
    const { internals, cleanup } = makeFleet();
    try {
      const { meta } = internals.pendingReactionsMeta("alpha");
      expect(meta).toEqual({});
      expect(Object.keys(meta)).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  it("keeps a reaction that arrives during delivery for the next message", async () => {
    const { internals, cleanup } = makeFleet();
    try {
      await internals.handleInboundReaction(reaction());
      const inFlight = internals.pendingReactionsMeta("alpha");

      // Lands between the summary being built and the consume — bounded by maxId,
      // so it must survive.
      await internals.handleInboundReaction(reaction({ emoji: "🚀", messageId: "msg-7" }));
      inFlight.consume();

      expect(internals.pendingReactionsMeta("alpha").meta.pending_reactions).toBe("msg msg-7: 🚀 from hanhanv");
    } finally {
      cleanup();
    }
  });

  it("scopes the queue per instance", async () => {
    const { internals, cleanup } = makeFleet();
    try {
      internals.eventLog.addReaction("beta", "m1", "hanhanv", "👍");
      expect(internals.pendingReactionsMeta("alpha").meta).toEqual({});
      expect(internals.pendingReactionsMeta("beta").meta.pending_reactions).toBe("msg m1: 👍 from hanhanv");
    } finally {
      cleanup();
    }
  });
});

describe("reaction retention", () => {
  it("prunes queued reactions after the retention window", () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-react-prune-"));
    const log = new EventLog(join(dir, "events.db"));
    try {
      log.addReaction("alpha", "m1", "hanhanv", "👍");
      // Backdate past the 7-day horizon, as time passing would.
      (log as unknown as { db: import("better-sqlite3").Database }).db
        .prepare("UPDATE reactions SET created_at = datetime('now', '-8 days')")
        .run();

      log.prune(30); // events keep a longer horizon; reactions use their own

      expect(log.pendingReactions("alpha")).toBeNull();
    } finally {
      log.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("daemon renders the pending line ahead of the message", () => {
  it("prefixes [Recent reactions: …] only when meta carries it", async () => {
    const { mkdtempSync: mkd } = await import("node:fs");
    const { Daemon } = await import("../src/daemon.js");
    const instanceDir = mkd(join(tmpdir(), "agend-react-render-"));
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const daemon = new Daemon("rr", {
      working_directory: "/tmp",
      restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
      context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 },
      hang_detector: { enabled: false, timeout_minutes: 10, idle_debounce_ms: 10 },
      log_level: "silent",
    } as any, instanceDir, false, { getReadyPattern: () => /❯/ } as any, undefined,
      { child: () => logger } as any);

    const delivered: string[] = [];
    (daemon as any).tmux = { getWindowId: () => "@1" };
    (daemon as any).deliverMessage = async (text: string) => { delivered.push(text); return true; };

    try {
      daemon.pushChannelMessage("進度如何?", {
        user: "hanhanv", source: "discord",
        pending_reactions: "👍×2 from hanhanv, ❓ from user2",
      });
      daemon.pushChannelMessage("second message", { user: "hanhanv", source: "discord" });
      await vi.waitFor(() => expect(delivered).toHaveLength(2));

      // One compact line, ahead of the [user:] block, once.
      expect(delivered[0].startsWith("[Recent reactions: 👍×2 from hanhanv, ❓ from user2]\n[user:hanhanv")).toBe(true);
      expect(delivered[0].match(/Recent reactions/g)).toHaveLength(1);
      // The common case must carry nothing.
      expect(delivered[1]).not.toContain("Recent reactions");
    } finally {
      rmSync(instanceDir, { recursive: true, force: true });
    }
  });
});

describe("Telegram allowed_updates", () => {
  it("includes message_reaction, which is absent from Telegram's default set", () => {
    expect(TELEGRAM_ALLOWED_UPDATES).toContain("message_reaction");
  });

  it("still lists every update type the adapter handles", () => {
    for (const u of ["message", "edited_message", "callback_query"]) {
      expect(TELEGRAM_ALLOWED_UPDATES).toContain(u);
    }
  });
});
