/**
 * #2453 (design #1939 §0.2): "Authorize this browser" over the admin's own named-tunnel hostname — opt-in
 * (`web.verified_authority.named_link`, off by default). The acceptance list of §0.2:
 * - Provenance: only the gateway says "named", and only on the exact configured hostname — never a header, a quick tunnel,
 *   or a named gateway that pinned a trycloudflare name.
 * - Admission: a quick tunnel is refused (public_link) with the option on or off; the named link with the option off is
 *   refused (named_link_off), with loopback_only on too (loopback_only); with the option on, the same §3 checks as local,
 *   and the peer is `named_link`.
 * - Read now: option off → its receipts read as none (named_link_off) at once; back on (it was on before) moves the epoch,
 *   so they never come back; loopback_only on downgrades them as lan ones.
 * - Settings: turning it on is confirmed and marked never self-confirmed (the trusted effect, alone or mixed); off is
 *   immediate.
 * - The fleet: a named-link session authorized by the Confirm path is web-verified with peer named_link; the link's end
 *   takes its authorizations with it.
 * Real modules; temp homes only (no fleet started, no tunnel, no network).
 */
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("../src/logger.js", () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child() { return this; } }) }));
vi.mock("node:child_process", async importOriginal => {
  const original = await importOriginal<typeof import("node:child_process")>();
  const blocked = () => { throw new Error("process execution is outside this harness"); };
  return { ...original, spawn: blocked, spawnSync: blocked, exec: blocked, execSync: blocked, execFile: blocked, execFileSync: blocked, fork: blocked };
});
import { createPublicWebGateway } from "../src/public-web-gateway.js";
import { gatewayRequestContext } from "../src/web-request-context.js";
import { webPeerOf } from "../src/web-api.js";
import { authorityNow, evaluateWebAuthority, webAuthorityPolicy, type HumanAuthority, type WebAuthorityInput } from "../src/authority/web-authority.js";
import { AuthorityStateStore } from "../src/authority/authority-state.js";
import { prepareSettingsEffect } from "../src/settings-effect.js";
import { validateFleetConfig } from "../src/config-validator.js";
import { FleetManager } from "../src/fleet-manager.js";
import { tokenEpoch } from "../src/web-session.js";

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); vi.restoreAllMocks(); });
const HOST = "agend.example.com";

describe("provenance: the gateway alone says named, on the exact hostname", () => {
  /** A gateway on an injected server: what dispatch saw for one request (its context), or the status it refused with. */
  function gateway(hostname: string | undefined, pinned: string) {
    let handler!: (req: any, res: any) => void;
    const seen: Array<{ named: boolean | undefined; peer: string }> = [];
    const g = createPublicWebGateway({ exposureId: "e1", ...(hostname ? { hostname } : {}), isCurrent: () => true, isOpen: () => true,
      dispatch: (req) => { seen.push({ named: gatewayRequestContext(req)?.named, peer: webPeerOf(req as never) }); },
      create: ((cb: any) => { handler = cb; return { on() {}, setTimeout() {}, listen() {}, close() {}, closeAllConnections() {} }; }) as never });
    g.setHost(pinned);
    const send = (headers: Record<string, string>) => {
      let status = 0;
      handler({ url: "/signin", method: "GET", headers, socket: { remoteAddress: "127.0.0.1" } }, { setHeader() {}, writeHead(c: number) { status = c; }, end() {} });
      return status;
    };
    return { seen, send };
  }
  it("named gateway, its exact host: named (peer named_link); spoofed Origin / forwarding headers change nothing", () => {
    const g = gateway(HOST, HOST);
    g.send({ host: HOST });
    g.send({ host: HOST, origin: "https://evil.example", "x-forwarded-host": "evil.example", forwarded: "host=evil.example" });
    expect(g.seen).toEqual([{ named: true, peer: "named_link" }, { named: true, peer: "named_link" }]);
  });
  it("another Host is the gateway's 403 (never dispatched); a named gateway pinned to a trycloudflare name is not named", () => {
    const g = gateway(HOST, HOST);
    expect([g.send({ host: "other.example.com" }), g.seen]).toEqual([403, []]);
    const quickPinned = gateway(HOST, "abc-def.trycloudflare.com");
    quickPinned.send({ host: "abc-def.trycloudflare.com" });
    expect(quickPinned.seen).toEqual([{ named: false, peer: "quick_link" }]);              // §0.3: the temporary link
  });
  it("a quick tunnel (no hostname) is never named", () => {
    const g = gateway(undefined, "abc-def.trycloudflare.com");
    g.send({ host: "abc-def.trycloudflare.com", "x-forwarded-host": HOST });
    expect(g.seen).toEqual([{ named: false, peer: "quick_link" }]);
  });
});

