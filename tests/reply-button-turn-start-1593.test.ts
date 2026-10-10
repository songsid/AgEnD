/**
 * #1593: real reply-button claims, FleetManager delivery/IPC facade, status event wiring,
 * cancel publications/retirement, web history and chat store. The adapter and daemon
 * native boundary are inert; no fleet, backend, platform or tmux is started.
 */
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FleetManager } from "../src/fleet-manager.js";
import { AdapterWorld } from "../src/adapter-world.js";
import { AccessManager } from "../src/channel/access-manager.js";
import { TelegramAdapter } from "../src/channel/adapters/telegram.js";
import { ClassicChannelManager } from "../src/classic-channel-manager.js";
import { REPLY_BUTTON_TTL_MS } from "../src/reply-buttons.js";
import { t } from "../src/locale.js";
import type { ChannelAdapter } from "../src/channel/types.js";
import type { ChannelConfig } from "../src/types.js";

let createChatStore: any;
beforeAll(async () => {
  ({ createChatStore } = await import("/ui/js/chat-store.js") as any);
});
const fixtures: Array<{ fm: any; dir: string }> = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-10T00:00:00Z"));
  vi.spyOn(ClassicChannelManager, "logMessage").mockImplementation(() => {});
});
afterEach(() => {
  for (const { fm, dir } of fixtures.splice(0)) {
    fm.replyButtonsCtl?.stop();
    fm.replyButtonsStore?.close();
    for (const entry of [...fm.cancelButtons.values()]) fm.discardButton(entry);
    rmSync(dir, { recursive: true, force: true });
  }
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
async function flush() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
function held<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

function fixture(type: "discord" | "telegram" | "web", classic = false) {
  const dir = mkdtempSync(join(tmpdir(), "agend-reply-turn-"));
  const fm = new FleetManager(dir) as any;
  fixtures.push({ fm, dir });
  const platform = type !== "web";
  const chatId = type === "telegram" ? "-100" : "guild";
  const topic = "42";
  const room = type === "telegram" ? "-200" : "room";
  const replies: any[] = [], reactions: any[] = [], alerts: any[] = [], deleted: any[] = [], payloads: any[] = [], events: any[] = [];
  const adapter = Object.assign(type === "telegram" ? Object.create(TelegramAdapter.prototype) : {}, {
    id: type, type, ...(type === "telegram" ? {} : { supportsReplyButtons: true }),
    react: vi.fn(async (...args: any[]) => { reactions.push(args); }),
    reactDeliveryStatus: vi.fn(async (...args: any[]) => { reactions.push(args); return true; }),
    unreact: vi.fn(async () => {}),
    notifyAlert: vi.fn(async (chatId: string, alert: any, options?: any) => {
      const receipt = { chatId, messageId: `cancel-${alerts.length + 1}`, threadId: options?.threadId };
      alerts.push({ ...receipt, alert }); return receipt;
    }),
    editAlert: vi.fn(async () => {}),
    editMessage: vi.fn(async () => {}),
    deleteMessage: vi.fn(async (...args: any[]) => { deleted.push(args); }),
    sendText: vi.fn(async (chatId: string, text: string, options?: any) => {
      const receipt = { chatId, messageId: `reply-${replies.length + 1}`, buttonsMessageId: `reply-${replies.length + 1}` };
      replies.push({ ...receipt, text, options }); return receipt;
    }),
    settleReplyButtons: vi.fn(async () => {}),
  }) as ChannelAdapter;
  const access = { mode: "locked", allowed_users: ["owner"], max_pending_codes: 0, code_expiry_minutes: 0 };
  const channel = { id: type, type, mode: "topic", bot_token_env: "FAKE", group_id: chatId, access,
    options: { status_emojis: { received: type === "telegram" ? "👌" : "👀", processing: "🤔" } },
  } as unknown as ChannelConfig;
  fm.fleetConfig = { defaults: {}, ...(platform ? { channels: [channel] } : {}), instances: { w: { working_directory: dir, ...(platform && !classic ? { channel_id: type, topic_id: topic } : {}) } } };
  if (classic) {
    delete fm.fleetConfig.instances.w;
    fm.classicChannels = {
      getChannelIdByInstance: (name: string) => name === "w" ? room : undefined,
      getAdapterIdByInstance: () => type,
      getAll: () => [{ instanceName: "w", channelId: room, adapterId: type }],
      getContextLines: () => 5,
      isCollab: () => false,
    };
  }
  if (platform) {
    const world = new AdapterWorld(type, adapter, new AccessManager(access as any, join(dir, "access.json")), channel);
    world.botUserId = "bot";
    fm.worlds.set(type, world); fm.adapter = adapter;
  }
  fm.routing.rebuild(fm.fleetConfig);
  // No start()/wake()/process handler is exercised. The injected native boundary
  // emits the same delivery/state stages as a CLI taking the message.
  const daemon = new EventEmitter();
  fm.lifecycle.attachDeliveryStatusHandlers("w", daemon);
  fm.lifecycle.isPaused = vi.fn(() => false);
  fm.getInstanceStatus = () => "running";
  fm.instanceIpcClients.set("w", { connected: true, send: (payload: any) => {
    if (payload.type === "fleet_inbound") {
      payloads.push(payload);
      const meta = payload.meta;
      daemon.emit("message_delivered", { chatId: meta.chat_id, messageId: meta.message_id, threadId: meta.thread_id || undefined });
      fm.cacheInstanceExecutionState("w", { state: "working" });
    }
    return true;
  } });
  fm.topicCommands.handleInstanceCommand = vi.fn(async () => false);
  fm.topicCommands.handleGeneralCommand = vi.fn(async () => false);
  const handlers: Record<string, (data: any) => void> = {};
  const store = createChatStore({ fetch: vi.fn(), t, toast: vi.fn(), announce: vi.fn(), now: () => 123, setTimeout });
  store.attach({ on: (event: string, fn: (data: any) => void) => { handlers[event] = fn; } });
  const realEmit = fm.emitSseEvent.bind(fm);
  fm.emitSseEvent = (event: string, data: any) => { events.push({ event, data }); realEmit(event, data); handlers[event]?.(data); };
  fm.cacheInstanceExecutionState("w", { state: "idle" });
  // A prior turn's pending idle timer and progress must not leak into this handoff.
  fm.instanceProgress.set("w", "old tool list");
  const buttons = fm.replyButtons()!;
  const where = { instance: "w", adapterId: platform ? type : "web", chatId: platform ? (classic ? room : chatId) : "web", threadId: platform && !classic ? topic : undefined };
  const prepared = buttons.prepare(where, [{ label: "B：直接上 VM 改", value: "deploy" }, { label: "A" , value: "A" }]);
  buttons.bind(prepared.id, "reply-with-buttons");
  const click = async (over: Record<string, unknown> = {}) => {
    const ack = vi.fn();
    await fm.dispatchAdapterCallback({ callbackData: prepared.callbacks[0].id,
      chatId: type === "discord" ? chatId : where.chatId,
      threadId: classic && type === "discord" ? room : where.threadId,
      messageId: "reply-with-buttons", userId: "owner", username: "alice", ack, ...over,
    }, type, adapter);
    await flush(); return ack;
  };
  return { fm, adapter, daemon, store, where, prepared, buttons, click, reactions, alerts, deleted, payloads, events };
}

describe("a reply choice is a user turn", () => {
  for (const type of ["discord", "telegram"] as const) for (const classic of [false, true]) {
    it(`${type} ${classic ? "Classic" : "topic"}: received → processing, one fresh cancel bubble and web working state`, async () => {
      const h = fixture(type, classic);
      const ack = await h.click();
      expect(h.payloads).toHaveLength(1);
      expect(h.payloads[0].content).toBe("[button] B：直接上 VM 改 (value: deploy)");
      expect(h.reactions.map(r => r[2])).toEqual(type === "discord" ? ["👀", "🤔"] : ["👌", "🤔"]);
      expect(h.reactions.every(r => r[1] === "reply-with-buttons")).toBe(true);
      expect(h.reactions[0][0]).toBe(classic ? h.where.chatId : (type === "discord" ? "42" : "-100"));
      if (type === "telegram") expect(h.reactions[0][3]).toBe(Date.now());
      expect(h.alerts).toHaveLength(1);
      expect(h.alerts[0]).toMatchObject({ chatId: h.where.chatId, alert: { type: "cancel", instanceName: "w", choices: [{ id: "cancel:w" }] } });
      expect(h.alerts[0].threadId).toBe(classic ? undefined : "42");
      const [entry] = [...h.fm.cancelButtons.values()] as any[];
      expect(entry.progressTimer).toBeDefined();
      expect(entry.toolProgress).toBeUndefined();
      expect(h.fm.lastInboundUser.get("w")).toBe("alice");
      expect(h.fm.lastInboundMsg.get("w")).toMatchObject({ messageId: "reply-with-buttons", adapterId: type });
      expect(h.store.state.exec.w).toBe("working");
      expect(h.store.state.workingSince.w).toBe(123);
      expect(h.fm.webChatHistory.list("w").at(-1)).toMatchObject({ role: "user", sender: "alice" });
      expect(h.fm.webChatHistory.list("w")).toHaveLength(1);
      expect(h.buttons.viewOf(h.prepared.id).state).toBe("chosen");
      expect(ack).toHaveBeenCalledWith(t("reply_buttons.sent", "B：直接上 VM 改"));
    });
  }
  it.each(["discord", "telegram", "web"] as const)("web choice on %s: no platform reaction on its synthetic id, same working state", async type => {
    const h = fixture(type);
    expect(await h.fm.clickWebReplyButton("w", h.prepared.id, 0)).toEqual({ status: 200 });
    await flush();
    expect(h.payloads).toHaveLength(1);
    expect(h.payloads[0].meta).toMatchObject({ source: "web", user_id: "web-user", message_id: expect.stringMatching(/^web-/) });
    expect(h.reactions).toEqual([]);
    expect(h.store.state.exec.w).toBe("working");
    expect(h.store.state.workingSince.w).toBe(123);
    expect(h.fm.webChatHistory.list("w").at(-1)).toMatchObject({ role: "user", sender: "web-user" });
    expect(h.alerts).toHaveLength(type === "web" ? 0 : 1);
  });
  it("the typed topic control uses the same cancel bookkeeping", async () => {
    const h = fixture("discord");
    await h.fm.handleInboundMessage({ source: "discord", adapterId: "discord", chatId: "guild", threadId: "42", messageId: "typed", userId: "owner", username: "alice", text: "Do B", timestamp: new Date() });
    await flush();
    expect(h.payloads).toHaveLength(1);
    expect(h.alerts).toHaveLength(1);
    expect(h.fm.lastInboundMsg.get("w").messageId).toBe("typed");
  });
  it.each(["discord", "telegram"] as const)("%s typed Classic carry: one user row and one cancel bubble after delivery", async type => {
    const h = fixture(type, true);
    vi.spyOn(h.fm, "getRecentChatLog").mockReturnValue("");
    const msg = { source: type, adapterId: type, chatId: h.where.chatId, messageId: "typed-classic", userId: "owner", username: "alice", timestamp: new Date() };
    await h.fm.forwardToClassicInstance("w", "Do B", msg); await flush();
    expect(h.payloads).toHaveLength(1); expect(h.alerts).toHaveLength(1);
    expect(h.fm.webChatHistory.list("w")).toMatchObject([{ role: "user", text: "Do B" }]);
    expect(h.events.filter(e => e.event === "message")).toHaveLength(1);
    const rejected = fixture(type, true);
    vi.spyOn(rejected.fm, "getRecentChatLog").mockReturnValue("");
    vi.spyOn(rejected.fm, "deliverToInstance").mockRejectedValue(new Error("inert unavailable"));
    await rejected.fm.forwardToClassicInstance("w", "not delivered", msg); await flush();
    expect(rejected.alerts).toEqual([]); expect(rejected.fm.webChatHistory.list("w")).toEqual([]);
  });
  it("the choice carries and consumes the same pending reaction context as typed input", async () => {
    const h = fixture("discord");
    const summary = "alice reacted 👍 to the last reply";
    h.fm.eventLog = { pendingReactions: vi.fn(() => ({ summary, maxId: 7 })), markReactionsConsumed: vi.fn() };
    await h.click();
    expect(h.payloads[0].meta.pending_reactions).toBe(summary);
    expect(h.fm.eventLog.markReactionsConsumed).toHaveBeenCalledWith("w", 7);
  });
  it("a rejected handoff leaves pending reaction context unconsumed", async () => {
    const h = fixture("discord");
    h.fm.eventLog = { pendingReactions: vi.fn(() => ({ summary: "pending", maxId: 7 })), markReactionsConsumed: vi.fn() };
    vi.spyOn(h.fm, "deliverToInstance").mockResolvedValue(false);
    await h.click();
    expect(h.fm.eventLog.pendingReactions).toHaveBeenCalledWith("w");
    expect(h.fm.eventLog.markReactionsConsumed).not.toHaveBeenCalled();
  });
  it("a topic choice records activity and uses the normal blue topic icon", async () => {
    const h = fixture("telegram");
    const activity = vi.spyOn(h.fm, "touchActivity");
    const icon = vi.spyOn(h.fm, "setTopicIcon");
    await h.click();
    expect(activity).toHaveBeenCalledWith("w");
    expect(h.fm.lastActivity.get("w")).toBe(Date.now());
    expect(icon).toHaveBeenCalledWith("w", "blue");
  });
});

describe("claims and cleanup remain shared", () => {
  it("a concurrent double click delivers and starts the turn once", async () => {
    const h = fixture("discord");
    await Promise.all([h.click(), h.click()]);
    expect(h.payloads).toHaveLength(1); expect(h.alerts).toHaveLength(1);
    expect(h.reactions.map(r => r[2])).toEqual(["👀", "🤔"]);
  });
  it.each([{ userId: "stranger" }, { userId: "bot" }, { messageId: "wrong" }])("refusal %j has no turn effects", async over => {
    const h = fixture("discord"); await h.click(over);
    expect(h.payloads).toEqual([]); expect(h.reactions).toEqual([]); expect(h.alerts).toEqual([]);
    expect(h.buttons.viewOf(h.prepared.id).state).toBe("open");
  });
  it("an expired choice is inert", async () => {
    const h = fixture("discord"); vi.setSystemTime(Date.now() + REPLY_BUTTON_TTL_MS);
    await h.click(); expect(h.payloads).toEqual([]); expect(h.alerts).toEqual([]);
    expect(h.buttons.viewOf(h.prepared.id).state).toBe("expired");
  });
  it.each([false, "throw"])("failed handoff %s reopens without a successful turn", async result => {
    const h = fixture("discord");
    const delivery = vi.spyOn(h.fm, "deliverToInstance").mockImplementation(async () => { if (result === "throw") throw new Error("inert unavailable"); return false; });
    await h.click();
    expect(h.reactions.map(r => r[2])).toEqual(["👀", "❌"]);
    expect(h.alerts).toEqual([]); expect(h.fm.lastInboundUser.has("w")).toBe(false);
    expect(h.fm.webChatHistory.list("w")).toEqual([]);
    expect(h.buttons.viewOf(h.prepared.id).state).toBe("open");
    delivery.mockRestore(); await h.click();
    h.daemon.emit("message_confirmed", { chatId: h.where.chatId, messageId: "reply-with-buttons", threadId: "42" });
    await flush();
    expect(h.reactions.map(r => r[2])).toEqual(["👀", "❌", "👀", "🤔", "✅"]);
    expect(h.adapter.unreact).toHaveBeenCalledWith("42", "reply-with-buttons", "❌", "42");
    expect(h.payloads).toHaveLength(1); expect(h.alerts).toHaveLength(1);
    expect(h.buttons.viewOf(h.prepared.id).state).toBe("chosen");
  });
  it("a canceled accepted handoff cannot resurrect a cancel publication", async () => {
    const h = fixture("discord"), wait = held<void>();
    const real = h.fm.deliverToInstance.bind(h.fm);
    vi.spyOn(h.fm, "deliverToInstance").mockImplementation(async (...args: any[]) => { const result = await real(...args); await wait.promise; return result; });
    const click = h.click(); await flush(); expect(h.payloads).toHaveLength(1);
    h.fm.cancelPendingDeliveries("w"); wait.resolve(); await click;
    expect(h.alerts).toEqual([]);
  });
  it("a stopping fleet cannot publish a new bubble after an accepted handoff", async () => {
    const h = fixture("discord"), wait = held<void>();
    const real = h.fm.deliverToInstance.bind(h.fm);
    vi.spyOn(h.fm, "deliverToInstance").mockImplementation(async (...args: any[]) => { const result = await real(...args); await wait.promise; return result; });
    const click = h.click(); await flush(); expect(h.payloads).toHaveLength(1);
    h.fm.shuttingDown = true; wait.resolve(); await click;
    expect(h.alerts).toEqual([]);
    // Acceptance remains truthful; only the retired turn publication is fenced.
    expect(h.buttons.viewOf(h.prepared.id).state).toBe("chosen");
    expect(h.fm.webChatHistory.list("w").at(-1)).toMatchObject({ role: "user" });
  });
  it("a new choice replaces the previous turn's idle retirement timer", async () => {
    const h = fixture("discord");
    await h.fm.sendCancelButton("w");
    await vi.advanceTimersByTimeAsync(1000);
    await h.click();
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.alerts).toHaveLength(2);
    expect([...h.fm.cancelButtons.values()]).toMatchObject([{ messageId: "cancel-2" }]);
  });
  it("a choice cannot mark a user HTML row as an agent", async () => {
    const h = fixture("discord"); await h.click({ username: "w" });
    expect(h.fm.webChatHistory.list("w").at(-1)).toMatchObject({ role: "user", sender: "w" });
  });
  it("the existing idle edge retires a choice's cancel button after grace", async () => {
    const h = fixture("telegram"); await h.click(); expect(h.fm.cancelButtons.size).toBe(1);
    h.fm.cacheInstanceExecutionState("w", { state: "idle" });
    await vi.advanceTimersByTimeAsync(1999); expect(h.fm.cancelButtons.size).toBe(1);
    await vi.advanceTimersByTimeAsync(1); await flush(); expect(h.fm.cancelButtons.size).toBe(0);
    expect(h.deleted).toHaveLength(1);
    expect(h.store.state.exec.w).toBe("idle"); expect(h.store.state.workingSince.w).toBeUndefined();
  });
  it("a reply while working re-posts, then the existing reply grace retires it", async () => {
    const h = fixture("discord"); await h.click();
    h.fm.afterReplyRouted("w", { text: "First step" }); await flush();
    expect(h.alerts).toHaveLength(2); expect(h.fm.cancelButtons.size).toBe(1);
    const [entry] = [...h.fm.cancelButtons.values()] as any[]; expect(entry.replyGraceTimer).toBeDefined();
    // The authoritative refresh boundary reports idle without a new idle edge;
    // this specifically exercises the reply-grace path, not the 2s timer.
    h.fm.refreshInstanceExecutionState = vi.fn(async () => { h.fm.instanceStateCache.get("w").state = "idle"; return true; });
    await vi.advanceTimersByTimeAsync(120_000); await flush(); expect(h.fm.cancelButtons.size).toBe(0);
  });
});
