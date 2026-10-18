/**
 * #1939 S2a (server): Settings → Web → Web authority (design §0, §3, §10).
 * - PUT /api/settings/fleet/web takes `verified_authority`: enabled / loopback_only (boolean, null = default),
 *   max_session_hours (number, null = default).
 * - Judged by what it lets web messages carry: the switch on, loopback_only off, a longer authorization wait for a
 *   General admin; the reverse of each applies at once.
 * - GET /api/settings/web-authority (what is in force, the authorized sessions) and POST …/revoke (at once, the caller
 *   asked again after the body). Never over the public link.
 * Rig: the real classifier and projection; the real gate in front of the real handler on a fleet.yaml on disk (as
 * web-guest-settings-1920); a real FleetManager for the overview and the live revoke.
 */
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import yaml from "js-yaml";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("../src/logger.js", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child() { return this; } }),
  rotateLogIfNeeded: () => { throw new Error("log rotation is outside this harness"); },
  rotateLogIfNeededAsync: async () => { throw new Error("log rotation is outside this harness"); },
}));
vi.mock("node:child_process", async importOriginal => {
  const original = await importOriginal<typeof import("node:child_process")>();
  const blocked = () => { throw new Error("process execution is outside this harness"); };
  return { ...original, spawn: blocked, spawnSync: blocked, exec: blocked, execSync: blocked, execFile: blocked, execFileSync: blocked, fork: blocked };
});
vi.mock("../src/backend/index.js", async original => ({ ...await original<typeof import("../src/backend/index.js")>(), createBackend: () => { throw Error("No backend"); } }));
vi.mock("../src/tmux-manager.js", async original => ({ ...await original<typeof import("../src/tmux-manager.js")>(), TmuxManager: new Proxy({}, { get: () => () => { throw Error("No tmux"); } }) }));
import { FleetManager } from "../src/fleet-manager.js";
import { WebSessionStore, csrfTokenFor, tokenEpoch } from "../src/web-session.js";
import { WEB_CSRF_HEADER, WEB_SESSION_COOKIE } from "../src/web-auth.js";
import { SettingsConfirmationStore } from "../src/settings-confirmation.js";
import { SettingsHttpConfirmation } from "../src/settings-http-confirmation.js";
import { SettingsBaselines } from "../src/settings-baseline.js";
import { handleSettingsRequest, type SettingsApiContext } from "../src/settings-api.js";
import { prepareSettingsEffect } from "../src/settings-effect.js";
import { noteSettingsWrite } from "../src/settings-transaction.js";
import { bindGatewayRequest } from "../src/web-request-context.js";
import { applyVerifiedAuthorityPatch, parseWebSettingsBody, verifiedAuthorityPatch } from "../src/web-settings-patch.js";

const roots: string[] = [], stores: SettingsConfirmationStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 5 }); });

const WEB = "/api/settings/fleet/web";
const FLEET = { channels: [{ id: "dc", type: "discord", group_id: "G", bot_token_env: "X" }], instances: { a: { working_directory: "/tmp" } } };
const judge = (va: unknown, current?: Record<string, unknown>) =>
  prepareSettingsEffect("PUT", WEB, { verified_authority: va }, { config: { defaults: {}, ...structuredClone(FLEET), web: current ? { verified_authority: current } : {} } as any, classic: {} }).diff;
const named = (d: any) => d?.summary.slice(1).join("\n") ?? null;

describe("the verified_authority patch", () => {
  it("reads each key; null is the default", () => {
    expect(verifiedAuthorityPatch(undefined)).toBeNull();
    expect(verifiedAuthorityPatch({})).toBeNull();
    expect(verifiedAuthorityPatch({ enabled: true, loopback_only: null, max_session_hours: 12 })).toEqual({ enabled: true, loopback_only: null, max_session_hours: 12 });
  });
  it.each([
    ["not an object", []], ["an unknown key", { other: 1 }], ["a non-boolean switch", { enabled: "yes" }], ["a non-boolean loopback_only", { loopback_only: 1 }],
    ["a non-number age", { max_session_hours: "4" }], ["an infinite age", { max_session_hours: Infinity }], ["a step-up list (§0: none)", { step_up: { enforce: ["merge"] } }],
  ])("refuses %s", (_n, raw) => {
    expect(verifiedAuthorityPatch(raw)).toBe("invalid");
    expect(parseWebSettingsBody({ verified_authority: raw })).toEqual({ error: expect.stringContaining("verified_authority") });
  });
  it("applies: values set and removed, the file edits named; the input is copied", () => {
    const current = { enabled: true, loopback_only: true };
    const r = applyVerifiedAuthorityPatch(current, { enabled: null, max_session_hours: 6 });
    expect(r.next).toEqual({ loopback_only: true, max_session_hours: 6 });
    expect(r.changes).toEqual([
      { path: ["web", "verified_authority", "enabled"], value: undefined, remove: true },
      { path: ["web", "verified_authority", "max_session_hours"], value: 6 },
    ]);
    expect(current).toEqual({ enabled: true, loopback_only: true });
    expect(applyVerifiedAuthorityPatch({ enabled: true }, { enabled: null }).next).toBeUndefined();
  });
});

