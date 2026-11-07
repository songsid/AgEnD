/**
 * alpha.6 feedback #2c — the user's decision hmsg-468cc290 (option A): on a web-only fleet, a pending Settings change is
 * confirmed on THIS computer's own page with the owner's authenticator code, by a local admin session that is not the host
 * operator. The real FleetManager authority (sessions, the authenticator store, the confirmation store), in a scratch dir:
 *   - offered only to a loopback, local, admin session on a web-only fleet with an app set up ("ready"), or "not_set_up";
 *     never over the public link, never from the LAN, never a guest, never on a chat fleet;
 *   - a correct code confirms that one change (audited under its own label) and is asked again at execution;
 *   - a wrong code is refused; the fleet-wide wrong-code limit pauses it; a code (time step) is accepted once only.
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
const roots: string[] = [], stores: SettingsConfirmationStore[] = [], fleets: any[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
  for (const a of fleets.splice(0)) { a.fm.stormWindow.shutdown(); a.fm.spawnGate.shutdown(); }
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function fleet(o: { enrolled?: boolean; chat?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "agend-b2b-")); roots.push(dir);
  if (o.enrolled !== false) writeFileSync(join(dir, WEB_REMOTE_ACCESS_FILE), JSON.stringify({ v: 1, totp: { secret: SECRET, enrolledAt: 1, lastStep: 0 }, outside: false, wrong: 0, level: 0, pausedUntil: 0, handles: [] }), { mode: 0o600 });
  const fm = new FleetManager(dir), any = fm as any;
  fm.fleetConfig = { defaults: { backend: "codex" }, ...(o.chat ? { channels: [{ id: "a", type: "telegram", mode: "topic", group_id: "-1001" }] } : {}),
    instances: { general: { working_directory: dir, general_topic: true } } } as any;
  writeFileSync(join(dir, "web.token"), TOKEN, { mode: 0o600 }); any.initializeWebSessions();
  const audit = vi.fn();
  const store = new SettingsConfirmationStore({ audit });
  stores.push(store); fleets.push({ fm, any });
  /** A browser session (no account: a code-signed admin, not the host operator), and a request carrying its cookie. */
  const session = (opts: { tier?: "admin" | "guest"; lan?: boolean; gateway?: boolean } = {}) => {
    const c = any.webSessions.create({ tier: opts.tier ?? "admin", surface: "local", label: "browser", tokenEpoch: tokenEpoch(TOKEN),
      ...(opts.tier === "guest" ? { owner: { adapterId: "telegram", userId: "42" } } : {}) });
    const req: any = { method: "POST", socket: { remoteAddress: opts.lan ? "192.168.1.20" : "127.0.0.1" },
      headers: { host: opts.lan ? "192.168.1.5:19280" : "127.0.0.1:19280", origin: opts.lan ? "http://192.168.1.5:19280" : "http://127.0.0.1:19280", "sec-fetch-site": "same-origin",
        cookie: `agend_session=${c.sessionId}`, [WEB_CSRF_HEADER]: csrfTokenFor(c.sessionId) } };
    if (opts.gateway) bindGatewayRequest(req, { surface: "gateway", exposureId: "x", expectedOrigin: "https://x.example", isCurrent: () => true });
    return { req, record: c.record, sessionId: c.sessionId };
  };
  const propose = (path = "/api/settings/hub/membership", body: unknown = { enabled: true }, extra: Record<string, unknown> = { hubMembership: () => ({ enabled: false }) }) => {
    const effect = prepareSettingsEffect(path.startsWith("/api/settings/hub/") && !path.endsWith("/apply") ? "PUT" : "POST", path, body, { config: fm.fleetConfig, classic: {}, ...extra } as any);
    const apply = vi.fn(async (_c: () => boolean, execution: any) => execution.commit(() => "applied"));
    let release!: () => void; const held = new Promise<boolean>((r) => { release = () => r(true); });
    const view = store.propose({ session: "browser", key: `k${Math.random()}`, bytes: 1, source: "web_session", section: effect.diff!.section, requestedBy: "browser",
      fingerprint: effect.diff!.fingerprint, summary: effect.diff!.summary, affectedConnections: effect.diff!.affectedConnections, authority: effect.diff!.authority,
      ...(effect.diff!.noSelfConfirm ? { noSelfConfirm: true as const } : {}), ...(effect.diff!.hostLocalConfirm ? { hostLocalConfirm: true as const } : {}),   // as the gate passes them
      current: () => true, unchanged: async () => (holdUnchanged ? held : true), snapshot: () => null, apply }).view;
    return { view, apply, release };
  };
  let holdUnchanged = false;
  return { fm, any, store, audit, session, propose, hold: () => { holdUnchanged = true; } };
}

