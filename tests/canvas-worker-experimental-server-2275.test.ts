/** #2275: private stores and HTTP boundaries only; no fleet/CLI/tmux/provider lifecycle. */
import { EventEmitter } from "node:events";
import { createServer, request, type Server } from "node:http";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import yaml from "js-yaml";
import { validateFleetConfig } from "../src/config-validator.js";
import { parseWebSettingsBody } from "../src/web-settings-patch.js";
import { prepareSettingsEffect } from "../src/settings-effect.js";
import { handleSettingsRequest } from "../src/settings-api.js";
import { handleWebRequest, exportMod, serveAppShell } from "../src/web-api.js";
import { handleAuthRequest } from "../src/auth-api.js";
import { WebSessionStore, tokenEpoch, csrfTokenFor, type SessionTier } from "../src/web-session.js";
import { bindGatewayRequest } from "../src/web-request-context.js";
import { WebPrefsStore } from "../src/web-prefs.js";
import { ThemeStore } from "../src/web-theme-store.js";
import { WebAppearance } from "../src/web-appearance.js";
import { AppearanceLimiter } from "../src/web-appearance-policy.js";
import { FleetManager } from "../src/fleet-manager.js";
import { guestStatus, guestFrameData, guestPollBody } from "../src/web-guest-access.js";
import { encodeEffectFiles } from "../src/web-effect-upload.js";
import { WebEffectLibrary } from "../src/web-effect-library.js";
import { WebEffectProfiles } from "../src/web-effect-profiles.js";
import { WebEffectService } from "../src/web-effect-service.js";
import { ModStore } from "../src/web-mod-store.js";
import { buildModBundle } from "../src/web-mod-export.js";
import { cw1EffectChecker } from "../src/web-mod-bundle.js";
import { effectiveAppearanceLimits } from "../src/web-appearance-limits.js";
import { checkAmbient } from "../src/web-ambient.js";
import { canvasWorkerEnabled, CANVAS_WORKER_EXPERIMENTAL_MESSAGE } from "../src/web-experimental.js";
import type { WebConfig } from "../src/types.js";
import { createPreviewListener } from "../src/web-preview.js";

