/**
 * #1586: the sign-in code can be copied on its own on a phone (a second private message holding only the code), and the
 * public link's expiry is shown in the fleet's zone with its offset. Rig: a real FleetManager with no fleet, as
 * public-web-menu-1367 (spawners, tmux, backend and inspector mocked to throw).
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
import { formatFleetTime, resolveTz } from "../src/tz-utils.js";
const rigs: Array<{dir: string; fm: FleetManager; s: any}> = [];
let mono = 0;
function rig(platform: "telegram" | "discord" = "telegram") {
  const dir = mkdtempSync(join(tmpdir(), "agend-login-copy-"));
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
const CODE = /[A-Z0-9]{4}-[A-Z0-9]{4}/;
const codeOf = (text: unknown) => CODE.exec(String(text))![0];

describe("#1586 formatFleetTime: the fleet's zone, always with its offset", () => {
  const at = Date.UTC(2026, 9, 10, 17, 30, 45);     // 2026-10-10 17:30:45 UTC
  it.each([
    ["Asia/Taipei", "2026-10-11 01:30 (UTC+8)"],
    ["Asia/Kolkata", "2026-10-10 23:00 (UTC+5:30)"],
    ["America/New_York", "2026-10-10 13:30 (UTC-4)"],   // daylight time in October
    ["UTC", "2026-10-10 17:30 (UTC)"],
  ])("%s → %s", (tz, expected) => {
    expect(formatFleetTime(at, tz)).toBe(expected);
  });
  it("a zone the runtime does not know falls back to UTC instead of throwing", () => {
    expect(formatFleetTime(at, "Not/AZone")).toBe("2026-10-10 17:30 (UTC)");
  });
  it("defaults to resolveTz(): the TZ override", () => {
    const saved = process.env.TZ;
    try { process.env.TZ = "Asia/Taipei"; expect(resolveTz()).toBe("Asia/Taipei"); expect(formatFleetTime(at)).toBe("2026-10-11 01:30 (UTC+8)"); }
    finally { if (saved === undefined) delete process.env.TZ; else process.env.TZ = saved; }
  });
});

describe("#1586 the sign-in DM: the code on its own, the link's expiry in the fleet's zone", () => {
  let savedTz: string | undefined;
  beforeEach(() => { savedTz = process.env.TZ; process.env.TZ = "Asia/Taipei"; });
  afterEach(() => { if (savedTz === undefined) delete process.env.TZ; else process.env.TZ = savedTz; });

  it("Telegram public link: the DM keeps code, hint, revoke and close button; the code follows alone in <code>, to the same user", async () => {
    const h = rig(); await h.typed(); await h.click("public");
    const calls = h.adapter.sendDirect.mock.calls;
    expect(calls).toHaveLength(2);
    const [to, text, opts] = calls[0]!;
    expect(to).toBe("admin");
    expect(text).toMatch(CODE);
    expect(text).toContain(t("dashboard.code_next"));
    expect(text).toContain("/dashboard revoke");
    expect(opts.choices[0].id).toMatch(/^dashboard:[a-f0-9]{32}:close$/);        // the close button stays on the sign-in DM
    expect(calls[1]).toEqual(["admin", `<code>${codeOf(text)}</code>`, { format: "html", disablePreview: true }]);
    expect(h.adapter.sendText.mock.calls.flat().join(" ")).not.toMatch(CODE);   // never into the group
  });

  it("the public link's expiry: the fleet's zone with its offset, never a UTC ISO string", async () => {
    const h = rig(); await h.typed(); await h.click("public");
    const text = String(h.adapter.sendDirect.mock.calls[0]![1]);
    const expiresAt = h.s.publicWebLink.status().expiresAt as number;
    expect(text).toContain(`${t("dashboard.private_link").split("\n")[3]!.replace("{3}", "")}${formatFleetTime(expiresAt, "Asia/Taipei")}`);
    expect(text).toMatch(/\d{4}-\d\d-\d\d \d\d:\d\d \(UTC\+8\)/);
    expect(text).not.toMatch(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z/);
  });

  it("the menu's status line shows the open link's expiry in the fleet's zone", async () => {
    const h = rig(); await h.typed(); await h.click("public");
    h.adapter.notifyAlert.mockClear(); await h.typed();
    const menu = String(h.adapter.notifyAlert.mock.calls.at(-1)![1].message);
    expect(menu).toContain(t("dashboard.public_until", formatFleetTime(h.s.publicWebLink.status().expiresAt, "Asia/Taipei")));
    expect(menu).toMatch(/\(UTC\+8\)/);
  });

  it("Discord local: the code follows alone as inline code (#1606: a tap copies it)", async () => {
    const h = rig("discord"); await h.slash(); await h.click("local");
    const calls = h.adapter.sendDirect.mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual(["admin", `\`${codeOf(calls[0]![1])}\``, { disablePreview: true }]);   // #1606: inline code
  });

  it("Discord ephemeral fallback: the code follows by the same route, a second private reply", async () => {
    const h = rig("discord"); h.adapter.sendDirect.mockRejectedValue(Error("DM disabled")); await h.slash();
    const privateReply = vi.fn(async (_text: string, _c?: unknown) => ({ messageId: "private", chatId: "T0", retire: async () => {} }));
    await h.click("local", { respondPrivate: privateReply });
    expect(privateReply).toHaveBeenCalledTimes(2);
    expect(privateReply.mock.calls[0]![0]).toContain(t("dashboard.code_next"));
    expect(privateReply.mock.calls[1]![0]).toBe(`\`${codeOf(privateReply.mock.calls[0]![0])}\``);
  });

  it("a code-only follow-up that fails changes nothing: the delivery succeeds and the code still works", async () => {
    const h = rig(); h.adapter.sendDirect.mockImplementation(async (user: string, text: string) => {
      if (/^<code>/.test(text)) throw Error("rate limited");
      return { chatId: user, messageId: "dm" };
    });
    await h.typed(); await h.click("local");
    expect(h.adapter.sendDirect).toHaveBeenCalledTimes(2);
    expect(h.s.webLoginCodes.hasOutstandingCode).toBe(true);
    const code = codeOf(h.adapter.sendDirect.mock.calls[0]![1]);
    expect(h.s.webLoginCodes.redeem(code, tokenEpoch("c".repeat(48))).kind).toBe("ok");
    expect(String((h.adapter.editMessageRemoveButtons.mock.calls.at(-1) as unknown[] | undefined)?.[2] ?? "")).not.toContain(t("dashboard.private_failed"));
  });

  it("Discord /dashboard outside General: DM then the code alone; the slash reply's own fallback is ONE message, without the hint", async () => {
    const h = rig("discord"); await h.slash("admin", "T1");
    expect(h.adapter.sendDirect.mock.calls).toHaveLength(2);
    expect(h.adapter.sendDirect.mock.calls[0]![1]).toContain(t("dashboard.code_next"));
    expect(h.adapter.sendDirect.mock.calls[1]![1]).toBe(`\`${codeOf(h.adapter.sendDirect.mock.calls[0]![1])}\``);

    const g = rig("discord"); g.adapter.sendDirect.mockRejectedValue(Error("DM disabled")); await g.slash("admin", "T1");
    expect(g.respond).toHaveBeenCalledTimes(1);
    expect(g.respond.mock.calls[0]![0]).toMatch(CODE);
    expect(g.respond.mock.calls[0]![0]).not.toContain(t("dashboard.code_next"));
  });
});

describe("#1586 review (Prism r1): the follow-up's wait never outlives the owner, and never fails a confirmed delivery", () => {
  /** sendDirect: the sign-in message goes at once; the code-only follow-up is held until released. */
  function holdFollowUp(h: ReturnType<typeof rig>) {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    h.adapter.sendDirect.mockImplementation(async (user: string, text: string) => {
      if (/^<code>|^`?[A-Z0-9]{4}-[A-Z0-9]{4}`?$/.test(text)) await held;
      return { chatId: user, messageId: "dm" };
    });
    return () => release();
  }

  it.each([[true, "an owner removed while the follow-up waits: the code is withdrawn and the delivery reported failed"],
    [false, "control — the same owner: delivered, the code stays"]] as const)("menu local (Telegram), owner removed = %s: %s", async (demote, _label) => {
    const h = rig(); const release = holdFollowUp(h);
    await h.typed(); const click = h.click("local"); await flush();
    expect(h.adapter.sendDirect).toHaveBeenCalledTimes(2);
    expect(h.s.webLoginCodes.hasOutstandingCode).toBe(true);
    if (demote) h.owner.access.allowed_users = ["admin2"];
    release(); await click; await flush();
    expect(h.s.webLoginCodes.hasOutstandingCode).toBe(!demote);
  });

  it.each([true, false])("Discord /dashboard outside General, owner removed during the follow-up = %s", async (demote) => {
    const h = rig("discord"); const release = holdFollowUp(h);
    const slash = h.slash("admin", "T1"); await flush();
    expect(h.adapter.sendDirect).toHaveBeenCalledTimes(2);
    if (demote) h.owner.access.allowed_users = ["admin2"];
    release(); await slash; await flush();
    expect(h.s.webLoginCodes.hasOutstandingCode).toBe(!demote);
    expect(h.respond).toHaveBeenLastCalledWith(t(demote ? "dashboard.private_failed" : "dashboard.private_sent_dm"));
  });

  it("a follow-up that never answers, with the clock already past the delivery's budget: the DM stands and is reported sent", async () => {
    const h = rig("discord");
    h.adapter.sendDirect.mockImplementation(async (user: string, text: string) => {
      if (/^`?[A-Z0-9]{4}-[A-Z0-9]{4}`?$/.test(text)) return new Promise<never>(() => {});
      return { chatId: user, messageId: "dm" };
    });
    const slash = h.slash("admin", "T1"); await flush();
    mono = 10_001;                                   // an event-loop stall: the 10 s delivery budget is spent
    await vi.advanceTimersByTimeAsync(5_000); await slash; await flush();
    expect(h.s.webLoginCodes.hasOutstandingCode).toBe(true);
    expect(h.respond).toHaveBeenLastCalledWith(t("dashboard.private_sent_dm"));
  });
});

