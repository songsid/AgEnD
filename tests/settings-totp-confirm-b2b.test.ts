/**
 * AGEND-122 (upstream #3486): the authenticator code (#3355, alpha.6 #2c) is now the owner's STRICT mode. By default any role-ok
 * fleet admin on a web cookie session presses Apply now from anywhere (settingsSelfConfirmation, settings-role.ts). Only while
 * `web.verified_authority.remote_confirm_code` is true is a role-ok session that is NOT on this computer (a direct loopback peer)
 * asked for the code instead — on a web-only fleet and on a chat fleet alike. The real FleetManager authority (sessions, the
 * authenticator store, the confirmation store), in a scratch dir:
 *   - who is asked: web-only admin sessions (a sign-in code, the host's own session carried off this computer, the owner signed in
 *     from outside over a link) and, on a chat fleet, a chat account that is still an admin of every connection the change touches
 *     (and the host's own session) — "ready" with an app, "not_set_up" without (fails closed, no Apply now either); never a guest,
 *     a header token, the web authorization switch off, a chat account that stopped being an admin, a link whose option is off;
 *   - who is not: strict mode off (Apply now exists, no code), a page on this computer (nothing asked, whatever the change class),
 *     "Only this computer can authorize" (`host_only`: no code, no Apply now), and a change that opens a link is never code-confirmed
 *     over a link (`on_host` / `not_here`, even with a correct code, and the code is not spent);
 *   - a correct code confirms that one change (audited under its own label), bound to its digest, one use per time step, the
 *     fleet-wide wrong-code limit pauses it; and it is asked again at execution (`current()`): the same session, role and chat
 *     admin, and the same authenticator enrolment — a session signed out, an account demoted, "Only this computer" turned on, an
 *     app replaced or removed and set up again while the change waits leaves it unapplied (stale).
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FleetManager } from "../src/fleet-manager.js";
import { SettingsConfirmationStore } from "../src/settings-confirmation.js";
import { prepareSettingsEffect } from "../src/settings-effect.js";
import { csrfTokenFor, tokenEpoch } from "../src/web-session.js";
import { WEB_CSRF_HEADER } from "../src/web-auth.js";
import { bindGatewayRequest } from "../src/web-request-context.js";
import { base32Encode, base32Decode, hotp, totpStep, TOTP_WRONG_LIMIT, WEB_REMOTE_ACCESS_FILE } from "../src/web-remote-access.js";

const TOKEN = "c".repeat(48);   // a valid web token (hex)
const SECRET = base32Encode(Buffer.from("0123456789abcdefghij"));
const codeAt = (ms: number) => hotp(base32Decode(SECRET)!, totpStep(ms));
const ADMIN = "100";            // a chat account that is an admin of the connection "a" (chat fleets)
const roots: string[] = [], stores: SettingsConfirmationStore[] = [], fleets: any[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
  for (const a of fleets.splice(0)) { a.fm.stormWindow.shutdown(); a.fm.spawnGate.shutdown(); }
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** `strict: false` leaves the option off; `va` adds to `web.verified_authority` (loopback_only, enabled, named_link…); `chat` is a Telegram connection "a" whose admin is ADMIN. */
function fleet(o: { enrolled?: boolean; chat?: boolean; strict?: boolean; va?: Record<string, unknown> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "agend-b2b-")); roots.push(dir);
  if (o.enrolled !== false) writeFileSync(join(dir, WEB_REMOTE_ACCESS_FILE), JSON.stringify({ v: 1, totp: { secret: SECRET, enrolledAt: 1, lastStep: 0 }, outside: false, wrong: 0, level: 0, pausedUntil: 0, handles: [] }), { mode: 0o600 });
  const fm = new FleetManager(dir), any = fm as any;
  fm.fleetConfig = { defaults: { backend: "codex" },
    ...(o.chat ? { channels: [{ id: "a", type: "telegram", mode: "topic", group_id: "-1001", access: { mode: "locked", allowed_users: [ADMIN] } }] } : {}),
    web: { verified_authority: { ...(o.strict === false ? {} : { remote_confirm_code: true }), ...o.va } },
    instances: { general: { working_directory: dir, general_topic: true } } } as any;
  writeFileSync(join(dir, "web.token"), TOKEN, { mode: 0o600 }); any.initializeWebSessions();
  any.outsideLink = () => ({ exposureId: "outside" });   // a web-only fleet whose "connections from outside" opened a link: the owner who signed in over it (remote: "totp") is the fleet's admin there
  const audit = vi.fn();
  const store = new SettingsConfirmationStore({ audit });
  stores.push(store); fleets.push({ fm, any });
  /**
   * A browser session and a request carrying its cookie. Default: an owner-less admin (a sign-in code) on the LAN, i.e. NOT on this
   * computer. `where: "here"` is this computer's own browser (a loopback peer); `link` is a request over the public gateway (a tunnel
   * connects from 127.0.0.1: only the gateway's own context says "over a link") — without an `account` the owner signed in from outside;
   * `account` a chat account (an admin on a chat fleet); `host` the host's own `agend web` session.
   */
  const session = (opts: { tier?: "admin" | "guest"; where?: "lan" | "here"; link?: "named" | "quick"; account?: string; host?: boolean } = {}) => {
    const link = !!opts.link, local = link || opts.where === "here";
    const c = any.webSessions.create({ tier: opts.tier ?? "admin", surface: link ? "gateway" : "local", label: "browser", tokenEpoch: tokenEpoch(TOKEN),
      ...(opts.tier === "guest" ? { owner: { adapterId: "telegram", userId: "42" } } : opts.account ? { owner: { adapterId: "a", userId: opts.account } } : {}),
      ...(opts.host ? { host: true } : {}), ...(link ? { exposureId: "outside" } : {}), ...(link && !opts.account ? { remote: "totp" } : {}) });
    const host = local ? "127.0.0.1:19280" : "192.168.1.5:19280";
    const req: any = { method: "POST", socket: { remoteAddress: local ? "127.0.0.1" : "192.168.1.20" },
      headers: { host, origin: `http://${host}`, "sec-fetch-site": "same-origin", cookie: `${link ? "__Host-agend_session" : "agend_session"}=${c.sessionId}`, [WEB_CSRF_HEADER]: csrfTokenFor(c.sessionId) } };
    if (link) bindGatewayRequest(req, { surface: "gateway", exposureId: "outside", expectedOrigin: `http://${host}`, isCurrent: () => true, named: opts.link === "named" } as any);
    return { req, record: c.record, sessionId: c.sessionId };
  };
  let holdUnchanged = false;
  const propose = (path = "/api/settings/hub/membership", body: unknown = { enabled: true }, extra: Record<string, unknown> = { hubMembership: () => ({ enabled: false }) }, authority?: { connections: string[]; primaryGeneral: boolean; unknown: boolean }) => {
    const effect = prepareSettingsEffect(path.startsWith("/api/settings/hub/") && !path.endsWith("/apply") ? "PUT" : "POST", path, body, { config: fm.fleetConfig, classic: {}, ...extra } as any);
    const apply = vi.fn(async (_c: () => boolean, execution: any) => execution.commit(() => "applied"));
    let release!: () => void; const held = new Promise<boolean>((r) => { release = () => r(true); });
    const view = store.propose({ session: "browser", key: `k${Math.random()}`, bytes: 1, source: "web_session", section: effect.diff!.section, requestedBy: "browser",
      fingerprint: effect.diff!.fingerprint, summary: effect.diff!.summary, affectedConnections: effect.diff!.affectedConnections, authority: authority ?? effect.diff!.authority,
      ...(effect.diff!.opensLink ? { opensLink: true as const } : {}),   // as the gate passes it: the only marker left on a proposal
      current: () => true, unchanged: async () => (holdUnchanged ? held : true), snapshot: () => null, apply }).view;
    return { view, apply, release };
  };
  /** The change that turns the named (or the quick) link on — the one marker a proposal still has: `opensLink` — and an outward Hub change (a class that used to be host-only). */
  const linkOn = (option: "named_link" | "quick_link" = "named_link") => propose("/api/settings/fleet/web", { verified_authority: { [option]: true } }, {});
  const hubConnect = (code = "ABCD-EFGH") => propose("/api/hub/member/pairing/connect", { address: "https://hub.example.test", code }, { hubPairing: () => ({ summary: ["Connect to the Hub at https://hub.example.test"] }) });
  /** What this request is told for that change: the code's state, and Apply now's label (null: none). */
  const asked = (s: { req: any }, id: string) => [any.settingsTotpState(store, s.req, id), any.settingsSelfConfirmation(store, s.req, id)?.label ?? null];
  const confirm = (s: { req: any }, id: string, code = codeAt(Date.now())) => any.settingsTotpConfirm(store, s.req, id, code, store.confirmDigest(id));
  return { fm, any, store, audit, session, propose, linkOn, hubConnect, asked, confirm, hold: () => { holdUnchanged = true; } };
}

