/**
 * #1610: on a phone the public link's close button sits right above the code a user taps to copy (#1606), so closing
 * takes two steps: 確定關閉 / 取消 on the same message, with the same owner gate. Rig: a real FleetManager with no
 * fleet, as public-web-menu-1367 (spawners, tmux, backend and inspector mocked to throw).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
vi.mock("node:child_process", async original => ({ ...await original<typeof import("node:child_process")>(),
  spawn: () => { throw Error("No process"); }, execFile: () => { throw Error("No CLI"); }, execFileSync: () => { throw Error("No CLI"); }, execSync: () => { throw Error("No CLI"); }, spawnSync: () => { throw Error("No CLI"); } }));
vi.mock("node:inspector", () => ({ Session: class { constructor() { throw Error("No inspector"); } } }));
vi.mock("../src/backend/index.js", async original => ({ ...await original<typeof import("../src/backend/index.js")>(), createBackend: () => { throw Error("No backend"); } }));
vi.mock("../src/tmux-manager.js", async original => ({ ...await original<typeof import("../src/tmux-manager.js")>(), TmuxManager: new Proxy({}, { get: () => () => { throw Error("No tmux"); } }) }));
vi.mock("../src/logger.js", () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), child() { return this; } }) }));
import { FleetManager } from "../src/fleet-manager.js";
import { PublicWebLink } from "../src/public-web-link.js";
import { TunnelPurposeLane } from "../src/tunnel/purpose-lane.js";
import { tokenEpoch } from "../src/web-session.js";
import { setLocale, t } from "../src/locale.js";
const rigs: Array<{dir: string; fm: FleetManager; s: any}> = [];
let mono = 0;
function rig(platform: "telegram" | "discord" = "telegram") {
  const dir = mkdtempSync(join(tmpdir(), "agend-close-confirm-"));
  const fm = new FleetManager(dir), s = fm as any;
  const adapter = { id: "owner", type: platform, sendText: vi.fn(async (chat: string, _text: string, opts?: any) => ({ chatId: chat, threadId: opts?.threadId, messageId: "safe" })),
    notifyAlert: vi.fn(async (chat: string, _alert: any, opts?: any) => ({ chatId: chat, threadId: opts?.threadId, messageId: "menu" })),
    sendDirect: vi.fn(async (user: string, _text: string, _opts?: any) => ({ chatId: platform === "discord" ? "DM" : user, messageId: "dm" })),
    editMessageRemoveButtons: vi.fn(async () => {}), replaceMessageButtons: vi.fn(async () => {}), stop: vi.fn(async () => {}) };
  const owner = { id: "owner", type: platform, group_id: "G", bot_token_env: "NONE", access: { mode: "open", allowed_users: ["admin", "admin2"] } };
  fm.fleetConfig = { defaults: {}, channel: owner, channels: [owner, { ...owner, id: "other", group_id: "OTHER", access: { mode: "open", allowed_users: ["foreign-admin"] } }], instances: {
    general: { working_directory: dir, general_topic: true, topic_id: "T0", channel_id: "owner" },
    worker: { working_directory: dir, topic_id: "T1", channel_id: "owner" },
  } } as never;
  fm.routing.rebuild(fm.fleetConfig!); s.adapters.set("owner", adapter); s.adapter = adapter;
  s.worlds.set("owner", { adapter, groupId: "G", channelConfig: owner, accessManager: { isAllowed: () => true }, stop: async () => {} });
  s.classicChannels = { isClassicChannel: () => false, hasChannel: () => false };
  writeFileSync(join(dir, "web.token"), "c".repeat(48), { mode: 0o600 }); s.initializeWebSessions();
  vi.spyOn(fm, "getDashboardAccess").mockReturnValue({ ready: true, token: "c".repeat(48) });
  const manager = { start: vi.fn(async (_p: unknown, ctx: any) => { ctx.onCandidateHost("sample.trycloudflare.com"); return { ok: true as const, handle: { pageUrl: "https://sample.trycloudflare.com/signin", onUnexpectedExit: () => () => {} } }; }), stop: vi.fn(async () => ({ confirmed: true as const })) };
  const lane = new TunnelPurposeLane(manager as never);
  s.tunnelPurposeLane = lane;
  s.publicWebLink = new PublicWebLink({ dataDir: dir, web: () => fm.fleetConfig!.web, permitted: o => s.publicOwnerCurrent(o), reserve: id => lane.reserve("dashboard", id),
    createGateway: () => ({ listen: async () => new URL("http://127.0.0.1:12345"), setHost: () => {}, close: () => {}, readinessMarker: "stub" }) as never,
    ensure: async () => ({ path: "/pinned", source: "agend" }), provider: () => ({}) as never,
    revoke: id => { s.webLoginCodes.revokeAudience(id); s.webSessions.revokeExposure(id); }, log: () => {}, now: () => mono });
  const respond = vi.fn(async (_text: string) => "slash"), respondButtons = vi.fn(async (_text: string, _choices: any) => "slash-menu");
  async function typed(user = "admin", thread = "T0", text = "/dashboard") {
    return s.topicCommands.handleGeneralCommand({ source: platform, adapterId: "owner", chatId: "G", threadId: thread, userId: user, username: user, text, messageId: "in", timestamp: new Date() });
  }
  async function slash(user = "admin", channel = "T0", guild = "G", action?: string) {
    return s.dispatchSlash({ command: "dashboard", guildId: guild, channelId: channel, userId: user, username: user, options: { action }, respond, respondButtons }, "owner", adapter);
  }
  function nonce() { return [...s.pendingNonceButtons.values()].find((e: any) => e.chatId === "G") as any; }
  async function click(action = "public", overrides: any = {}) {
    const e = nonce(); expect(e).toBeTruthy();
    return s.dispatchAdapterCallback({ callbackData: `dashboard:${e.nonce}:${action}`, chatId: e.chatId, threadId: e.threadId, messageId: e.messageId, userId: "admin", ack: vi.fn(), ...overrides }, "owner", adapter);
  }
  const h = { dir, fm, s, adapter, owner, manager, typed, slash, click, nonce, respond, respondButtons }; rigs.push(h); return h;
}
async function flush() { for (let n = 0; n < 30; n++) await Promise.resolve(); }
beforeEach(() => { setLocale("en"); vi.useFakeTimers(); mono = 0; vi.spyOn(performance, "now").mockImplementation(() => mono); });
afterEach(async () => {
  for (const h of rigs.splice(0)) { await h.s.publicWebLink.close("test end"); for (const e of h.s.pendingNonceButtons.values()) clearTimeout(e.timer); h.fm.stormWindow.shutdown(); h.fm.spawnGate.shutdown(); rmSync(h.dir, { recursive: true, force: true }); }
  vi.useRealTimers(); vi.restoreAllMocks();
});

/** The close prompt's DM (Telegram: chat = the owner's user id) and a click on it. */
const dmClick = (h: ReturnType<typeof rig>, nonce: string, action: string, over: Record<string, unknown> = {}) =>
  h.s.dispatchAdapterCallback({ callbackData: `dashboard:${nonce}:${action}`, chatId: "admin", messageId: "dm", userId: "admin", ack: vi.fn(), ...over }, "owner", h.adapter);
