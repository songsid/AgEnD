/**
 * M-3770 1.4: PUT /api/settings/fleet/updates — Settings → Version and update's controls write `updates.*` (design #4480 §6).
 * #4487 review P1: a held settings change, through the real settings gate (SettingsHttpConfirmation) and the real handler,
 * on a fleet.yaml on disk:
 *  - a current admin session only (local or the public link's), checked again after the body is read: a read session, a
 *    session whose admin ends while its body is in flight, and a caller with no admin over the link change nothing;
 *  - what only holds updates back (a pause window added, a pin set where there was none, the longest wait, mode "ask")
 *    applies at once; what lets an update go ahead sooner (automatic mode, a pin lifted or changed, a pause window
 *    removed) waits for a confirmation, and nothing is saved until it is confirmed;
 *  - a partial patch, validated as fleet.yaml is; `pin: null` removes the pin.
 */
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import yaml from "js-yaml";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsConfirmationStore } from "../src/settings-confirmation.js";
import { SettingsHttpConfirmation } from "../src/settings-http-confirmation.js";
import { SettingsBaselines } from "../src/settings-baseline.js";
import { handleSettingsRequest } from "../src/settings-api.js";
import { isSettingsMutation, prepareSettingsEffect } from "../src/settings-effect.js";
import { bindGatewayRequest } from "../src/web-request-context.js";
import { FleetManager } from "../src/fleet-manager.js";
import { updatesLoosened } from "../src/update-settings.js";

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

const roots: string[] = [], stores: SettingsConfirmationStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) { if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw Error("unsafe cleanup"); rmSync(root, { recursive: true, force: true, maxRetries: 5 }); }
});
const UPDATES = "/api/settings/fleet/updates";
const WINDOW = { days: [1, 2, 3, 4, 5], from: "09:00", to: "18:00" };

function harness(initial: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), "agend-s237-")); roots.push(root);
  const path = join(root, "fleet.yaml");
  writeFileSync(path, yaml.dump({ instances: {}, ...initial }));
  const fm = new FleetManager(root) as any;
  fm.loadConfig(path);
  const store = new SettingsConfirmationStore({ audit: vi.fn() }); stores.push(store);
  const baselines = new SettingsBaselines({ dataDir: root, configPath: () => fm.configPath, config: () => fm.fleetConfig, current: () => 0 });
  const who = { live: true, admin: true };
  const gate = new SettingsHttpConfirmation(store, {
    principal: () => ({ id: "session-a", label: "browser", source: "web_session", current: () => who.live, localAdmin: () => who.admin }),
    baseline: () => baselines.read(), snapshot: () => baselines.snapshot(),
  });
  let key = 0;
  async function request(body: unknown, opts: { publicLink?: boolean; beforeBody?: () => void } = {}) {
    return new Promise<{ status: number; body: any }>((done, fail) => {
      const req = new EventEmitter() as any;
      req.method = "PUT"; req.url = UPDATES; req.headers = { "idempotency-key": `k-${++key}`, cookie: "opaque" }; req.destroy = () => undefined;
      if (opts.publicLink) bindGatewayRequest(req, { surface: "gateway", exposureId: "e".repeat(32), expectedOrigin: "https://x.example", isCurrent: () => true });
      let status = 0;
      const res = { headersSent: false, destroyed: false, writeHead(code: number) { status = code; this.headersSent = true; }, setHeader: vi.fn(),
        end(text: string) { done({ status, body: JSON.parse(text) }); } } as any;
      const next = (r: any, s: any, u: URL) => handleSettingsRequest(r, s, u, fm);
      try {
        expect(gate.handle(req, res, new URL(UPDATES, "http://localhost"), next) || next(req, res, new URL(UPDATES, "http://localhost"))).toBe(true);
        queueMicrotask(() => { opts.beforeBody?.(); req.emit("data", Buffer.from(JSON.stringify(body))); req.emit("end"); });
      } catch (err) { fail(err); }
    });
  }
  const saved = () => (yaml.load(readFileSync(path, "utf8")) as any).updates;
  return { fm, store, request, saved, who };
}
const confirmer = () => ({ label: "F", current: () => true });