describe("who is asked for the code (remote_confirm_code on, a page that is not on this computer)", () => {
  it("a web-only fleet's admin session (a sign-in code) from the LAN, app set up: the code, no Apply now", () => {
    const f = fleet(), s = f.session(), p = f.propose();
    expect(f.asked(s, p.view.id)).toEqual(["ready", null]);
  });
  it("no app set up: not_set_up — no Apply now either, and a code cannot be checked (fails closed, never open)", () => {
    const f = fleet({ enrolled: false }), s = f.session(), p = f.propose();
    expect(f.asked(s, p.view.id)).toEqual(["not_set_up", null]);
    expect(f.confirm(s, p.view.id)).toEqual({ error: "not_here" });
  });
  it("the host's own session carried to another device: the code too (it is not on this computer any more)", () => {
    const f = fleet(), s = f.session({ host: true }), p = f.propose();
    expect(f.asked(s, p.view.id)).toEqual(["ready", null]);
  });
  it("a chat fleet's account session that is an admin of its connection, from the LAN: the code (new: chat fleets too)", () => {
    const f = fleet({ chat: true }), s = f.session({ account: ADMIN }), p = f.propose();
    expect(f.asked(s, p.view.id)).toEqual(["ready", null]);
  });
  it("a chat fleet's account that is no longer an admin: nothing (no code, no Apply now), and a correct code is refused", () => {
    const f = fleet({ chat: true }), s = f.session({ account: "999" }), p = f.propose();
    expect(f.asked(s, p.view.id)).toEqual([null, null]);
    expect(f.confirm(s, p.view.id)).toEqual({ error: "not_here" });
  });
  it("a chat account must be an admin of EVERY connection the change touches: one it does not administer → nothing", () => {
    const f = fleet({ chat: true }), s = f.session({ account: ADMIN });
    const own = f.propose("/api/settings/hub/membership", { enabled: true }, undefined, { connections: ["a"], primaryGeneral: false, unknown: false });
    const other = f.propose("/api/settings/hub/retention", { contentDays: 14, eventDays: 60, revision: 1 }, {}, { connections: ["a", "b"], primaryGeneral: false, unknown: false });
    expect([f.asked(s, own.view.id), f.asked(s, other.view.id), f.confirm(s, other.view.id)]).toEqual([["ready", null], [null, null], { error: "not_here" }]);
  });
  it("a chat fleet's owner-less session is the fleet's admin only when it is the host's own: another gets nothing", () => {
    const f = fleet({ chat: true }), p = f.propose();
    expect([f.asked(f.session(), p.view.id), f.asked(f.session({ host: true }), p.view.id)]).toEqual([[null, null], ["ready", null]]);
  });
  it.each([["named" as const], ["quick" as const]])("over the %s link, the owner signed in from outside (web-only fleet): the code for an ordinary change — the code path itself no longer refuses a link", (link) => {
    const f = fleet(), s = f.session({ link }), p = f.propose();
    expect(f.asked(s, p.view.id)).toEqual(["ready", null]);
    expect(f.confirm(s, p.view.id)).toMatchObject({ label: "Authenticator code" });
  });
  it("a chat account over the named link: the code while that link's option is on; nothing while it is off", () => {
    const on = fleet({ chat: true, va: { named_link: true } }), off = fleet({ chat: true });
    expect([on, off].map(f => f.asked(f.session({ account: ADMIN, link: "named" }), f.propose().view.id))).toEqual([["ready", null], [null, null]]);
  });
  it("a web-only fleet's gateway session that did not sign in from outside, a guest, a header token or the web authorization switch off: never", () => {
    const f = fleet(), p = f.propose(), off = fleet({ va: { enabled: false } });
    const plainLink = f.any.webSessions.create({ tier: "admin", surface: "gateway", label: "phone", tokenEpoch: tokenEpoch(TOKEN), exposureId: "outside" });   // no remote: "totp"
    const linkReq: any = { method: "POST", socket: { remoteAddress: "127.0.0.1" }, headers: { host: "127.0.0.1:19280", origin: "http://127.0.0.1:19280", "sec-fetch-site": "same-origin", cookie: `__Host-agend_session=${plainLink.sessionId}`, [WEB_CSRF_HEADER]: csrfTokenFor(plainLink.sessionId) } };
    bindGatewayRequest(linkReq, { surface: "gateway", exposureId: "outside", expectedOrigin: "http://127.0.0.1:19280", isCurrent: () => true } as any);
    const lan = f.session(), headerToken = { ...lan.req, headers: { host: lan.req.headers.host, authorization: `Bearer ${TOKEN}` } };
    expect([f.asked({ req: linkReq }, p.view.id), f.asked(f.session({ tier: "guest" }), p.view.id), f.asked({ req: headerToken }, p.view.id), off.asked(off.session(), off.propose().view.id)])
      .toEqual([[null, null], [null, null], [null, null], [null, null]]);
    expect(f.confirm({ req: headerToken }, p.view.id)).toEqual({ error: "not_here" });
    expect(f.confirm(f.session({ tier: "guest" }), p.view.id)).toEqual({ error: "not_here" });
  });
});

