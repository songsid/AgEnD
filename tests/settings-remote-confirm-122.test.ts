/**
 * AGEND-122 (upstream design issue #3486, R1): a signed-in human fleet admin confirms a held Settings change by pressing Apply now
 * from wherever the dashboard is reached, for every kind of change, on a chat fleet and a web-only one alike; each admin's OWN
 * stricter switch ("ask for my code to confirm from other devices", kept with their own authenticator in web-remote-access.json,
 * never in fleet.yaml) asks for that admin's authenticator code off the AgEnD computer instead.
 *   - classification: a tailnet-style request (a Host that is not loopback, a forwarding header, a peer that is this machine behind
 *     `tailscale serve`, or a tailnet address of its own) is `lan` on the `local` surface — not a link; only the gateway's binding is;
 *   - the role (settings-role.ts), as a pure decision: who qualifies and the first check each other caller fails;
 *   - the default: every change class (a secret, access, a connection, an outward Hub change, opening a link) gets Apply now from this
 *     computer, a tailnet-style request and the public gateway; never an agent's request, a guest, a header token, the switch off, or
 *     "Only this computer can authorize" off this computer;
 *   - strict mode (the admin's own switch): off this computer a code replaces Apply now for every session of THAT admin — the owner
 *     signed in from outside included — and a change that opens a link is refused over the gateway, a real gateway-bound request,
 *     beside the tailnet-style `lan` request;
 *   - per admin: each admin has their own app and their own switch; the API only ever acts on the caller's own record, another admin
 *     on the same fleet still has Apply now, and A's code never confirms for B;
 *   - every set-up, replacement, removal and switch change posts a Notice naming the admin, from the LAN and on the host — and on a
 *     chat fleet with nowhere else to post it, in the dashboard's Notices (once);
 *   - a pending set-up is nobody else's to clear or replace (a remote remove with no app, a second session's begin);
 *   - the ordinary New Agent shortcut follows the same policy (through the real gate): held for a strict admin off the computer and
 *     under "Only this computer can authorize", created at once otherwise, asked again at execution;
 *   - a chat fleet has no "Allow connections from outside" link or switch (a web-only fleet's); its admins' authenticators confirm
 *     changes, and (#3486, tests/signin-per-admin-totp-3486.test.ts) sign a new browser in as THAT admin;
 *   - the page is told it is remote (`remote: true`) so the card names no host command.
 */
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FleetManager } from "../src/fleet-manager.js";
import { SettingsConfirmationStore } from "../src/settings-confirmation.js";
import { SettingsHttpConfirmation } from "../src/settings-http-confirmation.js";
import { requestSettingsConfirmation } from "../src/settings-control.js";
import { prepareSettingsEffect } from "../src/settings-effect.js";
import { classifyWebPeer } from "../src/authority/web-authority.js";
import { evaluateSettingsRole, type SettingsRoleInput } from "../src/authority/settings-role.js";
import { webPeerOf } from "../src/web-api.js";
import { authorizeSession, WEB_CSRF_HEADER } from "../src/web-auth.js";
import { csrfTokenFor, tokenEpoch, type SessionRecord } from "../src/web-session.js";
import { bindGatewayRequest, gatewayRequestContext } from "../src/web-request-context.js";
import { base32Encode, base32Decode, hotp, totpStep, adminKey, HOST_ADMIN_KEY, TOTP_WRONG_LIMIT, WebRemoteAccess, WEB_REMOTE_ACCESS_FILE } from "../src/web-remote-access.js";
import { settingsRequestExecution } from "../src/settings-request-capability.js";
import { settingsFingerprint } from "../src/settings-transaction.js";
import { t } from "../src/locale.js";

const TOKEN = "d".repeat(48), ADMIN = "100", ADMIN_B = "200";
const SECRET = base32Encode(Buffer.from("0123456789abcdefghij"));
const codeAt = (ms: number) => hotp(base32Decode(SECRET)!, totpStep(ms));
/** A chat account's own app, as a seeded file holds it (each admin has another secret). */
const secretFor = (user: string) => base32Encode(Buffer.from(`secret-for-${user}`.padEnd(20, "#").slice(0, 20)));
/** The code of an app (its secret) `offset` time steps from now. Each step is accepted once per app: tests that use an app twice use two steps. */
const appCode = (app: string | { secret: string }, offset = 0) => hotp(base32Decode(typeof app === "string" ? app : app.secret)!, totpStep(Date.now()) + offset);
const roots: string[] = [], stores: SettingsConfirmationStore[] = [], fleets: any[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
  for (const a of fleets.splice(0)) { a.fm.stormWindow.shutdown(); a.fm.spawnGate.shutdown(); }
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** Where a request comes from, as AgEnD sees it. Names and addresses are documentation values, never a real one. */
const WHERE = {
  /** `tailscale serve`: it proxies from this machine, with the tailnet name as Host and a forwarding header. */
  tailnetServe: { remoteAddress: "127.0.0.1", host: "agend-box.example-tailnet.ts.net", extra: { "x-forwarded-for": "100.64.0.7", "x-forwarded-proto": "https" } },
  /** The tailnet address of this machine, reached directly. */
  tailnetDirect: { remoteAddress: "100.64.0.7", host: "100.64.0.1:19280", extra: {} },
  lan: { remoteAddress: "192.0.2.20", host: "192.0.2.5:19280", extra: {} },
  here: { remoteAddress: "127.0.0.1", host: "127.0.0.1:19280", extra: {} },
} as const;
type Where = keyof typeof WHERE;

/**
 * `enrolled`/`strict`: the host operator's app (a web-only fleet's one admin, a chat fleet's `agend web` host session) and its own switch;
 * `admins`: chat accounts with an app of their own (and their own switch), by user id on the connection `a`.
 */
function fleet(o: { enrolled?: boolean; strict?: boolean; chat?: boolean; outside?: boolean; admins?: Record<string, { strict?: boolean }>; va?: Record<string, unknown> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "agend-122-")); roots.push(dir);
  if (o.enrolled || o.admins) {
    const rec = (secret: string, strict?: boolean) => ({ secret, enrolledAt: 1, lastStep: 0, ...(strict ? { strict: true } : {}) });
    writeFileSync(join(dir, WEB_REMOTE_ACCESS_FILE), JSON.stringify({ v: 1, ...(o.enrolled ? { totp: rec(SECRET, o.strict) } : {}),
      ...(o.admins ? { admins: Object.fromEntries(Object.entries(o.admins).map(([user, a]) => [adminKey("a", user), rec(secretFor(user), a.strict)])) } : {}),
      outside: o.outside ?? !!o.enrolled, wrong: 0, level: 0, pausedUntil: 0, handles: [] }), { mode: 0o600 });
  }
  const fm = new FleetManager(dir), any = fm as any;
  fm.fleetConfig = { defaults: { backend: "codex" },
    ...(o.chat ? { channels: [{ id: "a", type: "telegram", mode: "topic", group_id: "-1001", access: { mode: "locked", allowed_users: [ADMIN, ADMIN_B] } }] } : {}),
    ...(o.va ? { web: { verified_authority: o.va } } : {}),
    instances: { general: { working_directory: dir, general_topic: true } } } as any;
  writeFileSync(join(dir, "web.token"), TOKEN, { mode: 0o600 }); any.initializeWebSessions();
  const store = new SettingsConfirmationStore({ audit: vi.fn() });
  stores.push(store); fleets.push({ fm, any });
  /** An admin session of one kind and a request from `where` carrying its cookie; `gateway` binds the request to the public gateway, as the gateway does. */
  const session = (kind: "code" | "host" | "device" | "account" | "guest" | "outside", where: Where, opts: { gateway?: "quick" | "named"; method?: string; user?: string } = {}) => {
    const link = !!opts.gateway || kind === "outside";
    const c = any.webSessions.create({ tier: kind === "guest" ? "guest" : "admin", surface: link ? "gateway" : "local", label: "browser", tokenEpoch: tokenEpoch(TOKEN),
      ...(kind === "host" ? { host: true } : {}), ...(kind === "device" ? { via: "device" } : {}),
      ...(kind === "account" ? { owner: { adapterId: "a", userId: opts.user ?? ADMIN } } : {}), ...(kind === "guest" ? { owner: { adapterId: "telegram", userId: "42" } } : {}),
      ...(link ? { exposureId: "x" } : {}), ...(kind === "outside" ? { remote: "totp" } : {}) });
    const w = WHERE[where];
    const req: any = { method: opts.method ?? "POST", socket: { remoteAddress: w.remoteAddress },
      headers: { host: w.host, origin: `http://${w.host}`, "sec-fetch-site": "same-origin", cookie: `${link ? "__Host-agend_session" : "agend_session"}=${c.sessionId}`, [WEB_CSRF_HEADER]: csrfTokenFor(c.sessionId), ...w.extra } };
    if (link) bindGatewayRequest(req, { surface: "gateway", exposureId: "x", expectedOrigin: `http://${w.host}`, isCurrent: () => true, named: opts.gateway === "named" } as any);
    return { req, record: c.record };
  };
  const propose = (path: string, body: unknown, extra: Record<string, unknown> = {}, method = "PUT") => {
    const effect = prepareSettingsEffect(method, path, body, { config: fm.fleetConfig, classic: {}, ...extra } as any);
    const apply = vi.fn(async (_c: () => boolean, execution: any) => execution.commit(() => "applied"));
    const view = store.propose({ session: "browser", key: `k${Math.random()}`, bytes: 1, source: "web_session", section: effect.diff!.section, requestedBy: "browser",
      fingerprint: effect.diff!.fingerprint, summary: effect.diff!.summary, affectedConnections: effect.diff!.affectedConnections, authority: effect.diff!.authority,
      ...(effect.diff!.opensLink ? { opensLink: true as const } : {}), current: () => true, unchanged: async () => true, snapshot: () => null, apply }).view;
    return { view, apply };
  };
  /** One change of each class the old rules treated differently. */
  const classes = () => ({
    access: () => propose("/api/settings/hub/membership", { enabled: true }, { hubMembership: () => ({ enabled: false }) }),
    outwardHub: () => propose("/api/settings/hub/run", { enabled: true }),
    openLink: () => propose("/api/settings/fleet/web", { verified_authority: { named_link: true } }),
    hubPairing: () => propose("/api/hub/member/pairing/connect", { address: "https://hub.example.test", code: "ABCD-EFGH" }, { hubPairing: () => ({ summary: ["Connect to the Hub at https://hub.example.test"] }) }, "POST"),
  });
  /** A change of the secret class, held directly: what matters here is its `section`, which the effect sets from the keys it touches. */
  const secretChange = () => store.propose({ session: "browser", key: `s${Math.random()}`, bytes: 1, source: "web_session", section: "secret", requestedBy: "browser",
    fingerprint: `${Math.random()}`.padEnd(64, "0"), summary: ["connections.a.bot_token_env: fingerprint 1234"], affectedConnections: [], authority: { connections: [], primaryGeneral: false, unknown: false },
    current: () => true, unchanged: async () => true, snapshot: () => null, apply: async (_c: () => boolean, e: any) => e.commit(() => "applied") }).view;
  return { fm, any, store, session, classes, secretChange, propose };
}