describe("who is offered the code (alpha.6 #2c, hmsg-468cc290)", () => {
  it("a local admin on this computer, web-only fleet, app set up: ready", () => {
    const f = fleet(), s = f.session(), p = f.propose();
    expect(f.any.settingsTotpState(f.store, s.req, p.view.id)).toBe("ready");
  });
  it("no app set up: not_set_up (the card points to setting one up, never to the host)", () => {
    const f = fleet({ enrolled: false }), s = f.session(), p = f.propose();
    expect(f.any.settingsTotpState(f.store, s.req, p.view.id)).toBe("not_set_up");
  });
  it("a LAN session (the leader's ruling): ready", () => {
    const f = fleet(), s = f.session({ lan: true }), p = f.propose();
    expect(f.any.settingsTotpState(f.store, s.req, p.view.id)).toBe("ready");
  });
  it("over the quick (temporary) link: no code — the card says to confirm on the host computer's browser, or in General", () => {
    const f = fleet(), s = f.session({ gateway: true }), p = f.propose();
    expect([f.any.settingsTotpState(f.store, s.req, p.view.id), f.any.settingsTotpConfirm(f.store, s.req, p.view.id, codeAt(Date.now()), f.store.confirmDigest(p.view.id))]).toEqual(["on_host", { error: "not_here" }]);
  });
  it("a guest: never", () => {
    const f = fleet(), s = f.session({ tier: "guest" }), p = f.propose();
    expect([f.any.settingsTotpState(f.store, s.req, p.view.id), f.any.settingsTotpConfirm(f.store, s.req, p.view.id, codeAt(Date.now()), f.store.confirmDigest(p.view.id))]).toEqual([null, { error: "not_here" }]);
  });
  it("a chat-connected fleet: never (its General's card decides)", () => {
    const f = fleet({ chat: true }), s = f.session(), p = f.propose();
    expect(f.any.settingsTotpState(f.store, s.req, p.view.id)).toBeNull();
  });
});

