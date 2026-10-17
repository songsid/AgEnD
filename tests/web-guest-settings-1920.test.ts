/**
 * #1920 phase 3 (P3b, server): Settings → Web sign-ins → Guests.
 * - PUT /api/settings/fleet/web takes `guests`: enabled / chat (boolean, null = default), open_instances and narrow (per
 *   connection / per account: a list of agents, null = removed). Read by one parser for the gate and the handler.
 * - Judged by what it lets guests reach: turning it on, letting guests chat, naming more agents for an open connection,
 *   and widening or lifting a narrowing wait for a General admin; the reverse of each applies at once.
 * - GET /api/settings/guests lists the switches, connections and every guest account; POST …/revoke signs one account's
 *   guests out (at once — it only takes away). Never over the public link.
 * Rig: the real classifier and projection; the real gate in front of the real handler on a fleet.yaml on disk (as
 * settings-web-1620); a real FleetManager for the overview.
 */
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { tokenEpoch } from "../src/web-session.js";
import { SettingsConfirmationStore } from "../src/settings-confirmation.js";
import { SettingsHttpConfirmation } from "../src/settings-http-confirmation.js";
import { SettingsBaselines } from "../src/settings-baseline.js";
import { handleSettingsRequest, type SettingsApiContext } from "../src/settings-api.js";
import { prepareSettingsEffect } from "../src/settings-effect.js";
import { noteSettingsWrite } from "../src/settings-transaction.js";
import { bindGatewayRequest } from "../src/web-request-context.js";
import { applyGuestsPatch, guestsPatch } from "../src/web-settings-patch.js";

const roots: string[] = [], stores: SettingsConfirmationStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 5 }); });

const WEB = "/api/settings/fleet/web";
const FLEET = { channels: [{ id: "dc", type: "discord", group_id: "G", bot_token_env: "X" }], instances: { a: { working_directory: "/tmp" }, b: { working_directory: "/tmp" } } };
const judge = (guests: unknown, web: Record<string, unknown> = {}) =>
  prepareSettingsEffect("PUT", WEB, { guests }, { config: { defaults: {}, ...structuredClone(FLEET), web } as any, classic: {} }).diff;

describe("the guests patch", () => {
  it("parses booleans, lists and nulls; refuses anything else", () => {
    expect(guestsPatch({ enabled: true, chat: null, open_instances: { dc: ["a"] }, narrow: { "dc:111": ["a"], "dc:222": null } }))
      .toEqual({ enabled: true, chat: null, open_instances: { dc: ["a"] }, narrow: { "dc:111": ["a"], "dc:222": null } });
    for (const bad of [{ enabled: "yes" }, { session: { absolute_hours: 2 } }, { open_instances: ["a"] }, { open_instances: { dc: "a" } },
      { open_instances: { dc: ["a", "a"] } }, { open_instances: { "bad id": ["a"] } }, { narrow: { dc: ["a"] } }, { narrow: { "dc:1 2": ["a"] } },
      { open_instances: { dc: [""] } }, { open_instances: { dc: Array.from({ length: 201 }, (_, i) => `n${i}`) } }]) {
      expect(guestsPatch(bad), JSON.stringify(bad).slice(0, 60)).toBe("invalid");
    }
    expect(guestsPatch(undefined)).toBeNull();
    expect(guestsPatch({})).toBeNull();
  });
  it("applies: null removes, an emptied map leaves, nothing left: no guests key; a '__proto__' connection is a plain key", () => {
    const cur = { enabled: true, open_instances: { dc: ["a"] }, narrow: { "dc:111": ["a"] } };
    const one = applyGuestsPatch(cur, { enabled: null, narrow: { "dc:111": null } });
    expect(one.next).toEqual({ open_instances: { dc: ["a"] } });
    expect(one.changes).toEqual([{ path: ["web", "guests", "enabled"], value: undefined, remove: true }, { path: ["web", "guests", "narrow", "dc:111"], value: undefined, remove: true }]);
    expect(applyGuestsPatch({ open_instances: { dc: ["a"] } }, { open_instances: { dc: null } }).next).toBeUndefined();
    const proto = applyGuestsPatch(undefined, { open_instances: guestsPatch(JSON.parse('{"open_instances":{"__proto__":["a"]}}')) && (guestsPatch(JSON.parse('{"open_instances":{"__proto__":["a"]}}')) as any).open_instances });
    expect(Object.getPrototypeOf(proto.next!.open_instances)).toBe(Object.prototype);
    expect(Object.hasOwn(proto.next!.open_instances!, "__proto__")).toBe(true);
  });
});