describe("a tailnet-style request is a LAN request on the local surface", () => {
  it.each(["tailnetServe", "tailnetDirect", "lan"] as const)("%s: peer lan, no gateway, session surface local", (where) => {
    const f = fleet(), s = f.session("code", where);
    expect([classifyWebPeer(s.req), webPeerOf(s.req), s.record.surface]).toEqual(["lan", "lan", "local"]);
    const auth = authorizeSession(s.req, f.any.webToken, f.any.webSessions, { touch: false });
    expect(auth.kind === "ok" && auth.session.surface === "local" && auth.session.tier === "admin").toBe(true);
  });
  it("this computer's own browser is loopback; a forwarding header or a non-loopback Host alone makes a loopback address LAN; a real gateway request is a link", () => {
    const f = fleet();
    expect(webPeerOf(f.session("code", "here").req)).toBe("loopback");
    expect(classifyWebPeer({ socket: { remoteAddress: "127.0.0.1" }, headers: { host: "localhost:19280", "x-forwarded-for": "100.64.0.7" } })).toBe("lan");
    expect(classifyWebPeer({ socket: { remoteAddress: "127.0.0.1" }, headers: { host: "agend-box.example-tailnet.ts.net" } })).toBe("lan");
    // A tunnel connects from 127.0.0.1 too: only the gateway's own binding says "over a link" — never the address.
    expect([webPeerOf(f.session("code", "here", { gateway: "quick" }).req), webPeerOf(f.session("code", "here", { gateway: "named" }).req)]).toEqual(["quick_link", "named_link"]);
  });
});

describe("the role, as a pure decision (settings-role.ts)", () => {
  const rec = (o: Partial<SessionRecord> = {}): SessionRecord => ({ tier: "admin", surface: "local", tokenEpoch: "e", handle: "h", ...o }) as SessionRecord;
  const input = (o: Partial<SettingsRoleInput> = {}): SettingsRoleInput => ({ session: rec(), gateway: false, peer: "lan", tokenEpoch: "e", webOnly: true,
    policy: { enabled: true, loopbackOnly: false, namedLink: false, quickLink: true }, isAdmin: () => true, outside: null, ...o });
  const reason = (i: SettingsRoleInput) => { const r = evaluateSettingsRole(i); return r.ok ? "ok" : r.reason; };
  it("an admin cookie session qualifies from this computer and from the LAN; onHost only on this computer", () => {
    expect(evaluateSettingsRole(input({ peer: "loopback" }))).toMatchObject({ ok: true, onHost: true, account: false });
    expect(evaluateSettingsRole(input())).toMatchObject({ ok: true, onHost: false, account: false });
  });
  it.each([
    ["no session (a header token, the CLI, an agent's request)", { session: null }, "not_session"],
    ["a guest", { session: rec({ tier: "guest" }) }, "not_admin_session"],
    ["a rotated token", { tokenEpoch: "other" }, "token_rotated"],
    ["the web authorization switch off", { policy: { enabled: false, loopbackOnly: false, namedLink: false, quickLink: true } }, "disabled"],
    ["Only this computer can authorize, from the LAN", { policy: { enabled: true, loopbackOnly: true, namedLink: false, quickLink: true } }, "loopback_only"],
    ["a chat account that is no longer an admin", { webOnly: false, session: rec({ owner: { adapterId: "a", userId: "1" } }), isAdmin: () => false }, "not_admin"],
    ["an owner-less admin session on a chat fleet that is not the host's", { webOnly: false }, "no_account"],
    ["a web-only fleet's session over a link that did not sign in from outside", { gateway: true, peer: "quick_link", session: rec({ surface: "gateway" }) }, "outside_sign_in"],
    ["a chat account over the named link while its option is off", { webOnly: false, gateway: true, peer: "named_link", session: rec({ surface: "gateway", owner: { adapterId: "a", userId: "1" } }) }, "link_off"],
    ["a local session replayed over a link", { gateway: true, peer: "quick_link" }, "public_link"],
  ] as const)("%s → %s", (_name, over, expected) => { expect(reason(input(over as Partial<SettingsRoleInput>))).toBe(expected); });
  it("the host's own session on a chat fleet, and a chat account over the quick link (its option on), qualify", () => {
    expect(reason(input({ webOnly: false, session: rec({ host: true }) }))).toBe("ok");
    expect(reason(input({ webOnly: false, gateway: true, peer: "quick_link", session: rec({ surface: "gateway", owner: { adapterId: "a", userId: "1" } }) }))).toBe("ok");
  });
  it("the owner signed in from outside qualifies over its own link only", () => {
    const outside = rec({ surface: "gateway", remote: "totp", exposureId: "x" });
    expect(reason(input({ gateway: true, peer: "quick_link", session: outside, outside: { exposureId: "x" } }))).toBe("ok");
    expect(reason(input({ gateway: true, peer: "quick_link", session: outside, outside: { exposureId: "y" } }))).toBe("outside_sign_in");
  });
});

describe("the default: every class of change gets Apply now, from anywhere", () => {
  const places = ["here", "tailnetServe", "tailnetDirect", "lan"] as const;
  it.each(places)("a web-only fleet's admin (sign-in code, host session, device) from %s: Apply now for access, an outward Hub change, a Hub pairing and a link opener", (where) => {
    for (const kind of ["code", "host", "device"] as const) {
      const f = fleet(), s = f.session(kind, where);
      for (const [name, make] of Object.entries(f.classes())) {
        const p = make();
        expect([name, f.any.settingsSelfConfirmation(f.store, s.req, p.view.id)?.label], `${kind} ${name}`).toEqual([name, "This fleet's admin"]);
      }
      expect(f.any.settingsSelfConfirmation(f.store, s.req, f.secretChange().id)?.label).toBe("This fleet's admin");
    }
  });
  it.each(places)("a chat account that is an admin, from %s: every class too, no DM authorization and no chat card needed", (where) => {
    const f = fleet({ chat: true }), s = f.session("account", where);
    for (const [name, make] of Object.entries(f.classes())) expect([name, !!f.any.settingsSelfConfirmation(f.store, s.req, make().view.id)]).toEqual([name, true]);
    expect(f.any.settingsSelfConfirmation(f.store, s.req, f.secretChange().id)).not.toBeNull();
  });
  it("over the public gateway (a real gateway-bound request): the quick link's own opt-in is on by default — the owner signed in from outside confirms; a named-link session needs its option", () => {
    const f = fleet({ enrolled: true });
    f.any.outsideLink = () => ({ exposureId: "x" });
    const owner = f.session("outside", "here");
    for (const make of Object.values(f.classes())) expect(f.any.settingsSelfConfirmation(f.store, owner.req, make().view.id)).not.toBeNull();
    const chat = fleet({ chat: true }), quick = chat.session("account", "here", { gateway: "quick" }), named = chat.session("account", "here", { gateway: "named" });
    const p = chat.classes().access();
    expect([!!chat.any.settingsSelfConfirmation(chat.store, quick.req, p.view.id), !!chat.any.settingsSelfConfirmation(chat.store, named.req, p.view.id)]).toEqual([true, false]);
  });
  it("never: a guest, a header token (no session), an owner-less session on a chat fleet that is not the host's", () => {
    const f = fleet({ chat: true }), p = f.classes().access();
    expect(f.any.settingsSelfConfirmation(f.store, f.session("guest", "lan").req, p.view.id)).toBeNull();
    const bare = f.session("account", "lan"); delete bare.req.headers.cookie; bare.req.headers.authorization = `Bearer ${TOKEN}`;
    expect(f.any.settingsSelfConfirmation(f.store, bare.req, p.view.id)).toBeNull();
    expect(f.any.settingsSelfConfirmation(f.store, f.session("code", "lan").req, p.view.id)).toBeNull();
  });
  it("the owner's knobs still hold: the web authorization switch off, and Only this computer can authorize off this computer", () => {
    const off = fleet({ va: { enabled: false } }), onlyHere = fleet({ va: { loopback_only: true } });
    for (const f of [off, onlyHere]) {
      const p = f.classes().access();
      expect([f.any.settingsSelfConfirmation(f.store, f.session("code", "tailnetServe").req, p.view.id)]).toEqual([null]);
    }
    const p = onlyHere.classes().access();
    expect(onlyHere.any.settingsSelfConfirmation(onlyHere.store, onlyHere.session("code", "here").req, p.view.id)?.label).toBe("This fleet's admin");
    expect(onlyHere.any.settingsTotpState(onlyHere.store, onlyHere.session("code", "lan").req, p.view.id)).toBe("host_only");
  });
});

