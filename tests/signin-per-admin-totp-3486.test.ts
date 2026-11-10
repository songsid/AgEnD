/**
 * #3486 (upstream #3486, the maintainer's follow-up): a browser that is not signed in yet signs in as ONE admin with the code of
 * THAT admin's own authenticator — POST /auth/totp `{ code }` (AGEND-155: the code alone; `{ account, code }` is still accepted) — on chat fleets and web-only fleets, on a direct connection
 * and (where the fleet allows it) over a public link. The rules this file holds:
 *   - who: the code is compared with every admin's app (a typed name, if one is still sent, resolves to exactly one); the session is that
 *     account's own (a web-only fleet's is the fleet admin's) and the settings role it gets is the one #3503 gives that admin;
 *   - nothing tells admins apart from strangers: a wrong code, a name that is nobody's, an admin with no app, one demoted since, and a
 *     name two admins share are the same answer (401 wrong_code), counted the same way (the fleet-wide sign-in limit grows for all);
 *   - one use per time step, shared with that admin's confirmations (`lastStep`); limits per admin, per typed name and fleet-wide;
 *   - rechecked as the session is made (same app, still an admin, still allowed here); "Only this computer can authorize" closes it;
 *   - every success is a Notice to the fleet's admins; the 8-character sign-in code is unchanged.
 * The route is driven through the real handler (handleAuthRequest) on the real FleetManager; requests are built as AgEnD sees them.
 */
import { Readable } from "node:stream";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Counts the real HMAC primitive evaluations (every TOTP code is one) so the tests can show the work is the same, not only that every admin was visited.
const hmac = vi.hoisted(() => ({ calls: 0 }));
vi.mock("node:crypto", async importOriginal => {
  const real = await importOriginal<typeof import("node:crypto")>();
  const counting = (...args: Parameters<typeof real.createHmac>) => { hmac.calls++; return real.createHmac(...args); };
  return { ...real, createHmac: counting, default: { ...real, createHmac: counting } };
});
import { FleetManager } from "../src/fleet-manager.js";
import { handleAuthRequest } from "../src/auth-api.js";
import { bindGatewayRequest } from "../src/web-request-context.js";
import { WEB_CSRF_HEADER } from "../src/web-auth.js";
import { csrfTokenFor, tokenEpoch } from "../src/web-session.js";
import { evaluateSettingsRole } from "../src/authority/settings-role.js";
import { base32Decode, base32Encode, hotp, totpStep, adminKey, HOST_ADMIN_KEY, OUTSIDE_LINK_OWNER, SIGNIN_BROWSER_WRONG_LIMIT, SIGNIN_FLEET_WRONG_LIMIT, SIGNIN_KNOWN_WRONG_LIMIT, SIGNIN_WRONG_LIMIT, TOTP_REACH_STEPS, TOTP_RETIRED_KEEP_MS, TOTP_RETIRED_SLOTS, TOTP_SIGNIN_OVER_PUBLIC_LINK, WebRemoteAccess, WEB_REMOTE_ACCESS_FILE } from "../src/web-remote-access.js";
import { SIGNIN_KNOWN_COOKIE, addSigninKnownDevice, buildSigninCookie, findSigninKnownEntry, signinKnownDevice } from "../src/web-signin-device.js";
import { fleetCookieName } from "../src/web-cookie-names.js";
import { setLocale } from "../src/locale.js";

const TOKEN = "d".repeat(48), ADMIN = "100", ADMIN_B = "200", NO_APP = "300", STRANGER = "999";
const HOST_SECRET = base32Encode(Buffer.from("0123456789abcdefghij"));
const secretFor = (user: string) => base32Encode(Buffer.from(`secret-for-${user}`.padEnd(20, "#").slice(0, 20)));
/** The code of an app (a secret) `offset` time steps from now. Each step is accepted once per app. */
const codeOf = (secret: string, offset = 0) => hotp(base32Decode(secret)!, totpStep(Date.now()) + offset);
const roots: string[] = [], fleets: any[] = [];
afterEach(() => {
  for (const a of fleets.splice(0)) { a.fm.stormWindow.shutdown(); a.fm.spawnGate.shutdown(); }
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const WHERE = {
  tailnetServe: { remoteAddress: "127.0.0.1", host: "agend-box.example-tailnet.ts.net", extra: { "x-forwarded-for": "100.64.0.7", "x-forwarded-proto": "https" } },
  lan: { remoteAddress: "192.0.2.20", host: "192.0.2.5:19280", extra: {} },
  here: { remoteAddress: "127.0.0.1", host: "127.0.0.1:19280", extra: {} },
} as const;
type Where = keyof typeof WHERE;

/**
 * `chat`: a Telegram connection `a` whose admins are ADMIN and ADMIN_B (and NO_APP, who has no app) — ADMIN_B's and ADMIN's apps are seeded;
 * not chat: a web-only fleet with the host operator's app.
 */
function fleet(o: { chat?: boolean; hostApp?: boolean; admins?: string[]; allowed?: string[]; outside?: boolean; va?: Record<string, unknown>; names?: boolean; secrets?: Record<string, string> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "agend-3486-")); roots.push(dir);
  const chat = o.chat ?? true, apps = o.admins ?? (chat ? [ADMIN, ADMIN_B] : []);
  const rec = (secret: string) => ({ secret, enrolledAt: 1, lastStep: 0 });
  writeFileSync(join(dir, WEB_REMOTE_ACCESS_FILE), JSON.stringify({ v: 1, ...(o.hostApp ?? !chat ? { totp: rec(HOST_SECRET) } : {}),
    ...(apps.length ? { admins: Object.fromEntries(apps.map(u => [adminKey("a", u), rec(o.secrets?.[u] ?? secretFor(u))])) } : {}),
    outside: o.outside ?? false, wrong: 0, level: 0, pausedUntil: 0, handles: [] }), { mode: 0o600 });
  const fm = new FleetManager(dir), any = fm as any;
  fm.fleetConfig = { defaults: { backend: "codex" },
    ...(chat ? { channels: [{ id: "a", type: "telegram", mode: "topic", group_id: "-1001", access: { mode: "locked", allowed_users: o.allowed ?? [ADMIN, ADMIN_B, NO_APP] } }] } : {}),
    web: { verified_authority: { enabled: true, ...o.va } },
    instances: { general: { working_directory: dir, general_topic: true } } } as any;
  writeFileSync(join(dir, "web.token"), TOKEN, { mode: 0o600 }); any.initializeWebSessions();
  fleets.push({ fm, any });
  if (chat && o.names !== false) { any.noteWebSignIn({ adapterId: "a", userId: ADMIN, username: "Alice_TG" }); any.noteWebSignIn({ adapterId: "a", userId: ADMIN_B, username: "bob" }); }
  const notified: string[] = [];
  vi.spyOn(any, "notifyFleetError").mockImplementation(((text: string) => { notified.push(text); return true; }) as any);
  /** The link a public request arrives over (the gateway's own binding), as `openSignin` reports it. */
  const openLink = (owner?: unknown) => { any.publicWebLink = { openSignin: () => ({ exposureId: "x", owner, url: "https://x.trycloudflare.com/signin" }), whenClosed: async () => {}, close: async () => {}, endOf: () => null }; };
  /** POST /auth/totp through the real handler. */
  const totp = (body: unknown, opts: { where?: Where; link?: "quick" | "named"; raw?: string; cookie?: string; /** Whether the gateway still counts the request as current (default: always). */ current?: () => boolean; /** The Origin header: a string, or null for none (the default is the page's own). */ origin?: string | null } = {}) => new Promise<{ status: number; headers: Record<string, any>; json: any }>((resolve, reject) => {
    const link = !!opts.link, w = WHERE[opts.where ?? "lan"];
    const host = link ? "x.trycloudflare.com" : w.host, origin = link ? "https://x.trycloudflare.com" : `http://${w.host}`;
    const req: any = Object.assign(Readable.from([Buffer.from(opts.raw ?? JSON.stringify(body))]), { method: "POST", url: "/auth/totp", socket: { remoteAddress: link ? "127.0.0.1" : w.remoteAddress },
      headers: { host, ...(opts.origin === null ? {} : { origin: opts.origin ?? origin }), "content-type": "application/json", "sec-fetch-site": "same-origin", "user-agent": "Mozilla/5.0 (iPhone) Safari", ...(opts.cookie ? { cookie: opts.cookie } : {}), ...(link ? {} : w.extra) } });
    if (link) bindGatewayRequest(req, { surface: "gateway", exposureId: "x", expectedOrigin: origin, isCurrent: opts.current ?? (() => true), named: opts.link === "named" } as any);
    const res: any = { destroyed: false, headersSent: false, writeHead(s: number, h: Record<string, any>) { this.s = s; this.h = h; }, end(b: string) { resolve({ status: this.s, headers: this.h, json: b ? JSON.parse(b) : null }); } };
    try { if (!handleAuthRequest(req, res, new URL(req.url, origin), any)) reject(new Error("not handled")); } catch (err) { reject(err); }
  });
  /** A request carrying the session cookie a sign-in answered with (from where it came). */
  const withCookie = (r: { headers: Record<string, any> }, where: Where, link?: "quick" | "named") => {
    const set = r.headers["Set-Cookie"], cookie = String(Array.isArray(set) ? set[0] : set).split(";")[0]!, sessionId = cookie.split("=")[1]!;
    const w = WHERE[where], host = link ? "x.trycloudflare.com" : w.host, origin = link ? "https://x.trycloudflare.com" : `http://${w.host}`;
    const req: any = { method: "POST", socket: { remoteAddress: link ? "127.0.0.1" : w.remoteAddress }, headers: { host, origin, "sec-fetch-site": "same-origin", cookie, [WEB_CSRF_HEADER]: csrfTokenFor(sessionId), ...(link ? {} : w.extra) } };
    if (link) bindGatewayRequest(req, { surface: "gateway", exposureId: "x", expectedOrigin: origin, isCurrent: () => true, named: link === "named" } as any);
    return { req, sessionId, record: any.webSessions.authenticate(sessionId, tokenEpoch(TOKEN), { touch: false, ...(link ? { surface: "gateway", exposureId: "x" } : { surface: "local" }) }) };
  };
  /** One person's browser: its cookies (the ids and marks the route hands out, and the session) kept between requests, as a browser keeps them. */
  const browser = (where: Where = "lan", link?: "quick" | "named") => {
    const jar = new Map<string, string>();
    return { jar, post: async (body: unknown) => {
      const r = await totp(body, { where, ...(link ? { link } : {}), cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") });
      const set = r.headers["Set-Cookie"];
      for (const c of Array.isArray(set) ? set : set ? [set] : []) { const [kv] = String(c).split(";"); const eq = kv!.indexOf("="); jar.set(kv!.slice(0, eq), kv!.slice(eq + 1)); }
      return r;
    }, /** The browser id dropped (a thief's way of starting a count afresh); the mark and the session stay. */
    shed: () => { for (const k of [...jar.keys()]) if (/signin_browser/.test(k)) jar.delete(k); } };
  };
  const restart = () => { any.webRemoteAccessState?.close(); any.webRemoteAccessState = null; };   // the store read again from its file, as after a restart
  const access = (): WebRemoteAccess => any.webRemoteAccess();
  const feed = () => (any.webNoticesFeed()?.view().items ?? []).map((n: { text: string }) => n.text);
  return { fm, any, dir, totp, browser, restart, withCookie, openLink, access, notified, feed };
}

const WRONG = { status: 401, json: { error: "wrong_code" } };
const summary = (r: { status: number; json: unknown }) => ({ status: r.status, json: r.json });

describe("who signs in: the admin the name stands for, with their own code", () => {
  it.each(["lan", "tailnetServe", "here"] as const)("chat fleet, direct (%s): the account's own session, and the settings role #3503 gives that admin", async where => {
    const f = fleet();
    const r = await f.totp({ account: "alice_tg", code: codeOf(secretFor(ADMIN)) }, { where });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, tier: "admin" });
    const s = f.withCookie(r, where);
    expect(s.record).toMatchObject({ tier: "admin", surface: "local", owner: { adapterId: "a", userId: ADMIN } });
    expect(s.record.host).toBeUndefined(); expect(s.record.remote).toBeUndefined();
    const { role } = f.any.settingsRole(s.req);
    expect(role).toMatchObject({ ok: true, actor: { adapter_id: "a", user_id: ADMIN }, account: true, onHost: where === "here" });
  });
  it("the other admin signs in as THEMSELVES — by handle, by user id, and by connection:id — and only their own app opens it", async () => {
    const f = fleet();
    for (const [account, offset] of [["@BOB", -1], [ADMIN_B, 0], ["a:200", 1]] as const) {
      const r = await f.totp({ account, code: codeOf(secretFor(ADMIN_B), offset) });
      expect(r.status).toBe(200);
      expect(f.withCookie(r, "lan").record.owner).toEqual({ adapterId: "a", userId: ADMIN_B });
    }
    // Alice's name with Bob's code is just a wrong code.
    expect(summary(await f.totp({ account: "alice_tg", code: codeOf(secretFor(ADMIN_B), 2) }))).toEqual(WRONG);
  });
  it("chat fleet over a public link: allowed, the account's session over the gateway (its role still follows the link's option)", async () => {
    const f = fleet({ va: { quick_link: true } });
    f.openLink();
    const r = await f.totp({ account: "bob", code: codeOf(secretFor(ADMIN_B)) }, { link: "quick" });
    expect(r.status).toBe(200);
    const s = f.withCookie(r, "lan", "quick");
    expect(s.record).toMatchObject({ surface: "gateway", exposureId: "x", owner: { adapterId: "a", userId: ADMIN_B } });
    expect(f.any.settingsRole(s.req).role).toMatchObject({ ok: true, actor: { user_id: ADMIN_B } });
    // The link's option off: signed in, but no say over held changes (unchanged #3503 rule).
    const off = fleet({ va: { quick_link: false } }); off.openLink();
    const r2 = await off.totp({ account: "bob", code: codeOf(secretFor(ADMIN_B)) }, { link: "quick" });
    expect(r2.status).toBe(200);
    expect(off.any.settingsRole(off.withCookie(r2, "lan", "quick").req).role).toEqual({ ok: false, reason: "link_off" });
  });
  it("chat fleet, no link open for that exposure: 404 as if the route were not there; the central switch is one constant, read in one place", async () => {
    const f = fleet();
    expect((await f.totp({ account: "bob", code: codeOf(secretFor(ADMIN_B)) }, { link: "quick" })).status).toBe(404);   // no link is open
    expect(TOTP_SIGNIN_OVER_PUBLIC_LINK).toBe(true);
    const src = readFileSync(join(process.cwd(), "src", "fleet-manager.ts"), "utf8");
    const code = src.split("\n").filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l) && l.includes("TOTP_SIGNIN_OVER_PUBLIC_LINK"));
    expect(code).toHaveLength(2);                                                                                         // the import and the one decision
  });
  it("web-only fleet, direct: the fleet's one admin (the host operator), no name needed; the session is the plain admin session, role = host operator", async () => {
    const f = fleet({ chat: false });
    const r = await f.totp({ code: codeOf(HOST_SECRET) }, { where: "tailnetServe" });
    expect(r.status).toBe(200);
    const s = f.withCookie(r, "tailnetServe");
    expect(s.record).toMatchObject({ tier: "admin", surface: "local" });
    expect([s.record.owner, s.record.host, s.record.remote]).toEqual([undefined, undefined, undefined]);
    expect(f.any.settingsRole(s.req).role).toMatchObject({ ok: true, actor: { adapter_id: "host", user_id: "operator" }, account: false });
  });
  it("web-only fleet over the outside link (as before, #3008): the remote session, authorized as this computer's admin", async () => {
    const f = fleet({ chat: false, outside: true });
    f.openLink(OUTSIDE_LINK_OWNER);
    const r = await f.totp({ code: codeOf(HOST_SECRET) }, { link: "quick" });
    expect(r.status).toBe(200);
    const s = f.withCookie(r, "lan", "quick");
    expect(s.record).toMatchObject({ remote: "totp", surface: "gateway", exposureId: "x" });
    expect(s.record.owner).toBeUndefined();
    expect(f.any.settingsRole(s.req).role).toMatchObject({ ok: true, outsideSession: true });
    // …and a web-only fleet's OTHER links stay closed to it: only the outside link.
    const other = fleet({ chat: false, outside: false }); other.openLink();
    expect((await other.totp({ code: codeOf(HOST_SECRET) }, { link: "quick" })).status).toBe(404);
  });
  it("a chat fleet's host operator (the `agend web` session on the computer) cannot be signed in as, nor anyone as a chat account without an app", async () => {
    const f = fleet({ admins: [ADMIN, ADMIN_B], hostApp: true });
    expect(f.access().isEnrolled(HOST_ADMIN_KEY)).toBe(true);
    for (const account of ["host", "operator", "host:operator", ""]) expect(summary(await f.totp({ account, code: codeOf(HOST_SECRET) }))).toEqual(WRONG);
    expect(summary(await f.totp({ code: codeOf(HOST_SECRET, 1) }))).toEqual(WRONG);                // no name: compared with the chat admins' apps only — the host's is not one of them
  });
  it("the session is never more than the admin session of that account: no host flag, no authorization, nothing an agent takes as a go-ahead", async () => {
    const f = fleet();
    const r = await f.totp({ account: "alice_tg", code: codeOf(secretFor(ADMIN)) });
    const s = f.withCookie(r, "lan");
    expect(s.record).not.toHaveProperty("host");
    expect(f.any.sessionAuthorizationStore()?.list() ?? []).toEqual([]);
    expect(f.any.webAuthority({ session: s.record, gateway: false, peer: "lan" }).authority.kind).toBe("none");
  });
});

