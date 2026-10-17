/**
 * #1920 phase 2 (step 4b-1, §5.5): guests over the public link — only an admin opens it; a guest is still a guest there.
 * - A guest's /web while the link is open: its code also works through that link, and the DM gives the link.
 * - Its sign-in there is said in the General of the admin who opened it (who, how many agents), awaited before the
 *   session works — the link still the open one, its opener current, the account still an admitted guest; else 503.
 * - The link closing withdraws only that audience: the code still works on the dashboard reached directly.
 * Rig: the real auth handler with a fake gateway request (as public-web-auth-1367), and a real FleetManager with no fleet
 * (as web-guest-signin-1920).
 */
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("node:child_process", async original => ({ ...await original<typeof import("node:child_process")>(),
  spawn: () => { throw Error("No process"); }, execFile: () => { throw Error("No CLI"); }, execFileSync: () => { throw Error("No CLI"); }, execSync: () => { throw Error("No CLI"); }, spawnSync: () => { throw Error("No CLI"); } }));
vi.mock("node:inspector", () => ({ Session: class { constructor() { throw Error("No inspector"); } } }));
vi.mock("../src/backend/index.js", async original => ({ ...await original<typeof import("../src/backend/index.js")>(), createBackend: () => { throw Error("No backend"); } }));
vi.mock("../src/tmux-manager.js", async original => ({ ...await original<typeof import("../src/tmux-manager.js")>(), TmuxManager: new Proxy({}, { get: () => () => { throw Error("No tmux"); } }) }));
vi.mock("../src/logger.js", () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), child() { return this; } }) }));
import { FleetManager } from "../src/fleet-manager.js";
import { WebSessionStore, tokenEpoch } from "../src/web-session.js";
import { GuestLoginCodes, WebLoginCodes } from "../src/web-login.js";
import { handleAuthRequest } from "../src/auth-api.js";
import { bindGatewayRequest } from "../src/web-request-context.js";
import { setLocale, t } from "../src/locale.js";
import { PublicWebLink } from "../src/public-web-link.js";

const X = "a".repeat(32), TOKEN = "c".repeat(48), ORIGIN = "https://sample.trycloudflare.com";
const ALICE = { adapterId: "owner", userId: "alice" };
const logger = { info: vi.fn(), debug: vi.fn(), error: vi.fn(), warn: vi.fn() };
function request(path: string, headers: Record<string, string> = {}) {
  const req = Object.assign(new EventEmitter(), { method: "POST", url: path, headers: { host: "sample.trycloudflare.com", origin: ORIGIN, "content-type": "application/json", ...headers } as Record<string, string>, destroy: vi.fn() });
  let status = 0, body = ""; const out: any = {};
  const res = { destroyed: false, headersSent: false, setHeader: (k: string, v: any) => { out[k] = v; }, writeHead: (code: number, h = {}) => { status = code; Object.assign(out, h); }, end: (text = "") => { body = text; }, destroy: vi.fn() };
  return { req, res, out, status: () => status, body: () => body, feed: (value: unknown) => { req.emit("data", Buffer.from(JSON.stringify(value))); req.emit("end"); } };
}
async function flush() { for (let n = 0; n < 30; n++) await Promise.resolve(); }

