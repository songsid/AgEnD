/**
 * #1629 r4.1 Q3 (b): Settings → Appearance writes the identity card's upload limits (fleet.yaml web.appearance) through
 * PUT /api/settings/fleet/appearance — the confirmation gate and the real handler, as the server mounts them.
 * - Each limit is judged by direction, on the limit it GIVES (clamped as the loader clamps): lower applies at once,
 *   higher waits for a General admin; back to the default from below is higher.
 * - Never over the temporary public link: absent from its manifest, refused by the gate and by the handler (each tested).
 * - GET shows what is written, what is in force, the defaults, the bounds and the clamp warnings.
 */
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsConfirmationStore } from "../src/settings-confirmation.js";
import { SettingsHttpConfirmation } from "../src/settings-http-confirmation.js";
import { SettingsBaselines } from "../src/settings-baseline.js";
import { handleSettingsRequest, type SettingsApiContext } from "../src/settings-api.js";
import { isSettingsMutation, prepareSettingsEffect } from "../src/settings-effect.js";
import { noteSettingsWrite } from "../src/settings-transaction.js";
import { bindGatewayRequest } from "../src/web-request-context.js";
import { isPublicWebRoute } from "../src/public-web-gateway.js";
import { applyAppearanceChanges, parseAppearanceSettingsBody } from "../src/web-settings-patch.js";

vi.mock("node:child_process", async importOriginal => {
  const original = await importOriginal<typeof import("node:child_process")>();
  const refuse = () => { throw new Error("card settings: no child process may start"); };
  return { ...original, spawn: refuse, spawnSync: refuse, exec: refuse, execSync: refuse, execFile: refuse, execFileSync: refuse, fork: refuse };
});

const roots: string[] = [], stores: SettingsConfirmationStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 5 }); });

const PATH = "/api/settings/fleet/appearance";
const judge = (body: unknown, fleet: Record<string, unknown> = {}) =>
  prepareSettingsEffect("PUT", PATH, body, { config: { defaults: {}, instances: {}, ...fleet } as any, classic: {} }).diff;

describe("the body", () => {
  it("whole positive numbers or null, in the known groups only", () => {
    expect(parseAppearanceSettingsBody({ portrait: { max_kib: 512, max_width: null }, instance_quota: { files: 4 } }))
      .toEqual([{ group: "portrait", key: "max_kib", value: 512 }, { group: "portrait", key: "max_width", value: null }, { group: "instance_quota", key: "files", value: 4 }]);
    for (const bad of [[], { avatar: {} }, { portrait: { depth: 1 } }, { portrait: { max_kib: 1.5 } }, { portrait: { max_kib: "512" } }, { portrait: { max_kib: 0 } }, { banner: 3 }]) {
      expect(parseAppearanceSettingsBody(bad), JSON.stringify(bad)).toMatchObject({ error: expect.any(String) });
    }
    expect(applyAppearanceChanges({ portrait: { max_kib: 512 }, banner: { max_width: 800 } }, [{ group: "portrait", key: "max_kib", value: null }]))
      .toEqual({ banner: { max_width: 800 } });
    expect(applyAppearanceChanges({ portrait: { max_kib: 512 } }, [{ group: "portrait", key: "max_kib", value: null }])).toBeUndefined();
  });
});