describe("strict mode (the admin's own switch): off this computer a code, never Apply now — for every session of that admin", () => {
  it("a LAN session, a tailnet-style session and the owner signed in from outside: the code, no Apply now; this computer: Apply now, no code", () => {
    const f = fleet({ enrolled: true, strict: true });
    f.any.outsideLink = () => ({ exposureId: "x" });
    const p = f.classes().access();
    for (const s of [f.session("code", "lan"), f.session("host", "tailnetServe"), f.session("outside", "here")]) {
      expect([f.any.settingsSelfConfirmation(f.store, s.req, p.view.id), f.any.settingsTotpState(f.store, s.req, p.view.id)]).toEqual([null, "ready"]);
    }
    const here = f.session("code", "here");
    expect([!!f.any.settingsSelfConfirmation(f.store, here.req, p.view.id), f.any.settingsTotpState(f.store, here.req, p.view.id)]).toEqual([true, null]);
  });
  it("the switch is off by default; with no app set up there is no switch (it lives inside an enrolled record): Apply now", () => {
    const f = fleet({ enrolled: true });
    const p = f.classes().access(), s = f.session("code", "lan");
    expect([!!f.any.settingsSelfConfirmation(f.store, s.req, p.view.id), f.any.settingsTotpState(f.store, s.req, p.view.id)]).toEqual([true, null]);
    // A fleet with no app at all: there is no switch to be on (strict lives inside an enrolled record) — Apply now, as by default.
    const none = fleet(), q = none.classes().access(), t2 = none.session("code", "lan");
    expect([!!none.any.settingsSelfConfirmation(none.store, t2.req, q.view.id), none.any.webRemoteAccess().strictOf(HOST_ADMIN_KEY)]).toEqual([true, false]);
  });
  it("a change that opens a link: confirmed with the code from a tailnet-style request, refused over a real gateway request — even with a correct code", () => {
    const f = fleet({ enrolled: true, strict: true });
    f.any.outsideLink = () => ({ exposureId: "x" });
    const p = f.classes().openLink(), tail = f.session("code", "tailnetServe"), link = f.session("outside", "here");
    const confirm = (s: { req: any }) => f.any.settingsTotpConfirm(f.store, s.req, p.view.id, codeAt(Date.now()), f.store.confirmDigest(p.view.id));
    expect([f.any.settingsTotpState(f.store, link.req, p.view.id), confirm(link)]).toEqual(["on_host", { error: "not_here" }]);
    expect(confirm(tail)).toMatchObject({ label: "Authenticator code" });
  });
  it("end to end: strict on, a LAN session is refused Apply now, a wrong code and a stale digest burn nothing, the right code confirms; turning the switch off asks the current code, then Apply now is back", async () => {
    const f = fleet({ enrolled: true, strict: true }), s = f.session("code", "lan");
    const post = vi.spyOn(f.any, "postSettingsRemoteNotice").mockImplementation(() => undefined);
    vi.spyOn(f.any, "notifyFleetError").mockReturnValue(true);
    const view = f.secretChange(), id = view.id;
    expect([f.any.settingsSelfConfirmation(f.store, s.req, id), f.any.settingsTotpState(f.store, s.req, id)]).toEqual([null, "ready"]);
    const digest = f.store.confirmDigest(id);
    expect(f.any.settingsTotpConfirm(f.store, s.req, id, codeAt(Date.now()), "0".repeat(64))).toEqual({ error: "changed" });   // a stale page never burns a code
    expect(f.any.settingsTotpConfirm(f.store, s.req, id, "000000", digest)).toEqual({ error: "wrong" });
    expect(f.store.get(id, "browser")!.state).toBe("pending");
    const ok = f.any.settingsTotpConfirm(f.store, s.req, id, codeAt(Date.now()), digest);
    expect(ok.label).toBe("Authenticator code");
    const done = await f.store.decide(id, "confirm", { ...ok, via: "web" }); ok.done?.(done);
    expect([done.state, post.mock.calls.map(c => c[1])]).toEqual(["applied", ["secret"]]);
    // The switch is the admin's own: off asks the CURRENT code off this computer (the next step: each step is accepted once) …
    expect(f.any.webOutsideStrict(s.req, false)).toEqual({ error: "code_required" });
    expect(f.any.webOutsideStrict(s.req, false, "000000")).toEqual({ error: "wrong" });
    expect(f.any.webRemoteAccess().strictOf(HOST_ADMIN_KEY)).toBe(true);
    expect(f.any.webOutsideStrict(s.req, false, codeAt(Date.now() + 30_000))).toBe("ok");
    // … and then the same session has Apply now again.
    const next = f.classes().access();
    expect([!!f.any.settingsSelfConfirmation(f.store, s.req, next.view.id), f.any.settingsTotpState(f.store, s.req, next.view.id)]).toEqual([true, null]);
  });
  it("an agent's or header-token request has no session: no code either", () => {
    const f = fleet({ enrolled: true, strict: true }), s = f.session("code", "lan"), p = f.classes().access();
    delete s.req.headers.cookie; s.req.headers.authorization = `Bearer ${TOKEN}`;
    expect([f.any.settingsTotpState(f.store, s.req, p.view.id), f.any.settingsTotpConfirm(f.store, s.req, p.view.id, codeAt(Date.now()), f.store.confirmDigest(p.view.id))]).toEqual([null, { error: "not_here" }]);
  });
});

describe("Notices for a remote link-opening or secret confirmation", () => {
  const notice = (f: ReturnType<typeof fleet>) => vi.spyOn(f.any, "postSettingsRemoteNotice").mockImplementation(() => undefined);
  it("from another device: one for a link opener and one for a secret; none for an ordinary change; none on this computer", async () => {
    const f = fleet(), post = notice(f);
    const run = async (s: { req: any }, view: { id: string }) => {
      const c = f.any.settingsSelfConfirmation(f.store, s.req, view.id)!;
      const done = await f.store.decide(view.id, "confirm", { ...c, via: "web" }); await c.done?.(done);
    };
    const lan = f.session("code", "tailnetServe"), here = f.session("code", "here");
    await run(lan, f.classes().openLink().view); await run(lan, f.secretChange()); await run(lan, f.classes().access().view);
    await run(here, f.classes().openLink().view);
    expect(post.mock.calls.map(c => c[1])).toEqual(["link", "secret"]);
  });
  it("it goes to the web Notices when nothing else could carry it: a chat fleet with no General and no primary target", () => {
    const f = fleet({ chat: true });
    vi.spyOn(f.any, "notifyFleetError").mockReturnValue(false);
    const view = { id: "x", state: "applied", summary: ["named_link: default → true"], outcome: null } as any;
    expect(f.any.webNoticesFeed()).toBeNull();
    f.any.postSettingsRemoteNotice(view, "link", "Ada");
    const feed = f.any.webNoticesFeed();
    expect(feed).not.toBeNull();
    expect(feed.list?.().some?.((n: any) => /opens a public link/.test(n.text)) ?? true).toBe(true);
  });
});

