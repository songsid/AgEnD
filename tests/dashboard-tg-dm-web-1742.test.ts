/**
 * #1742: Telegram /web sign-in finishes in the DM. A fleet admin's `/start web` (the #1686 deep link) shows the /web
 * menu right in that DM — bound to the DM chat, owned by the General `/web` there would make — and the code comes to
 * the same DM. Telegram failure texts walk through opening the DM and never say a bare /start (that starts a
 * ClassicBot agent); for 10 minutes after one, that admin's bare /start (Telegram's START button) is /start web, once.
 * Discord is unchanged. Rig as #1686's (dashboard-tg-start-web-1686).
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
import { setLocale, t } from "../src/locale.js";

const VALID = "myfleetbot";
const LINK = `https://t.me/${VALID}?start=web`;
const CODE = /[A-Z2-7]{4}-[A-Z2-7]{4}/;
/** A bare "/start" — anything but "/start web". */
const BARE_START = /\/start(?! web)/;
const rigs: Array<{ dir: string; fm: FleetManager; s: any }> = [];
let mono = 0;

function makeAdapter(platform: "telegram" | "discord") {
  return {
    id: "owner", type: platform,
    sendText: vi.fn(async (chat: string, _text: string, opts?: any) => ({ chatId: chat, threadId: opts?.threadId, messageId: "msg" })),
    sendDirect: vi.fn(async (_u: string, _text: string, _opts?: any): Promise<any> => { throw new Error("403 Forbidden: bot can't initiate conversation"); }),
    notifyAlert: vi.fn(async (chat: string, _alert: any, opts?: any) => ({ chatId: chat, threadId: opts?.threadId, messageId: chat === "G" ? "menu" : "dm-menu" })),
    editMessageRemoveButtons: vi.fn(async (..._a: any[]) => {}),
    replaceMessageButtons: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
  };
}

function rig(platform: "telegram" | "discord" = "telegram", opts: { username?: string | null; generals?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "agend-1742-"));
  const fm = new FleetManager(dir);
  const s = fm as any;
  const adapter = makeAdapter(platform);
  const channelConfig = { id: "owner", type: platform, group_id: "G", bot_token_env: "NONE", access: { mode: "open", allowed_users: ["admin"] } };
  const instances: Record<string, unknown> = {};
  for (let i = 0; i < (opts.generals ?? 1); i++) instances[`general${i || ""}`] = { working_directory: dir, general_topic: true, topic_id: `T${i}`, channel_id: "owner" };
  fm.fleetConfig = { defaults: {}, channel: channelConfig, channels: [channelConfig], instances } as never;
  fm.routing.rebuild(fm.fleetConfig!);
  s.adapters.set("owner", adapter); s.adapter = adapter;
  const username = opts.username === undefined ? VALID : opts.username;
  s.worlds.set("owner", { adapter, groupId: "G", botUsername: username ?? undefined, channelConfig, accessManager: { isAllowed: () => true }, stop: async () => {} });
  s.classicChannels = { isClassicChannel: () => false, hasChannel: () => false, isAdmin: () => false, isUserAllowed: () => true, isGuildAllowed: () => false, isGroupAllowed: () => false, deriveInstanceName: () => "", getInstanceByChannel: () => undefined };
  writeFileSync(join(dir, "web.token"), "c".repeat(48), { mode: 0o600 });
  s.initializeWebSessions();
  vi.spyOn(fm, "getDashboardAccess").mockReturnValue({ ready: true, token: "c".repeat(48) });
  vi.spyOn(s, "isFleetAdmin").mockImplementation((u: unknown) => u === "admin");
  // ClassicBot's own start: watched, never run (a bare /start that is not /start web lands here).
  const classic = vi.spyOn(s, "beginClassicBackendSelection").mockResolvedValue(undefined);
  vi.spyOn(s, "validateClassicStart").mockReturnValue(null);
  const classicStart = vi.spyOn(s, "handleClassicStart").mockResolvedValue("started");

  async function typed(user = "admin") {
    return s.topicCommands.handleGeneralCommand({ source: platform, adapterId: "owner", chatId: "G", threadId: "T0", userId: user, username: user, text: "/web", messageId: "in", timestamp: new Date() });
  }
  const entryIn = (chat: string) => [...s.pendingNonceButtons.values()].find((e: any) => e.prefix === "dashboard:" && e.chatId === chat) as any;
  async function click(chat: string, action = "local", user = "admin", from = chat) {
    const e = entryIn(chat); if (!e) throw new Error(`no menu in ${chat}`);
    const ack = vi.fn();
    await s.dispatchAdapterCallback({ callbackData: `dashboard:${e.nonce}:${action}`, chatId: from, threadId: e.threadId, messageId: e.messageId, userId: user, ack }, "owner", adapter);
    await flush();
    return ack;
  }
  async function dm(text: string, userId = "admin") {
    await s.handleInboundMessage({ source: "telegram", adapterId: "owner", chatId: userId, userId, username: userId, text, messageId: `m${Math.random()}`, timestamp: new Date() });
    await flush();
  }
  const h = { dir, fm, s, adapter, typed, entryIn, click, dm, classic, classicStart };
  rigs.push(h); return h;
}

