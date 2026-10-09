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
  const dir = mkdtempSync(join(tmpdir(), "agend-public-menu-"));
  const fm = new FleetManager(dir), s = fm as any;
  const adapter = { id: "owner", type: platform, sendText: vi.fn(async (chat: string, _text: string, opts?: any) => ({ chatId: chat, threadId: opts?.threadId, messageId: "safe" })),
    notifyAlert: vi.fn(async (chat: string, _alert: any, opts?: any) => ({ chatId: chat, threadId: opts?.threadId, messageId: "menu" })),
    sendDirect: vi.fn(async (user: string, _text: string, _opts?: any) => ({ chatId: platform === "discord" ? "DM" : user, messageId: "dm" })),
    editMessageRemoveButtons: vi.fn(async () => {}), stop: vi.fn(async () => {}) };
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
    expect(String((h.adapter.editMessageRemoveButtons.mock.calls.at(-1) as unknown[])[2]).endsWith(t("dashboard.private_failed"))).toBe(true);
    expect(t("dashboard.private_failed")).toContain("/start"); expect(JSON.stringify(h.adapter.editMessageRemoveButtons.mock.calls)).not.toContain("secret provider");
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
    await h.s.dispatchAdapterCallback({ callbackData: `dashboard:${e.nonce}:close`, chatId: "G", threadId: "T0", messageId: "private", userId: "admin", ack: vi.fn() }, "owner", h.adapter);
    expect(h.s.publicWebLink.status().state).toBe("closed");
  });
  it("Discord dashboard outside General finishes deferred response after private DM", async () => {
    const h = rig("discord");
    await h.slash("admin", "T1");
    expect(h.adapter.sendDirect).toHaveBeenCalledTimes(1);
    expect(h.respond).toHaveBeenCalledTimes(1);
    expect(h.respond).toHaveBeenCalledWith(t("dashboard.private_sent_dm"));
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