describe("admission (§3 with §0.2)", () => {
  const HOUR = 3_600_000, T0 = 1_800_000_000_000;
  const session = (surface: "gateway" | "local") => ({ handle: "h1", tier: "admin", surface, tokenEpoch: "E", owner: { adapterId: "dc", userId: "7" }, created: T0 } as any);
  const auth = { handle: "h1", owner: { adapterId: "dc", userId: "7" }, authorizedAt: T0, until: T0 + 48 * HOUR, epoch: 2 };
  const input = (over: Partial<WebAuthorityInput> & { namedLink?: boolean; loopbackOnly?: boolean } = {}): WebAuthorityInput => ({
    session: session("gateway"), gateway: true, peer: "named_link", tokenEpoch: "E", isAdmin: () => true, authorization: auth,
    policy: { enabled: true, loopbackOnly: over.loopbackOnly ?? false, namedLink: over.namedLink ?? true, quickLink: false, maxSessionMs: 48 * HOUR }, epoch: 2, now: T0 + HOUR, ...over });
  // §0.3: a quick tunnel's request is `quick_link` (its own option, tests/web-authority-quick-link.test.ts); a gateway
  // request with a local peer is never produced (webPeerOf), and is refused.
  it("a gateway request whose peer is local (never produced): public_link, option on or off", () => {
    for (const namedLink of [true, false]) expect(evaluateWebAuthority(input({ peer: "lan", namedLink })).refusal).toBe("public_link");
  });
  it("the named link: option off → named_link_off; loopback_only on → loopback_only (it still wins)", () => {
    expect([evaluateWebAuthority(input({ namedLink: false })).refusal, evaluateWebAuthority(input({ loopbackOnly: true })).refusal]).toEqual(["named_link_off", "loopback_only"]);
  });
  it("option on: web-verified, peer named_link; every other §3 check still applies", () => {
    const ok = evaluateWebAuthority(input());
    expect([ok.refusal, ok.authority.kind, ok.authority.session?.peer]).toEqual([null, "web-verified", "named_link"]);
    expect(evaluateWebAuthority(input({ isAdmin: () => false })).refusal).toBe("not_admin");
    expect(evaluateWebAuthority(input({ authorization: null })).refusal).toBe("not_authorized");
    expect(evaluateWebAuthority(input({ tokenEpoch: "other" })).refusal).toBe("token_rotated");
  });
  it("named is never claimed off the gateway, and a local session never rides the gateway (or the reverse)", () => {
    expect(evaluateWebAuthority(input({ gateway: false })).refusal).toBe("public_link");                       // peer named_link, not on the gateway
    expect(evaluateWebAuthority(input({ session: session("local") })).refusal).toBe("public_link");           // a local session over the gateway
    expect(evaluateWebAuthority(input({ gateway: false, peer: "loopback", session: session("gateway") })).refusal).toBe("public_link");
    // A local session that claims the named peer off the gateway: never named, never verified as such.
    expect(evaluateWebAuthority(input({ gateway: false, peer: "named_link", session: session("local") })).refusal).toBe("public_link");
  });
  it("the policy: off by default; only `true` turns it on", () => {
    expect([webAuthorityPolicy(undefined).namedLink, webAuthorityPolicy({ verified_authority: { named_link: "yes" as never } }).namedLink,
      webAuthorityPolicy({ verified_authority: { named_link: true } }).namedLink]).toEqual([false, false, true]);
  });
});

