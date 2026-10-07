import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { FleetManager } from "../src/fleet-manager.js";
import { Daemon } from "../src/daemon.js";
import { AccessManager } from "../src/channel/access-manager.js";
import { DiscordAdapter } from "../src/channel/adapters/discord.js";
import { TelegramAdapter } from "../src/channel/adapters/telegram.js";
import { routeToolCall } from "../src/channel/tool-router.js";
import { ClassicChannelManager } from "../src/classic-channel-manager.js";
import type { ChannelAdapter, InboundMessage } from "../src/channel/types.js";
import type { CliBackend } from "../src/backend/types.js";
import type { InstanceConfig } from "../src/types.js";

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}

function telegram(shared = { slot: [] as string[] }) {
  const calls: string[][] = [];
  const api = vi.fn(async (_chat: number, _message: number, values: Array<{ emoji: string }>) => {
    expect(values.length).toBeLessThanOrEqual(1);
    const next = values.map(v => v.emoji);
    expect(next.some(e => ["✅", "❌", "⏳"].includes(e))).toBe(false);
    calls.push(next);
    shared.slot = next;
  });
  const adapter = Object.create(TelegramAdapter.prototype) as TelegramAdapter;
  Object.assign(adapter, { id: "bot", reactionTrackingStartedAt: 0, bot: { api: { setMessageReaction: api } } });
  return { adapter, api, calls, shared };
}

function setup(adapter: ChannelAdapter, general = false) {
  const dir = mkdtempSync(join(tmpdir(), "agend-959-"));
  dirs.push(dir);
  const fm = new FleetManager(dir);
  const type = adapter instanceof TelegramAdapter ? "telegram" : "discord";
  const access = { mode: "open" as const, allowed_users: [], max_pending_codes: 5, code_expiry_minutes: 10 };
  const cfg = { id: "bot", type, mode: "topic", group_id: type === "telegram" ? "-100" : "guild", access,
    options: general ? { general_channel_id: "general-channel" } : {} };
  const instance = { working_directory: dir, channel_id: "bot", ...(general ? { general_topic: true, topic_id: "general-channel" } : { topic_id: "30" }) };
  Object.assign(fm, { adapter, fleetConfig: { defaults: {}, channels: [cfg], instances: { worker: instance } } });
  fm.worlds.set("bot", { id: "bot", adapter, channelConfig: cfg, groupId: cfg.group_id,
    accessManager: new AccessManager(access, join(dir, "access.json")) } as any);
  fm.routing.rebuild(fm.fleetConfig!);
  const daemon = new Daemon("worker", instance as InstanceConfig, dir, true,
    { binaryName: "fixture" } as CliBackend, undefined, pino({ level: "silent" }));
  Object.assign(daemon, { tmux: {} });
  vi.spyOn(daemon as any, "updateLastChat").mockImplementation(() => {});
  vi.spyOn(daemon as any, "recordRecentUserMessage").mockImplementation(() => {});
  vi.spyOn(daemon as any, "markTurnStarted").mockImplementation(() => {});
  // Only the final pane writer is stubbed: pushChannelMessage still constructs
  // its real channelStatus from the real General/topic delivery metadata.
  const paneWriter = vi.spyOn(daemon as any, "deliverMessage").mockImplementation(async (_text, status) => {
    daemon.emit("message_confirmed", status);
    return false;
  });
  for (const method of ["start", "wake", "stop", "trySpawn"])
    vi.spyOn(daemon as any, method).mockImplementation(() => { throw new Error(`forbidden lifecycle: ${method}`); });
  (fm as any).daemons.set("worker", daemon);
  (fm as any).lifecycle.attachDeliveryStatusHandlers("worker", daemon);
  vi.spyOn((fm as any).topicCommands, "handleInstanceCommand").mockResolvedValue(false);
  vi.spyOn((fm as any).topicCommands, "handleGeneralCommand").mockResolvedValue(false);
  for (const method of ["sendCancelButton", "setTopicIcon", "touchActivity"])
    vi.spyOn(fm as any, method).mockImplementation(() => {});
  vi.spyOn(fm, "deliverToInstance").mockImplementation(async (_name, payload) => {
    expect(typeof payload.content).toBe("string");
    daemon.pushChannelMessage(payload.content as string, payload.meta as Record<string, string>);
    await (daemon as any).pasteLock;
  });
  const msg: InboundMessage = { source: type, adapterId: "bot", chatId: cfg.group_id,
    threadId: general ? "general-channel" : "30", messageId: "42", userId: "human", username: "human",
    text: "hello", timestamp: new Date() };
  return { fm, daemon, msg, paneWriter };
}