describe("§0.1: every change applies at once (none grants anything without the account's Confirm)", () => {
  it("on, off, loopback_only either way, longer or shorter hours, back to the defaults: nothing to confirm", () => {
    for (const [change, current] of [
      [{ enabled: false }, undefined], [{ enabled: null }, { enabled: false }], [{ enabled: true }, { enabled: false }],
      [{ loopback_only: true }, undefined], [{ loopback_only: null }, { loopback_only: true }],
      [{ max_session_hours: 24 }, { max_session_hours: 12 }], [{ max_session_hours: 6 }, undefined], [{ max_session_hours: null }, { max_session_hours: 12 }],
      [{ enabled: false, loopback_only: null }, { enabled: true, loopback_only: true }],
    ] as const) expect(judge(change, current as never), JSON.stringify([change, current])).toBeNull();
  });
  it("an age the validator refuses is never proposed (the gate refuses the whole change)", () => {
    expect(() => judge({ max_session_hours: 100 }, { max_session_hours: 12 })).toThrow(/invalid_settings_effect/);
    expect(() => judge({ max_session_hours: 0.5 }, { max_session_hours: 12 })).toThrow(/invalid_settings_effect/);
  });
});

function harness(fleet: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), "agend-test-1939s-")); roots.push(root);
  const path = join(root, "fleet.yaml");
  const config: any = { defaults: {}, ...structuredClone(FLEET), ...structuredClone(fleet) };
  writeFileSync(path, yaml.dump(config));
  let revision = 0;
  const save = vi.fn(() => { noteSettingsWrite(path, yaml.load(readFileSync(path, "utf8")), config); writeFileSync(path, yaml.dump(config)); revision++; });
  const overview = vi.fn(() => ({ state: { enabled: false, loopbackOnly: false, epoch: 0 } }));
  const revoke = vi.fn(() => ({ epoch: 3, durable: true }));
  const TOKEN = "c".repeat(48), sessions = new WebSessionStore();
  const sid = sessions.create({ tier: "admin", surface: "local", label: "admin", tokenEpoch: tokenEpoch(TOKEN) }).sessionId as string;
  const guestSid = sessions.create({ tier: "guest", surface: "local", label: "guest", tokenEpoch: tokenEpoch(TOKEN), owner: { adapterId: "dc", userId: "999" } }).sessionId as string;
  const ctx = { fleetConfig: config, dataDir: root, configPath: path, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, webToken: TOKEN, webSessions: sessions,
    getRawFleetConfig: () => config, saveFleetConfig: save, lifecycle: { isPaused: () => false, pause: vi.fn(), wake: vi.fn() },
    webAuthorityOverview: overview, revokeWebAuthority: revoke } as unknown as SettingsApiContext;
  const store = new SettingsConfirmationStore({ audit: vi.fn() }); stores.push(store);
  const baselines = new SettingsBaselines({ dataDir: root, configPath: () => path, config: () => config, current: () => revision });
  const gate = new SettingsHttpConfirmation(store, {
    principal: req => req.headers.cookie ? { id: "session-a", label: "browser", source: "web_session", current: () => true } : null,
    baseline: () => baselines.read(), snapshot: () => baselines.snapshot(),
  });
  function request(method: string, url: string, body?: unknown, opts: { publicLink?: boolean; as?: "admin" | "guest" | "none" } = {}) {
    return new Promise<{ status: number; body: any }>((resolve, reject) => {
      const req = new EventEmitter() as any;
      req.method = method; req.url = url; req.destroy = () => undefined;
      const who = opts.as === "guest" ? guestSid : opts.as === "none" ? "not-a-session" : sid;
      req.headers = { "idempotency-key": `k-${Math.random()}`, host: "localhost", origin: "http://localhost", cookie: `${WEB_SESSION_COOKIE}=${who}`, [WEB_CSRF_HEADER]: csrfTokenFor(who) };
      if (opts.publicLink) bindGatewayRequest(req, { surface: "gateway", exposureId: "e".repeat(32), expectedOrigin: "https://x.example", isCurrent: () => true });
      let status = 0;
      const res = { headersSent: false, destroyed: false, writeHead(code: number) { status = code; this.headersSent = true; }, setHeader: vi.fn(),
        end(text: string) { resolve({ status, body: JSON.parse(text) }); } } as any;
      const next = (r: any, s: any, u: URL) => handleSettingsRequest(r, s, u, ctx);
      try { const u = new URL(url, "http://localhost"); if (!gate.handle(req, res, u, next)) expect(next(req, res, u)).toBe(true);
        queueMicrotask(() => { if (body !== undefined) req.emit("data", Buffer.from(JSON.stringify(body))); req.emit("end"); }); }
      catch (err) { reject(err); }
    });
  }
  const raw = () => yaml.load(readFileSync(path, "utf8")) as any;
  return { config, save, store, request, raw, overview, revoke };
}