describe("judged by direction, on the limit given", () => {
  it("lower applies at once; higher waits for a General admin, named old → new", () => {
    expect(judge({ portrait: { max_kib: 512 } })).toBeNull();
    expect(judge({ instance_quota: { files: 2, mib: 1 } })).toBeNull();
    const up = judge({ banner: { max_width: 2000 } });
    expect([up?.section, up?.summary.slice(1)]).toEqual(["access", ["fleet.web.appearance.banner.max\\_width: default → 2000"]]);
    expect(judge({ portrait: { max_kib: 2048 } }, { web: { appearance: { portrait: { max_kib: 512 } } } })?.summary.slice(1))
      .toEqual(["fleet.web.appearance.portrait.max\\_kib: 512 → 2048"]);
  });
  it("clamped as the loader clamps: above the ceiling to another value above it changes nothing; back to the default from below is higher", () => {
    expect(judge({ portrait: { max_width: 5000 } }, { web: { appearance: { portrait: { max_width: 9999 } } } })).toBeNull();   // 2048 → 2048
    expect(judge({ portrait: { max_width: 1500 } }, { web: { appearance: { portrait: { max_width: 9999 } } } })).toBeNull();   // 2048 → 1500
    expect(judge({ portrait: { max_width: null } }, { web: { appearance: { portrait: { max_width: 512 } } } })?.summary.slice(1))
      .toEqual(["fleet.web.appearance.portrait.max\\_width: 512 → default"]);
    expect(judge({ portrait: { max_width: null } }, { web: { appearance: { portrait: { max_width: 2000 } } } })).toBeNull();
    // Only the clamp tells these apart: below the floor (64 in force) and above the ceiling (2048 in force), nothing moves.
    expect(judge({ portrait: { max_width: 60 } }, { web: { appearance: { portrait: { max_width: 50 } } } })).toBeNull();
    expect(judge({ portrait: { max_width: 3000 } }, { web: { appearance: { portrait: { max_width: 2048 } } } })).toBeNull();
    expect(judge({ portrait: { max_width: 100 } }, { web: { appearance: { portrait: { max_width: 50 } } } })).not.toBeNull();   // 64 → 100
  });
  it("one higher limit in a batch of lower ones is confirmed, and only it is named; a bad body is refused before anything", () => {
    expect(judge({ portrait: { max_kib: 256, max_width: 1200 }, banner: { max_kib: 128 } })?.summary.slice(1)).toEqual(["fleet.web.appearance.portrait.max\\_width: default → 1200"]);
    expect(() => judge({ portrait: { max_kib: "big" } })).toThrow("invalid_appearance_settings");
    expect(isSettingsMutation("PUT", PATH)).toBe(true);
  });
});

function harness(fleet: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), "agend-test-card-settings-")); roots.push(root);
  const path = join(root, "fleet.yaml");
  const config: any = { defaults: {}, instances: {}, ...structuredClone(fleet) };
  writeFileSync(path, yaml.dump(config));
  let revision = 0;
  const save = vi.fn(() => { noteSettingsWrite(path, yaml.load(readFileSync(path, "utf8")), config); writeFileSync(path, yaml.dump(config)); revision++; });
  const ctx = { fleetConfig: config, dataDir: root, configPath: path, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    getRawFleetConfig: () => config, saveFleetConfig: save, lifecycle: { isPaused: () => false, pause: vi.fn(), wake: vi.fn() } } as unknown as SettingsApiContext;
  const store = new SettingsConfirmationStore({ audit: vi.fn() }); stores.push(store);
  const baselines = new SettingsBaselines({ dataDir: root, configPath: () => path, config: () => config, current: () => revision });
  const gate = new SettingsHttpConfirmation(store, {
    principal: req => req.headers.cookie ? { id: "session-a", label: "browser", source: "web_session", current: () => true } : null,
    baseline: () => baselines.read(), snapshot: () => baselines.snapshot(),
  });
  const dispatched = vi.fn();
  async function request(method: "GET" | "PUT", body: unknown, opts: { publicLink?: boolean; direct?: boolean } = {}) {
    return new Promise<{ status: number; body: any }>((resolve, reject) => {
      const req = new EventEmitter() as any;
      req.method = method; req.url = PATH; req.headers = { "idempotency-key": "k-1", cookie: "opaque" }; req.destroy = () => undefined;
      if (opts.publicLink) bindGatewayRequest(req, { surface: "gateway", exposureId: "e".repeat(32), expectedOrigin: "https://x.example", isCurrent: () => true });
      let status = 0;
      const res = { headersSent: false, destroyed: false, writeHead(code: number) { status = code; this.headersSent = true; }, setHeader: vi.fn(),
        end(text: string) { resolve({ status, body: JSON.parse(text) }); } } as any;
      const next = (r: any, s: any, u: URL) => { dispatched(); return handleSettingsRequest(r, s, u, ctx); };
      const url = new URL(PATH, "http://localhost");
      try {
        const handled = opts.direct || method === "GET" ? next(req, res, url) : gate.handle(req, res, url, next);
        expect(handled).toBe(true);
        if (method === "PUT") queueMicrotask(() => { req.emit("data", Buffer.from(JSON.stringify(body))); req.emit("end"); });
      } catch (err) { reject(err); }
    });
  }
  const raw = () => yaml.load(readFileSync(path, "utf8")) as any;
  return { config, save, store, request, raw, dispatched };
}
const admin = () => ({ label: "F", current: () => true });