describe("nothing tells admins from strangers: one answer, the same counting", () => {
  it("a wrong code, a name that is nobody's, an admin with no app, a demoted admin, a shared name: the same 401 body and headers", async () => {
    // ADMIN is demoted (not in the list any more); NO_APP is an admin with no app; ALICE and a second "alice" share a name.
    const f = fleet({ allowed: [ADMIN_B, NO_APP, "400"], admins: [ADMIN_B, "400"], names: false });
    f.any.noteWebSignIn({ adapterId: "a", userId: ADMIN_B, username: "twin" }); f.any.noteWebSignIn({ adapterId: "a", userId: "400", username: "TWIN" });
    const good = codeOf(secretFor(ADMIN_B));
    const answers = await Promise.all([
      f.totp({ account: ADMIN_B, code: "000000" }),                       // a real admin, a wrong code
      f.totp({ account: "ghost", code: good }),                           // no such name (the right code of someone else)
      f.totp({ account: NO_APP, code: good }),                            // an admin with no app
      f.totp({ account: STRANGER, code: good }),                          // an account that is not an admin
      f.totp({ account: "twin", code: good }),                            // a name two admins answer to: nobody's
    ]);
    // The same headers too: what a browser with no cookies is handed (its own id, once) is the same for every name.
    for (const a of answers) expect([a.status, a.json, Object.keys(a.headers).sort(), a.headers["Content-Type"]]).toEqual([401, { error: "wrong_code" }, ["Content-Type", "Set-Cookie"], "application/json"]);
    expect(f.any.webSessions.list(undefined, () => true)).toEqual([]);
    // …and they stay answerable by the unambiguous form.
    expect((await f.totp({ account: "a:200", code: codeOf(secretFor(ADMIN_B), 1) })).status).toBe(200);
  });
  it("a demoted admin and one whose app was replaced cannot sign in; a name no longer an admin's is nobody's", async () => {
    const f = fleet();
    f.fm.fleetConfig!.channels![0]!.access!.allowed_users = [ADMIN_B];                       // ADMIN demoted
    expect(summary(await f.totp({ account: "alice_tg", code: codeOf(secretFor(ADMIN)) }))).toEqual(WRONG);
    // ADMIN_B's app replaced: the old code no longer works, the new one does.
    const b = f.access().beginEnrollment("h", "x", adminKey("a", ADMIN_B));
    expect(f.access().confirmEnrollment("h", codeOf(b.secret, -1))).toBe("ok");
    expect(summary(await f.totp({ account: "bob", code: codeOf(secretFor(ADMIN_B), 1) }))).toEqual(WRONG);
    expect((await f.totp({ account: "bob", code: codeOf(b.secret, 1) })).status).toBe(200);
  });
  it("a name that is nobody's counts toward the fleet-wide sign-in limit exactly as a real admin's wrong code does (state is saved either way)", async () => {
    const f = fleet();
    const saved = () => JSON.parse(readFileSync(join(f.dir, WEB_REMOTE_ACCESS_FILE), "utf8"));
    await f.totp({ account: "ghost", code: "000000" });
    expect(saved().signin.wrong).toBe(1);
    await f.totp({ account: "bob", code: "000000" });
    expect(saved().signin.wrong).toBe(2);
    expect(saved().admins[adminKey("a", ADMIN_B)].lim.wrong).toBe(1);                         // the real admin's own count; a ghost has none to show
    expect(saved().admins[adminKey("a", ADMIN)].lim).toBeUndefined();
  });
  it("the store answers the same shape for a real admin, no name, and a key with no record (a decoy secret is compared when there is no admin)", () => {
    const store = new WebRemoteAccess(join(fleet().dir, WEB_REMOTE_ACCESS_FILE), { warn: () => {} });
    const b = (n: string) => ({ key: n, known: false });
    const answer = (v: ReturnType<WebRemoteAccess["signIn"]>) => ({ ...v, began: undefined, skewSteps: undefined });
    expect(answer(store.signIn(adminKey("a", ADMIN), "x", "000000", b("1")))).toEqual({ kind: "wrong", began: undefined, skewSteps: undefined });
    expect(answer(store.signIn(null, "y", "000000", b("2")))).toEqual({ kind: "wrong", began: undefined, skewSteps: undefined });
    expect(answer(store.signIn(adminKey("a", "nobody"), "z", "000000", b("3")))).toEqual({ kind: "wrong", began: undefined, skewSteps: undefined });
  });
  it("a body that is not {code, account} strings is a 400 (and says nothing about admins); a cross-site or non-JSON POST is refused", async () => {
    const f = fleet();
    expect((await f.totp({ account: 5, code: "000000" })).status).toBe(400);
    expect((await f.totp({ account: "x".repeat(300), code: "000000" })).status).toBe(400);
    expect((await f.totp({ code: 123456 })).status).toBe(400);
    expect((await f.totp(null, { raw: "not json" })).status).toBe(400);
  });
});

describe("one use per time step, shared with the admin's confirmations", () => {
  it("the same code (the same step) cannot sign in twice; a confirmation that used a step blocks sign-in with it, and the other way round", async () => {
    const f = fleet();
    const code = codeOf(secretFor(ADMIN));
    expect((await f.totp({ account: "alice_tg", code })).status).toBe(200);
    expect(summary(await f.totp({ account: "alice_tg", code }))).toEqual(WRONG);              // used
    expect(f.access().verify(code, adminKey("a", ADMIN))).toMatchObject({ kind: "wrong" });   // …and a confirmation cannot reuse it either
    // A confirmation uses the next step: sign-in cannot use it afterwards.
    const next = codeOf(secretFor(ADMIN), 1);
    expect(f.access().verify(next, adminKey("a", ADMIN))).toEqual({ kind: "ok" });
    expect(summary(await f.totp({ account: "alice_tg", code: next }))).toEqual(WRONG);
  });
  it("a sign-in's wrong codes do not touch the confirmation limiter (an open route cannot pause admins who are signed in)", async () => {
    const f = fleet();
    for (let n = 0; n < SIGNIN_WRONG_LIMIT + 2; n++) await f.totp({ account: "bob", code: "000000" });
    expect(f.access().status(adminKey("a", ADMIN_B)).pausedForMs).toBe(0);
    expect(f.access().verify(codeOf(secretFor(ADMIN_B)), adminKey("a", ADMIN_B))).toEqual({ kind: "ok" });
  });
});

const STATUSES = async (f: ReturnType<typeof fleet>, names: string[], n: number, mid?: () => void) => {
  const out: number[] = [];
  for (let k = 0; k < n; k++) { if (mid && k === Math.floor(n / 2)) mid(); out.push((await f.totp({ account: names[k % names.length], code: "000000" })).status); }
  return out;
};

