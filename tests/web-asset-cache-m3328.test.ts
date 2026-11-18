/**
 * M-3328 (measured in M-3316, after M-3314's versioned modules): what a module adds to the page later was still a plain,
 * `no-store` request on every open —
 * - the panels' own stylesheets (loading, hub, reply-previews, chat-work-bar, task-board, runtime-install,
 *   access-overview, …) and the office backgrounds (office-cozy/guild/school.png): now `assetUrl()` puts them under the
 *   page's version (public immutable), and a tab older than the server asks for its own version — a 404, never a newer
 *   file;
 * - the org chart's route worker (a worker does not use the page's import map): now under the module's own version, so
 *   its `./fleet-route-scene.js` / `./fleet-canvas-layout.js` are the page's cached files; libavoid's .wasm and glue and
 *   the worker are asked for together when Live is on (warmRouter), not one after another at the first routed scene.
 * Wherever the modules are loaded by their plain paths (the Hub's pages, the office share page) nothing changes.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { request, type Server } from "node:http";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FleetManager } from "../src/fleet-manager.js";
import { tokenEpoch } from "../src/web-session.js";
import { WEB_SESSION_COOKIE } from "../src/web-auth.js";
import { ROUTE_WORKER_CSP } from "../src/web-host-guard.js";
import { assetVersion } from "../src/web-asset-version.js";
import { SHARE_ASSETS } from "../src/office-share-page.js";
import { servePublicAsset } from "../src/auth-api.js";
import { createAssetUrl } from "../src/ui/shared/asset-url.js";
// @ts-expect-error — a JS module of the app, with no types
import * as route from "../src/ui/fleet-route.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); vi.restoreAllMocks(); route.resetRouterWarm?.(); });

type Got = { status: number; headers: Record<string, string | string[] | undefined>; body: Buffer };
function get(port: number, path: string, headers: Record<string, string> = {}): Promise<Got> {
  return new Promise((resolve, reject) => {
    const r = request({ host: "127.0.0.1", port, method: "GET", path, headers }, res => {
      const parts: Buffer[] = []; res.on("data", (c: Buffer) => parts.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(parts) }));
    });
    r.on("error", reject); r.end();
  });
}
async function listener() {
  const dir = mkdtempSync(join(tmpdir(), "agend-m3328-")); dirs.push(dir);
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
  return { port: (server.address() as { port: number }).port, cookie: { cookie: `${WEB_SESSION_COOKIE}=${admin}` }, stop: () => new Promise<void>(r => server.close(() => r())) };
}
const OLD = "0123456789ab";
const UI = join(__dirname, "..", "src", "ui");

describe("assetUrl", () => {
  it("puts /assets/<name> under the version of the URL its module was loaded from; a plain load changes nothing", () => {
    const v = createAssetUrl(`https://h/assets/v-${OLD}/asset-url.js`);
    expect(v("/assets/hub.css")).toBe(`/assets/v-${OLD}/hub.css`);
    expect(v("/assets/office-cozy.png")).toBe(`/assets/v-${OLD}/office-cozy.png`);
    for (const p of ["/ui/img/x.png", "/assets/a/b.css", `/assets/v-${OLD}/hub.css`, "/assets/hub.css?x=1", "hub.css"]) expect(v(p)).toBe(p);
    expect(createAssetUrl(`https://h/ui/js/v-${OLD}/x.js`)("/assets/hub.css")).toBe(`/assets/v-${OLD}/hub.css`);
    for (const u of ["https://h/assets/asset-url.js", "file:///repo/src/ui/shared/asset-url.js", "https://h/assets/v-123/asset-url.js", ""]) {
      expect(createAssetUrl(u)("/assets/hub.css")).toBe("/assets/hub.css");
    }
  });

  it("every stylesheet or picture a module names by an /assets path goes through assetUrl (the prompt for a stale tab excepted)", () => {
    // stale-tab.css: the prompt a tab OLDER than the server shows — under that tab's version it would be a 404.
    // panel-view.js and panel-fleet.js: a heal for a tab holding an OLDER app.css (`app.css?…`, fetched afresh on
    // purpose; under a version the shell's app.css is never older than its modules, so it does not fire there).
    const KEEP_PLAIN = new Set(["shared/stale-tab.js", "shared/panel-view.js", "panel-fleet.js"]);
    const files = (d: string, rel = ""): string[] => readdirSync(join(d, rel), { withFileTypes: true }).flatMap(e =>
      e.isDirectory() ? (e.name === "vendor" ? [] : files(d, rel ? `${rel}/${e.name}` : e.name)) : e.name.endsWith(".js") ? [rel ? `${rel}/${e.name}` : e.name] : []);
    const bare: string[] = [];
    for (const f of files(UI)) {
      if (KEEP_PLAIN.has(f)) continue;
      const src = readFileSync(join(UI, f), "utf8");
      for (const m of src.matchAll(/(assetUrl\()?["'`]?(\/assets\/[a-z0-9-]+\.(?:css|png|svg|webp|jpg))/g)) {
        const line = src.slice(src.lastIndexOf("\n", m.index) + 1, src.indexOf("\n", m.index));
        if (m[1] || /^\s*(\/\/|\*|\/\*)/.test(line)) continue;                         // wrapped, or a comment
        bare.push(`${f}: ${m[2]}`);
      }
    }
    expect(bare).toEqual([]);
  });

  it("asset-url.js is served wherever the modules importing it are: the app's /assets (the Hub's too) and the office share page", () => {
    const res = { writeHead: vi.fn(), end: vi.fn() };
    expect(servePublicAsset(res as never, "asset-url.js")).toBe(true);
    expect(SHARE_ASSETS["asset-url.js"]).toMatch(/javascript/);
  });
});

describe("served under the version", () => {
  it("panel CSS and office pictures: public immutable under <V>, the plain path unchanged; another <V> is a 404", async () => {
    const h = await listener();
    try {
      const V = assetVersion();
      for (const name of ["loading.css", "hub.css", "reply-previews.css", "chat-work-bar.css", "task-board.css", "runtime-install.css", "access-overview.css", "office-cozy.png", "office-school.png", "asset-url.js"]) {
        const plain = await get(h.port, `/assets/${name}`), v = await get(h.port, `/assets/v-${V}/${name}`);
        expect([name, plain.status, v.status]).toEqual([name, 200, 200]);
        expect(v.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
        expect(plain.headers["cache-control"]).toBe("no-store");
        if (name.endsWith(".png")) expect(v.body.equals(plain.body)).toBe(true);
        if (!name.endsWith(".js")) expect((await get(h.port, `/assets/v-${OLD}/${name}`)).status).toBe(404);
      }
    } finally { await h.stop(); }
  });
});

describe("the org chart's route worker", () => {
  it("under the version it keeps its own policy (WebAssembly only there, #2182), private immutable; another <V> is the stale answer", async () => {
    const h = await listener();
    try {
      const V = assetVersion();
      const v = await get(h.port, `/ui/js/v-${V}/fleet-route-worker.js`, h.cookie);
      expect([v.status, v.headers["content-security-policy"], v.headers["cache-control"]]).toEqual([200, ROUTE_WORKER_CSP, "private, max-age=31536000, immutable"]);
      expect(v.body.toString()).toContain('from "./fleet-route-scene.js"');                       // relative: resolved under the same <V>
      const stale = await get(h.port, `/ui/js/v-${OLD}/fleet-route-worker.js`, h.cookie);
      expect(stale.body.toString()).toMatch(/^throw new SyntaxError/);                              // an older page's worker fails: lanes stay
    } finally { await h.stop(); }
  });

  it("is started under the page's version (its relative imports are then the page's cached files); a plain load keeps the plain URL", () => {
    expect(route.workerUrlFor(`https://h/ui/js/v-${OLD}/fleet-route.js`)).toBe(`/ui/js/v-${OLD}/fleet-route-worker.js`);
    for (const u of ["https://h/ui/js/fleet-route.js", "file:///repo/src/ui/fleet-route.js", "https://h/ui/js/v-12/fleet-route.js"]) expect(route.workerUrlFor(u)).toBe(route.WORKER_URL);
  });

  it("the client starts the worker at its versioned URL", async () => {
    const made: string[] = [];
    class W { onmessage: unknown = null; onerror: unknown = null; constructor(u: string) { made.push(u); } postMessage() {} terminate() {} }
    const wasm = new ArrayBuffer(4);
    const c = route.createRouteClient({ Worker: W, fetch: async () => ({ ok: true, arrayBuffer: async () => wasm }), workerUrl: `/ui/js/v-${OLD}/fleet-route-worker.js`, timers: { set: () => 0, clear: () => {} } } as never);
    void c.route({ shapes: [], conns: [] } as never);
    await vi.waitFor(() => expect(made).toEqual([`/ui/js/v-${OLD}/fleet-route-worker.js`]));
    c.close();
  });

  it("warmRouter asks for the .wasm, libavoid's glue and the versioned worker at once; the client then starts with those bytes", async () => {
    const asked: string[] = [];
    const wasm = new ArrayBuffer(8);
    const pending: Array<() => void> = [];
    const fetchFake = (u: string) => { asked.push(u); return new Promise(r => pending.push(() => r({ ok: true, arrayBuffer: async () => (u.endsWith(".wasm") ? wasm : new ArrayBuffer(0)) }))); };
    const warmed = route.warmRouter(fetchFake as never, `https://h/ui/js/v-${OLD}/fleet-route.js`);
    await vi.waitFor(() => expect(asked.length).toBe(3));
    expect(new Set(asked)).toEqual(new Set([route.WASM_URL, route.LIBAVOID_JS, `/ui/js/v-${OLD}/fleet-route-worker.js`]));   // nothing waits for anything
    expect(route.warmRouter(fetchFake as never)).toBe(warmed);                                                      // once per page
    pending.forEach(f => f());
    await warmed;
    let sent: unknown = null;
    class W { onmessage: unknown = null; onerror: unknown = null; postMessage(m: { type: string; wasm?: ArrayBuffer }) { if (m.type === "init") sent = m.wasm; } terminate() {} }
    const later = vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(1) }));
    const c = route.createRouteClient({ Worker: W, fetch: later, timers: { set: () => 0, clear: () => {} } } as never);
    void c.route({ shapes: [], conns: [] } as never);
    await vi.waitFor(() => expect(sent).not.toBeNull());
    expect((sent as ArrayBuffer).byteLength).toBe(8);
    expect(later).not.toHaveBeenCalled();
    c.close();
  });

  it("a plain page warms only libavoid (a plain worker is no-store: fetching it twice would only cost)", async () => {
    const asked: string[] = [];
    await route.warmRouter((async (u: string) => { asked.push(u); return { ok: true, arrayBuffer: async () => new ArrayBuffer(1) }; }) as never, "https://h/ui/js/fleet-route.js");
    expect(asked.sort()).toEqual([route.LIBAVOID_JS, route.WASM_URL].sort());
  });
});