describe("a guest code through the public link (the real auth handler)", () => {
  const login = async (codes: GuestLoginCodes, code: string, extra: Record<string, unknown> = {}, exposureId = X) => {
    const store = new WebSessionStore();
    const h = request("/auth/login");
    bindGatewayRequest(h.req, { surface: "gateway", exposureId, expectedOrigin: ORIGIN, isCurrent: () => true });
    const confirmGuest = vi.fn(async () => {}), confirmAdmin = vi.fn(async () => {});
    handleAuthRequest(h.req as never, h.res as never, new URL(h.req.url, ORIGIN), { webToken: TOKEN, webSessions: store, webLoginCodes: new WebLoginCodes(), webGuestLoginCodes: codes,
      guestSignInAllowed: () => true, logger: logger as never, confirmPublicWebLogin: confirmAdmin, confirmGuestPublicWebLogin: confirmGuest, ...extra } as never);
    h.feed({ code }); await flush();
    return { h, store, confirmGuest, confirmAdmin };
  };
  it("a code issued while the link was open signs in there as a guest, after its own notice; never the admin's", async () => {
    const codes = new GuestLoginCodes();
    const issued = codes.issue({ epoch: tokenEpoch(TOKEN), recipient: ALICE, audiences: ["local", X] })!;
    const { h, store, confirmGuest, confirmAdmin } = await login(codes, issued.display);
    expect(h.status()).toBe(200);
    expect(confirmGuest).toHaveBeenCalledWith(expect.objectContaining({ account: ALICE, exposureId: X }), expect.any(Function));
    expect(confirmAdmin).not.toHaveBeenCalled();
    expect(store.list()).toEqual([expect.objectContaining({ tier: "guest", surface: "gateway" })]);
  });
  it("a code for the dashboard reached directly only, or for another link, is refused through this one", async () => {
    const codes = new GuestLoginCodes();
    const local = codes.issue({ epoch: tokenEpoch(TOKEN), recipient: ALICE })!;
    expect((await login(codes, local.display)).h.status()).toBe(401);
    const other = codes.issue({ epoch: tokenEpoch(TOKEN), recipient: { adapterId: "owner", userId: "bob" }, audiences: ["local", "b".repeat(32)] })!;
    expect((await login(codes, other.display)).h.status()).toBe(401);
  });
  it("its notice refused (link closed, opener gone, account no longer a guest): 503, no session", async () => {
    const codes = new GuestLoginCodes();
    const issued = codes.issue({ epoch: tokenEpoch(TOKEN), recipient: ALICE, audiences: ["local", X] })!;
    const { h, store } = await login(codes, issued.display, { confirmGuestPublicWebLogin: vi.fn(async () => { throw new Error("guest public sign-in unavailable"); }) });
    expect(h.status()).toBe(503);
    expect(store.size).toBe(0);
  });
  it("the link closing withdraws only that audience: the code still works directly, no more through the link", () => {
    const codes = new GuestLoginCodes();
    const issued = codes.issue({ epoch: tokenEpoch(TOKEN), recipient: ALICE, audiences: ["local", X] })!;
    codes.revokeAudience(X);
    expect(codes.match(issued.display, tokenEpoch(TOKEN), X)).toBeNull();
    expect(codes.match(issued.display, tokenEpoch(TOKEN), "local")).toMatchObject({ kind: "ok" });
    const linkOnly = codes.issue({ epoch: tokenEpoch(TOKEN), recipient: { adapterId: "owner", userId: "bob" }, audiences: [X] })!;
    codes.revokeAudience(X);
    expect(codes.match(linkOnly.display, tokenEpoch(TOKEN), "local"), "a code for that link only is gone").toBeNull();
  });
});

const rigs: Array<{ dir: string; fm: FleetManager }> = [];
let mono = 0;
function rig() {
  const dir = mkdtempSync(join(tmpdir(), "agend-1920p-"));
  const fm = new FleetManager(dir), s = fm as any;
  const adapter = { id: "owner", type: "discord", sendText: vi.fn(async (chat: string, _text: string, opts?: any) => ({ chatId: chat, threadId: opts?.threadId, messageId: "safe" })),
    sendDirect: vi.fn(async (_user: string, _text: string) => ({ chatId: "DM", messageId: "dm" })), stop: vi.fn(async () => {}) };
  const channel = { id: "owner", type: "discord", group_id: "G", bot_token_env: "NONE", access: { mode: "allowlist", allowed_users: ["admin"] } };
  fm.fleetConfig = { defaults: {}, channel, channels: [channel], web: { guests: { enabled: true } }, instances: {
    general: { working_directory: dir, general_topic: true, topic_id: "T0", channel_id: "owner" },
    worker: { working_directory: dir, topic_id: "T1", channel_id: "owner" },
  } } as never;
  fm.routing.rebuild(fm.fleetConfig!); s.adapters.set("owner", adapter); s.adapter = adapter;
  s.worlds.set("owner", { adapter, groupId: "G", channelConfig: channel, accessManager: { isAllowed: () => true, getMode: () => "allowlist" }, stop: async () => {} });
  s.classicChannels = { isClassicChannel: () => false, hasChannel: () => false, getAll: () => [] };
  writeFileSync(join(dir, "web.token"), TOKEN, { mode: 0o600 }); s.initializeWebSessions();
  vi.spyOn(fm, "getDashboardAccess").mockReturnValue({ ready: true, token: TOKEN });
  const opener = { binding: adapter, adapterId: "owner", userId: "admin", chatId: "G", threadId: "T0" };
  let link: { exposureId: string; url: string; owner: any } | null = { exposureId: X, url: `${ORIGIN}/signin`, owner: opener };
  s.publicWebLink = { openSignin: () => link, close: async () => ({ confirmed: true }), status: () => ({ state: link ? "open" : "closed" }), exposureId: X };
  const respond = vi.fn(async (_text: string) => "slash");
  const slash = (user: string) => s.dispatchSlash({ command: "web", guildId: "G", channelId: "T1", userId: user, username: user, options: {}, respond, respondButtons: vi.fn(async () => "menu") }, "owner", adapter);
  const h = { dir, fm, s, adapter, respond, slash, opener, setLink: (v: typeof link) => { link = v; } }; rigs.push(h); return h;
}
beforeEach(() => { setLocale("en"); mono = 1_000_000; vi.spyOn(performance, "now").mockImplementation(() => mono); });
afterEach(() => {
  for (const h of rigs.splice(0)) { h.fm.stormWindow.shutdown(); h.fm.spawnGate.shutdown(); rmSync(h.dir, { recursive: true, force: true }); }
  vi.restoreAllMocks();
});
const codeOf = (text: unknown) => /[A-Z0-9]{4}-[A-Z0-9]{4}/.exec(String(text))![0];

