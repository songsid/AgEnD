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
import { formatFleetTime } from "../src/tz-utils.js";
import { existsSync } from "node:fs";
import { syntheticTunnelToken } from "./helpers/named-tunnel-token.js";
import { PUBLIC_TUNNEL_TOKEN_ENV } from "../src/public-tunnel-config.js";
import { PUBLIC_LINK_OWNER_FILE } from "../src/public-link-owner.js";
const rigs: Array<{dir: string; fm: FleetManager; s: any}> = [];
let mono = 0;
function rig(platform: "telegram" | "discord" = "telegram") {
  const dir = mkdtempSync(join(tmpdir(), "agend-public-menu-"));
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
describe("real dashboard dispatcher/nonce/private delivery, no fleet or tunnel", () => {
  it.each([
    ["telegram", "en"], ["discord", "en"], ["telegram", "zh-TW"], ["discord", "zh-TW"],
  ] as const)("#1854 %s General menu is action-first in %s, with no code until a click", async (platform, language) => {
    setLocale(language);
    const h = rig(platform);
    h.s.worlds.get("owner").botUsername = "fixturebot";
    if (platform === "discord") await h.slash(); else await h.typed();
    const copy = platform === "discord" ? h.respondButtons.mock.calls[0]![0] : h.adapter.notifyAlert.mock.calls[0]![1].message;
    const choices = platform === "discord" ? h.respondButtons.mock.calls[0]![1] : h.adapter.notifyAlert.mock.calls[0]![1].choices;
    const menu = language === "en"
      ? "Press a sign-in button to get your private link and code.\nPublic links use Cloudflare TLS; anyone who signs in can manage the fleet. Do not forward."
      : "按登入按鈕，取得僅傳給你的連結和登入碼。\n公開連結使用 Cloudflare TLS；登入者可管理艦隊，勿轉傳。";
    expect(copy).toBe(platform === "discord" ? `${t("dashboard.deprecated")}\n\n${menu}` : menu);
    expect(choices.map((c: any) => c.label)).toEqual(language === "en"
      ? ["💻 AgEnD computer: get a code", "🌐 Other device (temporary public)"]
      : ["💻 AgEnD 電腦登入（取碼）", "🌐 其他裝置登入（臨時公開）"]);
    expect(h.s.webLoginCodes.hasOutstandingCode).toBe(false);
    expect(h.adapter.sendDirect).not.toHaveBeenCalled();
    expect(h.manager.start).not.toHaveBeenCalled();
    await h.click("local");
    expect(h.adapter.sendDirect.mock.calls[0]![1]).toMatch(/[A-Z0-9]{4}-[A-Z0-9]{4}/);
    expect(h.manager.start).not.toHaveBeenCalled();
  });

  it.each(["telegram", "discord"] as const)("#1854 %s public-disabled menu is one instruction and one local button", async platform => {
    const h = rig(platform); h.fm.fleetConfig!.web = { public_link: { allow_public: false } };
    if (platform === "discord") await h.slash(); else await h.typed();
    const copy = platform === "discord" ? h.respondButtons.mock.calls[0]![0] : h.adapter.notifyAlert.mock.calls[0]![1].message;
    const choices = platform === "discord" ? h.respondButtons.mock.calls[0]![1] : h.adapter.notifyAlert.mock.calls[0]![1].choices;
    const menu = "Press a sign-in button to get your private link and code.";
    expect(copy).toBe(platform === "discord" ? `${t("dashboard.deprecated")}\n\n${menu}` : menu);
    expect(choices.map((c: any) => c.id.split(":").at(-1))).toEqual(["local"]);
    expect(h.s.webLoginCodes.hasOutstandingCode).toBe(false);
  });

  it("#1854 preserves active public expiry and the close control", async () => {
    const h = rig(); const expiresAt = Date.now() + 60_000;
    vi.spyOn(h.fm, "getPublicWebStatus").mockReturnValue({ state: "open", remainingSeconds: 60, expiresAt });
    await h.typed();
    const menu = h.adapter.notifyAlert.mock.calls[0]![1];
    expect(menu.message).toContain("Public link: open · 60s remaining");
    expect(menu.message).toContain(t("dashboard.public_until", formatFleetTime(expiresAt)));
    expect(menu.choices.map((c: any) => c.id.split(":").at(-1))).toEqual(["local", "public", "close"]);
  });

  it("#1854 an unavailable dashboard does not promise a ready sign-in action", async () => {
    const h = rig(); vi.spyOn(h.fm, "getDashboardAccess").mockReturnValue({ ready: false, token: null });
    await h.typed();
    expect(h.adapter.notifyAlert.mock.calls[0]![1].message).toBe(`${t("dashboard.starting")}\n${t("dashboard.public_risk")}`);
    expect(h.s.webLoginCodes.hasOutstandingCode).toBe(false);
  });

  it.each(["telegram", "discord"] as const)("%s menu is secret-free; click sends link/code only by DM with a close button", async platform => {
    const h = rig(platform); if (platform === "discord") await h.slash(); else await h.typed();
    expect(h.manager.start).not.toHaveBeenCalled(); expect(h.s.webLoginCodes.hasOutstandingCode).toBe(false);
    const copy = platform === "discord" ? h.respondButtons.mock.calls[0][0] : h.adapter.notifyAlert.mock.calls[0][1].message;
    expect(copy).not.toContain("trycloudflare"); expect(copy).not.toMatch(/[A-Z0-9]{4}-[A-Z0-9]{4}/);
    await h.click(); expect(h.manager.start).toHaveBeenCalledTimes(1);
    const dm = h.adapter.sendDirect.mock.calls[0]; expect(dm[0]).toBe("admin"); expect(dm[1]).toContain("https://sample.trycloudflare.com/signin"); expect(dm[1]).toMatch(/[A-Z0-9]{4}-[A-Z0-9]{4}/);
    expect(dm[2].choices[0].id).toMatch(/^dashboard:[a-f0-9]{32}:close$/);
    expect(h.adapter.sendText.mock.calls.flat().join(" ")).not.toContain("trycloudflare");
    expect(h.adapter.editMessageRemoveButtons.mock.calls.flat().join(" ")).not.toContain("trycloudflare");
  });
  it("A private failure cannot close or revoke B's confirmed same-start link and newer code", async () => {
    const h = rig(); let failA!: (error: Error) => void;
    h.adapter.sendDirect.mockImplementation(async user => user === "admin"
      ? await new Promise<never>((_resolve, reject) => { failA = reject; })
      : { chatId: user, messageId: "dm-b" });
    await h.typed(); const first = h.click(); await flush();
    expect(h.adapter.sendDirect).toHaveBeenCalledTimes(1);
    await h.typed("admin2"); await h.click("public", { userId: "admin2" });
    const codeB = h.adapter.sendDirect.mock.calls[1][1].match(/[A-Z0-9]{4}-[A-Z0-9]{4}/)![0];
    const exposure = h.s.publicWebLink.exposureId;
    failA(new Error("DM refused")); await first;
    expect(h.manager.start).toHaveBeenCalledTimes(1); expect(h.manager.stop).not.toHaveBeenCalled();
    expect(h.s.publicWebLink.status().state).toBe("open");
    expect(h.s.webLoginCodes.redeem(codeB, tokenEpoch("c".repeat(48)), exposure).kind).toBe("ok");
  });
  it("Telegram DM failure gives safe /start guidance and withdraws code/link", async () => {
    const h = rig(); h.adapter.sendDirect.mockRejectedValue(Error("secret provider URL")); await h.typed(); await h.click();
    expect(h.s.webLoginCodes.hasOutstandingCode).toBe(false); expect(h.manager.stop).toHaveBeenCalledTimes(1);
    // The menu ends on the public link's steps (⑥ marked failed), then the safe guidance.
    expect(h.adapter.editMessageRemoveButtons).toHaveBeenLastCalledWith("G", "menu", expect.stringMatching(/❌ ⑥ [^\n]*\n\n/), "T0");
    // #1742: Telegram's guidance walks through the DM (no bot name known here: send `/start web`), never a bare /start.
    expect(String((h.adapter.editMessageRemoveButtons.mock.calls.at(-1) as unknown[])[2]).endsWith(t("dashboard.private_failed_tg_nolink"))).toBe(true);
    expect(t("dashboard.private_failed_tg_nolink")).toContain("/start web"); expect(t("dashboard.private_failed_tg_nolink")).not.toMatch(/\/start(?! web)/); expect(JSON.stringify(h.adapter.editMessageRemoveButtons.mock.calls)).not.toContain("secret provider");
  });
  it("Discord DM refusal awaits ephemeral fallback; no ACK means no usable code/link", async () => {
    const h = rig("discord"); h.adapter.sendDirect.mockRejectedValue(Error("DM disabled")); await h.slash(); let finish!: (v: any) => void;
    const privateReply = vi.fn(() => new Promise(resolve => { finish = resolve; })); const click = h.click("public", { respondPrivate: privateReply }); await flush();
    expect(privateReply).toHaveBeenCalledTimes(1); expect(h.s.publicWebLink.status().state).toBe("open");
    mono = 10_000; await vi.advanceTimersByTimeAsync(10_000); await click;
    expect(h.s.webLoginCodes.hasOutstandingCode).toBe(false); expect(h.s.publicWebLink.status().state).toBe("closed");
    finish({ messageId: "late", chatId: "T0" }); await flush(); expect(h.s.publicWebLink.status().state).toBe("closed");
  });
  it("Discord confirmed ephemeral fallback remains private and closable", async () => {
    const h = rig("discord"); h.adapter.sendDirect.mockRejectedValue(Error("DM disabled")); await h.slash(); const privateReply = vi.fn(async () => ({ messageId: "private", chatId: "T0" }));
    await h.click("public", { respondPrivate: privateReply }); expect(privateReply).toHaveBeenCalled(); expect(h.s.publicWebLink.status().state).toBe("open");
    const e = [...h.s.pendingNonceButtons.values()].find((e: any) => e.messageId === "private") as any;
    // #1610: two steps — the first tap swaps the ephemeral message's buttons through its own interaction.
    const replaceClickedButtons = vi.fn(async () => {});
    await h.s.dispatchAdapterCallback({ callbackData: `dashboard:${e.nonce}:close`, chatId: "G", threadId: "T0", messageId: "private", userId: "admin", ack: vi.fn(), replaceClickedButtons }, "owner", h.adapter);
    expect(h.s.publicWebLink.status().state).toBe("open");
    const step = [...h.s.pendingNonceButtons.values()].find((x: any) => x.messageId === "private" && x.closeStep) as any;
    await h.s.dispatchAdapterCallback({ callbackData: `dashboard:${step.nonce}:confirm`, chatId: "G", threadId: "T0", messageId: "private", userId: "admin", ack: vi.fn() }, "owner", h.adapter);
    expect(h.s.publicWebLink.status().state).toBe("closed");
  });
  it("Discord dashboard outside General finishes deferred response after private DM", async () => {
    const h = rig("discord");
    await h.slash("admin", "T1");
    // #1586: the sign-in DM, then the code alone, to the same user.
    expect(h.adapter.sendDirect).toHaveBeenCalledTimes(2);
    expect(h.adapter.sendDirect.mock.calls[0]![1]).toContain(t("dashboard.code_help"));
    expect(h.adapter.sendDirect.mock.calls[0]![1]).not.toContain(t("dashboard.menu_instruction"));
    expect(h.adapter.sendDirect.mock.calls[0]![1]).not.toMatch(/choose.*below|選擇下方/i);
    expect(h.adapter.sendDirect.mock.calls.map(c => c[0])).toEqual(["admin", "admin"]);
    expect(h.adapter.sendDirect.mock.calls[1][1]).toBe(`\`${/[A-Z0-9]{4}-[A-Z0-9]{4}/.exec(h.adapter.sendDirect.mock.calls[0][1])![0]}\``);   // #1606
    expect(h.respond).toHaveBeenCalledTimes(1);
    expect(h.respond).toHaveBeenCalledWith(`${t("dashboard.deprecated")}\n\n${t("dashboard.private_sent_dm")}`);
    expect(h.respond.mock.calls[0][0]).not.toMatch(/[A-Z0-9]{4}-[A-Z0-9]{4}/);
    expect(h.respond.mock.calls[0][0]).not.toContain("http");
    expect(h.nonce()).toBeUndefined();
  });
  it("Discord outside-General refused DM retains private ephemeral fallback", async () => {
    const h = rig("discord"); h.adapter.sendDirect.mockRejectedValue(Error("DM disabled"));
    await h.slash("admin", "T1");
    expect(h.respond).toHaveBeenCalledTimes(1);
    expect(h.respond.mock.calls[0][0]).toMatch(/[A-Z0-9]{4}-[A-Z0-9]{4}/);
  });
  it("requester, admin, owner world, configured General and exact message are all fenced", async () => {
    const h = rig(); await h.typed();
    for (const overrides of [{ userId: "member" }, { userId: "admin2" }, { chatId: "OTHER" }, { threadId: "T1" }, { messageId: "wrong" }]) await h.click("public", overrides);
    expect(h.manager.start).not.toHaveBeenCalled(); expect(h.nonce()).toBeTruthy();
    h.owner.access.allowed_users = []; await h.click(); expect(h.manager.start).not.toHaveBeenCalled();
  });
  it("typed Telegram and native Discord entry refuse non-admin; wrong General cannot open public", async () => {
    const a = rig(); await a.typed("member"); expect(a.nonce()).toBeUndefined(); await a.typed("admin", "T1"); expect(a.nonce()).toBeUndefined();
    const b = rig("discord"); await b.slash("member"); await b.slash("admin", "T0", "FOREIGN"); expect(b.nonce()).toBeUndefined(); expect(b.manager.start).not.toHaveBeenCalled();
    await b.slash("admin", "T1"); expect(b.nonce()).toBeUndefined(); expect(b.manager.start).not.toHaveBeenCalled();
  });
  it("old nonce, disable/rebind and shutdown cannot create a tunnel", async () => {
    const a = rig(); await a.typed(); await vi.advanceTimersByTimeAsync(5 * 60_000); expect(a.nonce()).toBeUndefined(); expect(a.manager.start).not.toHaveBeenCalled();
    const b = rig(); await b.typed(); b.fm.fleetConfig!.web = { public_link: { allow_public: false } }; await b.click(); expect(b.manager.start).not.toHaveBeenCalled();
    const c = rig(); await c.typed(); c.s.adapters.set("owner", { ...c.adapter }); await c.click(); expect(c.manager.start).not.toHaveBeenCalled();
  });
  it("kill switch removes public choice without creating defaults; local click remains private", async () => {
    const h = rig(); h.fm.fleetConfig!.web = { public_link: { allow_public: false } }; await h.typed();
    expect(h.adapter.notifyAlert.mock.calls[0][1].choices.map((c: any) => c.id.endsWith(":public"))).toEqual([false]);
    await h.click("local"); expect(h.manager.start).not.toHaveBeenCalled(); expect(h.adapter.sendDirect.mock.calls[0][1]).toContain("/signin");
  });
  it("/dashboard revoke and real stopAll fence access before asynchronous cleanup", async () => {
    const a = rig(); await a.typed(); await a.click(); await a.typed("admin", "T0", "/dashboard revoke"); expect(a.s.webLoginCodes.hasOutstandingCode).toBe(false); await flush(); expect(a.s.publicWebLink.status().state).toBe("closed");
    const b = rig(); await b.typed(); await b.click(); let finish!: () => void; b.manager.stop.mockImplementation(() => new Promise(resolve => { finish = () => resolve({ confirmed: true }); }));
    b.s.shutdownLoginWindows = async () => {}; const stop = b.fm.stopAll(); expect(b.s.shuttingDown).toBe(true); expect(b.s.publicWebLink.status().state).toBe("closing"); expect(b.s.webLoginCodes.hasOutstandingCode).toBe(false);
    await flush(); finish(); await stop; expect(b.manager.stop).toHaveBeenCalledTimes(1);
  });
  it("public General notice uses the issuing owner despite notify_login=false and rejects a changed admin/binding", async () => {
    const h = rig(); h.fm.fleetConfig!.web = { notify_login: false }; const owner = h.s.dashboardOwner("admin", "owner", "G", "T0");
    await h.fm.confirmPublicWebLogin({ label: "phone", handle: "abcdef123456", owner }, () => true);
    expect(h.adapter.sendText).toHaveBeenCalledWith("G", t("web.public_login_notice", "phone", "abcdef12"), { threadId: "T0", allowedMentions: { parse: [] } });
    h.owner.access.allowed_users = []; await expect(h.fm.confirmPublicWebLogin({ label: "phone", handle: "x", owner }, () => true)).rejects.toThrow(); expect(h.adapter.sendText).toHaveBeenCalledTimes(1);
  });
  it("the actual login controller and public web use the same purpose lane before startup awaits", async () => {
    const h = rig(); expect(h.s.webLogin.deps.reserveTunnel).toEqual(expect.any(Function));
    const login = h.s.webLogin.deps.reserveTunnel("login-reservation"); await h.typed(); await h.click(); expect(h.manager.start).not.toHaveBeenCalled();
    login.releaseUnused(); await h.typed(); await h.click(); expect(h.manager.start).toHaveBeenCalledTimes(1);
    expect(h.s.webLogin.deps.reserveTunnel("second-login")).toBeNull();
  });
});

describe("#named-link-ttl: no expiry and auto_open in the real dispatcher", () => {
  const previousToken = process.env[PUBLIC_TUNNEL_TOKEN_ENV];
  beforeEach(() => { process.env[PUBLIC_TUNNEL_TOKEN_ENV] = syntheticTunnelToken(); });
  afterEach(() => { if (previousToken === undefined) delete process.env[PUBLIC_TUNNEL_TOKEN_ENV]; else process.env[PUBLIC_TUNNEL_TOKEN_ENV] = previousToken; });
  const NAMED = (extra: Record<string, unknown> = {}) => ({ public_link: { hostname: "agend.example.com", tunnel_token_env: PUBLIC_TUNNEL_TOKEN_ENV, ttl_minutes: 0, ...extra } });
  const ownerFile = (h: { dir: string }) => join(h.dir, PUBLIC_LINK_OWNER_FILE);
  it("a no-expiry link says so privately and in the menu; its opener is remembered, and Close forgets them", async () => {
    const h = rig(); h.fm.fleetConfig!.web = NAMED();
    await h.typed(); await h.click();
    const dm = String(h.adapter.sendDirect.mock.calls[0]![1]);
    expect(dm).toContain(t("dashboard.public_no_expiry"));
    expect(h.s.publicWebLink.status()).toEqual({ state: "open", noExpiry: true });
    expect(existsSync(ownerFile(h))).toBe(true);
    await h.typed();
    expect(h.adapter.notifyAlert.mock.calls.at(-1)![1].message).toContain(t("dashboard.public_status_no_expiry", "open"));
    const close = [...h.s.pendingNonceButtons.values()].find((e: any) => e.chatId === "admin" && e.publicExposureId) as any;
    await h.s.dispatchAdapterCallback({ callbackData: `dashboard:${close.nonce}:close`, chatId: "admin", messageId: close.messageId, userId: "admin", ack: vi.fn() }, "owner", h.adapter);
    const step = [...h.s.pendingNonceButtons.values()].find((e: any) => e.closeStep) as any;
    await h.s.dispatchAdapterCallback({ callbackData: `dashboard:${step.nonce}:confirm`, chatId: "admin", messageId: step.messageId, userId: "admin", ack: vi.fn() }, "owner", h.adapter);
    expect(h.s.publicWebLink.status().state).toBe("closed");
    expect(existsSync(ownerFile(h))).toBe(false);
  });
  it("a quick-tunnel opening remembers nobody; /web revoke forgets a named opener", async () => {
    const quick = rig(); await quick.typed(); await quick.click();
    expect(quick.s.publicWebLink.status().state).toBe("open"); expect(existsSync(ownerFile(quick))).toBe(false);
    const named = rig(); named.fm.fleetConfig!.web = NAMED(); await named.typed(); await named.click();
    expect(existsSync(ownerFile(named))).toBe(true);
    await named.typed("admin", "T0", "/dashboard revoke"); await flush();
    expect(existsSync(ownerFile(named))).toBe(false);
  });
  it("after a start, auto_open reopens it once for the remembered admin — nothing posted, no code issued", async () => {
    const h = rig(); h.fm.fleetConfig!.web = NAMED({ auto_open: true });
    await h.typed(); await h.click();
    await h.s.publicWebLink.close("fleet shutdown");                       // as a restart leaves it
    expect(h.s.publicWebLink.status().state).toBe("closed");
    const posted = () => [h.adapter.sendDirect, h.adapter.sendText, h.adapter.notifyAlert].map(f => f.mock.calls.length);
    const before = posted(); h.s.webLoginCodes.revoke();
    h.s.healthServerListening = true;
    h.s.startPublicLinkAutoOpen(); await flush();
    expect(h.manager.start).toHaveBeenCalledTimes(2);
    expect(h.s.publicWebLink.status()).toEqual({ state: "open", noExpiry: true });
    expect(h.s.publicWebLink.openSignin()?.owner).toEqual(expect.objectContaining({ adapterId: "owner", userId: "admin", chatId: "G", threadId: "T0" }));
    expect(posted()).toEqual(before); expect(h.s.webLoginCodes.hasOutstandingCode).toBe(false);
    // The admin's next /web joins the same link and gets its URL and a code privately.
    await h.typed(); await h.click();
    expect(h.manager.start).toHaveBeenCalledTimes(2);
    expect(String(h.adapter.sendDirect.mock.calls.at(-2)![1])).toContain("/signin");
  });
  it.each([
    ["a quick tunnel (raw YAML auto_open)", { public_link: { auto_open: true } }],
    ["auto_open off", NAMED()],
  ])("auto_open is ignored with %s", async (_why, web) => {
    const h = rig(); h.fm.fleetConfig!.web = NAMED(); await h.typed(); await h.click();
    await h.s.publicWebLink.close("fleet shutdown");
    h.fm.fleetConfig!.web = web as never; h.s.healthServerListening = true;
    h.s.startPublicLinkAutoOpen(); await flush();
    expect(h.manager.start).toHaveBeenCalledTimes(1); expect(h.s.publicWebLink.status().state).toBe("closed");
  });
  // ── carry of #2450 (Fable's review P2-1, P2-2) ──────────────────────────────────────────────────────────────────────
  /** A named link opened by /web (so its admin is remembered), then closed as a restart leaves it. */
  async function remembered() {
    const h = rig(); h.fm.fleetConfig!.web = NAMED({ auto_open: true });
    await h.typed(); await h.click();
    await h.s.publicWebLink.close("fleet shutdown");
    expect(existsSync(ownerFile(h))).toBe(true);
    return h;
  }
  /** The two ways a remembered admin stops owning the link: no longer an admin; the General moved (another topic). */
  const demotions: Array<[string, (h: any) => void]> = [
    ["no longer a fleet admin", (h) => { h.owner.access.allowed_users = ["admin2"]; }],
    ["the General's topic changed", (h) => { h.fm.fleetConfig!.instances.general.topic_id = "T9"; h.fm.routing.rebuild(h.fm.fleetConfig!); }],
  ];
  it.each(demotions)("P2-1: a remembered admin %s — after a start nothing is opened, nothing is attempted, and nobody is told", async (_why, demote) => {
    const h = await remembered();
    demote(h);
    const dms = h.adapter.sendDirect.mock.calls.length, posted = h.adapter.sendText.mock.calls.length + h.adapter.notifyAlert.mock.calls.length;
    h.s.healthServerListening = true; h.s.startPublicLinkAutoOpen(); await flush();
    await vi.advanceTimersByTimeAsync(30_000); await flush();
    await vi.advanceTimersByTimeAsync(120_000); await flush();
    expect([h.manager.start.mock.calls.length, h.s.publicWebLink.status().state, h.adapter.sendDirect.mock.calls.length - dms,
      h.adapter.sendText.mock.calls.length + h.adapter.notifyAlert.mock.calls.length - posted]).toEqual([1, "closed", 0, 0]);
  });
  it("P2-1, each guard on its own: the remembered owner is none, the unattended start refuses (no lane), and no failure DM", async () => {
    const h = await remembered();
    const saved = h.s.rememberedPublicOwner();
    expect(saved, "control: before the demotion it is the admin").toEqual(expect.objectContaining({ userId: "admin", adapterId: "owner" }));
    h.owner.access.allowed_users = ["admin2"];
    const lane = vi.spyOn(h.s.tunnelPurposeLane, "reserve");
    const opened = await h.s.publicWebLink.openUnattended(saved);
    h.s.healthServerListening = true; h.s.startPublicLinkAutoOpen();
    const dms = h.adapter.sendDirect.mock.calls.length;
    await h.s.publicLinkAutoOpen.deps.notifyFailed(saved, undefined);
    expect([h.s.rememberedPublicOwner(), opened, lane.mock.calls.length, h.manager.start.mock.calls.length, h.adapter.sendDirect.mock.calls.length - dms])
      .toEqual([null, "failed", 0, 1, 0]);
  });
  it("P2-2: only a public opening is remembered — a local /web sign-in with a hostname configured leaves no owner", async () => {
    const h = rig(); h.fm.fleetConfig!.web = NAMED({ auto_open: true });
    await h.typed(); await h.click("local");
    const local = [h.adapter.sendDirect.mock.calls.length > 0, existsSync(ownerFile(h))];
    await h.typed(); await h.click("public");                          // control: the public opening is remembered
    expect([local, existsSync(ownerFile(h))]).toEqual([[true, false], true]);
  });
  it("a start that keeps failing is retried twice, then its admin hears once by DM, drawn as a failed /web", async () => {
    const h = rig(); h.fm.fleetConfig!.web = NAMED({ auto_open: true });
    await h.typed(); await h.click(); await h.s.publicWebLink.close("fleet shutdown");
    h.manager.start.mockResolvedValue({ ok: false, errorKind: "named-connection-failed", message: "private detail" } as never);
    const dms = h.adapter.sendDirect.mock.calls.length;
    h.s.healthServerListening = true; h.s.startPublicLinkAutoOpen(); await flush();
    await vi.advanceTimersByTimeAsync(30_000); await flush();
    await vi.advanceTimersByTimeAsync(120_000); await flush();
    expect(h.manager.start).toHaveBeenCalledTimes(4);
    expect(h.adapter.sendDirect.mock.calls.length).toBe(dms + 1);
    const notice = String(h.adapter.sendDirect.mock.calls.at(-1)![1]);
    expect(notice).toContain(t("dashboard.public_auto_failed")); expect(notice).toContain("❌"); expect(notice).not.toContain("private detail");
    await vi.advanceTimersByTimeAsync(600_000); await flush();
    expect(h.manager.start).toHaveBeenCalledTimes(4); expect(h.adapter.sendDirect.mock.calls.length).toBe(dms + 1);
  });
});
