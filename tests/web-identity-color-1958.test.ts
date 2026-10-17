/**
 * #1958 (server side): an instance's identity colour.
 * - The palette's 12 presets read at 4.5:1 on the page's and the sidebar's background, light and dark (the sidebar's
 *   colours are pinned to tokens.css).
 * - A colour is a preset id or #rrggbb, kept as `preset:<id>` / lowercase hex; a custom colour's name text uses a readable shade.
 * - Resolution: a person's pick > the agent's own (theme.identity.color, else its accent; only while themes are
 *   shown) > the own bot's role colour > one of a few soft automatic colours, by a stable hash of the name.
 * - Placements (name / bar / ring): a person's choice > the agent's (themes shown) > the host's color.show > ring + bar.
 * - The store: its own table (instance_identity; the first cut's instance_color carries over once); a status read
 *   creates nothing; a field cleared falls back; a bad value writes nothing.
 * - POST /api/profile/<name> { color, color_show }: checked before anything is written, written in one transaction
 *   with the card and the profile row; a write sends a status frame; GET reads the choice back. The status frame
 *   carries the tiers; get_web_appearance says which colour and places are in force, whose they are, and if colours are off.
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
const { checkTheme, contrastRatio, THEME_DEFAULTS } = await import("../src/web-theme.js");
const { parseWebPrefsPatch } = await import("../src/web-prefs.js");
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
  it("the automatic colours: 8 soft ones, each readable on the page and the sidebar too", () => {
    expect(C.AUTO_PALETTE.map(p => p.id)).toEqual(["sand", "clay", "rose", "plum", "dusk", "sea", "moss", "slate"]);
    for (const p of C.AUTO_PALETTE) for (const mode of ["light", "dark"] as const) {
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
    for (const bad of ["navy", "preset:navy", "Blue", "#12345", "#1234567", "rgb(1,2,3)", " #abc", "#abc ", "", 5, null, undefined, {}, "auto:sand", "sand"]) expect(C.canonicalIdentityColor(bad), String(bad)).toBeNull();
  });
  it("drawn: a preset by the page's mode, a custom colour as it is", () => {
    expect(C.identityColorValue("preset:blue", "light")).toBe("#0a62c2");
    expect(C.identityColorValue("preset:blue", "dark")).toBe("#7ab7ff");
    expect(C.identityColorValue("#123456", "dark")).toBe("#123456");
    expect([C.identityColorValue("auto:sea", "light"), C.identityColorValue("auto:sea", "dark")]).toEqual(["#3f7286", "#92c2d4"]);
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
  it("the automatic colour: one of the soft ones, the same for a name every time; two names may share one", () => {
    expect(C.autoIdentityColor("alpha")).toBe(C.autoIdentityColor("alpha"));
    expect(C.autoIdentityColor("alpha")).toMatch(/^auto:[a-z]+$/);
    // 32-bit FNV-1a over the UTF-8 bytes, modulo the 8 automatic colours (worked out independently of this module).
    expect(C.autoIdentityColor("a")).toBe("auto:dusk");          // 0xe40c292c
    expect(C.autoIdentityColor("alpha")).toBe("auto:plum");      // 0x5d8b6dab
    expect(C.autoIdentityColor("beta")).toBe("auto:slate");      // 0xaf81e4c7
    expect(C.autoIdentityColor("web-app")).toBe("auto:slate");   // 0xccb053a7: the same as beta's — fine (decision 4)
    expect(C.autoIdentityColor("研究")).toBe("auto:dusk");        // 0x8828802c: bytes, not UTF-16 units
    expect(new Set(Array.from({ length: 60 }, (_, i) => C.autoIdentityColor(`agent-${i}`))).size).toBe(8);
  });
});

describe("placements: where the colour shows", () => {
  it("a set of name / bar / ring, kept in that order; [] is nowhere; anything else is refused", () => {
    expect(C.canonicalPlacements(["ring", "name"])).toEqual(["name", "ring"]);
    expect(C.canonicalPlacements([])).toEqual([]);
    for (const bad of [["ring", "ring"], ["glow"], "ring", [1], ["name", "bar", "ring", "name"], null, {}]) expect(C.canonicalPlacements(bad), JSON.stringify(bad)).toBeNull();
    expect(C.DEFAULT_PLACEMENTS, "#2056: all three where nobody chose").toEqual(["name", "bar", "ring"]);
  });
  it("a person's choice > the agent's (themes shown) > the host's default > all three (#2056)", () => {
    const t = { person: ["name"], agent: ["ring"] } as never;
    expect(C.resolvePlacements(t, { showThemes: true, hostDefault: ["bar"] })).toEqual({ show: ["name"], source: "person" });
    expect(C.resolvePlacements({ agent: ["ring"] } as never, { showThemes: true, hostDefault: ["bar"] })).toEqual({ show: ["ring"], source: "agent" });
    expect(C.resolvePlacements({ agent: ["ring"] } as never, { showThemes: false, hostDefault: ["bar"] })).toEqual({ show: ["bar"], source: "host" });
    expect(C.resolvePlacements({}, { showThemes: true })).toEqual({ show: ["name", "bar", "ring"], source: "host" });
    expect(C.resolvePlacements({}, { showThemes: true, hostDefault: [] })).toEqual({ show: [], source: "host" });
    expect(C.resolvePlacements({ person: ["glow"] } as never, { showThemes: true, hostDefault: "x" }), "unreadable tiers fall through").toEqual({ show: ["name", "bar", "ring"], source: "host" });
  });
  it("the host's settings are web prefs: color.show (a set of places) and color.off (true)", () => {
    expect(parseWebPrefsPatch({ "color.show": ["ring", "name"], "color.off": true }, () => true)).toMatchObject({ ok: true });
    for (const bad of [{ "color.show": ["glow"] }, { "color.off": false }, { "color.off": "on" }]) expect(parseWebPrefsPatch(bad, () => true).ok, JSON.stringify(bad)).toBe(false);
  });
});

describe("the agent's own colour and places (theme.identity)", () => {
  const ctx = { assets: new Set<string>() } as never;
  it("a preset or #rrggbb, and a set of places — checked, kept canonical", () => {
    const r = checkTheme({ v: 1, identity: { color: "Teal".toLowerCase(), show: ["ring", "name"] } }, ctx);
    expect(r).toEqual({ ok: true, theme: { v: 1, identity: { color: "preset:teal", show: ["name", "ring"] } } });
    expect(checkTheme({ v: 1, identity: { color: "#ABC" } }, ctx)).toEqual({ ok: true, theme: { v: 1, identity: { color: "#aabbcc" } } });
  });
  it("anything else is refused, naming the field", () => {
    const r = checkTheme({ v: 1, identity: { color: "navy", show: ["glow"], size: 3 } }, ctx);
    expect(r.ok).toBe(false);
    expect((r as { errors: Array<{ path: string }> }).errors.map(e => e.path).sort()).toEqual(["identity.color", "identity.show", "identity.size"]);
    expect(checkTheme({ v: 1, identity: "blue" }, ctx).ok).toBe(false);
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
    expect(C.resolveIdentityColor({ agent: "red; background:url(x)", role: "nope", auto: "auto:moss" }, { showThemes: true })).toEqual({ color: "auto:moss", source: "auto" });
  });
  it("the agent's tier takes a preset too (theme.identity.color)", () => {
    expect(C.resolveIdentityColor({ agent: "preset:violet", auto: "auto:moss" }, { showThemes: true })).toEqual({ color: "preset:violet", source: "agent" });
  });
});

describe("the store (profiles.db instance_identity)", () => {
  const open = (dir: string) => { let db: Database.Database | null = null; return () => (db ??= new Database(join(dir, "profiles.db"))); };
  it("field by field: a colour, places, or both; a field cleared falls back; a bad value writes nothing", () => {
    const dir = tmp("agend-color-");
    const s = new C.IdentityColorStore(open(dir));
    expect(s.get("alpha")).toEqual({ color: null, show: null });
    expect(s.set("alpha", { color: "teal" })).toEqual({ ok: true });
    expect(s.set("alpha", { show: ["ring", "name"] })).toEqual({ ok: true });
    expect(s.get("alpha")).toEqual({ color: "preset:teal", show: ["name", "ring"] });
    expect(s.set("alpha", { color: "#ABCDEF" })).toEqual({ ok: true });
    expect(s.get("alpha")).toEqual({ color: "#abcdef", show: ["name", "ring"] });
    expect(s.set("alpha", { color: "navy" })).toMatchObject({ ok: false, status: 400, error: "color" });
    expect(s.set("alpha", { color: "red", show: ["glow"] })).toMatchObject({ ok: false, status: 400, error: "color_show" });
    expect(s.get("alpha"), "unchanged: neither field is written").toEqual({ color: "#abcdef", show: ["name", "ring"] });
    for (const reset of [null, "", "  "]) { s.set("alpha", { color: "red" }); expect(s.set("alpha", { color: reset })).toEqual({ ok: true }); expect(s.get("alpha").color).toBeNull(); }
    expect(s.set("alpha", { show: [] })).toEqual({ ok: true });
    expect(s.get("alpha").show, "[] is nowhere, not unset").toEqual([]);
    expect(s.set("alpha", { show: null })).toEqual({ ok: true });
    expect(s.get("alpha")).toEqual({ color: null, show: null });
    expect(open(dir)().prepare("SELECT COUNT(*) AS n FROM instance_identity").get(), "a row with nothing left is gone").toEqual({ n: 0 });
  });
  it("a status read creates nothing, and skips a value this version cannot read", () => {
    const dir = tmp("agend-color-");
    expect(C.IdentityColorStore.all(dir, open(dir))).toEqual(new Map());
    expect(existsSync(join(dir, "profiles.db")), "no profiles.db made by a read").toBe(false);
    const openDb = open(dir);
    const s = new C.IdentityColorStore(openDb);
    s.set("alpha", { color: "green" }); s.set("beta", { show: ["bar"] });
    openDb().prepare("INSERT INTO instance_identity (instance_name, color, show, updated_at) VALUES ('gamma', 'oklch(1 2 3)', '[\"glow\"]', 0)").run();
    expect(C.IdentityColorStore.all(dir, openDb)).toEqual(new Map([["alpha", { color: "preset:green", show: null }], ["beta", { color: null, show: ["bar"] }]]));
  });
  it("the first cut's picks (instance_color) carry over once, and read before anything is written", () => {
    const dir = tmp("agend-color-");
    const openDb = open(dir);
    openDb().exec("CREATE TABLE instance_color (instance_name TEXT PRIMARY KEY, color TEXT NOT NULL, updated_at INTEGER)");
    openDb().prepare("INSERT INTO instance_color VALUES ('alpha', 'preset:red', 1), ('beta', 'bad', 1)").run();
    expect(C.IdentityColorStore.all(dir, openDb), "read as they are, nothing written").toEqual(new Map([["alpha", { color: "preset:red", show: null }]]));
    const s = new C.IdentityColorStore(openDb);
    expect(s.get("alpha")).toEqual({ color: "preset:red", show: null });
    s.set("alpha", { show: ["name"] });
    expect(C.IdentityColorStore.all(dir, openDb).get("alpha")).toEqual({ color: "preset:red", show: ["name"] });
  });
  it("Prism #2003 P2-1: carried over once per database — a pick reset since never comes back on a later connection", () => {
    const dir = tmp("agend-color-");
    const first = new Database(join(dir, "profiles.db"));
    first.exec("CREATE TABLE instance_color (instance_name TEXT PRIMARY KEY, color TEXT NOT NULL, updated_at INTEGER)");
    first.prepare("INSERT INTO instance_color VALUES ('alpha', 'preset:red', 1)").run();
    const s1 = new C.IdentityColorStore(() => first);
    expect(s1.get("alpha").color).toBe("preset:red");                    // carried over
    expect(s1.set("alpha", { color: null })).toEqual({ ok: true });      // Reset: the row is gone
    first.close();
    // A later connection (a fleet restart): the old table is still there, and must not bring red back.
    const second = new Database(join(dir, "profiles.db"));
    const s2 = new C.IdentityColorStore(() => second);
    expect(s2.get("alpha")).toEqual({ color: null, show: null });
    expect(C.IdentityColorStore.all(dir, () => second).has("alpha")).toBe(false);
    expect(second.prepare("SELECT COUNT(*) AS n FROM instance_color").get(), "the old table is left as it is").toEqual({ n: 1 });
    second.close();
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
    expect(await call("POST", "/api/profile/alpha", { color: "violet", color_show: ["name", "bar"] })).toEqual({ status: 200, body: { ok: true } });
    expect(changed).toHaveBeenCalledTimes(1);
    const got = (await call("GET", "/api/profile/alpha")).body;
    expect([got.color, got.color_show]).toEqual(["preset:violet", ["name", "bar"]]);
    expect(await call("POST", "/api/profile/alpha", { color_show: ["glow"], display_name: "Not saved" })).toEqual({ status: 400, body: { error: "color_show", detail: "a list of where the colour shows: name, bar, ring (each once; [] for nowhere)" } });
    const bad = await call("POST", "/api/profile/alpha", { color: "navy", card_tagline: "Not saved", display_name: "Not saved" });
    expect(bad).toEqual({ status: 400, body: { error: "color", detail: "a preset id or a hex colour #rrggbb" } });
    expect(changed, "refused writes repaint nothing").toHaveBeenCalledTimes(1);
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
  it("Fable #1966 P3: the card text, the choice and the profile row go in one transaction — a failure takes them all back", async () => {
    const { call, changed, dir } = await fleet();
    // An instance_profile this version cannot write (no `role` column): the last write of the three fails.
    const db = new Database(join(dir, "profiles.db"));
    db.exec("CREATE TABLE instance_profile (instance_name TEXT PRIMARY KEY, display_name TEXT, avatar_path TEXT, description TEXT, updated_at INTEGER)");
    db.close();
    const r = await call("POST", "/api/profile/alpha", { color: "pink", color_show: ["ring"], card_tagline: "Rolled back", role: "Lead" });
    expect([r.status, r.body.error]).toEqual([503, "profile_write_failed"]);
    expect(changed, "a failed write repaints nothing").not.toHaveBeenCalled();
    // Prism #2003 P2-2: the SAME fleet, route and cached handle still work for both stores after the rollback.
    const got = (await call("GET", "/api/profile/alpha")).body;
    expect([got.color, got.color_show], "the colour was taken back").toEqual([null, null]);
    expect((await call("GET", "/api/card/alpha")).body.tagline, "and the card text").toBeUndefined();
    expect((await call("POST", "/api/profile/alpha", { color: "teal", color_show: ["name"], card_tagline: "After" })).status).toBe(200);
    expect(changed).toHaveBeenCalledTimes(1);
    const after = (await call("GET", "/api/profile/alpha")).body;
    expect([after.color, after.color_show]).toEqual(["preset:teal", ["name"]]);
    expect((await call("GET", "/api/card/alpha")).body.tagline).toEqual({ text: "After", by: "human" });
  });
  it("an agent sets its own colour and places with set_web_theme (identity); a bad one is refused and nothing kept", async () => {
    const { fm } = await fleet();
    const set = fm.webAppearance.setTheme("beta", { set: { identity: { color: "teal", show: ["ring", "name"] } } });
    expect([set.error, set.errors], JSON.stringify(set)).toEqual([undefined, undefined]);
    expect(fm.themeStore.get("beta").theme.identity).toEqual({ color: "preset:teal", show: ["name", "ring"] });
    const bad = fm.webAppearance.setTheme("alpha", { set: { identity: { color: "navy" } } });
    expect(bad.errors).toEqual([{ path: "identity.color", problem: expect.stringContaining("a preset") }]);
    expect(fm.themeStore.get("alpha").theme.identity, "nothing kept").toBeUndefined();
  });
  it("the status frame carries the tiers; get_web_appearance resolves them (a person's pick over the theme's accent)", async () => {
    const { fm, call } = await fleet();
    fm.webAppearance.setTheme("alpha", { set: { accent: "#3366cc" } });
    const entry = (n: string) => (fm.getUiStatus().instances as Array<Record<string, any>>).find(i => i.name === n)!;
    expect([entry("alpha").color, entry("alpha").color_show]).toEqual([{ agent: "#3366cc", auto: C.autoIdentityColor("alpha") }, {}]);
    expect(entry("beta").color).toEqual({ auto: C.autoIdentityColor("beta") });
    expect(resolvedIdentityColor(entry("alpha") as never)).toEqual({ color: "#3366cc", source: "agent", light: "#3366cc", dark: "#3366cc", show: ["name", "bar", "ring"], show_source: "host", off: false });
    // The agent's own colour and places (theme.identity) win over its accent.
    // (Through the store: the agent's tool would wait out the edit limiter's gap first.)
    fm.themeStore.setTheme("alpha", { v: 1, accent: "#3366cc", identity: { color: "preset:indigo", show: ["name"] } }, "agent");
    expect([entry("alpha").color.agent, entry("alpha").color_show]).toEqual(["preset:indigo", { agent: ["name"] }]);
    expect(resolvedIdentityColor(entry("alpha") as never, { show: ["bar"] })).toMatchObject({ color: "preset:indigo", source: "agent", show: ["name"], show_source: "agent" });
    // A person's choice wins, field by field.
    expect((await call("POST", "/api/profile/alpha", { color: "amber" })).status).toBe(200);
    expect(entry("alpha").color).toEqual({ person: "preset:amber", agent: "preset:indigo", auto: C.autoIdentityColor("alpha") });
    expect(resolvedIdentityColor(entry("alpha") as never)).toMatchObject({ color: "preset:amber", source: "person", light: "#8a5d00", dark: "#e3b341", show: ["name"], show_source: "agent" });
    expect((await call("POST", "/api/profile/alpha", { color_show: [] })).status).toBe(200);
    expect(resolvedIdentityColor(entry("alpha") as never)).toMatchObject({ show: [], show_source: "person" });
    // The host's default and its off switch (web prefs) reach the agent's view too.
    expect(resolvedIdentityColor(entry("beta") as never, { show: ["name", "ring"], off: true })).toMatchObject({ source: "auto", show: ["name", "ring"], show_source: "host", off: true });
    fm.webPrefs.write("operator", new Map<string, unknown>([["color.off", true]]));
    const view = fm.appearanceTools.handle("beta", "get_web_appearance", {}) as Record<string, any>;
    expect(view.identity_color).toMatchObject({ source: "auto", off: true });
  });
});