const roots: string[] = [], servers: Server[] = [];
const tmp = () => { const root = mkdtempSync(join(tmpdir(), "agend-cw-server-")); roots.push(root); return root; };
afterEach(async () => { vi.restoreAllMocks(); for (const server of servers.splice(0)) await new Promise<void>(r => { server.closeAllConnections(); server.close(() => r()); }); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const ID = "a".repeat(32), EXPOSURE = "e".repeat(32), TOKEN = "private-cw-boundary-token", WEB = "/api/settings/fleet/web";
const TOOLS = ["upload_web_effect", "list_web_effects", "preview_web_effect", "profile_web_effect", "apply_web_effect", "remove_web_effect", "delete_web_effect", "export_web_mod", "propose_web_mod"];
const PETALS = { preset: "fall", glyphs: ["🌸", "✿"] };
function ambient() { const result = checkAmbient(PETALS); if (!result.ok) throw Error("bad ambient fixture"); return result.value; }
function snapshot(root: string): Record<string, string> { return Object.fromEntries(readdirSync(root, { recursive: true, withFileTypes: true }).filter(e => e.isFile()).map(e => [join(e.parentPath, e.name), readFileSync(join(e.parentPath, e.name)).toString("base64")])); }
function reqRes(method: string, path: string, headers: Record<string, string> = {}) {
  const req = Object.assign(new EventEmitter(), { method, url: path, headers: { host: "127.0.0.1:19280", ...headers }, resume: vi.fn(), destroy: vi.fn(), socket: { destroy: vi.fn() } });
  let status = 0, body = "";
  const res: any = Object.assign(new EventEmitter(), { headersSent: false, destroyed: false, setHeader: vi.fn(), writeHead(code: number) { status = code; this.headersSent = true; }, end(text: string | Buffer = "") { body = String(text); }, write() { return true; } });
  return { req, res, status: () => status, text: () => body, json: () => JSON.parse(body) };
}
async function httpFixture() {
  const root = tmp(), config: any = { defaults: {}, instances: {}, web: { experimental: { canvas_worker: false } } };
  const path = join(root, "fleet.yaml"), sessions = new WebSessionStore(), themes = new ThemeStore(root), prefs = new WebPrefsStore(root), library = new WebEffectLibrary(root);
  writeFileSync(path, yaml.dump(config));
  const service = new WebEffectService({ library, themes, prefs, profiles: new WebEffectProfiles(root), known: n => n === "own", changed: vi.fn() });
  const appearance = new WebAppearance(themes, () => config.web, vi.fn(), new AppearanceLimiter());
  const save = vi.fn(() => writeFileSync(path, yaml.dump(config)));
  const ctx: any = { dataDir: root, configPath: path, fleetConfig: config, webToken: TOKEN, webSessions: sessions, webLoginCodes: null, themeStore: themes, webPrefs: prefs, effectService: service, webAppearance: appearance,
    getRawFleetConfig: () => config, saveFleetConfig: save, isKnownInstance: (n: string) => n === "own", emitSseEvent: vi.fn(), getUiStatus: () => ({}), logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } };
  const server = createServer((req, res) => {
    if (req.headers["x-private-gateway"] === "1") bindGatewayRequest(req, { surface: "gateway", exposureId: EXPOSURE, expectedOrigin: "https://private.invalid", isCurrent: () => true });
    const url = new URL(req.url!, "http://localhost");
    if (handleSettingsRequest(req, res, url, ctx) || handleWebRequest(req, res, url, ctx)) return;
    res.writeHead(404); res.end('{}');
  }); servers.push(server);
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r)); const port = (server.address() as { port: number }).port, origin = `http://127.0.0.1:${port}`;
  const session = (tier: SessionTier = "admin", gateway = false) => {
    const made = sessions.create({ tier, surface: gateway ? "gateway" : "local", label: "private test", tokenEpoch: tokenEpoch(TOKEN), owner: { adapterId: "discord", userId: "alice" }, ...(gateway ? { exposureId: EXPOSURE } : {}) });
    return { ...made, person: "person:discord:alice", headers: { cookie: `${gateway ? "__Host-agend_session" : "agend_session"}=${made.sessionId}`, origin: gateway ? "https://private.invalid" : origin, "x-agend-csrf": csrfTokenFor(made.sessionId), ...(gateway ? { "x-private-gateway": "1" } : {}) } };
  };
  const call = (method: string, url: string, headers: Record<string, string> = {}, body?: unknown) => new Promise<{ status: number; body: any }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path: url, headers }, res => { let text = ""; res.setEncoding("utf8"); res.on("data", x => { text += x; }); res.on("end", () => resolve({ status: res.statusCode!, body: JSON.parse(text) })); });
    req.on("error", reject); req.setTimeout(5000, () => req.destroy(Error("private HTTP deadline"))); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  return { root, path, config, prefs, themes, library, service, save, ctx, session, call };
}