const pending = (h: ReturnType<typeof rig>, step: boolean) => [...h.s.pendingNonceButtons.values()].find((e: any) => e.publicExposureId && !!e.closeStep === step) as any;
async function openLink(h: ReturnType<typeof rig>) {
  await h.typed(); await h.click("public");
  expect(h.s.publicWebLink.status().state).toBe("open");
  const close = pending(h, false); expect(close).toBeTruthy();
  return close;
}

describe("#1610: closing the public link takes two steps", () => {
  it("the first tap closes nothing: the same message's buttons become 確定關閉 / 取消, keyboard-only (the sign-in text stays)", async () => {
    const h = rig(); const close = await openLink(h);
    h.adapter.editMessageRemoveButtons.mockClear();
    await dmClick(h, close.nonce, "close");
    expect(h.s.publicWebLink.status().state).toBe("open");
    expect(h.manager.stop).not.toHaveBeenCalled();
    const step = pending(h, true); expect(step).toBeTruthy();
    expect(step.nonce).not.toBe(close.nonce);
    expect(step).toMatchObject({ messageId: "dm", chatId: "admin", requesterUserId: "admin", publicExposureId: close.publicExposureId });
    expect(h.adapter.replaceMessageButtons).toHaveBeenLastCalledWith("admin", "dm", [
      { id: `dashboard:${step.nonce}:confirm`, label: t("dashboard.public_close_confirm") },
      { id: `dashboard:${step.nonce}:keep`, label: t("dashboard.public_close_keep") }], undefined);
    expect(h.adapter.editMessageRemoveButtons).not.toHaveBeenCalled();      // the text (link and code) is never replaced
  });

  it("確定關閉 closes the link and retires the buttons", async () => {
    const h = rig(); const close = await openLink(h);
    await dmClick(h, close.nonce, "close");
    await dmClick(h, pending(h, true).nonce, "confirm");
    expect(h.s.publicWebLink.status().state).toBe("closed");
    expect(h.adapter.editMessageRemoveButtons).toHaveBeenLastCalledWith("admin", "dm", t("dashboard.public_closed"), undefined);
  });

  it("取消 puts the close button back (a fresh nonce), the link stays open, and the restored button again takes two steps", async () => {
    const h = rig(); const close = await openLink(h);
    await dmClick(h, close.nonce, "close");
    const step = pending(h, true);
    await dmClick(h, step.nonce, "keep");
    expect(h.s.publicWebLink.status().state).toBe("open");
    const again = pending(h, false);
    expect(again.nonce).not.toBe(close.nonce);
    expect(h.adapter.replaceMessageButtons).toHaveBeenLastCalledWith("admin", "dm", [{ id: `dashboard:${again.nonce}:close`, label: t("dashboard.public_close") }], undefined);
    await dmClick(h, again.nonce, "close");
    expect(h.s.publicWebLink.status().state).toBe("open");
  });

  it("someone other than the owner who asked cannot confirm — refused unconsumed, so the owner still can", async () => {
    const h = rig(); const close = await openLink(h);
    await dmClick(h, close.nonce, "close");
    const step = pending(h, true);
    const ack = vi.fn();
    await dmClick(h, step.nonce, "confirm", { userId: "admin2", ack });
    expect(ack).toHaveBeenCalledWith(t("buttons.wrong_place"));
    expect(h.s.publicWebLink.status().state).toBe("open");
    expect(h.s.pendingNonceButtons.get(step.nonce)).toBe(step);
    await dmClick(h, step.nonce, "confirm");
    expect(h.s.publicWebLink.status().state).toBe("closed");
  });

  it("a spent confirm cannot be replayed: after 取消, the old 確定關閉 is stale", async () => {
    const h = rig(); const close = await openLink(h);
    await dmClick(h, close.nonce, "close");
    const step = pending(h, true);
    await dmClick(h, step.nonce, "keep");
    const ack = vi.fn();
    await dmClick(h, step.nonce, "confirm", { ack });
    expect(ack).toHaveBeenCalledWith(t("buttons.stale_notice"));
    expect(h.s.publicWebLink.status().state).toBe("open");
  });

  it("Fable r1: a double tap on 關閉公開連結 leaves the message alone — no text edit, one swap — and the confirm still closes", async () => {
    const h = rig(); const close = await openLink(h);
    h.adapter.editMessageRemoveButtons.mockClear(); h.adapter.replaceMessageButtons.mockClear();
    await dmClick(h, close.nonce, "close");
    const ack = vi.fn();
    await dmClick(h, close.nonce, "close", { ack });                     // the second tap: a spent nonce
    expect(ack).toHaveBeenCalledWith(t("buttons.stale_notice"));
    expect(h.adapter.editMessageRemoveButtons).not.toHaveBeenCalled();
    expect(h.adapter.replaceMessageButtons).toHaveBeenCalledTimes(1);
    await dmClick(h, pending(h, true).nonce, "confirm");
    expect(h.s.publicWebLink.status().state).toBe("closed");
  });

  it("Fable r1: after 取消, the old 確定關閉 changes neither the text nor the restored button", async () => {
    const h = rig(); const close = await openLink(h);
    await dmClick(h, close.nonce, "close");
    const step = pending(h, true);
    await dmClick(h, step.nonce, "keep");
    h.adapter.editMessageRemoveButtons.mockClear(); h.adapter.replaceMessageButtons.mockClear();
    await dmClick(h, step.nonce, "confirm", { ack: vi.fn() });
    expect(h.adapter.editMessageRemoveButtons).not.toHaveBeenCalled();
    expect(h.adapter.replaceMessageButtons).not.toHaveBeenCalled();
    expect(pending(h, false)).toBeTruthy();                                // the restored close button is still live
    expect(h.s.publicWebLink.status().state).toBe("open");
  });

  it("#1617: another bot's live prompt on a colliding message id does not hold back this bot's stale-click cleanup", async () => {
    const h = rig(); const close = await openLink(h);
    await dmClick(h, close.nonce, "close");                                   // bot "owner" now has a live confirm step on DM "dm"
    // A second bot, same user, same DM message id: its stale button is collapsed as any stale button is.
    const other = { id: "other", type: "telegram", editMessageRemoveButtons: vi.fn(async () => {}), sendText: vi.fn(async () => ({ messageId: "x", chatId: "admin" })) };
    const ack = vi.fn();
    const claimed = h.s.consumeNonceCallback("dashboard:", /^dashboard:([0-9a-f]{32}):(local|public|close|confirm|keep)$/,
      { callbackData: `dashboard:${close.nonce}:close`, chatId: "admin", messageId: "dm", userId: "admin", ack }, "other", other);
    expect(claimed).toBe("consumed");
    expect(other.editMessageRemoveButtons).toHaveBeenCalledWith("admin", "dm", t("buttons.stale"), undefined);
    // …while the same click through the bot that owns the live step leaves the message alone (#1610).
    h.adapter.editMessageRemoveButtons.mockClear();
    await dmClick(h, close.nonce, "close", { ack: vi.fn() });
    expect(h.adapter.editMessageRemoveButtons).not.toHaveBeenCalled();
    expect(pending(h, true)).toBeTruthy();
  });

  it("a confirm on the close button's own nonce, or a close on the confirm step, is refused unconsumed", async () => {
    const h = rig(); const close = await openLink(h);
    const ack = vi.fn();
    await dmClick(h, close.nonce, "confirm", { ack });
    expect(ack).toHaveBeenCalledWith(t("buttons.admin_only"));
    expect(h.s.publicWebLink.status().state).toBe("open");
    expect(h.s.pendingNonceButtons.get(close.nonce)).toBe(close);
    await dmClick(h, close.nonce, "close");
    const step = pending(h, true);
    await dmClick(h, step.nonce, "close", { ack: vi.fn() });
    expect(h.s.pendingNonceButtons.get(step.nonce)).toBe(step);
    expect(h.s.publicWebLink.status().state).toBe("open");
  });

  it("if the buttons cannot be swapped, nothing closes and no confirm step is left armed", async () => {
    const h = rig(); const close = await openLink(h);
    h.adapter.replaceMessageButtons.mockRejectedValueOnce(new Error("message too old"));
    await dmClick(h, close.nonce, "close");
    expect(h.s.publicWebLink.status().state).toBe("open");
    expect(pending(h, true)).toBeUndefined();
  });

  it("an unanswered confirm step lapses after 5 minutes and closes nothing", async () => {
    const h = rig(); const close = await openLink(h);
    await dmClick(h, close.nonce, "close");
    const step = pending(h, true);
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 1);
    expect(h.s.pendingNonceButtons.has(step.nonce)).toBe(false);
    expect(h.manager.stop).not.toHaveBeenCalled();
  });

  it("/dashboard revoke stays one step", async () => {
    const h = rig(); await openLink(h);
    await h.typed("admin", "T0", "/dashboard revoke"); await flush(); await vi.advanceTimersByTimeAsync(0); await flush();
    expect(h.s.publicWebLink.status().state).toBe("closed");
    expect(pending(h, true)).toBeUndefined();     // no confirm step was offered
  });
});

