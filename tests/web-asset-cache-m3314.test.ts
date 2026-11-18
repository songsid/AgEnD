/**
 * M-3314 (measured in M-3312: every file no-store, the app's modules in ~14 waves over the fixed link):
 * - /assets/v-<V>/<name> and /ui/js/v-<V>/<name> serve exactly the plain path's file, through the same gates, cached for
 *   good (public / private immutable); the plain paths are unchanged (no-store);
 * - a request for another <V> (a tab opened before an update or a rollback) never gets this version's file: a module
 *   throws the stale-tab SyntaxError (#3822's prompt), anything else is a 404;
 * - <V> follows the files: change one byte and it changes;
 * - the app shell carries the import map (with the page's nonce), its own files versioned, and a modulepreload for
 *   everything the load imports — /ui, Settings and the Fleet org chart load in ≤ 2 waves (14-ish without);
 * - the public link's route list admits the versioned paths as their plain ones; a guest's shell preloads nothing it
 *   would not load itself;
 * - module-warm.js preloads a later panel's graph at once, under the version.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { request, type Server } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import { FleetManager } from "../src/fleet-manager.js";
import { tokenEpoch } from "../src/web-session.js";
import { WEB_SESSION_COOKIE } from "../src/web-auth.js";
import { isPublicWebRoute } from "../src/public-web-gateway.js";
import { assetVersion, computeAssetVersion, loadWaves, staticClosure, STALE_MODULE_BODY, takeAssetVersion, assetVersionMark } from "../src/web-asset-version.js";
import { appModuleGraph, shellPreload, PANEL_MODULES } from "../src/web-api.js";
import { createWarmer } from "../src/ui/shared/module-warm.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); vi.restoreAllMocks(); });

type Got = { status: number; headers: Record<string, string | string[] | undefined>; body: string };
function get(port: number, path: string, headers: Record<string, string> = {}): Promise<Got> {
  return new Promise((resolve, reject) => {
    const r = request({ host: "127.0.0.1", port, method: "GET", path, headers }, res => {
      let text = ""; res.on("data", (c: Buffer) => { text += c.toString(); });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }));
    });
    r.on("error", reject); r.end();
  });
}
async function listener() {
  const dir = mkdtempSync(join(tmpdir(), "agend-m3314-")); dirs.push(dir);
  const fm = new FleetManager(dir);
  (fm as any).fleetConfig = { instances: {} };
  const quiet = () => {};
  fm.logger = { info: quiet, warn: quiet, error: quiet, debug: quiet, trace: quiet, fatal: quiet, child: () => fm.logger } as unknown as typeof fm.logger;
  vi.spyOn(fm, "notifyFleetError").mockImplementation(() => true);
  (fm as any).initializeWebAuthTokens();
  (fm as any).startHealthServer(0);
  await vi.waitFor(() => expect(fm.getDashboardAccess().ready).toBe(true));
  const server = (fm as unknown as { healthServer: Server }).healthServer;
  const admin = (fm as any).webSessions.create({ tier: "admin", surface: "local", label: "admin", tokenEpoch: tokenEpoch(fm.getDashboardAccess().token!) }).sessionId as string;
  return { fm, port: (server.address() as { port: number }).port, cookie: { cookie: `${WEB_SESSION_COOKIE}=${admin}` }, stop: () => new Promise<void>(r => server.close(() => r())) };
}
const OLD = "0123456789ab";

describe("versioned files", () => {
  it("/assets/v-<V>/ is the plain file, public immutable; the plain path stays no-store; another <V> is the stale-tab answer", async () => {
    const h = await listener();
    try {
      const V = assetVersion();
      const plain = await get(h.port, "/assets/app.js"), v = await get(h.port, `/assets/v-${V}/app.js`);
      expect([plain.status, v.status]).toEqual([200, 200]);
      expect(v.body).toBe(plain.body);
      expect(v.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
      expect(plain.headers["cache-control"]).toBe("no-store");
      const stale = await get(h.port, `/assets/v-${OLD}/app.js`);
      expect([stale.status, stale.body, stale.headers["cache-control"]]).toEqual([200, STALE_MODULE_BODY, "no-store"]);
      let thrown: unknown; try { vm.runInNewContext(stale.body); } catch (e) { thrown = e; }
      expect((thrown as Error)?.name).toBe("SyntaxError");                                       // what isStaleModuleError recognises
      expect((await get(h.port, `/assets/v-${OLD}/app.css`)).status).toBe(404);
      expect((await get(h.port, `/assets/v-${V}/nope.js`)).status).toBe(404);
      // A stylesheet under <V> names its fonts and @imports under the same <V>.
      const css = await get(h.port, `/assets/v-${V}/app.css`);
      expect(css.body).not.toContain('url("/assets/inter');
      expect(css.body.includes(`url("/assets/v-${V}/`) || !(await get(h.port, "/assets/app.css")).body.includes('url("/assets/')).toBe(true);
    } finally { await h.stop(); }
  });

  it("/ui/js/v-<V>/ keeps the session gate (401 without one), then private immutable; another <V> is the stale answer", async () => {
    const h = await listener();
    try {
      const V = assetVersion();
      expect((await get(h.port, `/ui/js/v-${V}/panel-chat.js`)).status).toBe(401);
      expect((await get(h.port, `/ui/js/v-${OLD}/panel-chat.js`)).status).toBe(401);
      const plain = await get(h.port, "/ui/js/panel-chat.js", h.cookie), v = await get(h.port, `/ui/js/v-${V}/panel-chat.js`, h.cookie);
      expect([plain.status, v.status]).toEqual([200, 200]);
      expect(v.body).toBe(plain.body);
      expect(v.headers["cache-control"]).toBe("private, max-age=31536000, immutable");
      expect(plain.headers["cache-control"]).toBe("no-store");
      expect((await get(h.port, `/ui/js/v-${OLD}/panel-chat.js`, h.cookie)).body).toBe(STALE_MODULE_BODY);
      expect((await get(h.port, `/ui/js/v-${V}/../app.js`, h.cookie)).status).not.toBe(200);
    } finally { await h.stop(); }
  });

  it("<V> follows the files: one changed byte, a new version (an update or a rollback busts every cached file)", () => {
    const d = mkdtempSync(join(tmpdir(), "agend-m3314-v-")); dirs.push(d);
    mkdirSync(join(d, "shared"));
    writeFileSync(join(d, "a.js"), "export const a = 1;\n"); writeFileSync(join(d, "shared", "b.css"), "x{}\n");
    const v1 = computeAssetVersion(d);
    expect(v1).toMatch(/^[0-9a-f]{12}$/);
    expect(computeAssetVersion(d)).toBe(v1);
    writeFileSync(join(d, "shared", "b.css"), "x{ }\n");
    expect(computeAssetVersion(d)).not.toBe(v1);
  });

  it("takeAssetVersion: a versioned path becomes its plain one (query kept) and is marked; anything else is left alone", () => {
    const req = (url: string) => ({ url }) as any;
    const a = req(`/ui/js/v-${OLD}/panel-chat.js?retry=1`); takeAssetVersion(a, () => "ffffffffffff");
    expect([a.url, assetVersionMark(a)]).toEqual(["/ui/js/panel-chat.js?retry=1", { current: false, version: OLD }]);
    for (const u of ["/assets/app.js", "/assets/v-123/app.js", `/assets/v-${OLD}/x/y.js`, `/ui/v-${OLD}/a.js`, `/ui/js/v-${OLD.toUpperCase()}/a.js`]) {
      const r = req(u); takeAssetVersion(r, () => OLD); expect([r.url, assetVersionMark(r)]).toEqual([u, undefined]);
    }
    const c = req(`/assets/v-${OLD}/app.js`); takeAssetVersion(c, () => OLD);
    expect(assetVersionMark(c)).toEqual({ current: true, version: OLD });
  });
});

describe("the app shell", () => {
  it("an admin's /ui: the import map with the page's nonce, its files versioned, every module of the load preloaded", async () => {
    const h = await listener();
    try {
      const V = assetVersion();
      const page = await get(h.port, "/ui", h.cookie);
      expect(page.status).toBe(200);
      const nonce = /script-src 'self' 'nonce-([^']+)'/.exec(String(page.headers["content-security-policy"]))![1];
      const map = new RegExp(`<script type="importmap" nonce="${nonce.replace(/[+/=]/g, "\\$&")}">([^<]+)</script>`).exec(page.body);
      expect(map, "the import map carries the nonce").not.toBeNull();
      expect(JSON.parse(map![1]).imports).toEqual({ "/assets/": `/assets/v-${V}/`, "/ui/js/": `/ui/js/v-${V}/`, [`/assets/v-${V}/`]: `/assets/v-${V}/`, [`/ui/js/v-${V}/`]: `/ui/js/v-${V}/` });
      expect(page.body.indexOf('type="importmap"')).toBeLessThan(page.body.indexOf("modulepreload"));
      expect(page.body).toContain(`<script type="module" src="/assets/v-${V}/app.js"></script>`);
      expect(page.body).toContain(`<link rel="stylesheet" href="/assets/v-${V}/app.css">`);
      const preloads = [...page.body.matchAll(/<link rel="modulepreload" href="([^"]+)">/g)].map(m => m[1]);
      expect(preloads).toContain(`/assets/v-${V}/app.js`);
      expect(preloads).toContain(`/ui/js/v-${V}/panel-chat.js`);
      for (const p of preloads.slice(0, 400)) expect((await get(h.port, p, h.cookie)).status, p).toBe(200);   // nothing preloaded is missing
      expect(page.body).toContain('<script type="application/json" id="agend-modules">');
    } finally { await h.stop(); }
  });

  it("/ui, Settings and the Fleet org chart load in ≤ 2 waves with the shell's preloads (≈14 without)", () => {
    const graph = appModuleGraph();
    const cases: Array<[string, string[]]> = [
      ["/ui", ["/assets/app.js", PANEL_MODULES.chat]],
      ["/settings", ["/assets/app.js", PANEL_MODULES.chat, PANEL_MODULES.settings]],
      ["/ui/fleet/org", ["/assets/app.js", PANEL_MODULES.chat, PANEL_MODULES.fleet]],
    ];
    for (const [path, entries] of cases) {
      const without = loadWaves(graph, entries, new Set());
      const withPreload = loadWaves(graph, entries, new Set(shellPreload("full", false, path, false)));
      expect(without, `${path} without preloads`).toBeGreaterThanOrEqual(4);
      expect(withPreload, `${path} with the shell's preloads`).toBeLessThanOrEqual(2);
    }
  });

  it("a guest's or a reader's shell preloads only what it imports itself (no admin-only panel)", () => {
    const guest = shellPreload("full", true, "/settings", true);
    expect(guest).toContain("/assets/app.js");
    expect(guest).not.toContain(PANEL_MODULES.settings);
    expect(guest.sort()).toEqual(staticClosure(appModuleGraph(), ["/assets/app.js", PANEL_MODULES.chat]).sort());   // what a guest's page loads itself
    const reader = shellPreload("view-only", false, "/view", false);
    expect(reader.every(u => u.startsWith("/assets/"))).toBe(true);
    expect(reader).toContain(PANEL_MODULES.view);
  });

  it("the public link admits a versioned path exactly as its plain one", () => {
    const V = assetVersion();
    for (const [plain, verd] of [["/assets/app.js", `/assets/v-${V}/app.js`], ["/ui/js/panel-chat.js", `/ui/js/v-${V}/panel-chat.js`], ["/assets/nope.js", `/assets/v-${V}/nope.js`]]) {
      const r = { url: verd } as any; takeAssetVersion(r);
      expect(isPublicWebRoute("GET", r.url), verd).toBe(isPublicWebRoute("GET", plain));
    }
  });
});

describe("module-warm.js", () => {
  function fakeDoc(graph: Record<string, string[]> | null) {
    const links: Array<Record<string, string>> = [];
    const head = {
      appendChild: (l: { attrs: Record<string, string> }) => { links.push(l.attrs); },
      querySelector: (sel: string) => links.find(l => sel.includes(`href="${l.href}"`)) ?? null,
    };
    return { links, doc: {
      head,
      getElementById: (id: string) => (id === "agend-modules" && graph ? { textContent: JSON.stringify(graph) } : null),
      createElement: () => { const attrs: Record<string, string> = {}; return { attrs, setAttribute: (k: string, v: string) => { attrs[k] = v; } }; },
    } };
  }
  const G = { "/ui/js/panel-settings.js": ["/assets/app-html.js", "/ui/js/settings-a.js"], "/ui/js/settings-a.js": ["/assets/app-html.js"], "/assets/app-html.js": [] };

  it("a panel's whole graph is preloaded at once under the page's version, each file once", () => {
    const f = fakeDoc(G);
    const warm = createWarmer({ doc: f.doc as never, url: `http://h/assets/v-${OLD}/module-warm.js` });
    expect(warm("/ui/js/panel-settings.js")).toBe(3);
    expect(f.links.map(l => l.href).sort()).toEqual([`/assets/v-${OLD}/app-html.js`, `/ui/js/v-${OLD}/panel-settings.js`, `/ui/js/v-${OLD}/settings-a.js`]);
    expect(f.links.every(l => l.rel === "modulepreload")).toBe(true);
    expect(warm("/ui/js/panel-settings.js")).toBe(0);
  });
  it("loaded from a plain path, or with no graph on the page, it does nothing", () => {
    expect(createWarmer({ doc: fakeDoc(G).doc as never, url: "http://h/assets/module-warm.js" })("/ui/js/panel-settings.js")).toBe(0);
    expect(createWarmer({ doc: fakeDoc(null).doc as never, url: `http://h/assets/v-${OLD}/module-warm.js` })("/ui/js/panel-settings.js")).toBe(0);
  });
});