describe("CW config and settings admission", () => {
  it("fences the legacy preview CW bootstrap live while ordinary HTML previews stay available", async () => {
    let enabled = false;
    const listener = createPreviewListener({ settings: { enabled: true, port: 0, origin: null }, healthPort: 19280, config: {}, canvasWorkerEnabled: () => enabled });
    servers.push(listener.server);
    await new Promise<void>(r => listener.server.listen(0, "127.0.0.1", r));
    const port = (listener.server.address() as { port: number }).port;
    const get = (path: string) => new Promise<{ status: number; text: string }>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, path }, res => { let text = ""; res.setEncoding("utf8"); res.on("data", chunk => { text += chunk; }); res.on("end", () => resolve({ status: res.statusCode!, text })); });
      req.on("error", reject); req.end();
    });
    expect((await get("/effect")).status).toBe(403);
    expect((await get("/frame")).status).toBe(200);
    enabled = true;
    expect(await get("/effect")).toMatchObject({ status: 200, text: expect.stringContaining("<title>Effect</title>") });
    enabled = false;
    expect((await get("/effect")).status).toBe(403);
    expect((await get("/frame")).status).toBe(200);
  });
  it("validates the nested setting without truthy coercion or unknown feature keys", () => {
    const web: WebConfig = { experimental: { canvas_worker: true } };
    expect(canvasWorkerEnabled(web)).toBe(true);
    for (const candidate of [undefined, {}, { canvas_worker: false }, { canvas_worker: true }]) expect(validateFleetConfig({ defaults: {}, instances: {}, web: candidate === undefined ? {} : { experimental: candidate } }).errors.filter(e => e.path.startsWith("web.experimental"))).toEqual([]);
    expect(canvasWorkerEnabled({})).toBe(false);
    for (const candidate of [null, [], true, { canvas_worker: "true" }, { canvas_worker: 1 }, { something_else: true }]) expect(validateFleetConfig({ defaults: {}, instances: {}, web: { experimental: candidate } }).errors.some(e => e.path.startsWith("web.experimental")), JSON.stringify(candidate)).toBe(true);
    for (const enabled of [false, true]) expect(parseWebSettingsBody({ experimental: { canvas_worker: enabled } })).toMatchObject({ canvasWorker: enabled });
    for (const candidate of [null, [], {}, true, { canvas_worker: "true" }, { canvas_worker: null }, { canvas_worker: true, other: true }]) expect(parseWebSettingsBody({ experimental: candidate })).toHaveProperty("error");
  });
  it("names enabling in confirmation while disabling and shared settings remain immediate", () => {
    const effect = (enabled: boolean, before: boolean) => prepareSettingsEffect("PUT", WEB, { experimental: { canvas_worker: enabled } }, { config: { defaults: {}, instances: {}, web: { experimental: { canvas_worker: before } } } as any, classic: {} }).diff;
    const enable = effect(true, false);
    expect(enable?.section).toBe("access");
    expect(enable?.summary.join("\n")).toContain("canvas\\_worker: false → true");
    expect(effect(false, true)).toBeNull();
    expect(prepareSettingsEffect("PUT", WEB, { echo_to_channel: false }, { config: { defaults: {}, instances: {} } as any, classic: {} }).diff).toBeNull();
  });
  it("writes only for a local signed-in admin; header, guest, read and public sessions cannot toggle", async () => {
    const f = await httpFixture(); const before = readFileSync(f.path, "utf8");
    const headers = [{ "x-agend-token": TOKEN }, f.session("guest").headers, f.session("read").headers, f.session("admin", true).headers];
    for (const h of headers) {
      const result = await f.call("PUT", WEB, h, { experimental: { canvas_worker: true } });
      expect(result.status).toBe(403); expect(f.save).not.toHaveBeenCalled(); expect(readFileSync(f.path, "utf8")).toBe(before);
    }
    const admin = f.session();
    expect((await f.call("PUT", WEB, admin.headers, { experimental: { canvas_worker: true } })).status).toBe(200);
    expect(f.config.web.experimental.canvas_worker).toBe(true);
    expect((yaml.load(readFileSync(f.path, "utf8")) as any).web.experimental.canvas_worker).toBe(true);
    expect((await f.call("PUT", WEB, admin.headers, { experimental: { canvas_worker: false } })).status).toBe(200);
    expect(f.config.web.experimental.canvas_worker).toBe(false);
  });
  it("refreshes live visibility exactly after successful changed settings, never on failed save or no-op", async () => {
    const f = await httpFixture(), admin = f.session(), changes: boolean[] = [];
    const changed = vi.fn(() => { const disk = yaml.load(readFileSync(f.path, "utf8")) as any; expect(disk.web.experimental.canvas_worker).toBe(f.config.web.experimental.canvas_worker); changes.push(disk.web.experimental.canvas_worker); });
    f.ctx.canvasWorkerSettingChanged = changed;
    expect((await f.call("PUT", WEB, admin.headers, { experimental: { canvas_worker: false } })).status).toBe(200);
    expect((await f.call("PUT", WEB, admin.headers, { echo_to_channel: false })).status).toBe(200); expect(changed).not.toHaveBeenCalled();
    expect((await f.call("PUT", WEB, admin.headers, { experimental: { canvas_worker: true } })).status).toBe(200);
    expect(changes).toEqual([true]);
    expect((await f.call("PUT", WEB, admin.headers, { experimental: { canvas_worker: true } })).status).toBe(200); expect(changes).toEqual([true]);
    f.save.mockImplementationOnce(() => { throw Error("inert disk failure"); });
    expect((await f.call("PUT", WEB, admin.headers, { experimental: { canvas_worker: false } })).status).toBe(500);
    expect(f.config.web.experimental.canvas_worker).toBe(true); expect(changes).toEqual([true]);
    expect((await f.call("PUT", WEB, admin.headers, { experimental: { canvas_worker: false } })).status).toBe(200); expect(changes).toEqual([true, false]);
  });

});

