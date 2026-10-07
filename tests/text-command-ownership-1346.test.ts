/**
 * #1346: text commands follow the topic owner, never the dedup-race winner.
 * - Non-owner copies run no command and answer nothing (unit: TopicCommands
 *   returns false; manager: dropped before the dedup claim).
 * - Permission is checked against the owner's admin list.
 * - Discord fleet topics: ANY /xxx (known or not) never runs — the owner
 *   posts one system note and consumes it. Discord classic ignores /xxx
 *   silently. /xxx@another-bot is silent everywhere.
 * - Telegram fleet topics: bare /cmd runs via the owner; /cmd@otherbot is
 *   ignored. Telegram classic groups ignore bare /cmd (only /cmd@ourbot
 *   runs); private chats run bare /cmd unchanged.
 * Isolated: stub contexts and fake adapters only — no fleet, tmux, Discord.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccessManager } from "../src/channel/access-manager.js";
import { FleetManager } from "../src/fleet-manager.js";
import { setLocale, t } from "../src/locale.js";
import { TopicCommands } from "../src/topic-commands.js";

const OWNER = "discord";
const SIBLING = "grok-persona";

afterEach(() => {
  vi.restoreAllMocks();
  setLocale("en");
});

// ── Unit layer: TopicCommands with a stub context ──────────────────────────

function unitCommands(opts?: {
  owner?: string | null;
  admins?: Record<string, string[]>;
  adapters?: string[];
}) {
  const sent: Record<string, string[]> = {};
  const adapters = new Map<string, { sendText: (chat: string, text: string, opts?: unknown) => Promise<void> }>();
  for (const id of opts?.adapters ?? [OWNER, SIBLING]) {
    sent[id] = [];
    adapters.set(id, { sendText: vi.fn(async (_chat: string, text: string) => { sent[id]!.push(text); }) });
  }
  const isFleetAdmin = vi.fn(
    (userId: string, adapterId?: string) => (opts?.admins?.[adapterId ?? ""] ?? []).includes(userId),
  );
  const commands = new TopicCommands({
    adapters,
    adapter: { sendText: vi.fn(async () => undefined) },
    fleetConfig: { instances: {} },
    getInstanceAdapterId: opts?.owner === null ? undefined : () => opts?.owner ?? OWNER,
    isFleetAdmin,
    hasFleetAdmins: (adapterId?: string) => (opts?.admins?.[adapterId ?? ""] ?? []).length > 0,
  } as any);
  return { commands, sent, isFleetAdmin };
}

function inbound(text: string, adapterId: string, source = "discord", userId = "alice") {
  return {
    source, adapterId, chatId: "g1", threadId: "topic-1", messageId: `m-${text}-${adapterId}`,
    userId, userName: userId, text, isBotMessage: false,
  } as any;
}

describe("owner gate: handleInstanceCommand", () => {
  it("a non-owner copy runs nothing and answers nothing", async () => {
    const { commands, sent } = unitCommands({ owner: OWNER });
    expect(await commands.handleInstanceCommand(inbound("/ctx", SIBLING), "worker")).toBe(false);
    expect(sent[OWNER]).toHaveLength(0);
    expect(sent[SIBLING]).toHaveLength(0);
  });

  it("the owner copy runs and replies through the owner adapter", async () => {
    const { commands, sent } = unitCommands({ owner: OWNER });
    vi.spyOn(commands, "getCtxText").mockResolvedValue("CTX-CARD");
    expect(await commands.handleInstanceCommand(inbound("/ctx", OWNER), "worker")).toBe(true);
    expect(sent[OWNER]).toEqual(["CTX-CARD"]);
    expect(sent[SIBLING]).toHaveLength(0);
  });

  it("a non-owner copy never reaches the permission check at all", async () => {
    // mallory is admin on the sibling only: her copy dies at the gate, so no
    // list — receiver's or owner's — can let her through this way.
    const { commands, sent, isFleetAdmin } = unitCommands({
      owner: OWNER,
      admins: { [OWNER]: ["alice"], [SIBLING]: ["mallory"] },
    });
    expect(await commands.handleInstanceCommand(inbound("/effort", SIBLING, "discord", "mallory"), "worker")).toBe(false);
    expect(isFleetAdmin).not.toHaveBeenCalled();
    expect(sent[SIBLING]).toHaveLength(0);
    expect(sent[OWNER]).toHaveLength(0);
    // Even alice (owner-admin) gets nothing from the sibling copy: only the
    // owner's own copy may run the command.
    expect(await commands.handleInstanceCommand(inbound("/effort", SIBLING, "discord", "alice"), "worker")).toBe(false);
    expect(isFleetAdmin).not.toHaveBeenCalled();
  });

  it("the owner copy checks permission against the owner's list", async () => {
    const { commands, isFleetAdmin } = unitCommands({
      owner: OWNER,
      admins: { [OWNER]: ["alice"], [SIBLING]: ["mallory"] },
    });
    await commands.handleInstanceCommand(inbound("/effort", OWNER, "discord", "alice"), "worker");
    expect(isFleetAdmin).toHaveBeenCalledWith("alice", OWNER);
    isFleetAdmin.mockClear();
    await commands.handleInstanceCommand(inbound("/effort", OWNER, "discord", "mallory"), "worker");
    expect(isFleetAdmin).toHaveBeenCalledWith("mallory", OWNER);
  });

  it("an adapter-less copy is judged against the owner's list", async () => {
    const { commands, isFleetAdmin } = unitCommands({
      owner: OWNER,
      admins: { [OWNER]: ["alice"] },
    });
    const msg = inbound("/effort", OWNER, "discord", "alice");
    delete (msg as any).adapterId;
    expect(await commands.handleInstanceCommand(msg, "worker")).toBe(true);
    expect(isFleetAdmin).toHaveBeenCalledWith("alice", OWNER);
  });
});

describe("owner gate: handleGeneralCommand", () => {
  it("a non-owner copy runs nothing and answers nothing", async () => {
    const { commands, sent } = unitCommands({ owner: OWNER });
    expect(await commands.handleGeneralCommand(inbound("/login", SIBLING), "general")).toBe(false);
    expect(sent[OWNER]).toHaveLength(0);
    expect(sent[SIBLING]).toHaveLength(0);
  });

  it("the owner copy reaches the permission check on the owner's list", async () => {
    const { commands, isFleetAdmin } = unitCommands({
      owner: OWNER,
      admins: { [OWNER]: ["alice"] },
    });
    expect(await commands.handleGeneralCommand(inbound("/login", OWNER), "general")).toBe(true);
    expect(isFleetAdmin).toHaveBeenCalledWith("alice", OWNER);
  });

  it("a legacy one-arg call still processes (no instance to judge by)", async () => {
    const { commands } = unitCommands({ owner: null });
    // No instance: the gate is skipped, the denied admin path still answers.
    expect(await commands.handleGeneralCommand(inbound("/login", OWNER))).toBe(true);
  });
});

describe("telegram text commands are unchanged", () => {
  it("still matches /ctx and unmatched /xxx still falls through", async () => {
    const { commands, sent } = unitCommands({ owner: OWNER });
    vi.spyOn(commands, "getCtxText").mockResolvedValue("CTX-CARD");
    expect(await commands.handleInstanceCommand(inbound("/ctx", OWNER, "telegram"), "worker")).toBe(true);
    expect(sent[OWNER]).toEqual(["CTX-CARD"]);
    // Unknown /xxx: no system note at this layer, falls through to delivery.
    expect(await commands.handleInstanceCommand(inbound("/frobnicate", OWNER, "telegram"), "worker")).toBe(false);
    expect(sent[OWNER]).toHaveLength(1);
  });
});

// ── Manager layer: real FleetManager, two fake Discord worlds ──────────────

const OPEN = { mode: "open" as const, allowed_users: [] as string[], max_pending_codes: 5, code_expiry_minutes: 10 };
const discordSent: string[] = [];
const siblingSent: string[] = [];

function managerSetup() {
  const dir = mkdtempSync(join(tmpdir(), "text-ownership-1346-"));
  const fm = new FleetManager(dir) as any;
  discordSent.length = 0;
  siblingSent.length = 0;
  const mk = (id: string, store: string[]) => ({
    id, type: "discord",
    sendText: vi.fn(async (_c: string, text: string) => { store.push(text); }),
  });
  const discord = mk(OWNER, discordSent);
  const sibling = mk(SIBLING, siblingSent);
  const cfg = (id: string) => ({ id, type: "discord", mode: "topic", group_id: "g1", access: OPEN });
  fm.fleetConfig = {
    defaults: {},
    channels: [cfg(OWNER), cfg(SIBLING)],
    instances: { worker: { working_directory: dir, topic_id: "topic-1" } },
  } as any;
  fm.adapter = discord;
  fm.worlds.set(OWNER, { adapterId: OWNER, adapter: discord, channelConfig: cfg(OWNER),
    botUsername: "OwnerBot", accessManager: new AccessManager(OPEN, join(dir, "a1.json")) });
  fm.worlds.set(SIBLING, { adapterId: SIBLING, adapter: sibling, channelConfig: cfg(SIBLING),
    botUsername: "SibBot", accessManager: new AccessManager(OPEN, join(dir, "a2.json")) });
  fm.routing.rebuild(fm.fleetConfig);
  vi.spyOn(fm.topicCommands, "getCtxText").mockResolvedValue("CTX-CARD");
  const deliver = vi.spyOn(fm, "deliverToInstance").mockResolvedValue(undefined);
  return { fm, dir, deliver };
}

function copy(text: string, adapterId: string, messageId: string, source = "discord") {
  return {
    source, adapterId, chatId: "g1", threadId: "topic-1", messageId,
    userId: 111, userName: "user", text, isBotMessage: false, timestamp: new Date(),
  };
}

describe("end to end: the #1346 race", () => {
  it("even the owner's /ctx gets the system note — text never runs on Discord", async () => {
    const { fm, dir, deliver } = managerSetup();
    try {
      await fm.handleInboundMessage(copy("/ctx", SIBLING, "m-1"));
      expect(siblingSent, "non-owner answers nothing").toHaveLength(0);
      expect(discordSent, "owner copy has not arrived yet").toHaveLength(0);
      expect(deliver, "command text is not delivered").not.toHaveBeenCalled();
      expect(fm.recentMessageIds.size, "key unconsumed").toBe(0);
      await fm.handleInboundMessage(copy("/ctx", OWNER, "m-1"));
      expect(discordSent, "owner posts the system note").toEqual([t("cmd.not_a_command")]);
      expect(siblingSent).toHaveLength(0);
      expect(deliver, "consumed, never delivered").not.toHaveBeenCalled();
      expect(fm.topicCommands.getCtxText, "no command ran").not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("/xxx@another-bot is silent even on the owner's copy (addressed elsewhere)", async () => {
    const { fm, dir, deliver } = managerSetup();
    try {
      await fm.handleInboundMessage(copy("/ctx@someoneelse", OWNER, "m-9"));
      expect(discordSent, "no system note for a foreign @suffix").toHaveLength(0);
      expect(deliver, "ignored, never delivered").not.toHaveBeenCalled();
      expect(fm.topicCommands.getCtxText, "no command ran").not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("unknown /xxx on Discord gets one owner-posted system note, never the agent", async () => {
    const { fm, dir, deliver } = managerSetup();
    try {
      await fm.handleInboundMessage(copy("/frobnicate", OWNER, "m-2"));
      expect(discordSent).toEqual([t("cmd.not_a_command")]);
      expect(deliver, "consumed, never delivered").not.toHaveBeenCalled();
      await fm.handleInboundMessage(copy("/frobnicate", SIBLING, "m-3"));
      expect(siblingSent, "non-owner stays silent").toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("plain non-command input still delivers first-wins", async () => {
    const { fm, dir, deliver } = managerSetup();
    try {
      await fm.handleInboundMessage(copy("hello there", SIBLING, "m-4"));
      expect(deliver, "delivered once").toHaveBeenCalledTimes(1);
      expect(siblingSent).toHaveLength(0);
      expect(discordSent).toHaveLength(0);
      await fm.handleInboundMessage(copy("hello there", OWNER, "m-4"));
      expect(deliver, "late duplicate dropped").toHaveBeenCalledTimes(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Discord classic ignores /xxx; Telegram classic still answers", () => {
  function classicSetup() {
    const dir = mkdtempSync(join(tmpdir(), "text-ownership-classic-"));
    const fm = new FleetManager(dir) as any;
    const sentA: string[] = [];
    const sentB: string[] = [];
    const mkAdapter = (store: string[]) => ({
      sendText: vi.fn(async (_c: string, text: string) => { store.push(text); }),
    });
    fm.worlds = new Map([
      ["da", { adapterId: "da", adapter: mkAdapter(sentA), channelConfig: { id: "da" }, botUserId: "b1" }],
      ["db", { adapterId: "db", adapter: mkAdapter(sentB), channelConfig: { id: "db" }, botUserId: "b2" }],
    ]);
    fm.adapter = fm.worlds.get("da").adapter;
    fm.classicChannels = {
      getInstanceByChannel: vi.fn((channelId: string, adapterId?: string) =>
        channelId === "chan-1" && (adapterId === "da" || adapterId === "db") ? "classic-a" : undefined),
      isCollab: () => false,
    };
    vi.spyOn(fm.topicCommands, "getCtxText").mockResolvedValue("CTX-CARD");
    return { fm, dir, sentA, sentB };
  }

  const classicMsg = (text: string, adapterId: string, source = "discord") => ({
    source, adapterId, chatId: "chan-1", threadId: undefined, messageId: `c-${text}-${adapterId}`,
    userId: "u", userName: "u", text, isBotMessage: false,
  });

  it("no bot answers /ctx on Discord classic, not even multi-bot", async () => {
    const { fm, dir, sentA, sentB } = classicSetup();
    try {
      await fm.handleClassicChannelMessage("classic-a", classicMsg("/ctx", "da") as any);
      await fm.handleClassicChannelMessage("classic-a", classicMsg("/ctx", "db") as any);
      expect(sentA).toHaveLength(0);
      expect(sentB).toHaveLength(0);
      expect(fm.topicCommands.getCtxText).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("Discord /chat text is not forwarded either", async () => {
    const { fm, dir, sentA } = classicSetup();
    try {
      await fm.handleClassicChannelMessage("classic-a", classicMsg("/chat hello?", "da") as any);
      expect(sentA).toHaveLength(0);
      expect(fm.topicCommands.getCtxText).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("Telegram /ctx still answers through the entry's adapter", async () => {
    const { fm, dir, sentA, sentB } = classicSetup();
    try {
      await fm.handleClassicChannelMessage("classic-a", classicMsg("/ctx", "db", "telegram") as any);
      expect(sentB).toEqual(["CTX-CARD"]);
      expect(sentA).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("an adapter with no entry in the channel answers nothing", async () => {
    const { fm, dir, sentA, sentB } = classicSetup();
    try {
      await fm.handleClassicChannelMessage("classic-a", classicMsg("/ctx", "ghost", "telegram") as any);
      expect(sentA).toHaveLength(0);
      expect(sentB).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── Telegram fleet forum topics: bare /cmd runs via the owner; /cmd@other ───
// is ignored (6b). Same owner gate as Discord, but text commands execute.

const TG_OWNER = "tg-owner";
const TG_SIBLING = "tg-sib";

function tgFleetSetup() {
  const dir = mkdtempSync(join(tmpdir(), "text-ownership-tg-fleet-"));
  const fm = new FleetManager(dir) as any;
  const ownerSent: string[] = [];
  const sibSent: string[] = [];
  const mk = (store: string[]) => ({
    sendText: vi.fn(async (_c: string, text: string) => { store.push(text); }),
  });
  const cfg = (id: string) => ({ id, type: "telegram", mode: "topic", group_id: "g1", access: OPEN });
  fm.fleetConfig = {
    defaults: {},
    channels: [cfg(TG_OWNER), cfg(TG_SIBLING)],
    instances: { worker: { working_directory: dir, topic_id: "topic-1" } },
  } as any;
  fm.adapter = mk(ownerSent);
  fm.worlds.set(TG_OWNER, { adapterId: TG_OWNER, adapter: mk(ownerSent), channelConfig: cfg(TG_OWNER),
    botUsername: "OwnerBot", accessManager: new AccessManager(OPEN, join(dir, "a1.json")) });
  fm.worlds.set(TG_SIBLING, { adapterId: TG_SIBLING, adapter: mk(sibSent), channelConfig: cfg(TG_SIBLING),
    botUsername: "SibBot", accessManager: new AccessManager(OPEN, join(dir, "a2.json")) });
  fm.routing.rebuild(fm.fleetConfig);
  vi.spyOn(fm.topicCommands, "getCtxText").mockResolvedValue("CTX-CARD");
  const deliver = vi.spyOn(fm, "deliverToInstance").mockResolvedValue(undefined);
  return { fm, dir, deliver, ownerSent, sibSent };
}

const tgCopy = (text: string, adapterId: string, messageId: string) => ({
  source: "telegram", adapterId, chatId: "g1", threadId: "topic-1", messageId,
  userId: 111, userName: "user", text, isBotMessage: false, timestamp: new Date(),
});

describe("Telegram fleet topics: owner gate + @bot suffix (6b)", () => {
  it("a bare /cmd runs, but only through the owning adapter", async () => {
    const { fm, dir, deliver, ownerSent, sibSent } = tgFleetSetup();
    try {
      await fm.handleInboundMessage(tgCopy("/ctx", TG_SIBLING, "t-1"));
      expect(sibSent, "non-owner silent").toHaveLength(0);
      expect(ownerSent).toHaveLength(0);
      expect(deliver).not.toHaveBeenCalled();
      await fm.handleInboundMessage(tgCopy("/ctx", TG_OWNER, "t-1"));
      expect(ownerSent, "owner runs and replies").toEqual(["CTX-CARD"]);
      expect(sibSent).toHaveLength(0);
      expect(deliver).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("/cmd@otherbot is ignored, even on the owner's copy", async () => {
    const { fm, dir, deliver, ownerSent, sibSent } = tgFleetSetup();
    try {
      await fm.handleInboundMessage(tgCopy("/ctx@SibBot", TG_OWNER, "t-2"));
      await fm.handleInboundMessage(tgCopy("/ctx@SibBot", TG_SIBLING, "t-3"));
      expect(ownerSent).toHaveLength(0);
      expect(sibSent).toHaveLength(0);
      expect(deliver, "ignored, never delivered").not.toHaveBeenCalled();
      expect(fm.topicCommands.getCtxText, "no command ran").not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("/cmd@ownerbot (any case) still runs through the owner", async () => {
    const { fm, dir, deliver, ownerSent, sibSent } = tgFleetSetup();
    try {
      await fm.handleInboundMessage(tgCopy("/ctx@oWnErBoT", TG_OWNER, "t-4"));
      expect(ownerSent).toEqual(["CTX-CARD"]);
      expect(sibSent).toHaveLength(0);
      expect(deliver).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("/cmd@stranger is ignored — nobody runs it", async () => {
    const { fm, dir, deliver, ownerSent, sibSent } = tgFleetSetup();
    try {
      await fm.handleInboundMessage(tgCopy("/ctx@stranger", TG_OWNER, "t-5"));
      expect(ownerSent).toHaveLength(0);
      expect(sibSent).toHaveLength(0);
      expect(deliver).not.toHaveBeenCalled();
      expect(fm.topicCommands.getCtxText).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── Telegram ClassicBot groups (6a) and private chats (6c) ──────────────────

function tgClassicSetup() {
  const dir = mkdtempSync(join(tmpdir(), "text-ownership-tg-classic-"));
  const fm = new FleetManager(dir) as any;
  const sent: string[] = [];
  const adapter = {
    sendText: vi.fn(async (_c: string, text: string) => { sent.push(text); }),
  };
  fm.adapter = adapter;
  fm.worlds.set("tg", { adapterId: "tg", adapter,
    channelConfig: { id: "tg", type: "telegram", group_id: "999" },
    botUsername: "OurBot", accessManager: new AccessManager(OPEN, join(dir, "a.json")) });
  fm.classicChannels = {
    hasChannel: () => false,
    getInstanceByChannel: vi.fn((chatId: string, adapterId?: string) =>
      (chatId === "-100" || chatId === "12345") && adapterId === "tg" ? "classic-tg" : undefined),
    isCollab: () => false,
  };
  vi.spyOn(fm.topicCommands, "getCtxText").mockResolvedValue("CTX-CARD");
  const deliver = vi.spyOn(fm, "deliverToInstance").mockResolvedValue(undefined);
  return { fm, dir, deliver, sent };
}

const tgDirect = (text: string, chatId: string, messageId: string) => ({
  source: "telegram", adapterId: "tg", chatId, threadId: undefined, messageId,
  userId: 111, userName: "user", text, isBotMessage: false, timestamp: new Date(),
});

describe("Telegram classic groups (6a) and private chats (6c)", () => {
  it("a bare /cmd in a classic group is ignored — only /cmd@ourbot runs", async () => {
    const { fm, dir, deliver, sent } = tgClassicSetup();
    try {
      await fm.handleInboundMessage(tgDirect("/ctx", "-100", "g-1"));
      expect(sent, "bare /cmd ignored").toHaveLength(0);
      expect(fm.topicCommands.getCtxText).not.toHaveBeenCalled();
      await fm.handleInboundMessage(tgDirect("/ctx@OurBot", "-100", "g-2"));
      expect(sent, "/cmd@ourbot runs").toEqual(["CTX-CARD"]);
      expect(deliver).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("/cmd@otherbot in a classic group is ignored entirely", async () => {
    const { fm, dir, deliver, sent } = tgClassicSetup();
    try {
      await fm.handleInboundMessage(tgDirect("/ctx@OtherBot", "-100", "g-3"));
      expect(sent).toHaveLength(0);
      expect(deliver, "never delivered").not.toHaveBeenCalled();
      expect(fm.topicCommands.getCtxText).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a bare /cmd in a private chat still runs (6c unchanged)", async () => {
    const { fm, dir, deliver, sent } = tgClassicSetup();
    try {
      await fm.handleInboundMessage(tgDirect("/ctx", "12345", "p-1"));
      expect(sent).toEqual(["CTX-CARD"]);
      expect(deliver).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
