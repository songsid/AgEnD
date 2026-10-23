/**
 * Design #1939 §0.3: "Authorize this browser" over the temporary public link (the quick tunnel `/web` opens) — opt-in
 * (`web.verified_authority.quick_link`), off by default (the user's decision, 2026-10-23). The acceptance list of §0.3:
 * - Provenance: a gateway request that is not named is `quick_link`, from the listener alone (never a header).
 * - Admission: option off → quick_link_off; loopback_only on → loopback_only; on → the same §3 checks as local, peer
 *   `quick_link`; never claimed off the gateway. Each link's option is its own.
 * - Read now: option off → its receipts read as none (quick_link_off) at once; back on (it was on before) moves the epoch.
 * - Settings: an effective widening (false → true) is confirmed and marked never self-confirmed, alone or mixed; off is
 *   immediate; null / a removed key is a no-op with the release default, and a widening if the default were true.
 * - The fleet: a quick-link session authorized by the Confirm path is web-verified with peer quick_link; off drops only
 *   the quick-link sessions' authorizations; the link's end takes them too.
 * Real modules; temp homes only (no fleet started, no tunnel, no network).
 */
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
import { createPublicWebGateway, isPublicWebRoute } from "../src/public-web-gateway.js";
import { gatewayRequestContext } from "../src/web-request-context.js";
import { webPeerOf } from "../src/web-api.js";
import { authorityNow, evaluateWebAuthority, isHumanAuthority, QUICK_LINK_DEFAULT, quickLinkEffective, webAuthorityPolicy, type HumanAuthority, type WebAuthorityInput } from "../src/authority/web-authority.js";
import { AuthorityStateStore } from "../src/authority/authority-state.js";
import { SessionAuthorizations } from "../src/authority/session-authorizations.js";
import { prepareSettingsEffect } from "../src/settings-effect.js";
import { validateFleetConfig } from "../src/config-validator.js";
import { FleetManager } from "../src/fleet-manager.js";
import { tokenEpoch } from "../src/web-session.js";

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); vi.restoreAllMocks(); vi.doUnmock("../src/authority/web-authority.js"); });
const QUICK = "abc-def.trycloudflare.com", NAMED_HOST = "agend.example.com";

describe("provenance: a gateway request that is not named is the quick link", () => {
  function gateway(hostname: string | undefined, pinned: string) {
    let handler!: (req: any, res: any) => void;
    const seen: string[] = [];
    const g = createPublicWebGateway({ exposureId: "e1", ...(hostname ? { hostname } : {}), isCurrent: () => true, isOpen: () => true,
      dispatch: (req) => { seen.push(webPeerOf(req as never)); },
      create: ((cb: any) => { handler = cb; return { on() {}, setTimeout() {}, listen() {}, close() {}, closeAllConnections() {} }; }) as never });
    g.setHost(pinned);
    const send = (headers: Record<string, string>) => {
      handler({ url: "/signin", method: "GET", headers, socket: { remoteAddress: "127.0.0.1" } }, { setHeader() {}, writeHead() {}, end() {} });
    };
    return { seen, send };
  }
  it("a quick tunnel: quick_link, whatever its headers say (Origin, X-Forwarded-Host, Forwarded naming the named host)", () => {
    const g = gateway(undefined, QUICK);
    g.send({ host: QUICK });
    g.send({ host: QUICK, origin: `https://${NAMED_HOST}`, "x-forwarded-host": NAMED_HOST, forwarded: `host=${NAMED_HOST}` });
    expect(g.seen).toEqual(["quick_link", "quick_link"]);
  });
  it("the browser asks over the link: /ui/authorization (its state, and the ask for a Confirm card) is a public route — nothing else of it", () => {
    expect([isPublicWebRoute("GET", "/ui/authorization"), isPublicWebRoute("POST", "/ui/authorization"), isPublicWebRoute("PUT", "/ui/authorization"),
      isPublicWebRoute("DELETE", "/ui/authorization"), isPublicWebRoute("GET", "/ui/authorization/x")]).toEqual([true, true, false, false, false]);
  });
  it("off the gateway a request is never quick: loopback (127.0.0.1, a loopback Host) or lan", () => {
    const local = { headers: { host: "127.0.0.1:19280" }, socket: { remoteAddress: "127.0.0.1" } } as never;
    expect([gatewayRequestContext(local), webPeerOf(local)]).toEqual([undefined, "loopback"]);
  });
});