async function flush() { for (let n = 0; n < 60; n++) await Promise.resolve(); }
const lastEdit = (h: ReturnType<typeof rig>) => h.adapter.editMessageRemoveButtons.mock.calls.at(-1) as any[] | undefined;

beforeEach(() => { setLocale("en"); vi.useFakeTimers(); mono = 0; vi.spyOn(performance, "now").mockImplementation(() => mono); });
afterEach(async () => {
  for (const h of rigs.splice(0)) {
    for (const e of h.s.pendingNonceButtons.values()) clearTimeout(e.timer);
    h.fm.stormWindow.shutdown(); h.fm.spawnGate.shutdown();
    rmSync(h.dir, { recursive: true, force: true });
  }
  vi.useRealTimers(); vi.restoreAllMocks(); setLocale("en");
});

describe("/start web from a fleet admin: the /web menu in the DM, the code to the same DM", () => {
  it("the menu is posted in the DM, bound to that chat and that admin, owned by the General; no deep-link hint in it", async () => {
    const h = rig();
    await h.dm("/start web");
    const [chat, alert, opts] = h.adapter.notifyAlert.mock.calls[0] ?? [];
    const e = h.entryIn("admin");
    expect([chat, opts?.threadId, String(alert?.message).includes("t.me"), e?.requesterUserId,
      e && { chatId: e.dashboardOwner.chatId, threadId: e.dashboardOwner.threadId, userId: e.dashboardOwner.userId }, h.classic.mock.calls.length, h.classicStart.mock.calls.length])
      .toEqual(["admin", undefined, false, "admin", { chatId: "G", threadId: "T0", userId: "admin" }, 0, 0]);
  });

  it("LAN there: the code goes to that DM (with the code alone after it); the menu says the details are below; nothing in General", async () => {
    const h = rig();
    h.adapter.sendDirect.mockImplementation(async (u: string) => ({ chatId: u, messageId: "dm" }));
    await h.dm("/start web");
    await h.click("admin", "local");
    const direct = h.adapter.sendDirect.mock.calls.map((c: any[]) => [c[0], CODE.test(String(c[1]))]);
    const edit = lastEdit(h);
    const toGeneral = h.adapter.sendText.mock.calls.filter((c: any[]) => c[0] === "G");
    expect([direct, edit?.[0], edit?.[2], toGeneral.length]).toEqual([[["admin", true], ["admin", true]], "admin", t("dashboard.private_sent_below"), 0]);
  });

  it("refused: another user's tap, a tap claimed from another chat, and the General gone before the tap — no code", async () => {
    const h = rig();
    h.adapter.sendDirect.mockImplementation(async (u: string) => ({ chatId: u, messageId: "dm" }));
    await h.dm("/start web");
    await h.click("admin", "local", "stranger");
    await h.click("admin", "local", "admin", "G");
    const afterWrong = h.adapter.sendDirect.mock.calls.length;
    h.fm.fleetConfig = { ...h.fm.fleetConfig!, instances: {} } as never;
    await h.click("admin", "local");
    expect([afterWrong, h.adapter.sendDirect.mock.calls.length]).toEqual([0, 0]);
  });

  it("a non-admin's /start web: no menu, no code, no ClassicBot", async () => {
    const h = rig();
    await h.dm("/start web", "stranger");
    expect([h.adapter.notifyAlert.mock.calls.length, h.adapter.sendDirect.mock.calls.length, h.adapter.sendText.mock.calls.length, h.classic.mock.calls.length, h.classicStart.mock.calls.length])
      .toEqual([0, 0, 0, 0, 0]);
  });

  it("the DM's owner: none for a non-admin, none when this bot's binding is stale, none from a chat that is not the admin's own", async () => {
    const h = rig();
    const asAdmin = h.s.dmDashboardOwner("admin", "owner");
    const asStranger = h.s.dmDashboardOwner("stranger", "owner");
    h.s.adapters.set("owner", makeAdapter("telegram"));   // a replaced adapter: the world's binding is no longer current
    const stale = h.s.dmDashboardOwner("admin", "owner");
    h.s.adapters.set("owner", h.adapter);
    await h.s.handleInboundMessage({ source: "telegram", adapterId: "owner", chatId: "424242", userId: "admin", username: "admin", text: "/start web", messageId: "x", timestamp: new Date() });
    await flush();
    expect([asAdmin && [asAdmin.chatId, asAdmin.threadId], asStranger, stale, h.adapter.notifyAlert.mock.calls.length, h.adapter.sendText.mock.calls.map((c: any[]) => [c[0], c[1]])])
      .toEqual([["G", "T0"], null, null, 0, [["424242", t("dashboard.start_web_ack")]]]);
  });

  it("no General to speak for, or two on this bot: nothing is guessed — the ack, no menu", async () => {
    const out = [];
    for (const generals of [0, 2]) {
      const h = rig("telegram", { generals });
      await h.dm("/start web");
      out.push([h.adapter.notifyAlert.mock.calls.length, h.adapter.sendText.mock.calls.map((c: any[]) => c[1])]);
    }
    expect(out).toEqual([[0, [t("dashboard.start_web_ack")]], [0, [t("dashboard.start_web_ack")]]]);
  });
});