describe("judged by what it lets guests reach", () => {
  it("confirmed: on, chat on, more named agents, a narrowing widened or lifted — each named", () => {
    const named = (d: any) => d?.summary.slice(1).join("\n");
    expect(named(judge({ enabled: true }))).toContain("fleet.web.guests.enabled: default → true");
    expect(named(judge({ chat: true }, { guests: { chat: false } }))).toContain("fleet.web.guests.chat: false → true");
    expect(named(judge({ chat: null }, { guests: { chat: false } })), "back to the default (on)").toContain("fleet.web.guests.chat: false → default");
    expect(named(judge({ open_instances: { dc: ["a", "b"] } }, { guests: { open_instances: { dc: ["a"] } } }))).toContain("open\\_instances.dc");
    expect(named(judge({ narrow: { "dc:111": null } }, { guests: { narrow: { "dc:111": ["a"] } } }))).toContain("narrow.dc:111");
    expect(named(judge({ narrow: { "dc:111": ["a", "b"] } }, { guests: { narrow: { "dc:111": ["a"] } } }))).toContain("narrow.dc:111");
    expect(judge({ enabled: true })?.section).toBe("access");
  });
  it("applied at once: off, read-only, fewer named agents, a new or narrower narrowing", () => {
    expect(judge({ enabled: false }, { guests: { enabled: true } })).toBeNull();
    expect(judge({ enabled: null }, { guests: { enabled: true } })).toBeNull();
    expect(judge({ chat: false })).toBeNull();
    expect(judge({ chat: true }), "chat is on by default: saying so changes nothing").toBeNull();
    expect(judge({ open_instances: { dc: ["a"] } }, { guests: { open_instances: { dc: ["a", "b"] } } })).toBeNull();
    expect(judge({ open_instances: { dc: null } }, { guests: { open_instances: { dc: ["a"] } } })).toBeNull();
    expect(judge({ narrow: { "dc:111": ["a"] } })).toBeNull();
    expect(judge({ narrow: { "dc:111": ["a"] } }, { guests: { narrow: { "dc:111": ["a", "b"] } } })).toBeNull();
  });
  it("one change that tightens and one that widens: only the widening is named, and the whole waits", () => {
    const d = judge({ enabled: false, open_instances: { dc: ["a"] } }, { guests: { enabled: true } });
    expect(d?.summary.slice(1)).toEqual([expect.stringContaining("open\\_instances.dc")]);
  });
});