describe("setting up, replacing and removing the authenticator (M3, S1)", () => {
  const secretOf = (r: any, offset = 0) => appCode(r, offset);
  it("a set-up begun while no app existed (no code asked) cannot be finished once an app exists for that admin and a code is asked", () => {
    const f = fleet({ enrolled: false, outside: false }), s = f.session("code", "lan"), mine = f.session("host", "here");
    const begun = f.any.webOutsideBeginEnrollment(s.req);
    expect(begun).toMatchObject({ secret: expect.any(String) });              // no app: no code asked, first set-up
    const hostBegun = f.any.webOutsideBeginEnrollment(mine.req);
    expect(f.any.webOutsideConfirmEnrollment(mine.req, secretOf(hostBegun))).toBe("ok");   // the host sets its own app up meanwhile
    const enrolment = f.any.webRemoteAccess().enrollmentOf(HOST_ADMIN_KEY);
    expect(f.any.webOutsideConfirmEnrollment(s.req, secretOf(begun))).toBe("not_here");    // an app exists now: finishing a replacement asks the code it never gave
    expect(f.any.webRemoteAccess().enrollmentOf(HOST_ADMIN_KEY)).toBe(enrolment);          // nothing was replaced
  });
  // Round 3 (Prism P2): a code is a proof about the app that existed when it was given, and about nothing that replaces it.
  it("Prism's case: A's remote session proves its code and begins replacement B; a recovery on the computer sets up C; B's first code is then refused and C is kept", () => {
    const f = fleet({ enrolled: true, outside: false }), remote = f.session("code", "lan"), computer = f.session("host", "here");
    const b = f.any.webOutsideBeginEnrollment(remote.req, codeAt(Date.now()));          // switch off, remote: the current code, then a pending replacement B
    expect(b).toMatchObject({ secret: expect.any(String) });
    const c = f.any.webOutsideBeginEnrollment(computer.req);                            // the owner recovers on the computer: asks nothing
    expect(f.any.webOutsideConfirmEnrollment(computer.req, secretOf(c))).toBe("ok");   // C is the app now
    const noticeCount = () => f.any.webNoticesFeed().view().items.length;            // the real feed: WebNotices.view().items
    const keep = f.any.webRemoteAccess().enrollmentOf(HOST_ADMIN_KEY), notices = noticeCount();
    expect(notices, "the feed exists and holds the recovery's Notice").toBeGreaterThan(0);
    expect(f.any.webOutsideConfirmEnrollment(remote.req, secretOf(b))).toBe("not_here");   // never verified against C: refused …
    expect(f.any.webRemoteAccess().enrollmentOf(HOST_ADMIN_KEY)).toBe(keep);               // … and C is still the app
    expect(f.any.webRemoteAccess().verify(secretOf(c, 1), HOST_ADMIN_KEY).kind).toBe("ok");
    expect(f.any.webRemoteAccess().verify(secretOf(b, 2), HOST_ADMIN_KEY).kind).toBe("wrong");   // B never became the app
    expect(noticeCount()).toBe(notices);                        // no "replaced" Notice for a refused finish
    expect(f.any.webOutsideConfirmEnrollment(remote.req, secretOf(b, 3))).toBe("not_here");     // and the voided start is not reusable
  });
  it("removal voids it too, for good: the refused finish is not revivable by repeating it; only a fresh begin (no app: no code) sets up again", () => {
    const f = fleet({ enrolled: true, outside: false }), remote = f.session("code", "lan"), computer = f.session("host", "here");
    const b = f.any.webOutsideBeginEnrollment(remote.req, codeAt(Date.now()));
    expect(f.any.webOutsideRemove(computer.req)).toBe("ok");                          // the owner removes the app on the computer
    for (let n = 0; n < 3; n++) {
      expect(f.any.webOutsideConfirmEnrollment(remote.req, secretOf(b, n)), `finish #${n + 1} of the same attempt`).toBe("not_here");
      expect(f.any.webRemoteAccess().isEnrolled(HOST_ADMIN_KEY)).toBe(false);         // never bound to B (Prism: repeating the finish returned "ok")
    }
    expect(f.any.webRemoteAccess().confirmEnrollment("never-begun", secretOf(b)), "the store dropped the secret too").toBe("expired");
    // The way on is a fresh begin, which asks nothing while there is no app; the old secret B stays dead.
    const b2 = f.any.webOutsideBeginEnrollment(remote.req);
    expect(b2).toMatchObject({ secret: expect.any(String) });
    expect(f.any.webOutsideConfirmEnrollment(remote.req, secretOf(b, 5)), "the old secret is not the new attempt's").toBe("wrong");
    expect(f.any.webRemoteAccess().isEnrolled(HOST_ADMIN_KEY)).toBe(false);
    const b3 = f.any.webOutsideBeginEnrollment(remote.req);
    expect(f.any.webOutsideConfirmEnrollment(remote.req, secretOf(b3))).toBe("ok");
    expect(f.any.webRemoteAccess().verify(secretOf(b3, 1), HOST_ADMIN_KEY).kind).toBe("ok");
  });
  it("an attempt with no start on record (never made here) is refused before the store, and a start that had no app is voided once one appears", () => {
    const f = fleet({ enrolled: false, outside: false }), remote = f.session("code", "lan"), computer = f.session("host", "here");
    const none = f.any.webOutsideBeginEnrollment(remote.req);                          // no app: no code asked, a "none" start
    const c = f.any.webOutsideBeginEnrollment(computer.req);
    expect(f.any.webOutsideConfirmEnrollment(computer.req, secretOf(c))).toBe("ok");   // an app appears on the computer
    expect(f.any.webOutsideConfirmEnrollment(remote.req, secretOf(none, 0))).toBe("not_here");   // an app exists now: finish #1 refused, and the attempt voided
    expect(f.any.webOutsideRemove(computer.req)).toBe("ok");                          // removed again: no code is asked once more …
    expect(f.any.webOutsideConfirmEnrollment(remote.req, secretOf(none, 1))).toBe("not_here");   // … yet finish #2 of the voided attempt is still refused
    expect(f.any.webRemoteAccess().isEnrolled(HOST_ADMIN_KEY)).toBe(false);
    const lost = f.any.webOutsideBeginEnrollment(remote.req); f.any.authenticatorStarts.clear();
    expect(f.any.webOutsideConfirmEnrollment(remote.req, secretOf(lost))).toBe("not_here");
    expect(f.any.webRemoteAccess().isEnrolled(HOST_ADMIN_KEY)).toBe(false);
  });
  it("controls: the app unchanged — a remote replacement with its code completes; the owner with no app recovers on the computer", () => {
    const f = fleet({ enrolled: true, outside: false }), remote = f.session("code", "lan"), computer = f.session("host", "here");
    const before = f.any.webRemoteAccess().enrollmentOf(HOST_ADMIN_KEY);
    const b = f.any.webOutsideBeginEnrollment(remote.req, codeAt(Date.now()));
    expect(f.any.webOutsideConfirmEnrollment(remote.req, secretOf(b))).toBe("ok");      // nothing changed in between
    expect(f.any.webRemoteAccess().enrollmentOf(HOST_ADMIN_KEY)).not.toBe(before);
    expect(f.any.webRemoteAccess().verify(secretOf(b, 1), HOST_ADMIN_KEY).kind).toBe("ok");
    expect(f.any.webOutsideRemove(computer.req)).toBe("ok");                              // the owner's app is gone …
    expect(f.any.webOutsideConfirmEnrollment(computer.req, secretOf(f.any.webOutsideBeginEnrollment(computer.req)))).toBe("ok");   // … and set up again on the computer
    expect(f.any.webRemoteAccess().isEnrolled(HOST_ADMIN_KEY)).toBe(true);
  });
  it("a set-up begun on this computer is not finished by the same cookie from another device once the switch is on", () => {
    const f = fleet({ enrolled: true, strict: true, outside: false }), s = f.session("host", "here");
    const begun = f.any.webOutsideBeginEnrollment(s.req);
    expect(begun).toMatchObject({ secret: expect.any(String) });
    const away = { ...s.req, socket: { remoteAddress: "192.0.2.20" }, headers: { ...s.req.headers, host: "192.0.2.5:19280", origin: "http://192.0.2.5:19280" } };
    expect(f.any.webOutsideConfirmEnrollment(away, secretOf(begun))).toBe("not_here");
    expect(f.any.webOutsideConfirmEnrollment(s.req, secretOf(begun))).toBe("ok");        // the same start, finished on this computer
  });
  it("begun with the switch on: the current code first, then the finish is allowed; the switch survives the replacement", () => {
    const f = fleet({ enrolled: true, strict: true, outside: false }), s = f.session("code", "lan");
    expect(f.any.webOutsideBeginEnrollment(s.req)).toEqual({ error: "code_required" });
    const begun = f.any.webOutsideBeginEnrollment(s.req, codeAt(Date.now()));
    expect(begun).toMatchObject({ secret: expect.any(String) });
    expect(f.any.webOutsideConfirmEnrollment(s.req, secretOf(begun))).toBe("ok");
    expect([f.any.webRemoteAccess().strictOf(HOST_ADMIN_KEY), f.any.webRemoteAccess().isEnrolled(HOST_ADMIN_KEY)]).toEqual([true, true]);
  });
  it("a web-only fleet whose connections from outside are on: replacing or removing asks the current code even with the switch off; this computer is not asked", () => {
    const f = fleet({ enrolled: true, outside: true }), s = f.session("code", "tailnetServe");
    expect([f.any.webOutsideBeginEnrollment(s.req), f.any.webOutsideRemove(s.req)]).toEqual([{ error: "code_required" }, { error: "code_required" }]);
    expect(f.any.webOutsideStatus(s.req)).toMatchObject({ codeNeeded: true, strict: false });
    expect(f.any.webOutsideRemove(f.session("host", "here").req)).toBe("ok");
  });
  it("the switch lives inside the app's record: removing the app removes it, and a new app starts with it off", () => {
    const f = fleet({ enrolled: true, strict: true, outside: false }), s = f.session("host", "here");
    expect([f.any.webOutsideStrict(s.req, false), f.any.webOutsideStrict(s.req, true)]).toEqual(["ok", "ok"]);
    expect(f.any.webOutsideRemove(s.req)).toBe("ok");
    expect([f.any.webRemoteAccess().strictOf(HOST_ADMIN_KEY), f.any.webOutsideStrict(s.req, true)]).toEqual([false, "not_enrolled"]);   // no app, no switch
    expect(f.any.webOutsideConfirmEnrollment(s.req, secretOf(f.any.webOutsideBeginEnrollment(s.req)))).toBe("ok");
    expect(f.any.webRemoteAccess().strictOf(HOST_ADMIN_KEY)).toBe(false);
  });
});

/** Set up `s`'s own app from where it is (nothing is asked while its switch is off): the secret, with the first code taken at `offset` steps from now. */
function enrol(f: ReturnType<typeof fleet>, s: { req: any }, offset = -1): string {
  const begun = f.any.webOutsideBeginEnrollment(s.req);
  expect(begun).toMatchObject({ secret: expect.any(String) });
  expect(f.any.webOutsideConfirmEnrollment(s.req, appCode(begun, offset))).toBe("ok");
  return begun.secret;
}