describe("#1606 Discord: the code-only message is inline code, alone; Telegram stays <code>", () => {
  it("every caller: the menu (local), /dashboard outside General, and the ephemeral fallback all send exactly `CODE`", async () => {
    const menu = rig("discord"); await menu.slash(); await menu.click("local");
    expect(menu.adapter.sendDirect.mock.calls[1]![1]).toMatch(/^`[A-Z2-7]{4}-[A-Z2-7]{4}`$/);
    const outside = rig("discord"); await outside.slash("admin", "T1");
    expect(outside.adapter.sendDirect.mock.calls[1]![1]).toMatch(/^`[A-Z2-7]{4}-[A-Z2-7]{4}`$/);
    // /web is /dashboard under a shorter name (#1569): the same path, the same follow-up.
    const web = rig("discord");
    await web.s.dispatchSlash({ command: "web", guildId: "G", channelId: "T1", userId: "admin", username: "admin", options: {}, respond: web.respond, respondButtons: web.respondButtons }, "owner", web.adapter);
    expect(web.adapter.sendDirect.mock.calls[1]![1]).toMatch(/^`[A-Z2-7]{4}-[A-Z2-7]{4}`$/);
    const tg = rig(); await tg.typed(); await tg.click("local");
    expect(tg.adapter.sendDirect.mock.calls[1]![1]).toMatch(/^<code>[A-Z2-7]{4}-[A-Z2-7]{4}<\/code>$/);
  });

  it("a backtick can never be in a code: the alphabet is A–Z, 2–7 and the dash (and one would go bare, not break the markdown)", async () => {
    const { generateOneTimeCode, formatOneTimeCode } = await import("../src/auth/one-time-code.js");
    for (let n = 0; n < 2000; n++) expect(formatOneTimeCode(generateOneTimeCode())).toMatch(/^[A-Z2-7]{4}-[A-Z2-7]{4}$/);
    const sent: string[] = [];
    await (rig("discord").s).sendCodeAlone(async (body: string) => { sent.push(body); }, "discord", "AB`C-DEFG");
    expect(sent).toEqual(["AB`C-DEFG"]);
  });
});