describe("confirming with the code", () => {
  it("a correct code confirms that one change: applied once, audited under its own label", async () => {
    const f = fleet(), s = f.session(), p = f.propose();
    const r = f.any.settingsTotpConfirm(f.store, s.req, p.view.id, codeAt(Date.now()), f.store.confirmDigest(p.view.id));
    expect(r.label).toBe("Authenticator code");
    await f.store.decide(p.view.id, "confirm", { ...r, via: "web" });
    expect([p.apply.mock.calls.length, f.store.get(p.view.id, "browser")!.state]).toEqual([1, "applied"]);
    // #3352 security review, point 4: the confirmer is the code, not the session's user; what it confirmed is in the record.
    expect(f.audit.mock.calls.find(([event]: any[]) => event === "confirmed")?.[1]).toMatchObject({ decided_by: "Authenticator code", confirmed_with: "authenticator_code", summary: p.view.summary });
  });
  it("the same code (time step) is accepted once: a second change cannot reuse it", () => {
    const f = fleet(), s = f.session(), a = f.propose(), b = f.propose("/api/settings/hub/retention", { contentDays: 14, eventDays: 60, revision: 1 }, {});
    const code = codeAt(Date.now());
    expect("label" in f.any.settingsTotpConfirm(f.store, s.req, a.view.id, code, f.store.confirmDigest(a.view.id))).toBe(true);
    expect(f.any.settingsTotpConfirm(f.store, s.req, b.view.id, code, f.store.confirmDigest(b.view.id))).toEqual({ error: "wrong" });
  });
  it("wrong codes are refused, and the fleet-wide limit pauses the code (no confirmation while paused)", () => {
    const f = fleet(), s = f.session(), p = f.propose();
    for (let i = 1; i < TOTP_WRONG_LIMIT; i++) expect(f.any.settingsTotpConfirm(f.store, s.req, p.view.id, "000000", f.store.confirmDigest(p.view.id))).toEqual({ error: "wrong" });
    expect(f.any.settingsTotpConfirm(f.store, s.req, p.view.id, "000000", f.store.confirmDigest(p.view.id))).toMatchObject({ error: "paused" });
    expect(f.any.settingsTotpConfirm(f.store, s.req, p.view.id, codeAt(Date.now()), f.store.confirmDigest(p.view.id))).toMatchObject({ error: "paused" });
    expect(f.store.get(p.view.id, "browser")!.state).toBe("pending");
  });
  it("asked again at execution: a session signed out before the change runs leaves it unapplied", async () => {
    const f = fleet(); f.hold();
    const s = f.session(), p = f.propose();
    const r = f.any.settingsTotpConfirm(f.store, s.req, p.view.id, codeAt(Date.now()), f.store.confirmDigest(p.view.id));
    const decided = f.store.decide(p.view.id, "confirm", { ...r, via: "web" });
    f.any.webSessions.revokeById(s.sessionId);
    p.release(); await decided;
    expect([p.apply.mock.calls.length, f.store.get(p.view.id, "browser")!.state]).toEqual([0, "stale"]);
  });
});