describe("limits: this browser first, then the shared ceilings (the admin's, the name's, the whole sign-in's)", () => {
  it("one browser's five wrong codes pause THAT browser alone (429, 5 minutes); another browser signs in at once", async () => {
    const f = fleet(), mine = f.browser();
    for (let n = 1; n < SIGNIN_BROWSER_WRONG_LIMIT; n++) expect((await mine.post({ account: "bob", code: "000000" })).status).toBe(401);
    const fifth = await mine.post({ account: "bob", code: "000000" });
    expect([fifth.status, fifth.json.error, fifth.headers["Retry-After"], fifth.json.retryAfterMs]).toEqual([429, "paused", "300", 5 * 60_000]);
    expect((await mine.post({ account: "bob", code: codeOf(secretFor(ADMIN_B)) })).status).toBe(429);       // the right code waits too, in this browser
    // …someone else's browser is not held by it: bob (the same admin) signs in from another one.
    expect((await f.browser().post({ account: "bob", code: codeOf(secretFor(ADMIN_B)) })).status).toBe(200);
    expect(f.notified.filter(t => /paused/.test(t)).length).toBe(0);                                          // a browser's own wait is nobody's Notice
  });
  it("the same for a name that is nobody's: the browser's pause comes after the same number of tries", async () => {
    const f = fleet(), mine = f.browser();
    const seen: number[] = [];
    for (let n = 0; n < SIGNIN_BROWSER_WRONG_LIMIT; n++) seen.push((await mine.post({ account: "ghost", code: "000000" })).status);
    expect(seen).toEqual([401, 401, 401, 401, 429]);
  });
  it("clearing cookies does not clear the shared ceilings: new browsers keep adding to the admin's and the name's count (429 at the limit, the right code too)", async () => {
    const f = fleet();
    for (let n = 1; n < SIGNIN_WRONG_LIMIT; n++) expect((await f.totp({ account: "bob", code: "000000" })).status).toBe(401);    // no cookie sent: a new browser each time
    const tenth = await f.totp({ account: "bob", code: "000000" });
    expect([tenth.status, tenth.json.error, tenth.headers["Retry-After"]]).toEqual([429, "paused", "900"]);
    expect((await f.totp({ account: "bob", code: codeOf(secretFor(ADMIN_B)) })).status).toBe(429);
    expect((await f.totp({ account: "alice_tg", code: codeOf(secretFor(ADMIN)) })).status).toBe(200);          // another admin is not held
    expect(f.notified.filter(t => /paused/.test(t)).length).toBe(1);                                          // said once, to the admins (a real admin's)
  });
  it("a name that is nobody's is held by the same ceiling after the same number of tries — and says no Notice (a flood must not flood)", async () => {
    const f = fleet();
    expect(await STATUSES(f, ["ghost"], SIGNIN_WRONG_LIMIT)).toEqual([...Array(SIGNIN_WRONG_LIMIT - 1).fill(401), 429]);
    expect(f.notified.filter(t => /paused/.test(t)).length).toBe(0);
  });
  it("the whole sign-in's ceiling counts names that are nobody's: past it everyone new is paused, the right code too", async () => {
    const f = fleet();
    let last = 0, n = 0;
    while (last !== 429 && n < SIGNIN_FLEET_WRONG_LIMIT + 5) { last = (await f.totp({ account: `ghost${Math.floor(n / 4)}`, code: "000000" })).status; n++; }
    expect(n).toBe(SIGNIN_FLEET_WRONG_LIMIT);
    const real = await f.totp({ account: "alice_tg", code: codeOf(secretFor(ADMIN)) });
    expect([real.status, real.json.error]).toEqual([429, "paused"]);
    expect(f.notified.filter(t => /paused/.test(t)).length).toBe(1);
  });
  it("the admin's own ceiling never changes an answer: with two names of one admin it holds the code back and answers 401 exactly like a stranger's name does", async () => {
    // A real admin typed under rotating names and a name nobody has, 55 times, with a restart in the middle: the same statuses at every step.
    const real = fleet(), ghost = fleet();
    const a = await STATUSES(real, ["bob", ADMIN_B, "a:200"], 55, () => real.restart());
    const b = await STATUSES(ghost, ["g1", "g2", "g3"], 55, () => ghost.restart());
    expect(a).toEqual(b);
    expect(a.filter(x => x === 429).length).toBeGreaterThan(0);                                                // …and it did pause, at the names' ceilings, for both
    // …and the held admin's right code, under a name not yet paused, is not tried: 401, no session (the ceiling's job).
    const held = fleet();
    for (let n = 0; n < SIGNIN_WRONG_LIMIT; n++) await held.totp({ account: ["bob", ADMIN_B][n % 2], code: "000000" });    // 5 + 5: each name under its own limit, the admin at its
    const r = await held.totp({ account: "a:200", code: codeOf(secretFor(ADMIN_B)) });
    expect([r.status, r.json]).toEqual([401, { error: "wrong_code" }]);
    expect(held.any.webSessions.list(undefined, () => true)).toEqual([]);
    expect(held.notified.filter(t => /paused/.test(t)).length).toBe(1);                                       // the admins hear of it
  });
  it("a restart changes nothing: a real admin and a name nobody has are paused at the same attempt (the names' counts are saved)", async () => {
    for (const name of ["bob", "ghost"]) {
      const f = fleet();
      for (let n = 0; n < SIGNIN_WRONG_LIMIT - 1; n++) await f.totp({ account: name, code: "000000" });
      f.restart();
      expect((await f.totp({ account: name, code: "000000" })).status).toBe(429);
    }
    const f = fleet();
    for (let n = 0; n < SIGNIN_WRONG_LIMIT; n++) await f.totp({ account: "bob", code: "000000" });
    const reopened = new WebRemoteAccess(join(f.dir, WEB_REMOTE_ACCESS_FILE), { warn: () => {} });
    expect(reopened.signIn(adminKey("a", ADMIN_B), "bob", codeOf(secretFor(ADMIN_B)), { key: "k", known: false })).toMatchObject({ kind: "paused" });
    expect(Object.keys(JSON.parse(readFileSync(join(f.dir, WEB_REMOTE_ACCESS_FILE), "utf8")).idents)).toHaveLength(1);
  });
  it("a correct code clears that admin's own count and that name's — not the whole sign-in's, which only time lowers", async () => {
    const f = fleet();
    for (let n = 0; n < SIGNIN_WRONG_LIMIT - 1; n++) await f.totp({ account: "bob", code: "000000" });
    expect((await f.totp({ account: ADMIN_B, code: codeOf(secretFor(ADMIN_B)) })).status).toBe(200);
    const saved = JSON.parse(readFileSync(join(f.dir, WEB_REMOTE_ACCESS_FILE), "utf8"));
    expect(saved.admins[adminKey("a", ADMIN_B)].lim).toBeUndefined();
    expect(saved.signin.wrong).toBe(SIGNIN_WRONG_LIMIT - 1);
  });
  it("time: a shared count is forgotten only after a quiet DAY (this browser's after an hour), and the doubling steps down a level per quiet day", () => {
    let clock = 1_800_000_000_000;
    const dir = mkdtempSync(join(tmpdir(), "agend-3486-t-")); roots.push(dir);
    const store = new WebRemoteAccess(join(dir, WEB_REMOTE_ACCESS_FILE), { warn: () => {} }, () => clock);
    const wrongOnce = (i: number, name = "x") => store.signIn(null, name, "000000", { key: `k${i}`, known: false });
    const burst = (name = "x"): number => { let last: ReturnType<typeof wrongOnce> = { kind: "unavailable" }; for (let n = 0; n < SIGNIN_WRONG_LIMIT; n++) last = wrongOnce(n, name); return last.kind === "paused" ? last.retryAfterMs : 0; };
    expect(burst()).toBe(15 * 60_000);
    clock += 15 * 60_000 + 1; expect(burst()).toBe(30 * 60_000);                 // a second wait right after: doubled
    clock += 30 * 60_000 + 3 * 24 * 60 * 60_000; expect(burst()).toBe(15 * 60_000);   // three quiet days later the level is back to the first
    clock += 15 * 60_000 + 2 * 60 * 60_000;
    for (let n = 0; n < SIGNIN_WRONG_LIMIT - 1; n++) wrongOnce(n, "y");
    clock += 61 * 60_000;                                                             // an hour of quiet is NOT enough for a shared count …
    expect(wrongOnce(0, "y").kind).toBe("paused");                                    // … the tenth since the first still pauses
    clock += 25 * 60 * 60_000;                                                        // (a quiet day, so the whole sign-in's own count — 20 now — is out of the way)
    // …while this browser's own count (one key) is forgotten after an hour.
    const one = (name: string) => store.signIn(null, name, "000000", { key: "same-browser", known: false });
    for (let n = 0; n < SIGNIN_BROWSER_WRONG_LIMIT - 1; n++) expect(one(`n${n}`).kind).toBe("wrong");
    clock += 61 * 60_000;
    for (let n = 0; n < SIGNIN_BROWSER_WRONG_LIMIT - 1; n++) expect(one(`m${n}`).kind).toBe("wrong");   // four more: not a fifth
  });
  it("a slow guesser (nine a hour, new browser each time) is caught: the tenth overall pauses, in the second hour; and half-way the admins are told once per cycle", () => {
    let clock = 1_800_000_000_000;
    const dir = mkdtempSync(join(tmpdir(), "agend-3486-slow-")); roots.push(dir);
    writeFileSync(join(dir, WEB_REMOTE_ACCESS_FILE), JSON.stringify({ v: 1, admins: { [adminKey("a", ADMIN)]: { secret: secretFor(ADMIN), enrolledAt: 1, lastStep: 0 } }, outside: false, wrong: 0, level: 0, pausedUntil: 0, handles: [] }));
    const store = new WebRemoteAccess(join(dir, WEB_REMOTE_ACCESS_FILE), { warn: () => {} }, () => clock);
    const who = adminKey("a", ADMIN);
    let browserId = 0; const tryOnce = () => store.signIn(who, "alice", "000000", { key: `b${browserId++}`, known: false });
    const told: boolean[] = [];
    for (let n = 0; n < 9; n++) { const v = tryOnce(); expect(v.kind).toBe("wrong"); told.push((v as any).began.halfAdmin); }
    expect(told.filter(Boolean)).toHaveLength(1); expect(told.indexOf(true)).toBe(SIGNIN_WRONG_LIMIT / 2 - 1);   // the fifth, once
    clock += 60 * 60_000;                                                                                     // an hour later: nothing forgotten
    expect(tryOnce().kind).toBe("paused");                                                                    // the tenth overall
    clock += 15 * 60_000 + 1;
    const again = tryOnce(); expect([again.kind, (again as any).began.halfAdmin]).toEqual(["wrong", false]);    // same cycle: not told again
    clock += 25 * 60 * 60_000;                                                                                 // a day and an hour of quiet: a new cycle
    const fresh: boolean[] = []; for (let n = 0; n < SIGNIN_WRONG_LIMIT / 2; n++) fresh.push((tryOnce() as any).began.halfAdmin);
    expect(fresh.filter(Boolean)).toHaveLength(1);
  });
});

