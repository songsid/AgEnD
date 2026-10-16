/**
 * #1958 (server side): an instance's identity colour.
 * - The palette's 12 presets read at 4.5:1 on the page's and the sidebar's background, light and dark (the sidebar's
 *   colours are pinned to tokens.css).
 * - A colour is a preset id or #rrggbb, kept as `preset:<id>` / lowercase hex; a custom colour's name text uses a readable shade.
 * - Resolution: a person's pick > the agent's theme accent (only while themes are shown) > the own bot's role
 *   colour > a stable hash of the name.
 * - The store: its own table; a status read creates nothing; Reset deletes the pick; a bad value writes nothing.
 * - POST /api/profile/<name> { color }: checked before anything is written; a write sends a status frame; GET reads
 *   the pick back. The status frame carries the tiers; get_web_appearance says which colour is in force and why.
 */
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", async importOriginal => {
  const real = await importOriginal<typeof import("node:child_process")>();
  const refuse = () => { throw Error("identity colour tests must not spawn any process"); };
  return { ...real, spawn: refuse, spawnSync: refuse, exec: refuse, execSync: refuse, execFile: refuse, execFileSync: refuse, fork: refuse };
});
// #1778 shape: a real FleetManager's pino transport opens <AGEND_HOME>/daemon.log late, racing the scratch home's removal.
vi.mock("../src/logger.js", async original => {
  const silent: Record<string, unknown> = new Proxy({}, { get: (_t, key) => (key === "child" ? () => silent : key === "level" ? "silent" : () => {}) });
  return { ...await original<typeof import("../src/logger.js")>(), createLogger: () => silent };
});

const C = await import("../src/web-identity-color.js");
const { contrastRatio, THEME_DEFAULTS } = await import("../src/web-theme.js");
const { resolvedIdentityColor } = await import("../src/web-appearance-view.js");

const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tmp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };

describe("the palette", () => {
  it("12 presets, each readable (4.5:1) on the page and the sidebar, in light and in dark", () => {
    expect(C.IDENTITY_PALETTE.map(p => p.id)).toEqual(["red", "orange", "amber", "lime", "green", "teal", "cyan", "blue", "indigo", "violet", "pink", "slate"]);
    for (const p of C.IDENTITY_PALETTE) for (const mode of ["light", "dark"] as const) {
      for (const bg of [THEME_DEFAULTS[mode].bg, C.SIDEBAR_BG[mode]]) expect(contrastRatio(p[mode], bg), `${p.id} ${mode} on ${bg}`).toBeGreaterThanOrEqual(4.5);
    }
  });
  it("the sidebar's colours are tokens.css's --bg-sidebar (dark is the default, light the other)", () => {
    const css = readFileSync(join(process.cwd(), "src", "ui", "shared", "tokens.css"), "utf8");
    const all = [...css.matchAll(/--bg-sidebar:\s*(#[0-9a-f]{6})/gi)].map(m => m[1]!.toLowerCase());
    expect(all[0]).toBe(C.SIDEBAR_BG.dark);
    expect(new Set(all.slice(1))).toEqual(new Set([C.SIDEBAR_BG.light]));
  });
});

describe("a colour as given, as kept, as drawn", () => {
  it("a preset's id (bare or prefixed) or a hex colour, in its kept form; nothing else", () => {
    expect(C.canonicalIdentityColor("blue")).toBe("preset:blue");
    expect(C.canonicalIdentityColor("preset:teal")).toBe("preset:teal");
    expect(C.canonicalIdentityColor("#ABC")).toBe("#aabbcc");
    expect(C.canonicalIdentityColor("#12AB34")).toBe("#12ab34");
    for (const bad of ["navy", "preset:navy", "Blue", "#12345", "#1234567", "rgb(1,2,3)", " #abc", "#abc ", "", 5, null, undefined, {}]) expect(C.canonicalIdentityColor(bad), String(bad)).toBeNull();
  });
  it("drawn: a preset by the page's mode, a custom colour as it is", () => {
    expect(C.identityColorValue("preset:blue", "light")).toBe("#0a62c2");
    expect(C.identityColorValue("preset:blue", "dark")).toBe("#7ab7ff");
    expect(C.identityColorValue("#123456", "dark")).toBe("#123456");
  });
  it("name text: a readable shade of a custom colour — itself when it already reads, else toward black or white", () => {
    expect(C.readableShade("#0a62c2", "light")).toBe("#0a62c2");
    for (const [hex, mode] of [["#ffff00", "light"], ["#000080", "dark"], ["#777777", "light"], ["#777777", "dark"]] as const) {
      const shade = C.readableShade(hex, mode);
      expect(shade, `${hex} ${mode}`).not.toBe(hex);
      for (const bg of [THEME_DEFAULTS[mode].bg, C.SIDEBAR_BG[mode]]) expect(contrastRatio(shade, bg)).toBeGreaterThanOrEqual(4.5);
    }
    expect(C.readableShade("not a colour", "dark")).toBe(THEME_DEFAULTS.dark.text);
  });
  it("a shade is the colour moved toward black on a light page and toward white on a dark one — never the text colour", () => {
    const rgb = (h: string) => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
    for (const [hex, mode] of [["#ffff00", "light"], ["#33aaff", "light"], ["#000080", "dark"], ["#aa2244", "dark"]] as const) {
      const shade = C.readableShade(hex, mode), a = rgb(hex), b = rgb(shade);
      expect(shade, `${hex} ${mode}`).not.toBe(THEME_DEFAULTS[mode].text);
      b.forEach((v, i) => (mode === "light" ? expect(v).toBeLessThanOrEqual(a[i]!) : expect(v).toBeGreaterThanOrEqual(a[i]!)));
    }
  });
  it("readable on the sidebar too, not only the page: #767676 reads 4.54 on white but 4.31 on the light sidebar", () => {
    expect(contrastRatio("#767676", THEME_DEFAULTS.light.bg)).toBeGreaterThanOrEqual(4.5);
    expect(C.readableShade("#767676", "light")).not.toBe("#767676");
  });
  it("the automatic colour: a preset, the same for a name every time, and names spread over the palette", () => {
    expect(C.autoIdentityColor("alpha")).toBe(C.autoIdentityColor("alpha"));
    expect(C.autoIdentityColor("alpha")).toMatch(/^preset:[a-z]+$/);
    const used = new Set(Array.from({ length: 60 }, (_, i) => C.autoIdentityColor(`agent-${i}`)));
    expect(used.size).toBeGreaterThanOrEqual(8);
    // 32-bit FNV-1a over the UTF-8 bytes, modulo the 12 presets (worked out independently of this module).
    expect(C.autoIdentityColor("a")).toBe("preset:green");       // 0xe40c292c
    expect(C.autoIdentityColor("alpha")).toBe("preset:slate");   // 0x5d8b6dab
    expect(C.autoIdentityColor("web-app")).toBe("preset:lime");  // 0xccb053a7
    expect(C.autoIdentityColor("研究")).toBe("preset:red");       // 0x8828802c: bytes, not UTF-16 units
  });
});

describe("resolution: person > agent (themes shown) > role > auto", () => {
  const all = { person: "preset:pink", agent: "#112233", role: "#445566", auto: "preset:slate" } as const;
  it("each tier in turn", () => {
    expect(C.resolveIdentityColor(all, { showThemes: true })).toEqual({ color: "preset:pink", source: "person" });
    expect(C.resolveIdentityColor({ ...all, person: undefined }, { showThemes: true })).toEqual({ color: "#112233", source: "agent" });
    expect(C.resolveIdentityColor({ ...all, person: undefined, agent: undefined }, { showThemes: true })).toEqual({ color: "#445566", source: "role" });
    expect(C.resolveIdentityColor({ auto: "preset:slate" }, { showThemes: true })).toEqual({ color: "preset:slate", source: "auto" });
  });
  it("themes hidden: the agent's tier is skipped (the rest of its theme is, too)", () => {
    expect(C.resolveIdentityColor({ ...all, person: undefined }, { showThemes: false })).toEqual({ color: "#445566", source: "role" });
  });
  it("a tier that is not a colour is skipped, never drawn", () => {
    expect(C.resolveIdentityColor({ agent: "red; background:url(x)", role: "nope", auto: "preset:lime" }, { showThemes: true })).toEqual({ color: "preset:lime", source: "auto" });
  });
});

describe("the store (profiles.db instance_color)", () => {
  const open = (dir: string) => { let db: Database.Database | null = null; return () => (db ??= new Database(join(dir, "profiles.db"))); };
  it("set, read back, Reset; a bad value writes nothing", () => {
    const dir = tmp("agend-color-");
    const s = new C.IdentityColorStore(open(dir));
    expect(s.get("alpha")).toBeNull();
    expect(s.set("alpha", "teal")).toEqual({ ok: true });
    expect(s.get("alpha")).toBe("preset:teal");
    expect(s.set("alpha", "#ABCDEF")).toEqual({ ok: true });
    expect(s.get("alpha")).toBe("#abcdef");
    expect(s.set("alpha", "navy")).toMatchObject({ ok: false, status: 400, error: "color" });
    expect(s.get("alpha"), "unchanged").toBe("#abcdef");
    for (const reset of [null, "", "  "]) { s.set("alpha", "red"); expect(s.set("alpha", reset)).toEqual({ ok: true }); expect(s.get("alpha")).toBeNull(); }
  });
  it("a status read creates nothing, and skips a row this version cannot read", () => {
    const dir = tmp("agend-color-");
    expect(C.IdentityColorStore.all(dir, open(dir))).toEqual(new Map());
    expect(existsSync(join(dir, "profiles.db")), "no profiles.db made by a read").toBe(false);
    const openDb = open(dir);
    const s = new C.IdentityColorStore(openDb);
    s.set("alpha", "green"); s.set("beta", "#010203");
    openDb().prepare("INSERT INTO instance_color (instance_name, color, updated_at) VALUES ('gamma', 'oklch(1 2 3)', 0)").run();
    expect(C.IdentityColorStore.all(dir, openDb)).toEqual(new Map([["alpha", "preset:green"], ["beta", "#010203"]]));
  });
});

describe("through the fleet: the profile route, the status frame, get_web_appearance", () => {
  async function fleet() {
    const dir = tmp("agend-color-fm-");
    vi.stubEnv("AGEND_HOME", dir);
    const { FleetManager } = await import("../src/fleet-manager.js");
    const { handleViewRequest } = await import("../src/view-api.js");
    const fm = new FleetManager(dir) as any;
    fm.fleetConfig = { instances: { alpha: { working_directory: dir }, beta: { working_directory: dir } }, defaults: {} };
    fm.initializeWebAuthTokens();
    const changed = vi.spyOn(fm, "identityChanged").mockImplementation(() => {});
    const call = (method: string, path: string, body?: unknown) => new Promise<{ status: number; body: any }>((resolve) => {
      const req: any = Object.assign(new EventEmitter(), { method, url: path, headers: { host: "127.0.0.1:19280", "x-agend-token": fm.webToken, "content-type": "application/json" }, socket: { remoteAddress: "127.0.0.1" }, destroy() {}, resume() {} });
      let status = 0;
      const res: any = { headersSent: false, setHeader() {}, writeHead(c: number) { status = c; res.headersSent = true; return res; }, end(b?: Buffer | string) { resolve({ status, body: b ? JSON.parse(b.toString()) : null }); } };
      expect(handleViewRequest(req, res, new URL(`http://127.0.0.1:19280${path}`), fm)).toBe(true);
      setImmediate(() => { if (body !== undefined) req.emit("data", Buffer.from(JSON.stringify(body))); req.emit("end"); });
    });
    return { fm, call, changed, dir };
  }
  it("POST { color }: kept, read back, Reset; checked before anything is written; each write repaints every page", async () => {
    const { call, changed } = await fleet();
    expect(await call("POST", "/api/profile/alpha", { color: "violet" })).toEqual({ status: 200, body: { ok: true } });
    expect(changed).toHaveBeenCalledTimes(1);
    expect((await call("GET", "/api/profile/alpha")).body.color).toBe("preset:violet");
    const bad = await call("POST", "/api/profile/alpha", { color: "navy", card_tagline: "Not saved", display_name: "Not saved" });
    expect(bad).toEqual({ status: 400, body: { error: "color", detail: "a preset id or a hex colour #rrggbb" } });
    expect(changed, "a refused write repaints nothing").toHaveBeenCalledTimes(1);
    const after = (await call("GET", "/api/profile/alpha")).body;
    expect([after.color, after.display_name]).toEqual(["preset:violet", null]);
    expect((await call("POST", "/api/profile/alpha", { color: null })).status).toBe(200);
    expect((await call("GET", "/api/profile/alpha")).body.color).toBeNull();
    expect(changed).toHaveBeenCalledTimes(2);
    // Any profile write repaints (a name, a card line) — before #1958 none did.
    expect((await call("POST", "/api/profile/alpha", { display_name: "Alfa" })).status).toBe(200);
    expect((await call("POST", "/api/profile/alpha", { card_tagline: "Hi" })).status).toBe(200);
    expect(changed).toHaveBeenCalledTimes(4);
    expect((await call("POST", "/api/profile/alpha", {})).status).toBe(200);
    expect(changed, "nothing written: nothing to repaint").toHaveBeenCalledTimes(4);
    expect((await call("POST", "/api/profile/nobody", { color: "red" })).status).toBe(404);
  });
  it("the status frame carries the tiers; get_web_appearance resolves them (a person's pick over the theme's accent)", async () => {
    const { fm, call } = await fleet();
    fm.webAppearance.setTheme("alpha", { set: { accent: "#3366cc" } });
    const entry = (n: string) => (fm.getUiStatus().instances as Array<Record<string, any>>).find(i => i.name === n)!;
    expect(entry("alpha").color).toEqual({ agent: "#3366cc", auto: C.autoIdentityColor("alpha") });
    expect(entry("beta").color).toEqual({ auto: C.autoIdentityColor("beta") });
    expect(resolvedIdentityColor(entry("alpha") as never)).toEqual({ color: "#3366cc", source: "agent", light: "#3366cc", dark: "#3366cc" });
    expect((await call("POST", "/api/profile/alpha", { color: "amber" })).status).toBe(200);
    expect(entry("alpha").color).toEqual({ person: "preset:amber", agent: "#3366cc", auto: C.autoIdentityColor("alpha") });
    expect(resolvedIdentityColor(entry("alpha") as never)).toEqual({ color: "preset:amber", source: "person", light: "#8a5d00", dark: "#e3b341" });
    expect(resolvedIdentityColor(entry("beta") as never).source).toBe("auto");
  });
});