describe("who is NOT asked for it", () => {
  it("strict mode off (the default): no code is offered, Apply now exists for the same LAN admin — and a code is refused", () => {
    const f = fleet({ strict: false }), s = f.session(), p = f.propose();
    expect(f.asked(s, p.view.id)).toEqual([null, "This fleet's admin"]);
    expect(f.confirm(s, p.view.id)).toEqual({ error: "not_here" });
  });
  it("strict mode off, a chat account: Apply now (its own label), no code", () => {
    const f = fleet({ chat: true, strict: false }), s = f.session({ account: ADMIN }), p = f.propose();
    const [state, label] = f.asked(s, p.view.id);
    expect([state, String(label).endsWith("(web-verified)")]).toEqual([null, true]);
  });
  it("on this computer's own browser: nothing is asked — Apply now, every change class (an outward Hub change too), and a code is not what confirms it", () => {
    const f = fleet(), s = f.session({ where: "here" });
    for (const p of [f.propose(), f.hubConnect(), f.linkOn()]) {
      expect(f.asked(s, p.view.id)).toEqual([null, "This fleet's admin"]);
      expect(f.confirm(s, p.view.id)).toEqual({ error: "not_here" });
    }
    const chat = fleet({ chat: true }), account = chat.session({ account: ADMIN, where: "here" }), q = chat.propose();
    expect([chat.asked(account, q.view.id)[0], chat.confirm(account, q.view.id)]).toEqual([null, { error: "not_here" }]);
    expect(chat.any.settingsSelfConfirmation(chat.store, account.req, q.view.id)).not.toBeNull();
  });
  it("a loopback-looking request that is not this computer's (a proxy's forwarding header, a public Host): no Apply now, the code instead — whatever the change class", () => {
    const f = fleet(), p = f.hubConnect(), s = f.session({ where: "here", host: true });
    expect(f.asked(s, p.view.id)).toEqual([null, "This fleet's admin"]);
    const forwarded = { req: { ...s.req, headers: { ...s.req.headers, "x-forwarded-for": "203.0.113.9" } } };
    const publicHost = { req: { ...s.req, headers: { ...s.req.headers, host: "fleet.example.com", origin: "https://fleet.example.com" } } };
    for (const replay of [forwarded, publicHost]) {
      expect(f.asked(replay, p.view.id)).toEqual(["ready", null]);
      expect(f.any.settingsPageIsRemote(replay.req)).toBe(true);
    }
    expect(f.any.settingsPageIsRemote(s.req)).toBe(false);
    // …and Apply now's own confirmation is asked again at execution from the same request.
    expect(f.any.settingsSelfConfirmation(f.store, s.req, p.view.id).current()).toBe(true);
  });
  it("\"Only this computer can authorize\": from the LAN no code and no Apply now (host_only); this computer's own browser still confirms with Apply now", () => {
    const f = fleet({ va: { loopback_only: true } }), lan = f.session(), here = f.session({ where: "here" }), p = f.propose();
    expect(f.asked(lan, p.view.id)).toEqual(["host_only", null]);
    expect(f.confirm(lan, p.view.id, codeAt(Date.now()))).toEqual({ error: "not_here" });
    expect(f.asked(here, p.view.id)).toEqual([null, "This fleet's admin"]);
    const chat = fleet({ chat: true, va: { loopback_only: true } });
    expect(chat.asked(chat.session({ account: ADMIN }), chat.propose().view.id)).toEqual(["host_only", null]);
  });
});