describe("#3352 security review: binding, shared budget, and who else", () => {
  it("point 2: a code is bound to the change the page showed — a different change's digest is refused before the code is used", () => {
    const f = fleet(), s = f.session(), a = f.propose(), b = f.propose("/api/settings/hub/retention", { contentDays: 14, eventDays: 60, revision: 1 }, {});
    const code = codeAt(Date.now());
    expect(f.any.settingsTotpConfirm(f.store, s.req, a.view.id, code, f.store.confirmDigest(b.view.id))).toEqual({ error: "changed" });
    expect("label" in f.any.settingsTotpConfirm(f.store, s.req, a.view.id, code, f.store.confirmDigest(a.view.id)), "the code was not spent by the refusal").toBe(true);
  });
  it("point 3: one step per window across both paths — a code that signed in from outside cannot also confirm a change", () => {
    const f = fleet(), s = f.session(), p = f.propose(), code = codeAt(Date.now());
    expect(f.any.webRemoteAccess().verify(code).kind).toBe("ok");
    expect(f.any.settingsTotpConfirm(f.store, s.req, p.view.id, code, f.store.confirmDigest(p.view.id))).toEqual({ error: "wrong" });
  });
  it("the leader's ruling (b): never over a link — a named-link owner signed in with the authenticator, a tunnel request from 127.0.0.1: refused; the card says where", () => {
    const f = fleet(), p = f.propose();
    f.any.isOutsideLink = (id: string) => id === "outside";
    const overLink = (named: boolean, remote: boolean) => {
      const c = f.any.webSessions.create({ tier: "admin", surface: "gateway", label: "phone", tokenEpoch: tokenEpoch(TOKEN), exposureId: "outside", ...(remote ? { remote: "totp" } : {}) });
      // A tunnel connects from 127.0.0.1: only the gateway's own context says "over a link".
      const req: any = { method: "POST", socket: { remoteAddress: "127.0.0.1" }, headers: { host: "127.0.0.1:19280", origin: "http://127.0.0.1:19280", "sec-fetch-site": "same-origin",
        cookie: `__Host-agend_session=${c.sessionId}`, [WEB_CSRF_HEADER]: csrfTokenFor(c.sessionId) } };
      bindGatewayRequest(req, { surface: "gateway", exposureId: "outside", expectedOrigin: "http://127.0.0.1:19280", isCurrent: () => true, named } as any);
      return req;
    };
    for (const req of [overLink(true, true), overLink(false, false)]) {
      expect(f.any.settingsTotpState(f.store, req, p.view.id)).toBe("on_host");
      expect(f.any.settingsTotpConfirm(f.store, req, p.view.id, codeAt(Date.now()), f.store.confirmDigest(p.view.id))).toEqual({ error: "not_here" });
    }
  });
  it("the host operator's own local session: Apply now for an outward Hub change (no code); the code is offered only to others", () => {
    const f = fleet(), p = f.propose("/api/hub/member/pairing/connect", { address: "https://hub.example.test", code: "ABCD-EFGH" }, { hubPairing: () => ({ summary: ["Connect to the Hub at https://hub.example.test"] }) });
    expect(f.store.selfConfirmable(p.view.id)).toBe(false);
    const op = f.any.webSessions.create({ tier: "admin", surface: "local", label: "host", tokenEpoch: tokenEpoch(TOKEN), host: true });
    const req: any = { method: "POST", socket: { remoteAddress: "127.0.0.1" }, headers: { host: "127.0.0.1:19280", origin: "http://127.0.0.1:19280", "sec-fetch-site": "same-origin", cookie: `agend_session=${op.sessionId}`, [WEB_CSRF_HEADER]: csrfTokenFor(op.sessionId) } };
    f.any.webAuthority = () => ({ authority: { kind: "web-verified", actor: { adapter_id: "host", user_id: "operator" }, session: { handle: op.record.handle } } });
    expect(f.any.settingsSelfConfirmation(f.store, req, p.view.id)?.label).toBe("This computer's admin");
    expect(f.any.settingsTotpState(f.store, req, p.view.id)).toBeNull();
    // A forwarded request (a proxy in front) is not this computer's: no Apply now for the outward change; a code instead.
    // #3352 security review (the host:true hole): the same host:true cookie replayed with a forwarding header, or to a
    // non-loopback Host, is not this computer's request — no code-free Apply now; the code prompt instead.
    const forwarded = { ...req, headers: { ...req.headers, "x-forwarded-for": "203.0.113.9" } };
    const publicHost = { ...req, headers: { ...req.headers, host: "fleet.example.com", origin: "https://fleet.example.com" } };
    for (const replay of [forwarded, publicHost]) {
      expect(f.any.settingsSelfConfirmation(f.store, replay, p.view.id)).toBeNull();
      expect(f.any.settingsTotpState(f.store, replay, p.view.id)).toBe("ready");
    }
    // …and asked again at execution: the Apply-now confirmation of the local request stays bound to that request's own provenance.
    expect(f.any.settingsSelfConfirmation(f.store, req, p.view.id)!.current()).toBe(true);
    // A loopback session that is web-verified as the host operator but is not its host session (host:true): no code-free
    // Apply now for an outward change either — the host flag and this request's provenance are both required.
    const notHost = f.session();
    f.any.webAuthority = () => ({ authority: { kind: "web-verified", actor: { adapter_id: "host", user_id: "operator" }, session: { handle: notHost.record.handle } } });
    expect(f.any.settingsSelfConfirmation(f.store, notHost.req, p.view.id)).toBeNull();
    f.any.webAuthority = () => ({ authority: { kind: "unverified" } });
    const other = f.session(), q = f.propose("/api/hub/member/pairing/connect", { address: "https://hub.example.test", code: "WXYZ-1234" }, { hubPairing: () => ({ summary: ["Connect"] }) });
    expect(f.any.settingsTotpState(f.store, other.req, q.view.id)).toBe("ready");
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
