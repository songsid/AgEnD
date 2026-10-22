/**
 * #2308: the app icon — the store (checked, decoded, made into the sizes, switched atomically, versioned, reset), the
 * icon and manifest routes (custom or bundled, cached by version), the pages' icon links, and who may change it: a
 * signed-in admin's session only — not a read-only session, a guest, the CLI's token or the public link; an upload is
 * a PNG of at most 5 MiB.
 *
 * Isolation: temp state dirs; requests through the real web routes with fake req/res (web-task-board's pattern).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { AppIconStore, APP_ICON_MAX_BYTES, appIconSet, convertInProcess, convertWithWorker, type AppIconConvert } from "../src/web-app-icon.js";
import { appManifest, handleWebIconRequest, isWebIconPath, useAppIconStore, withAppIconLinks } from "../src/web-icons.js";
import { decodePng, encodePng, resize } from "../src/web-png.js";
import { handleWebRequest } from "../src/web-api.js";
import { WebSessionStore, csrfTokenFor, tokenEpoch } from "../src/web-session.js";
import { bindGatewayRequest } from "../src/web-request-context.js";
import { isPublicWebRoute } from "../src/public-web-gateway.js";

const TOKEN = "c".repeat(48);
const dirs: string[] = [];
afterEach(() => { useAppIconStore(null); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const stateDir = () => { const d = mkdtempSync(join(tmpdir(), "agend-app-icon-")); dirs.push(d); return d; };

/** A square PNG: a red disc on transparent, `side` px. */
function sourcePng(side = 512, w = side, h = side): Buffer {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const inside = (x - w / 2) ** 2 + (y - h / 2) ** 2 < (Math.min(w, h) / 2.2) ** 2;
    data.set(inside ? [220, 30, 30, 255] : [0, 0, 0, 0], (y * w + x) * 4);
  }
  return encodePng({ width: w, height: h, data });
}

