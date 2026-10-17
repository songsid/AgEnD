/**
 * #1629 B1 (first design §5–§7, r2 (a)(b)(d)): agents' themes on the page.
 * - Server: GET /ui/themes (themes + locks) and /ui/img/theme/<instance>/<id> for every page, the public link included
 *   (it views themes); a person's reset and lock from an admin session only — never the CLI token, never the public
 *   link (absent from its manifest, refused by the handler); the page's reads are passive; the status frame carries
 *   the theme's picture and ring colour beside the theme-free face, below a person's upload.
 * - Page: a theme is re-checked and applied to its own chat root only (custom properties, fixed tokens); not shown
 *   with the viewer's switch off or in safe mode; the sidebar's face and ring follow; Lock/Reset are not offered over
 *   the public link.
 */
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page, settle, type AppPage } from "./helpers/app-harness.js";

vi.mock("node:child_process", async importOriginal => {
  const real = await importOriginal<typeof import("node:child_process")>();
  const refuse = (name: string) => () => { throw new Error(`themes ui: no child process may start (${name})`); };
  return { ...real, spawn: refuse("spawn"), spawnSync: refuse("spawnSync"), exec: refuse("exec"), execSync: refuse("execSync"),
    execFile: refuse("execFile"), execFileSync: refuse("execFileSync"), fork: refuse("fork") };
});

const { FleetManager } = await import("../src/fleet-manager.js");
const { csrfTokenFor, tokenEpoch } = await import("../src/web-session.js");
const { isPublicWebRoute } = await import("../src/public-web-gateway.js");
const { isPassiveWebRead } = await import("../src/web-auth.js");
const { handleWebRequest } = await import("../src/web-api.js");
const { bindGatewayRequest } = await import("../src/web-request-context.js");

const dirs: string[] = [];
let pg: AppPage | null = null;
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); if (pg) { pg.restore(); pg = null; } for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...be32(13), ...Buffer.from("IHDR"), ...be32(4), ...be32(4), 8, 6, 0, 0, 0, 0, 0, 0, 0,
  ...be32(1), ...Buffer.from("IDAT"), 7, 0, 0, 0, 0, ...be32(0), ...Buffer.from("IEND"), 0, 0, 0, 0]);

