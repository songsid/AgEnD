/**
 * AGEND-122 (upstream #3486, R1) on the first rule this file held (D3, decision bcbb541f / M-2623: "the host's own session
 * here confirms what no General can take", #2453: "a link option turned on is the host's own session only", #3366 review: "a
 * link opener never reaches a web-verified admin's Apply now, nor a code"). Those host-only rules are gone: any signed-in
 * human admin on a web cookie session may press Apply now (settingsSelfConfirmation, src/authority/settings-role.ts) from
 * wherever the dashboard is reached, for every class of change — chat fleet or web-only. What this file now proves:
 *   - the launch-link session (`agend web`, the host's own) confirms at Save as before; from another device (forwarded, a LAN or
 *     tailnet Host) it is the same session and the same Apply now — no General's card, no chat DM, no host session needed;
 *   - what still never confirms: a chat fleet's owner-less session that is not the host's (no account), a guest, a header token,
 *     a local session over the gateway; the owner's knobs (the web authorization switch, "Only this computer can authorize");
 *     and the session / switch / admin list asked again at execution;
 *   - the link-opening class (turning the named / quick link on) is marked `opensLink` only — Apply now works for it, a
 *     confirmation from another device posts a Notice, and in strict mode (`remote_confirm_code`) it is never confirmed over a
 *     public link (`totp: "on_host"`, `not_here`), though a LAN device may confirm it with the authenticator's code.
 * The shared provenance helper's own table is B2b's (tests/settings-totp-confirm-b2b.test.ts).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { request, type Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FleetManager } from "../src/fleet-manager.js";
import { csrfTokenFor, tokenEpoch, type SessionRecord } from "../src/web-session.js";
import { SettingsConfirmationStore } from "../src/settings-confirmation.js";
import { prepareSettingsEffect } from "../src/settings-effect.js";
import { WEB_CSRF_HEADER, WEB_SESSION_COOKIE, WEB_SESSION_COOKIE_SECURE } from "../src/web-auth.js";
import { bindGatewayRequest } from "../src/web-request-context.js";
import { setLocale } from "../src/locale.js";
import { base32Encode, base32Decode, hotp, totpStep, WEB_REMOTE_ACCESS_FILE } from "../src/web-remote-access.js";

const dirs: string[] = [], stores: SettingsConfirmationStore[] = [];
afterEach(() => { for (const s of stores.splice(0)) s.close(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); vi.restoreAllMocks(); });

// ── A real fleet: its web server, sign-in over HTTP ──
interface Res { status: number; headers: Record<string, string | string[] | undefined>; body: string }
function raw(port: number, method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<Res> {
  return new Promise((resolve, reject) => {
    const r = request({ host: "127.0.0.1", port, method, path, headers }, res => {
      let text = ""; res.on("data", (c: Buffer) => { text += c.toString(); });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }));
    });
    r.on("error", reject); if (body !== undefined) r.write(body); r.end();
  });
}
// A chat fleet has a General: whole-fleet changes (`primaryGeneral`) also need the account to be an admin of the primary General's connection.
const CHAT = { channel: { type: "telegram", mode: "topic", bot_token_env: "T", group_id: "-100", access: { mode: "locked", allowed_users: ["1"] } }, instances: { general: { working_directory: "/tmp/agend-122-general", general_topic: true } } };
const ACCOUNT = { adapterId: "telegram", userId: "1" };                     // CHAT's one admin: adminGate("1", "telegram") is "ok"
const SECRET = base32Encode(Buffer.from("0123456789abcdefghij"));
const codeAt = (ms: number) => hotp(base32Decode(SECRET)!, totpStep(ms));
const AWAY = { "x-forwarded-for": "198.51.100.7" };                         // another device behind a proxy: a direct connection, not this computer
const EXPOSURE = "e".repeat(32), LINK_ORIGIN = "https://abc.trycloudflare.com";
const STRICT = { web: { verified_authority: { enabled: true, remote_confirm_code: true } } };
const ENROLLED = JSON.stringify({ v: 1, totp: { secret: SECRET, enrolledAt: 1, lastStep: 0 }, outside: false, wrong: 0, level: 0, pausedUntil: 0, handles: [] });
async function startFleet(config: Record<string, unknown> = {}, opts: { enrolled?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "agend-d3-")); dirs.push(dir);
  if (opts.enrolled) writeFileSync(join(dir, WEB_REMOTE_ACCESS_FILE), ENROLLED, { mode: 0o600 });
  const fm = new FleetManager(dir), any = fm as any;
  const sink = () => {};
  fm.logger = { info: sink, warn: sink, error: sink, debug: sink, trace: sink, fatal: sink, child: () => fm.logger } as unknown as typeof fm.logger;
  const notify = vi.spyOn(fm, "notifyFleetError").mockImplementation(() => true);          // the Notice a remote confirmation posts
  fm.fleetConfig = { defaults: {}, instances: {}, web: { verified_authority: { enabled: true } }, ...config } as never;
  any.initializeWebAuthTokens();
  any.startHealthServer(0);
  await vi.waitFor(() => expect(fm.getDashboardAccess().ready).toBe(true));
  const address = (any.healthServer as Server).address();
  if (!address || typeof address === "string") throw new Error("missing TCP address");
  const port = address.port, origin = `http://127.0.0.1:${port}`, token = fm.getDashboardAccess().token!;
  const stop = () => new Promise<void>(resolve => { const s = any.healthServer as Server | null; any.healthServer = null; s ? s.close(() => resolve()) : resolve(); });
  /** The launch link's own code (`agend web`), or another code; signed in from where `extra` says. */
  const signIn = async (code?: string, extra: Record<string, string> = {}) => {
    code ??= JSON.parse((await raw(port, "POST", "/auth/issue-code", { "x-agend-token": token, origin })).body).code as string;
    const res = await raw(port, "POST", "/auth/login", { "content-type": "application/json", origin, ...extra }, JSON.stringify({ code }));
    expect(res.status).toBe(200);
    const set = res.headers["set-cookie"]; const sessionId = (Array.isArray(set) ? set[0] : set)!.split(";")[0]!.split("=")[1]!;
    return { sessionId, record: any.webSessions.authenticate(sessionId, tokenEpoch(token), { touch: false }) as SessionRecord };
  };
  /** A session made directly: a guest, a chat account's, one over the public link (a web-only fleet's `remote` is the owner signed in from outside). */
  const session = (o: { tier?: "admin" | "guest"; owner?: { adapterId: string; userId: string }; link?: boolean; remote?: true } = {}) => {
    const c = any.webSessions.create({ tier: o.tier ?? "admin", surface: o.link ? "gateway" : "local", label: "browser", tokenEpoch: tokenEpoch(token),
      ...(o.owner ? { owner: o.owner } : {}), ...(o.link ? { exposureId: EXPOSURE } : {}), ...(o.remote ? { remote: "totp" as const } : {}) });
    return { sessionId: c.sessionId as string, record: c.record as SessionRecord };
  };
  /** A request carrying a session's cookie, from where `extra` says; over the public link (the quick link, or the named one) when `link` is given. */
  const reqOf = (sessionId: string, extra: Record<string, string> = {}, link?: "quick" | "named") => {
    const host = extra.host ?? `127.0.0.1:${port}`;                                          // a Host of its own is the page's own origin too
    const req: any = { method: "PUT", socket: { remoteAddress: "127.0.0.1" },
      headers: { origin: `http://${host}`, "sec-fetch-site": "same-origin", cookie: `${link ? WEB_SESSION_COOKIE_SECURE : WEB_SESSION_COOKIE}=${sessionId}`, [WEB_CSRF_HEADER]: csrfTokenFor(sessionId), ...extra, host } };
    if (link) { req.headers.origin = LINK_ORIGIN; bindGatewayRequest(req, { surface: "gateway", exposureId: EXPOSURE, expectedOrigin: LINK_ORIGIN, isCurrent: () => true, ...(link === "named" ? { named: true } : {}) }); }
    return req;
  };
  return { fm, any, port, origin, token, notify, stop, signIn, session, reqOf };
}
type Fleet = Awaited<ReturnType<typeof startFleet>>;
/**
 * A held change with an apply that only records it ran: connecting a Telegram bot (it needs confirming), or — "link" — turning the named
 * link on (marked `opensLink`, as the gate passes it). `section: "secret"` stands for one that changes a secret.
 */