describe("admission (§3 with §0.3)", () => {
  const HOUR = 3_600_000, T0 = 1_800_000_000_000;
  const session = (surface: "gateway" | "local") => ({ handle: "h1", tier: "admin", surface, tokenEpoch: "E", owner: { adapterId: "dc", userId: "7" }, created: T0 } as any);
  const auth = { handle: "h1", owner: { adapterId: "dc", userId: "7" }, authorizedAt: T0, until: T0 + 48 * HOUR, epoch: 2 };
  const input = (over: Partial<WebAuthorityInput> & { quickLink?: boolean; namedLink?: boolean; loopbackOnly?: boolean } = {}): WebAuthorityInput => ({
    session: session("gateway"), gateway: true, peer: "quick_link", tokenEpoch: "E", isAdmin: () => true, authorization: auth,
    policy: { enabled: true, loopbackOnly: over.loopbackOnly ?? false, namedLink: over.namedLink ?? false, quickLink: over.quickLink ?? true, maxSessionMs: 48 * HOUR },
    epoch: 2, now: T0 + HOUR, ...over });
  it("option off: quick_link_off; loopback_only on: loopback_only (it still wins)", () => {
    expect([evaluateWebAuthority(input({ quickLink: false })).refusal, evaluateWebAuthority(input({ loopbackOnly: true })).refusal]).toEqual(["quick_link_off", "loopback_only"]);
  });
  it("option on: web-verified, peer quick_link; every other §3 check still applies", () => {
    const ok = evaluateWebAuthority(input());
    expect([ok.refusal, ok.authority.kind, ok.authority.session?.peer]).toEqual([null, "web-verified", "quick_link"]);
    expect(evaluateWebAuthority(input({ isAdmin: () => false })).refusal).toBe("not_admin");
    expect(evaluateWebAuthority(input({ authorization: null })).refusal).toBe("not_authorized");
    expect(evaluateWebAuthority(input({ tokenEpoch: "other" })).refusal).toBe("token_rotated");
  });
  it("each link's option is its own: named on never opens the quick link, quick on never opens the named one", () => {
    expect([evaluateWebAuthority(input({ quickLink: false, namedLink: true })).refusal,
      evaluateWebAuthority(input({ peer: "named_link", quickLink: true, namedLink: false })).refusal]).toEqual(["quick_link_off", "named_link_off"]);
  });
  it("quick is never claimed off the gateway, and a local session never rides the gateway", () => {
    expect(evaluateWebAuthority(input({ gateway: false })).refusal).toBe("public_link");
    expect(evaluateWebAuthority(input({ gateway: false, session: session("local") })).refusal).toBe("public_link");
    expect(evaluateWebAuthority(input({ session: session("local") })).refusal).toBe("public_link");
  });
  it("the policy: off by default (the release default is false); only `true` turns it on", () => {
    expect([QUICK_LINK_DEFAULT, webAuthorityPolicy(undefined).quickLink, webAuthorityPolicy({ verified_authority: { quick_link: "yes" as never } }).quickLink,
      webAuthorityPolicy({ verified_authority: { quick_link: true } }).quickLink]).toEqual([false, false, false, true]);
  });
  it("the value in force: explicit, else the default — a key removed inherits it", () => {
    expect([quickLinkEffective({}), quickLinkEffective({ quick_link: false }), quickLinkEffective({ quick_link: true }), quickLinkEffective({}, true),
      quickLinkEffective({ quick_link: false }, true), quickLinkEffective(undefined)]).toEqual([false, false, true, true, false, false]);
  });
});

describe("read now (§10 with §0.3)", () => {
  const receipt = (peer: "quick_link" | "named_link" | "lan" | "loopback"): HumanAuthority => ({ kind: "web-verified", actor: { adapter_id: "dc", user_id: "7" },
    session: { handle: "h1", peer, signed_in_at: "t", authorized_at: "t" }, authority_epoch: 3 });
  const state = (over: Partial<{ enabled: boolean; loopbackOnly: boolean; namedLink: boolean; quickLink: boolean; epoch: number }> = {}) =>
    ({ enabled: true, loopbackOnly: false, namedLink: true, quickLink: true, epoch: 3, ...over });
  it("option off: a quick-link receipt reads as none (quick_link_off); named, lan and loopback ones are untouched", () => {
    const off = state({ quickLink: false });
    expect([authorityNow(receipt("quick_link"), off).downgraded, authorityNow(receipt("named_link"), off).kind, authorityNow(receipt("lan"), off).kind,
      authorityNow(receipt("loopback"), off).kind, authorityNow(receipt("quick_link"), state()).kind]).toEqual(["quick_link_off", "web-verified", "web-verified", "web-verified", "web-verified"]);
  });
  it("loopback_only on downgrades it as a lan one; a revocation as any; the receipt shape accepts the peer", () => {
    expect([authorityNow(receipt("quick_link"), state({ loopbackOnly: true })).downgraded, authorityNow(receipt("quick_link"), state({ epoch: 4 })).downgraded,
      isHumanAuthority(receipt("quick_link"))]).toEqual(["loopback_only", "revoked", true]);
  });
});