describe("PublicWebLink.openSignin", () => {
  it("only an open, current exposure — not one starting or closing, nor one whose opener is no longer permitted", () => {
    let permitted = true;
    const link = new PublicWebLink({ dataDir: tmpdir(), web: () => undefined, permitted: () => permitted, now: () => 0 } as never) as any;
    const owner = { adapterId: "owner", userId: "admin", chatId: "G" };
    const entry = { id: X, owner, phase: "starting", url: `${ORIGIN}/signin`, deadline: 1_000, closing: undefined, abort: new AbortController() };
    link.entry = entry;
    expect(link.openSignin(), "starting").toBeNull();
    entry.phase = "open";
    expect(link.openSignin()).toEqual({ exposureId: X, url: `${ORIGIN}/signin`, owner });
    permitted = false;
    expect(link.openSignin(), "its opener is no longer permitted").toBeNull();
    permitted = true; (entry as any).closing = Promise.resolve();
    expect(link.openSignin(), "closing").toBeNull();
  });
});

describe("the fleet: a guest's /web while the public link is open", () => {
  it("the DM gives the link, and the code works through it and directly; closed: directly only", async () => {
    const h = rig();
    await h.slash("alice");
    const dm = String(h.adapter.sendDirect.mock.calls[0]![1]);
    expect(dm).toContain(t("web.guest_public", `${ORIGIN}/signin`));
    const code = codeOf(dm);
    expect(h.s.webGuestLoginCodes.match(code, tokenEpoch(TOKEN), X)).toMatchObject({ kind: "ok", tier: "guest" });
    h.setLink(null); mono += 60_000; h.adapter.sendDirect.mockClear();
    await h.slash("alice");
    const closed = String(h.adapter.sendDirect.mock.calls[0]![1]);
    expect(closed).not.toContain(ORIGIN);
    expect(h.s.webGuestLoginCodes.match(codeOf(closed), tokenEpoch(TOKEN), X)).toBeNull();
  });
  it("the real link's closing (its revoke) withdraws that audience from guest codes", () => {
    const h = rig();
    const real = (h.s.publicWebLink = null, h.s.getPublicWebLink()) as any;
    const issued = h.s.webGuestLoginCodes.issue({ epoch: tokenEpoch(TOKEN), recipient: ALICE, audiences: ["local", X] });
    real.deps.revoke(X);
    expect(h.s.webGuestLoginCodes.match(issued.display, tokenEpoch(TOKEN), X)).toBeNull();
    expect(h.s.webGuestLoginCodes.match(issued.display, tokenEpoch(TOKEN), "local")).toMatchObject({ kind: "ok" });
  });
  it("confirmGuestPublicWebLogin: said in the opener's General, while it all still holds; else it throws", async () => {
    const h = rig();
    const info = { label: "Firefox", handle: "h".repeat(32), account: ALICE, exposureId: X };
    await h.s.confirmGuestPublicWebLogin(info, () => true);
    const [chat, text, opts] = h.adapter.sendText.mock.calls.at(-1)!;
    expect([chat, opts?.threadId]).toEqual(["G", "T0"]);
    expect(String(text)).toMatch(/^👤 A guest, .+ signed in through the public link \(Firefox; 2 agents/);
    h.adapter.sendText.mockClear();
    await expect(h.s.confirmGuestPublicWebLogin({ ...info, exposureId: "b".repeat(32) }, () => true), "another link").rejects.toThrow();
    await expect(h.s.confirmGuestPublicWebLogin(info, () => false), "the request is gone").rejects.toThrow();
    h.fm.fleetConfig!.web = { guests: { enabled: true, narrow: { "owner:alice": [] } } } as never;
    await expect(h.s.confirmGuestPublicWebLogin(info, () => true), "nothing in scope").rejects.toThrow();
    h.fm.fleetConfig!.web = { guests: { enabled: true } } as never;
    h.setLink({ exposureId: X, url: `${ORIGIN}/signin`, owner: { ...h.opener, userId: "not-an-admin" } });
    await expect(h.s.confirmGuestPublicWebLogin(info, () => true), "the opener is no longer current").rejects.toThrow();
    expect(h.adapter.sendText).not.toHaveBeenCalled();
    // Changed while the notice was on its way: the sign-in is refused all the same.
    h.setLink({ exposureId: X, url: `${ORIGIN}/signin`, owner: h.opener });
    h.adapter.sendText.mockImplementationOnce(async () => { h.setLink(null); return { chatId: "G", threadId: "T0", messageId: "n" }; });
    await expect(h.s.confirmGuestPublicWebLogin(info, () => true)).rejects.toThrow("changed");
  });
});