describe("PUT /api/settings/fleet/updates (M-3770 1.4; #4487 review P1)", () => {
  it("is a held settings route: the gate sees it", () => {
    expect(isSettingsMutation("PUT", UPDATES)).toBe(true);
    expect(isSettingsMutation("GET", UPDATES)).toBe(false);
  });
  it("what only holds updates back applies at once: a pause window, a first pin, the longest wait, mode ask; only the keys sent change", async () => {
    const h = harness();
    const r = await h.request({ pause: [WINDOW] });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.updates).toMatchObject({ mode: "ask", pause: [WINDOW], pin: null, maxIdleWait: 24 });
    const r2 = await h.request({ maxIdleWait: 12, pin: "2.4.0", mode: "ask" });
    expect(r2.status, JSON.stringify(r2.body)).toBe(200);
    expect(h.saved()).toEqual({ pause: [WINDOW], maxIdleWait: 12, pin: "2.4.0", mode: "ask" });
    expect(h.fm.fleetConfig.updates).toMatchObject({ pause: [WINDOW], maxIdleWait: 12, pin: "2.4.0" });
  });
  it("what lets an update go ahead sooner waits for a confirmation, and nothing is saved until then; pin: null then removes the pin", async () => {
    const h = harness({ updates: { pin: "2.4.0", pause: [WINDOW] } });
    for (const body of [{ pin: null }, { pin: "2.4.1" }, { pause: [] }, { mode: "auto-when-idle" }]) {
      const r = await h.request(body);
      expect([r.status, r.body.result], JSON.stringify(body)).toEqual([202, "pending_confirmation"]);
      expect(h.saved(), JSON.stringify(body)).toEqual({ pin: "2.4.0", pause: [WINDOW] });
    }
    const held = await h.request({ pin: null });
    const outcome = await h.store.decide(held.body.pending_change.id, "confirm", confirmer());
    expect(outcome?.state, JSON.stringify(outcome)).toBe("applied");
    expect(h.saved()).toEqual({ pause: [WINDOW] });
    expect(h.fm.fleetConfig.updates.pin).toBeUndefined();
  });
  it("a read session (not an admin) changes nothing, on the dashboard and over the public link", async () => {
    const h = harness({ updates: { pin: "2.4.0" } });
    h.who.admin = false;
    for (const publicLink of [false, true]) {
      const r = await h.request({ pause: [WINDOW] }, { publicLink });
      expect([r.status, r.body.error], String(publicLink)).toEqual([403, "admin_required"]);
      const held = await h.request({ pin: null }, { publicLink });
      expect(held.status, String(publicLink)).not.toBe(200);
      if (held.status === 202) {                                       // held for someone else to confirm: still not saved
        const outcome = await h.store.decide(held.body.pending_change.id, "confirm", confirmer());
        expect(outcome?.state).not.toBe("applied");
      }
    }
    expect(h.saved()).toEqual({ pin: "2.4.0" });
  });
  it("an admin session that ends while its body is in flight changes nothing", async () => {
    const h = harness();
    const r = await h.request({ pause: [WINDOW] }, { beforeBody: () => { h.who.admin = false; } });
    expect(r.status).toBe(403);
    expect(h.saved()).toBeUndefined();
    h.who.admin = true;
    const r2 = await h.request({ pause: [WINDOW] }, { beforeBody: () => { h.who.live = false; } });
    expect(r2.status).not.toBe(200);
    expect(h.saved()).toBeUndefined();
  });
  it("refuses what fleet.yaml would refuse, and anything but the four keys; nothing is saved", async () => {
    const h = harness({ updates: { maxIdleWait: 6 } });
    for (const body of [{ pause: [{ days: [7], from: "09:00", to: "18:00" }] }, { pause: [{ days: [1], from: "09:00", to: "09:00" }] }, { maxIdleWait: 0 }, { maxIdleWait: 1.5 },
      { mode: "always" }, { channel: "stable" }, {}, [1]]) {
      const r = await h.request(body);
      expect(r.status, JSON.stringify(body)).toBe(400);
    }
    expect(h.saved()).toEqual({ maxIdleWait: 6 });
  });
  it("judges each key by direction", () => {
    expect(updatesLoosened({}, { pause: [WINDOW], pin: "2.4.0", maxIdleWait: 2, mode: "ask" })).toEqual([]);
    expect(updatesLoosened({ pin: "2.4.0" }, {})).toEqual(["pin"]);
    expect(updatesLoosened({ pin: "2.4.0" }, { pin: "2.4.1" })).toEqual(["pin"]);
    expect(updatesLoosened({ pause: [WINDOW] }, { pause: [{ ...WINDOW, days: [5, 4, 3, 2, 1] }, { days: [0], from: "00:00", to: "06:00" }] })).toEqual([]);
    expect(updatesLoosened({ pause: [WINDOW] }, { pause: [{ ...WINDOW, to: "17:00" }] })).toEqual(["pause"]);
    expect(updatesLoosened({}, { mode: "auto-when-idle" })).toEqual(["mode"]);
    const diff = prepareSettingsEffect("PUT", UPDATES, { mode: "auto-when-idle", pin: null }, { config: { instances: {}, updates: { pin: "2.4.0" } } as any, classic: {} }).diff;
    expect(diff?.summary.slice(1)).toEqual(["fleet.updates.mode: none → auto-when-idle", "fleet.updates.pin: 2.4.0 → none"]);
  });
  it("is on the public link's list (its admin session may change it, as monitoring's)", () => {
    expect(readFileSync("src/public-web-gateway.ts", "utf8")).toContain('if (method === "PUT" && path === "/api/settings/fleet/updates") return true;');
  });
});