describe("the state: quick_link remembered; back on after it was on moves the epoch", () => {
  function store() {
    const files = new Map<string, string>();
    const s = new AuthorityStateStore("/a.json", { warn() {} }, { read: (p) => { const v = files.get(p); if (v === undefined) throw Object.assign(new Error("x"), { code: "ENOENT" }); return v; }, write: (p, d) => { files.set(p, d); } });
    return { s, files };
  }
  // §0.3 (#2525 review): every widening moves the epoch in the same write — the first one too (unlike the named link).
  it("every on moves the epoch, the first one too; off: no move, and the read says it closed", () => {
    const { s, files } = store();
    const base = s.current({}).epoch;
    const first = s.current({ quick_link: true });
    const off = s.current({});
    const again = s.current({ quick_link: true });
    const same = s.current({ quick_link: true });
    expect([first.quickLink, first.epoch - base, off.quickLink, off.epoch - base, off.quickLinkClosed, again.epoch - base, same.epoch - base, JSON.parse(files.get("/a.json")!).epoch - base])
      .toEqual([true, 1, false, 1, true, 2, 2, 2]);
  });
  it("a warm store (epoch 7): unset → on and explicit false → on each move it, on disk too", () => {
    for (const before of [{}, { quick_link: false }]) {
      const files = new Map([["/a.json", JSON.stringify({ v: 1, epoch: 7, enabled: true, loopback_only: false })]]);
      const s = new AuthorityStateStore("/a.json", { warn() {} }, { read: (p) => files.get(p)!, write: (p, d) => { files.set(p, d); } });
      expect(s.current(before).epoch, JSON.stringify(before)).toBe(7);
      expect([s.current({ quick_link: true }).epoch, JSON.parse(files.get("/a.json")!).epoch], JSON.stringify(before)).toEqual([8, 8]);
    }
  });
  it("each link remembered on its own: the named one's first on does not move it, the quick one's does; the named one back on does", () => {
    const { s } = store();
    const base = s.current({ named_link: true }).epoch;
    s.current({});
    expect([s.current({ quick_link: true }).epoch - base, s.current({ quick_link: true, named_link: true }).epoch - base]).toEqual([1, 2]);
  });
  it("a file from before §0.3 (no quick_link) reads as off; one that cannot be written counts the option off", () => {
    const files = new Map([["/a.json", JSON.stringify({ v: 1, epoch: 5, enabled: true, loopback_only: false, named_link: true, named_link_seen: true })]]);
    const s = new AuthorityStateStore("/a.json", { warn() {} }, { read: (p) => files.get(p)!, write: () => { throw new Error("read-only"); } });
    // Turning it on moves the epoch (§0.3) even while the state can't be written: never back to an older one.
    expect(s.current({ quick_link: true, named_link: true })).toEqual({ enabled: false, loopbackOnly: false, namedLink: false, quickLink: false, epoch: 6 });
  });
});