describe("confirming with the code", () => {
  it("a correct code confirms that one change: applied once, audited under its own label", async () => {
    const f = fleet(), s = f.session(), p = f.propose();
    const r = f.confirm(s, p.view.id);
    expect(r.label).toBe("Authenticator code");
    await f.store.decide(p.view.id, "confirm", { ...r, via: "web" });
    expect([p.apply.mock.calls.length, f.store.get(p.view.id, "browser")!.state]).toEqual([1, "applied"]);
    // #3352 security review, point 4: the confirmer is the code, not the session's user; what it confirmed is in the record.
    expect(f.audit.mock.calls.find(([event]: any[]) => event === "confirmed")?.[1]).toMatchObject({ decided_by: "Authenticator code", confirmed_with: "authenticator_code", summary: p.view.summary });
  });
  it("a chat account's session confirms with the code too (AGEND-122), applied once, audited under the code's label", async () => {
    const f = fleet({ chat: true }), s = f.session({ account: ADMIN }), p = f.propose();
    const r = f.confirm(s, p.view.id);
    expect(r.label).toBe("Authenticator code");
    await f.store.decide(p.view.id, "confirm", { ...r, via: "web" });
    expect([p.apply.mock.calls.length, f.store.get(p.view.id, "browser")!.state]).toEqual([1, "applied"]);
    expect(f.audit.mock.calls.find(([event]: any[]) => event === "confirmed")?.[1]).toMatchObject({ decided_by: "Authenticator code", confirmed_with: "authenticator_code" });
  });
  it("the same code (time step) is accepted once: a second change cannot reuse it", () => {
    const f = fleet(), s = f.session(), a = f.propose(), b = f.propose("/api/settings/hub/retention", { contentDays: 14, eventDays: 60, revision: 1 }, {});
    const code = codeAt(Date.now());
    expect("label" in f.confirm(s, a.view.id, code)).toBe(true);
    expect(f.confirm(s, b.view.id, code)).toEqual({ error: "wrong" });
  });
  it("wrong codes are refused, and the fleet-wide limit pauses the code (no confirmation while paused)", () => {
    const f = fleet(), s = f.session(), p = f.propose();
    for (let i = 1; i < TOTP_WRONG_LIMIT; i++) expect(f.confirm(s, p.view.id, "000000")).toEqual({ error: "wrong" });
    expect(f.confirm(s, p.view.id, "000000")).toMatchObject({ error: "paused" });
    expect(f.confirm(s, p.view.id, codeAt(Date.now()))).toMatchObject({ error: "paused" });
    expect(f.store.get(p.view.id, "browser")!.state).toBe("pending");
  });
  it("asked again at execution: a session signed out before the change runs leaves it unapplied", async () => {
    const f = fleet(); f.hold();
    const s = f.session(), p = f.propose();
    const decided = f.store.decide(p.view.id, "confirm", { ...f.confirm(s, p.view.id), via: "web" });
    f.any.webSessions.revokeById(s.sessionId);
    p.release(); await decided;
    expect([p.apply.mock.calls.length, f.store.get(p.view.id, "browser")!.state]).toEqual([0, "stale"]);
  });
  it("asked again at execution: a chat account demoted from admin while the change waits leaves it unapplied (and an admin who stays still applies it)", async () => {
    const run = async (demote: boolean) => {
      const f = fleet({ chat: true }); f.hold();
      const s = f.session({ account: ADMIN }), p = f.propose();
      const decided = f.store.decide(p.view.id, "confirm", { ...f.confirm(s, p.view.id), via: "web" });
      if (demote) f.fm.fleetConfig!.channels![0]!.access!.allowed_users = [];
      p.release(); await decided;
      return [p.apply.mock.calls.length, f.store.get(p.view.id, "browser")!.state];
    };
    expect([await run(false), await run(true)]).toEqual([[1, "applied"], [0, "stale"]]);
  });
  it("asked again at execution: \"Only this computer can authorize\" turned on while the change waits leaves it unapplied", async () => {
    const f = fleet(); f.hold();
    const s = f.session(), p = f.propose();
    const r = f.confirm(s, p.view.id);
    expect(r.current()).toBe(true);
    const decided = f.store.decide(p.view.id, "confirm", { ...r, via: "web" });
    f.fm.fleetConfig!.web!.verified_authority!.loopback_only = true;
    p.release(); await decided;
    expect([p.apply.mock.calls.length, f.store.get(p.view.id, "browser")!.state]).toEqual([0, "stale"]);
  });
  it("a remote confirmation of a change that opens a link posts a Notice (a code confirmation from the LAN); an ordinary change posts none", () => {
    for (const [change, kind] of [["link", "link"], ["ordinary", null]] as const) {
      const f = fleet(), s = f.session(), p = change === "link" ? f.linkOn() : f.propose();
      const notice = vi.spyOn(f.any, "postSettingsRemoteNotice").mockImplementation(() => {});
      const r = f.confirm(s, p.view.id);
      r.done(f.store.get(p.view.id, "browser")!);
      expect(notice.mock.calls.map(c => c[1])).toEqual(kind ? [kind] : []);
    }
  });
});