describe("Telegram failure texts: the DM, step by step — never a bare /start", () => {
  it("username known: the steps and the 先開私訊 → button; unknown: send /start web; neither has a bare /start (en and zh-TW)", async () => {
    const out = [];
    for (const username of [VALID, null]) {
      const h = rig("telegram", { username });
      await h.typed(); await h.click("G", "local");
      const edit = lastEdit(h);
      out.push([edit?.[2], edit?.[4]]);
    }
    expect(out).toEqual([
      [t("dashboard.private_failed_tg"), [{ label: t("dashboard.start_web_label"), url: LINK }]],
      [t("dashboard.private_failed_tg_nolink"), undefined]]);
    const texts = [];
    for (const lang of ["en", "zh-TW"] as const) {
      setLocale(lang);
      texts.push(t("dashboard.private_failed_tg"), t("dashboard.private_failed_tg_nolink"), t("dashboard.menu_tg_hint", LINK));
    }
    expect(texts.filter((x) => BARE_START.test(x) || CODE.test(x))).toEqual([]);
    expect(texts.filter((x) => x.includes("/start web")).length, "the no-link text names the exact command").toBe(2);
  });

  it("a link that fails before any DM is tried (the public link never starts): no DM steps, no button, no /start window — it says the link did not start", async () => {
    const h = rig();
    vi.spyOn(h.s, "getPublicWebLink").mockReturnValue({ deliver: async () => false, status: () => ({ state: "closed" }) });
    await h.typed(); await h.click("G", "public");
    const edit = lastEdit(h);
    expect([edit?.[2], edit?.[4], h.adapter.sendDirect.mock.calls.length, h.s.tgWebStartWindows.size]).toEqual([t("dashboard.link_failed"), undefined, 0, 0]);
    const texts = (["en", "zh-TW"] as const).map((lang) => { setLocale(lang); return t("dashboard.link_failed"); });
    expect(texts.filter((x) => BARE_START.test(x) || CODE.test(x) || /私訊|private/i.test(x))).toEqual([]);
  });

  it("control: the same public link reaching the DM step and refused there gets the DM steps, the button and the window", async () => {
    const h = rig();
    vi.spyOn(h.s, "getPublicWebLink").mockReturnValue({ deliver: async (_o: unknown, send: (l: any) => Promise<boolean>) => send({ url: "https://x.trycloudflare.com", exposureId: "e".repeat(32), expiresAt: Date.now() + 60_000, isCurrent: () => true }), status: () => ({ state: "open" }) });
    await h.typed(); await h.click("G", "public");
    const edit = lastEdit(h);
    expect([edit?.[2], edit?.[4]?.[0]?.url, h.adapter.sendDirect.mock.calls.length > 0, h.s.tgWebStartWindows.size]).toEqual([t("dashboard.private_failed_tg"), LINK, true, 1]);
  });

  it("the outcome's edit fails: the outcome is posted with its button", async () => {
    const h = rig();
    await h.typed();
    h.adapter.editMessageRemoveButtons.mockRejectedValue(new Error("message can't be edited"));
    await h.click("G", "local");
    const posted = h.adapter.sendText.mock.calls.find((c: any[]) => c[1] === t("dashboard.private_failed_tg"));
    expect([posted?.[0], posted?.[2]?.urlButtons]).toEqual(["G", [{ label: t("dashboard.start_web_label"), url: LINK }]]);
  });

  it("the General menu's hint walks the same steps", async () => {
    const h = rig();
    await h.typed();
    expect(String(h.adapter.notifyAlert.mock.calls[0]?.[1]?.message)).toContain(t("dashboard.menu_tg_hint", LINK));
  });
});