describe("CW HTTP graph and shared ambient", () => {
  it("refuses all CW request families before touching services, credentials or request bodies", () => {
    const paths = ["/ui/effects", "/ui/effects/upload", `/ui/effects/resource/${ID}`, `/ui/effects/image/${ID}/poster.png`, `/ui/effects/profile/${ID}`, "/ui/effects/placements", "/ui/effects/owner", "/ui/effect-posters", "/ui/effect-trials", `/ui/effect-trials/${ID}/start`, "/effect-bootstrap", "/effect-bootstrap/worker.js", "/ui/js/effect-frame.js"];
    const serviceRead = vi.fn(() => { throw Error("CW service must stay asleep"); });
    const ctx: any = { fleetConfig: {}, get effectService() { return serviceRead(); }, get webSessions() { throw Error("no auth lookup needed for disabled route"); } };
    for (const path of paths) for (const method of ["GET", "POST", "DELETE"]) {
      const f = reqRes(method, path);
      let handled: boolean | undefined;
      expect(() => { handled = handleWebRequest(f.req as never, f.res, new URL(path, "http://localhost"), ctx); }).not.toThrow();
      expect(handled).toBe(true);
      expect(f.status()).toBe(403); expect(f.json()).toMatchObject({ error: "canvas_worker_experimental", message: CANVAS_WORKER_EXPERIMENTAL_MESSAGE });
      expect(f.req.listenerCount("data")).toBe(0);
    }
    expect(serviceRead).not.toHaveBeenCalled();
  });
  it("enabled requests reach the original authenticated library; disabling stops them without deleting storage", async () => {
    const f = await httpFixture(), admin = f.session();
    const listed = vi.spyOn(f.service, "list");
    expect((await f.call("GET", "/ui/effects", admin.headers)).status).toBe(403); expect(listed).not.toHaveBeenCalled();
    f.config.web.experimental.canvas_worker = true;
    expect(await f.call("GET", "/ui/effects", admin.headers)).toMatchObject({ status: 200, body: { effects: [], canWrite: true } });
    expect(listed).toHaveBeenCalledOnce();
    f.config.web.experimental.canvas_worker = false;
    expect((await f.call("POST", "/ui/themes/own/ambient", admin.headers, { spec: PETALS })).status).toBe(200);
    expect(f.themes.get("own").placements.ambient.loop?.spec.glyphs).toEqual(PETALS.glyphs);
    expect((await f.call("GET", "/ui/effects", admin.headers)).status).toBe(403); expect(listed).toHaveBeenCalledOnce();
  });
  it("off refuses owner selection writes atomically, preserves saved selections and leaves shared ambient preferences writable", async () => {
    const f = await httpFixture(), admin = f.session();
    expect(f.prefs.writeForViewer(admin.person, new Map([["fx.page", ID]]), { validateEffect: () => null }).ok).toBe(true);
    const before = readFileSync(f.prefs.path, "utf8");
    for (const key of ["fx.sidebar", "fx.header", "fx.page", "fx.box", "fx.cursor"]) {
      expect((await f.call("POST", "/ui/prefs", admin.headers, { set: { theme: "dark", [key]: null }, ownerEpoch: admin.record.handle })).status).toBe(403);
      expect(readFileSync(f.prefs.path, "utf8")).toBe(before);
    }
    // fx.show also controls ordinary themes/ambient; it is deliberately not a CW-only selection key.
    expect((await f.call("POST", "/ui/prefs", admin.headers, { set: { "fx.show": false, theme: "dark" } })).status).toBe(200);
    const reopened = new WebPrefsStore(f.root).readForViewer(admin.person).values;
    expect(reopened).toMatchObject({ "fx.page": ID, "fx.show": false, theme: "dark" });
    f.config.web.experimental.canvas_worker = true;
    expect((await f.call("POST", "/ui/prefs", admin.headers, { set: { "fx.page": null }, ownerEpoch: admin.record.handle })).status).toBe(200);
    expect(new WebPrefsStore(f.root).readForViewer(admin.person).values["fx.page"]).toBeUndefined();
  });
  it.each([["upload", false], ["upload", true], ["trial", false], ["trial", true]] as const)("held %s body checks the current flag before side effects (remain enabled=%s)", async (kind, enabled) => {
    const f = await httpFixture(), admin = f.session(); f.config.web.experimental.canvas_worker = true;
    const path = kind === "upload" ? "/ui/effects/upload" : `/ui/effect-trials/start?ownerEpoch=${admin.record.handle}`;
    const r = reqRes("POST", path, admin.headers); r.req.headers.host = new URL(admin.headers.origin).host;
    const sideEffect = kind === "upload" ? vi.spyOn(f.service, "upload").mockReturnValue({ id: ID }) : vi.spyOn(f.service, "trialStart").mockReturnValue({ started: true });
    expect(handleWebRequest(r.req as never, r.res, new URL(path, admin.headers.origin), f.ctx)).toBe(true);
    expect(r.status()).toBe(0); expect(r.req.listenerCount("data")).toBe(1);
    f.config.web.experimental.canvas_worker = enabled;
    const body = kind === "upload" ? encodeEffectFiles(modFixture().files)! : Buffer.from(JSON.stringify({ offer: ID, instance: "own" }));
    r.req.emit("data", body); r.req.emit("end");
    for (let i = 0; i < 40; i++) await Promise.resolve();
    expect(r.status()).toBe(enabled ? 200 : 403); expect(sideEffect).toHaveBeenCalledTimes(enabled ? 1 : 0);
    if (!enabled) expect(r.json().error).toBe("canvas_worker_experimental");
  });
  it("guest status and poll/stream projections carry only a strict feature boolean and retain instance scoping", () => {
    for (const value of [undefined, false, "true", 1, true]) {
      const status = { canvas_worker: value, secret: "not for guests", instances: [{ name: "own", status: "running" }, { name: "hidden" }] };
      const scope = new Set(["own"]), expected = { canvas_worker: value === true, instances: [{ name: "own", status: "running" }] };
      expect(guestStatus(status, scope)).toEqual(expected);
      expect(guestFrameData("status", status, scope)).toEqual(expected);
      expect(guestPollBody(status, scope, 42).status).toEqual(expected);
    }
    expect(guestStatus(null, new Set())).toEqual({ canvas_worker: false, instances: [] });
  });
  it("installed CW mod files are refused off before ownership reads, while plain mod files remain available", async () => {
    const f = await httpFixture(), admin = f.session(), m = modFixture(); f.ctx.mods = m.store;
    const install = (name: string, effects: boolean) => { const stage = m.store.stage(admin.person, m.make(name, effects)); if (!stage.ok) throw Error(JSON.stringify(stage)); const result = m.store.commit(admin.person, { stage: stage.stage, plan_hash: stage.plan_hash, include: { theme: true, ambient: true, effects }, target: "own" }); if (!result.ok) throw Error(JSON.stringify(result)); return result.id; };
    const cw = install("cw-file", true), plain = install("plain-file", false), canRead = vi.fn(() => ({ name: "fixture", files: m.files })); f.ctx.modPlacedEffect = canRead;
    expect((await f.call("GET", `/ui/mods/file/${cw}`, admin.headers)).status).toBe(403); expect(canRead).not.toHaveBeenCalled();
    expect(await f.call("GET", `/ui/mods/file/${plain}`, admin.headers)).toMatchObject({ status: 200, body: { format: "agend-mod" } }); expect(canRead).not.toHaveBeenCalled();
    vi.spyOn(m.store, "bundleEffects").mockReturnValueOnce("unknown");
    expect((await f.call("GET", `/ui/mods/file/${plain}`, admin.headers)).status).toBe(403); expect(canRead).not.toHaveBeenCalled();
    f.config.web.experimental.canvas_worker = true;
    expect(await f.call("GET", `/ui/mods/file/${cw}`, admin.headers)).toMatchObject({ status: 200, body: { format: "agend-mod" } }); expect(canRead).toHaveBeenCalledOnce();
  });
  it("auth assets deny CW module loads while retaining neutral appearance and shared motion helpers", () => {
    for (const enabled of [false, true]) {
      const ctx: any = { fleetConfig: { web: { experimental: { canvas_worker: enabled } } } };
      for (const path of ["/assets/effect-frame.js", "/assets/effect-posters.js", "/assets/effect-trial.css", "/assets/owner-effect-prefs.js"]) {
        const f = reqRes("GET", path); expect(handleAuthRequest(f.req as never, f.res, new URL(path, "http://localhost"), ctx)).toBe(true);
        expect(f.status()).toBe(enabled ? 200 : 404);
        if (!enabled) expect(f.json().error).toBe("canvas_worker_experimental");
      }
      for (const path of ["/assets/fx-motion.js", "/assets/agent-widget.js", "/assets/feature-flags.js", "/assets/app.css"]) {
        const f = reqRes("GET", path); expect(handleAuthRequest(f.req as never, f.res, new URL(path, "http://localhost"), ctx)).toBe(true); expect(f.status()).toBe(200);
      }
    }
  });
  it("the HTML shell publishes a strict feature boolean on local/public and anonymous View pages", () => {
    for (const value of [undefined, false, "true", 1, true]) for (const mode of ["full", "view-only"] as const) for (const publicLink of [false, true]) {
      const f = reqRes("GET", "/ui");
      if (publicLink) bindGatewayRequest(f.req, { surface: "gateway", exposureId: EXPOSURE, expectedOrigin: "https://private.invalid", isCurrent: () => true });
      serveAppShell(f.req as never, f.res, { fleetConfig: { web: { experimental: { canvas_worker: value } } } } as never, mode);
      expect(f.status()).toBe(200); expect(f.text()).toContain(`data-canvas-worker="${value === true ? "1" : "0"}"`);
    }
  });
});