describe("through the gate and the real handler", () => {
  it("every change is written at once: off, on again (the default), only-this-computer, the hours", async () => {
    const h = harness();
    expect((await h.request("PUT", WEB, { verified_authority: { enabled: false, loopback_only: true, max_session_hours: 12 } })).status).toBe(200);
    expect(h.raw().web.verified_authority).toEqual({ enabled: false, loopback_only: true, max_session_hours: 12 });
    const on = await h.request("PUT", WEB, { verified_authority: { enabled: null, loopback_only: null, max_session_hours: 24 } });
    expect(on.status, "§0.1: no confirmation for these keys").toBe(200);
    expect(h.raw().web.verified_authority).toEqual({ max_session_hours: 24 });
    expect(h.config.web.verified_authority.enabled).toBeUndefined();                      // on: the default
  });
  it("a body it doesn't take (a step-up list) or a result the validator refuses (a 49 h age) is refused; over the public link nothing", async () => {
    const h = harness();
    expect((await h.request("PUT", WEB, { verified_authority: { step_up: { enforce: ["merge"] } } })).status).toBe(400);
    expect((await h.request("PUT", WEB, { verified_authority: { max_session_hours: 49 } })).status).toBe(400);
    expect((await h.request("PUT", WEB, { verified_authority: { enabled: false } }, { publicLink: true })).status).toBe(403);
    expect(h.save).not.toHaveBeenCalled();
  });
  it("GET /api/settings/web-authority and POST …/revoke (at once); neither for a non-admin nor over the public link", async () => {
    const h = harness();
    expect(await h.request("GET", "/api/settings/web-authority")).toEqual({ status: 200, body: { state: { enabled: false, loopbackOnly: false, epoch: 0 } } });
    expect(await h.request("POST", "/api/settings/web-authority/revoke", {})).toEqual({ status: 200, body: { ok: true, epoch: 3, durable: true } });
    expect((await h.request("POST", "/api/settings/web-authority/revoke", {}, { as: "guest" })).status).toBe(401);
    expect((await h.request("POST", "/api/settings/web-authority/revoke", {}, { as: "none" })).status).toBe(401);
    expect((await h.request("GET", "/api/settings/web-authority", undefined, { publicLink: true })).status).toBe(403);
    expect((await h.request("POST", "/api/settings/web-authority/revoke", {}, { publicLink: true })).status).toBe(403);
    expect(h.revoke).toHaveBeenCalledTimes(1);
  });
});