describe("a browser that signed in before (the known-device mark)", () => {
  const signIn = async (br: ReturnType<ReturnType<typeof fleet>["browser"]>, user = ADMIN_B, offset = 0) => br.post({ account: user === ADMIN ? "alice_tg" : "bob", code: codeOf(secretFor(user), offset) });
  /**
   * What is wrong with a known-device cookie as "a mark that names no one" (empty: nothing). Deterministic: the mark's value is the
   * random-looking `<expiry>.<HMAC>` text (1–4 entries joined by `~`), so "the text does not contain the admin's id" is a coin flip
   * for an id made of digits or hex letters (CI flaked on it: a signature that happened to contain `200`). What is checked instead is
   * (a) its STRUCTURE — only canonical entries (an expiry of 10–16 digits, a dot, 32 lowercase hex), nothing else in the value, so
   * there is no field an identity could be in — and (b) the identities the test signed in as, which are chosen to be impossible in the
   * mark's alphabet (`[0-9a-f.~]`), so finding one in the value is always a real leak and never a coincidence.
   */
  const markProblems = (setCookie: string, identities: readonly string[]): string[] => {
    const problems: string[] = [];
    const eq = setCookie.indexOf("="), value = setCookie.slice(eq + 1).split(";")[0]!;
    const entries = value.split("~");
    if (entries.length < 1 || entries.length > 4) problems.push(`${entries.length} entries`);
    for (const e of entries) if (!/^[1-9][0-9]{9,15}\.[0-9a-f]{32}$/.test(e)) problems.push(`not an <expiry>.<signature> entry: ${e}`);
    if (!/^[0-9a-f.~]+$/.test(value)) problems.push("a character outside [0-9a-f.~]");
    for (const id of identities) if (id && /[^0-9a-f.~]/.test(id) && (value.includes(id) || setCookie.slice(0, eq).includes(id))) problems.push(`names ${id}`);
    return problems;
  };
  it("the first success hands out the browser's id and its mark (HttpOnly, SameSite=Strict, long-lived); the mark names no one", async () => {
    const f = fleet(), mine = f.browser(), r = await signIn(mine);
    expect(r.status).toBe(200);
    const cookies = (r.headers["Set-Cookie"] as string[]);
    const known = cookies.find(c => /^agend_signin_known/.test(c))!, id = cookies.find(c => /^agend_signin_browser/.test(c))!;
    for (const c of [known, id]) expect(c).toMatch(/HttpOnly; SameSite=Strict; Max-Age=\d+/);
    expect(Number(/Max-Age=(\d+)/.exec(known)![1])).toBe(90 * 24 * 3600);
    // The mark is one canonical <expiry>.<signature> entry and nothing else; its name is the fleet's (from the token), not the admin's.
    expect(markProblems(known, ["bob", "Alice_TG"])).toEqual([]);
    expect(known.split("=")[0]).toBe(fleetCookieName(SIGNIN_KNOWN_COOKIE, TOKEN));
    expect(known.slice(known.indexOf("=") + 1).split(";")[0]!.split("~")).toHaveLength(1);
  });
  it("…and an admin whose id can never appear in a mark by chance: the same sign-in, the id (and connection:id) is nowhere in the cookie", async () => {
    const SPECIAL = "Zq-200";                                                                   // 'Z', 'q' and '-' are outside the mark's alphabet: a hit is a leak, never luck
    const f = fleet({ admins: [SPECIAL], allowed: [SPECIAL], names: false }), mine = f.browser();
    const r = await mine.post({ account: SPECIAL, code: codeOf(secretFor(SPECIAL)) });
    expect(r.status).toBe(200);
    const known = (r.headers["Set-Cookie"] as string[]).find(c => /^agend_signin_known/.test(c))!;
    expect(markProblems(known, [SPECIAL, `a:${SPECIAL}`, "Zq", "a:Zq"])).toEqual([]);
    expect(known).not.toContain(SPECIAL); expect(known).not.toContain("Zq");
  });
  it("the check itself: it catches a mark that names someone (the control), and never mistakes a signature that merely contains the digits for one", () => {
    const mac = "0123456789abcdef0123456789abcdef", at = "1799999999999", name = "agend_signin_known_c21b13ddab05bbd2";
    // Real leaks, each of which the old substring check would also have flagged: all are reported.
    expect(markProblems(`${name}=200.${mac}; Path=/`, ["Zq-200"]).length).toBeGreaterThan(0);                  // an id where the expiry goes
    expect(markProblems(`${name}=${at}.${mac}~Zq-200; Path=/`, ["Zq-200"])).toEqual(expect.arrayContaining(["names Zq-200"]));
    expect(markProblems(`${name}=${at}.${mac}~bob; Path=/`, ["bob"])).toEqual(expect.arrayContaining(["names bob"]));
    expect(markProblems(`${name}=bob.${mac}; Path=/`, ["bob"]).length).toBeGreaterThan(0);
    expect(markProblems(`${name}=${at}.${mac}.200; Path=/`, [])).not.toEqual([]);                              // an extra field
    expect(markProblems(`${name}=${at}.${mac}~${at}.${mac}~${at}.${mac}~${at}.${mac}~${at}.${mac}; Path=/`, [])).not.toEqual([]);   // more than four entries
    expect(markProblems(`agend_signin_known_Zq-200=${at}.${mac}; Path=/`, ["Zq-200"])).toEqual(expect.arrayContaining(["names Zq-200"]));   // an id in the cookie's name
    // The flake: a perfectly good mark whose signature contains the admin's digits (or any of them, anywhere) is clean.
    for (const lucky of ["200", "100", "999", "20", "00"]) {
      const sig = (lucky + "f".repeat(32)).slice(0, 32), good = `${name}=${at}.${sig}; Path=/; HttpOnly`;
      expect(good).toContain(lucky);
      expect(markProblems(good, ["Zq-200", "bob"])).toEqual([]);
    }
    // Every position of "200" in a signature, and in the expiry's digits.
    for (let i = 0; i <= 29; i++) {
      const sig = ("a".repeat(i) + "200" + "b".repeat(32)).slice(0, 32), expiry = `1${"2".repeat(3)}00${"0".repeat(8)}`;
      expect(markProblems(`${name}=${expiry}.${sig}`, ["Zq-200", "bob"]), `i=${i}`).toEqual([]);
    }
  });
  it("another browser's wrong codes (even to the name's ceiling) do not hold a known device; it still needs the right code", async () => {
    const f = fleet(), mine = f.browser();
    expect((await signIn(mine)).status).toBe(200);
    for (let n = 0; n < SIGNIN_WRONG_LIMIT; n++) await f.totp({ account: "bob", code: "000000" });          // strangers: the admin's, the name's ceiling are in force
    expect((await f.totp({ account: "bob", code: codeOf(secretFor(ADMIN_B), 1) })).status).toBe(429);       // a new browser waits
    expect((await mine.post({ account: "bob", code: "000000" })).status).toBe(401);                          // the known one is let try — and a wrong code is wrong
    expect((await signIn(mine, ADMIN_B, 1)).status).toBe(200);                                               // …and the right one signs in
  });
  it("the whole sign-in's ceiling does not hold it either; and it is not a way round its own browser's limit", async () => {
    const f = fleet(), mine = f.browser();
    expect((await signIn(mine)).status).toBe(200);
    for (let n = 0; n < SIGNIN_FLEET_WRONG_LIMIT; n++) await f.totp({ account: `ghost${Math.floor(n / 4)}`, code: "000000" });
    expect((await f.totp({ account: "alice_tg", code: codeOf(secretFor(ADMIN)) })).status).toBe(429);
    expect((await signIn(mine, ADMIN_B, 1)).status).toBe(200);
    for (let n = 1; n < SIGNIN_BROWSER_WRONG_LIMIT; n++) expect((await mine.post({ account: "bob", code: "000000" })).status).toBe(401);
    expect((await mine.post({ account: "bob", code: "000000" })).status).toBe(429);                          // its own browser's limit still holds
    expect((await signIn(mine, ADMIN_B, 2)).status).toBe(429);
  });
  it("a stolen mark cannot be used to guess for ever by shedding cookies: its wrong codes are counted by the mark, not the browser id", async () => {
    const f = fleet(), mine = f.browser();
    expect((await signIn(mine)).status).toBe(200);
    const seen: number[] = [];
    for (let n = 0; n < SIGNIN_BROWSER_WRONG_LIMIT; n++) { mine.shed(); seen.push((await mine.post({ account: "bob", code: "000000" })).status); }
    expect(seen).toEqual([401, 401, 401, 401, 429]);                                                           // a new browser id each time, the same count
    mine.shed();
    expect((await mine.post({ account: "bob", code: codeOf(secretFor(ADMIN_B), 1) })).status).toBe(429);        // the right code waits too
  });
  it("every mark of one admin counts together in the known-path limiter (30): several stolen marks cannot add up their tries; half-way (15) the admins are told", async () => {
    const f = fleet(), who = adminKey("a", ADMIN_B);
    // Valid marks of Bob's (each from another sign-in, at another moment), each sent alone — a new browser id every time.
    const cookie = (n: number) => { const v = addSigninKnownDevice(TOKEN, undefined, who, f.access().enrollmentOf(who)!, f.any.webAuthorityState().epoch, Date.now() + n * 1000); return buildSigninCookie("known", v, false, TOKEN).split(";")[0]!; };
    const marks = Array.from({ length: 10 }, (_, n) => cookie(n));
    const wrong = async (n: number) => (await f.totp({ account: "bob", code: "000000" }, { cookie: marks[n]! })).status;
    // 29 wrong codes spread so that no single mark reaches its own limit (4 each), none is the 30th
    for (let m = 0; m < 7; m++) for (let n = 0; n < SIGNIN_BROWSER_WRONG_LIMIT - 1; n++) expect(await wrong(m)).toBe(401);
    expect(await wrong(7)).toBe(401);
    expect(f.notified.filter(t => /keeps trying/.test(t)).length).toBe(3);                                    // the admin's own half (5), the known path's (15) and the whole sign-in's (25), each once
    expect(await wrong(8)).toBe(429);                                                                          // the 30th overall, from a mark with one try: the known-path ceiling
    const saved = JSON.parse(readFileSync(join(f.dir, WEB_REMOTE_ACCESS_FILE), "utf8"));
    expect(saved.admins[who].klim.level).toBe(1);
    // a mark never used for a wrong code is held too — and the right code waits (a limit, like the others)
    const held = await f.totp({ account: "bob", code: codeOf(secretFor(ADMIN_B)) }, { cookie: marks[9]! });
    expect([held.status, held.json.error, held.headers["Retry-After"]]).toEqual([429, "paused", "900"]);
  });
  it("a mark written another way is not another mark: leading zeros, 0x, exponent, upper-case, a fractional expiry are refused, and cannot make a fresh count", async () => {
    const f = fleet(), who = adminKey("a", ADMIN_B), enrollment = f.access().enrollmentOf(who)!, epoch = f.any.webAuthorityState().epoch, now = Date.now();
    const mark = addSigninKnownDevice(TOKEN, undefined, who, enrollment, epoch, now);
    const [expiry, mac] = mark.split(".") as [string, string];
    const variants = [`0${expiry}.${mac}`, `00000${expiry}.${mac}`, `0x${Number(expiry).toString(16)}.${mac}`, `${expiry}.0.${mac}`, `${expiry}.${mac.toUpperCase()}`, ` ${expiry}.${mac}`,
      `${expiry}e0.${mac}`, `${Number(expiry) + 0.5}.${mac}`, `+${expiry}.${mac}`];
    expect(signinKnownDevice(TOKEN, mark, who, enrollment, epoch, now)).toBe(true);
    for (const v of variants) expect([v, signinKnownDevice(TOKEN, v, who, enrollment, epoch, now)]).toEqual([v, false]);
    expect(findSigninKnownEntry(TOKEN, mark, who, enrollment, epoch, now)).toBe(mark);                        // the one written form
    // Through the route: the real mark is exempt from a shared pause, every rewriting of it is not — and none starts a count of its own.
    const known = buildSigninCookie("known", mark, false, TOKEN).split(";")[0]!, name = known.split("=")[0]!;
    for (let n = 0; n < SIGNIN_WRONG_LIMIT; n++) await f.totp({ account: "bob", code: "000000" });             // strangers trip the shared ceilings
    // (a leading space never reaches the server: the cookie header's own whitespace is trimmed, so it is the same string)
    for (const [i, v] of variants.filter(x => !x.startsWith(" ")).entries()) expect((await f.totp({ account: "bob", code: codeOf(secretFor(ADMIN_B), 1) }, { cookie: `${name}=${v}` })).status, `variant ${i}`).toBe(429);
    const saved = JSON.parse(readFileSync(join(f.dir, WEB_REMOTE_ACCESS_FILE), "utf8"));
    expect(saved.admins[who].klim).toBeUndefined();
    expect((await f.totp({ account: "bob", code: codeOf(secretFor(ADMIN_B), 1) }, { cookie: known })).status).toBe(200);
  });
  it("the sixth try with a mark and a shed browser id is a 429, however the mark's string is padded (padding only makes a stranger of it, never a new count)", async () => {
    const f = fleet(), mine = f.browser();
    expect((await signIn(mine)).status).toBe(200);
    const known = [...mine.jar].find(([k]) => /^agend_signin_known/.test(k))!;
    const seen: number[] = [];
    for (let n = 0; n < SIGNIN_BROWSER_WRONG_LIMIT + 1; n++) seen.push((await f.totp({ account: "bob", code: "000000" }, { cookie: `${known[0]}=${n % 2 ? "0" : ""}${known[1]}` })).status);
    const plain: number[] = [];
    for (let n = 0; n < SIGNIN_BROWSER_WRONG_LIMIT; n++) plain.push((await f.totp({ account: "bob", code: "000000" }, { cookie: `${known[0]}=${known[1]}` })).status);
    // The plain spelling had been sent 3 times above (tries 0, 2, 4); the padded ones were strangers', not the mark's: so the mark's own 5th is its 2nd try here.
    expect(plain).toEqual([401, 429, 429, 429, 429]);
  });
  it("strangers' wrong codes (no mark) never touch the known-path count", async () => {
    const f = fleet(), mine = f.browser();
    expect((await signIn(mine)).status).toBe(200);
    for (let n = 0; n < SIGNIN_WRONG_LIMIT - 1; n++) await f.totp({ account: "bob", code: "000000" });          // new browsers, no marks
    const saved = JSON.parse(readFileSync(join(f.dir, WEB_REMOTE_ACCESS_FILE), "utf8"));
    expect(saved.admins[adminKey("a", ADMIN_B)].klim).toBeUndefined();
    expect((await mine.post({ account: "bob", code: codeOf(secretFor(ADMIN_B), 1) })).status).toBe(200);        // still let in, count untouched
  });
  it("it vouches only for the admin it was made for: Bob's browser is held like any other under Alice's name", async () => {
    const f = fleet(), mine = f.browser();
    expect((await signIn(mine)).status).toBe(200);                                                          // Bob's mark
    for (let n = 0; n < SIGNIN_WRONG_LIMIT; n++) await f.totp({ account: "alice_tg", code: "000000" });
    expect((await mine.post({ account: "alice_tg", code: codeOf(secretFor(ADMIN)) })).status).toBe(429);
  });
  it("the mark vouches by itself (its browser id is only for the browser's own limit); a forged one is nothing", async () => {
    const f = fleet(), mine = f.browser();
    expect((await signIn(mine)).status).toBe(200);
    const known = [...mine.jar].find(([k]) => /^agend_signin_known/.test(k))!;
    for (let n = 0; n < SIGNIN_WRONG_LIMIT; n++) await f.totp({ account: "bob", code: "000000" });
    const r = await f.totp({ account: "bob", code: codeOf(secretFor(ADMIN_B), 1) }, { cookie: `${known[0]}=${known[1]}` });   // the mark alone: a fresh browser id, still exempt from the shared ceilings (it is the mark that vouches)
    expect(r.status).toBe(200);
    for (let n = 0; n < SIGNIN_WRONG_LIMIT; n++) await f.totp({ account: "bob", code: "000000" });                      // a success clears the counts: held again
    const forged = await f.totp({ account: "bob", code: codeOf(secretFor(ADMIN_B), 2) }, { cookie: `${known[0]}=${"9999999999999.".concat("0".repeat(32))}` });
    expect(forged.status).toBe(429);
  });
  it("it stops vouching when the admin is demoted, their app is replaced or removed, or authority is revoked (the epoch moves)", async () => {
    const f = fleet(), mine = f.browser();
    expect((await signIn(mine)).status).toBe(200);
    const trip = async () => { for (let n = 0; n < SIGNIN_WRONG_LIMIT; n++) await f.totp({ account: "bob", code: "000000" }); };
    await trip();
    expect((await signIn(mine, ADMIN_B, 1)).status).toBe(200);                                              // exempt while all stands
    await trip();                                                                                           // a success clears the counts: held again
    // the app replaced
    const b = f.access().beginEnrollment("h", "x", adminKey("a", ADMIN_B));
    expect(f.access().confirmEnrollment("h", codeOf(b.secret, -1))).toBe("ok");
    expect((await mine.post({ account: "bob", code: codeOf(b.secret, 2) })).status).toBe(429);              // the new app: no longer exempt
    // demoted: not an admin, the name resolves to nobody
    f.fm.fleetConfig!.channels![0]!.access!.allowed_users = [ADMIN];
    expect(summary(await mine.post({ account: "bob", code: codeOf(b.secret, 3) }))).toMatchObject({ status: expect.any(Number) });
    expect((await mine.post({ account: "bob", code: codeOf(b.secret, 3) })).status).not.toBe(200);
    // revoked: the epoch moves
    const g = fleet(), mine2 = g.browser();
    expect((await signIn(mine2)).status).toBe(200);
    vi.spyOn(g.any, "webAuthorityState").mockReturnValue({ ...g.any.webAuthorityState(), epoch: g.any.webAuthorityState().epoch + 1 });
    for (let n = 0; n < SIGNIN_WRONG_LIMIT; n++) await g.totp({ account: "bob", code: "000000" });
    expect((await mine2.post({ account: "bob", code: codeOf(secretFor(ADMIN_B), 1) })).status).toBe(429);
  });
  it("the mark, as a pure function: other admin / other app / other epoch / other web token / expired / tampered each fail; renewal keeps other admins' entries", () => {
    const token = "t".repeat(48), now = 1_800_000_000_000, who = adminKey("a", ADMIN_B), other = adminKey("a", ADMIN);
    const mark = addSigninKnownDevice(token, undefined, who, "enr1", 3, now);
    expect(signinKnownDevice(token, mark, who, "enr1", 3, now + 1000)).toBe(true);
    expect([signinKnownDevice(token, mark, other, "enr1", 3, now), signinKnownDevice(token, mark, who, "enr2", 3, now), signinKnownDevice(token, mark, who, "enr1", 4, now),
      signinKnownDevice("u".repeat(48), mark, who, "enr1", 3, now), signinKnownDevice(token, mark, who, "enr1", 3, now + 91 * 24 * 3600_000),
      signinKnownDevice(token, mark.replace(/.$/, c => (c === "0" ? "1" : "0")), who, "enr1", 3, now), signinKnownDevice(token, undefined, who, "enr1", 3, now),
      signinKnownDevice(token, mark, null, "enr1", 3, now), signinKnownDevice(token, mark, who, null, 3, now)]).toEqual(Array(9).fill(false));
    const both = addSigninKnownDevice(token, mark, other, "enrA", 3, now);
    expect([signinKnownDevice(token, both, who, "enr1", 3, now), signinKnownDevice(token, both, other, "enrA", 3, now)]).toEqual([true, true]);
    expect(addSigninKnownDevice(token, both, who, "enr1", 3, now + 5).split("~")).toHaveLength(2);        // renewed, not piled up
  });
});