interface Res { status: number; headers: Record<string, string | string[] | undefined>; body: string }
function raw(port: number, method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<Res> {
  return new Promise((resolve, reject) => {
    const r = request({ host: "127.0.0.1", port, method, path, headers }, res => {
      const chunks: Buffer[] = []; res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    r.on("error", reject); if (body !== undefined) r.write(body); r.end();
  });
}
async function fleet() {
  const dir = mkdtempSync(join(tmpdir(), "agend-themes-ui-")); dirs.push(dir);
  const fm = new FleetManager(dir) as any;
  const quiet = () => {};
  fm.logger = { info: quiet, warn: quiet, error: quiet, debug: quiet, trace: quiet, fatal: quiet, child: () => fm.logger };
  vi.spyOn(fm, "notifyFleetError").mockImplementation(() => true);
  fm.fleetConfig = { instances: { alpha: { working_directory: "/tmp" }, beta: { working_directory: "/tmp" } }, defaults: {} };
  fm.initializeWebAuthTokens(); fm.startHealthServer(0);
  await vi.waitFor(() => expect(fm.getDashboardAccess().ready).toBe(true));
  const port = ((fm.healthServer as Server).address() as { port: number }).port, origin = `http://127.0.0.1:${port}`;
  const session = (tier: "admin" | "read" = "admin") => {
    const { sessionId } = fm.webSessions.create({ tier, surface: "local", label: "t", tokenEpoch: tokenEpoch(fm.webToken) });
    const cookie = `agend_session=${sessionId}`;
    return { id: sessionId, read: { cookie }, write: { cookie, origin, "x-agend-csrf": csrfTokenFor(sessionId), "content-type": "application/json" } };
  };
  const stop = () => new Promise<void>(r => (fm.healthServer as Server).close(() => r()));
  return { fm, dir, port, session, stop };
}

describe("the theme routes", () => {
  it("GET /ui/themes: the themes and locks, for a signed-in page; anonymous 401", async () => {
    const f = await fleet();
    try {
      f.fm.themeStore.setTheme("alpha", { v: 1, font: "mono" }, "agent");
      f.fm.themeStore.setLocked("beta", true);
      expect((await raw(f.port, "GET", "/ui/themes")).status).toBe(401);
      const r = JSON.parse((await raw(f.port, "GET", "/ui/themes", f.session("read").read)).body);
      expect([r.themes, r.locked, typeof r.rev]).toEqual([{ alpha: { v: 1, font: "mono" } }, ["beta"], "number"]);
    } finally { await f.stop(); }
  }, 30_000);
  it("a theme picture: same-origin, typed, nosniff, sandboxed; an unknown id or instance: 404", async () => {
    const f = await fleet();
    try {
      const w = f.fm.themeStore.addAsset("alpha", "avatar", PNG);
      const s = f.session("read").read;
      const ok = await raw(f.port, "GET", `/ui/img/theme/alpha/${w.id}`, s);
      expect([ok.status, ok.headers["content-type"], ok.headers["x-content-type-options"], ok.headers["content-security-policy"]]).toEqual([200, "image/png", "nosniff", "default-src 'none'; sandbox"]);
      for (const p of [`/ui/img/theme/beta/${w.id}`, `/ui/img/theme/alpha/${"f".repeat(32)}`, "/ui/img/theme/alpha/../x"]) expect((await raw(f.port, "GET", p, s)).status, p).toBe(404);
    } finally { await f.stop(); }
  }, 30_000);
  it("reset and lock: an admin session only — read session 403, CLI token 403, anonymous 401; unknown instance 404", async () => {
    const f = await fleet();
    try {
      const post = (path: string, headers: Record<string, string>, body: unknown = {}) => raw(f.port, "POST", path, headers, JSON.stringify(body));
      expect((await post("/ui/themes/alpha/lock", { origin: `http://127.0.0.1:${f.port}`, "content-type": "application/json" }, { locked: true })).status).toBe(401);
      expect((await post("/ui/themes/alpha/lock", f.session("read").write, { locked: true })).status).toBe(403);
      const token = { "x-agend-token": f.fm.getDashboardAccess().token, "content-type": "application/json" };
      const t = await post("/ui/themes/alpha/lock", token, { locked: true });
      expect([t.status, JSON.parse(t.body).error]).toEqual([403, "theme_needs_an_admin_session"]);
      const admin = f.session("admin").write;
      expect((await post("/ui/themes/ghost/lock", admin, { locked: true })).status).toBe(404);
      expect((await post("/ui/themes/alpha/lock", admin, { locked: "yes" })).status).toBe(400);
      expect(JSON.parse((await post("/ui/themes/alpha/lock", admin, { locked: true })).body)).toMatchObject({ ok: true, locked: true });
      expect(f.fm.webAppearance.setTheme("alpha", { set: { font: "mono" } })).toMatchObject({ error: "locked" });
      f.fm.themeStore.setLocked("alpha", false);
      f.fm.webAppearance.setTheme("alpha", { set: { font: "mono" } });
      f.fm.themeStore.setLocked("alpha", true);
      expect((await post("/ui/themes/alpha/reset", admin)).status).toBe(200);
      expect([f.fm.themeStore.get("alpha").theme, f.fm.themeStore.get("alpha").locked]).toEqual([{ v: 1 }, true]);
    } finally { await f.stop(); }
  }, 30_000);
  it("reset/lock ask again once the body is in: a session revoked while it was on its way changes nothing (#1888 review)", async () => {
    const f = await fleet();
    try {
      const s = f.session("admin");
      const body = JSON.stringify({ locked: true });
      const status = await new Promise<number>((resolve, reject) => {
        const r = request({ host: "127.0.0.1", port: f.port, method: "POST", path: "/ui/themes/alpha/lock", headers: { ...s.write, "content-length": String(Buffer.byteLength(body)) } }, res => { res.resume(); resolve(res.statusCode ?? 0); });
        r.on("error", reject);
        r.flushHeaders();
        setTimeout(() => { f.fm.webSessions.revokeById(s.id); r.end(body); }, 150);
      });
      expect([status, f.fm.themeStore.get("alpha").locked]).toEqual([401, false]);
    } finally { await f.stop(); }
  }, 30_000);
  it("the public link: reads on its manifest, reset and lock absent — and refused by the handler on its own", async () => {
    expect([isPublicWebRoute("GET", "/ui/themes"), isPublicWebRoute("GET", `/ui/img/theme/a/${"a".repeat(32)}`)]).toEqual([true, true]);
    for (const p of ["/ui/themes/a/reset", "/ui/themes/a/lock"]) expect(isPublicWebRoute("POST", p), p).toBe(false);
    const f = await fleet();
    try {
      const { sessionId } = f.fm.webSessions.create({ tier: "admin", surface: "gateway", exposureId: "e".repeat(32), label: "t", tokenEpoch: tokenEpoch(f.fm.webToken) });
      const status = await new Promise<number>(resolve => {
        let code = 0;
        const res: any = { headersSent: false, setHeader() {}, writeHead(c: number) { code = c; res.headersSent = true; return res; }, end() { resolve(code); } };
        const req = Object.assign(new EventEmitter(), { method: "POST", url: "/ui/themes/alpha/reset", headers: { host: "x.trycloudflare.com", cookie: `__Host-agend_session=${sessionId}`, origin: "https://x.trycloudflare.com", "x-agend-csrf": csrfTokenFor(sessionId), "content-type": "application/json" }, destroy() {}, resume() {} });
        bindGatewayRequest(req, { surface: "gateway", exposureId: "e".repeat(32), expectedOrigin: "https://x.trycloudflare.com", isCurrent: () => true });
        expect(handleWebRequest(req as never, res, new URL("https://x.trycloudflare.com/ui/themes/alpha/reset"), f.fm)).toBe(true);
      });
      expect(status).toBe(403);
    } finally { await f.stop(); }
  }, 30_000);
  it("the page's theme reads are passive (they never slide a session's idle expiry)", () => {
    expect([isPassiveWebRead("GET", "/ui/themes"), isPassiveWebRead("GET", `/ui/img/theme/a/${"a".repeat(32)}`), isPassiveWebRead("POST", "/ui/themes/a/reset")]).toEqual([true, true, false]);
  });
});

describe("the status frame: a theme's picture and ring colour, beside the theme-free face", () => {
  it("theme_avatar / theme_accent when the theme names them; none while a person's upload stands", async () => {
    const f = await fleet();
    try {
      vi.spyOn(f.fm, "getInstanceStatus").mockReturnValue("running");
      const w = f.fm.themeStore.addAsset("alpha", "avatar", PNG);
      f.fm.themeStore.setTheme("alpha", { v: 1, avatar: w.id, accent: "#8b5cf6" }, "agent");
      const frame = () => Object.fromEntries(f.fm.getUiStatus().instances.map((i: any) => [i.name, i]));
      expect(frame().alpha).toMatchObject({ theme_avatar: { kind: "image", src: `/ui/img/theme/alpha/${w.id}` }, theme_accent: "#8b5cf6" });
      expect(frame().beta.theme_avatar).toBeUndefined();
      const Database = (await import("better-sqlite3")).default;
      mkdirSync(join(f.dir, "avatars"), { recursive: true });
      writeFileSync(join(f.dir, "avatars", "alpha.png"), PNG);
      const db = new Database(join(f.dir, "profiles.db"));
      db.exec("CREATE TABLE IF NOT EXISTS instance_profile (instance_name TEXT PRIMARY KEY, display_name TEXT, avatar_path TEXT, role TEXT, description TEXT, updated_at INTEGER);");
      db.prepare("INSERT INTO instance_profile (instance_name, avatar_path, updated_at) VALUES ('alpha', 'alpha.png', 0)").run();
      db.close();
      expect([frame().alpha.theme_avatar, frame().alpha.theme_accent, frame().alpha.avatar.src]).toEqual([undefined, undefined, expect.stringMatching(/^\/ui\/img\/avatar\/alpha/)]);
    } finally { await f.stop(); }
  }, 30_000);
});

describe("the page", () => {
  async function load(opts: { url?: string; publicLink?: boolean; fxShow?: boolean } = {}) {
    vi.resetModules();
    pg = page({ url: opts.url ?? "http://127.0.0.1:19280/ui/chat/alpha", storage: opts.fxShow === false ? { agend_fx_show: "off" } : {} });
    if (opts.publicLink) pg.document.body.dataset.publicLink = "1";
    await import("/ui/js/chat-strings.js");                                       // as panel-chat and panel-details do
    const themes = await import("/assets/app-themes.js");
    const nav = await import("/assets/instance-nav.js");
    return { themes, nav };
  }
  const T = { v: 1, accent: "#8b5cf6", colors: { dark: { bg: "#101010", text: "#f0f0f0" }, light: { bg: "#fafafa" } }, bubble: { radius: 6, border: "thin" }, font: "mono",
    background: { image: "a".repeat(32), fit: "cover", opacity: 0.4 }, workingLabel: "Thinking" };
  const prop = (el: any, k: string) => el.style[k] ?? "";                 // mini-dom's style: setProperty writes the key
  it("a theme is applied to its chat root only: custom properties by mode, fixed tokens; cleared to nothing", async () => {
    const { themes } = await load();
    themes.themesStore.set({ themes: { alpha: T }, shown: true });
    const el = pg!.document.createElement("div");
    themes.applyTheme(el, themes.themeFor("alpha"), "dark");
    expect([prop(el, "--bg"), prop(el, "--text"), prop(el, "--accent"), prop(el, "--bubble-radius")])
      .toEqual(["#101010", "#f0f0f0", "#8b5cf6", "6px"]);
    expect(["th", "th-font-mono", "th-bubble-thin"].every(c => el.classList.contains(c))).toBe(true);
    themes.applyTheme(el, themes.themeFor("alpha"), "light");
    expect([prop(el, "--bg"), prop(el, "--text")]).toEqual(["#fafafa", ""]);
    themes.applyTheme(el, null, "light");
    expect([prop(el, "--bg"), prop(el, "--accent"), el.classList.contains("th")]).toEqual(["", "", false]);
    expect(el.getAttribute("style") ?? "", "CSSOM only — never written as an attribute by this code").not.toContain("url(");
  });
  it("values are checked again: anything not canonical is dropped, never passed on", async () => {
    const { themes } = await load();
    themes.themesStore.set({ themes: { alpha: { v: 1, accent: "red; background:url(x)", colors: { dark: { bg: "var(--x)", text: "#ffffff" } }, font: "comic", bubble: { radius: 99 },
      background: { image: "https://evil/x.png", fit: "cover", opacity: 1 } } }, shown: true });
    expect(themes.themeFor("alpha")).toEqual({ colors: { light: {}, dark: { text: "#ffffff" } }, bubble: {} });
  });
  it("the label, colours and opacity are checked as the host checks them (#1888 review)", async () => {
    const { themes } = await load();
    const check = (t: Record<string, unknown>) => { themes.themesStore.set({ themes: { alpha: { v: 1, ...t } }, shown: true }); return themes.themeFor("alpha"); };
    expect(check({ accent: "#ffffff; x" }).accent).toBeUndefined();
    expect(check({ accent: "#FFFFFF" }).accent).toBeUndefined();                 // the host sends lowercase only
    const bg = (opacity: number) => check({ background: { image: "a".repeat(32), fit: "cover", opacity } }).background;
    expect([bg(0.04), bg(0.05), bg(1), bg(1.01)]).toEqual([undefined, { image: "a".repeat(32), fit: "cover", opacity: 0.05 }, { image: "a".repeat(32), fit: "cover", opacity: 1 }, undefined]);
    const label = (s: string) => check({ workingLabel: s }).workingLabel;
    expect([label("x".repeat(24)), label("x".repeat(25)), label("👨‍👩‍👧".repeat(24)), label("Think\u202eing"), label("\u200d"), label(" pad"), label("a\nb")])
      .toEqual(["x".repeat(24), undefined, "👨‍👩‍👧".repeat(24), undefined, undefined, undefined, undefined]);
  });
  it("another device's fx.show is followed at once; the switch is cached as \"off\" only (#1888 review)", async () => {
    vi.resetModules();
    pg = page({ url: "http://127.0.0.1:19280/ui/chat/alpha", storage: { agend_prefs_synced: "1" } });
    pg.document.documentElement.setAttribute("data-prefs", JSON.stringify({ rev: 1, values: {} }));
    let host: Record<string, unknown> = {}, rev = 1;
    vi.stubGlobal("fetch", async (url: string, init: { method?: string; body?: string } = {}) => {
      if (url === "/ui/prefs" && (init.method ?? "GET") === "POST") { const set = JSON.parse(init.body!).set; host = { ...host, ...set }; for (const k of Object.keys(host)) if (host[k] === null) delete host[k]; }
      return { ok: true, status: 200, json: async () => (url === "/ui/prefs" ? { rev: ++rev, values: host } : { rev: 0, themes: {}, locked: [] }) };
    });
    const themes = await import("/assets/app-themes.js");
    const prefs = await import("/assets/app-prefs.js");
    themes.startThemes();
    expect(themes.themesStore.get().shown).toBe(true);
    host = { "fx.show": false };
    await prefs.refresh(); await settle(2);
    expect([themes.themesStore.get().shown, pg.storage.get("agend_fx_show")]).toEqual([false, "off"]);
    host = {};
    await prefs.refresh(); await settle(2);
    expect([themes.themesStore.get().shown, pg.storage.get("agend_fx_show") ?? null]).toEqual([true, null]);
    themes.setThemesShown(false);
    expect(pg.storage.get("agend_fx_show")).toBe("off");
    themes.setThemesShown(true);
    expect(pg.storage.get("agend_fx_show") ?? null).toBeNull();
  });
  it("the themes are read when themes_rev moves — once per revision (#1888 review)", async () => {
    vi.resetModules();
    pg = page({ url: "http://127.0.0.1:19280/ui/chat/alpha" });
    const reads: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => { reads.push(url); return { ok: true, status: 200, json: async () => ({ rev: reads.length, themes: { alpha: { v: 1, font: "mono" } }, locked: [] }) }; });
    const themes = await import("/assets/app-themes.js");
    const { appStore } = await import("/assets/app-store.js");
    themes.startThemes();
    appStore.set({ themesRev: 1 }); await settle(2);
    appStore.set({ themesRev: 1, connection: "live" }); await settle(2);
    expect(reads).toEqual(["/ui/themes"]);
    appStore.set({ themesRev: 2 }); await settle(2);
    expect([reads.length, themes.themeFor("alpha")?.font]).toEqual([2, "mono"]);
  });
  it("not shown: with the viewer's switch off, or in safe mode (?safe=1)", async () => {
    let { themes } = await load({ fxShow: false });
    expect(themes.themesShown()).toBe(false);
    // Safe mode holds from the start: the app starts themes before installOwnerCss runs (smoke: ?safe=1 drew the theme).
    ({ themes } = await load({ url: "http://127.0.0.1:19280/ui/chat/alpha?safe=1" }));
    themes.startThemes();
    themes.themesStore.set({ themes: { alpha: T } });
    expect([themes.themesShown(), themes.themesStore.get().shown, themes.themeFor("alpha")]).toEqual([false, false, null]);
    themes.themesStore.set({ shown: true });                                // even a store that says shown: safe mode wins
    expect(themes.themeFor("alpha")).toBeNull();
  });
  it("the sidebar: the theme's picture and ring while shown; the bot's face and colour otherwise; only same-origin theme paths", async () => {
    const { themes, nav } = await load();
    const it0 = { name: "alpha", avatar: { kind: "image", src: "/ui/img/bot/discord?v=1" }, accent: "#ff0000", theme_avatar: { kind: "image", src: `/ui/img/theme/alpha/${"a".repeat(32)}` }, theme_accent: "#8b5cf6",
      color: { role: "#ff0000", agent: "#8b5cf6", auto: "auto:sea" } };
    expect(nav.avatarOf(it0)).toEqual({ kind: "image", src: `/ui/img/theme/alpha/${"a".repeat(32)}` });
    pg!.storage.set("agend_fx_show", "off");
    expect(themes.themesShown()).toBe(false);
    expect(nav.avatarOf(it0)).toEqual({ kind: "image", src: "/ui/img/bot/discord?v=1" });
    // #1958: the ring is the identity colour — the theme's (the agent tier) while shown, else its bot's (the role tier).
    const ring = async () => (await import("/assets/identity-color.js")).identityOf(it0).light;
    expect(await ring(), "themes off: the bot's colour").toBe("#ff0000");
    pg!.storage.delete("agend_fx_show");
    themes.themesStore.set({ shown: themes.themesShown() });
    expect(await ring(), "themes shown: the theme's").toBe("#8b5cf6");
    for (const src of ["/ui/img/theme/../x", `/ui/img/theme/%2e%2e/${"a".repeat(32)}`, "https://evil/x.png", `/ui/img/theme/a/b/${"a".repeat(32)}`]) {
      expect(nav.avatarOf({ ...it0, theme_avatar: { kind: "image", src } }), src).toEqual({ kind: "image", src: "/ui/img/bot/discord?v=1" });
    }
  });
  it("Lock and Reset are offered — but not over the public link; Unlock once locked", async () => {
    let { themes } = await load();
    expect(themes.themeMenuItems("alpha").map((i: { key: string }) => i.key)).toEqual(["theme-lock", "theme-reset"]);
    themes.themesStore.set({ locked: ["alpha"] });
    expect(themes.themeMenuItems("alpha")[0].label).toBe("Unlock theme");
    ({ themes } = await load({ publicLink: true }));
    expect(themes.themeMenuItems("alpha")).toEqual([]);
  });
});