describe("the overview (a real FleetManager)", () => {
  function fm(web: Record<string, unknown>) {
    const dir = mkdtempSync(join(tmpdir(), "agend-1939so-")); roots.push(dir);
    const f = new FleetManager(dir), s = f as any;
    const owner = { id: "owner", type: "telegram", group_id: "G", bot_token_env: "NONE", access: { mode: "open", allowed_users: ["admin"] } };
    f.fleetConfig = { defaults: {}, channel: owner, channels: [owner], instances: {}, web } as never;
    writeFileSync(join(dir, "web.token"), "c".repeat(48), { mode: 0o600 }); s.initializeWebSessions();
    const session = (label: string) => s.webSessions.create({ tier: "admin", surface: "local", label, tokenEpoch: tokenEpoch("c".repeat(48)), owner: { adapterId: "owner", userId: "admin" } }).record;
    return { f, s, session, close: () => { f.stormWindow.shutdown(); f.spawnGate.shutdown(); } };
  }
  it("the state in force, what fleet.yaml says, the hosts that reach it from elsewhere, and the sessions authorized now", () => {
    const h = fm({ allowed_hosts: ["localhost", "agend.example.com", "192.168.1.5:19280"], verified_authority: { enabled: true, max_session_hours: 6 } });
    const firefox = h.session("Firefox on Mac"), phone = h.session("Safari on iPhone");
    expect(h.s.authorizeWebSession(firefox, "loopback", false)).toMatchObject({ ok: true });
    const o = h.s.webAuthorityOverview();
    expect(o.state).toEqual({ enabled: true, loopbackOnly: false, epoch: 1 });
    expect(o.configured).toEqual({ enabled: true, max_session_hours: 6 });
    expect(o.hours).toEqual({ min: 1, max: 48, default: 48 });
    expect(o.lanHosts).toEqual(["agend.example.com", "192.168.1.5:19280"]);
    expect(o.authorized).toEqual([{ handle: firefox.handle, label: "Firefox on Mac", account: "owner:admin", authorizedAt: expect.any(Number), until: expect.any(Number) }]);
    expect(o.authorized[0].until - o.authorized[0].authorizedAt).toBeLessThanOrEqual(6 * 3_600_000);
    expect(o.authorized.map((a: any) => a.handle)).not.toContain(phone.handle);
    expect(o).not.toHaveProperty("actions");                                            // §0: no step-up list
    h.s.revokeWebAuthority();
    expect(h.s.webAuthorityOverview().authorized, "an epoch bump ends every authorization").toEqual([]);
    h.close();
  });
  it("nothing configured: on (§0.1), no hosts, nothing authorized yet; switched off: nothing listed", () => {
    const h = fm({});
    const o = h.s.webAuthorityOverview();
    expect([o.state.enabled, o.configured, o.lanHosts, o.authorized]).toEqual([true, {}, [], []]);
    h.s.authorizeWebSession(h.session("Firefox"), "loopback", false);
    expect(h.s.webAuthorityOverview().authorized.length).toBe(1);
    h.s.fleetConfig.web = { verified_authority: { enabled: false } };
    expect(h.s.webAuthorityOverview().authorized).toEqual([]);
    h.close();
  });
});

describe("POST …/revoke through the real local server, its body held (the caller asked again after it)", () => {
  async function live() {
    const dir = mkdtempSync(join(tmpdir(), "agend-1939sr-")); roots.push(dir);
    const fm = new FleetManager(dir), s = fm as any;
    const q = () => {}; s.logger = { info: q, warn: q, error: q, debug: q, trace: q, fatal: q, child: () => s.logger };
    writeFileSync(join(dir, "fleet.yaml"), `health_port: 0\ninstances:\n  a:\n    working_directory: ${dir}\n    backend: claude-code\nweb:\n  verified_authority:\n    enabled: true\n`);
    s.notifyFleetError = () => true; fm.loadConfig(join(dir, "fleet.yaml"));
    s.lifecycle = { isPaused: () => false, hasWorkLease: () => false, daemons: new Map() };
    s.getInstanceStatus = () => "running";
    s.initializeWebAuthTokens(); s.startHealthServer(0);
    await vi.waitFor(() => expect(s.getDashboardAccess().ready).toBe(true));
    s.initializeWebSessions();
    const port = s.healthServer.address().port as number;
    const admin = s.webSessions.create({ tier: "admin", surface: "local", label: "admin", tokenEpoch: tokenEpoch(s.getDashboardAccess().token) });
    const revoke = (between: () => unknown) => new Promise<number>((resolve, reject) => {
      const body = "{}";
      const r = httpRequest({ host: "127.0.0.1", port, method: "POST", path: "/api/settings/web-authority/revoke", headers: { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`,
        "content-type": "application/json", "content-length": String(Buffer.byteLength(body)), cookie: `${WEB_SESSION_COOKIE}=${admin.sessionId}`, [WEB_CSRF_HEADER]: csrfTokenFor(admin.sessionId) } },
        (res) => { res.resume(); res.on("end", () => resolve(res.statusCode ?? 0)); });
      r.on("error", reject);
      r.write(body.slice(0, 1));
      setTimeout(() => { between(); r.end(body.slice(1)); }, 50);
    });
    const close = () => new Promise<void>((r) => { s.healthServer.close(() => r()); fm.stormWindow.shutdown(); fm.spawnGate.shutdown(); });
    return { s, admin, revoke, close };
  }
  it("an admin's revoke moves the epoch at once (no confirmation)", async () => {
    const h = await live();
    try {
      expect(h.s.webAuthorityState().epoch).toBe(1);
      expect(await h.revoke(() => {})).toBe(200);
      expect(h.s.webAuthorityState().epoch).toBe(2);
    } finally { await h.close(); }
  });
  it("the admin's session revoked while the body came: refused, nothing revoked", async () => {
    const h = await live();
    try {
      expect(h.s.webAuthorityState().epoch).toBe(1);
      expect(await h.revoke(() => h.s.webSessions.revokeById(h.admin.sessionId))).toBe(401);
      expect(h.s.webAuthorityState().epoch).toBe(1);
    } finally { await h.close(); }
  });
});