describe("through the gate and the real handler", () => {
  it("lower: written at once, fleet.yaml and the live config; the answer shows what is in force", async () => {
    const h = harness();
    const r = await h.request("PUT", { portrait: { max_kib: 512 } });
    expect([r.status, h.raw().web, h.config.web.appearance]).toEqual([200, { appearance: { portrait: { max_kib: 512 } } }, { portrait: { max_kib: 512 } }]);
    expect(r.body.effective.portrait).toEqual({ max_width: 1024, max_height: 1536, max_kib: 512 });
  });
  it("higher: proposed, written only when a General admin confirms it", async () => {
    const h = harness();
    const r = await h.request("PUT", { banner: { max_kib: 1024 } });
    expect([r.status, r.body.result, h.save.mock.calls.length, h.raw().web]).toEqual([202, "pending_confirmation", 0, undefined]);
    expect((await h.store.decide(r.body.pending_change.id, "confirm", admin())).state).toBe("applied");
    expect(h.raw().web).toEqual({ appearance: { banner: { max_kib: 1024 } } });
  });
  it("null puts a limit back to its default: the key leaves fleet.yaml, the others stay", async () => {
    const h = harness({ web: { usage_panel: false, appearance: { portrait: { max_kib: 2048, max_width: 800 } } } });
    expect((await h.request("PUT", { portrait: { max_kib: null } })).status).toBe(200);   // 2048 → 1536: lower
    expect(h.raw().web).toEqual({ usage_panel: false, appearance: { portrait: { max_width: 800 } } });
  });
  it("GET: written, in force (clamped), defaults, bounds and the warnings", async () => {
    const h = harness({ web: { appearance: { portrait: { max_width: 9999 } } } });
    const r = await h.request("GET", undefined);
    expect([r.status, r.body.configured, r.body.effective.portrait.max_width, r.body.defaults.portrait.max_width, r.body.bounds.portrait.max_width])
      .toEqual([200, { portrait: { max_width: 9999 } }, 2048, 1024, [64, 2048]]);
    expect(r.body.warnings).toEqual([{ path: "web.appearance.portrait.max_width", message: "9999 is above the ceiling 2048 — 2048 is used" }]);
  });
  it("never over the temporary public link: not on its manifest; refused by the gate, and by the handler on its own", async () => {
    expect([isPublicWebRoute("PUT", PATH), isPublicWebRoute("GET", PATH)]).toEqual([false, false]);
    const h = harness();
    const viaGate = await h.request("PUT", { portrait: { max_kib: 512 } }, { publicLink: true });
    expect([viaGate.status, viaGate.body.error, h.dispatched.mock.calls.length]).toEqual([403, "appearance_settings_not_over_public_link", 0]);
    const direct = await h.request("PUT", { portrait: { max_kib: 512 } }, { publicLink: true, direct: true });
    expect([direct.status, direct.body.error, h.save.mock.calls.length]).toEqual([403, "appearance_settings_not_over_public_link", 0]);
    expect((await h.request("GET", undefined, { publicLink: true })).status).toBe(403);
  });
});