function harness(fleet: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), "agend-test-1920g-")); roots.push(root);
  const path = join(root, "fleet.yaml");
  const config: any = { defaults: {}, ...structuredClone(FLEET), ...structuredClone(fleet) };
  writeFileSync(path, yaml.dump(config));
  let revision = 0;
  const save = vi.fn(() => { noteSettingsWrite(path, yaml.load(readFileSync(path, "utf8")), config); writeFileSync(path, yaml.dump(config)); revision++; });
  const overview = vi.fn(() => ({ enabled: true, guests: [] }));
  const revoke = vi.fn(() => ({ count: 2, durable: true }));
  const ctx = { fleetConfig: config, dataDir: root, configPath: path, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    getRawFleetConfig: () => config, saveFleetConfig: save, lifecycle: { isPaused: () => false, pause: vi.fn(), wake: vi.fn() },
    guestOverview: overview, revokeGuestWebSessions: revoke } as unknown as SettingsApiContext;
  const store = new SettingsConfirmationStore({ audit: vi.fn() }); stores.push(store);
  const baselines = new SettingsBaselines({ dataDir: root, configPath: () => path, config: () => config, current: () => revision });
  const gate = new SettingsHttpConfirmation(store, {
    principal: req => req.headers.cookie ? { id: "session-a", label: "browser", source: "web_session", current: () => true } : null,
    baseline: () => baselines.read(), snapshot: () => baselines.snapshot(),
  });
  function request(method: string, url: string, body?: unknown, opts: { publicLink?: boolean } = {}) {
    return new Promise<{ status: number; body: any }>((resolve, reject) => {
      const req = new EventEmitter() as any;
      req.method = method; req.url = url; req.headers = { "idempotency-key": `k-${Math.random()}`, cookie: "opaque" }; req.destroy = () => undefined;
      if (opts.publicLink) bindGatewayRequest(req, { surface: "gateway", exposureId: "e".repeat(32), expectedOrigin: "https://x.example", isCurrent: () => true });
      let status = 0;
      const res = { headersSent: false, destroyed: false, writeHead(code: number) { status = code; this.headersSent = true; }, setHeader: vi.fn(),
        end(text: string) { resolve({ status, body: JSON.parse(text) }); } } as any;
      const next = (r: any, s: any, u: URL) => handleSettingsRequest(r, s, u, ctx);
      // As the server mounts it: the gate takes a settings mutation; anything else goes straight to the handler.
      try { const u = new URL(url, "http://localhost"); if (!gate.handle(req, res, u, next)) expect(next(req, res, u)).toBe(true);
        queueMicrotask(() => { if (body !== undefined) req.emit("data", Buffer.from(JSON.stringify(body))); req.emit("end"); }); }
      catch (err) { reject(err); }
    });
  }
  const raw = () => yaml.load(readFileSync(path, "utf8")) as any;
  return { config, save, store, request, raw, overview, revoke };
}
const admin = () => ({ label: "F", current: () => true });

describe("through the gate and the real handler", () => {
  it("narrowing a guest and turning guests off are written at once; turning them on waits for a General admin", async () => {
    const h = harness({ web: { guests: { enabled: true } } });
    const narrow = await h.request("PUT", WEB, { guests: { narrow: { "dc:111": ["a"] } } });
    expect(narrow.status).toBe(200);
    expect(h.raw().web.guests).toEqual({ enabled: true, narrow: { "dc:111": ["a"] } });
    expect((await h.request("PUT", WEB, { guests: { enabled: false } })).status).toBe(200);
    expect(h.raw().web.guests.enabled).toBe(false);
    const on = await h.request("PUT", WEB, { guests: { enabled: true, open_instances: { dc: ["a"] } } });
    expect([on.status, on.body.result]).toEqual([202, "pending_confirmation"]);
    expect(h.raw().web.guests.enabled).toBe(false);
    expect((await h.store.decide(on.body.pending_change.id, "confirm", admin())).state).toBe("applied");
    expect(h.raw().web.guests).toEqual({ enabled: true, narrow: { "dc:111": ["a"] }, open_instances: { dc: ["a"] } });
    expect(h.config.web.guests.open_instances).toEqual({ dc: ["a"] });
  });
  it("a body the validator refuses (an unknown connection key shape) is refused; over the public link nothing", async () => {
    const h = harness();
    expect((await h.request("PUT", WEB, { guests: { narrow: { "dc:bad user": ["a"] } } })).status).toBe(400);
    const pub = await h.request("PUT", WEB, { guests: { enabled: false } }, { publicLink: true });
    expect(pub.status).toBe(403);
    expect(h.save).not.toHaveBeenCalled();
  });
  it("GET /api/settings/guests and POST …/revoke (at once); neither over the public link", async () => {
    const h = harness();
    expect(await h.request("GET", "/api/settings/guests")).toEqual({ status: 200, body: { enabled: true, guests: [] } });
    const r = await h.request("POST", "/api/settings/guests/revoke", { adapterId: "dc", userId: "111" });
    expect(r).toEqual({ status: 200, body: { ok: true, count: 2, durable: true } });
    expect(h.revoke).toHaveBeenCalledWith({ adapterId: "dc", userId: "111" });
    expect((await h.request("POST", "/api/settings/guests/revoke", { adapterId: "dc" })).status).toBe(400);
    expect((await h.request("GET", "/api/settings/guests", undefined, { publicLink: true })).status).toBe(403);
    expect((await h.request("POST", "/api/settings/guests/revoke", { adapterId: "dc", userId: "111" }, { publicLink: true })).status).toBe(403);
    expect(h.revoke).toHaveBeenCalledTimes(1);
  });
});