async function drain(fm: FleetManager) {
  // The production FIFO removes settled tails. Await all current tails rather
  // than sleeping and letting a timing flake decide whether a call happened.
  while ((fm as any).deliveryStatusChains.size)
    await Promise.all([...(fm as any).deliveryStatusChains.values()]);
}

function classicAttachment(kind: "document" | "photo", collab: boolean) {
  const tg = telegram();
  const state = setup(tg.adapter);
  const { fm, msg, paneWriter } = state;
  vi.spyOn(ClassicChannelManager, "logMessage").mockImplementation(() => {});
  vi.spyOn(fm as any, "getRecentChatLog").mockReturnValue("");
  Object.assign(fm, { classicChannels: {
    isCollab: () => collab,
    getAdapterIdByInstance: () => "bot",
    getChannelIdByInstance: () => "-200",
    getContextLines: () => 5,
    getAll: () => [],
  } });
  Object.assign(fm.worlds.get("bot")!, { botUserId: "4242" });
  const path = join((fm as any).dataDir, "inbox", kind === "photo" ? "image.png" : "report.pdf");
  vi.spyOn(fm as any, "saveClassicAttachment").mockResolvedValue({ path, paths: [path], kind });
  vi.spyOn(tg.adapter, "downloadAttachment").mockRejectedValue(new Error("unexpected real download"));
  // Drive the real Classic handler → real delivery metadata → real daemon
  // status binding, with storage, platform API and the pane writer stubbed.
  paneWriter.mockResolvedValue(false);
  const classicMsg: InboundMessage = { ...msg, chatId: "-200", threadId: "-200",
    text: collab ? "<@4242> read this" : "/chat read this",
    attachments: [{ kind, fileId: "fixture", filename: kind === "photo" ? "image.png" : "report.pdf" }] };
  const settle = async () => {
    while ((fm as any).deliveryStatusChains.size || (tg.adapter as any).reactionChains?.size) {
      await drain(fm);
      await Promise.all([...(tg.adapter as any).reactionChains?.values() ?? []]);
    }
  };
  return { ...state, tg, classicMsg, settle };
}

function agentReact(adapter: ChannelAdapter, emoji: string, messageId = "42") {
  return new Promise<void>((resolve, reject) => {
    expect(routeToolCall(adapter, "react", { chat_id: "-100", message_id: messageId, emoji }, "30",
      (_result, error) => error ? reject(new Error(error)) : resolve())).toBe(true);
  });
}

