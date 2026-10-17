/**
 * #1920 phase 2 (step 4a, §2.3/§5.4): a non-admin's `/web`, while guest sign-in is on, signs them in as a guest.
 * - The code goes privately (a DM, else the slash command's ephemeral answer), bound to their account, tier guest —
 *   only when their scope holds something; once a minute at most; never posted where they asked.
 * - Guests' codes are their own store: a guest's /web never withdraws an admin's code.
 * - A guest code signs in only while the account is still a guest with something in scope; its sign-in is said in
 *   General (who, how many agents); it makes the browser a guest's returning device (step 4b, web-guest-devices-1920).
 * - A guest's `/web revoke` ends its own sessions and code only; an admin's still ends everyone's.
 * - The channel copy of a guest's web message says "(guest)" after the name.
 * Rig: a real FleetManager with no fleet, as login-code-copy-1586 (spawners, tmux, backend and inspector mocked).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
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
import { formatWebChannelEcho } from "../src/web-channel-echo.js";
import { GuestLoginCodes, LOGIN_CODE_TTL_MS } from "../src/web-login.js";

const TOKEN = "c".repeat(48);
const rigs: Array<{ dir: string; fm: FleetManager; s: any }> = [];
let mono = 0;
function rig(platform: "telegram" | "discord" = "discord", mode: "allowlist" | "open" = "allowlist") {
  const dir = mkdtempSync(join(tmpdir(), "agend-1920s-"));
  const fm = new FleetManager(dir), s = fm as any;
  const adapter = { id: "owner", type: platform, sendText: vi.fn(async (chat: string, _text: string, opts?: any) => ({ chatId: chat, threadId: opts?.threadId, messageId: "safe" })),
    sendDirect: vi.fn(async (user: string, _text: string, _opts?: any) => ({ chatId: platform === "discord" ? "DM" : user, messageId: "dm" })), stop: vi.fn(async () => {}) };
  const owner = { id: "owner", type: platform, group_id: "G", bot_token_env: "NONE", access: { mode, allowed_users: ["admin"] } };
  fm.fleetConfig = { defaults: {}, channel: owner, channels: [owner], web: { guests: { enabled: true } }, instances: {
    general: { working_directory: dir, general_topic: true, topic_id: "T0", channel_id: "owner" },
    worker: { working_directory: dir, topic_id: "T1", channel_id: "owner" },
  } } as never;
  fm.routing.rebuild(fm.fleetConfig!); s.adapters.set("owner", adapter); s.adapter = adapter;
  s.worlds.set("owner", { adapter, groupId: "G", channelConfig: owner, accessManager: { isAllowed: () => true, getMode: () => mode }, stop: async () => {} });
  s.classicChannels = { isClassicChannel: () => false, hasChannel: () => false, getAll: () => [] };
  writeFileSync(join(dir, "web.token"), TOKEN, { mode: 0o600 }); s.initializeWebSessions();
  vi.spyOn(fm, "getDashboardAccess").mockReturnValue({ ready: true, token: TOKEN });
  const respond = vi.fn(async (_text: string) => "slash");
  const slash = (user: string, action?: string, command = "web") =>
    s.dispatchSlash({ command, guildId: "G", channelId: "T1", userId: user, username: user, options: { action }, respond, respondButtons: vi.fn(async () => "menu") }, "owner", adapter);
  const typed = (user: string, text = "/web", thread = "T0") =>
    s.topicCommands.handleGeneralCommand({ source: platform, adapterId: "owner", chatId: "G", threadId: thread, userId: user, username: user, text, messageId: "in", timestamp: new Date() });
  const h = { dir, fm, s, adapter, respond, slash, typed }; rigs.push(h); return h;
}
beforeEach(() => { setLocale("en"); mono = 1_000_000; vi.spyOn(performance, "now").mockImplementation(() => mono); });
afterEach(() => {
  for (const h of rigs.splice(0)) { h.fm.stormWindow.shutdown(); h.fm.spawnGate.shutdown(); rmSync(h.dir, { recursive: true, force: true }); }
  vi.restoreAllMocks();
});
const CODE = /[A-Z0-9]{4}-[A-Z0-9]{4}/;
const codeOf = (text: unknown) => CODE.exec(String(text))![0];
const texts = (fn: any) => fn.mock.calls.map((c: any[]) => String(c[1] ?? c[0]));

describe("a non-admin's /web while guest sign-in is on", () => {
  it("a guest code by DM, bound to the account; only a short line where they asked; an admin's /web unchanged", async () => {
    const h = rig();
    expect([h.s.isGuestWebAsk("owner", "alice"), h.s.isGuestWebAsk("owner", "admin")]).toEqual([true, false]);
    await h.slash("alice");
    const dm = h.adapter.sendDirect.mock.calls[0]!;
    expect(dm[0]).toBe("alice");
    expect(String(dm[1])).toContain(t("web.guest_intro", 2));
    const code = codeOf(dm[1]);
    expect(h.respond.mock.calls.map((c: any[]) => c[0])).toEqual([t("web.guest_sent")]);
    expect(h.respond.mock.calls.some((c: any[]) => String(c[0]).includes(code)), "the code is never posted where asked").toBe(false);
    expect(h.s.webGuestLoginCodes.match(code, tokenEpoch(TOKEN))).toMatchObject({ kind: "ok", tier: "guest", recipient: { adapterId: "owner", userId: "alice" } });
    expect(h.s.webGuestLoginCodes.match(code, tokenEpoch(TOKEN)), "single use").toBeNull();
    // Guest sign-in off: the same /web is refused by the table, as before.
    h.fm.fleetConfig!.web = { guests: { enabled: false } } as never;
    h.respond.mockClear(); h.adapter.sendDirect.mockClear(); mono += 120_000;
    await h.slash("alice");
    expect(h.adapter.sendDirect).not.toHaveBeenCalled();
    expect(h.respond.mock.calls[0]![0]).toBe(t("not_authorized"));
  });
  it("a guest's code never withdraws an admin's (its own store), nor the reverse", async () => {
    const h = rig();
    const admin = h.s.issueDashboardLogin()!;
    await h.slash("alice");
    const guest = codeOf(h.adapter.sendDirect.mock.calls[0]![1]);
    expect(h.s.webLoginCodes.redeem(admin.display, tokenEpoch(TOKEN))).toMatchObject({ kind: "ok", tier: "admin" });
    expect(h.s.webGuestLoginCodes.match(guest, tokenEpoch(TOKEN))).toMatchObject({ kind: "ok", tier: "guest" });
  });
  it("leader's #2093 review: one code per account — guest B's /web never invalidates guest A's live code", async () => {
    const h = rig();
    await h.slash("alice");
    const a1 = codeOf(h.adapter.sendDirect.mock.calls[0]![1]);
    await h.slash("bob");
    const b1 = codeOf(h.adapter.sendDirect.mock.calls.at(-1)![1]);
    // A new /web from alice replaces only her own code.
    mono += 60_000; await h.slash("alice");
    const a2 = codeOf(h.adapter.sendDirect.mock.calls.at(-1)![1]);
    const epoch = tokenEpoch(TOKEN);
    expect(h.s.webGuestLoginCodes.match(a1, epoch), "her old code was replaced").toBeNull();
    expect(h.s.webGuestLoginCodes.match(b1, epoch)).toMatchObject({ kind: "ok", recipient: { userId: "bob" } });
    expect(h.s.webGuestLoginCodes.match(a2, epoch)).toMatchObject({ kind: "ok", recipient: { userId: "alice" } });
  });
  it("at most 32 outstanding guest codes: past that a new account is refused (try again later), nobody's evicted", async () => {
    const h = rig();
    const codes = h.s.webGuestLoginCodes, epoch = tokenEpoch(TOKEN);
    const first = codes.issue({ epoch, recipient: { adapterId: "owner", userId: "u0" } });
    for (let i = 1; i < 32; i++) expect(codes.issue({ epoch, recipient: { adapterId: "owner", userId: `u${i}` } })).not.toBeNull();
    await h.slash("alice");
    expect(h.adapter.sendDirect).not.toHaveBeenCalled();
    expect(h.respond.mock.calls[0]![0]).toBe(t("web.guest_busy"));
    expect(codes.issue({ epoch, recipient: { adapterId: "owner", userId: "u5" } }), "an account at the cap may replace its own").not.toBeNull();
    expect(codes.match(first.display, epoch), "u0's code was kept").toMatchObject({ kind: "ok" });
    h.respond.mockClear();
    await h.slash("alice");
    expect(h.respond.mock.calls[0]![0], "a slot freed: hers now").toBe(t("web.guest_sent"));
  });
  it("#2093 review: two /web at once from one account: one code, one DM; the other waits; another account is not held up", async () => {
    const h = rig();
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    vi.spyOn(h.s, "refreshGuestRooms").mockImplementation(() => held);
    const first = h.slash("alice"), second = h.slash("alice");
    await Promise.resolve(); await Promise.resolve();
    expect(h.respond.mock.calls.map((c: any[]) => c[0])).toEqual([t("web.guest_wait")]);
    const bob = h.slash("bob");
    release(); await Promise.all([first, second, bob]);
    expect(h.adapter.sendDirect.mock.calls.filter((c: any[]) => c[0] === "alice" && CODE.test(String(c[1])) && String(c[1]).includes("\n"))).toHaveLength(1);
    const code = codeOf(h.adapter.sendDirect.mock.calls.find((c: any[]) => c[0] === "alice")![1]);
    expect(h.s.webGuestLoginCodes.match(code, tokenEpoch(TOKEN)), "her one code stands").toMatchObject({ kind: "ok" });
    expect(h.s.webGuestLoginCodes.hasCodeFor({ adapterId: "owner", userId: "bob" })).toBe(true);
  });
  it("#2093 review: a revoke (hers, or an admin's) made while her /web is on its way ends it — no late code", async () => {
    for (const revoker of ["alice", "admin"]) {
      const h = rig();
      let release!: () => void;
      vi.spyOn(h.s, "refreshGuestRooms").mockImplementation(() => new Promise<void>((r) => { release = r; }));
      const asking = h.slash("alice");
      await Promise.resolve();
      await h.slash(revoker, "revoke");
      release(); await asking;
      expect(h.adapter.sendDirect, revoker).not.toHaveBeenCalled();
      expect(h.s.webGuestLoginCodes.size, revoker).toBe(0);
    }
    // Revoked while the DM is on its way: that code is withdrawn, and nothing says it was sent.
    const h = rig();
    let sent!: () => void;
    h.adapter.sendDirect.mockImplementationOnce(() => new Promise((r) => { sent = () => r({ chatId: "DM", messageId: "dm" }); }));
    const asking = h.slash("alice");
    await vi.waitFor(() => expect(h.adapter.sendDirect).toHaveBeenCalled());
    const code = codeOf(h.adapter.sendDirect.mock.calls[0]![1]);
    await h.slash("admin", "revoke");
    sent(); await asking;
    expect(h.s.webGuestLoginCodes.match(code, tokenEpoch(TOKEN))).toBeNull();
    expect(h.respond.mock.calls.map((c: any[]) => c[0])).not.toContain(t("web.guest_sent"));
    expect(h.respond.mock.calls.map((c: any[]) => c[0]), "nor that a DM failed: the revoke answered").not.toContain(t("web.guest_dm_failed"));
  });
  it("a wrong code counts against every guest code (each dies at its fifth) and the breaker; nothing typed counts nothing", async () => {
    const h = rig();
    const codes = h.s.webGuestLoginCodes, epoch = tokenEpoch(TOKEN);
    const a = codes.issue({ epoch, recipient: { adapterId: "owner", userId: "a" } });
    codes.issue({ epoch, recipient: { adapterId: "owner", userId: "b" } });
    for (let i = 0; i < 10; i++) codes.recordWrong("   ");
    for (let i = 0; i < 4; i++) codes.recordWrong("ZZZZ-ZZZZ");
    expect(codes.size).toBe(2);
    codes.recordWrong("ZZZZ-ZZZZ");
    expect(codes.size, "both burned at the fifth wrong try").toBe(0);
    expect(codes.match(a.display, epoch)).toBeNull();
    // Three more codes, five wrong tries each: 20 in the window (with a code to guess each time) — paused.
    for (let n = 0; n < 3; n++) { codes.issue({ epoch, recipient: { adapterId: "owner", userId: "a" } }); for (let i = 0; i < 5; i++) codes.recordWrong("ZZZZ-ZZZZ"); }
    expect(codes.pausedForMs(), "20 wrong in the window: paused").toBeGreaterThan(0);
  });
  it("once a minute per account; the DM refused: the slash command's ephemeral answer, else the code is withdrawn", async () => {
    const h = rig();
    await h.slash("alice");
    h.respond.mockClear(); h.adapter.sendDirect.mockClear();
    mono += 59_999; await h.slash("alice");
    expect(h.adapter.sendDirect).not.toHaveBeenCalled();
    expect(h.respond.mock.calls[0]![0]).toBe(t("web.guest_wait"));
    // DM refused on a slash command: the code in its (ephemeral) answer.
    mono += 1; h.respond.mockClear();
    h.adapter.sendDirect.mockRejectedValueOnce(new Error("Cannot send messages to this user"));
    await h.slash("alice");
    const ephemeral = String(h.respond.mock.calls[0]![0]);
    expect(h.s.webGuestLoginCodes.match(codeOf(ephemeral), tokenEpoch(TOKEN))).toMatchObject({ kind: "ok", tier: "guest" });
    // DM refused on typed text (nothing private to fall back on): the code is withdrawn and they are told how.
    const tg = rig("telegram");
    tg.s.worlds.get("owner").botUsername = "agend_demo_bot";
    tg.adapter.sendDirect.mockRejectedValueOnce(new Error("Forbidden: bot can't initiate conversation with a user"));
    expect(await tg.typed("alice")).toBe(true);
    const said = texts(tg.adapter.sendText);
    expect(said).toEqual([t("web.guest_dm_failed_link", "https://t.me/agend_demo_bot?start=web")]);
    expect(tg.s.webGuestLoginCodes.size > 0, "withdrawn").toBe(false);
  });
  it("typed in any topic of the fleet (the table would point a non-admin elsewhere); never the code in the group", async () => {
    const h = rig("telegram");
    expect(await h.typed("alice", "/web", "T1")).toBe(true);
    const code = codeOf(h.adapter.sendDirect.mock.calls[0]![1]);
    expect(texts(h.adapter.sendText)).toEqual([t("web.guest_sent")]);
    expect(texts(h.adapter.sendText).join("\n")).not.toContain(code);
  });
  it("nothing in scope: no code — 'not set up' on an open connection with no named agents", async () => {
    const h = rig("discord", "open");
    await h.slash("alice");
    expect(h.adapter.sendDirect).not.toHaveBeenCalled();
    expect(h.respond.mock.calls[0]![0]).toBe(t("web.guest_not_set_up"));
    const n = rig();
    // (Someone the connection does not let in never gets this far: the slash door answers first.)
    n.fm.fleetConfig!.web = { guests: { enabled: true, narrow: { "owner:alice": [] } } } as never;
    await n.slash("alice");
    expect(n.respond.mock.calls[0]![0]).toBe(t("web.guest_nothing"));
    expect(n.s.webGuestLoginCodes.size > 0).toBe(false);
  });
  it("a guest's /web revoke: its own sessions and code; an admin's: everyone's", async () => {
    const h = rig();
    const create = (tier: string, owner?: any) => h.s.webSessions.create({ tier, surface: "local", label: tier, tokenEpoch: tokenEpoch(TOKEN), owner });
    create("guest", { adapterId: "owner", userId: "alice" }); create("guest", { adapterId: "owner", userId: "alice" });
    create("guest", { adapterId: "owner", userId: "bob" }); create("admin");
    await h.slash("alice");                                   // an outstanding code of hers
    h.respond.mockClear();
    await h.slash("alice", "revoke");
    expect(h.respond.mock.calls[0]![0]).toBe(t("web.guest_revoked", 2));
    expect(h.s.webGuestLoginCodes.hasCodeFor({ adapterId: "owner", userId: "alice" }), "her code too").toBe(false);
    const left = h.s.webSessions.list().map((r: any) => r.label).sort();
    expect(left).toEqual(["admin", "guest"]);                // bob's and the admin's
    // Another guest's revoke leaves her outstanding code alone; an admin's withdraws it with everything else.
    mono += 60_000; await h.slash("alice");
    expect(h.s.webGuestLoginCodes.hasCodeFor({ adapterId: "owner", userId: "alice" })).toBe(true);
    await h.slash("bob", "revoke");
    expect(h.s.webGuestLoginCodes.hasCodeFor({ adapterId: "owner", userId: "alice" }), "bob's revoke is not hers").toBe(true);
    h.respond.mockClear();
    await h.slash("admin", "revoke");
    expect(h.s.webSessions.list()).toEqual([]);
    expect(h.s.webGuestLoginCodes.hasCodeFor({ adapterId: "owner", userId: "alice" }), "an admin's revoke withdraws a guest's code too").toBe(false);
  });
  it("the channel copy of a guest's web message says so after the (clipped) name", () => {
    expect(formatWebChannelEcho("Alice", "hi", "full", { guest: true })).toBe("🌐 web · Alice (guest): hi");
    expect(formatWebChannelEcho("x".repeat(200), "hi", "full", { guest: true })).toContain(`${"x".repeat(80)} (guest): hi`);
    expect(formatWebChannelEcho("Alice", "hi")).toBe("🌐 web · Alice: hi");
  });
});

describe("GuestLoginCodes", () => {
  it("#2093 review: with no guest code outstanding (none issued, expired, burned) a wrong code counts against nothing", () => {
    let now = 0;
    const codes = new GuestLoginCodes({ now: () => now });
    for (let i = 0; i < 25; i++) codes.recordWrong("ZZZZ-ZZZZ");
    expect(codes.pausedForMs(), "none issued").toBe(0);
    // An expired code is nothing to guess: these five count against nothing — 15 more (with codes) do not pause, 20 do.
    codes.issue({ epoch: "e", recipient: { adapterId: "o", userId: "a" } }); now += LOGIN_CODE_TTL_MS;
    for (let i = 0; i < 5; i++) codes.recordWrong("ZZZZ-ZZZZ");
    for (let n = 0; n < 3; n++) { codes.issue({ epoch: "e", recipient: { adapterId: "o", userId: "a" } }); for (let i = 0; i < 5; i++) codes.recordWrong("ZZZZ-ZZZZ"); }
    expect(codes.pausedForMs(), "expired").toBe(0);
    now += 16 * 60_000;                                            // a fresh breaker window for the rest
    codes.issue({ epoch: "e", recipient: { adapterId: "o", userId: "a" } });
    for (let i = 0; i < 5; i++) codes.recordWrong("ZZZZ-ZZZZ");       // burned at the fifth
    for (let i = 0; i < 25; i++) codes.recordWrong("ZZZZ-ZZZZ");
    expect(codes.pausedForMs(), "burned").toBe(0);
    // The breaker's history stays across codes: 5 + 5 + 5 + 5 wrong tries on four codes in the window pause it.
    for (let n = 0; n < 3; n++) { codes.issue({ epoch: "e", recipient: { adapterId: "o", userId: "a" } }); for (let i = 0; i < 5; i++) codes.recordWrong("ZZZZ-ZZZZ"); }
    expect(codes.pausedForMs()).toBeGreaterThan(0);
  });
  it("a code matches only under its token, for its audience, before it expires, and not while paused", () => {
    let now = 0;
    const codes = new GuestLoginCodes({ now: () => now });
    const r = { adapterId: "owner", userId: "a" };
    const issue = () => codes.issue({ epoch: "e1", recipient: r })!.display;
    expect(codes.match(issue(), "e2"), "the token was rotated").toBeNull();
    expect(codes.size).toBe(0);
    expect(codes.match(issue(), "e1", "exposure-1"), "another audience").toBeNull();
    const c = issue(); now += LOGIN_CODE_TTL_MS;
    expect(codes.match(c, "e1"), "expired").toBeNull();
    const d = issue();
    for (let i = 0; i < 20; i++) { codes.issue({ epoch: "e1", recipient: { adapterId: "owner", userId: `x${i % 2}` } }); codes.recordWrong("ZZZZ-ZZZZ"); }
    codes.issue({ epoch: "e1", recipient: r });
    expect(codes.pausedForMs()).toBeGreaterThan(0);
    const e = codes.issue({ epoch: "e1", recipient: r })!.display;
    expect(codes.match(e, "e1"), "paused: even a right code").toBeNull();
    expect(d).not.toBe(e);
  });
});

describe("live: a guest code at /auth/login", () => {
  function post(port: number, body: unknown): Promise<{ status: number; body: string; cookies: string[] }> {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify(body);
      const r = request({ host: "127.0.0.1", port, method: "POST", path: "/auth/login", headers: { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`, "content-type": "application/json", "content-length": Buffer.byteLength(data) } }, (res) => {
        let b = ""; res.on("data", (c: Buffer) => { b += c.toString(); });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: b, cookies: ([] as string[]).concat(res.headers["set-cookie"] ?? []) }));
      });
      r.on("error", reject); r.end(data);
    });
  }
  async function live() {
    vi.mocked(performance.now).mockRestore?.();
    const h = rig();
    h.s.startHealthServer(0);
    await vi.waitFor(() => expect(h.s.healthServer?.address()).toBeTruthy());
    const port = h.s.healthServer.address().port as number;
    const notify = vi.spyOn(h.fm as any, "notifyFleetError").mockReturnValue(true);
    return { ...h, port, notify, close: () => new Promise<void>((r) => h.s.healthServer.close(() => r())) };
  }
  it("signs in as a guest bound to the account; said in General; a guest's returning device", async () => {
    const h = await live();
    try {
      await h.slash("alice");
      const code = codeOf(h.adapter.sendDirect.mock.calls[0]![1]);
      const r = await post(h.port, { code });
      expect(r.status).toBe(200);
      expect(JSON.parse(r.body)).toMatchObject({ ok: true, tier: "guest" });
      expect(r.cookies.some((c) => /agend_device/.test(c)), "a guest's returning device (4b)").toBe(true);
      const sessions = h.s.webSessions.list(undefined, (x: any) => x.tier === "guest");
      expect(sessions).toHaveLength(1);
      expect(h.notify.mock.calls.map((c: any[]) => c[0]).find((x: string) => x.includes("guest"))).toMatch(/^👤 A guest, .+ signed in to the web \(.+; 2 agents/);
    } finally { await h.close(); }
  });
  it("a guest signing in never counts against an admin's code; a code neither knows counts against both", async () => {
    const h = await live();
    try {
      const admin = h.s.issueDashboardLogin()!;
      await h.slash("alice");
      expect((await post(h.port, { code: codeOf(h.adapter.sendDirect.mock.calls[0]![1]) })).status).toBe(200);
      for (let i = 0; i < 4; i++) expect((await post(h.port, { code: "ZZZZ-ZZZZ" })).status).toBe(401);
      // Four wrong tries: the admin's code (dead at its fifth) still works — the guest's sign-in was not one of them.
      expect(JSON.parse((await post(h.port, { code: admin.display })).body)).toMatchObject({ ok: true, tier: "admin" });
    } finally { await h.close(); }
  });
  it("at /auth/login, a code neither knows counts against the guests' codes; their breaker open pauses sign-in (429)", async () => {
    const h = await live();
    try {
      await h.slash("alice");
      const code = codeOf(h.adapter.sendDirect.mock.calls[0]![1]);
      for (let i = 0; i < 5; i++) await post(h.port, { code: "ZZZZ-ZZZZ" });
      expect((await post(h.port, { code })).status, "burned at the fifth wrong try").toBe(401);
      // 15 more wrong tries, each with a code to guess (three codes, burned at five each): 20 in the window.
      for (let n = 0; n < 3; n++) { h.s.webGuestLoginCodes.issue({ epoch: tokenEpoch(TOKEN), recipient: { adapterId: "owner", userId: "x" } }); for (let i = 0; i < 5; i++) h.s.webGuestLoginCodes.recordWrong("ZZZZ-ZZZZ"); }
      const next = h.s.webGuestLoginCodes.issue({ epoch: tokenEpoch(TOKEN), recipient: { adapterId: "owner", userId: "alice" } })?.display ?? "ABCD-EFGH";
      const paused = await post(h.port, { code: next });
      expect(paused.status).toBe(429);
    } finally { await h.close(); }
  });
  it("#2093 review: wrong codes before any code exists (guests off) never make a later admin code 429", async () => {
    const h = await live();
    try {
      h.fm.fleetConfig!.web = { guests: { enabled: false } } as never;
      for (let i = 0; i < 20; i++) expect((await post(h.port, { code: "ZZZZ-ZZZZ" })).status).toBe(401);
      const admin = h.s.issueDashboardLogin()!;
      expect((await post(h.port, { code: admin.display })).status).toBe(200);
    } finally { await h.close(); }
  });
  it("refused when the account is no longer a guest with something to see (guests off since, or made an admin)", async () => {
    const h = await live();
    try {
      await h.slash("alice");
      const code = codeOf(h.adapter.sendDirect.mock.calls[0]![1]);
      h.s.worlds.get("owner").accessManager.isAllowed = () => false;      // removed from the connection's access
      expect((await post(h.port, { code })).status).toBe(401);
      expect(h.s.webSessions.list(undefined, (x: any) => x.tier === "guest")).toHaveLength(0);
    } finally { await h.close(); }
  });
});