describe("#3355 review (Prism P2): the code's authority is the app it came from, through execution", () => {
  const confirmHeld = (f: ReturnType<typeof fleet>) => {
    const s = f.session(), p = f.propose();
    const r = f.confirm(s, p.view.id);
    expect(r.label).toBe("Authenticator code");
    return { p, r, decided: f.store.decide(p.view.id, "confirm", { ...r, via: "web" }) };
  };
  /** Set up another app the way Access & security does: begin, then its first code. */
  const reenroll = (f: ReturnType<typeof fleet>) => {
    const access = f.any.webRemoteAccess(), handle = "a".repeat(16);
    const { secret } = access.beginEnrollment(handle, "owner");
    expect(access.confirmEnrollment(handle, hotp(base32Decode(secret)!, totpStep(Date.now())))).toBe("ok");
  };
  it("control: the same app still set up when the change runs — applied", async () => {
    const f = fleet(); f.hold();
    const { p, decided } = confirmHeld(f);
    p.release(); await decided;
    expect([p.apply.mock.calls.length, f.store.get(p.view.id, "browser")!.state]).toEqual([1, "applied"]);
  });
  it("the app replaced while the change waits: not applied (stale)", async () => {
    const f = fleet(); f.hold();
    const { p, decided } = confirmHeld(f);
    reenroll(f);
    p.release(); await decided;
    expect([p.apply.mock.calls.length, f.store.get(p.view.id, "browser")!.state]).toEqual([0, "stale"]);
  });
  it("the app removed and another set up while the change waits: not applied (stale)", async () => {
    const f = fleet(); f.hold();
    const { p, decided } = confirmHeld(f);
    expect(f.any.webRemoteAccess().remove()).toBe(true);
    reenroll(f);
    p.release(); await decided;
    expect([p.apply.mock.calls.length, f.store.get(p.view.id, "browser")!.state]).toEqual([0, "stale"]);
  });
  it("ended for good: the very same app back afterwards does not revive it", () => {
    const f = fleet(), s = f.session(), p = f.propose();
    const r = f.confirm(s, p.view.id);
    expect(r.current()).toBe(true);
    const access = f.any.webRemoteAccess(), saved = access.enrollment;
    expect(access.remove()).toBe(true);
    expect(r.current()).toBe(false);
    // The original file back, read again: the same enrollment as the code came from.
    writeFileSync(join(f.fm.dataDir, WEB_REMOTE_ACCESS_FILE), JSON.stringify({ v: 1, totp: { secret: SECRET, enrolledAt: 1, lastStep: 0 }, outside: false, wrong: 0, level: 0, pausedUntil: 0, handles: [] }), { mode: 0o600 });
    f.any.webRemoteAccessState = null;
    expect(f.any.webRemoteAccess().enrollment).toBe(saved);
    expect(r.current()).toBe(false);
  });
  it("the enrollment id: null with no app, another for another app, never the secret", () => {
    const f = fleet(), access = f.any.webRemoteAccess(), first = access.enrollment;
    expect(first).toMatch(/^[0-9a-f]{32}$/);
    expect(first).not.toContain(SECRET.toLowerCase());
    reenroll(f);
    expect(access.enrollment).not.toBe(first);
    access.remove();
    expect(access.enrollment).toBeNull();
  });
});