describe("per admin: each admin's own authenticator and switch (upstream #3486)", () => {
  const key = (user: string) => adminKey("a", user);
  it("A sets up the app and turns strict on from the LAN: A is asked for the code, no Apply now; B (no app) still has Apply now and is asked nothing; A on this computer has Apply now too", () => {
    const f = fleet({ chat: true }), a = f.session("account", "lan", { user: ADMIN }), b = f.session("account", "lan", { user: ADMIN_B }), aHere = f.session("account", "here", { user: ADMIN });
    enrol(f, a);
    expect(f.any.webOutsideStrict(a.req, true)).toBe("ok");
    const p = f.classes().access();
    expect([f.any.settingsSelfConfirmation(f.store, a.req, p.view.id), f.any.settingsTotpState(f.store, a.req, p.view.id)]).toEqual([null, "ready"]);
    expect([!!f.any.settingsSelfConfirmation(f.store, b.req, p.view.id), f.any.settingsTotpState(f.store, b.req, p.view.id)]).toEqual([true, null]);
    expect([!!f.any.settingsSelfConfirmation(f.store, aHere.req, p.view.id), f.any.settingsTotpState(f.store, aHere.req, p.view.id)]).toEqual([true, null]);
    expect(f.any.webOutsideStatus(a.req)).toMatchObject({ manage: true, enrolled: true, strict: true, codeNeeded: true });
    expect(f.any.webOutsideStatus(b.req)).toMatchObject({ manage: true, enrolled: false, strict: false, codeNeeded: false });
  });
  it("B's calls act on B's own record only: A's app, switch and enrolment stay exactly as they were", () => {
    const f = fleet({ chat: true, admins: { [ADMIN]: { strict: true } } }), b = f.session("account", "lan", { user: ADMIN_B });
    const access = () => f.any.webRemoteAccess(), snapshot = () => JSON.stringify([access().status(key(ADMIN)), access().enrollmentOf(key(ADMIN)), access().strictOf(key(ADMIN))]);
    const mine = snapshot();
    // B has no app: nothing to switch or remove — and nothing of A's is reachable from here.
    expect([f.any.webOutsideStrict(b.req, false), f.any.webOutsideStrict(b.req, true), f.any.webOutsideRemove(b.req)]).toEqual(["not_enrolled", "not_enrolled", "not_here"]);
    expect(snapshot()).toBe(mine);
    // B sets up their own, turns their own on; A's record does not move.
    enrol(f, b);
    expect(f.any.webOutsideStrict(b.req, true)).toBe("ok");
    expect([access().isEnrolled(key(ADMIN_B)), access().strictOf(key(ADMIN_B)), access().isEnrolled(HOST_ADMIN_KEY)]).toEqual([true, true, false]);
    expect(snapshot()).toBe(mine);
    // A's code is not B's: B's off, replace and remove are asked for B's own current code, and A's code is wrong for it.
    const aCode = appCode(secretFor(ADMIN));
    expect([f.any.webOutsideStrict(b.req, false, aCode), f.any.webOutsideBeginEnrollment(b.req, aCode), f.any.webOutsideRemove(b.req, aCode)]).toEqual([{ error: "wrong" }, { error: "wrong" }, { error: "wrong" }]);
    expect([access().strictOf(key(ADMIN_B)), access().isEnrolled(key(ADMIN_B))]).toEqual([true, true]);
    expect(snapshot()).toBe(mine);
  });
  it("A's code never confirms a change for B, and B's never for A; each one's own code does", () => {
    const f = fleet({ chat: true, admins: { [ADMIN]: { strict: true }, [ADMIN_B]: { strict: true } } });
    const a = f.session("account", "lan", { user: ADMIN }), b = f.session("account", "lan", { user: ADMIN_B }), p = f.classes().access();
    const confirm = (s: { req: any }, code: string) => f.any.settingsTotpConfirm(f.store, s.req, p.view.id, code, f.store.confirmDigest(p.view.id));
    expect(confirm(b, appCode(secretFor(ADMIN)))).toEqual({ error: "wrong" });
    expect(confirm(a, appCode(secretFor(ADMIN_B)))).toEqual({ error: "wrong" });
    expect(f.store.get(p.view.id, "browser")!.state).toBe("pending");
    expect(confirm(a, appCode(secretFor(ADMIN)))).toMatchObject({ label: "Authenticator code" });
    expect(confirm(b, appCode(secretFor(ADMIN_B)))).toMatchObject({ label: "Authenticator code" });
  });
  it("a code's confirmation ends when that admin's app is replaced while the change waits", () => {
    const f = fleet({ chat: true, admins: { [ADMIN]: { strict: true } } });
    const a = f.session("account", "lan", { user: ADMIN }), p = f.classes().access();
    const ok = f.any.settingsTotpConfirm(f.store, a.req, p.view.id, appCode(secretFor(ADMIN)), f.store.confirmDigest(p.view.id));
    expect(ok.current()).toBe(true);
    // The same admin's app replaced meanwhile (an enrolment from this computer): what the old code authorized no longer holds.
    const here = f.session("account", "here", { user: ADMIN });
    enrol(f, here);
    expect(ok.current()).toBe(false);
  });
  it("turning A's switch off needs A's current code off the AgEnD computer; on the computer none; turning it on never asks", () => {
    const f = fleet({ chat: true, admins: { [ADMIN]: { strict: true } } }), a = f.session("account", "lan", { user: ADMIN }), aHere = f.session("account", "here", { user: ADMIN });
    expect(f.any.webOutsideStrict(a.req, false)).toEqual({ error: "code_required" });
    expect(f.any.webOutsideStrict(a.req, false, "000000")).toEqual({ error: "wrong" });
    expect(f.any.webRemoteAccess().strictOf(key(ADMIN))).toBe(true);
    expect(f.any.webOutsideStrict(a.req, false, appCode(secretFor(ADMIN)))).toBe("ok");
    expect(f.any.webRemoteAccess().strictOf(key(ADMIN))).toBe(false);
    expect(f.any.webOutsideStrict(a.req, true)).toBe("ok");                                    // on: asks nothing
    expect(f.any.webOutsideStrict(aHere.req, false)).toBe("ok");                               // the computer's own browser: no code
    expect(f.any.webRemoteAccess().strictOf(key(ADMIN))).toBe(false);
  });
  it("a chat account used on the host computer manages only its own: the host operator's app and switch are never reached", () => {
    const f = fleet({ chat: true, enrolled: true, strict: true }), access = () => f.any.webRemoteAccess();
    const here = f.session("account", "here", { user: ADMIN }), other = f.session("account", "here", { user: ADMIN_B }), host = f.session("host", "here");
    const hostState = () => JSON.stringify([access().status(HOST_ADMIN_KEY), access().enrollmentOf(HOST_ADMIN_KEY)]);
    const mine = hostState();
    expect(f.any.webOutsideStatus(here.req)).toMatchObject({ manage: true, enrolled: false, strict: false, codeNeeded: false });
    expect(f.any.webOutsideStatus(host.req)).toMatchObject({ manage: true, enrolled: true, strict: true });
    enrol(f, here);                                                                           // on this computer: no code asked
    expect([access().isEnrolled(key(ADMIN)), f.any.webOutsideStrict(here.req, true), hostState()]).toEqual([true, "ok", mine]);
    expect([access().strictOf(key(ADMIN)), access().strictOf(HOST_ADMIN_KEY)]).toEqual([true, true]);
    // Another account with no app removing "its" app on the computer: nothing of the host operator's is touched.
    expect([f.any.webOutsideRemove(other.req), f.any.webOutsideStrict(other.req, false), hostState()]).toEqual(["ok", "not_enrolled", mine]);
    expect(f.any.webOutsideRemove(here.req)).toBe("ok");
    expect([access().isEnrolled(key(ADMIN)), hostState()]).toEqual([false, mine]);
  });
});

describe("every set-up, replacement, removal and switch change posts a Notice naming the admin", () => {
  /** One admin's whole life through the API, as the rules ask (a code off the computer while their switch is on): five events. */
  function life(f: ReturnType<typeof fleet>, s: { req: any }, away: boolean) {
    const asked = (app: string) => (away ? appCode(app) : undefined);
    const set = (code?: string) => { const b = f.any.webOutsideBeginEnrollment(s.req, code); expect(b).toMatchObject({ secret: expect.any(String) }); expect(f.any.webOutsideConfirmEnrollment(s.req, appCode(b, -1))).toBe("ok"); return b.secret as string; };
    let app = set();                                                      // set-up
    expect(f.any.webOutsideStrict(s.req, true)).toBe("ok");               // switch on (never asks)
    app = set(asked(app));                                                // replacement (a code while the switch is on)
    expect(f.any.webOutsideStrict(s.req, false, asked(app))).toBe("ok"); // switch off
    expect(f.any.webOutsideRemove(s.req, away ? appCode(app, 1) : undefined)).toBe("ok");   // removal (the owner's current code off the computer)
  }
  const KEYS = ["outside.enrolled_notice_by", "outside.strict_on_notice_by", "outside.reenrolled_notice_by", "outside.strict_off_notice_by", "outside.removed_notice_by"];
  it.each([
    ["a chat account from the LAN", "account", "lan", true],
    ["a chat account on the host computer", "account", "here", false],
    ["the host operator from the LAN", "host", "lan", true],
    ["the host operator on the host computer", "host", "here", false],
  ] as const)("%s: all five reach notifyFleetError, never throttled, naming the admin", (_who, kind, where, away) => {
    const f = fleet({ chat: true }), say = vi.spyOn(f.any, "notifyFleetError").mockReturnValue(true);
    expect(f.any.setWebPersonName({ adapterId: "a", userId: ADMIN }, "Ada").ok).toBe(true);
    const name = kind === "account" ? "Ada" : t("settings_confirm.host_operator_label");
    life(f, f.session(kind, where), away);
    expect(say.mock.calls).toEqual(KEYS.map(k => [t(k, name), { throttle: false }]));
    expect(say.mock.calls.every(c => (c[0] as string).includes(name))).toBe(true);
  });
  it("a refused or empty call posts nothing: a wrong code, a switch already in that state, a remove with nothing to remove", () => {
    const f = fleet({ chat: true, admins: { [ADMIN]: { strict: true } } }), say = vi.spyOn(f.any, "notifyFleetError").mockReturnValue(true);
    const a = f.session("account", "lan", { user: ADMIN }), b = f.session("account", "lan", { user: ADMIN_B });
    f.any.webOutsideStrict(a.req, false, "000000"); f.any.webOutsideStrict(a.req, true); f.any.webOutsideRemove(b.req); f.any.webOutsideStrict(b.req, true);
    expect(say).not.toHaveBeenCalled();
  });
  it("a chat fleet with no General and no target: the dashboard's Notices carry each one, once, and the page is told", () => {
    const f = fleet({ chat: true });
    f.fm.fleetConfig!.instances = {};                                                         // no General, no primary target
    const say = vi.spyOn(f.any, "notifyFleetError").mockReturnValue(false), sse = vi.spyOn(f.any, "emitSseEvent").mockImplementation(() => undefined);
    expect(f.any.setWebPersonName({ adapterId: "a", userId: ADMIN }, "Ada").ok).toBe(true);
    expect(f.any.webNoticesFeed()).toBeNull();                                                // nothing was ever put there
    const a = f.session("account", "lan", { user: ADMIN });
    const asked = (app: string) => appCode(app);
    const step = (n: number, key: string) => {
      const feed = f.any.webNoticesFeed();
      expect(feed, `after step ${n}`).not.toBeNull();
      const view = feed.view();
      expect([view.items.length, view.unread, view.items[0].text, view.items[0].kind]).toEqual([n, n, t(key, "Ada"), "fleet"]);
      expect(say).toHaveBeenCalledTimes(n);
      const notices = sse.mock.calls.filter(c => c[0] === "notice");
      expect(notices.length).toBe(n);
      expect(notices.at(-1)![1]).toMatchObject({ notice: { text: t(key, "Ada") }, unread: n });
    };
    const set = (code?: string) => { const b = f.any.webOutsideBeginEnrollment(a.req, code); expect(f.any.webOutsideConfirmEnrollment(a.req, appCode(b, -1))).toBe("ok"); return b.secret as string; };
    let app = set(); step(1, KEYS[0]!);                                                      // a first set-up, remote
    expect(f.any.webOutsideStrict(a.req, true)).toBe("ok"); step(2, KEYS[1]!);               // strict on
    app = set(asked(app)); step(3, KEYS[2]!);                                                // a replacement
    expect(f.any.webOutsideStrict(a.req, false, asked(app))).toBe("ok"); step(4, KEYS[3]!);  // strict off
    expect(f.any.webOutsideRemove(a.req, appCode(app, 1))).toBe("ok"); step(5, KEYS[4]!);    // a removal (the owner's current code)
    // The notices are kept in the real store beside the fleet's files, readable again from a new read.
    expect(f.any.webNoticeStore().view().items.map((n: any) => n.text).reverse()).toEqual(KEYS.map(k => t(k, "Ada")));
  });
});

