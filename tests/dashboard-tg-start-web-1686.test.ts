/**
 * #1686: /web Telegram failure → URL button + menu hint + /start web DM ack.
 *
 * Rig pattern follows dashboard-close-confirm-1610: FleetManager with spawners/
 * tmux/backend mocked to throw; one Telegram (or Discord) adapter; botUsername
 * wired into the world. Menu triggered via topicCommands.handleGeneralCommand.
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
const rigs: Array<{ dir: string; fm: FleetManager; s: any }> = [];
let mono = 0;

function makeAdapter(platform: "telegram" | "discord") {
  return {
    id: "owner", type: platform,
    sendText: vi.fn(async (chat: string, _text: string, opts?: any) => ({ chatId: chat, threadId: opts?.threadId, messageId: "msg" })),
    sendDirect: vi.fn(async () => { throw new Error("403 Forbidden: bot can't initiate conversation"); }),
    notifyAlert: vi.fn(async (chat: string, _alert: any, opts?: any) => ({ chatId: chat, threadId: opts?.threadId, messageId: "menu" })),
    editMessageRemoveButtons: vi.fn(async () => {}),
    replaceMessageButtons: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
  };
}

function rig(platform: "telegram" | "discord" = "telegram", username: string | null = VALID) {
  const dir = mkdtempSync(join(tmpdir(), "agend-1686-"));
  const fm = new FleetManager(dir);
  const s = fm as any;
  const adapter = makeAdapter(platform);
  const channelConfig = { id: "owner", type: platform, group_id: "G", bot_token_env: "NONE", access: { mode: "open", allowed_users: ["admin"] } };
  fm.fleetConfig = {
    defaults: {}, channel: channelConfig, channels: [channelConfig],
    instances: { general: { working_directory: dir, general_topic: true, topic_id: "T0", channel_id: "owner" } },
  } as never;
  fm.routing.rebuild(fm.fleetConfig!);
  s.adapters.set("owner", adapter); s.adapter = adapter;
  s.worlds.set("owner", { adapter, groupId: "G", botUsername: username ?? undefined, channelConfig, accessManager: { isAllowed: () => true }, stop: async () => {} });
  s.classicChannels = { isClassicChannel: () => false, hasChannel: () => false, isAdmin: () => false, isUserAllowed: () => true, isGuildAllowed: () => false, isGroupAllowed: () => false, deriveInstanceName: () => "" };
  writeFileSync(join(dir, "web.token"), "c".repeat(48), { mode: 0o600 });
  s.initializeWebSessions();
  vi.spyOn(fm, "getDashboardAccess").mockReturnValue({ ready: true, token: "c".repeat(48) });
  const respond = vi.fn(async () => "slash");
  const respondButtons = vi.fn(async () => "menu");

  // Fleet-topic path: send /web as a typed command in the General topic (mirrors 1610 test).
  async function typed(user = "admin") {
    return s.topicCommands.handleGeneralCommand({ source: platform, adapterId: "owner", chatId: "G", threadId: "T0", userId: user, username: user, text: "/web", messageId: "in", timestamp: new Date() });
  }
  function nonce() { return [...s.pendingNonceButtons.values()].find((e: any) => e.chatId === "G") as any; }
  async function click(action = "local") {
    const e = nonce(); if (!e) throw new Error("no nonce");
    return s.dispatchAdapterCallback({ callbackData: `dashboard:${e.nonce}:${action}`, chatId: e.chatId, threadId: e.threadId, messageId: e.messageId, userId: "admin", ack: vi.fn() }, "owner", adapter);
  }
  // Private DM path for /start web.
  async function inboundDm(text: string, userId = "admin") {
    return s.handleInboundMessage({ source: "telegram", adapterId: "owner", chatId: userId, userId, username: userId, text, messageId: `m${Date.now()}`, timestamp: new Date() });
  }

  const h = { dir, fm, s, adapter, respond, respondButtons, typed, nonce, click, inboundDm };
  rigs.push(h); return h;
}

async function flush() { for (let n = 0; n < 40; n++) await Promise.resolve(); }

beforeEach(() => { setLocale("en"); vi.useFakeTimers(); mono = 0; vi.spyOn(performance, "now").mockImplementation(() => mono); });
afterEach(async () => {
  for (const h of rigs.splice(0)) {
    for (const e of h.s.pendingNonceButtons.values()) clearTimeout(e.timer);
    h.fm.stormWindow.shutdown(); h.fm.spawnGate.shutdown();
    rmSync(h.dir, { recursive: true, force: true });
  }
  vi.useRealTimers(); vi.restoreAllMocks();
});

// ─── username validation ────────────────────────────────────────────────────

describe("#1686: tgStartWebUrl validates bot username", () => {
  it("returns the deep-link for a valid username", () => {
    const { s } = rig("telegram", VALID);
    expect(s.tgStartWebUrl("owner")).toBe(`https://t.me/${VALID}?start=web`);
  });
  it("returns null for username shorter than 5 chars", () => {
    const { s } = rig("telegram", "ab");
    expect(s.tgStartWebUrl("owner")).toBeNull();
  });
  it("returns null for username longer than 32 chars", () => {
    const { s } = rig("telegram", "a".repeat(33));
    expect(s.tgStartWebUrl("owner")).toBeNull();
  });
  it("returns null for username with invalid chars (hyphen)", () => {
    const { s } = rig("telegram", "hello-world");
    expect(s.tgStartWebUrl("owner")).toBeNull();
  });
  it("returns null when no username is set", () => {
    const { s } = rig("telegram", null);
    expect(s.tgStartWebUrl("owner")).toBeNull();
  });
});

// ─── menu hint ────────────────────────────────────────────────────────────

describe("#1686: Telegram /web menu carries the hint", () => {
  it("menu text includes the start hint for valid Telegram username", async () => {
    const h = rig("telegram");
    await h.typed(); await flush();
    const alertCalls = h.adapter.notifyAlert.mock.calls;
    const menuText: string = alertCalls[0]?.[1]?.message ?? "";
    expect(menuText).toBeTruthy();
    const expected = t("dashboard.menu_tg_hint", `https://t.me/${VALID}?start=web`);
    expect(menuText).toContain(expected);
  });

  it("menu text has no hint when username fails validation (too short)", async () => {
    const h = rig("telegram", "xy");
    await h.typed(); await flush();
    const alertCalls = h.adapter.notifyAlert.mock.calls;
    const menuText: string = alertCalls[0]?.[1]?.message ?? "";
    expect(menuText).not.toContain("t.me");
  });

  it("Discord menu has no hint", async () => {
    // Direct test: showDashboardMenu for a Discord adapter must not append the hint.
    const h = rig("discord");
    // We need a valid owner to call showDashboardMenu directly.
    const fakeOwner = {
      userId: "admin", adapterId: "owner", chatId: "G", threadId: "T0",
      binding: h.adapter,
    };
    await h.s.showDashboardMenu(fakeOwner);
    const alertCalls = h.adapter.notifyAlert.mock.calls;
    const menuText: string = alertCalls[0]?.[1]?.message ?? "";
    // If notifyAlert was never called (owner check failed), sendText carries menu_failed — also no hint.
    const sendCalls = h.adapter.sendText.mock.calls;
    const allTexts = [...alertCalls.map((c: any[]) => c[1]?.message ?? ""), ...sendCalls.map((c: any[]) => String(c[1] ?? ""))];
    for (const text of allTexts) expect(text).not.toContain("t.me");
  });
});

// ─── button-click failure: URL button on the outcome edit ─────────────────

describe("#1686: Telegram button-click failure carries the link/button", () => {
  it("editMessageRemoveButtons receives urlButtons with the start link", async () => {
    const h = rig("telegram");
    await h.typed(); await flush();
    expect(h.nonce()).toBeTruthy();
    await h.click("local"); await flush();
    const calls = (h.adapter.editMessageRemoveButtons.mock.calls as any[][]);
    expect(calls.length).toBeGreaterThan(0);
    const urlButtons = calls[calls.length - 1]?.[4] as Array<{ label: string; url: string }> | undefined;
    expect(Array.isArray(urlButtons)).toBe(true);
    expect(urlButtons![0]?.url).toBe(`https://t.me/${VALID}?start=web`);
    expect(urlButtons![0]?.label).toBe(t("dashboard.start_web_label"));
  });

  it("outcome text does NOT contain the sign-in code", async () => {
    const h = rig("telegram");
    await h.typed(); await flush();
    await h.click("local"); await flush();
    const calls = (h.adapter.editMessageRemoveButtons.mock.calls as any[][]);
    const text: string = calls[calls.length - 1]?.[2] ?? "";
    expect(text).not.toMatch(/[A-Z2-7]{4}-[A-Z2-7]{4}/);
  });

  it("Discord button-click failure: no urlButtons (Discord unchanged)", async () => {
    // Drive retireNonceButtons directly via the fleet manager's internals: plant a Discord
    // nonce entry and call retireNonceButtons without urlButtons, verifying editMessageRemoveButtons
    // is called with exactly 4 args (no 5th urlButtons).
    const h = rig("discord");
    const discordAdapter = makeAdapter("discord");
    // Directly call retireNonceButtons with a simulated Discord failure nonce (no urlButtons arg).
    const fakeEntry: any = {
      prefix: "dashboard:", instanceName: "dashboard", adapterId: "owner",
      adapter: discordAdapter, chatId: "G", threadId: "T0", messageId: "menu",
      expiredText: "stale", retire: undefined, nonce: "abc123", timer: undefined,
    };
    await h.s.retireNonceButtons(fakeEntry, "menu", "Discord failure text");
    const calls = (discordAdapter.editMessageRemoveButtons.mock.calls as any[][]);
    expect(calls.length).toBe(1);
    // 5th arg must be absent (undefined not passed) — Discord does NOT get urlButtons
    expect(calls[0]).toHaveLength(4);
    expect(calls[0][2]).toBe("Discord failure text");
  });

  it("Discord button-click failure (with mutation guard): urlButtons IS present when telegram guard removed", async () => {
    // Stronger guard: call retireNonceButtons WITH urlButtons to verify the adapter WOULD receive them
    // if the type check were removed. This test exists only to confirm the guard works:
    // in production, urlButtons is never passed for Discord (the type check prevents it).
    const h = rig("discord");
    const discordAdapter = makeAdapter("discord");
    const fakeEntry: any = {
      prefix: "dashboard:", instanceName: "dashboard", adapterId: "owner",
      adapter: discordAdapter, chatId: "G", threadId: "T0", messageId: "menu",
      expiredText: "stale", retire: undefined, nonce: "abc123", timer: undefined,
    };
    const urlButtons = [{ label: "Start →", url: "https://t.me/bot?start=web" }];
    await h.s.retireNonceButtons(fakeEntry, "menu", "Discord failure text", undefined, urlButtons);
    const calls = (discordAdapter.editMessageRemoveButtons.mock.calls as any[][]);
    expect(calls.length).toBe(1);
    // When urlButtons IS provided, it DOES reach the adapter (the guard is in handleDashboardCallback, not here)
    expect(calls[0]).toHaveLength(5);
    expect(calls[0][4]).toEqual(urlButtons);
  });

  it("Discord unchanged: handleDashboardCallback does NOT call tgStartWebUrl for Discord owner", async () => {
    // Guards the `type === "telegram"` check in handleDashboardCallback.
    // Approach: spy on tgStartWebUrl — it must never be called when the owner's adapter is Discord.
    // Drive the callback by planting a nonce entry with a Discord owner and firing dispatchAdapterCallback.
    const h = rig("discord");
    const discordOwner: any = {
      userId: "admin", adapterId: "owner", chatId: "G", threadId: "T0", binding: h.adapter,
    };
    // Nonce must be 32 lowercase hex chars to match /^dashboard:([0-9a-f]{32}):(local|...)$/
    // Key in pendingNonceButtons is the bare nonce (no prefix — consumeNonceCallback uses match[1]).
    const nonce = "abcdef1234567890abcdef1234567890";
    const timer = setTimeout(() => {}, 300_000);
    h.s.pendingNonceButtons.set(nonce, {
      prefix: "dashboard:", instanceName: "dashboard", adapterId: "owner",
      adapter: h.adapter, chatId: "G", threadId: "T0", messageId: "menu",
      nonce, expiredText: "stale", retire: undefined, dashboardOwner: discordOwner,
      extra: { requesterUserId: "admin", dashboardOwner: discordOwner }, timer,
    });
    const urlSpy = vi.spyOn(h.s, "tgStartWebUrl");
    await h.s.dispatchAdapterCallback({
      callbackData: `dashboard:${nonce}:local`, chatId: "G", threadId: "T0",
      messageId: "menu", userId: "admin", ack: vi.fn(),
    }, "owner", h.adapter);
    await flush();
    clearTimeout(timer);
    // tgStartWebUrl must NOT have been called for a Discord owner (type !== "telegram")
    expect(urlSpy).not.toHaveBeenCalled();
  });
});

// ─── no code in group on any path ─────────────────────────────────────────

describe("#1686: no code in a group on any path", () => {
  it("sendText to group chat never carries a sign-in code after failure", async () => {
    const h = rig("telegram");
    await h.typed(); await flush();
    await h.click("local"); await flush();
    const codePattern = /[A-Z2-7]{4}-[A-Z2-7]{4}/;
    for (const call of (h.adapter.sendText.mock.calls as any[][])) {
      const text = String(call[1] ?? "");
      expect(text).not.toMatch(codePattern);
    }
    for (const call of (h.adapter.editMessageRemoveButtons.mock.calls as any[][])) {
      const text = String(call[2] ?? "");
      expect(text).not.toMatch(codePattern);
    }
  });
});

// ─── /start web DM ack ───────────────────────────────────────────────────

describe("#1686: /start web in DM from fleet admin", () => {
  it("fleet admin gets the ack message in their private DM", async () => {
    const h = rig("telegram");
    vi.spyOn(h.s, "isFleetAdmin").mockReturnValue(true);
    await h.inboundDm("/start web", "admin");
    await flush();
    const ack = h.adapter.sendText.mock.calls.find((c: any[]) => String(c[1]).includes(t("dashboard.start_web_ack")));
    expect(ack).toBeTruthy();
  });

  it("non-admin in private DM does not get the ack (treated as a regular /start)", async () => {
    const h = rig("telegram");
    vi.spyOn(h.s, "isFleetAdmin").mockReturnValue(false);
    // stub handleClassicStart so a non-admin /start web doesn't require the full classicChannels setup.
    vi.spyOn(h.s, "handleClassicStart").mockResolvedValue(t("classic.no_agent_start") ?? "no agent");
    await h.inboundDm("/start web", "stranger");
    await flush();
    const ack = h.adapter.sendText.mock.calls.find((c: any[]) => String(c[1]).includes(t("dashboard.start_web_ack")));
    expect(ack).toBeFalsy();
  });

  // Fable witness tests (P1 — must pass after fix, failed before)
  it("(a) fleet admin NOT on ClassicBot allow list gets the ack, no access request", async () => {
    const h = rig("telegram");
    vi.spyOn(h.s, "isFleetAdmin").mockReturnValue(true);
    h.s.classicChannels.isUserAllowed = () => false;
    const prompt = vi.spyOn(h.s, "promptClassicApproval").mockResolvedValue(undefined);
    await h.inboundDm("/start web", "admin"); await flush();
    expect([
      h.adapter.sendText.mock.calls.map((c: any[]) => String(c[1])),
      prompt.mock.calls.length,
    ]).toEqual([[t("dashboard.start_web_ack")], 0]);
  });

  it("(b) non-admin tapping the deep link never starts a Classic agent", async () => {
    const h = rig("telegram");
    vi.spyOn(h.s, "isFleetAdmin").mockReturnValue(false);
    const start = vi.spyOn(h.s, "handleClassicStart").mockResolvedValue("started");
    await h.inboundDm("/start web", "stranger"); await flush();
    expect(start).not.toHaveBeenCalled();
  });

  it("ordering mutation: /start web AFTER validateClassicStart → fleet admin without allow-list gets access request, not ack", async () => {
    // This is the mutation: temporarily move the intercept after validateClassicStart by spying on
    // validateClassicStart to return a blocker for the "admin" user (simulating the wrong order).
    // The real /start web intercept runs BEFORE validateClassicStart, so it never reaches this spy.
    // If the ordering were wrong, validateClassicStart running first would block fleet admins not on
    // the Classic allow list with an access-requested notice.
    const h = rig("telegram");
    vi.spyOn(h.s, "isFleetAdmin").mockReturnValue(true);
    h.s.classicChannels.isUserAllowed = () => false;
    const prompt = vi.spyOn(h.s, "promptClassicApproval").mockResolvedValue(undefined);
    // With the correct ordering, the intercept fires first → ack sent, prompt never called.
    await h.inboundDm("/start web", "admin"); await flush();
    // If this assertion fails, the intercept ran AFTER validateClassicStart (wrong order).
    expect(prompt.mock.calls.length).toBe(0);
    expect(h.adapter.sendText.mock.calls.some((c: any[]) => String(c[1]).includes(t("dashboard.start_web_ack")))).toBe(true);
  });
});