describe("#3352 security review: binding, shared budget, and the link rule", () => {
  it("point 2: a code is bound to the change the page showed — a different change's digest is refused before the code is used", () => {
    const f = fleet(), s = f.session(), a = f.propose(), b = f.propose("/api/settings/hub/retention", { contentDays: 14, eventDays: 60, revision: 1 }, {});
    const code = codeAt(Date.now());
    expect(f.any.settingsTotpConfirm(f.store, s.req, a.view.id, code, f.store.confirmDigest(b.view.id))).toEqual({ error: "changed" });
    expect("label" in f.any.settingsTotpConfirm(f.store, s.req, a.view.id, code, f.store.confirmDigest(a.view.id)), "the code was not spent by the refusal").toBe(true);
  });
  it("point 3: one step per window across both paths — a code that signed in from outside cannot also confirm a change", () => {
    const f = fleet(), s = f.session(), p = f.propose(), code = codeAt(Date.now());
    expect(f.any.webRemoteAccess().verify(code).kind).toBe("ok");
    expect(f.confirm(s, p.view.id, code)).toEqual({ error: "wrong" });
  });
  it.each([["named" as const], ["quick" as const]])("never over a link: a change that opens a link, over the %s link — on_host and refused with a correct code, the code unspent; the same change from the LAN is code-confirmable", (link) => {
    const f = fleet(), p = f.linkOn(), over = f.session({ link });
    expect(f.any.settingsTotpState(f.store, over.req, p.view.id)).toBe("on_host");
    expect(f.confirm(over, p.view.id)).toEqual({ error: "not_here" });
    expect(f.asked(over, p.view.id)[1], "and no Apply now either: the strict option sends a link's request to the code").toBeNull();
    // The refusal is before the code: the same code still confirms it from a page that is not over a link.
    expect(f.confirm(f.session(), p.view.id)).toMatchObject({ label: "Authenticator code" });
  });
  it("never over a link, a chat account too: its change that opens the quick link, over the named link (its option on), is on_host / not_here", () => {
    const f = fleet({ chat: true, va: { named_link: true, quick_link: false } }), p = f.linkOn("quick_link"), over = f.session({ account: ADMIN, link: "named" });
    expect([f.any.settingsTotpState(f.store, over.req, p.view.id), f.confirm(over, p.view.id)]).toEqual(["on_host", { error: "not_here" }]);
    expect(f.confirm(f.session({ account: ADMIN }), p.view.id)).toMatchObject({ label: "Authenticator code" });
  });
  it("an outward Hub change is no longer special: from the LAN the same code confirms it (it used to be Apply-now-only for the host's session, and no code for anyone else)", () => {
    const f = fleet(), p = f.hubConnect(), s = f.session();
    expect([f.asked(s, p.view.id), f.confirm(s, p.view.id)]).toMatchObject([["ready", null], { label: "Authenticator code" }]);
  });
});