describe("#1610: the Telegram adapter replaces a message's buttons keyboard-only", () => {
  it("replaceMessageButtons calls editMessageReplyMarkup with the new keyboard and no text", async () => {
    const { TelegramAdapter } = await import("../src/channel/adapters/telegram.js");
    const dir = mkdtempSync(join(tmpdir(), "agend-close-confirm-tg-"));
    try {
      const adapter = new TelegramAdapter({ id: "tg", botToken: "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi", accessManager: { isAllowed: () => ({ allowed: true }) } as never, inboxDir: dir });
      const calls: Array<{ method: string; payload: any }> = [];
      (adapter.getBot() as any).api.config.use(async (_prev: unknown, method: string, payload: any) => { calls.push({ method, payload }); return { ok: true, result: true }; });
      await adapter.replaceMessageButtons("42", "7", [{ id: "dashboard:x:confirm", label: "確定關閉" }, { id: "dashboard:x:keep", label: "取消" }]);
      expect(calls).toEqual([{ method: "editMessageReplyMarkup", payload: { chat_id: 42, message_id: 7,
        reply_markup: { inline_keyboard: [[{ text: "確定關閉", callback_data: "dashboard:x:confirm" }], [{ text: "取消", callback_data: "dashboard:x:keep" }]] } } }]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