describe("FleetManager product guards without constructing a fleet", () => {
  it.each(TOOLS)("%s is refused by direct HTTP and permission admission, with the right typed IPC response family", async tool => {
    const fm = Object.create(FleetManager.prototype) as any;
    fm.fleetConfig = { defaults: {}, instances: { own: { tool_set: "full" } } };
    fm.logger = { debug: vi.fn(), warn: vi.fn() };
    const send = vi.fn(); fm.instanceIpcClients = new Map([["own", { send }]]);
    expect(fm.checkToolPermission("ipc-typed", "own", tool)).toEqual({ allowed: false, message: CANVAS_WORKER_EXPERIMENTAL_MESSAGE });
    expect(await fm.handleWebThemeHttp("own", tool, {})).toEqual({ error: "canvas_worker_experimental", message: CANVAS_WORKER_EXPERIMENTAL_MESSAGE });
    fm.refuseTypedIpc("own", { type: `fleet_${tool}`, fleetRequestId: "request-17" }, CANVAS_WORKER_EXPERIMENTAL_MESSAGE);
    expect(send).toHaveBeenCalledWith({ type: "fleet_web_theme_response", fleetRequestId: "request-17", error: CANVAS_WORKER_EXPERIMENTAL_MESSAGE });
    fm.fleetConfig.web = { experimental: { canvas_worker: true } };
    expect(fm.checkToolPermission("ipc-typed", "own", tool).allowed).toBe(true);
    expect(fm.checkToolPermission("ipc-typed", "own", "set_web_ambient").allowed).toBe(true);
    delete fm.fleetConfig.web;
    expect(fm.checkToolPermission("ipc-typed", "own", "set_web_ambient").allowed).toBe(true);
  });
});