function held(h: Fleet, kind: "ordinary" | "link" = "ordinary", opts: { section?: string } = {}) {
  const store = new SettingsConfirmationStore({ audit: vi.fn(), notify: vi.fn() }); stores.push(store);
  const effect = kind === "link" ? prepareSettingsEffect("PUT", "/api/settings/fleet/web", { verified_authority: { named_link: true } }, { config: h.fm.fleetConfig, classic: {} })
    : prepareSettingsEffect("PUT", "/api/settings/fleet/channels", [{ ...CHAT.channel, id: "tg" }], { config: h.fm.fleetConfig, classic: {} });
  const apply = vi.fn(async (_c: () => boolean, execution: any) => execution.commit(() => "applied"));
  const view = store.propose({ session: "browser", key: `k${Math.random()}`, bytes: 1, source: "web_session", section: (opts.section ?? effect.diff!.section) as any, requestedBy: "browser",
    fingerprint: effect.diff!.fingerprint, summary: effect.diff!.summary, affectedConnections: effect.diff!.affectedConnections, authority: effect.diff!.authority,
    ...(effect.diff!.opensLink ? { opensLink: true as const } : {}), current: () => true, unchanged: async () => true, snapshot: () => null, apply }).view;
  return { store, view, apply };
}
type Held = ReturnType<typeof held>;
/** The Notices a confirmation from another device posts (a new web sign-in posts its own Notice; not counted). */
const remoteNotices = (h: { notify: { mock: { calls: unknown[][] } } }) => h.notify.mock.calls.filter(c => /Settings change/.test(String(c[0])));
/** Apply now, as the gate asks for it: the request's own role over the change. */
const ask = (h: Fleet, a: Held, sessionId: string, extra: Record<string, string> = {}, link?: "quick" | "named") => h.any.settingsSelfConfirmation(a.store, h.reqOf(sessionId, extra, link), a.view.id);
/** Decide it as the gate does: the store decides, then the confirmation's `done` runs (the Notice, when it owes one). */
async function confirm(a: Held, how: any) { const view = await a.store.decide(a.view.id, "confirm", { ...how, via: "web" }); how.done?.(view); return view; }

