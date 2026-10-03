/** Drive both installed slash listeners; no Discord/network/process lifecycle. */
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChannelConfig, FleetConfig } from "../src/types.js";
import type { ChannelAdapter } from "../src/channel/types.js";
import type { StatusEmojiConfig } from "../src/status-emojis.js";

const adapters = vi.hoisted(() => new Map<string, ChannelAdapter>());
vi.mock("../src/channel/factory.js", () => ({
  createAdapter: vi.fn(async (_config: ChannelConfig, options: { id: string }) => adapters.get(options.id)),
}));
import { FleetManager } from "../src/fleet-manager.js";
import { ClassicChannelManager } from "../src/classic-channel-manager.js";

const INBOX = "<:inbox:111111111111111111>";
const WORK = "<a:work:222222222222222222>";
const DONE = "<:done:333333333333333333>";
const dirs: string[] = [];
const managers: FleetManager[] = [];

afterEach(() => {
  for (const manager of managers.splice(0)) {
    const state = manager as any;
    clearInterval(state.sessionPruneTimer);
    for (const entry of state.cancelButtons.values()) {
      clearInterval(entry.progressTimer);
      clearInterval(entry.idleCheckTimer);
      clearTimeout(entry.progressEditTimer);
    }
    for (const timer of state.cancelButtonIdleRetireTimers.values()) clearTimeout(timer);
  }
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  adapters.clear();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function recordingAdapter(id: string, type = "discord") {
  const events = new EventEmitter();
  const adapter = Object.assign(events, {
    id, type, topology: "topics", start: vi.fn(async () => {}), setChatId: vi.fn(),
    react: vi.fn(async () => {}), unreact: vi.fn(async () => {}),
    notifyAlert: vi.fn(async () => ({ chatId: "room", messageId: `progress-${id}` })),
    editAlert: vi.fn(async () => {}),
  });
  adapters.set(id, adapter as unknown as ChannelAdapter);
  return adapter;
}

async function harness(path: "primary" | "additional", config: StatusEmojiConfig = {}) {
  vi.stubEnv("STATUS_TEST_TOKEN", "test-only");
  const dir = mkdtempSync(join(tmpdir(), "agend-classic-status-"));
  dirs.push(dir);
  const fleet = new FleetManager(dir);
  managers.push(fleet);
  const state = fleet as any;
  const primary = recordingAdapter("primary");
  const secondary = recordingAdapter("secondary");
  const channel = (id: string, status_emojis: StatusEmojiConfig): ChannelConfig => ({
    id, type: "discord", mode: "topic", bot_token_env: "STATUS_TEST_TOKEN",
    group_id: "guild", access: { mode: "open", allowed_users: [], max_pending_codes: 0, code_expiry_minutes: 0 }, options: { status_emojis },
  });
  // Both bots see the same room. Secondary must never inherit the primary's stamps.
  const channels = [channel("primary", path === "primary" ? config : { received: "🦊", processing: "🦊", delivered: "🦊" }),
    channel("secondary", path === "additional" ? config : { received: "🐙" })];
  const fleetConfig = { channels, defaults: {}, instances: {} } as FleetConfig;
  fleet.fleetConfig = fleetConfig;
  const id = path === "primary" ? "primary" : "secondary";
  const selected = path === "primary" ? primary : secondary;
  state.classicChannels = {
    getInstanceByChannel: (room: string, adapterId: string) => room === "room" && adapterId === id ? "classic" : undefined,
    getChannelIdByInstance: () => "room", getAdapterIdByInstance: () => id,
    getContextLines: () => 5, getAll: () => [{ instanceName: "classic" }],
  };
  // Exercise the real slash listener, forwarder, status resolver, and bubble
  // writer. Stub every process/IPC/startup side effect and the external API.
  state.topicCommands.registerBotCommands = vi.fn(async () => {});
  state.probeCliEnvs = vi.fn();
  state.startTopicCleanupPoller = vi.fn();
  state.getRecentChatLog = vi.fn(() => "");
  state.deliverToInstance = vi.fn(async () => {});
  state.getInstanceExecutionState = vi.fn(() => "working");
  state.logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  vi.spyOn(ClassicChannelManager, "logMessage").mockImplementation(() => {});
  await state.startSingleAdapter(fleetConfig, channels[0]);
  if (path === "additional") await state.startAdditionalAdapter(channels[1]);
  const respond = vi.fn(async (_text: string) => "slash-reply");
  async function chat(text = "hello", room = "room") {
    selected.emit("slash_command", {
      command: "chat", channelId: room, channelName: "test", userId: "human", username: "han", text, respond,
    });
    // safeHandler deliberately returns void. Drain its async chain without
    // invoking fleet timers, tmux, detached handlers, or a network client.
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(state.logger.error).not.toHaveBeenCalled();
  }
  return { fleet, state, selected, primary, secondary, channels, respond, chat };
}

describe("ClassicBot /chat uses connection status_emojis (#1105)", () => {
  for (const path of ["primary", "additional"] as const) {
    it(`${path}: received text, processing bubble/reaction, and done use configured forms`, async () => {
      const h = await harness(path, { received: "inbox:111111111111111111", processing: WORK, queued: "🔵", delivered: DONE });
      await h.chat();
      // Text must be a Discord tag, not the REST reaction form name:id.
      expect(h.respond).toHaveBeenCalledWith(INBOX);
      expect(h.state.deliverToInstance).toHaveBeenCalledWith("classic", expect.objectContaining({
        content: "hello", meta: expect.objectContaining({ message_id: "slash-reply", chat_id: "room", thread_id: "room" }),
      }));
      expect(h.selected.notifyAlert).toHaveBeenCalledWith("room", expect.objectContaining({ message: `${WORK} 處理中…` }), undefined);
      h.fleet.reactMessageStatus("classic", "room", "slash-reply", "processing", "room");
      h.fleet.finishDeliveryStatus("classic", "room", "slash-reply", "delivered", "room");
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(h.selected.react.mock.calls).toEqual([
        ["room", "slash-reply", "work:222222222222222222", "room"],
        ["room", "slash-reply", "done:333333333333333333", "room"],
      ]);
      const other = path === "primary" ? h.secondary : h.primary;
      expect(other.react).not.toHaveBeenCalled();
      expect(other.notifyAlert).not.toHaveBeenCalled();
      const entry = h.state.cancelButtons.get(`progress-${h.selected.id}`);
      vi.spyOn(Date, "now").mockReturnValue(entry.startedAt + 40_000);
      h.state.refreshBubble(entry);
      expect(h.selected.editAlert).toHaveBeenCalledWith("room", entry.messageId,
        expect.objectContaining({ message: "🔵 處理中… (已進行 0m 40s)" }), undefined);
    });

    it(`${path}: no settings preserves received and both default progress phases`, async () => {
      const h = await harness(path);
      await h.chat();
      expect(h.respond).toHaveBeenCalledWith("👀");
      expect(h.selected.notifyAlert).toHaveBeenCalledWith("room", expect.objectContaining({ message: "👀 處理中…" }), undefined);
      const entry = h.state.cancelButtons.get(`progress-${h.selected.id}`);
      vi.spyOn(Date, "now").mockReturnValue(entry.startedAt + 40_000);
      h.state.refreshBubble(entry);
      expect(h.selected.editAlert).toHaveBeenCalledWith("room", entry.messageId,
        expect.objectContaining({ message: "⏳ 處理中… (已進行 0m 40s)" }), undefined);
    });

    it(`${path}: invalid received falls back and custom progress prefix wins in both phases`, async () => {
      const h = await harness(path, { received: "not an emoji", processing: WORK, queued: "🔵", progress_prefix: "🐼" });
      await h.chat();
      expect(h.respond).toHaveBeenCalledWith("👀");
      expect(h.selected.notifyAlert).toHaveBeenCalledWith("room", expect.objectContaining({ message: "🐼 處理中…" }), undefined);
      const entry = h.state.cancelButtons.get(`progress-${h.selected.id}`);
      vi.spyOn(Date, "now").mockReturnValue(entry.startedAt + 40_000);
      h.state.refreshBubble(entry);
      expect(h.selected.editAlert).toHaveBeenCalledWith("room", entry.messageId,
        expect.objectContaining({ message: "🐼 處理中… (已進行 0m 40s)" }), undefined);
    });

    it(`${path}: missing text or missing instance never forwards`, async () => {
      const h = await harness(path, { received: INBOX });
      await h.chat("");
      expect(h.respond).not.toHaveBeenCalledWith(INBOX);
      await h.chat("hello", "unbound-room");
      expect(h.state.deliverToInstance).not.toHaveBeenCalled();
      expect(h.selected.notifyAlert).not.toHaveBeenCalled();
    });
  }

  it("reads updated connection settings without replacing the slash listener", async () => {
    const h = await harness("additional", { received: INBOX });
    await h.chat();
    h.channels[1]!.options!.status_emojis = { received: "📬" };
    // Keep this second invocation on the real slash path; the bubble is
    // unrelated to configuration refresh and already covered above.
    h.state.sendCancelButton = vi.fn(async () => {});
    await h.chat("new message");
    expect(h.respond.mock.calls.map(c => c[0])).toEqual([INBOX, "📬"]);
  });

  it("keeps the initial short phase even when elapsed text is configured to start immediately", async () => {
    const h = await harness("primary", { processing: WORK, queued: "🔵" });
    h.fleet.fleetConfig!.defaults.progress_min_elapsed = 0;
    await h.chat();
    expect(h.selected.notifyAlert).toHaveBeenCalledWith("room", expect.objectContaining({ message: `${WORK} 處理中…` }), undefined);
    const entry = h.state.cancelButtons.get("progress-primary");
    vi.spyOn(Date, "now").mockReturnValue(entry.startedAt + 1_000);
    h.state.refreshBubble(entry);
    expect(h.selected.editAlert).toHaveBeenCalledWith("room", entry.messageId,
      expect.objectContaining({ message: "🔵 處理中… (已進行 0m 01s)" }), undefined);
  });

  it("keeps Telegram's existing elapsed text despite its smaller reaction vocabulary", async () => {
    const h = await harness("primary");
    h.channels[0]!.type = "telegram";
    await h.chat();
    const entry = h.state.cancelButtons.get("progress-primary");
    vi.spyOn(Date, "now").mockReturnValue(entry.startedAt + 40_000);
    h.state.refreshBubble(entry);
    expect(h.selected.editAlert).toHaveBeenCalledWith("room", entry.messageId,
      expect.objectContaining({ message: "⏳ 處理中… (已進行 0m 40s)" }), undefined);
  });
});