describe("Settings: an effective widening is confirmed and never self-confirmed; off is immediate", () => {
  const FLEET = { defaults: {}, channels: [{ id: "dc", type: "discord", group_id: "G", bot_token_env: "X" }], instances: { a: { working_directory: "/tmp" } } };
  const judgeWith = (prepare: typeof prepareSettingsEffect) => (va: unknown, current?: Record<string, unknown>) =>
    prepare("PUT", "/api/settings/fleet/web", { verified_authority: va }, { config: { ...structuredClone(FLEET), web: current ? { verified_authority: current } : {} } as any, classic: {} }).diff;
  const judge = judgeWith(prepareSettingsEffect);
  it("on: a confirmed change, marked noSelfConfirm — alone, or mixed with keys that are immediate on their own", () => {
    const alone = judge({ quick_link: true }), mixed = judge({ quick_link: true, loopback_only: true, max_session_hours: 6 }), fromFalse = judge({ quick_link: true }, { quick_link: false });
    expect([alone?.noSelfConfirm, alone?.summary.join("\n").includes("quick\\_link"), mixed?.noSelfConfirm, fromFalse?.noSelfConfirm]).toEqual([true, true, true, true]);
  });
  it("off, a re-save, or a removed key (it inherits false): immediate (no confirmation, no mark)", () => {
    expect([judge({ quick_link: null }, { quick_link: true }), judge({ quick_link: true }, { quick_link: true }), judge({ quick_link: null }, { quick_link: false }),
      judge({ loopback_only: true })]).toEqual([null, null, null, null]);
  });
  it("the guard (§0.3): with the default forced true, removing an explicit false is a widening too — confirmed, marked", async () => {
    vi.resetModules();
    vi.doMock("../src/authority/web-authority.js", async (orig) => {
      const m = await orig<typeof import("../src/authority/web-authority.js")>();
      return { ...m, QUICK_LINK_DEFAULT: true, quickLinkEffective: (v: never, fallback = true) => m.quickLinkEffective(v, fallback) };
    });
    const forced = judgeWith((await import("../src/settings-effect.js")).prepareSettingsEffect);
    const removed = forced({ quick_link: null }, { quick_link: false });
    expect([removed?.noSelfConfirm, forced({ quick_link: null }, { quick_link: true })]).toEqual([true, null]);
  });
  it("the validator: a boolean only; a known key", () => {
    const v = (quick: unknown) => validateFleetConfig({ ...structuredClone(FLEET), web: { verified_authority: { quick_link: quick } } } as never);
    expect([v(true).valid, v("yes").errors.some(e => e.path === "web.verified_authority.quick_link"), v(true).warnings.some(w => w.path === "web.verified_authority.quick_link")]).toEqual([true, true, false]);
  });
});