function modFixture() {
  const root = tmp(), themes = new ThemeStore(root), prefs = new WebPrefsStore(root), library = new WebEffectLibrary(root); let enabled = true;
  const effects = { stage: (entries: readonly any[], principal: any, options: any) => library.stage(entries, principal, options), commit: (stage: string) => library.commit(stage), abort: (stage: string) => library.abort(stage), releaseHolder: (holder: string, principal: any) => library.releaseHolder(holder, principal) };
  const store = new ModStore(root, { themes, prefs, ownerCss: null, effects, canvasWorkerEnabled: () => enabled, context: () => ({ agendVersion: "2.3.0", limits: effectiveAppearanceLimits(undefined).limits, effects: cw1EffectChecker() }), isKnownInstance: n => n === "own", prefsIdentity: "operator" });
  const files = new Map<string, Uint8Array>([["effect.json", Buffer.from(JSON.stringify({ v: 1, runtime: "canvas-worker-v1", worker: "worker.js", name: "fixture", title: "Fixture", regions: ["chat"], layer: "behind", wants: [] }))], ["worker.js", Buffer.from("agend.ready()")]]);
  const make = (name: string, withEffect: boolean) => {
    const result = buildModBundle({ name, version: "1.0.0", title: name }, { theme: { theme: { v: 1, accent: "#8b5cf6" }, picture: () => null, ...(withEffect ? { effects: [{ name: "fixture", files, params: {} }] } : {}) }, ambient: { specs: { loop: ambient() }, picture: () => null } });
    if (!result.ok) throw Error(JSON.stringify(result)); return result.text;
  };
  return { root, themes, prefs, library, store, files, make, set: (on: boolean) => { enabled = on; } };
}
describe("disabled CW survives ordinary mod/ambient operations", () => {
  it("rejects staged/committed/uninstalled CW bundles without disk changes and restores the same stage on enable", () => {
    const f = modFixture(), withEffect = f.make("with-effect", true);
    f.set(false); const beforeStage = snapshot(f.root);
    expect(f.store.stage("person", withEffect)).toMatchObject({ ok: false, status: 403, error: "canvas_worker_experimental" }); expect(snapshot(f.root)).toEqual(beforeStage);
    f.set(true); const stage = f.store.stage("person", withEffect); if (!stage.ok) throw Error(JSON.stringify(stage));
    f.set(false); const beforeCommit = snapshot(f.root), input = { stage: stage.stage, plan_hash: stage.plan_hash, include: { theme: true, effects: true, ambient: true }, target: "own" };
    expect(f.store.commit("person", input)).toMatchObject({ ok: false, status: 403, error: "canvas_worker_experimental" }); expect(snapshot(f.root)).toEqual(beforeCommit);
    f.set(true); const installed = f.store.commit("person", input); if (!installed.ok) throw Error(JSON.stringify(installed));
    const placed = f.themes.get("own").placements.effects;
    expect(placed).toHaveLength(1); const beforeUninstall = snapshot(f.root);
    f.set(false); expect(f.store.uninstall(installed.id)).toMatchObject({ ok: false, status: 403, error: "canvas_worker_experimental" }); expect(snapshot(f.root)).toEqual(beforeUninstall);
    f.set(true); expect(f.store.uninstall(installed.id).ok).toBe(true); expect(f.themes.get("own").placements.effects).toEqual(placed);
  });
  it("non-CW mod apply/uninstall while off changes ambient/theme and retains previous CW placements", () => {
    const f = modFixture(); expect(f.themes.setPlacements("own", { effects: [ID] }, "human", () => null).ok).toBe(true);
    const stored = f.themes.get("own").placements.effects; f.set(false);
    const stage = f.store.stage("person", f.make("ambient-only", false)); if (!stage.ok) throw Error(JSON.stringify(stage));
    const result = f.store.commit("person", { stage: stage.stage, plan_hash: stage.plan_hash, include: { theme: true, ambient: true }, target: "own" });
    expect(result.ok, JSON.stringify(result)).toBe(true); if (!result.ok) return;
    expect(f.themes.get("own").placements.effects).toEqual(stored); expect(f.themes.get("own").placements.ambient.loop?.spec).toEqual(ambient());
    expect(f.store.uninstall(result.id).ok).toBe(true); expect(f.themes.get("own").placements.effects).toEqual(stored);
  });
  it("export while off omits hidden CW files without reading them, retains ambient and restores CW export when enabled", () => {
    const f = modFixture(); f.themes.setTheme("own", { v: 1, accent: "#8b5cf6" }, "agent"); f.themes.setAmbient("own", ambient(), "agent"); f.themes.setPlacements("own", { effects: [ID] }, "human", () => null);
    const readEffect = vi.fn(() => ({ name: "fixture", files: f.files }));
    const ctx: any = { themeStore: f.themes, fleetConfig: { web: {} }, isKnownInstance: () => true, modPlacedEffect: readEffect };
    const body = { instance: "own", name: "exported", version: "1.0.0", title: "Exported", include: { theme: true, ambient: true } };
    const before = snapshot(f.root), off = exportMod(ctx, "person", body); if (!off.ok) throw Error(JSON.stringify(off));
    const doc = JSON.parse(off.text); expect(doc.manifest.contents.ambient).toBeDefined(); expect(doc.manifest.contents.effects).toBeUndefined(); expect(Object.keys(doc.files).some(p => p.startsWith("effects/"))).toBe(false); expect(readEffect).not.toHaveBeenCalled(); expect(snapshot(f.root)).toEqual(before);
    ctx.fleetConfig.web.experimental = { canvas_worker: true }; const on = exportMod(ctx, "person", body); if (!on.ok) throw Error(JSON.stringify(on));
    expect(JSON.parse(on.text).manifest.contents.effects).toEqual(["effects/fixture"]); expect(readEffect).toHaveBeenCalledOnce(); expect(snapshot(f.root)).toEqual(before);
  });
});