describe("D3 on a chat fleet (AGEND-122): any signed-in admin session confirms a change from anywhere; one with no standing never does", () => {
  it("the launch-link session on this computer confirms it — labelled this fleet's admin, applied once, no card, no Notice (it is this computer)", async () => {
    setLocale("en");
    const h = await startFleet(CHAT);
    try {
      const s = await h.signIn();
      const a = held(h);
      const self = ask(h, a, s.sessionId);
      expect([self?.label, self?.current()]).toEqual(["This fleet's admin", true]);
      const done = await confirm(a, self);
      expect([done.state, done.outcome?.decided_by_label, a.apply.mock.calls.length, remoteNotices(h).length]).toEqual(["applied", "This fleet's admin", 1, 0]);
    } finally { await h.stop(); }
  }, 20_000);
  it("from another device too — forwarded, a LAN or public-named Host: the same session gets Apply now (it was none before); an ordinary change posts no Notice", async () => {
    setLocale("en");
    const h = await startFleet(CHAT);
    try {
      const host = await h.signIn();
      for (const extra of [AWAY, { host: "agend.example.test" }, { host: "192.168.1.5:19280" }]) {
        const a = held(h);
        const self = ask(h, a, host.sessionId, extra);
        expect([self?.label, self?.current()], JSON.stringify(extra)).toEqual(["This fleet's admin", true]);
        expect((await confirm(a, self)).state).toBe("applied");
      }
      expect(remoteNotices(h)).toEqual([]);                       // not a link opener, not a secret: the audit trail is enough
    } finally { await h.stop(); }
  }, 20_000);
  it("no standing, no Apply now: another code's session (no chat account, not the host's), a guest, a header token, the host's cookie over the public link; the switch off, or only-this-computer", async () => {
    const h = await startFleet(CHAT);
    try {
      const host = await h.signIn();
      const chatCode = await h.signIn(h.fm.issueDashboardLogin()!.display);            // a code sent by chat, used here
      const guest = h.session({ tier: "guest", owner: ACCOUNT });
      const a = held(h);
      const why = (req: any) => [h.any.settingsSelfConfirmation(a.store, req, a.view.id), h.any.settingsRole(req).role.reason];     // Apply now, and the refusal that says why
      expect([chatCode.record.host, ...why(h.reqOf(chatCode.sessionId))]).toEqual([undefined, null, "no_account"]);        // chat fleet: an owner-less admin must be the host's own
      expect([why(h.reqOf(chatCode.sessionId, AWAY)), why(h.reqOf(guest.sessionId))]).toEqual([[null, "no_account"], [null, "not_admin_session"]]);
      const token = { method: "PUT", socket: { remoteAddress: "127.0.0.1" }, headers: { host: `127.0.0.1:${h.port}`, origin: h.origin, "x-agend-token": h.token } };
      expect(why(token)).toEqual([null, "not_session"]);                                              // the CLI's / a script's header token: never
      expect(why(h.reqOf(host.sessionId, {}, "quick"))).toEqual([null, "not_session"]);              // a local session's cookie over the public link: not that surface
      expect(a.apply).not.toHaveBeenCalled();
      // The owner's knobs, asked of the live policy: "Only this computer can authorize" ends it off this computer, the switch off ends it everywhere.
      const va = (h.fm.fleetConfig as any).web.verified_authority;
      va.loopback_only = true;
      expect([why(h.reqOf(host.sessionId, AWAY)), ask(h, a, host.sessionId)?.label]).toEqual([[null, "loopback_only"], "This fleet's admin"]);
      delete va.loopback_only; va.enabled = false;
      expect([why(h.reqOf(host.sessionId)), why(h.reqOf(host.sessionId, AWAY))]).toEqual([[null, "disabled"], [null, "disabled"]]);
    } finally { await h.stop(); }
  }, 20_000);
  it("a General's card no longer decides it (D1 is gone); asked again when it is confirmed: the session signed out, or the switch turned off, refuses it; the fleet turning web-only does not", async () => {
    const h = await startFleet(CHAT);
    try {
      const s = await h.signIn();
      vi.spyOn(h.any, "settingsCardPossible").mockReturnValue(true);                 // a General could take it: its card is another way, not the only one
      const a = held(h), self = ask(h, a, s.sessionId);
      expect([self?.label, self?.current()]).toEqual(["This fleet's admin", true]);
      const c = held(h), again = ask(h, c, s.sessionId);
      h.any.webSessions.revokeByHandle(s.record.handle);                               // signed out before it ran
      await expect(c.store.decide(c.view.id, "confirm", { ...again, via: "web" })).rejects.toMatchObject({ code: "admin_required" });
      expect([c.store.inspect(c.view.id)?.state, c.apply.mock.calls.length]).toEqual(["pending", 0]);
      const s2 = await h.signIn(), d = held(h), off = ask(h, d, s2.sessionId);
      (h.fm.fleetConfig as any).web.verified_authority.enabled = false;                 // the web authorization switch turned off before it ran
      expect(off?.current()).toBe(false);
      await expect(d.store.decide(d.view.id, "confirm", { ...off, via: "web" })).rejects.toMatchObject({ code: "admin_required" });
      (h.fm.fleetConfig as any).web.verified_authority.enabled = true;
      // #3362 review N2 was "the fleet becoming web-only before it runs ends it": the host's own session is this fleet's admin either way.
      const e = held(h), late = ask(h, e, s2.sessionId);
      expect(late?.current()).toBe(true);
      const channel = (h.fm.fleetConfig as any).channel; delete (h.fm.fleetConfig as any).channel;
      expect(late?.current()).toBe(true);
      (h.fm.fleetConfig as any).channel = channel;
    } finally { await h.stop(); }
  }, 20_000);
});

