/**
 * #3451 (alpha.9 acceptance on 64dede51): fleet Settings → Hub's two host-owner saves — "HTML previews on this Hub" and
 * "Run this Hub" — went straight to their routes, which save only as a confirmed replay, so both answered 403
 * admin_confirmation_required and nothing changed. Like retention, they are Settings changes the gate proposes first: here
 * through the real gate and the real handler, the host owner's own confirmation applies each, and a route's refusal at the
 * replay reaches the page as the failed outcome's detail.
 */
import { EventEmitter } from "node:events";
import { createServer } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsConfirmationStore } from "../src/settings-confirmation.js";
import { SettingsHttpConfirmation } from "../src/settings-http-confirmation.js";
import { SettingsBaselines } from "../src/settings-baseline.js";
import { handleSettingsRequest, type SettingsApiContext } from "../src/settings-api.js";
import { isSettingsMutation, prepareSettingsEffect } from "../src/settings-effect.js";

const roots: string[] = [], stores: SettingsConfirmationStore[] = [];
afterEach(() => { for (const s of stores.splice(0)) s.close(); for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
const freePort = async () => { const s = createServer(); await new Promise<void>((r) => s.listen({ host: "127.0.0.1", port: 0 }, r)); const p = (s.address() as { port: number }).port; await new Promise<void>((r) => s.close(() => r())); return p; };

function harness(o: { localAdmin?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "agend-3451-")); roots.push(root);
  const path = join(root, "fleet.yaml");
  const config: any = { defaults: {}, instances: {}, health_port: 19280, hub: { enabled: true, hubId: "4c3b2a19-0e8f-4d7c-9b6a-5f4e3d2c1b0a",
    webOrigin: "https://hub.example.test:8444", memberOrigin: "https://hub.example.test:8443",
    webListen: { host: "127.0.0.1", port: 8444 }, memberListen: { host: "127.0.0.1", port: 8443 } } };
  writeFileSync(path, yaml.dump(config));
  let revision = 0;
  const save = vi.fn((patches: Array<{ path: string[]; value?: unknown; remove?: boolean }>) => {
    for (const p of patches) {
      let at = config; for (const k of p.path.slice(0, -1)) at = at[k] ??= {};
      if (p.remove) delete at[p.path.at(-1)!]; else at[p.path.at(-1)!] = p.value;
    }
    writeFileSync(path, yaml.dump(config)); revision++;
  });
  const ctx = { webToken: "tok", webSessions: null, fleetConfig: config, dataDir: root, configPath: path, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    getRawFleetConfig: () => config, saveFleetConfig: save, hubSettingsBusy: () => false } as unknown as SettingsApiContext;
  const store = new SettingsConfirmationStore({ audit: vi.fn(), notify: vi.fn() }); stores.push(store);
  const baselines = new SettingsBaselines({ dataDir: root, configPath: () => path, config: () => config, current: () => revision });
  const done = vi.fn();
  const gate = new SettingsHttpConfirmation(store, {
    // The host owner's own session (D3): the local admin, confirming its own change at Save.
    principal: () => ({ id: "host", label: "host", source: "web_session", current: () => true, localAdmin: () => o.localAdmin !== false }),
    baseline: () => baselines.read(), snapshot: () => baselines.snapshot(), selfConfirm: () => ({ label: "This computer's admin", current: () => true, done }),
  });
  /** A browser's PUT as the server routes it: the gate first, else the handler. */
  function put(url: string, body: unknown) {
    return new Promise<{ status: number; body: any }>((resolve) => {
      const req = new EventEmitter() as any;
      req.method = "PUT"; req.url = url; req.headers = { "idempotency-key": `k${Math.random()}`, "x-agend-token": "tok" }; req.destroy = () => undefined;
      let status = 0;
      const res = { headersSent: false, destroyed: false, writeHead(code: number) { status = code; this.headersSent = true; }, setHeader: vi.fn(),
        end(text: string) { resolve({ status, body: JSON.parse(text) }); } } as any;
      const next = (r: any, s: any, u: URL) => handleSettingsRequest(r, s, u, ctx);
      const u = new URL(url, "http://localhost");
      if (!gate.handle(req, res, u, next)) next(req, res, u);
      queueMicrotask(() => { req.emit("data", Buffer.from(JSON.stringify(body))); req.emit("end"); });
    });
  }
  /** The pending change's final view (what the page's confirmedWrite resolves to). */
  const settled = async () => { await vi.waitFor(() => expect(done).toHaveBeenCalled()); return done.mock.calls.at(-1)![0]; };
  return { config, save, put, settled };
}

describe("#3451: the host owner's Hub switches are confirmed Settings changes", () => {
  it("both routes are Settings mutations (PUT only)", () => {
    for (const p of ["/api/settings/hub/run", "/api/settings/hub/preview"]) {
      expect([isSettingsMutation("PUT", p), isSettingsMutation("GET", p)]).toEqual([true, false]);
    }
  });
  it("Run this Hub → Stop: proposed, confirmed by the host owner, applied — hub.enabled false", async () => {
    const h = harness();
    const r = await h.put("/api/settings/hub/run", { enabled: false });
    expect([r.status, r.body.result]).toEqual([202, "pending_confirmation"]);
    const view = await h.settled();
    expect([view.state, view.outcome.result]).toEqual(["applied", { ok: true, initialized: true, enabled: false }]);
    expect(h.save.mock.calls).toEqual([[[{ path: ["hub", "enabled"], value: false }]]]);
    expect(h.config.hub.enabled).toBe(false);
  });
  it("HTML previews → Save a free port: applied — exactly hub.web.preview_port; then off removes it", async () => {
    const h = harness(), port = await freePort();
    expect((await h.put("/api/settings/hub/preview", { enabled: true, port })).status).toBe(202);
    const on = await h.settled();
    expect([on.state, on.outcome.result]).toMatchObject(["applied", { ok: true, enabled: true, port }]);
    expect(h.config.hub.web).toEqual({ preview_port: port });
    expect((await h.put("/api/settings/hub/preview", { enabled: false })).status).toBe(202);
    await vi.waitFor(() => expect(h.save).toHaveBeenCalledTimes(2));
    expect(h.save.mock.calls[1]).toEqual([[{ path: ["hub", "web", "preview_port"], remove: true }]]);
    expect(h.config.hub.web).toEqual({});
  });
  it("a refusal at the replay is the failed outcome's detail (the page shows its own words); nothing is saved", async () => {
    const h = harness();
    await h.put("/api/settings/hub/preview", { enabled: true, port: 8444 });
    const v = await h.settled();
    expect([v.state, v.outcome.detail, h.save.mock.calls.length]).toEqual(["failed", "apply_rejected: port_conflict", 0]);
  });
  it("a malformed body is refused before anything is proposed", async () => {
    const h = harness();
    expect(await h.put("/api/settings/hub/run", { enabled: "no" })).toEqual({ status: 400, body: { error: "invalid" } });
    expect(await h.put("/api/settings/hub/preview", { enabled: true, port: 0 })).toEqual({ status: 400, body: { error: "invalid_port" } });
    expect(h.save).not.toHaveBeenCalled();
  });
  it("opening a listener (start, a preview port) is outward but, since AGEND-122, confirmed like any change (a signed-in admin's Apply now); the Hub authority scope stays; stop and off widen nothing", () => {
    const ctx = { config: { defaults: {}, instances: {} } as any, classic: {} };
    const diff = (path: string, body: unknown) => prepareSettingsEffect("PUT", path, body, ctx).diff!;
    const hub = { connections: [], primaryGeneral: true, unknown: false };
    for (const [path, body] of [["/api/settings/hub/run", { enabled: true }], ["/api/settings/hub/preview", { enabled: true, port: 8445 }],
      ["/api/settings/hub/run", { enabled: false }], ["/api/settings/hub/preview", { enabled: false }]] as const) {
      const d = diff(path, body);
      expect([d.authority, "noSelfConfirm" in d, "hostLocalConfirm" in d]).toEqual([hub, false, false]);
    }
  });
});