describe("#959 real ingress → daemon status → bound adapter", () => {
  it.each([false, true])("Classic forwarded document (collab=%s) remains system-owned through failure", async collab => {
    const { fm, daemon, paneWriter, tg, classicMsg, settle } = classicAttachment("document", collab);
    await (fm as any).handleClassicChannelMessage("worker", classicMsg);
    await settle();
    expect(paneWriter).toHaveBeenCalledOnce();
    expect(paneWriter.mock.calls[0][0]).toContain("report.pdf");
    expect(tg.calls).toEqual([["👀"], ["👍"]]);
    daemon.emit("message_failed", { chatId: "-200", messageId: "42", threadId: "-200" });
    await settle();
    expect(tg.shared.slot).toEqual(["👎"]);
    expect(tg.calls).toEqual([["👀"], ["👍"], ["👎"]]);
    expect(tg.api.mock.calls.every(c => c[0] === -200 && c[1] === 42)).toBe(true);
  });

  it.each([false, true])("Classic forwarded image (collab=%s) permits processing and failed statuses", async collab => {
    const { fm, daemon, paneWriter, tg, classicMsg, settle } = classicAttachment("photo", collab);
    await (fm as any).handleClassicChannelMessage("worker", classicMsg);
    await settle();
    expect(paneWriter).toHaveBeenCalledOnce();
    expect(tg.calls).toEqual([["👀"], ["👌"]]);
    daemon.emit("message_delivered", { chatId: "-200", messageId: "42", threadId: "-200" });
    await settle();
    expect(tg.shared.slot).toEqual(["👀"]);
    daemon.emit("message_failed", { chatId: "-200", messageId: "42", threadId: "-200" });
    await settle();
    expect(tg.calls).toEqual([["👀"], ["👌"], ["👀"], ["👎"]]);
  });

  it.each([false, true])("an agent override after a forwarded attachment stamp (collab=%s) remains untouched", async collab => {
    const { fm, daemon, tg, classicMsg, settle } = classicAttachment("document", collab);
    await (fm as any).handleClassicChannelMessage("worker", classicMsg);
    await settle();
    // The same emoji is still a deliberate agent replacement of our stamp.
    await tg.adapter.react("-200", "42", "👍");
    daemon.emit("message_failed", { chatId: "-200", messageId: "42", threadId: "-200" });
    await settle();
    expect(tg.shared.slot).toEqual(["👍"]);
    expect(tg.calls).toEqual([["👀"], ["👍"], ["👍"]]);
  });

  it.each([
    [false, "photo", "🔥", "🔥"], [true, "photo", "🔥", "🔥"],
    [false, "document", "🎉", "🎉"], [true, "document", "🎉", "🎉"],
    [false, "photo", "📸", "👌"], [true, "photo", "📸", "👌"],
    [false, "document", "📎", "👍"], [true, "document", "📎", "👍"],
  ] as const)("forwarded stamp keeps its configured emoji/fallback (collab=%s, kind=%s, override=%s)", async (collab, kind, configured, expected) => {
    const { fm, daemon, tg, classicMsg, settle } = classicAttachment(kind, collab);
    Object.assign(fm.fleetConfig!.instances.worker, {
      status_emojis: { [kind === "photo" ? "photo" : "attachment"]: configured },
    });
    await (fm as any).handleClassicChannelMessage("worker", classicMsg);
    await settle();
    expect(tg.calls).toEqual([["👀"], [expected]]);
    expect(tg.shared.slot).toEqual([expected]);
    daemon.emit("message_failed", { chatId: "-200", messageId: "42", threadId: "-200" });
    await settle();
    expect(tg.shared.slot).toEqual(["👎"]);
    expect(tg.calls).toEqual([["👀"], [expected], ["👎"]]);
  });

  it.each([false, true])("a forwarded attachment (collab=%s) cannot replace an earlier agent reaction", async collab => {
    const { fm, daemon, paneWriter, tg, classicMsg, settle } = classicAttachment("document", collab);
    await tg.adapter.react("-200", "42", "🔥");
    await (fm as any).handleClassicChannelMessage("worker", classicMsg);
    await settle();
    expect(paneWriter).toHaveBeenCalledOnce();
    daemon.emit("message_failed", { chatId: "-200", messageId: "42", threadId: "-200" });
    await settle();
    expect(tg.calls).toEqual([["🔥"]]);
    expect(tg.shared.slot).toEqual(["🔥"]);
  });

  it("a forwarded attachment stamp cannot bootstrap an unknown slot without a receipt", async () => {
    const { fm, tg, classicMsg, settle } = classicAttachment("document", false);
    await (fm as any).reactClassicForwardedAttachment("worker", tg.adapter, classicMsg, "document");
    await settle();
    expect(tg.api).not.toHaveBeenCalled();
    expect((tg.adapter as any).telegramReactions?.size ?? 0).toBe(0);
  });

  it.each([false, true])("a save-only Classic attachment (collab=%s) never acquires delivery ownership", async collab => {
    const { fm, daemon, paneWriter, tg, classicMsg, settle } = classicAttachment("document", collab);
    await (fm as any).handleClassicChannelMessage("worker", { ...classicMsg, text: "just saving" });
    await settle();
    expect(paneWriter).not.toHaveBeenCalled();
    expect(tg.calls).toEqual([["👍"]]);
    daemon.emit("message_failed", { chatId: "-200", messageId: "42", threadId: "-200" });
    await settle();
    expect(tg.calls).toEqual([["👍"]]);
    expect(tg.shared.slot).toEqual(["👍"]);
  });

  it("Classic system receipt owns the slot and permits later status until an agent replaces it", async () => {
    const tg = telegram();
    const { fm, daemon, msg } = setup(tg.adapter);
    vi.spyOn(ClassicChannelManager, "logMessage").mockImplementation(() => {});
    vi.spyOn(fm as any, "getRecentChatLog").mockReturnValue("");
    const classicMsg = { ...msg, chatId: "-200", threadId: "-200", text: "/chat hello" };
    await (fm as any).handleClassicChannelMessage("worker", classicMsg);
    await drain(fm);
    daemon.emit("message_failed", { chatId: "-200", messageId: "42", threadId: "-200" });
    await drain(fm);
    expect(tg.calls).toEqual([["👀"], ["👎"]]);
    await tg.adapter.react("-200", "42", "👍");
    daemon.emit("message_confirmed", { chatId: "-200", messageId: "42", threadId: "-200" });
    await drain(fm);
    expect(tg.shared.slot).toEqual(["👍"]);
    expect(tg.calls).toEqual([["👀"], ["👎"], ["👍"]]);
  });

  it("native Discord General topic routing keeps its channel without normalization stubs", async () => {
    const put = vi.fn().mockResolvedValue(undefined);
    const adapter = Object.create(DiscordAdapter.prototype) as DiscordAdapter;
    Object.assign(adapter, { id: "bot", client: { rest: { put } } });
    const { fm, msg, paneWriter } = setup(adapter, true);
    await (fm as any).handleInboundMessage(msg);
    await drain(fm);
    expect(paneWriter).toHaveBeenCalledOnce();
    expect(put).toHaveBeenCalledTimes(2);
    expect(put.mock.calls.every(c => String(c[0]).startsWith("/channels/general-channel/"))).toBe(true);
  });

  it("Discord General keeps the original channel on both receipt and terminal status", async () => {
    const post = vi.fn().mockResolvedValue(undefined);
    const adapter = Object.create(DiscordAdapter.prototype) as DiscordAdapter;
    Object.assign(adapter, { id: "bot", client: { rest: { put: post } } });
    const { fm, msg, paneWriter } = setup(adapter, true);
    // Exercise the explicit General fallback too. Native Discord currently
    // routes its channel id as a topic; only this route classification is
    // stubbed, leaving the ingress, metadata, daemon and reaction handlers real.
    vi.spyOn(fm as any, "inboundRouteThreadId").mockReturnValue(undefined);
    await (fm as any).handleInboundMessage(msg);
    await drain(fm);
    expect(paneWriter).toHaveBeenCalledOnce();
    expect(paneWriter.mock.calls[0][1]).toEqual({ chatId: "guild", messageId: "42", threadId: "general-channel" });
    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls.every(c => String(c[0]).startsWith("/channels/general-channel/messages/42/reactions/"))).toBe(true);
    expect(post.mock.calls.some(c => String(c[0]).includes("/channels/guild/"))).toBe(false);
  });

  it.each(["👍", "👀"])("agent-owned %s survives a different failed status", async emoji => {
    const tg = telegram();
    const { fm, daemon, msg } = setup(tg.adapter);
    await (fm as any).handleInboundMessage(msg);
    await drain(fm);
    expect(tg.calls).toEqual([["👀"]]);
    await agentReact(tg.adapter, emoji);
    daemon.emit("message_failed", { chatId: msg.chatId, messageId: msg.messageId, threadId: msg.threadId });
    await drain(fm);
    expect(tg.shared.slot).toEqual([emoji]);
    expect(tg.calls).toEqual([["👀"], [emoji]]);
    expect([...(fm as any).lastStatusEmoji.values()]).toEqual([{ emoji: "👀", status: "delivered" }]);
  });

  it("adapter re-creation skips late daemon status without forgetting the platform slot", async () => {
    const old = telegram();
    const { fm, daemon, msg } = setup(old.adapter);
    await (fm as any).handleInboundMessage(msg);
    await drain(fm);
    await agentReact(old.adapter, "👍");
    const replacement = telegram(old.shared);
    (fm.worlds.get("bot") as any).adapter = replacement.adapter;
    (fm as any).adapter = replacement.adapter;
    daemon.emit("message_failed", { chatId: msg.chatId, messageId: msg.messageId, threadId: msg.threadId });
    await drain(fm);
    expect(replacement.api).not.toHaveBeenCalled();
    expect(replacement.shared.slot).toEqual(["👍"]);
  });

  it("an agent call already in flight owns the slot before later status can check it", async () => {
    const tg = telegram();
    const { fm, daemon, msg } = setup(tg.adapter);
    await (fm as any).handleInboundMessage(msg);
    await drain(fm);
    const held = deferred();
    tg.api.mockImplementationOnce(async (_c, _m, values) => { await held.promise; tg.shared.slot = values.map(v => v.emoji); });
    const agent = agentReact(tg.adapter, "👍");
    await Promise.resolve();
    daemon.emit("message_failed", { chatId: msg.chatId, messageId: msg.messageId, threadId: msg.threadId });
    await Promise.resolve();
    held.resolve();
    await agent;
    await drain(fm);
    expect(tg.api).toHaveBeenCalledTimes(2);
    expect(tg.shared.slot).toEqual(["👍"]);
  });

  it("an older status already in flight settles before the agent's replacement", async () => {
    const tg = telegram();
    const { fm, daemon, msg } = setup(tg.adapter);
    await (fm as any).handleInboundMessage(msg);
    await drain(fm);
    const entered = deferred();
    const held = deferred();
    tg.api.mockImplementationOnce(async (_c, _m, values) => {
      entered.resolve();
      await held.promise;
      tg.shared.slot = values.map(v => v.emoji);
    });
    daemon.emit("message_failed", { chatId: msg.chatId, messageId: msg.messageId, threadId: msg.threadId });
    await entered.promise;
    const agent = agentReact(tg.adapter, "👍");
    held.resolve();
    await agent;
    await drain(fm);
    expect(tg.api).toHaveBeenCalledTimes(3);
    expect(tg.shared.slot).toEqual(["👍"]);
  });

  it("a failed agent API response makes ownership unknown and later status skips", async () => {
    const tg = telegram();
    const { fm, daemon, msg } = setup(tg.adapter);
    await (fm as any).handleInboundMessage(msg);
    await drain(fm);
    tg.api.mockImplementationOnce(async () => {
      tg.shared.slot = ["👍"]; // Telegram applied it, but its response was lost.
      throw new Error("response lost");
    });
    await expect(agentReact(tg.adapter, "👍")).rejects.toThrow("response lost");
    daemon.emit("message_failed", { chatId: msg.chatId, messageId: msg.messageId, threadId: msg.threadId });
    await drain(fm);
    expect(tg.api).toHaveBeenCalledTimes(2);
    expect(tg.shared.slot).toEqual(["👍"]);
    // Rejected calls must not poison the ordinary reaction FIFO.
    await agentReact(tg.adapter, "🎉");
    expect(tg.shared.slot).toEqual(["🎉"]);
  });

  it("status-owned transitions still work and a failed status does not advance the fleet cache", async () => {
    const tg = telegram();
    const { fm, daemon, msg } = setup(tg.adapter);
    await (fm as any).handleInboundMessage(msg);
    await drain(fm);
    tg.api.mockRejectedValueOnce(new Error("ambiguous status write"));
    daemon.emit("message_failed", { chatId: msg.chatId, messageId: msg.messageId, threadId: msg.threadId });
    await drain(fm);
    expect([...(fm as any).lastStatusEmoji.values()]).toEqual([{ emoji: "👀", status: "delivered" }]);
    fm.finishDeliveryStatus("worker", msg.chatId, msg.messageId, "delivered", msg.threadId);
    await drain(fm);
    expect(tg.api).toHaveBeenCalledTimes(2); // unknown → no third write
  });

  it("an evicted record is unknown and a terminal event cannot reacquire its slot", async () => {
    const tg = telegram();
    const { fm, daemon, msg } = setup(tg.adapter);
    await (fm as any).handleInboundMessage(msg);
    await drain(fm);
    await agentReact(tg.adapter, "👍");
    for (let i = 0; i < 1000; i++) await agentReact(tg.adapter, "🎉", String(1000 + i));
    expect((tg.adapter as any).telegramReactions.size).toBe(1000);
    expect((tg.adapter as any).telegramReactions.has("-100:42")).toBe(false);
    tg.api.mockClear();
    daemon.emit("message_failed", { chatId: msg.chatId, messageId: msg.messageId, threadId: msg.threadId });
    await drain(fm);
    expect(tg.api).not.toHaveBeenCalled();
  });

  it("a non-receipt status cannot bootstrap ownership even with a caller-supplied timestamp", async () => {
    const tg = telegram({ slot: ["👍"] });
    const { fm } = setup(tg.adapter);
    fm.reactMessageStatus("worker", "-100", "42", "failed", "30", Date.now());
    await drain(fm);
    expect(tg.api).not.toHaveBeenCalled();
    expect((fm as any).lastStatusEmoji.size).toBe(0);
    expect(tg.shared.slot).toEqual(["👍"]);
  });
});