// ── #2453: the link options. They were the host's own session only (noSelfConfirm / hostSessionOnly); now they are marked `opensLink` and nothing more ──
describe("a link option turned on (#2453): marked opensLink; any signed-in admin session confirms it, a remote confirmation posts a Notice, strict mode never over a link", () => {
  it("the effect marks only turning a link option on: named_link or quick_link on → opensLink (the old noSelfConfirm / hostSessionOnly marks are gone); off → none", () => {
    const fleet = (va?: Record<string, unknown>) => ({ defaults: {}, ...CHAT, web: va ? { verified_authority: va } : {} }) as never;
    const judge = (va: unknown, current?: Record<string, unknown>) => prepareSettingsEffect("PUT", "/api/settings/fleet/web", { verified_authority: va }, { config: fleet(current), classic: {} }).diff;
    for (const on of [judge({ named_link: true }), judge({ quick_link: true }, { quick_link: false })]) expect([on?.opensLink, on && "noSelfConfirm" in on, on && "hostSessionOnly" in on]).toEqual([true, false, false]);
    expect(judge({ named_link: null }, { named_link: true })).toBeNull();
    const other = judge({ max_session_hours: 6 }, { max_session_hours: 1 });
    expect(other?.opensLink).toBeUndefined();
  });
  it("chat fleet: the host's session confirms it here (no Notice) and from another device (a Notice naming who, what and the outcome); another code's session cannot; no authenticator code is asked", async () => {
    setLocale("en");
    const h = await startFleet(CHAT);
    try {
      const host = await h.signIn(), chatCode = await h.signIn(h.fm.issueDashboardLogin()!.display);
      const a = held(h, "link");
      expect(h.any.settingsSelfConfirmation(a.store, h.reqOf(chatCode.sessionId), a.view.id)).toBeNull();     // chat fleet: an owner-less admin must be the host's own
      expect([h.any.settingsTotpState(a.store, h.reqOf(chatCode.sessionId), a.view.id), h.any.settingsTotpState(a.store, h.reqOf(host.sessionId, AWAY), a.view.id)]).toEqual([null, null]);
      const self = ask(h, a, host.sessionId);
      expect(self?.label).toBe("This fleet's admin");
      expect((await confirm(a, self)).state).toBe("applied");
      expect(remoteNotices(h)).toEqual([]);                                                  // on this computer: nothing to announce
      const b = held(h, "link");
      expect((await confirm(b, ask(h, b, host.sessionId, AWAY))).state).toBe("applied");
      expect(remoteNotices(h)).toHaveLength(1);
      const [text, opts] = remoteNotices(h)[0]! as [string, unknown];
      expect([opts, text.includes("This fleet's admin"), text.includes("opens a public link"), text.includes("Outcome: ")]).toEqual([{ throttle: false }, true, true, true]);
      // A card's route does not take it away: General's card stays another way to confirm.
      vi.spyOn(h.any, "settingsCardPossible").mockReturnValue(true);
      const c = held(h, "link");
      expect(ask(h, c, host.sessionId, AWAY)?.label).toBe("This fleet's admin");
    } finally { await h.stop(); }
  }, 20_000);
  it("chat fleet: a chat account's session confirms it over the quick link (an option that is on) with a Notice; over a link whose option is off, or as a guest, it cannot", async () => {
    setLocale("en");
    const h = await startFleet(CHAT);
    try {
      const account = h.session({ owner: ACCOUNT }), viaLink = h.session({ owner: ACCOUNT, link: true }), guest = h.session({ tier: "guest", owner: ACCOUNT });
      const a = held(h, "link");
      const name = h.any.webPerson(ACCOUNT).name;
      expect([ask(h, a, account.sessionId)?.label, ask(h, a, guest.sessionId)]).toEqual([`${name} (web-verified)`, null]);
      const self = ask(h, a, viaLink.sessionId, {}, "quick");
      expect(self?.current()).toBe(true);
      expect((await confirm(a, self)).state).toBe("applied");
      expect(remoteNotices(h)).toHaveLength(1);
      const b = held(h, "link"), off = ask(h, b, viaLink.sessionId, {}, "quick");
      (h.fm.fleetConfig as any).web.verified_authority.quick_link = false;                     // the quick link's own option turned off before it ran
      expect([off?.current(), ask(h, b, viaLink.sessionId, {}, "quick")]).toEqual([false, null]);
      expect(b.apply).not.toHaveBeenCalled();
    } finally { await h.stop(); }
  }, 20_000);
  it("web-only fleet: Apply now for every signed-in admin session — the host's here, forwarded, another code's; none for a guest; the Notice only off this computer", async () => {
    setLocale("en");
    const h = await startFleet();
    try {
      const host = await h.signIn(), other = await h.signIn(h.fm.issueDashboardLogin()!.display), guest = h.session({ tier: "guest", owner: ACCOUNT });
      expect([other.record.host, ask(h, held(h, "link"), guest.sessionId)]).toEqual([undefined, null]);
      const a = held(h, "link");
      expect([ask(h, a, host.sessionId)?.label, ask(h, a, host.sessionId, AWAY)?.label, ask(h, a, other.sessionId)?.label, ask(h, a, other.sessionId, AWAY)?.label])
        .toEqual(Array(4).fill("This fleet's admin"));
      expect([h.any.settingsTotpState(a.store, h.reqOf(host.sessionId, AWAY), a.view.id), h.any.settingsTotpConfirm(a.store, h.reqOf(host.sessionId, AWAY), a.view.id, "123456", "x")])
        .toEqual([null, { error: "not_here" }]);                                                     // strict off: no code is asked of anyone, a posted code is refused
      expect((await confirm(a, ask(h, a, other.sessionId))).state).toBe("applied");                 // another code's session, on this computer
      expect(remoteNotices(h)).toEqual([]);
      const b = held(h, "link");
      expect((await confirm(b, ask(h, b, other.sessionId, AWAY))).state).toBe("applied");           // …and from another device
      expect(remoteNotices(h)).toHaveLength(1);
      // Over the public link, as the owner signed in from outside (#3008: the link's own opt-in): Apply now too, with a Notice.
      vi.spyOn(h.any, "outsideLink").mockReturnValue({ exposureId: EXPOSURE });
      const outside = h.session({ link: true, remote: true }), c = held(h, "link");
      expect((await confirm(c, ask(h, c, outside.sessionId, {}, "quick"))).state).toBe("applied");
      expect(remoteNotices(h)).toHaveLength(2);
    } finally { await h.stop(); }
  }, 20_000);
  it("strict mode (remote_confirm_code), web-only: this computer still gets Apply now; a device on the LAN is asked the authenticator's code for it, wrong refused, right one applies with a Notice; over HTTP the held Save says so", async () => {
    setLocale("en");
    const h = await startFleet(STRICT, { enrolled: true });
    try {
      const host = await h.signIn(), a = held(h, "link");
      const away = h.reqOf(host.sessionId, AWAY);
      expect([ask(h, a, host.sessionId)?.label, h.any.settingsTotpState(a.store, h.reqOf(host.sessionId), a.view.id)]).toEqual(["This fleet's admin", null]);
      expect([ask(h, a, host.sessionId, AWAY), h.any.settingsTotpState(a.store, away, a.view.id)]).toEqual([null, "ready"]);     // no Apply now off this computer: the code
      const digest = a.store.confirmDigest(a.view.id)!;
      expect(h.any.settingsTotpConfirm(a.store, away, a.view.id, "000000", digest)).toEqual({ error: "wrong" });
      const how = h.any.settingsTotpConfirm(a.store, away, a.view.id, codeAt(Date.now()), digest);
      expect(how.label).toBe("Authenticator code");
      expect((await confirm(a, how)).state).toBe("applied");
      expect(remoteNotices(h)).toHaveLength(1);
      expect(String(remoteNotices(h)[0]![0]).includes("opens a public link")).toBe(true);
      // Over HTTP, through the Settings gate: a forwarded Save waits for the code and its page knows it is not on the computer.
      const put = await raw(h.port, "PUT", "/api/settings/fleet/web", { ...h.reqOf(host.sessionId, AWAY).headers,
        "content-type": "application/json", "idempotency-key": `k${Math.random()}` }, JSON.stringify({ verified_authority: { named_link: true } }));
      expect(put.status).toBe(202);
      const pending = JSON.parse(put.body).pending_change;
      expect([pending.state, pending.totp, pending.remote, pending.can_self_confirm]).toEqual(["pending", "ready", true, undefined]);
    } finally { await h.stop(); }
  }, 20_000);
});