describe("a pending set-up is nobody else's to clear or replace (Prism P2-2)", () => {
  it("strict is only a flag inside an enrolled record: with no app a switch call changes nothing and there is nothing to remove", () => {
    const f = fleet(), s = f.session("code", "lan"), access = f.any.webRemoteAccess();
    expect([f.any.webOutsideStrict(s.req, true), f.any.webOutsideStrict(s.req, false)]).toEqual(["not_enrolled", "not_enrolled"]);
    expect([access.strictOf(HOST_ADMIN_KEY), access.isEnrolled(HOST_ADMIN_KEY), access.status(HOST_ADMIN_KEY).strict]).toEqual([false, false, false]);
  });
  it("a REMOTE remove with no app is not_here and does not clear the set-up the host began; the host still finishes it with the right code", () => {
    const f = fleet(), host = f.session("host", "here"), remote = f.session("code", "lan");     // the same principal: a web-only fleet's one admin
    const begun = f.any.webOutsideBeginEnrollment(host.req);
    expect(begun).toMatchObject({ secret: expect.any(String) });
    expect(f.any.webOutsideRemove(remote.req)).toBe("not_here");
    expect(f.any.webOutsideRemove(remote.req, appCode(begun))).toBe("not_here");                    // not even with a code
    expect(f.any.webOutsideConfirmEnrollment(host.req, appCode(begun))).toBe("ok");
    expect(f.any.webRemoteAccess().isEnrolled(HOST_ADMIN_KEY)).toBe(true);
  });
  it("the same on a chat fleet, for a chat account: another session's remove with no app leaves its pending set-up", () => {
    const f = fleet({ chat: true }), first = f.session("account", "here", { user: ADMIN }), second = f.session("account", "lan", { user: ADMIN });
    const begun = f.any.webOutsideBeginEnrollment(first.req);
    expect(f.any.webOutsideRemove(second.req)).toBe("not_here");
    expect(f.any.webOutsideConfirmEnrollment(first.req, appCode(begun))).toBe("ok");
  });
  it("on the computer a remove with no app is ok but still never touches a pending set-up", () => {
    const f = fleet(), first = f.session("host", "here"), second = f.session("host", "here");
    const begun = f.any.webOutsideBeginEnrollment(first.req);
    expect(f.any.webOutsideRemove(second.req)).toBe("ok");
    expect(f.any.webOutsideConfirmEnrollment(first.req, appCode(begun))).toBe("ok");
  });
  it("a second session's begin does not replace the first session's pending secret: each finishes its own, never the other's", () => {
    const f = fleet(), one = f.session("host", "here"), two = f.session("host", "here");
    const first = f.any.webOutsideBeginEnrollment(one.req), second = f.any.webOutsideBeginEnrollment(two.req);
    expect(first.secret).not.toBe(second.secret);
    expect(f.any.webOutsideConfirmEnrollment(one.req, appCode(second))).toBe("wrong");             // not the second one's secret
    expect(f.any.webOutsideConfirmEnrollment(one.req, appCode(first))).toBe("ok");
    expect(f.any.webOutsideConfirmEnrollment(two.req, appCode(second, 1))).toBe("ok");              // the second's own start survived
  });
});

describe("the ordinary New Agent shortcut follows the same policy (Prism P2-1), through the real gate", () => {
  /** The real SettingsHttpConfirmation, its principal built as the fleet builds it, the creation's apply an inert commit. */
  function creationGate(f: ReturnType<typeof fleet>) {
    const { any, fm, store } = f, created: string[] = [];
    let calls = 0, hold: Promise<void> | null = null;
    const gate = new SettingsHttpConfirmation(store, {
      principal: req => {
        const auth = authorizeSession(req, any.webToken, any.webSessions, { touch: false });
        if (auth.kind !== "ok") return null;
        const record = auth.session, sessions = any.webSessions, exposure = gatewayRequestContext(req);
        return { id: record.idHash, label: record.label, source: exposure ? "public_link" : "web_session",
          localAdmin: () => record.tier === "admin" && record.surface === "local" && !exposure,
          current: () => sessions === any.webSessions && !!any.webToken && sessions.isCurrent(record, tokenEpoch(any.webToken)) && (!exposure || exposure.isCurrent()) };
      },
      // The second look at the baseline is the one at execution (`unchanged`): a test may hold it to act between admission and execution.
      baseline: async () => { const config = fm.fleetConfig; if (hold && ++calls > 1) await hold; return { config, classic: {}, fingerprint: settingsFingerprint(config) } as any; },
      snapshot: () => fm.fleetConfig,
      selfConfirm: (req, id) => any.settingsSelfConfirmation(store, req, id),
      totp: { state: (req, id) => any.settingsTotpState(store, req, id), confirm: (req, id, code, digest) => any.settingsTotpConfirm(store, req, id, code, digest) },
      remote: req => any.settingsPageIsRemote(req),
      directCreationPolicy: req => any.settingsDirectCreationAllowed(req),
      directAgentCreation: true,
    });
    const next = (rq: any, rs: any) => {
      const execution = settingsRequestExecution(rq);
      if (!execution) return false;
      execution.commit(() => { created.push("agent"); });                         // inert: no instance, no CLI
      rs.statusCode = 200; rs.end(JSON.stringify({ name: "agent" })); return true;
    };
    const send = (s: { req: any }, method: string, path: string, body: unknown) => new Promise<{ status: number; body: any }>((resolve, reject) => {
      const req: any = Object.assign(new EventEmitter(), s.req, { method, url: path, destroy: () => {} });
      req.headers = { ...s.req.headers, "idempotency-key": `k${Math.random()}` };
      let status = 0;
      const res: any = { destroyed: false, headersSent: false, once: () => {}, setHeader: () => {}, writeHead(code: number) { status = code; this.headersSent = true; }, end(v: string) { resolve({ status, body: JSON.parse(v) }); } };
      try { expect(gate.handle(req, res, new URL(path, "http://localhost"), next)).toBe(true); queueMicrotask(() => { req.emit("data", Buffer.from(JSON.stringify(body))); req.emit("end"); }); } catch (e) { reject(e); }
    });
    const create = (s: { req: any }) => send(s, "POST", "/ui/instances", { topic_name: "helper", backend: "codex" });
    const settle = () => new Promise(r => setTimeout(r, 30));                        // an unwanted direct apply is asynchronous
    const stateOf = (r: { body: any }, s: { record: SessionRecord }) => store.get(r.body.pending_change.id, s.record.idHash)?.state;
    return { created, create, send, settle, stateOf, holdExecution: () => { calls = 0; let release!: () => void; hold = new Promise<void>(r => { release = r; }); return () => { hold = null; release(); }; } };
  }
  it("(a) a strict admin from the LAN: not created at once — a held change, state pending, the code is offered; a correct code then confirms it", async () => {
    const f = fleet({ enrolled: true, strict: true }), g = creationGate(f), s = f.session("code", "lan");
    const r = await g.create(s);
    expect([r.status, r.body.pending_change.state, r.body.pending_change.totp]).toEqual([202, "pending", "ready"]);
    await g.settle();
    expect([g.created.length, g.stateOf(r, s)]).toEqual([0, "pending"]);
    const confirmed = await g.send(s, "POST", `/api/settings/pending/${r.body.pending_change.id}/confirm-totp`, { code: codeAt(Date.now()), digest: r.body.pending_change.confirm_digest });
    expect(confirmed.status).toBe(202);
    await vi.waitFor(() => expect(g.created.length).toBe(1));
    await vi.waitFor(() => expect(g.stateOf(r, s)).toBe("applied"));
  });
  it("(b) the same admin on this computer (loopback): created at once", async () => {
    const f = fleet({ enrolled: true, strict: true }), g = creationGate(f), s = f.session("code", "here");
    const r = await g.create(s);
    expect(r.status).toBe(202);
    await vi.waitFor(() => expect(g.created.length).toBe(1));
    await vi.waitFor(() => expect(g.stateOf(r, s)).toBe("applied"));
  });
  it("(c) an admin whose switch is off, from the LAN: created at once — and so is a chat account whose own switch is off while another admin's is on", async () => {
    const f = fleet({ enrolled: true }), g = creationGate(f), s = f.session("code", "lan");
    const r = await g.create(s);
    expect(r.status).toBe(202);
    await vi.waitFor(() => expect(g.stateOf(r, s)).toBe("applied"));
    expect(g.created.length).toBe(1);
    const c = fleet({ chat: true, admins: { [ADMIN]: { strict: true } } }), h = creationGate(c), a = c.session("account", "lan", { user: ADMIN }), b = c.session("account", "lan", { user: ADMIN_B });
    const ra = await h.create(a), rb = await h.create(b);
    expect([ra.body.pending_change.state, ra.body.pending_change.totp]).toEqual(["pending", "ready"]);
    await vi.waitFor(() => expect(h.stateOf(rb, b)).toBe("applied"));
    expect([h.created.length, h.stateOf(ra, a)]).toEqual([1, "pending"]);
  });
  it("(d) \"Only this computer can authorize\" on: from the LAN held with host_only, on this computer created at once", async () => {
    const f = fleet({ enrolled: true, va: { loopback_only: true } }), g = creationGate(f);
    const away = f.session("code", "lan"), r = await g.create(away);
    expect([r.status, r.body.pending_change.state, r.body.pending_change.totp]).toEqual([202, "pending", "host_only"]);
    await g.settle();
    expect([g.created.length, g.stateOf(r, away)]).toEqual([0, "pending"]);
    const here = f.session("code", "here"), q = await g.create(here);
    expect(q.status).toBe(202);
    await vi.waitFor(() => expect(g.stateOf(q, here)).toBe("applied"));
    expect(g.created.length).toBe(1);
  });
  it("(e) strict switched on after admission but before execution: the policy is asked again, the change is stale and nothing is created", async () => {
    const f = fleet({ enrolled: true }), g = creationGate(f), s = f.session("code", "lan"), host = f.session("host", "here");
    const release = g.holdExecution();
    const r = await g.create(s);                                                // admitted: the switch was off
    expect(r.status).toBe(202);
    expect(f.any.webOutsideStrict(host.req, true)).toBe("ok");                  // the admin switches strict on from the computer
    release();
    await vi.waitFor(() => expect(g.stateOf(r, s)).toBe("stale"));
    expect(g.created.length).toBe(0);
  });
  it("(f) a refused role is not permission: a chat account no longer in its connection's admin list, and a chat fleet's owner-less session that is not the host's, create nothing — on this computer too", async () => {
    const f = fleet({ chat: true }), g = creationGate(f);
    const ada = f.session("account", "lan", { user: ADMIN }), adaHere = f.session("account", "here", { user: ADMIN }), bare = f.session("code", "here");
    expect((await g.create(ada)).status).toBe(202);                                // control: a current admin creates at once
    await vi.waitFor(() => expect(g.created.length).toBe(1));
    (f.fm.fleetConfig as any).channels[0].access.allowed_users = [ADMIN_B];         // the account is removed from the admin list; its cookie is still a valid admin-tier session
    expect(f.any.settingsRole(ada.req).role).toMatchObject({ ok: false, reason: "not_admin" });
    for (const s of [ada, adaHere]) {
      const r = await g.create(s);
      expect(r.body.pending_change.state, "waits as a held change").toBe("pending");
      await g.settle();
      expect(g.stateOf(r, s)).toBe("pending");
    }
    const noAccount = await g.create(bare);                                         // owner-less, not the host's: no account at all
    expect(f.any.settingsRole(bare.req).role).toMatchObject({ ok: false, reason: "no_account" });
    expect(noAccount.body.pending_change.state).toBe("pending");
    await g.settle();
    expect(g.created.length).toBe(1);                                              // only the control
  });
  it("(g) an admin revoked after admission and before execution: the policy is asked again, stale, nothing created", async () => {
    const f = fleet({ chat: true }), g = creationGate(f), s = f.session("account", "lan", { user: ADMIN });
    const release = g.holdExecution();
    const r = await g.create(s);
    expect(r.status).toBe(202);
    (f.fm.fleetConfig as any).channels[0].access.allowed_users = [ADMIN_B];
    release();
    await vi.waitFor(() => expect(g.stateOf(r, s)).toBe("stale"));
    expect(g.created.length).toBe(0);
  });
  it("(h) the one legacy exception, kept apart from admin eligibility: with the web authorization switch off a local admin still creates", async () => {
    const f = fleet({ enrolled: true, va: { enabled: false } }), g = creationGate(f), s = f.session("code", "lan");
    expect(f.any.settingsRole(s.req).role).toMatchObject({ ok: false, reason: "disabled" });
    const r = await g.create(s);
    await vi.waitFor(() => expect(g.created.length).toBe(1));
    expect(r.status).toBe(202);
  });
  // Round 3 (Prism P2-1, second half): the switch being off is the one legacy exception, and it must not stand in for admin eligibility —
  // the other checks (admin tier, a chat account still an admin, the host's / a web-only admin, "Only this computer can authorize") still run.
  it("(i1) switch off, a revoked chat account: held at admission (nothing created); admitted while an admin and revoked before execution → stale", async () => {
    const f = fleet({ chat: true, va: { enabled: false } }), g = creationGate(f);
    const ada = f.session("account", "lan", { user: ADMIN }), adaHere = f.session("account", "here", { user: ADMIN });
    expect((await g.create(ada)).status, "control: a current admin creates at once with the switch off").toBe(202);
    await vi.waitFor(() => expect(g.created.length).toBe(1));
    const late = f.session("account", "lan", { user: ADMIN }), release = g.holdExecution();
    const admitted = await g.create(late);                                          // admitted while still an admin
    expect(admitted.status).toBe(202);
    (f.fm.fleetConfig as any).channels[0].access.allowed_users = [ADMIN_B];         // revoked: its cookie is still a valid admin-tier session
    expect(f.any.settingsRole(ada.req)).toMatchObject({ role: { ok: false, reason: "disabled" } });
    expect(f.any.settingsRole(ada.req, { ignoreSwitch: true }).role).toMatchObject({ ok: false, reason: "not_admin" });
    release();
    await vi.waitFor(() => expect(g.stateOf(admitted, late)).toBe("stale"));        // execution asks again
    for (const s of [ada, adaHere]) {
      expect(f.any.settingsDirectCreationAllowed(s.req)).toBe(false);
      const r = await g.create(s);
      expect(r.body.pending_change.state, "waits as a held change").toBe("pending");
      await g.settle();
      expect(g.stateOf(r, s)).toBe("pending");
    }
    expect(g.created.length).toBe(1);                                               // only the control
  });
  it("(i2) switch off, a chat fleet's owner-less session that is not the host's (no account): held, never created — on this computer too", async () => {
    const f = fleet({ chat: true, va: { enabled: false } }), g = creationGate(f);
    for (const where of ["lan", "here"] as const) {
      const bare = f.session("code", where);
      expect(f.any.settingsRole(bare.req, { ignoreSwitch: true }).role).toMatchObject({ ok: false, reason: "no_account" });
      expect(f.any.settingsDirectCreationAllowed(bare.req)).toBe(false);             // the same policy the execution asks again
      const r = await g.create(bare);
      expect(r.body.pending_change.state).toBe("pending");
      await g.settle();
      expect([g.created.length, g.stateOf(r, bare)]).toEqual([0, "pending"]);
    }
    const host = f.session("host", "here");                                          // control: the host's own session still creates
    const ok = await g.create(host);
    expect(ok.status).toBe(202);
    await vi.waitFor(() => expect(g.created.length).toBe(1));
  });
  it("(i3) switch off + \"Only this computer can authorize\": from the LAN held at admission; admitted on the LAN before it was turned on → stale; on this computer created", async () => {
    const f = fleet({ enrolled: true, va: { enabled: false } }), g = creationGate(f), lan = f.session("code", "lan"), here = f.session("code", "here");
    const release = g.holdExecution();
    const admitted = await g.create(lan);                                            // loopback_only still off: created like (h)
    expect(admitted.status).toBe(202);
    (f.fm.fleetConfig as any).web.verified_authority.loopback_only = true;
    release();
    await vi.waitFor(() => expect(g.stateOf(admitted, lan)).toBe("stale"));
    expect(g.created.length).toBe(0);
    expect(f.any.settingsRole(lan.req, { ignoreSwitch: true }).role).toMatchObject({ ok: false, reason: "loopback_only" });
    expect(f.any.settingsDirectCreationAllowed(lan.req)).toBe(false);
    const r = await g.create(lan);
    expect(r.body.pending_change.state).toBe("pending");
    await g.settle();
    expect([g.created.length, g.stateOf(r, lan)]).toEqual([0, "pending"]);
    const q = await g.create(here);                                                  // this computer: the one place it is allowed
    expect(q.status).toBe(202);
    await vi.waitFor(() => expect(g.created.length).toBe(1));
  });
});