describe("read now (§10 with §0.2)", () => {
  const receipt = (peer: "named_link" | "lan" | "loopback"): HumanAuthority => ({ kind: "web-verified", actor: { adapter_id: "dc", user_id: "7" },
    session: { handle: "h1", peer, signed_in_at: "t", authorized_at: "t" }, authority_epoch: 3 });
  const state = (over: Partial<{ enabled: boolean; loopbackOnly: boolean; namedLink: boolean; epoch: number }> = {}) => ({ enabled: true, loopbackOnly: false, namedLink: true, quickLink: false, epoch: 3, ...over });
  it("option off: a named-link receipt reads as none (named_link_off); lan and loopback ones are untouched", () => {
    expect([authorityNow(receipt("named_link"), state({ namedLink: false })).downgraded, authorityNow(receipt("lan"), state({ namedLink: false })).kind,
      authorityNow(receipt("loopback"), state({ namedLink: false })).kind, authorityNow(receipt("named_link"), state()).kind]).toEqual(["named_link_off", "web-verified", "web-verified", "web-verified"]);
  });
  it("loopback_only on downgrades it as a lan one; a revocation as any", () => {
    expect([authorityNow(receipt("named_link"), state({ loopbackOnly: true })).downgraded, authorityNow(receipt("named_link"), state({ epoch: 4 })).downgraded]).toEqual(["loopback_only", "revoked"]);
  });
});

describe("the state: named_link remembered; back on after it was on moves the epoch", () => {
  function store() {
    const files = new Map<string, string>();
    const s = new AuthorityStateStore("/a.json", { warn() {} }, { read: (p) => { const v = files.get(p); if (v === undefined) throw Object.assign(new Error("x"), { code: "ENOENT" }); return v; }, write: (p, d) => { files.set(p, d); } });
    return { s, files };
  }
  it("first on: no move (nothing local is revoked by opening it); off: no move (its receipts read as none meanwhile); on again: a move", () => {
    const { s, files } = store();
    const base = s.current({}).epoch;
    const first = s.current({ named_link: true });
    const off = s.current({});
    const again = s.current({ named_link: true });
    expect([first.namedLink, first.epoch - base, off.namedLink, off.epoch - base, again.namedLink, again.epoch - base, JSON.parse(files.get("/a.json")!).named_link_seen]).toEqual([true, 0, false, 0, true, 1, true]);
  });
  it("a file from before #2453 (no named_link) reads as off; one that cannot be written counts the option off", () => {
    const files = new Map([["/a.json", JSON.stringify({ v: 1, epoch: 5, enabled: true, loopback_only: false })]]);
    const s = new AuthorityStateStore("/a.json", { warn() {} }, { read: (p) => files.get(p)!, write: () => { throw new Error("read-only"); } });
    expect(s.current({ named_link: true })).toEqual({ enabled: false, loopbackOnly: false, namedLink: false, quickLink: false, epoch: 5 });
  });
});

describe("Settings: on is confirmed and never self-confirmed; off is immediate", () => {
  const FLEET = { defaults: {}, channels: [{ id: "dc", type: "discord", group_id: "G", bot_token_env: "X" }], instances: { a: { working_directory: "/tmp" } } };
  const judge = (va: unknown, current?: Record<string, unknown>) =>
    prepareSettingsEffect("PUT", "/api/settings/fleet/web", { verified_authority: va }, { config: { ...structuredClone(FLEET), web: current ? { verified_authority: current } : {} } as any, classic: {} }).diff;
  it("on: a confirmed change, marked noSelfConfirm — alone, or mixed with keys that are immediate on their own", () => {
    const alone = judge({ named_link: true }), mixed = judge({ named_link: true, loopback_only: true, max_session_hours: 6 });
    expect([alone?.noSelfConfirm, alone?.summary.join("\n").includes("named\\_link"), mixed?.noSelfConfirm]).toEqual([true, true, true]);
  });
  it("off, or nothing about it: immediate (no confirmation, no mark)", () => {
    expect([judge({ named_link: null }, { named_link: true }), judge({ loopback_only: true }), judge({ named_link: true }, { named_link: true })]).toEqual([null, null, null]);
  });
  it("the validator: a boolean only; a known key", () => {
    const v = (named: unknown) => validateFleetConfig({ ...structuredClone(FLEET), web: { verified_authority: { named_link: named } } } as never);
    expect([v(true).valid, v("yes").errors.some(e => e.path === "web.verified_authority.named_link"), v(true).warnings.some(w => w.path === "web.verified_authority.named_link")]).toEqual([true, true, false]);
  });
});