// D3 / B2b: the one shared helper (agreed with dev-claude), as a table.
describe("hostSessionHere (src/authority/web-authority.ts)", async () => {
  const { hostSessionHere } = await import("../src/authority/web-authority.js");
  const host = { host: true as const, tier: "admin" as const, surface: "local" as const };
  const local = { socket: { remoteAddress: "127.0.0.1" }, headers: { host: "127.0.0.1:19280" } };
  const linked = () => { const r: any = { socket: { remoteAddress: "127.0.0.1" }, headers: { host: "127.0.0.1:19280" } }; bindGatewayRequest(r, { surface: "gateway", exposureId: "x", expectedOrigin: "https://x.example", isCurrent: () => true }); return r; };
  it.each([
    ["the host session, over loopback", host, local, true],
    ["forwarded (a proxy in front)", host, { ...local, headers: { ...local.headers, "x-forwarded-for": "203.0.113.9" } }, false],
    ["a public Host", host, { ...local, headers: { host: "fleet.example.com" } }, false],
    ["a tunnel from 127.0.0.1 (gateway context)", host, null, false],
    ["from the LAN", host, { socket: { remoteAddress: "192.168.1.20" }, headers: { host: "192.168.1.5:19280" } }, false],
    ["a non-host session over loopback", { tier: "admin" as const, surface: "local" as const }, local, false],
    ["a guest", { ...host, tier: "guest" as const }, local, false],
    ["a session with a chat account", { ...host, owner: { adapterId: "telegram", userId: "1" } }, local, false],
    ["no session (bare loopback)", null, local, false],
  ] as Array<[string, any, any, boolean]>)("%s → %s", (_n, session, req, want) => {
    expect(hostSessionHere(session, req ?? linked())).toBe(want);
  });
});