describe("the fleet: a quick-link session authorized, and the link's end", () => {
  function fleet(web: Record<string, unknown>) {
    const dir = mkdtempSync(join(tmpdir(), "agend-quick-")); roots.push(dir);
    const fm = new FleetManager(dir), s = fm as any;
    const owner = { id: "owner", type: "telegram", group_id: "G", bot_token_env: "NONE", access: { mode: "open", allowed_users: ["admin"] } };
    fm.fleetConfig = { defaults: {}, channel: owner, channels: [owner], instances: {}, web } as never;
    writeFileSync(join(dir, "web.token"), "c".repeat(48), { mode: 0o600 }); s.initializeWebSessions();
    const gatewaySession = (label = "phone") => s.webSessions.create({ tier: "admin", surface: "gateway", exposureId: "e".repeat(32), label, tokenEpoch: tokenEpoch("c".repeat(48)), owner: { adapterId: "owner", userId: "admin" } }).record;
    const localSession = () => s.webSessions.create({ tier: "admin", surface: "local", label: "desk", tokenEpoch: tokenEpoch("c".repeat(48)), owner: { adapterId: "owner", userId: "admin" } }).record;
    return { fm, s, gatewaySession, localSession, close: () => { fm.stormWindow.shutdown(); fm.spawnGate.shutdown(); } };
  }
  const VA = (va: Record<string, unknown>) => ({ public_link: { hostname: NAMED_HOST }, verified_authority: { enabled: true, ...va } });
  it("option on: authorized by the Confirm path → web-verified, peer quick_link; the overview marks the session quick", () => {
    const h = fleet(VA({ quick_link: true }));
    try {
      const rec = h.gatewaySession();
      expect(h.s.authorizeWebSession(rec, "quick_link", true)).toMatchObject({ ok: true });
      const v = h.s.webAuthority({ session: rec, gateway: true, peer: "quick_link" });
      const o = h.s.webAuthorityOverview();
      expect([v.refusal, v.authority.session?.peer, o.authorized.map((a: any) => [a.quick, a.named]), h.s.sessionAuthorizationStore().get(rec.handle)?.peer])
        .toEqual([null, "quick_link", [[true, undefined]], "quick_link"]);
    } finally { h.close(); }
  });
  it("option off (the default): quick_link_off, at the Confirm tap too", () => {
    const h = fleet(VA({}));
    try {
      const rec = h.gatewaySession();
      expect([h.s.authorizeWebSession(rec, "quick_link", true), h.s.sessionAuthorizationRequests().deps.authorize(rec.handle, "quick_link")])
        .toEqual([{ ok: false, refusal: "quick_link_off" }, { ok: false, refusal: "quick_link_off" }]);
    } finally { h.close(); }
  });
  it("the Confirm tap judges a quick-link session as the gateway request it is; its card names the link's host and the internet", () => {
    const h = fleet(VA({ quick_link: true }));
    try {
      const rec = h.gatewaySession();
      h.s.publicWebLink = { openSignin: () => ({ exposureId: "e".repeat(32), url: `https://${QUICK}/`, owner: {} }) };
      const deps = h.s.sessionAuthorizationRequests().deps;
      const tapped = deps.authorize(rec.handle, "quick_link");
      const ask = deps.text.ask({ label: "phone", peer: "quick_link", askedAt: Date.now(), until: Date.now() + 1000 });
      expect([tapped.ok, h.s.webAuthority({ session: rec, gateway: true, peer: "quick_link" }).authority.kind, ask.includes(QUICK), ask.includes("the internet"), ask.includes("temporary public link")])
        .toEqual([true, "web-verified", true, true, true]);
    } finally { h.close(); }
  });
  for (const readWhileOff of [false, true]) it(`off → on through Settings saves, ${readWhileOff ? "read" : "nothing read"} while off: the old session needs a new Confirm`, () => {
    const h = fleet(VA({ quick_link: true }));
    try {
      const rec = h.gatewaySession();
      expect(h.s.authorizeWebSession(rec, "quick_link", true)).toMatchObject({ ok: true });
      const before = h.s.webAuthority({ session: rec, gateway: true, peer: "quick_link" });
      delete h.s.fleetConfig.web.verified_authority.quick_link; h.s.saveFleetConfig();       // off (removed: the default)
      if (readWhileOff) h.s.webAuthority({ session: rec, gateway: true, peer: "quick_link" });
      h.s.fleetConfig.web.verified_authority.quick_link = true; h.s.saveFleetConfig();      // on again (after its confirmation)
      const after = h.s.webAuthority({ session: rec, gateway: true, peer: "quick_link" });
      expect([before.authority.kind, after.authority.kind, after.refusal]).toEqual(["web-verified", "none", "not_authorized"]);
    } finally { h.close(); }
  });
  // Each link's option off drops only its own sessions' authorizations (each case a fresh fleet: turning one back on
  // after it was on moves the epoch, which ends every older authorization by design).
  for (const off of ["quick_link", "named_link"] as const) it(`${off} off drops only its own sessions' authorizations; the other link's and the local ones stay`, () => {
    const h = fleet(VA({ quick_link: true, named_link: true }));
    try {
      const quick = h.gatewaySession("phone"), named = h.gatewaySession("tablet"), local = h.localSession();
      expect([h.s.authorizeWebSession(quick, "quick_link", true).ok, h.s.authorizeWebSession(named, "named_link", true).ok, h.s.authorizeWebSession(local, "loopback", false).ok]).toEqual([true, true, true]);
      const has = (r: { handle: string }) => !!h.s.sessionAuthorizationStore().get(r.handle);
      h.s.fleetConfig.web.verified_authority[off] = false; h.s.saveFleetConfig();
      expect([has(quick), has(named), has(local)]).toEqual(off === "quick_link" ? [false, true, true] : [true, false, true]);
    } finally { h.close(); }
  });
  it("a gateway record from before §0.3 (no peer) counts as named: the named option off drops it, the quick one off keeps it", () => {
    const h = fleet(VA({ quick_link: true, named_link: true }));
    try {
      const rec = h.gatewaySession();
      const store: SessionAuthorizations = h.s.sessionAuthorizationStore();
      const epoch = h.s.webAuthorityState().epoch, now = Date.now();
      store.authorize(rec.handle, { adapterId: "owner", userId: "admin" }, now, epoch, now + 3_600_000);            // no peer
      h.s.fleetConfig.web.verified_authority.quick_link = false; h.s.saveFleetConfig();
      const kept = !!store.get(rec.handle);
      h.s.fleetConfig.web.verified_authority.named_link = false; h.s.saveFleetConfig();
      expect([kept, !!store.get(rec.handle)]).toEqual([true, false]);
    } finally { h.close(); }
  });
  it("the link's end (its exposure revoked): its sessions' authorizations go with it; a local one stays", () => {
    const h = fleet(VA({ quick_link: true }));
    try {
      const rec = h.gatewaySession(), local = h.localSession();
      expect([h.s.authorizeWebSession(rec, "quick_link", true).ok, h.s.authorizeWebSession(local, "loopback", false).ok]).toEqual([true, true]);
      h.s.getPublicWebLink().deps.revoke("e".repeat(32));
      expect([h.s.sessionAuthorizationStore().get(rec.handle) ?? null, !!h.s.sessionAuthorizationStore().get(local.handle)]).toEqual([null, true]);
    } finally { h.close(); }
  });
});