describe("the fleet: a named-link session authorized, and the link's end", () => {
  function fleet(web: Record<string, unknown>) {
    const dir = mkdtempSync(join(tmpdir(), "agend-2453-")); roots.push(dir);
    const fm = new FleetManager(dir), s = fm as any;
    const owner = { id: "owner", type: "telegram", group_id: "G", bot_token_env: "NONE", access: { mode: "open", allowed_users: ["admin"] } };
    fm.fleetConfig = { defaults: {}, channel: owner, channels: [owner], instances: {}, web } as never;
    writeFileSync(join(dir, "web.token"), "c".repeat(48), { mode: 0o600 }); s.initializeWebSessions();
    const gatewaySession = () => s.webSessions.create({ tier: "admin", surface: "gateway", exposureId: "e".repeat(32), label: "phone", tokenEpoch: tokenEpoch("c".repeat(48)), owner: { adapterId: "owner", userId: "admin" } }).record;
    return { fm, s, gatewaySession, close: () => { fm.stormWindow.shutdown(); fm.spawnGate.shutdown(); } };
  }
  const NAMED = (named_link?: boolean) => ({ public_link: { hostname: HOST }, verified_authority: { enabled: true, ...(named_link !== undefined ? { named_link } : {}) } });
  it("option on: authorized by the Confirm path → web-verified, peer named_link; the overview names the host and marks the session", () => {
    const h = fleet(NAMED(true));
    try {
      const rec = h.gatewaySession();
      expect(h.s.authorizeWebSession(rec, "named_link", true)).toMatchObject({ ok: true });
      const v = h.s.webAuthority({ session: rec, gateway: true, peer: "named_link" });
      const o = h.s.webAuthorityOverview();
      expect([v.refusal, v.authority.session?.peer, o.namedHost, o.authorized.map((a: any) => a.named)]).toEqual([null, "named_link", HOST, [true]]);
    } finally { h.close(); }
  });
  it("option off: named_link_off; a quick tunnel: public_link — and a named-link session at the Confirm tap is judged as the gateway request it is", () => {
    const off = fleet(NAMED());
    try {
      const rec = off.gatewaySession();
      expect([off.s.authorizeWebSession(rec, "named_link", true), off.s.authorizeWebSession(rec, "lan", true)]).toEqual([{ ok: false, refusal: "named_link_off" }, { ok: false, refusal: "public_link" }]);
      const pending = off.s.sessionAuthorizationRequests();
      expect(pending).toBeTruthy();
    } finally { off.close(); }
  });
  it("the Confirm tap (the requests' authorize, as the button calls it) judges a named-link session as the gateway request it is; its card says where", () => {
    const h = fleet(NAMED(true));
    try {
      const rec = h.gatewaySession();
      const deps = h.s.sessionAuthorizationRequests().deps;
      const tapped = deps.authorize(rec.handle, "named_link");
      const ask = deps.text.ask({ label: "phone", peer: "named_link", askedAt: Date.now(), until: Date.now() + 1000 });
      expect([tapped.ok, h.s.webAuthority({ session: rec, gateway: true, peer: "named_link" }).authority.kind, ask.includes(HOST), ask.includes("the internet")]).toEqual([true, "web-verified", true, true]);
    } finally { h.close(); }
  });
  // Fable's #2464 review: the option off then on again with nothing reading authority in between must not bring a
  // named-link session's authority back. Every configuration change is observed (a Settings save — the PUT, a confirmed
  // change's apply, the host's confirm — and a reload), and off drops the named-link sessions' authorizations.
  for (const readWhileOff of [false, true]) it(`off → on through Settings saves, ${readWhileOff ? "read" : "nothing read"} while off: the old session needs a new Confirm`, () => {
    const h = fleet(NAMED(true));
    try {
      const rec = h.gatewaySession();
      expect(h.s.authorizeWebSession(rec, "named_link", true)).toMatchObject({ ok: true });
      const before = h.s.webAuthority({ session: rec, gateway: true, peer: "named_link" });
      h.s.fleetConfig.web.verified_authority.named_link = false; h.s.saveFleetConfig();       // off (immediate)
      if (readWhileOff) h.s.webAuthority({ session: rec, gateway: true, peer: "named_link" });
      h.s.fleetConfig.web.verified_authority.named_link = true; h.s.saveFleetConfig();        // on again (after its confirmation)
      const after = h.s.webAuthority({ session: rec, gateway: true, peer: "named_link" });
      expect([before.authority.kind, after.authority.kind, after.refusal]).toEqual(["web-verified", "none", "not_authorized"]);
    } finally { h.close(); }
  });
  it("the same gap for the server switch (enabled off → on, nothing read between): every older authority stays revoked", () => {
    const h = fleet(NAMED(false));
    try {
      const local = h.s.webSessions.create({ tier: "admin", surface: "local", label: "desk", tokenEpoch: tokenEpoch("c".repeat(48)), owner: { adapterId: "owner", userId: "admin" } }).record;
      expect(h.s.authorizeWebSession(local, "loopback", false)).toMatchObject({ ok: true });
      h.s.fleetConfig.web.verified_authority.enabled = false; h.s.saveFleetConfig();
      h.s.fleetConfig.web.verified_authority.enabled = true; h.s.saveFleetConfig();
      expect(h.s.webAuthority({ session: local, gateway: false, peer: "loopback" }).refusal).toBe("not_authorized");
    } finally { h.close(); }
  });
  it("off drops the named-link sessions' authorizations at once (local ones stay)", () => {
    const h = fleet(NAMED(true));
    try {
      const rec = h.gatewaySession();
      const local = h.s.webSessions.create({ tier: "admin", surface: "local", label: "desk", tokenEpoch: tokenEpoch("c".repeat(48)), owner: { adapterId: "owner", userId: "admin" } }).record;
      expect([h.s.authorizeWebSession(rec, "named_link", true).ok, h.s.authorizeWebSession(local, "loopback", false).ok]).toEqual([true, true]);
      h.s.fleetConfig.web.verified_authority.named_link = false; h.s.saveFleetConfig();
      expect([h.s.sessionAuthorizationStore().get(rec.handle) ?? null, !!h.s.sessionAuthorizationStore().get(local.handle)]).toEqual([null, true]);
    } finally { h.close(); }
  });
  it("…and through a reload (fleet.yaml edited off, then on): the same", () => {
    const h = fleet(NAMED(true));
    try {
      const path = join(h.fm.dataDir as string, "fleet.yaml");
      const write = (on: boolean) => writeFileSync(path, `channel: { id: owner, type: telegram, group_id: G, bot_token_env: NONE, access: { mode: open, allowed_users: [admin] } }\ninstances: {}\nweb:\n  public_link: { hostname: ${HOST} }\n  verified_authority: { enabled: true, named_link: ${on} }\n`);
      const rec = h.gatewaySession();
      expect(h.s.authorizeWebSession(rec, "named_link", true)).toMatchObject({ ok: true });
      write(false); h.fm.loadConfig(path);
      write(true); h.fm.loadConfig(path);
      const after = h.s.webAuthority({ session: rec, gateway: true, peer: "named_link" });
      expect([after.authority.kind, after.refusal]).toEqual(["none", "not_authorized"]);
    } finally { h.close(); }
  });
  it("the link's end (its exposure revoked): its sessions' authorizations go with it; a local one stays", () => {
    const h = fleet(NAMED(true));
    try {
      const rec = h.gatewaySession();
      const local = h.s.webSessions.create({ tier: "admin", surface: "local", label: "desk", tokenEpoch: tokenEpoch("c".repeat(48)), owner: { adapterId: "owner", userId: "admin" } }).record;
      expect(h.s.authorizeWebSession(rec, "named_link", true)).toMatchObject({ ok: true });
      expect(h.s.authorizeWebSession(local, "loopback", false)).toMatchObject({ ok: true });
      h.s.getPublicWebLink().deps.revoke("e".repeat(32));
      expect([h.s.sessionAuthorizationStore().get(rec.handle) ?? null, !!h.s.sessionAuthorizationStore().get(local.handle)]).toEqual([null, true]);
    } finally { h.close(); }
  });
});