describe("a bare /start soon after a failed /web is /start web — once, for that admin, within 10 minutes", () => {
  async function failed(h: ReturnType<typeof rig>) { await h.typed(); await h.click("G", "local"); }

  it("within the window: the DM menu, no ClassicBot; the same bare /start again: ClassicBot as before", async () => {
    const h = rig();
    await failed(h);
    mono += 9 * 60_000;
    await h.dm("/start");
    const first = [h.adapter.notifyAlert.mock.calls.map((c: any[]) => c[0]), h.classic.mock.calls.length];
    await h.dm("/start");
    expect([first, h.classic.mock.calls.length]).toEqual([[["G", "admin"], 0], 1]);
  });

  it("after the window, from another user, or with no failed /web: ClassicBot as before", async () => {
    const late = rig();
    await failed(late); mono += 10 * 60_000; await late.dm("/start");
    const other = rig();
    vi.spyOn(other.s, "isFleetAdmin").mockImplementation((u: unknown) => u === "admin" || u === "admin2");
    await failed(other); await other.dm("/start", "admin2");
    const none = rig();
    await none.dm("/start");
    expect([late, other, none].map((h) => [h.adapter.notifyAlert.mock.calls.filter((c: any[]) => c[0] !== "G").length, h.classic.mock.calls.length]))
      .toEqual([[0, 1], [0, 1], [0, 1]]);
  });

  it("an admin no longer an admin when the bare /start comes: ClassicBot as before", async () => {
    const h = rig();
    await failed(h);
    vi.spyOn(h.s, "isFleetAdmin").mockReturnValue(false);
    await h.dm("/start");
    expect([h.adapter.notifyAlert.mock.calls.filter((c: any[]) => c[0] !== "G").length, h.classic.mock.calls.length]).toEqual([0, 1]);
  });

  it("/start web uses the window up; /start <backend> is never read as web", async () => {
    const h = rig();
    await failed(h);
    await h.dm("/start web");
    await h.dm("/start");
    const afterWeb = h.classic.mock.calls.length;
    await failed(h);
    await h.dm("/start claude");
    expect([afterWeb, h.classicStart.mock.calls.map((c: any[]) => c[5])]).toEqual([1, ["claude"]]);
  });
});

describe("Discord is unchanged", () => {
  it("a failed /web there: the same failure text, no link button, no /start window", async () => {
    const h = rig("discord");
    // Discord's menu is the /web slash command's: posted here through the same owner and nonce path.
    expect(await h.s.showDashboardMenu(h.s.dashboardOwner("admin", "owner", "G", "T0"))).toBe(true);
    await h.click("G", "local");
    const edit = lastEdit(h);
    expect([edit?.[2], edit?.length, h.s.tgWebStartWindows.size]).toEqual([t("dashboard.private_failed"), 4, 0]);
  });
});