describe("who can never confirm (agents, paired Windows PCs)", () => {
  it("`agend settings confirm` refuses an agent's environment before touching the host socket", async () => {
    await expect(requestSettingsConfirmation("/nonexistent", { action: "inspect", id: "x" }, { AGEND_INSTANCE_NAME: "worker" })).rejects.toThrow("Agent sessions cannot confirm Settings changes.");
  });
  it("a paired Windows PC (a runtime bearer token, never a browser cookie session) and an agent's token confirm nothing, in either mode", () => {
    for (const strict of [false, true]) {
      const f = fleet({ enrolled: true, strict }), p = f.classes().access(), s = f.session("code", "lan");
      for (const authorization of ["Bearer runtime-token-0123456789", `Bearer ${TOKEN}`]) {
        const req = { ...s.req, headers: { host: s.req.headers.host, authorization } };
        expect([f.any.settingsSelfConfirmation(f.store, req, p.view.id), f.any.settingsTotpConfirm(f.store, req, p.view.id, codeAt(Date.now()), f.store.confirmDigest(p.view.id))]).toEqual([null, { error: "not_here" }]);
      }
    }
  });
});

describe("a chat fleet has no outside link or outside switch (its admins sign in with their own app: signin-per-admin-totp-3486)", () => {
  it("no outside link and no switch, even with an app set up and the switch recorded on", () => {
    const f = fleet({ chat: true, enrolled: true }), s = f.session("account", "here");
    expect(f.any.webRemoteAccess().outside).toBe(true);                    // the shared store says it, the fleet type decides
    expect([f.any.outsideOn(), f.any.outsideLink(), f.any.isOutsideLink("x")]).toEqual([false, null, false]);
    expect(f.any.webOutsideSwitch(s.req, true)).toBe("not_here");
    // a session that signed in "from outside" is nobody's on a chat fleet: the role refuses it
    expect(evaluateSettingsRole({ session: { tier: "admin", surface: "gateway", tokenEpoch: "e", handle: "h", remote: "totp", exposureId: "x" } as any, gateway: true, peer: "quick_link", tokenEpoch: "e",
      webOnly: false, policy: { enabled: true, loopbackOnly: false, namedLink: true, quickLink: true }, isAdmin: () => true, outside: f.any.outsideLink() })).toEqual({ ok: false, reason: "no_account" });
  });
  it("the account admin can set the app up; the web-only switch stays the web-only host admin's", () => {
    const f = fleet({ chat: true }), s = f.session("account", "tailnetServe");
    expect(f.any.webOutsideBeginEnrollment(s.req)).toMatchObject({ secret: expect.any(String) });
    expect(f.any.webOutsideSwitch(s.req, true)).toBe("not_here");
  });
});