describe("the store", () => {
  it("makes the sizes from one PNG, under a version folder named by its sha, the pointer last", async () => {
    const dir = stateDir();
    const store = new AppIconStore(dir, () => new Date("2026-10-21T08:00:00Z"), convertInProcess);
    expect(store.current()).toBeNull();
    const src = sourcePng();
    const r = await store.set(src, "person:discord:1");
    const version = createHash("sha256").update(src).digest("hex").slice(0, 16);
    expect(r).toEqual({ ok: true, state: { version, updatedAt: "2026-10-21T08:00:00.000Z", by: "person:discord:1" } });
    expect(store.current()).toEqual(r.ok && r.state);
    expect(readdirSync(join(dir, "web-app-icon")).sort()).toEqual([version, "current.json"].sort());
    expect(readdirSync(join(dir, "web-app-icon", version)).sort()).toEqual(["apple-touch-icon.png", "favicon.ico", "icon-192.png", "icon-512.png", "source.png"]);
    const touch = decodePng(store.file("apple-touch-icon.png")!, { maxSide: 4096 });
    expect([touch.width, touch.height]).toEqual([180, 180]);
    // iOS shows transparency as black: the touch icon is flattened on white, the manifest's keep their alpha.
    expect([...touch.data.subarray(0, 4)]).toEqual([255, 255, 255, 255]);
    const i192 = decodePng(store.file("icon-192.png")!, { maxSide: 4096 });
    expect([i192.width, i192.data[3], i192.data[(96 * 192 + 96) * 4]]).toEqual([192, 0, 220]);
    expect(decodePng(store.file("icon-512.png")!, { maxSide: 4096 }).width).toBe(512);
    const ico = store.file("favicon.ico")!;
    expect([ico.readUInt16LE(4), ico[6], ico[22]]).toEqual([2, 32, 48]);
  });

  it("a second icon replaces the first (its folder removed); reset goes back to the bundled one and clears the files", async () => {
    const dir = stateDir();
    const store = new AppIconStore(dir, undefined, convertInProcess);
    const a = await store.set(sourcePng(512), "p"), b = await store.set(sourcePng(600), "p");
    if (!a.ok || !b.ok) throw new Error("set failed");
    expect(a.state.version).not.toBe(b.state.version);
    expect(store.current()?.version).toBe(b.state.version);
    expect(existsSync(join(dir, "web-app-icon", a.state.version))).toBe(false);
    expect(store.file("icon-192.png", a.state.version)).toBeNull();
    store.reset();
    expect(store.current()).toBeNull();
    expect(store.file("icon-192.png")).toBeNull();
    expect(readdirSync(join(dir, "web-app-icon"))).toEqual([]);
  });

  it("refuses with a reason and leaves the icon in force alone: not a PNG, too large, not square, too small, unreadable", async () => {
    const dir = stateDir();
    const store = new AppIconStore(dir, undefined, convertInProcess);
    const kept = await store.set(sourcePng(), "p");
    if (!kept.ok) throw new Error("set failed");
    const big = Buffer.alloc(APP_ICON_MAX_BYTES + 1);
    expect(await store.set(big, "p")).toEqual({ ok: false, status: 413, error: "app_icon_too_large", detail: "at most 5 MiB", detail_key: "max_size", detail_args: [5] });
    expect(await store.set(Buffer.from("\xff\xd8\xff\xe0JFIF", "latin1"), "p")).toMatchObject({ ok: false, status: 415, error: "app_icon_not_png" });
    expect(await store.set(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"), "p")).toMatchObject({ status: 415 });
    expect(await store.set(sourcePng(512, 600, 512), "p")).toEqual({ ok: false, status: 400, error: "app_icon_unreadable", detail: "not square (600×512)", detail_key: "not_square", detail_args: [600, 512] });
    expect(await store.set(sourcePng(256), "p")).toEqual({ ok: false, status: 400, error: "app_icon_unreadable", detail: "smaller than 512×512", detail_key: "too_small", detail_args: [512] });
    const broken = Buffer.from(sourcePng()); broken[40] ^= 0xff;
    expect(await store.set(broken, "p")).toMatchObject({ ok: false, status: 400, error: "app_icon_unreadable" });
    expect(store.current()?.version).toBe(kept.state.version);
    expect(readdirSync(join(dir, "web-app-icon")).sort()).toEqual([kept.state.version, "current.json"].sort());
  });

  it("an unreadable pointer is the bundled icon; a pointer changed on disk is read again", async () => {
    const dir = stateDir();
    const store = new AppIconStore(dir, undefined, convertInProcess);
    const r = await store.set(sourcePng(), "p");
    if (!r.ok) throw new Error("set failed");
    writeFileSync(join(dir, "web-app-icon", "current.json"), "{not json");
    expect(store.current()).toBeNull();
    writeFileSync(join(dir, "web-app-icon", "current.json"), JSON.stringify({ version: "../../etc/passwd", updatedAt: "x", by: "p" }));
    expect(store.current()).toBeNull();
    // A version is 16 hex characters, never a path: a file outside the icon folder is not reachable through it.
    mkdirSync(join(dir, "secret"), { recursive: true });
    writeFileSync(join(dir, "secret", "icon-192.png"), "outside");
    expect(store.file("icon-192.png", "../secret")).toBeNull();
  });
});

/** One request to the icon routes. */
function icon(path: string, method = "GET") {
  return new Promise<{ status: number; headers: Record<string, string>; body: Buffer }>((resolve) => {
    let status = 0, headers: Record<string, string> = {};
    const chunks: Buffer[] = [];
    const res = { writeHead: (c: number, h: Record<string, string> = {}) => { status = c; headers = h; }, end: (b?: Buffer) => { if (b) chunks.push(Buffer.from(b)); resolve({ status, headers, body: Buffer.concat(chunks) }); } };
    const handled = handleWebIconRequest({ method, url: path } as never, res as never, path.split("?")[0]!);
    if (!handled) resolve({ status: -1, headers: {}, body: Buffer.alloc(0) });
  });
}
const bundled = (file: string) => readFileSync(new URL(`../src/ui/icons/${file}`, import.meta.url));

describe("the icon and manifest routes", () => {
  it("bundled icons without a custom one; the version in force cached for good, anything else checked each time", async () => {
    useAppIconStore(new AppIconStore(stateDir(), undefined, convertInProcess));
    for (const [path, file, type] of [["/favicon.ico", "favicon.ico", "image/vnd.microsoft.icon"], ["/favicon.svg", "favicon.svg", "image/svg+xml"],
      ["/apple-touch-icon.png", "apple-touch-icon.png", "image/png"], ["/icon-192.png", "icon-192.png", "image/png"], ["/icon-512.png", "icon-512.png", "image/png"]] as const) {
      const r = await icon(path);
      expect([r.status, r.headers["Content-Type"], r.body.equals(bundled(file)), r.headers["Cache-Control"]], path).toEqual([200, type, true, "no-cache"]);
    }
    expect((await icon("/icon-192.png?v=default")).headers["Cache-Control"]).toBe("public, max-age=31536000, immutable");
    expect((await icon("/icon-192.png?v=0123456789abcdef")).headers["Cache-Control"]).toBe("no-cache");
    expect([decodePng(bundled("icon-512.png"), { maxSide: 4096 }).width, decodePng(bundled("icon-192.png"), { maxSide: 4096 }).width]).toEqual([512, 192]);
  });

  it("the custom icon once set (the SVG stays the bundled one); its version cached for good, an old one not", async () => {
    const store = new AppIconStore(stateDir(), undefined, convertInProcess);
    useAppIconStore(store);
    const r = await store.set(sourcePng(), "p");
    if (!r.ok) throw new Error("set failed");
    const v = r.state.version;
    for (const name of ["favicon.ico", "apple-touch-icon.png", "icon-192.png", "icon-512.png"] as const) {
      const got = await icon(`/${name}?v=${v}`);
      expect([got.status, got.body.equals(store.file(name)!), got.headers["Cache-Control"]], name).toEqual([200, true, "public, max-age=31536000, immutable"]);
    }
    expect((await icon("/favicon.svg")).body.equals(bundled("favicon.svg"))).toBe(true);
    expect((await icon("/icon-192.png?v=default")).headers["Cache-Control"]).toBe("no-cache");
    const head = await icon("/icon-512.png", "HEAD");
    expect([head.status, head.body.length, Number(head.headers["Content-Length"])]).toEqual([200, 0, store.file("icon-512.png")!.length]);
    expect((await icon("/icon-512.png", "POST")).status).toBe(405);
  });

  it("the manifest: the fixed name, standalone at /, the 192/512 icons of the version in force", async () => {
    const store = new AppIconStore(stateDir(), undefined, convertInProcess);
    useAppIconStore(store);
    const m = await icon("/manifest.webmanifest");
    expect([m.status, m.headers["Content-Type"]]).toEqual([200, "application/manifest+json"]);
    expect(JSON.parse(m.body.toString())).toEqual({ name: "AgEnD", short_name: "AgEnD", start_url: "/", scope: "/", display: "standalone", background_color: "#212121", theme_color: "#212121",
      icons: [{ src: "/icon-192.png?v=default", sizes: "192x192", type: "image/png" }, { src: "/icon-512.png?v=default", sizes: "512x512", type: "image/png" }] });
    const r = await store.set(sourcePng(), "p");
    if (!r.ok) throw new Error("set failed");
    expect(JSON.parse(appManifest()).icons.map((i: { src: string }) => i.src)).toEqual([`/icon-192.png?v=${r.state.version}`, `/icon-512.png?v=${r.state.version}`]);
  });

  it("no store yet: the bundled icons; a failing store never breaks a page or an icon", async () => {
    expect((await icon("/icon-192.png")).body.equals(bundled("icon-192.png"))).toBe(true);
    useAppIconStore({ current: () => { throw new Error("disk"); }, file: () => null });
    expect((await icon("/favicon.ico")).status).toBe(200);
    expect(withAppIconLinks("<!--app-icon-->x<!--/app-icon-->\n")).toContain("/favicon.ico?v=default");
  });

  it("the public link may read every icon route (and nothing of /ui/app-icon)", async () => {
    for (const p of ["/favicon.ico", "/favicon.svg", "/apple-touch-icon.png", "/icon-192.png", "/icon-512.png", "/manifest.webmanifest"]) {
      expect([isWebIconPath(p), isPublicWebRoute("GET", p), isPublicWebRoute("HEAD", p)], p).toEqual([true, true, true]);
    }
    for (const m of ["GET", "PUT", "DELETE"]) expect(isPublicWebRoute(m, "/ui/app-icon"), m).toBe(false);
  });
});

describe("the pages' icon links", () => {
  const page = (name: string) => readFileSync(new URL(`../src/ui/${name}`, import.meta.url), "utf8");

  it("app.html and signin.html: versioned bundled links with the SVG, the manifest and the theme colours", async () => {
    useAppIconStore(new AppIconStore(stateDir(), undefined, convertInProcess));
    for (const name of ["app.html", "signin.html"]) {
      const html = withAppIconLinks(page(name));
      expect(html, name).not.toContain("<!--app-icon-->");
      expect(html).toContain('<link rel="icon" href="/favicon.ico?v=default" sizes="16x16 32x32 64x64">');
      expect(html).toContain('<link rel="icon" href="/favicon.svg?v=default" type="image/svg+xml" sizes="any">');
      expect(html).toContain('<link rel="apple-touch-icon" href="/apple-touch-icon.png?v=default" sizes="180x180">');
      expect(html).toContain('<link rel="manifest" href="/manifest.webmanifest?v=default">');
      expect(html).toContain('<meta name="theme-color" content="#212121" media="(prefers-color-scheme: dark)">');
      expect(html.match(/rel="icon"/g)).toHaveLength(2);
    }
  });

  it("with a custom icon: its version on every link, and no SVG (a browser would prefer it over the new icon)", async () => {
    const store = new AppIconStore(stateDir(), undefined, convertInProcess);
    useAppIconStore(store);
    const r = await store.set(sourcePng(), "p");
    if (!r.ok) throw new Error("set failed");
    const html = withAppIconLinks(page("app.html"));
    expect(html).toContain(`<link rel="icon" href="/favicon.ico?v=${r.state.version}" sizes="32x32 48x48">`);
    expect(html).toContain(`<link rel="apple-touch-icon" href="/apple-touch-icon.png?v=${r.state.version}" sizes="180x180">`);
    expect(html).toContain(`<link rel="manifest" href="/manifest.webmanifest?v=${r.state.version}">`);
    expect(html).not.toContain("favicon.svg");
  });
});

/** One request through the real web routes as a session of `tier` (local, or the public link's gateway), or the token. */
function viaWeb(method: string, path: string, opts: { tier?: "admin" | "read" | "guest"; gateway?: boolean; token?: boolean; csrf?: boolean; body?: Buffer; store?: AppIconStore; noEnd?: boolean; sessions?: WebSessionStore; signedIn?: (sessionId: string) => void } = {}) {
  const sessions = opts.sessions ?? new WebSessionStore(), exposureId = "a".repeat(32), pub = "https://sample.trycloudflare.com", local = "http://127.0.0.1:19280";
  const origin = opts.gateway ? pub : local;
  const headers: Record<string, string> = { host: new URL(origin).host, origin, "sec-fetch-site": "same-origin", "content-type": "image/png" };
  if (opts.token) headers["x-agend-token"] = TOKEN;                   // the CLI's header token (valid, but not a person)
  else {
    const s = sessions.create({ tier: opts.tier ?? "admin", surface: opts.gateway ? "gateway" : "local", exposureId: opts.gateway ? exposureId : undefined, label: "t", tokenEpoch: tokenEpoch(TOKEN),
      owner: { adapterId: "discord", userId: "1", name: "Ann" } } as never);
    headers.cookie = `${opts.gateway ? "__Host-" : ""}agend_session=${s.sessionId}`;
    opts.signedIn?.(s.sessionId);
    if (opts.csrf !== false) headers["x-agend-csrf"] = csrfTokenFor(s.sessionId);
  }
  const store = opts.store ?? new AppIconStore(stateDir(), undefined, convertInProcess);
  return new Promise<{ status: number; body: any; store: AppIconStore }>((resolve) => {
    const req = Object.assign(new EventEmitter(), { method, url: path, headers, destroy: vi.fn() });
    if (opts.gateway) bindGatewayRequest(req as never, { surface: "gateway", exposureId, expectedOrigin: pub, isCurrent: () => true });
    let status = 0;
    const res = Object.assign(new EventEmitter(), { headersSent: false, destroyed: false, setHeader() {}, writeHead: (c: number) => { status = c; },
      end: (t = "") => resolve({ status, body: t ? JSON.parse(String(t)) : null, store }) });
    handleWebRequest(req as never, res as never, new URL(path, origin), { webToken: TOKEN, webSessions: sessions, appIcon: store, fleetConfig: { defaults: {}, instances: {} },
      logger: { debug() {}, info() {}, warn() {}, error() {} } } as never);
    setImmediate(() => { if (opts.body) req.emit("data", opts.body); if (!opts.noEnd) req.emit("end"); });
  });
}

describe("who may change it (/ui/app-icon)", () => {
  it("an admin's session: PUT a PNG sets it, GET says so, DELETE restores the default", async () => {
    const store = new AppIconStore(stateDir());                            // through the worker thread, end to end
    const put = await viaWeb("PUT", "/ui/app-icon", { body: sourcePng(), store });
    expect(put.status).toBe(200);
    expect(put.body).toMatchObject({ custom: true, version: store.current()!.version });
    expect(store.current()!.by).toBe("person:discord:1");
    expect((await viaWeb("GET", "/ui/app-icon", { store })).body).toMatchObject({ custom: true, version: store.current()!.version });
    const del = await viaWeb("DELETE", "/ui/app-icon", { store });
    expect([del.status, del.body]).toEqual([200, { custom: false, version: "default", updatedAt: null }]);
    expect(store.current()).toBeNull();
  });

  it("a read-only session reads it and changes nothing; a guest, the token and the public link get nothing", async () => {
    const store = new AppIconStore(stateDir(), undefined, convertInProcess);
    await store.set(sourcePng(), "p");
    const before = store.current();
    expect((await viaWeb("GET", "/ui/app-icon", { tier: "read", store })).status).toBe(200);
    for (const [label, opts, status, error] of [
      ["read PUT", { tier: "read" as const, body: sourcePng(600) }, 403, "app_icon_admin_only"],
      ["read DELETE", { tier: "read" as const }, 403, "app_icon_admin_only"],
      ["guest GET", { tier: "guest" as const }, 403, "app_icon_needs_a_signed_in_person"],
      ["guest PUT", { tier: "guest" as const, body: sourcePng(600) }, 403, "app_icon_needs_a_signed_in_person"],
      ["token PUT", { token: true, body: sourcePng(600) }, 403, "app_icon_needs_a_signed_in_person"],
      ["public link PUT", { gateway: true, body: sourcePng(600) }, 403, "app_icon_not_over_public_link"],
      ["public link DELETE", { gateway: true }, 403, "app_icon_not_over_public_link"],
      ["public link GET", { gateway: true }, 404, "app_icon_not_over_public_link"],
    ] as const) {
      const method = label.split(" ").pop()!;
      const r = await viaWeb(method, "/ui/app-icon", { ...opts, store });
      expect([r.status, r.body?.error], label).toEqual([status, error]);
    }
    expect(store.current()).toEqual(before);
  });

  it("a write without the CSRF header is refused", async () => {
    const store = new AppIconStore(stateDir(), undefined, convertInProcess);
    const r = await viaWeb("PUT", "/ui/app-icon", { csrf: false, body: sourcePng(), store });
    expect(r.status).toBe(401);
    expect(store.current()).toBeNull();
  });

  it("an upload: over 5 MiB is 413 (not read whole), not a PNG 415, unreadable 400 — the icon in force kept; other methods 405", async () => {
    const store = new AppIconStore(stateDir(), undefined, convertInProcess);
    await store.set(sourcePng(), "p");
    const before = store.current();
    // Refused as the body passes 5 MiB — before it has all arrived (no "end" is ever sent here).
    expect([(await viaWeb("PUT", "/ui/app-icon", { body: Buffer.alloc(APP_ICON_MAX_BYTES + 1, 1), store, noEnd: true })).status]).toEqual([413]);
    const jpg = await viaWeb("PUT", "/ui/app-icon", { body: Buffer.from("\xff\xd8\xff\xe0JFIF", "latin1"), store });
    expect([jpg.status, jpg.body.error]).toEqual([415, "app_icon_not_png"]);
    const broken = Buffer.from(sourcePng()); broken[40] ^= 0xff;
    const bad = await viaWeb("PUT", "/ui/app-icon", { body: broken, store });
    expect([bad.status, bad.body.error, bad.body.detail]).toEqual([400, "app_icon_unreadable", "bad chunk CRC"]);
    expect((await viaWeb("POST", "/ui/app-icon", { store })).status).toBe(405);
    expect(store.current()).toEqual(before);
  });
});

/** A conversion held until the test lets it finish (what happens while it runs). */
function held(): { convert: AppIconConvert; started: Promise<void>; release(): void } {
  let release!: () => void, began!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const started = new Promise<void>((r) => { began = r; });
  return { started, release: () => release(), convert: async (bytes) => { began(); await gate; return convertInProcess(bytes); } };
}

describe("#2308 review: the conversion is off the fleet loop, one at a time, checked again before it is used", () => {
  it("in a worker thread: the event loop keeps turning while a 2048 px source is made into its sizes", async () => {
    const store = new AppIconStore(stateDir());                            // the fleet's default: a worker thread
    const src = sourcePng(2048);
    let ticks = 0;
    const timer = setInterval(() => { ticks++; }, 5);
    const t0 = performance.now();
    const r = await store.prepare(src);
    const took = performance.now() - t0;
    clearInterval(timer);
    expect(r.ok).toBe(true);
    // Every 5 ms of the conversion the loop ran a tick (a blocked loop runs none until it ends): most of them, at least.
    expect(ticks, `${ticks} ticks in ${Math.round(took)} ms`).toBeGreaterThanOrEqual(Math.floor(took / 5 / 3));
    expect(took).toBeGreaterThan(30);
    // The same work on this thread runs no tick at all until it is done (the control).
    let blocked = 0;
    const t2 = setInterval(() => { blocked++; }, 5);
    const inProcess = new AppIconStore(stateDir(), undefined, convertInProcess);
    const p = inProcess.prepare(src);
    const before = blocked;
    await p;
    clearInterval(t2);
    expect(before).toBe(0);
  }, 30_000);

  it("a second upload while one is being made is told to wait (409); the first is unaffected", async () => {
    const h = held();
    const store = new AppIconStore(stateDir(), undefined, h.convert);
    const first = store.prepare(sourcePng());
    await h.started;
    expect(await store.prepare(sourcePng(600))).toEqual({ ok: false, status: 409, error: "app_icon_busy", detail: "another icon is being made", detail_key: "busy" });
    h.release();
    expect((await first).ok).toBe(true);
    expect((await store.prepare(sourcePng(600))).ok).toBe(true);           // free again
  });

  it("over the route: a session revoked while the icon is made switches nothing", async () => {
    const h = held();
    const store = new AppIconStore(stateDir(), undefined, h.convert);
    const sessions = new WebSessionStore();
    let id = "";
    const r = viaWeb("PUT", "/ui/app-icon", { body: sourcePng(), store, sessions, signedIn: (s) => { id = s; } });
    await h.started;
    sessions.revokeById(id);
    h.release();
    expect((await r).status).toBe(401);
    expect(store.current()).toBeNull();
  });

  it("over the route: the fleet stopping while the icon is made switches nothing (503)", async () => {
    const h = held();
    const store = new AppIconStore(stateDir(), undefined, h.convert);
    const r = viaWeb("PUT", "/ui/app-icon", { body: sourcePng(), store });
    await h.started;
    store.close();
    h.release();
    expect([(await r).status, (await r).body.error]).toEqual([503, "app_icon_unavailable"]);
    expect(store.current()).toBeNull();
  });
});

describe("#2308 review: resetting fails out loud", () => {
  it("no pointer is the default already: ok; a pointer that cannot be removed: 500, and the icon in force keeps its files", async () => {
    const dir = stateDir();
    const store = new AppIconStore(dir, undefined, convertInProcess);
    expect(store.reset()).toEqual({ ok: true });
    const r = await store.set(sourcePng(), "p");
    if (!r.ok) throw new Error("set failed");
    if (process.getuid?.() === 0) return;                                  // root ignores the directory's mode
    chmodSync(join(dir, "web-app-icon"), 0o500);
    try {
      expect(store.reset()).toEqual({ ok: false, status: 500, error: "app_icon_not_reset", detail: "EACCES" });
      expect(store.current()?.version).toBe(r.state.version);
      expect(store.file("icon-192.png")).not.toBeNull();
      const del = await viaWeb("DELETE", "/ui/app-icon", { store });
      expect([del.status, del.body.error]).toEqual([500, "app_icon_not_reset"]);
    } finally {
      chmodSync(join(dir, "web-app-icon"), 0o700);
    }
    expect(store.reset()).toEqual({ ok: true });
    expect(store.current()).toBeNull();
  });
});

describe("#2319 review R1: a reset is the latest wish; the claim lasts until the worker has gone", () => {
  it("an upload being made when the icon is reset is not used afterwards; one not overtaken is (control)", async () => {
    const h = held();
    const store = new AppIconStore(stateDir(), undefined, h.convert);
    const late = store.prepare(sourcePng());
    await h.started;
    expect(store.reset()).toEqual({ ok: true });
    h.release();
    const p = await late;
    if (!p.ok) throw new Error("prepare failed");
    expect(store.commit(p.prepared, "p")).toEqual({ ok: false, status: 409, error: "app_icon_superseded", detail: "the icon was reset meanwhile", detail_key: "reset_meanwhile" });
    expect(store.current()).toBeNull();
    const q = await store.prepare(sourcePng(600));
    if (!q.ok) throw new Error("prepare failed");
    expect(store.commit(q.prepared, "p").ok).toBe(true);
  });

  it("over the route: Restore default while an upload is being made wins; the upload answers 409", async () => {
    const h = held();
    const store = new AppIconStore(stateDir(), undefined, h.convert);
    const put = viaWeb("PUT", "/ui/app-icon", { body: sourcePng(), store });
    await h.started;
    const del = await viaWeb("DELETE", "/ui/app-icon", { store });
    expect(del.status).toBe(200);
    h.release();
    expect([(await put).status, (await put).body.error]).toEqual([409, "app_icon_superseded"]);
    expect(store.current()).toBeNull();
  });

  /** A worker that answers at once but exits only when the test says (its terminate() resolves later). */
  function slowExit(opts: { answer: boolean }) {
    const exits: Array<() => void> = [];
    let alive = 0;
    const spawn = (source: ArrayBuffer) => {
      alive++;
      const listeners: Record<string, Array<(...a: any[]) => void>> = { message: [], error: [], exit: [] };
      const w = {
        on: (e: string, l: (...a: any[]) => void) => { listeners[e]!.push(l); return w; },
        terminate: () => new Promise<number>((resolve) => { exits.push(() => { alive--; for (const l of listeners.exit!) l(1); resolve(1); }); }),
      };
      if (opts.answer) setImmediate(() => { for (const l of listeners.message!) l({ ok: true, files: appIconSet(new Uint8Array(source)) }); });
      return w;
    };
    return { spawn, exitAll: () => { for (const e of exits.splice(0)) e(); }, alive: () => alive };
  }

  it("finished: still busy until the worker has exited; then free (the claim follows the thread, not the answer)", async () => {
    const w = slowExit({ answer: true });
    const store = new AppIconStore(stateDir(), undefined, convertWithWorker(w.spawn, 60_000));
    let settled = false;
    const first = store.prepare(sourcePng()).then((r) => { settled = true; return r; });
    await new Promise((r) => setTimeout(r, 50));
    expect(settled).toBe(false);                                           // answered, but its thread is still there
    expect(await store.prepare(sourcePng(600))).toMatchObject({ ok: false, status: 409, error: "app_icon_busy" });
    expect(w.alive()).toBe(1);
    w.exitAll();
    expect((await first).ok).toBe(true);
    expect(w.alive()).toBe(0);
    const next = store.prepare(sourcePng(600));
    await new Promise((r) => setTimeout(r, 20));
    w.exitAll();
    expect((await next).ok).toBe(true);
  });

  it("timed out: the caller is told only once the worker has exited; no second worker meanwhile", async () => {
    const w = slowExit({ answer: false });
    const store = new AppIconStore(stateDir(), undefined, convertWithWorker(w.spawn, 20));
    let settled = false;
    const first = store.prepare(sourcePng()).then((r) => { settled = true; return r; });
    await new Promise((r) => setTimeout(r, 80));                          // past the deadline: terminate() asked
    expect(settled).toBe(false);
    expect(await store.prepare(sourcePng(600))).toMatchObject({ ok: false, status: 409, error: "app_icon_busy" });
    expect(w.alive()).toBe(1);
    w.exitAll();
    expect(await first).toEqual({ ok: false, status: 400, error: "app_icon_unreadable", detail: "it took too long to read", detail_key: "too_slow" });
  });
});