describe("the overview (a real FleetManager)", () => {
  it("the switches, each connection's mode and named agents, every guest account — signed in, with a device, or narrowed", () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-1920go-")); roots.push(dir);
    const fm = new FleetManager(dir), s = fm as any;
    const adapter = { id: "dc", type: "discord", stop: vi.fn(async () => {}) };
    const channel = { id: "dc", type: "discord", group_id: "G", bot_token_env: "X", access: { mode: "open", allowed_users: ["admin"] } };
    fm.fleetConfig = { defaults: {}, channel, channels: [channel], instances: { a: { working_directory: dir, topic_id: "T1", channel_id: "dc" }, b: { working_directory: dir, topic_id: "T2", channel_id: "dc" } },
      web: { guests: { enabled: true, chat: false, open_instances: { dc: ["a", "b"] }, narrow: { "dc:333": ["a"] } } } } as never;
    fm.routing.rebuild(fm.fleetConfig!); s.adapters.set("dc", adapter);
    s.worlds.set("dc", { adapter, groupId: "G", channelConfig: channel, accessManager: { isAllowed: () => true, getMode: () => "open" }, stop: async () => {} });
    s.classicChannels = { getAll: () => [] };
    writeFileSync(join(dir, "web.token"), "c".repeat(48), { mode: 0o600 }); s.initializeWebSessions();
    const epoch = tokenEpoch("c".repeat(48));
    for (let i = 0; i < 2; i++) s.webSessions.create({ tier: "guest", surface: "local", label: "x", tokenEpoch: epoch, owner: { adapterId: "dc", userId: "111" } });
    s.webSessions.create({ tier: "admin", surface: "local", label: "x", tokenEpoch: epoch });
    s.rememberGuestDevice?.({ adapterId: "dc", userId: "222" }, { surface: "local", label: "x" });
    const o = s.guestOverview();
    expect([o.enabled, o.chat, o.instances]).toEqual([true, false, ["a", "b"]]);
    expect(o.connections).toEqual([{ id: "dc", type: "discord", mode: "open", named: ["a", "b"] }]);
    const by = Object.fromEntries(o.guests.map((g: any) => [g.userId, g]));
    expect(by["111"]).toMatchObject({ adapterId: "dc", platform: "discord", sessions: 2, devices: 0, scope: ["a", "b"], narrow: null });
    expect(typeof by["111"].lastSeen).toBe("number");
    expect(by["333"]).toMatchObject({ sessions: 0, lastSeen: null, scope: ["a"], narrow: ["a"] });
    if (s.rememberGuestDevice) expect(by["222"]).toMatchObject({ sessions: 0, devices: 1 });
    expect(Object.keys(by).sort(), "no admin session in it").toEqual(s.rememberGuestDevice ? ["111", "222", "333"] : ["111", "333"]);
    fm.stormWindow.shutdown(); fm.spawnGate.shutdown();
  });
});