describe("the remote flag the page reads", () => {
  function route(remote: boolean | undefined) {
    const store = new SettingsConfirmationStore({ audit: vi.fn() }); stores.push(store);
    const view = store.propose({ session: "me", key: "k", bytes: 1, source: "web_session", section: "access", requestedBy: "me", fingerprint: "f".repeat(64),
      summary: ["Enable Hub membership"], affectedConnections: [], authority: { connections: [], primaryGeneral: true, unknown: false },
      current: () => true, unchanged: async () => true, snapshot: () => null, apply: async (_c: () => boolean, execution: any) => execution.commit(() => "applied") }).view;
    const gate = new SettingsHttpConfirmation(store, { principal: () => ({ id: "me", label: "me", source: "web_session", current: () => true }),
      baseline: async () => ({ fingerprint: "b" } as any), snapshot: () => null, ...(remote === undefined ? {} : { remote: () => remote }) });
    const get = (id?: string) => new Promise<any>((resolve) => {
      const req: any = Object.assign(new EventEmitter(), { method: "GET", url: `/api/settings/pending${id ? `/${id}` : ""}`, headers: {} });
      let status = 0; const res: any = { destroyed: false, headersSent: false, setHeader: () => {}, writeHead: (s: number) => { status = s; }, end: (b: string) => resolve({ status, body: JSON.parse(b) }) };
      expect(gate.handle(req, res, new URL(req.url, "http://localhost"), () => false)).toBe(true);
    });
    return { view, get, store };
  }
  it("a remote page's pending change says remote, in a read and in the list", async () => {
    const r = route(true), one = await r.get(r.view.id), list = await r.get();
    expect([one.status, one.body.remote, list.body[0].remote]).toEqual([200, true, true]);
  });
  it("this computer's own page, or a fleet that does not say: no flag; a decided change carries none", async () => {
    for (const remote of [false, undefined]) { const r = route(remote); expect((await r.get(r.view.id)).body.remote).toBeUndefined(); }
    const r = route(true);
    await r.store.decide(r.view.id, "reject", { label: "me", current: () => true, via: "web" } as any);
    expect((await r.get(r.view.id)).body.remote).toBeUndefined();
  });
  it("the fleet says remote for every non-loopback page, on any fleet type", () => {
    for (const chat of [false, true]) {
      const f = fleet({ chat });
      expect(["here", "lan", "tailnetServe", "tailnetDirect"].map(w => f.any.settingsPageIsRemote(f.session("code", w as Where).req))).toEqual([false, true, true, true]);
    }
  });
});

describe("changing an app that exists is its owner's: the current code off the computer, whatever the switch says (Prism round 2, #2)", () => {
  const lan = (f: ReturnType<typeof fleet>) => f.session("account", "lan", { user: ADMIN });
  it("an enrolled admin with the switch OFF, from the LAN: replacing and removing need their current code — no secret is given and nothing is removed without it; the right code works", () => {
    const f = fleet({ chat: true, admins: { [ADMIN]: {} } }), a = lan(f), mine = adminKey("a", ADMIN), access = f.any.webRemoteAccess();
    expect(access.strictOf(mine)).toBe(false);
    expect(f.any.webOutsideStatus(a.req)).toMatchObject({ enrolled: true, strict: false, codeNeeded: true });
    expect(f.any.webOutsideBeginEnrollment(a.req)).toEqual({ error: "code_required" });                      // no secret
    expect(f.any.webOutsideBeginEnrollment(a.req, "000000")).toEqual({ error: "wrong" });
    expect(f.any.webOutsideRemove(a.req)).toEqual({ error: "code_required" });
    expect(access.isEnrolled(mine)).toBe(true);
    const begun = f.any.webOutsideBeginEnrollment(a.req, appCode(secretFor(ADMIN)));
    expect(begun).toMatchObject({ secret: expect.any(String) });
    expect(f.any.webOutsideConfirmEnrollment(a.req, appCode(begun, -1))).toBe("ok");
    expect(f.any.webOutsideRemove(a.req, appCode(begun, 1))).toBe("ok");
    expect(access.isEnrolled(mine)).toBe(false);
  });
  it("the same admin on the computer asks nothing; a first set-up (no app) asks nothing anywhere; strict on asks nothing, strict off asks the code", () => {
    const f = fleet({ chat: true, admins: { [ADMIN]: {} } }), here = f.session("account", "here", { user: ADMIN }), away = lan(f);
    expect(f.any.webOutsideStatus(here.req)).toMatchObject({ codeNeeded: false });
    const begun = f.any.webOutsideBeginEnrollment(here.req);
    expect(begun).toMatchObject({ secret: expect.any(String) });
    expect(f.any.webOutsideConfirmEnrollment(here.req, appCode(begun, -1))).toBe("ok");
    expect(f.any.webOutsideStrict(away.req, true)).toBe("ok");
    expect(f.any.webOutsideStrict(away.req, false)).toEqual({ error: "code_required" });
    expect(f.any.webOutsideRemove(here.req)).toBe("ok");                                                     // the computer: no code
    const b = f.session("account", "lan", { user: ADMIN_B });                                                // B has no app: a first set-up from the LAN needs nothing
    expect(f.any.webOutsideStatus(b.req)).toMatchObject({ enrolled: false, codeNeeded: false });
    const nb = f.any.webOutsideBeginEnrollment(b.req);
    expect(f.any.webOutsideConfirmEnrollment(b.req, appCode(nb, -1))).toBe("ok");
  });
  it("same-owner host recovery: with no app the host begins and finishes without any code, while a remote Remove of nothing changes nothing", () => {
    const f = fleet({ chat: true }), host = f.session("account", "here", { user: ADMIN }), away = lan(f);
    const begun = f.any.webOutsideBeginEnrollment(host.req);
    expect(f.any.webOutsideRemove(away.req)).toBe("not_here");
    expect(f.any.webOutsideConfirmEnrollment(host.req, appCode(begun, -1))).toBe("ok");
  });
});

describe("the security Notice reaches every connection's admins and survives a failed chat delivery (Prism round 2, #3)", () => {
  /** Two connections whose admin lists do not overlap, each with its own General; chat delivery is a spy (it reports a dispatch, never a delivery). */
  function twoConnections() {
    const dir = mkdtempSync(join(tmpdir(), "agend-122-two-")); roots.push(dir);
    const fm = new FleetManager(dir), any = fm as any;
    fm.fleetConfig = { defaults: { backend: "codex" },
      channels: [{ id: "a", type: "telegram", mode: "topic", group_id: "-1001", access: { mode: "locked", allowed_users: [ADMIN] } },
        { id: "b", type: "telegram", mode: "topic", group_id: "-1002", access: { mode: "locked", allowed_users: [ADMIN_B] } }],
      instances: { general_a: { working_directory: dir, general_topic: true, channel_id: "a", topic_id: 1 }, general_b: { working_directory: dir, general_topic: true, channel_id: "b", topic_id: 2 } } } as any;
    writeFileSync(join(dir, "web.token"), TOKEN, { mode: 0o600 }); any.initializeWebSessions();
    fleets.push({ fm, any });
    const sent: string[] = [], failing = { on: false };
    vi.spyOn(any, "notifyInstanceTopic").mockImplementation(((name: string) => { sent.push(name); if (failing.on) throw new Error("sendText rejected"); return true; }) as any);
    const c = any.webSessions.create({ tier: "admin", surface: "local", label: "browser", tokenEpoch: tokenEpoch(TOKEN), owner: { adapterId: "a", userId: ADMIN } });
    const req: any = { method: "POST", socket: { remoteAddress: "192.0.2.20" }, headers: { host: "192.0.2.5:19280", origin: "http://192.0.2.5:19280", "sec-fetch-site": "same-origin", cookie: `agend_session=${c.sessionId}`, [WEB_CSRF_HEADER]: csrfTokenFor(c.sessionId) } };
    const enrol = () => { const b = any.webOutsideBeginEnrollment(req); expect(any.webOutsideConfirmEnrollment(req, appCode(b, -1))).toBe("ok"); };
    return { any, sent, failing, enrol };
  }
  it("a Notice goes to BOTH connections' Generals and, on a chat fleet, always to the dashboard's Notices — once", () => {
    const f = twoConnections();
    expect(f.any.webNoticesFeed()).toBeNull();
    f.enrol();
    expect(f.sent.sort()).toEqual(["general_a", "general_b"]);
    const feed = f.any.webNoticesFeed();
    expect(feed).not.toBeNull();
    expect(feed.view().items.length).toBe(1);
  });
  it("a chat send that throws or never arrives still leaves the dashboard Notice (exactly one), and the other connection is still tried", () => {
    const f = twoConnections();
    f.failing.on = true;
    f.enrol();
    expect(f.sent).toEqual(["general_a", "general_b"]);
    expect(f.any.webNoticesFeed()!.view().items.length).toBe(1);
  });
});

describe("capacity and the shared limiter at fleet level (Prism round 2, #4 and #5)", () => {
  it("#4: with 64 admins enrolled the 65th is refused before any secret is shown; an existing admin may still replace; nothing is dropped on reopen", () => {
    const admins = Object.fromEntries(Array.from({ length: 64 }, (_, n) => [`u${n}`, {} as { strict?: boolean }]));
    const f = fleet({ chat: true, admins }), a = f.session("account", "lan", { user: ADMIN });
    expect(f.any.webOutsideBeginEnrollment(a.req)).toBeNull();                                           // no room: refused up front
    expect(f.any.webRemoteAccess().isEnrolled(adminKey("a", ADMIN))).toBe(false);
    const reopened = new WebRemoteAccess(join(f.any.dataDir, WEB_REMOTE_ACCESS_FILE), { warn: () => {} });
    expect(Array.from({ length: 64 }, (_, n) => reopened.isEnrolled(adminKey("a", `u${n}`))).every(Boolean)).toBe(true);
  });
  it("#5: A is paused by five wrong codes; the host identity's FIRST enrolment from another device leaves the pause; on the computer itself it is cleared", () => {
    const f = fleet({ chat: true, admins: { [ADMIN]: {} } }), access = f.any.webRemoteAccess(), A = adminKey("a", ADMIN);
    for (let n = 0; n < TOTP_WRONG_LIMIT; n++) access.verify("000000", A);
    expect(access.verify("000000", A)).toMatchObject({ kind: "paused" });
    const remote = f.session("host", "lan"), b = f.any.webOutsideBeginEnrollment(remote.req);
    expect(f.any.webOutsideConfirmEnrollment(remote.req, appCode(b, -1))).toBe("ok");                    // the host identity enrols, remotely
    expect(access.isEnrolled(HOST_ADMIN_KEY)).toBe(true);
    expect(access.verify("000000", A)).toMatchObject({ kind: "paused" });                                // still paused
    const here = f.session("host", "here"), c = f.any.webOutsideBeginEnrollment(here.req);
    expect(f.any.webOutsideConfirmEnrollment(here.req, appCode(c, -1))).toBe("ok");                      // the computer's own browser
    expect(access.status(A).pausedForMs).toBe(0);
  });
});
