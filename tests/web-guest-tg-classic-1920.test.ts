/**
 * #1920 phase 2 (step 4b-3): the last doors to a guest's /web.
 * - Telegram (#1742 for guests): a guest whose /web could not reach them privately gets the bot's start link, and a
 *   START window. Its bare /start (once, within the window) or the link's /start web then sends their guest code to that
 *   DM. Any other bare /start is ClassicBot's, as before.
 * - /web typed in a ClassicBot room (a Telegram group needs `/web@ThisBot`; a private chat, plain /web) by someone who is
 *   not a fleet admin, while guest sign-in is on: their guest code, privately. A fleet admin's goes on as before.
 * - Discord ClassicBot rooms: the slash command, as everywhere, in this bot's own server (the door keeps /web there,
 *   for guests as for admins).
 * Rig: as dashboard-tg-dm-web-1742 (a real FleetManager with no fleet), with guest sign-in on.
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
import { tokenEpoch } from "../src/web-session.js";
import { setLocale, t } from "../src/locale.js";

const BOT = "myfleetbot", LINK = `https://t.me/${BOT}?start=web`, TOKEN = "c".repeat(48);
const CODE = /[A-Z2-7]{4}-[A-Z2-7]{4}/;
const rigs: Array<{ dir: string; fm: FleetManager }> = [];
let mono = 0;

function rig(platform: "telegram" | "discord" = "telegram") {
  const dir = mkdtempSync(join(tmpdir(), "agend-1920t-"));
  const fm = new FleetManager(dir), s = fm as any;
  let dmOpen = false;                                       // Telegram: a bot may DM a user only after their /start
  const adapter = {
    id: "owner", type: platform,
    sendText: vi.fn(async (chat: string, _text: string, opts?: any) => ({ chatId: chat, threadId: opts?.threadId, messageId: "msg" })),
    sendDirect: vi.fn(async (user: string, _text: string, _opts?: any): Promise<any> => {
      if (!dmOpen) throw new Error("403 Forbidden: bot can't initiate conversation with a user");
      return { chatId: user, messageId: "dm" };
    }),
    notifyAlert: vi.fn(async (chat: string) => ({ chatId: chat, messageId: "menu" })),
    stop: vi.fn(async () => {}),
  };
  const channel = { id: "owner", type: platform, group_id: "G", bot_token_env: "NONE", access: { mode: "allowlist", allowed_users: ["admin"] } };
  fm.fleetConfig = { defaults: {}, channel, channels: [channel], web: { guests: { enabled: true } }, instances: {
    general: { working_directory: dir, general_topic: true, topic_id: "T0", channel_id: "owner" },
    worker: { working_directory: dir, topic_id: "T1", channel_id: "owner" },
  } } as never;
  fm.routing.rebuild(fm.fleetConfig!);
  s.adapters.set("owner", adapter); s.adapter = adapter;
  s.worlds.set("owner", { adapter, groupId: "G", botUsername: BOT, channelConfig: channel, accessManager: { isAllowed: () => true, getMode: () => "allowlist" }, stop: async () => {} });
  writeFileSync(join(dir, "web.token"), TOKEN, { mode: 0o600 }); s.initializeWebSessions();
  vi.spyOn(fm, "getDashboardAccess").mockReturnValue({ ready: true, token: TOKEN });
  // ClassicBot's own start and rooms: watched, never run.
  const classic = vi.spyOn(s, "beginClassicBackendSelection").mockResolvedValue(undefined);
  vi.spyOn(s, "validateClassicStart").mockReturnValue(null);
  vi.spyOn(s, "handleClassicStart").mockResolvedValue("started");
  const classicRoom = "-1004242";
  s.classicChannels = { isClassicChannel: (id: string) => id === classicRoom || id === "C1", hasChannel: (id: string) => id === classicRoom || id === "C1", getAll: () => [],
    getChannelIdByInstance: () => undefined, getInstanceByChannel: () => undefined, isAdmin: () => false };
  const inbound = (chatId: string, text: string, userId = "alice") =>
    s.handleInboundMessage({ source: "telegram", adapterId: "owner", chatId, userId, username: userId, text, messageId: `m${Math.random()}`, timestamp: new Date() }).then(flush);
  const typedInGeneral = (user = "alice") =>
    s.topicCommands.handleGeneralCommand({ source: platform, adapterId: "owner", chatId: "G", threadId: "T0", userId: user, username: user, text: "/web", messageId: "in", timestamp: new Date() });
  const h = { dir, fm, s, adapter, classic, classicRoom, inbound, typedInGeneral, openDm: () => { dmOpen = true; } }; rigs.push(h); return h;
}
async function flush() { for (let n = 0; n < 60; n++) await Promise.resolve(); }
beforeEach(() => { setLocale("en"); mono = 1_000_000; vi.spyOn(performance, "now").mockImplementation(() => mono); });
afterEach(() => {
  for (const h of rigs.splice(0)) { h.fm.stormWindow.shutdown(); h.fm.spawnGate.shutdown(); rmSync(h.dir, { recursive: true, force: true }); }
  vi.restoreAllMocks();
});
const guestCodeIn = (h: ReturnType<typeof rig>, text: unknown) =>
  h.s.webGuestLoginCodes.match(CODE.exec(String(text))![0], tokenEpoch(TOKEN));

describe("Telegram: a guest's START after its /web could not reach it", () => {
  it("the link and a window; the bare /start then sends its guest code to that DM — once", async () => {
    const h = rig();
    await h.typedInGeneral();
    expect(h.adapter.sendText.mock.calls.at(-1)![1]).toBe(t("web.guest_dm_failed_link", LINK));
    h.openDm(); mono += 60_000;                              // they press START (and the minute is past)
    await h.inbound("alice", "/start");
    const dm = h.adapter.sendDirect.mock.calls.filter((c: any[]) => CODE.test(String(c[1]))).at(-1);   // the earlier one failed
    expect(dm?.[0]).toBe("alice");
    expect(guestCodeIn(h, dm![1])).toMatchObject({ kind: "ok", tier: "guest", recipient: { userId: "alice" } });
    expect(h.classic, "not ClassicBot's start").not.toHaveBeenCalled();
    // The window is used up: a later bare /start is ClassicBot's again.
    h.adapter.sendDirect.mockClear(); mono += 60_000;
    await h.inbound("alice", "/start");
    expect(h.adapter.sendDirect).not.toHaveBeenCalled();
    expect(h.classic).toHaveBeenCalled();
  });
  it("the link's /start web works with no window; a bare /start with none is ClassicBot's; guests off: nothing", async () => {
    const h = rig();
    h.openDm();
    await h.inbound("alice", "/start web");
    expect(guestCodeIn(h, h.adapter.sendDirect.mock.calls.find((c: any[]) => CODE.test(String(c[1])))![1])).toMatchObject({ kind: "ok" });
    const b = rig();
    b.openDm();
    await b.inbound("bob", "/start", "bob");
    expect(b.adapter.sendDirect).not.toHaveBeenCalled();
    expect(b.classic).toHaveBeenCalled();
    const off = rig();
    off.fm.fleetConfig!.web = { guests: { enabled: false } } as never;
    off.openDm();
    await off.inbound("alice", "/start web");
    expect(off.adapter.sendDirect).not.toHaveBeenCalled();
  });
});

describe("/web typed in a ClassicBot room", () => {
  it("a group needs /web@ThisBot: the guest's code privately, only a short line in the room; a bare /web is ignored", async () => {
    const h = rig();
    h.openDm();
    await h.inbound(h.classicRoom, "/web");
    expect(h.adapter.sendDirect).not.toHaveBeenCalled();
    await h.inbound(h.classicRoom, `/web@${BOT}`);
    const dm = h.adapter.sendDirect.mock.calls.find((c: any[]) => CODE.test(String(c[1])));
    expect(guestCodeIn(h, dm![1])).toMatchObject({ kind: "ok", recipient: { userId: "alice" } });
    const inRoom = h.adapter.sendText.mock.calls.filter((c: any[]) => c[0] === h.classicRoom).map((c: any[]) => c[1]);
    expect(inRoom).toEqual([t("web.guest_sent")]);
  });
  it("a private chat: plain /web, and /web revoke; a fleet admin's /web is not a guest's", async () => {
    const h = rig();
    h.openDm();
    await h.inbound("alice", "/web");
    expect(h.s.webGuestLoginCodes.hasCodeFor({ adapterId: "owner", userId: "alice" })).toBe(true);
    await h.inbound("alice", "/web revoke");
    expect(h.adapter.sendText.mock.calls.at(-1)![1]).toBe(t("web.guest_revoked", 0));
    expect(h.s.webGuestLoginCodes.hasCodeFor({ adapterId: "owner", userId: "alice" })).toBe(false);
    const guest = vi.spyOn(h.s, "guestWebCommand");
    await h.inbound(h.classicRoom, `/web@${BOT}`, "admin");
    expect(guest).not.toHaveBeenCalled();
  });
});

describe("Discord ClassicBot rooms", () => {
  it("the slash command in this bot's server: the room's door lets a guest through to its guest code; another server's: not", async () => {
    const h = rig("discord");
    h.openDm();
    const respond = vi.fn(async (_text: string) => "slash");
    await h.s.dispatchSlash({ command: "web", guildId: "G", channelId: "C1", userId: "alice", username: "alice", options: {}, respond, respondButtons: vi.fn(async () => "menu") }, "owner", h.adapter);
    expect(respond.mock.calls.map((c: any[]) => c[0])).toEqual([t("web.guest_sent")]);
    expect(h.s.webGuestLoginCodes.hasCodeFor({ adapterId: "owner", userId: "alice" })).toBe(true);
    // A room in another server: the door keeps /web for this bot's own server, as for an admin (unchanged here).
    respond.mockClear(); mono += 60_000;
    await h.s.dispatchSlash({ command: "web", guildId: "OTHER", channelId: "C1", userId: "bob", username: "bob", options: {}, respond, respondButtons: vi.fn(async () => "menu") }, "owner", h.adapter);
    expect(h.s.webGuestLoginCodes.hasCodeFor({ adapterId: "owner", userId: "bob" })).toBe(false);
  });
});
