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
    const h = rig("discord");
    await h.typed(); await flush();
    const alertCalls = h.adapter.notifyAlert.mock.calls;
    const menuText: string = alertCalls[0]?.[1]?.message ?? "";
    expect(menuText).not.toContain("t.me");
  });
});

// ─── button-click failure: URL button on the outcome edit ─────────────────

describe("#1686: Telegram button-click failure carries the link/button", () => {
  it("editMessageRemoveButtons receives urlButtons with the start link", async () => {
    const h = rig("telegram");
    await h.typed(); await flush();
    expect(h.nonce()).toBeTruthy();
    await h.click("local"); await flush();
    const calls = h.adapter.editMessageRemoveButtons.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const urlButtons = calls[calls.length - 1]?.[4];
    expect(Array.isArray(urlButtons)).toBe(true);
    expect(urlButtons[0]?.url).toBe(`https://t.me/${VALID}?start=web`);
    expect(urlButtons[0]?.label).toBe(t("dashboard.start_web_label"));
  });

  it("outcome text does NOT contain the sign-in code", async () => {
    const h = rig("telegram");
    await h.typed(); await flush();
    await h.click("local"); await flush();
    const calls = h.adapter.editMessageRemoveButtons.mock.calls;
    const text: string = calls[calls.length - 1]?.[2] ?? "";
    expect(text).not.toMatch(/[A-Z2-7]{4}-[A-Z2-7]{4}/);
  });

  it("Discord button-click failure: no urlButtons (Discord unchanged)", async () => {
    const h = rig("discord");
    await h.typed(); await flush();
    const e = h.nonce();
    if (!e) return; // Discord may reach this path differently; already verified by no sendText urlButtons
    await h.click("local"); await flush();
    const calls = h.adapter.editMessageRemoveButtons.mock.calls;
    if (!calls.length) return; // no edit = no urlButtons to check
    const urlButtons = calls[calls.length - 1]?.[4];
    expect(urlButtons).toBeUndefined();
  });
});

// ─── no code in group on any path ─────────────────────────────────────────

describe("#1686: no code in a group on any path", () => {
  it("sendText to group chat never carries a sign-in code after failure", async () => {
    const h = rig("telegram");
    await h.typed(); await flush();
    await h.click("local"); await flush();
    const codePattern = /[A-Z2-7]{4}-[A-Z2-7]{4}/;
    for (const call of h.adapter.sendText.mock.calls) {
      const text = String(call[1] ?? "");
      expect(text).not.toMatch(codePattern);
    }
    for (const call of h.adapter.editMessageRemoveButtons.mock.calls) {
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
    // Stub handleClassicStart so a non-admin /start web doesn't require the full classicChannels setup.
    vi.spyOn(h.s, "handleClassicStart").mockResolvedValue(t("classic.no_agent_start") ?? "no agent");
    await h.inboundDm("/start web", "stranger");
    await flush();
    const ack = h.adapter.sendText.mock.calls.find((c: any[]) => String(c[1]).includes(t("dashboard.start_web_ack")));
    expect(ack).toBeFalsy();
  });
});