describe("Telegram conditional status ownership", () => {
  it.each([[1_000, 2_250], [10_000, 10_001]])("an evicted message cannot re-acquire ownership by replaying receivedAt=%s", async (receivedAt, newerAt) => {
    const now = vi.spyOn(Date, "now").mockReturnValue(2_000);
    const tg = telegram();
    const slots = new Map<string, string[]>();
    tg.api.mockImplementation(async (chat, message, values) => {
      expect(values.length).toBeLessThanOrEqual(1);
      slots.set(`${chat}:${message}`, values.map(v => v.emoji));
    });
    await tg.adapter.reactDeliveryStatus("-100", "42", "👀", receivedAt);
    now.mockReturnValue(2_500);
    await tg.adapter.react("-100", "42", "👍");
    now.mockReturnValue(5_000);
    for (let i = 0; i < 1_000; i++) await tg.adapter.react("-100", String(100 + i), "👍");
    expect((tg.adapter as any).telegramReactions.has("-100:42")).toBe(false);
    const calls = tg.api.mock.calls.length;
    expect(await tg.adapter.reactDeliveryStatus("-100", "42", "👎", receivedAt)).toBe(false);
    expect(tg.api).toHaveBeenCalledTimes(calls);
    expect(slots.get("-100:42")).toEqual(["👍"]);
    // The boundary tracks first observation, not the latest agent update.
    // A distinct, genuinely newer receipt remains eligible.
    expect(await tg.adapter.reactDeliveryStatus("-100", "99", "👀", newerAt)).toBe(true);
    expect(slots.get("-100:99")).toEqual(["👀"]);
  });

  it("cannot bootstrap from an old receipt or an unverified timestamp", async () => {
    const tg = telegram({ slot: ["👍"] });
    (tg.adapter as any).reactionTrackingStartedAt = 2000;
    expect(await tg.adapter.reactDeliveryStatus("-100", "42", "👀", 1999)).toBe(false);
    expect(await tg.adapter.reactDeliveryStatus("-100", "42", "👀")).toBe(false);
    expect(await tg.adapter.reactDeliveryStatus("-100", "42", "👀", NaN)).toBe(false);
    expect(tg.api).not.toHaveBeenCalled();
    expect(tg.shared.slot).toEqual(["👍"]);
  });

  it("only the first fresh receipt establishes ownership; error remains unknown", async () => {
    const tg = telegram();
    expect(await tg.adapter.reactDeliveryStatus("-100", "42", "👀", Date.now())).toBe(true);
    expect(await tg.adapter.reactDeliveryStatus("-100", "42", "👎")).toBe(true);
    expect(await tg.adapter.reactDeliveryStatus("-100", "42", "👀")).toBe(true);
    expect(tg.calls).toEqual([["👀"], ["👎"], ["👀"]]);
    tg.api.mockRejectedValueOnce(new Error("ambiguous"));
    await expect(tg.adapter.reactDeliveryStatus("-100", "42", "👎")).rejects.toThrow("ambiguous");
    expect(await tg.adapter.reactDeliveryStatus("-100", "42", "👀", Date.now())).toBe(false);
    expect(tg.api).toHaveBeenCalledTimes(4);
  });

  it("status cleanup preserves an agent's identical emoji and an explicit agent clear", async () => {
    const tg = telegram();
    await tg.adapter.reactDeliveryStatus("-100", "42", "👀", Date.now());
    await agentReact(tg.adapter, "👀");
    expect(await tg.adapter.reactDeliveryStatus("-100", "42", null)).toBe(false);
    expect(tg.shared.slot).toEqual(["👀"]);
    await tg.adapter.unreact("-100", "42", "👀");
    expect(await tg.adapter.reactDeliveryStatus("-100", "42", "👎")).toBe(false);
    expect(tg.shared.slot).toEqual([]);
  });

  it("status cleanup clears its own slot once", async () => {
    const tg = telegram();
    await tg.adapter.reactDeliveryStatus("-100", "42", "👀", Date.now());
    expect(await tg.adapter.reactDeliveryStatus("-100", "42", null)).toBe(true);
    expect(await tg.adapter.reactDeliveryStatus("-100", "42", null)).toBe(true);
    expect(tg.calls).toEqual([["👀"], []]);
  });

  it("stop invalidates queued mutations and a late API acknowledgement cannot restore ownership", async () => {
    const tg = telegram();
    await tg.adapter.reactDeliveryStatus("-100", "42", "👀", Date.now());
    const entered = deferred();
    const held = deferred();
    tg.api.mockImplementationOnce(async () => { entered.resolve(); await held.promise; });
    const active = tg.adapter.reactDeliveryStatus("-100", "42", "👎");
    await entered.promise;
    const queued = tg.adapter.reactDeliveryStatus("-100", "42", "👀");
    // Attach rejection before releasing the FIFO; all stop side effects stubbed.
    const queuedResult = queued.catch(e => e.message as string);
    Object.assign(tg.adapter, { queue: { stop: vi.fn() }, httpAgent: { destroy: vi.fn() }, httpsAgent: { destroy: vi.fn() } });
    (tg.adapter as any).bot.stop = vi.fn().mockResolvedValue(undefined);
    await tg.adapter.stop();
    held.resolve();
    await active;
    expect(await queuedResult).toBe("Reaction cancelled by adapter stop");
    expect((tg.adapter as any).telegramReactions.size).toBe(0);
    expect(await tg.adapter.reactDeliveryStatus("-100", "42", "👀")).toBe(false);
    expect(tg.api).toHaveBeenCalledTimes(2);
  });
});