describe("rechecked as the session is made", () => {
  it("the app replaced, or the admin demoted, between the code and the session: no session, nothing admitted", () => {
    const f = fleet(), code = codeOf(secretFor(ADMIN));
    const first = f.any.totpSignIn({ exposureId: undefined, peer: "lan", account: "alice_tg", code, browser: { id: "b".repeat(32), address: "192.0.2.20" }, knownCookie: undefined });
    expect(first.kind).toBe("ok");
    const b = f.access().beginEnrollment("h", "x", adminKey("a", ADMIN)); f.access().confirmEnrollment("h", codeOf(b.secret, -1));
    const rec = f.any.webSessions.create({ tier: "admin", surface: "local", label: "x", tokenEpoch: tokenEpoch(TOKEN), owner: first.session.owner }).record;
    expect(first.commit(rec, "x")).toBe(false);
    const second = f.any.totpSignIn({ exposureId: undefined, peer: "lan", account: "alice_tg", code: codeOf(b.secret, 1), browser: { id: "b".repeat(32), address: "192.0.2.20" }, knownCookie: undefined });
    expect(second.kind).toBe("ok");
    f.fm.fleetConfig!.channels![0]!.access!.allowed_users = [ADMIN_B];
    expect(second.commit(rec, "x")).toBe(false);
  });
  it("the HTTP answer for a refused commit is 503 and the session is gone", async () => {
    const f = fleet();
    vi.spyOn(f.any, "totpSignIn").mockImplementation((() => ({ kind: "ok", session: { owner: { adapterId: "a", userId: ADMIN } }, commit: () => false })) as any);
    const r = await f.totp({ account: "alice_tg", code: "123456" });
    expect([r.status, r.json]).toEqual([503, { error: "unavailable" }]);
    expect(f.any.webSessions.list(undefined, () => true)).toEqual([]);
  });
  it.each([["lan"], ["tailnetServe"]] as const)("\"Only this computer can authorize\": refused from %s (404, nothing counted), and over a link; this computer's own browser still signs in", async where => {
    const f = fleet({ va: { loopback_only: true } });
    expect((await f.totp({ account: "alice_tg", code: codeOf(secretFor(ADMIN)) }, { where })).status).toBe(404);
    f.openLink();
    expect((await f.totp({ account: "alice_tg", code: codeOf(secretFor(ADMIN)) }, { link: "quick" })).status).toBe(404);
    expect(() => readFileSync(join(f.dir, WEB_REMOTE_ACCESS_FILE), "utf8")).not.toThrow();
    expect(JSON.parse(readFileSync(join(f.dir, WEB_REMOTE_ACCESS_FILE), "utf8")).signin).toBeUndefined();   // refused before anything is counted
    expect((await f.totp({ account: "alice_tg", code: codeOf(secretFor(ADMIN)) }, { where: "here" })).status).toBe(200);
  });
  it("the same on a web-only fleet", async () => {
    const f = fleet({ chat: false, va: { loopback_only: true } });
    expect((await f.totp({ code: codeOf(HOST_SECRET) }, { where: "lan" })).status).toBe(404);
    expect((await f.totp({ code: codeOf(HOST_SECRET) }, { where: "here" })).status).toBe(200);
  });
});

describe("every success tells the fleet's admins", () => {
  it("a Notice names who, the device and how, goes to General AND the dashboard's Notices once; no code or secret in it", async () => {
    const f = fleet();
    const code = codeOf(secretFor(ADMIN));
    expect((await f.totp({ account: "alice_tg", code })).status).toBe(200);
    const notices = f.feed();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatch(/signed in from a new browser with their authenticator code/);
    expect(notices[0]).toMatch(/direct connection/);
    expect(f.notified).toHaveLength(1);
    for (const text of [...notices, ...f.notified]) { expect(text).not.toContain(code); expect(text).not.toContain(secretFor(ADMIN)); }
  });
  it("with no General to post to, the web Notices carry it; over a link it says so", async () => {
    const f = fleet(); f.openLink();
    vi.spyOn(f.any, "notifyFleetError").mockImplementation((() => false) as any);
    expect((await f.totp({ account: "bob", code: codeOf(secretFor(ADMIN_B)) }, { link: "quick" })).status).toBe(200);
    expect(f.feed()).toHaveLength(1);
    expect(f.feed()[0]).toMatch(/public link/);
  });
  it("a web-only fleet's success is a Notice too", async () => {
    const f = fleet({ chat: false });
    expect((await f.totp({ code: codeOf(HOST_SECRET) })).status).toBe(200);
    expect(f.feed().length + f.notified.length).toBeGreaterThan(0);
  });
});

describe("the admins hear of a slow guesser half-way, once", () => {
  const half = (f: ReturnType<typeof fleet>) => f.notified.filter(t => /keeps trying/.test(t)).length;
  it("a real admin's count reaching half (5) is one Notice, no more in the same cycle; no code, no name in it", async () => {
    const f = fleet();
    for (let n = 0; n < SIGNIN_WRONG_LIMIT / 2 - 1; n++) await f.totp({ account: "bob", code: "000000" });
    expect(half(f)).toBe(0);
    await f.totp({ account: "bob", code: "000000" });
    expect(half(f)).toBe(1);
    for (let n = 0; n < 3; n++) await f.totp({ account: ADMIN_B, code: "000000" });
    expect(half(f)).toBe(1);
    const text = f.notified.find(t => /keeps trying/.test(t))!;
    expect(text).not.toMatch(/bob|000000|200/);
  });
  it("a name that is nobody's says nothing at its own half; the whole sign-in's half (25) says it once", async () => {
    const f = fleet();
    for (let n = 0; n < SIGNIN_WRONG_LIMIT / 2; n++) await f.totp({ account: "ghost", code: "000000" });
    expect(half(f)).toBe(0);
    for (let n = SIGNIN_WRONG_LIMIT / 2; n < SIGNIN_FLEET_WRONG_LIMIT / 2; n++) await f.totp({ account: `ghost${n}`, code: "000000" });
    expect(half(f)).toBe(1);
    for (let n = 0; n < 10; n++) await f.totp({ account: `other${n}`, code: "000000" });
    expect(half(f)).toBe(1);
  });
  it("the answers do not change because of it: the same 401 before and after the Notice", async () => {
    const f = fleet(), g = fleet();
    const real: number[] = [], ghost: number[] = [];
    for (let n = 0; n < 7; n++) { real.push((await f.totp({ account: "bob", code: "000000" })).status); ghost.push((await g.totp({ account: "nobody", code: "000000" })).status); }
    expect(real).toEqual(ghost);
  });
  it("the unified page tells a refused person to use the 8-character code or a device used before", () => {
    const js = readFileSync(join(process.cwd(), "src", "ui", "shared", "signin.js"), "utf8");
    expect(js).toMatch(/totp_help/);
    expect(js).toMatch(/8-character code or a signed-in device/);
    expect(js).toMatch(/8 字元裝置登入碼/);
  });
});

describe("the route's CSRF edge, and what is checked after the answer", () => {
  /** Everything a refused request must leave alone: the saved state (every limiter and every admin's `lastStep`), the browsers' counts, the sessions. */
  const state = (f: ReturnType<typeof fleet>) => ({ file: readFileSync(join(f.dir, WEB_REMOTE_ACCESS_FILE), "utf8"), browsers: (f.any.webRemoteAccess() as any).browserLim.size,
    sessions: f.any.webSessions.list(undefined, () => true).length });
  const who = adminKey("a", ADMIN_B);
  it.each([["no Origin header", null], ["another site's Origin", "http://evil.example"], ["the opaque Origin 'null'", "null"]] as const)("%s: 403, and nothing is counted, saved, handed out or spent", async (_why, origin) => {
    const f = fleet();
    const known = buildSigninCookie("known", addSigninKnownDevice(TOKEN, undefined, who, f.access().enrollmentOf(who)!, f.any.webAuthorityState().epoch, Date.now()), false, TOKEN).split(";")[0]!;
    f.access().signIn(adminKey("a", "nobody"), "warm", "000000", { key: "warm", known: false });                           // the counters exist, so a change shows
    const before = state(f);
    for (const [code, cookie] of [["000000", undefined], [codeOf(secretFor(ADMIN_B)), undefined], ["000000", known], [codeOf(secretFor(ADMIN_B)), known]] as const) {
      const r = await f.totp({ account: "bob", code }, { origin, ...(cookie ? { cookie } : {}) });
      expect([r.status, r.json]).toEqual([403, { error: "Cross-site request rejected" }]);
      expect(r.headers["Set-Cookie"]).toBeUndefined();                                                                  // no browser id, no mark, no session
      expect(state(f)).toEqual(before);                                                                                 // browser, name, admin, whole sign-in, known path: unchanged
    }
    // …and the right code was not spent by them: the same step still signs in, from the page's own origin.
    expect((await f.totp({ account: "bob", code: codeOf(secretFor(ADMIN_B)) })).status).toBe(200);
  });
  it("the same over a link: no Origin there is a 403 too, and counts nothing", async () => {
    const f = fleet(); f.openLink();
    const before = state(f);
    const r = await f.totp({ account: "bob", code: codeOf(secretFor(ADMIN_B)) }, { link: "quick", origin: null });
    expect([r.status, r.headers["Set-Cookie"], state(f)]).toEqual([403, undefined, before]);
    expect((await f.totp({ account: "bob", code: codeOf(secretFor(ADMIN_B)) }, { link: "quick" })).status).toBe(200);
  });
  it("the token rotated while the request is in flight: no session and no cookie of one, and the code is spent", async () => {
    const f = fleet(), real = f.any.totpSignIn.bind(f.any);
    vi.spyOn(f.any, "totpSignIn").mockImplementation(((input: unknown) => { const result = real(input); writeFileSync(join(f.dir, "web.token"), "e".repeat(48), { mode: 0o600 }); return result; }) as any);       // the token file replaced, as `agend web-token rotate` does
    const r = await f.totp({ account: "bob", code: codeOf(secretFor(ADMIN_B)) });
    expect([r.status, r.json]).toEqual([503, { error: "unavailable" }]);
    expect([r.headers["Set-Cookie"]].flat().filter(c => /session|signin_known/.test(String(c)))).toEqual([]);
    expect(f.any.webSessions.list(undefined, () => true)).toEqual([]);
  });
  it("a link that closes while the request is in flight: no session and no cookie of one", async () => {
    const f = fleet(); f.openLink();
    let live = true; const real = f.any.totpSignIn.bind(f.any);
    vi.spyOn(f.any, "totpSignIn").mockImplementation(((input: unknown) => { const result = real(input); live = false; return result; }) as any);
    const r = await f.totp({ account: "bob", code: codeOf(secretFor(ADMIN_B)) }, { link: "quick", current: () => live });
    expect([r.status, r.json]).toEqual([503, { error: "unavailable" }]);
    expect([r.headers["Set-Cookie"]].flat().filter(c => /session|signin_known/.test(String(c)))).toEqual([]);
    expect(f.any.webSessions.list(undefined, () => true)).toEqual([]);
  });
  it("a correct code clears the count of the name typed: nine wrong, the right one, nine wrong again never pauses", async () => {
    const f = fleet();
    for (let n = 0; n < SIGNIN_WRONG_LIMIT - 1; n++) expect((await f.totp({ account: "bob", code: "000000" })).status).toBe(401);
    expect((await f.totp({ account: "bob", code: codeOf(secretFor(ADMIN_B)) })).status).toBe(200);
    const idents = JSON.parse(readFileSync(join(f.dir, WEB_REMOTE_ACCESS_FILE), "utf8")).idents;
    expect(idents === undefined || !Object.keys(idents).length).toBe(true);
    for (let n = 0; n < SIGNIN_WRONG_LIMIT - 1; n++) expect((await f.totp({ account: "bob", code: "000000" })).status).toBe(401);   // 18 in all: only the cleared count lets this through
  });
  it("every key's admin standing is asked whatever the name is (a name that belongs to a record does no extra work)", async () => {
    const f = fleet(), asked: string[] = [], real = f.any.adminGate.bind(f.any);
    vi.spyOn(f.any, "adminGate").mockImplementation(((u: string, a: string) => { asked.push(`${a}:${u}`); return real(u, a); }) as any);
    await f.totp({ account: "nobody-at-all", code: "000000" });
    const forGhost = [...asked]; asked.length = 0;
    await f.totp({ account: "bob", code: "000000" });
    expect(forGhost.length).toBeGreaterThanOrEqual(2);                                                                   // both enrolled admins, a name that matches neither
    expect(asked.filter(x => x === `a:${ADMIN}` || x === `a:${ADMIN_B}`).length).toBeGreaterThanOrEqual(2);
    expect(forGhost.filter(x => x === `a:${ADMIN}` || x === `a:${ADMIN_B}`).sort()).toEqual([`a:${ADMIN}`, `a:${ADMIN_B}`]);
  });
});