// ── #3366 review (Fable F1, F2): the two guards on a link opener, now what strict mode and the Notice carry ──
describe("a link opener and a web-verified admin's Apply now / an authenticator code (#3366 review, AGEND-122)", () => {
  const TOKEN = "c".repeat(48);
  function fixture(chat: boolean, strict = false) {
    const dir = mkdtempSync(join(tmpdir(), "agend-3366-")); dirs.push(dir);
    if (!chat) writeFileSync(join(dir, WEB_REMOTE_ACCESS_FILE), ENROLLED, { mode: 0o600 });
    const fm = new FleetManager(dir), any = fm as any;
    fm.fleetConfig = { defaults: { backend: "codex" }, ...(chat ? { channels: [{ id: "a", type: "telegram", mode: "topic", group_id: "-1001", access: { mode: "locked", allowed_users: ["1"] } }] } : {}),
      ...(strict ? STRICT : {}), instances: { general: { working_directory: dir, general_topic: true } } } as any;
    writeFileSync(join(dir, "web.token"), TOKEN, { mode: 0o600 }); any.initializeWebSessions();
    const notify = vi.spyOn(fm, "notifyFleetError").mockImplementation(() => true);
    const store = new SettingsConfirmationStore({ audit: vi.fn() }); stores.push(store);
    const make = (o: { owner?: { adapterId: string; userId: string }; link?: boolean; remote?: true } = {}) => {
      const c = any.webSessions.create({ tier: "admin", surface: o.link ? "gateway" : "local", label: "browser", tokenEpoch: tokenEpoch(TOKEN),
        ...(o.owner ? { owner: o.owner } : {}), ...(o.link ? { exposureId: EXPOSURE } : {}), ...(o.remote ? { remote: "totp" as const } : {}) });
      return { sessionId: c.sessionId as string, record: c.record as SessionRecord };
    };
    /** A request with this session's cookie: on this computer, from another device on the LAN, or over the public (quick) link. */
    const req = (sessionId: string, where: "here" | "lan" | "link" = "here"): any => {
      const lan = where === "lan", r: any = { method: "POST", socket: { remoteAddress: lan ? "192.0.2.20" : "127.0.0.1" }, headers: { host: lan ? "192.0.2.5:19280" : "127.0.0.1:19280",
        origin: lan ? "http://192.0.2.5:19280" : where === "link" ? LINK_ORIGIN : "http://127.0.0.1:19280", "sec-fetch-site": "same-origin",
        cookie: `${where === "link" ? WEB_SESSION_COOKIE_SECURE : WEB_SESSION_COOKIE}=${sessionId}`, [WEB_CSRF_HEADER]: csrfTokenFor(sessionId) } };
      if (where === "link") bindGatewayRequest(r, { surface: "gateway", exposureId: EXPOSURE, expectedOrigin: LINK_ORIGIN, isCurrent: () => true });
      return r;
    };
    const propose = (link: boolean) => {
      // A link opener, or an ordinary held change (connecting another Telegram bot).
      const effect = link ? prepareSettingsEffect("PUT", "/api/settings/fleet/web", { verified_authority: { named_link: true } }, { config: fm.fleetConfig, classic: {} } as any)
        : prepareSettingsEffect("PUT", "/api/settings/fleet/channels", [{ id: "b", type: "telegram", mode: "topic", group_id: "-1002", bot_token_env: "T2" }], { config: fm.fleetConfig, classic: {} } as any);
      const apply = vi.fn(async (_c: () => boolean, execution: any) => execution.commit(() => "applied"));
      const view = store.propose({ session: "browser", key: `k${Math.random()}`, bytes: 1, source: "web_session", section: effect.diff!.section, requestedBy: "browser",
        fingerprint: effect.diff!.fingerprint, summary: effect.diff!.summary, affectedConnections: effect.diff!.affectedConnections, authority: effect.diff!.authority,
        ...(effect.diff!.opensLink ? { opensLink: true as const } : {}),                         // as the gate passes it
        current: () => true, unchanged: async () => true, snapshot: () => null, apply }).view;
      return { view, apply };
    };
    return { fm, any, store, notify, make, req, propose };
  }
  it("F1 — chat fleet: a web-verified admin of the connection gets Apply now for an ordinary change AND a link opener (was: never the opener); a link opener from another device posts a Notice; a demoted admin is refused", async () => {
    setLocale("en");
    const f = fixture(true), session = f.make({ owner: { adapterId: "a", userId: "1" } });
    vi.spyOn(f.any, "settingsCardPossible").mockReturnValue(true);                              // a General's card could take them: not what decides it any more
    const ordinary = f.propose(false), link = f.propose(true);
    expect([f.store.opensLink(ordinary.view.id), f.store.opensLink(link.view.id)]).toEqual([false, true]);
    const own = f.any.settingsSelfConfirmation(f.store, f.req(session.sessionId), ordinary.view.id);
    expect(own?.label).toContain("(web-verified)");                                                // control: the path is open for an ordinary change…
    const onHost = f.any.settingsSelfConfirmation(f.store, f.req(session.sessionId), link.view.id);
    expect(onHost?.label).toBe(own?.label);                                                        // …and now for #2453's link opener too
    const away = f.any.settingsSelfConfirmation(f.store, f.req(session.sessionId, "lan"), link.view.id);
    expect(away?.current()).toBe(true);
    const done = await f.store.decide(link.view.id, "confirm", { ...away, via: "web" }); away.done?.(done);
    expect([done.state, link.apply.mock.calls.length, f.notify.mock.calls.length]).toEqual(["applied", 1, 1]);
    expect(String(f.notify.mock.calls[0]![0])).toContain("opens a public link");
    // The account stops being an admin of its connection before the ordinary change runs: refused, nothing applied.
    (f.fm.fleetConfig as any).channels[0].access.allowed_users = ["2"];
    expect(own?.current()).toBe(false);
    await expect(f.store.decide(ordinary.view.id, "confirm", { ...own, via: "web" })).rejects.toMatchObject({ code: "admin_required" });
    expect([f.any.settingsSelfConfirmation(f.store, f.req(session.sessionId), ordinary.view.id), ordinary.apply.mock.calls.length]).toEqual([null, 0]);
  });
  it("F2 — web-only fleet, strict mode: a correct authenticator code with the right digest, POSTed for a link opener over the public link, is refused (nothing applied); from a LAN device, or for an ordinary change over the link, it is accepted", async () => {
    const f = fixture(false, true), outside = f.make({ link: true, remote: true }), lan = f.make();
    vi.spyOn(f.any, "outsideLink").mockReturnValue({ exposureId: EXPOSURE });                      // the link "connections from outside" opened
    const link = f.propose(true), ordinary = f.propose(false);
    expect([f.any.settingsTotpState(f.store, f.req(outside.sessionId, "link"), link.view.id), f.any.settingsTotpState(f.store, f.req(outside.sessionId, "link"), ordinary.view.id)]).toEqual(["on_host", "ready"]);
    expect(f.any.settingsSelfConfirmation(f.store, f.req(outside.sessionId, "link"), link.view.id)).toBeNull();     // strict: no Apply now off this computer, link or not
    const refused = f.any.settingsTotpConfirm(f.store, f.req(outside.sessionId, "link"), link.view.id, codeAt(Date.now()), f.store.confirmDigest(link.view.id));
    expect(refused).toEqual({ error: "not_here" });
    expect(link.apply).not.toHaveBeenCalled();
    // Controls: the same app confirms the link opener from a device on the LAN (a direct connection, not a link), and an ordinary change over the link.
    expect(f.any.settingsTotpState(f.store, f.req(lan.sessionId, "lan"), link.view.id)).toBe("ready");
    const r = f.any.settingsTotpConfirm(f.store, f.req(lan.sessionId, "lan"), link.view.id, codeAt(Date.now()), f.store.confirmDigest(link.view.id));
    expect(r.label).toBe("Authenticator code");
    const c = f.any.settingsTotpConfirm(f.store, f.req(outside.sessionId, "link"), ordinary.view.id, codeAt(Date.now() + 30_000), f.store.confirmDigest(ordinary.view.id));
    expect(c.label).toBe("Authenticator code");
    // On this computer nothing is asked in strict mode: Apply now, and no code is taken.
    expect([f.any.settingsTotpState(f.store, f.req(lan.sessionId, "here"), link.view.id), f.any.settingsSelfConfirmation(f.store, f.req(lan.sessionId, "here"), link.view.id)?.label])
      .toEqual([null, "This fleet's admin"]);
  });
});