describe("what is unchanged", () => {
  it("the 8-character sign-in code still signs in (a web-only fleet's `agend web --code`), authenticator or not", async () => {
    const f = fleet({ chat: false });
    const issued = f.any.webLoginCodes.issue({ tier: "admin", epoch: tokenEpoch(TOKEN), host: true });
    const req: any = Object.assign(Readable.from([Buffer.from(JSON.stringify({ code: issued.display }))]), { method: "POST", url: "/auth/login", socket: { remoteAddress: "127.0.0.1" },
      headers: { host: "127.0.0.1:19280", origin: "http://127.0.0.1:19280", "content-type": "application/json", "sec-fetch-site": "same-origin", "user-agent": "Safari" } });
    const out = await new Promise<number>(resolve => {
      const res: any = { destroyed: false, headersSent: false, writeHead(s: number) { this.s = s; }, end() { resolve(this.s); }, once() {}, removeListener() {} };
      handleAuthRequest(req, res, new URL(req.url, "http://127.0.0.1:19280"), f.any);
    });
    expect(out).toBe(200);
  });
  it("an admin with no app has no authenticator route: only the 8-character code (the name is answered as nobody's)", async () => {
    const f = fleet();
    expect(summary(await f.totp({ account: NO_APP, code: "123456" }))).toEqual(WRONG);
  });
  it("the unified page asks for the code only: no name field, no list, no suggestions; and it sends only the code", () => {
    const html = readFileSync(join(process.cwd(), "src", "ui", "signin.html"), "utf8");
    expect(html).not.toMatch(/datalist|list="/i);
    expect(html).not.toMatch(/id="account"|name="account"|autocomplete="username"/);
    expect(html).toMatch(/id="code"[^>]*autocomplete="one-time-code"/);
    const js = readFileSync(join(process.cwd(), "src", "ui", "shared", "signin.js"), "utf8");
    const submit = js.slice(js.indexOf("async function submitEntry"), js.indexOf("function entryInput"));
    expect(submit.length).toBeGreaterThan(0);
    expect(submit).toContain("body: JSON.stringify({ code: value.code })");
    expect(submit).not.toMatch(/\/auth\/(sessions|device-login)|admins|enumerate|\baccount\s*[:,]/);
  });
  it("the status a signed-in admin reads no longer carries a sign-in name (AGEND-155: nobody types one any more); it still says whether they have an app", () => {
    const f = fleet();
    const a = f.withCookie({ headers: { "Set-Cookie": `agend_session=${f.any.webSessions.create({ tier: "admin", surface: "local", label: "x", tokenEpoch: tokenEpoch(TOKEN), owner: { adapterId: "a", userId: ADMIN } }).sessionId}` } }, "lan");
    const status = f.any.webOutsideStatus(a.req);
    expect(status).toMatchObject({ enrolled: true });
    expect(status).not.toHaveProperty("signinName");
  });
  it("a stranger's session cookie, a guest's and a header token never reach the route's result (it takes only a code and a name)", async () => {
    const f = fleet();
    const guest = f.any.webSessions.create({ tier: "guest", surface: "local", label: "g", tokenEpoch: tokenEpoch(TOKEN), owner: { adapterId: "a", userId: STRANGER } });
    expect(evaluateSettingsRole({ session: guest.record, gateway: false, peer: "lan", tokenEpoch: tokenEpoch(TOKEN), webOnly: false,
      policy: { enabled: true, loopbackOnly: false, namedLink: false, quickLink: true }, isAdmin: () => true, outside: null })).toEqual({ ok: false, reason: "not_admin_session" });
    expect(summary(await f.totp({ account: STRANGER, code: "123456" }))).toEqual(WRONG);
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// AGEND-155 (#3486, the product owner's decision): the browser types the CODE ONLY. The server compares it with every admin's app.
// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe("code only: the server works out which admin it is (AGEND-155)", () => {
  const saved = (f: ReturnType<typeof fleet>) => JSON.parse(readFileSync(join(f.dir, WEB_REMOTE_ACCESS_FILE), "utf8"));
  const sessions = (f: ReturnType<typeof fleet>) => f.any.webSessions.list(undefined, () => true);
  const shape = (r: { status: number; json: unknown; headers: Record<string, any> }) => [r.status, r.json, Object.keys(r.headers).sort()];
  /** The apps compared, in order, by one request. */
  const traced = (f: ReturnType<typeof fleet>): (string | null)[] => { const seen: (string | null)[] = []; f.access().compareTrace = who => seen.push(who); return seen; };
  const A = adminKey("a", ADMIN), B = adminKey("a", ADMIN_B), C = adminKey("a", NO_APP);

  it.each(["lan", "tailnetServe", "here"] as const)("chat fleet, direct (%s): the code alone signs in as the admin it belongs to, each of them", async where => {
    const f = fleet();
    const a = await f.totp({ code: codeOf(secretFor(ADMIN)) }, { where });
    expect(a.status).toBe(200);
    expect(f.withCookie(a, where).record).toMatchObject({ tier: "admin", surface: "local", owner: { adapterId: "a", userId: ADMIN } });
    expect(f.withCookie(a, where).record.host).toBeUndefined();
    const b = await f.totp({ code: codeOf(secretFor(ADMIN_B)) }, { where });
    expect(b.status).toBe(200);
    expect(f.withCookie(b, where).record.owner).toEqual({ adapterId: "a", userId: ADMIN_B });
    // the role is the one #3503 gives THAT admin
    expect(f.any.settingsRole(f.withCookie(b, where).req).role).toMatchObject({ ok: true, actor: { adapter_id: "a", user_id: ADMIN_B }, account: true });
  });
  it("chat fleet over a public link: the code alone signs in as that admin, over the gateway", async () => {
    const f = fleet({ va: { quick_link: true } }); f.openLink();
    const r = await f.totp({ code: codeOf(secretFor(ADMIN_B)) }, { link: "quick" });
    expect(r.status).toBe(200);
    expect(f.withCookie(r, "lan", "quick").record).toMatchObject({ surface: "gateway", exposureId: "x", owner: { adapterId: "a", userId: ADMIN_B } });
  });
  it("web-only fleet: the code alone (direct, and over the outside link as the #3008 remote session)", async () => {
    const f = fleet({ chat: false });
    const r = await f.totp({ code: codeOf(HOST_SECRET) });
    expect(r.status).toBe(200);
    expect([f.withCookie(r, "lan").record.owner, f.withCookie(r, "lan").record.remote]).toEqual([undefined, undefined]);
    const o = fleet({ chat: false, outside: true }); o.openLink(OUTSIDE_LINK_OWNER);
    const l = await o.totp({ code: codeOf(HOST_SECRET) }, { link: "quick" });
    expect(l.status).toBe(200);
    expect(o.withCookie(l, "lan", "quick").record).toMatchObject({ remote: "totp", surface: "gateway" });
  });
  it("a chat fleet's own host operator is not someone a code can sign in as (its app is not among the candidates)", async () => {
    const f = fleet({ admins: [ADMIN, ADMIN_B], hostApp: true });
    const seen = traced(f);
    expect(summary(await f.totp({ code: codeOf(HOST_SECRET) }))).toEqual(WRONG);
    expect(seen).toEqual([A, B]);
  });
  it("the same time step cannot be used twice, and a step used by a confirmation (or by the switch) cannot sign in — both ways", async () => {
    const f = fleet();
    const code = codeOf(secretFor(ADMIN));
    expect((await f.totp({ code })).status).toBe(200);
    expect(summary(await f.totp({ code }))).toEqual(WRONG);
    expect(f.access().verify(code, A)).toMatchObject({ kind: "wrong" });
    const next = codeOf(secretFor(ADMIN), 1);
    expect(f.access().verify(next, A)).toEqual({ kind: "ok" });
    expect(summary(await f.totp({ code: next }))).toEqual(WRONG);
    // …and the other admin's code, in the same step, is unaffected
    expect((await f.totp({ code: codeOf(secretFor(ADMIN_B)) })).status).toBe(200);
  });

  describe("every admin with an app is compared, each time, whatever the answer", () => {
    const three = () => fleet({ admins: [ADMIN, ADMIN_B, NO_APP] });
    it("a code that belongs to the first, the middle, the last, and to nobody: the same list of comparisons", async () => {
      const f = three(), seen = traced(f);
      for (const [code, ok] of [[codeOf(secretFor(ADMIN)), true], [codeOf(secretFor(ADMIN_B)), true], [codeOf(secretFor(NO_APP)), true], ["000000", false]] as const) {
        seen.length = 0;
        expect((await f.totp({ code })).status).toBe(ok ? 200 : 401);
        expect(seen).toEqual([A, B, C]);                                                // nothing stops at a match
      }
    });
    it("an admin who is no longer one (demoted) is compared too — and cannot sign in; their step is not spent", async () => {
      const f = three(), seen = traced(f);
      f.fm.fleetConfig!.channels![0]!.access!.allowed_users = [ADMIN, NO_APP];            // ADMIN_B demoted
      expect(summary(await f.totp({ code: codeOf(secretFor(ADMIN_B)) }))).toEqual(WRONG);
      expect(seen).toEqual([A, B, C]);
      expect(saved(f).admins[B].lastStep).toBe(0);
    });
    it("every admin's standing is asked, whether or not an earlier one matched", async () => {
      const f = three(), asked: string[] = [], real = f.any.adminGate.bind(f.any);
      vi.spyOn(f.any, "adminGate").mockImplementation(((u: string, a: string) => { asked.push(u); return real(u, a); }) as any);
      await f.totp({ code: codeOf(secretFor(ADMIN)) });
      expect([...new Set(asked.filter(u => [ADMIN, ADMIN_B, NO_APP].includes(u)))].sort()).toEqual([ADMIN, ADMIN_B, NO_APP].sort());   // (the matched admin is asked once more as the session is made)
    });
    it("with no one having an app, one comparison is made with a decoy; the answer is the same 401", async () => {
      const f = fleet({ admins: [] }), seen = traced(f);
      expect(summary(await f.totp({ code: "123456" }))).toEqual(WRONG);
      expect(seen).toEqual([null]);
    });
    it("the real HMAC work is the same: ordinary wrong, inside the skew reach, outside it, used, demoted, collision, not six digits — and a decoy when no one has an app", () => {
      let T = 0;
      const find = (() => { const t = Math.floor(Date.now() / 30_000) * 30_000 + 10_000, sec = (i: number) => base32Encode(Buffer.from(`collide-${i}`.padEnd(20, "#").slice(0, 20))), seen = new Map<string, string>();
        for (let i = 0; i < 20_000; i++) { const c = hotp(base32Decode(sec(i))!, totpStep(t)), o = seen.get(c); if (o) return [o, sec(i), t] as const; seen.set(c, sec(i)); } throw new Error("none"); })();
      const [sa, sb] = find; T = find[2];
      vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(T);
      try {
        const dir = mkdtempSync(join(tmpdir(), "agend-155-hmac-")); roots.push(dir);
        const rec = (secret: string) => ({ secret, enrolledAt: 1, lastStep: 0 });
        writeFileSync(join(dir, WEB_REMOTE_ACCESS_FILE), JSON.stringify({ v: 1, admins: { [A]: rec(sa), [B]: rec(sb) }, outside: false, wrong: 0, level: 0, pausedUntil: 0, handles: [] }));
        const store = new WebRemoteAccess(join(dir, WEB_REMOTE_ACCESS_FILE), { warn: () => {} });
        // A's step +1 is spent by a confirmation, so its code at +1 is a "used" one (B's code at +1 is not A's).
        expect(store.verify(hotp(base32Decode(sa)!, totpStep(T) + 1), A)).toEqual({ kind: "ok" });
        const both = [{ who: A, eligible: true }, { who: B, eligible: true }];
        let n = 0;
        const work = (code: string, candidates = both): number => { const before = hmac.calls; store.signInByCode(code, { key: `k${n++}` }, candidates, []); return hmac.calls - before; };
        const at = (secret: string, offset: number) => hotp(base32Decode(secret)!, totpStep(T) + offset);
        const per = 2 * TOTP_REACH_STEPS + 1, all = (2 + TOTP_RETIRED_SLOTS) * per;   // two admins, plus the fixed pool of retired-app slots
        const counts = {
          ordinary: work("000000"),
          skewInside: work(at(sa, 2)),                       // two steps ahead: inside the reach, outside the accepted window
          skewOutside: work(at(sa, 9)),                      // far outside
          used: work(at(sa, 1)),                             // a step already spent
          demoted: work(at(sb, -1), [{ who: A, eligible: true }, { who: B, eligible: false }]),
          collision: work(at(sa, 0)),                        // matches both apps
          notDigits: work("12ab"),
        };
        expect(counts).toEqual({ ordinary: all, skewInside: all, skewOutside: all, used: all, demoted: all, collision: all, notDigits: all });
        const empty = new WebRemoteAccess(join(mkdtempSync(join(tmpdir(), "agend-155-hmac0-")), WEB_REMOTE_ACCESS_FILE), { warn: () => {} });
        const before = hmac.calls; empty.signInByCode("123456", { key: "x" }, [], []);
        expect(hmac.calls - before).toBe((1 + TOTP_RETIRED_SLOTS) * per);   // the decoy: exactly one app's worth, plus the same fixed retired pool
        // …and the same after an app was retired (replaced), and with a full pool: nothing about the lifecycle changes the work.
        const spare = store.beginEnrollment("h", "x", B), keep = [{ who: A, eligible: true }, { who: B, eligible: true }];
        expect(store.confirmEnrollment("h", hotp(base32Decode(spare.secret)!, totpStep(T) + 1))).toBe("ok");
        const afterRetire = (() => { const b4 = hmac.calls; store.signInByCode("000000", { key: "after" }, keep, []); return hmac.calls - b4; })();
        expect(afterRetire).toBe(all);
      } finally { vi.useRealTimers(); }
    });
    it("a web-only fleet compares its one app", async () => {
      const f = fleet({ chat: false }), seen = traced(f);
      await f.totp({ code: "000000" });
      expect(seen).toEqual([HOST_ADMIN_KEY]);
    });
  });

  describe("two apps matching at once: nobody is signed in, and it is not an oracle", () => {
    /** Two secrets whose codes are equal at the same step (found by search: about 3 in a million per pair, so we look). */
    /** `[a, b]` with a's code at step now+offA equal to b's code at step now+offB (the same step: 0, 0), found by search; and the moment (mid-step) to pin the clock at. */
    const collide = (offA = 0, offB = 0): [string, string, number] => {
      const T = Math.floor(Date.now() / 30_000) * 30_000 + 10_000, secretOf = (i: number) => base32Encode(Buffer.from(`collide-${i}`.padEnd(20, "#").slice(0, 20)));
      const byCode = new Map<string, string>();
      for (let i = 0; i < 20_000; i++) byCode.set(hotp(base32Decode(secretOf(i))!, totpStep(T) + offA), secretOf(i));
      for (let j = 0; j < 20_000; j++) {
        const other = byCode.get(hotp(base32Decode(secretOf(j))!, totpStep(T) + offB));
        if (other && other !== secretOf(j)) return [other, secretOf(j), T];
      }
      throw new Error("no collision found");
    };
    afterEach(() => { vi.useRealTimers(); });
    it("the code of both: 401 like any wrong code, nobody signed in, no step spent, counted like a wrong code", async () => {
      const [sa, sb, T] = collide();
      vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(T);
      const f = fleet({ secrets: { [ADMIN]: sa, [ADMIN_B]: sb } }), plain = fleet({ secrets: { [ADMIN]: sa, [ADMIN_B]: sb } });
      const code = codeOf(sa);
      expect(code).toBe(codeOf(sb));
      const both = await f.totp({ code }), wrong = await plain.totp({ code: code === "000000" ? "000001" : "000000" });
      expect(shape(both)).toEqual(shape(wrong));
      expect(both.status).toBe(401); expect(both.json).toEqual({ error: "wrong_code" });
      expect(sessions(f)).toEqual([]);
      expect([saved(f).admins[A].lastStep, saved(f).admins[B].lastStep]).toEqual([0, 0]);          // not spent: a collision cannot burn anyone's step
      expect(saved(f).signin.wrong).toBe(1);                                                        // counted exactly as a wrong code is …
      expect(saved(f).signin.wrong).toBe(saved(plain).signin.wrong);
      expect([saved(f).admins[A].lim, saved(f).admins[B].lim, saved(f).idents]).toEqual([undefined, undefined, undefined]);   // … and nothing names either admin
      expect(f.notified).toEqual([]);                                                               // no Notice for it
      expect(f.access().verify(code, A)).toEqual({ kind: "ok" });                                  // A's own confirmation can still use that code
    });
    it("the next code (next step) of either one signs that one in", async () => {
      const [sa, sb, T] = collide();
      vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(T);
      const f = fleet({ secrets: { [ADMIN]: sa, [ADMIN_B]: sb } });
      expect((await f.totp({ code: codeOf(sa) })).status).toBe(401);
      expect((await f.totp({ code: codeOf(sa, 1) })).status).toBe(200);
      expect(f.withCookie(await f.totp({ code: codeOf(sb, -1) }), "lan").record).toMatchObject({ owner: { userId: ADMIN_B } });
    });
    it("a refused collision stays refused after one of them SPENDS the step (route level): unnamed B-digits 401 → named B signs in as B → the same digits unnamed are still 401, never A", async () => {
      const [sa, sb, T] = collide();
      vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(T);
      const f = fleet({ secrets: { [ADMIN]: sa, [ADMIN_B]: sb } });
      const digits = codeOf(sb);
      expect(digits).toBe(codeOf(sa));
      expect(summary(await f.totp({ code: digits }))).toEqual(WRONG);
      const named = await f.totp({ account: "bob", code: digits });
      expect([named.status, f.withCookie(named, "lan").record.owner]).toEqual([200, { adapterId: "a", userId: ADMIN_B }]);   // by name it is B's, and spends B's step
      expect(saved(f).admins[B].lastStep).toBe(totpStep(T));
      for (let n = 0; n < 2; n++) {
        expect(summary(await f.totp({ code: digits }))).toEqual(WRONG);                              // the same digits, unnamed: refused, not A
        f.restart();                                                                                  // … and a restart changes nothing (no state is kept for it)
      }
      expect(sessions(f)).toHaveLength(1);                                                            // only the named one: no session was made for A
      expect(saved(f).admins[A].lastStep).toBe(0);
    });
    it("a refused collision stays refused after ONE of the two steps ages out (route level): B's step S equals A's step S+1; once S is gone and S+1 is still accepted the same digits are still 401", async () => {
      const [sa, sb, T] = collide(1, 0);                                                              // a's code one step ahead = b's code now
      vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(T);
      const f = fleet({ secrets: { [ADMIN]: sa, [ADMIN_B]: sb } });
      const digits = codeOf(sb);
      expect(digits).toBe(codeOf(sa, 1));
      expect(summary(await f.totp({ code: digits }))).toEqual(WRONG);                                 // both steps in the window: ambiguous
      vi.setSystemTime(T + 2 * 30_000);                                                               // S is two steps back (out), S+1 one step back (still accepted for A)
      expect(totpStep(Date.now()) - 1).toBe(totpStep(T) + 1);
      expect(summary(await f.totp({ code: digits }))).toEqual(WRONG);                                 // before the fix this signed in as A
      f.restart();
      expect(summary(await f.totp({ code: digits }))).toEqual(WRONG);
      expect(sessions(f)).toEqual([]);
      expect([saved(f).admins[A].lastStep, saved(f).admins[B].lastStep]).toEqual([0, 0]);
      // …once the steps it matched are all out of reach, the admin's own next code works as usual
      expect((await f.totp({ code: codeOf(sa, 1) })).status).toBe(200);
    });
    it("a refused collision is refused whether or not one of the two may sign in (demoted) and whatever the limits say", async () => {
      const [sa, sb, T] = collide();
      vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(T);
      const f = fleet({ secrets: { [ADMIN]: sa, [ADMIN_B]: sb } });
      f.fm.fleetConfig!.channels![0]!.access!.allowed_users = [ADMIN];                                // B demoted: only A could sign in
      expect(summary(await f.totp({ code: codeOf(sa) }))).toEqual(WRONG);
      expect(sessions(f)).toEqual([]);
    });
    describe("a refused collision stays refused when the matching admin removes or replaces their OWN app (retired apps)", () => {
      /** B signs in by name with the step BEFORE the collision step (so B's collision step is still unspent), then the unnamed digits are refused. */
      const setup = async () => {
        const [sa, sb, T] = collide();
        vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(T);
        const f = fleet({ secrets: { [ADMIN]: sa, [ADMIN_B]: sb } });
        const mine = await f.totp({ account: "bob", code: codeOf(sb, -1) });
        expect(mine.status).toBe(200);
        const session = f.withCookie(mine, "lan");
        const digits = codeOf(sb);
        expect(digits).toBe(codeOf(sa));
        expect(summary(await f.totp({ code: digits }))).toEqual(WRONG);
        return { f, sa, sb, T, digits, session };
      };
      it("B REMOVES their app (proving their current code): the same digits are still 401, also after a restart; A's next code and B's other codes behave", async () => {
        const { f, sa, sb, T, digits, session } = await setup();
        expect(f.any.webOutsideRemove(session.req, digits)).toBe("ok");
        expect(f.access().isEnrolled(B)).toBe(false);
        expect(summary(await f.totp({ code: digits }))).toEqual(WRONG);                                // before the fix: 200 as A
        f.restart();
        expect(summary(await f.totp({ code: digits }))).toEqual(WRONG);
        expect(saved(f).admins[A].lastStep).toBe(0);                                                    // A's step was never spent by the refusals
        expect(saved(f).retired).toHaveLength(1);
        // the retired secret is never a way in: it signs nobody in, by name or by code alone, and confirms nothing
        expect(summary(await f.totp({ code: codeOf(sb, 1) }))).toEqual(WRONG);
        expect(summary(await f.totp({ account: "bob", code: codeOf(sb, 1) }))).toEqual(WRONG);
        expect(f.access().verify(codeOf(sb, 1), B)).toEqual({ kind: "not_enrolled" });
        // someone who collides with nobody is not affected: A's own next code (a different number) signs A in at once
        const next = await f.totp({ code: codeOf(sa, 1) });
        expect(next.status).toBe(200);
        expect(f.withCookie(next, "lan").record.owner).toEqual({ adapterId: "a", userId: ADMIN });
        // once the retention is over A's collision step is out of the window anyway and the retired app is forgotten
        vi.setSystemTime(T + TOTP_RETIRED_KEEP_MS + 60_000);
        const later = await f.totp({ code: codeOf(sa, 1) });
        expect(later.status).toBe(200);
      });
      it("B REPLACES their app (begin with their current code, confirm with the new app's): the same digits are still 401 after a restart; the new app's code works at once", async () => {
        const { f, sa, digits, session } = await setup();
        const begun = f.any.webOutsideBeginEnrollment(session.req, digits);
        expect(begun).toHaveProperty("secret");
        expect(f.any.webOutsideConfirmEnrollment(session.req, codeOf((begun as any).secret))).toBe("ok");
        expect(summary(await f.totp({ code: digits }))).toEqual(WRONG);
        f.restart();
        expect(summary(await f.totp({ code: digits }))).toEqual(WRONG);
        expect(saved(f).admins[A].lastStep).toBe(0);
        const mineNow = await f.totp({ code: codeOf((begun as any).secret, 1) });                         // the new app: usable at once, as B
        expect(mineNow.status).toBe(200);
        expect(f.withCookie(mineNow, "lan").record.owner).toEqual({ adapterId: "a", userId: ADMIN_B });
        expect((await f.totp({ code: codeOf(sa, 1) })).status).toBe(200);                                 // and A's next code is untouched
      });
      it("the retired secret is saved with the other state (restart-proof), is not used for anything else, and its keep time is the documented 3 minutes", async () => {
        const { f, sb, session, digits } = await setup();
        expect(f.any.webOutsideRemove(session.req, digits)).toBe("ok");
        const file = saved(f);
        expect(file.retired).toEqual([{ who: B, secret: sb, until: Date.now() + TOTP_RETIRED_KEEP_MS }]);
        expect(TOTP_RETIRED_KEEP_MS).toBe(180_000);
        expect(file.admins[B]).toBeUndefined();
      });
      it("more apps retired within the keep time than the pool holds: nothing is forgotten quietly — code-only sign-in is refused (as a wrong code) until the dropped one's time is over", () => {
        let clock = 1_800_000_000_000;
        const dir = mkdtempSync(join(tmpdir(), "agend-155-pool-")); roots.push(dir);
        writeFileSync(join(dir, WEB_REMOTE_ACCESS_FILE), JSON.stringify({ v: 1, admins: { [A]: { secret: secretFor(ADMIN), enrolledAt: 1, lastStep: 0 }, [B]: { secret: secretFor(ADMIN_B), enrolledAt: 1, lastStep: 0 } }, outside: false, wrong: 0, level: 0, pausedUntil: 0, handles: [] }));
        const store = new WebRemoteAccess(join(dir, WEB_REMOTE_ACCESS_FILE), { warn: () => {} }, () => clock);
        const both = [{ who: A, eligible: true }, { who: B, eligible: true }];
        const replaceB = () => { const b = store.beginEnrollment("h", "x", B); expect(store.confirmEnrollment("h", hotp(base32Decode(b.secret)!, totpStep(clock)))).toBe("ok"); };
        for (let n = 0; n < TOTP_RETIRED_SLOTS; n++) replaceB();
        expect(JSON.parse(readFileSync(join(dir, WEB_REMOTE_ACCESS_FILE), "utf8")).holdUntil).toBeUndefined();     // full, nothing dropped yet
        expect(store.signInByCode(hotp(base32Decode(secretFor(ADMIN))!, totpStep(clock)), { key: "ok" }, both, []).kind).toBe("ok");
        clock += 1_000; replaceB();                                                                           // one more: the oldest is dropped …
        const held = JSON.parse(readFileSync(join(dir, WEB_REMOTE_ACCESS_FILE), "utf8"));
        expect(held.retired).toHaveLength(TOTP_RETIRED_SLOTS);
        expect(held.holdUntil).toBeGreaterThan(clock);
        expect(store.signInByCode(hotp(base32Decode(secretFor(ADMIN))!, totpStep(clock) + 1), { key: "held" }, both, []).kind).toBe("wrong");   // … so the right code is refused, uniformly
        clock = held.holdUntil + 1;
        expect(store.signInByCode(hotp(base32Decode(secretFor(ADMIN))!, totpStep(clock)), { key: "free" }, both, []).kind).toBe("ok");
        const reopened = new WebRemoteAccess(join(dir, WEB_REMOTE_ACCESS_FILE), { warn: () => {} }, () => held.holdUntil - 5_000);
        expect(reopened.signInByCode(hotp(base32Decode(secretFor(ADMIN))!, totpStep(held.holdUntil - 5_000) + 1), { key: "r" }, both, []).kind).toBe("wrong");   // the hold survives a restart
      });
    });
    it("the digits of an admin who does NOT collide still sign in after another admin spent a step (the rule refuses only what two apps match)", async () => {
      const f = fleet();
      expect(f.access().verify(codeOf(secretFor(ADMIN_B)), B)).toEqual({ kind: "ok" });
      expect((await f.totp({ code: codeOf(secretFor(ADMIN)) })).status).toBe(200);
    });
  });

  describe("no oracle: every way of not getting in is one answer, counted the same", () => {
    it("wrong, nobody's, demoted, already used, an admin with no app: the same status, body, headers and the same saved counters", async () => {
      const run = async (make: (f: ReturnType<typeof fleet>) => Promise<{ status: number; json: unknown; headers: Record<string, any> }>) => {
        const f = fleet(), r = await make(f), s = saved(f);
        return { r: shape(r), signin: s.signin?.wrong, admins: Object.values(s.admins as Record<string, any>).map(x => [x.lastStep, x.lim, x.klim]), idents: s.idents, sessions: sessions(f).length };
      };
      const answers = await Promise.all([
        run(f => f.totp({ code: "000000" })),                                                                  // right for nobody
        run(f => f.totp({ code: codeOf(secretFor(ADMIN), 5) })),                                              // a step far outside the window
        run(async f => { f.fm.fleetConfig!.channels![0]!.access!.allowed_users = [ADMIN_B]; return f.totp({ code: codeOf(secretFor(ADMIN)) }); }),   // right, but demoted
        run(async f => { const c = codeOf(secretFor(ADMIN)); await f.totp({ code: c }); return f.totp({ code: c }); }),   // used: one sign-in, then the same step again
        run(f => f.totp({ code: codeOf(secretFor(NO_APP)) })),                                                // an admin with no app
      ]);
      for (const a of answers) expect(a.r).toEqual([401, { error: "wrong_code" }, ["Content-Type", "Set-Cookie"]]);
      expect(answers.map(a => a.signin)).toEqual([1, 1, 1, 1, 1]);
      for (const a of answers) expect(a.idents).toBeUndefined();
      expect(answers.map(a => a.sessions)).toEqual([0, 0, 0, 1, 0]);                                         // (the used-code run did sign in once, first)
    });
    it("a wrong code with no name touches the browser's count and the whole sign-in's — no admin's own count, no name's", async () => {
      const f = fleet();
      for (let n = 0; n < 4; n++) await f.totp({ code: "000000" });
      const s = saved(f);
      expect(s.signin.wrong).toBe(4);
      expect(Object.values(s.admins as Record<string, any>).map(a => [a.lim, a.klim])).toEqual([[undefined, undefined], [undefined, undefined]]);
      expect(s.idents).toBeUndefined();
      expect((f.access() as any).browserLim.size).toBe(4);                                                              // one per browser (no cookies were sent)
    });
    it("a body that is not {code: string} is a 400; a code that is not six digits is just a wrong code", async () => {
      const f = fleet();
      expect((await f.totp({ code: 123456 })).status).toBe(400);
      expect((await f.totp({})).status).toBe(400);
      for (const code of ["", "12345", "1234567", "abcdef", "12 34 5"]) expect((await f.totp({ code })).status).toBe(401);
    });
  });

  describe("limits for the code alone", () => {
    it("the whole sign-in's ceiling is 20 now, for every browser, with no cookies kept: the 20th wrong code pauses all new devices (the right code too)", async () => {
      expect(SIGNIN_FLEET_WRONG_LIMIT).toBe(20);
      const f = fleet();
      for (let n = 1; n < SIGNIN_FLEET_WRONG_LIMIT; n++) expect((await f.totp({ code: "000000" })).status).toBe(401);
      const last = await f.totp({ code: "000000" });
      expect([last.status, last.json.error, last.headers["Retry-After"]]).toEqual([429, "paused", "900"]);
      expect((await f.totp({ code: codeOf(secretFor(ADMIN)) })).status).toBe(429);
      expect(f.notified.filter(t => /paused/.test(t))).toHaveLength(1);                                      // said once, to the admins
      expect(f.notified.filter(t => /keeps trying/.test(t))).toHaveLength(1);                                // …and once half-way, at 10
    });
    it("the half-way Notice comes at the 10th wrong code, once per cycle, with no code or name in it", async () => {
      const f = fleet();
      for (let n = 0; n < SIGNIN_FLEET_WRONG_LIMIT / 2 - 1; n++) await f.totp({ code: "000000" });
      expect(f.notified.filter(t => /keeps trying/.test(t))).toHaveLength(0);
      await f.totp({ code: "000000" });
      expect(f.notified.filter(t => /keeps trying/.test(t))).toHaveLength(1);
      for (let n = 0; n < 5; n++) await f.totp({ code: "000000" });
      expect(f.notified.filter(t => /keeps trying/.test(t))).toHaveLength(1);
      expect(f.notified.find(t => /keeps trying/.test(t))).not.toMatch(/000000|bob|alice/i);
    });
    it("one browser's own limit is unchanged: 5 wrong codes pause that browser (429, 5 minutes); another browser signs in at once", async () => {
      const f = fleet(), mine = f.browser();
      const seen: number[] = [];
      for (let n = 0; n < SIGNIN_BROWSER_WRONG_LIMIT; n++) seen.push((await mine.post({ code: "000000" })).status);
      expect(seen).toEqual([401, 401, 401, 401, 429]);
      expect((await mine.post({ code: codeOf(secretFor(ADMIN_B)) })).status).toBe(429);
      expect((await f.browser().post({ code: codeOf(secretFor(ADMIN_B)) })).status).toBe(200);
    });
    it("clearing cookies does not clear the whole sign-in's count (and a success does not either)", async () => {
      const f = fleet(), mine = f.browser();
      for (let n = 0; n < 8; n++) { mine.shed(); await mine.post({ code: "000000" }); }
      expect((await f.totp({ code: codeOf(secretFor(ADMIN)) })).status).toBe(200);
      expect(saved(f).signin.wrong).toBe(8);
    });
    it("a known device is not held by the whole sign-in's pause: it signs in with the right code; its own browser limit still holds", async () => {
      const f = fleet(), mine = f.browser();
      expect((await mine.post({ code: codeOf(secretFor(ADMIN_B)) })).status).toBe(200);                      // the mark is handed out
      for (let n = 0; n < SIGNIN_FLEET_WRONG_LIMIT; n++) await f.totp({ code: "000000" });                   // strangers pause the whole sign-in
      expect((await f.totp({ code: codeOf(secretFor(ADMIN), 1) })).status).toBe(429);                         // a new device waits …
      expect((await mine.post({ code: codeOf(secretFor(ADMIN_B), 1) })).status).toBe(200);                    // … the known one is let in
      for (let n = 0; n < SIGNIN_FLEET_WRONG_LIMIT; n++) await f.totp({ code: "000000" });
      for (let n = 1; n < SIGNIN_BROWSER_WRONG_LIMIT; n++) expect((await mine.post({ code: "000000" })).status).toBe(401);
      expect((await mine.post({ code: "000000" })).status).toBe(429);                                          // its browser limit
      expect((await mine.post({ code: codeOf(secretFor(ADMIN_B), 2) })).status).toBe(429);
    });
    it("a known device vouches only for its own admin: with Bob's mark, Alice's code is held like anyone's while the whole sign-in is paused", async () => {
      const f = fleet(), mine = f.browser();
      expect((await mine.post({ code: codeOf(secretFor(ADMIN_B)) })).status).toBe(200);
      for (let n = 0; n < SIGNIN_FLEET_WRONG_LIMIT; n++) await f.totp({ code: "000000" });
      const r = await mine.post({ code: codeOf(secretFor(ADMIN), 1) });
      expect(r.status).not.toBe(200);
      expect(sessions(f).filter((x: any) => x.owner?.userId === ADMIN)).toEqual([]);
    });
    it("known path by mark × admin, as before: a stolen mark with its browser id shed every time is counted by the mark, and by the admin's known-path limiter (30)", async () => {
      const f = fleet(), mine = f.browser();
      expect((await mine.post({ code: codeOf(secretFor(ADMIN_B)) })).status).toBe(200);
      const known = [...mine.jar].find(([k]) => /^agend_signin_known/.test(k))!, cookie = `${known[0]}=${known[1]}`;
      const seen: number[] = [];
      for (let n = 0; n < SIGNIN_BROWSER_WRONG_LIMIT; n++) seen.push((await f.totp({ code: "000000" }, { cookie })).status);   // a new browser id each time
      expect(seen).toEqual([401, 401, 401, 401, 429]);                                                                          // counted by the mark
      expect(SIGNIN_KNOWN_WRONG_LIMIT).toBe(30);
      expect(saved(f).admins[B].klim.wrong).toBeGreaterThan(0);
      expect((await f.totp({ code: codeOf(secretFor(ADMIN_B), 1) }, { cookie })).status).toBe(429);                              // the right code waits too
    });
    it("every mark of one admin counts together in the known-path limiter (30): several stolen marks cannot add up their tries", async () => {
      const f = fleet();
      const cookie = (n: number) => { const v = addSigninKnownDevice(TOKEN, undefined, B, f.access().enrollmentOf(B)!, f.any.webAuthorityState().epoch, Date.now() + n * 1000); return buildSigninCookie("known", v, false, TOKEN).split(";")[0]!; };
      const marks = Array.from({ length: 10 }, (_, n) => cookie(n));
      const wrong = async (n: number) => (await f.totp({ code: "000000" }, { cookie: marks[n]! })).status;
      for (let m = 0; m < 7; m++) for (let n = 0; n < SIGNIN_BROWSER_WRONG_LIMIT - 1; n++) expect(await wrong(m)).toBe(401);
      expect(await wrong(7)).toBe(401);                                                                      // 29 in all
      expect(await wrong(8)).toBe(429);                                                                      // the 30th overall: the known-path ceiling
      expect(saved(f).admins[B].klim.level).toBe(1);
      expect(f.notified.filter(t => /keeps trying/.test(t))).toHaveLength(2);                                // the whole sign-in's half (10) and the known path's (15), once each
    });
    it("a stranger's wrong codes never touch the known-path count, and a success clears this admin's counts but not the whole sign-in's", async () => {
      const f = fleet(), mine = f.browser();
      expect((await mine.post({ code: codeOf(secretFor(ADMIN_B)) })).status).toBe(200);
      for (let n = 0; n < 12; n++) await f.totp({ code: "000000" });
      expect(saved(f).admins[B].klim).toBeUndefined();
      expect((await mine.post({ code: codeOf(secretFor(ADMIN_B), 1) })).status).toBe(200);
      expect(saved(f).signin.wrong).toBe(12);
    });
    it("an admin's own ceiling (started only by requests that still send a name) does not block that admin's code-only sign-in: typing wrong codes under Bob's name cannot lock Bob out", async () => {
      const f = fleet();
      for (let n = 0; n < SIGNIN_WRONG_LIMIT; n++) await f.totp({ account: ["bob", ADMIN_B][n % 2], code: "000000" });
      expect(saved(f).admins[B].lim.level).toBe(1);                                                          // the named path is held for Bob …
      expect((await f.totp({ account: "bob", code: codeOf(secretFor(ADMIN_B)) })).status).toBe(401);          // … including his right code, under his name
      const r = await f.totp({ code: codeOf(secretFor(ADMIN_B), 1) });                                        // … but not the code alone
      expect(r.status).toBe(200);
      expect(f.withCookie(r, "lan").record.owner).toEqual({ adapterId: "a", userId: ADMIN_B });
      expect((await f.totp({ code: codeOf(secretFor(ADMIN)) })).status).toBe(200);                           // another admin is not held either
    });
    it("the whole sign-in's ceiling and the browser's limit still bound that same code-only path (nothing else was removed)", async () => {
      const f = fleet();
      for (let n = 0; n < SIGNIN_WRONG_LIMIT; n++) await f.totp({ account: "bob", code: "000000" });
      for (let n = 0; n < SIGNIN_FLEET_WRONG_LIMIT - SIGNIN_WRONG_LIMIT; n++) await f.totp({ code: "000000" });
      expect((await f.totp({ code: codeOf(secretFor(ADMIN_B), 1) })).status).toBe(429);                      // the whole sign-in is paused: the right code waits
    });
    it("a restart changes nothing: the whole sign-in's count is saved", async () => {
      const f = fleet();
      for (let n = 0; n < SIGNIN_FLEET_WRONG_LIMIT - 1; n++) await f.totp({ code: "000000" });
      f.restart();
      expect((await f.totp({ code: "000000" })).status).toBe(429);
    });
    it("a guesser who never stops, from fresh browsers, gets about 20 tries a day in the long run (what docs/SECURITY.md's arithmetic uses)", () => {
      let clock = 1_800_000_000_000;
      const dir = mkdtempSync(join(tmpdir(), "agend-155-sim-")); roots.push(dir);
      const keys = [0, 1, 2].map(i => adminKey("a", String(1000 + i)));
      writeFileSync(join(dir, WEB_REMOTE_ACCESS_FILE), JSON.stringify({ v: 1, admins: Object.fromEntries(keys.map(k => [k, { secret: secretFor(k.slice(-4)), enrolledAt: 1, lastStep: 0 }])), outside: false, wrong: 0, level: 0, pausedUntil: 0, handles: [] }));
      const store = new WebRemoteAccess(join(dir, WEB_REMOTE_ACCESS_FILE), { warn: () => {} }, () => clock);
      // The limiter arithmetic is what is measured, not the disk: no write per try (7 400 file writes made this slow on slow disks; persistence has its own tests).
      (store as any).flush = () => true;
      const t0 = clock, end = t0 + 365 * 86_400_000, byDay: Record<number, number> = {};
      let tried = 0, id = 0;
      while (clock < end) {
        const v = store.signInByCode("000000", { key: `b${id++}` }, keys.map(who => ({ who, eligible: true })), []);
        if (v.kind === "paused") { if (v.began.waitMs > 0) tried++; clock += v.retryAfterMs + 1; } else { tried++; clock += 1000; }
        for (const d of [1, 7, 30, 365]) if (!byDay[d] && clock - t0 >= d * 86_400_000) byDay[d] = tried;
      }
      // The figures docs/SECURITY.md's table is built on: 20 at once, then waits of 15 min, 30, 60, 2 h, 4, 8, 16 h, then 24 h. The fake clock makes them exact, so a changed
      // constant or doubling rule fails here instead of quietly making the table wrong.
      expect([byDay[1], byDay[7], byDay[30], tried]).toEqual([140, 260, 720, 7420]);
    });
  });

  describe("what stays, and the compatibility path", () => {
    it("a request that still sends `account` works as before (the name resolves to one admin, the code is that admin's); blank names are code-only", async () => {
      const f = fleet();
      expect((await f.totp({ account: "alice_tg", code: codeOf(secretFor(ADMIN)) })).status).toBe(200);
      expect((await f.totp({ account: "a:200", code: codeOf(secretFor(ADMIN_B)) })).status).toBe(200);
      expect((await f.totp({ account: "", code: codeOf(secretFor(ADMIN_B), 1) })).status).toBe(200);          // blank: the code stands alone
      expect((await f.totp({ account: "  @ ", code: codeOf(secretFor(ADMIN), 1) })).status).toBe(200);
      // a name that is nobody's still gives 401 for a right code (the name is what was asked for)
      expect(summary(await f.totp({ account: "ghost", code: codeOf(secretFor(ADMIN), 2) }))).toEqual(WRONG);
    });
    it("\"Only this computer can authorize\" closes the code-only route: 404 from the network and over a link, nothing counted; this computer's own browser still signs in", async () => {
      const f = fleet({ va: { loopback_only: true } });
      expect((await f.totp({ code: codeOf(secretFor(ADMIN)) }, { where: "lan" })).status).toBe(404);
      f.openLink();
      expect((await f.totp({ code: codeOf(secretFor(ADMIN)) }, { link: "quick" })).status).toBe(404);
      expect((await f.totp({ code: "000000" }, { where: "tailnetServe" })).status).toBe(404);
      expect(saved(f).signin).toBeUndefined();
      expect((await f.totp({ code: codeOf(secretFor(ADMIN)) }, { where: "here" })).status).toBe(200);
    });
    it("a link this fleet does not allow, or the public-link switch off, is a 404 as if the route were not there", async () => {
      const f = fleet();
      expect((await f.totp({ code: codeOf(secretFor(ADMIN)) }, { link: "quick" })).status).toBe(404);          // no link is open
    });
    it("rechecked as the session is made: the app replaced between the code and the session ends it (no admission)", () => {
      const f = fleet();
      const first = f.any.totpSignIn({ exposureId: undefined, peer: "lan", account: undefined, code: codeOf(secretFor(ADMIN)), browser: { id: "b".repeat(32), address: "192.0.2.20" }, knownCookie: undefined });
      expect(first.kind).toBe("ok");
      const b = f.access().beginEnrollment("h", "x", A); f.access().confirmEnrollment("h", codeOf(b.secret, -1));
      const rec = f.any.webSessions.create({ tier: "admin", surface: "local", label: "x", tokenEpoch: tokenEpoch(TOKEN), owner: (first as any).session.owner }).record;
      expect((first as any).commit(rec, "x")).toBe(false);
    });
    it("the success Notice goes to all admins and says who signed in", async () => {
      const f = fleet();
      expect((await f.totp({ code: codeOf(secretFor(ADMIN)) })).status).toBe(200);
      expect(f.feed()).toHaveLength(1);
      expect(f.feed()[0]).toMatch(/signed in from a new browser/);
    });
  });
});
