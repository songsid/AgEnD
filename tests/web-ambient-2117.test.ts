/**
 * #2117 (from #2115's proposal): declarative ambient effects — the agent sends data, the page draws it.
 * - The spec is closed and checked whole (web-ambient.ts): every bound of every preset, glyph text and glyph pictures,
 *   1 KiB; the page checks the bounds again (chat-ambient.js).
 * - Store: one looping and one click ambient per chat; the same spec keeps its first placement; glyph pictures (their
 *   own small slot, at most 4) go when no ambient names them; what is stored is checked again on load; a person's reset
 *   clears it; it is a placement, not a theme key (an older binary drops it and keeps the theme).
 * - Tools: set_web_ambient / clear_web_ambient — no target, a change, the lock, the fleet switch, a person's placement.
 * - General: set_web_settings { what: "ambient" } writes as the person. GET /ui/themes carries it.
 * - Mods: a bundle's ambient (glyph pictures by path) plans, applies with applyLook and exports back.
 * - The page: shown by default (reduced motion included), hidden with the show switch off, ?safe=1, or this device
 *   following reduced motion while the system asks for it (or can't say); caps; a passive click listener that never
 *   cancels; pause on a hidden tab; everything it made goes on stop; the ⋯ menu names why it isn't showing.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { request, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page, settle, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";

vi.mock("node:child_process", async importOriginal => {
  const real = await importOriginal<typeof import("node:child_process")>();
  const refuse = (name: string) => () => { throw new Error(`ambient: no child process may start (${name})`); };
  return { ...real, spawn: refuse("spawn"), spawnSync: refuse("spawnSync"), exec: refuse("exec"), execSync: refuse("execSync"),
    execFile: refuse("execFile"), execFileSync: refuse("execFileSync"), fork: refuse("fork") };
});

const A = await import("../src/web-ambient.js");
const { ThemeStore, GLYPH_ASSET_LIMIT } = await import("../src/web-theme-store.js");
const { WebAppearance } = await import("../src/web-appearance.js");
const { AppearanceLimiter } = await import("../src/web-appearance-policy.js");
const B = await import("../src/web-mod-bundle.js");
const { buildModBundle } = await import("../src/web-mod-export.js");
const { modPlan } = await import("../src/web-mod-store.js");
const { effectiveAppearanceLimits } = await import("../src/web-appearance-limits.js");
const { WebSettingsTools } = await import("../src/web-settings-tools.js");
const { appearanceView, previewSvg } = await import("../src/web-appearance-view.js");
const { ModStore } = await import("../src/web-mod-store.js");
const { AgentMods } = await import("../src/web-mod-agent.js");
const { WebPrefsStore, OPERATOR } = await import("../src/web-prefs.js");
const { OwnerCssStore } = await import("../src/web-owner-css-store.js");

const dirs: string[] = [];
let pg: AppPage | null = null;
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); if (pg) { pg.restore(); pg = null; } for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "agend-ambient-")); dirs.push(d); return d; };

const crc = (b: Buffer) => { let c = ~0; for (const x of b) { c ^= x; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return (~c) >>> 0; };
const chunk = (t: string, d: Buffer) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
function png(w: number, h: number, rgb: number[] = [200, 80, 120]): Buffer {
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3, Buffer.from(rgb))]);
  const ih = Buffer.alloc(13); ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ih), chunk("IDAT", deflateSync(Buffer.concat(Array(h).fill(row)))), chunk("IEND", Buffer.alloc(0))]);
}
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]);

const PETALS = { preset: "fall", glyphs: ["🌸", "❀", "✿"] };
const STARS = { preset: "burst-on-click", glyphs: ["✦", "✧"], colors: ["#ffd700", "#ff69b4", "#87ceeb", "#98fb98", "#dda0dd"] };
const ok = (raw: unknown, glyphAsset?: (id: string) => boolean) => A.checkAmbient(raw, glyphAsset ? { glyphAsset } : {}).ok;

describe("the spec", () => {
  it("fills every default, per preset", () => {
    const fall = A.checkAmbient(PETALS);
    expect(fall).toEqual({ ok: true, value: { preset: "fall", glyphs: ["🌸", "❀", "✿"], colors: [], count: 12, duration: [9, 19], size: [14, 22], sway: 40, spread: [34, 90], rotate: 300, opacity: [0, 0.85, 0.15], layer: "behind" } });
    expect((A.checkAmbient({ preset: "twinkle", glyphs: ["✦"] }) as any).value).toMatchObject({ count: 12, duration: [2, 5] });
    expect((A.checkAmbient(STARS) as any).value).toMatchObject({ count: 10, duration: [0.5, 0.9], colors: STARS.colors });
    expect(A.ambientKind("fall")).toBe("loop"); expect(A.ambientKind("rise")).toBe("loop"); expect(A.ambientKind("twinkle")).toBe("loop");
    expect(A.ambientKind("burst-on-click")).toBe("click");
  });
  // [what, spec, ok]: each bound on both sides.
  const TABLE: Array<[string, Record<string, unknown>, boolean]> = [
    ["no preset", { glyphs: ["x"] }, false], ["an unknown preset", { preset: "rain", glyphs: ["x"] }, false],
    ["an unknown key", { ...PETALS, css: "x" }, false], ["layer front", { ...PETALS, layer: "front" }, false], ["layer behind", { ...PETALS, layer: "behind" }, true],
    ["no glyphs", { preset: "fall" }, false], ["0 glyphs", { preset: "fall", glyphs: [] }, false],
    ["4 glyphs", { preset: "fall", glyphs: ["a", "b", "c", "d"] }, true], ["5 glyphs", { preset: "fall", glyphs: ["a", "b", "c", "d", "e"] }, false],
    ["a 2-grapheme glyph", { preset: "fall", glyphs: ["✦✧"] }, true], ["a 3-grapheme glyph", { preset: "fall", glyphs: ["abc"] }, false],
    ["a ZWJ family emoji (1 grapheme)", { preset: "fall", glyphs: ["👨‍👩‍👧"] }, true],
    ["a bidi override", { preset: "fall", glyphs: ["‮a"] }, false], ["blank", { preset: "fall", glyphs: [" "] }, false],
    ["a number glyph", { preset: "fall", glyphs: [1] }, false], ["an asset glyph, not hex", { preset: "fall", glyphs: [{ asset: "x" }] }, false],
    ["an asset glyph with a second key", { preset: "fall", glyphs: [{ asset: "a".repeat(32), url: "x" }] }, false],
    ["count 1", { ...PETALS, count: 1 }, true], ["count 0", { ...PETALS, count: 0 }, false], ["count 24", { ...PETALS, count: 24 }, true], ["count 25", { ...PETALS, count: 25 }, false],
    ["count 1.5", { ...PETALS, count: 1.5 }, false],
    ["burst count 4", { ...STARS, count: 4 }, true], ["burst count 3", { ...STARS, count: 3 }, false], ["burst count 16", { ...STARS, count: 16 }, true], ["burst count 17", { ...STARS, count: 17 }, false],
    ["fall duration [4, 30]", { ...PETALS, duration: [4, 30] }, true], ["fall duration [3.9, 9]", { ...PETALS, duration: [3.9, 9] }, false], ["fall duration [9, 31]", { ...PETALS, duration: [9, 31] }, false],
    ["duration min > max", { ...PETALS, duration: [10, 9] }, false], ["duration of 3", { ...PETALS, duration: [4, 5, 6] }, false],
    ["twinkle duration [1, 10]", { preset: "twinkle", glyphs: ["✦"], duration: [1, 10] }, true], ["twinkle duration [1, 11]", { preset: "twinkle", glyphs: ["✦"], duration: [1, 11] }, false],
    ["burst duration [0.3, 2]", { ...STARS, duration: [0.3, 2] }, true], ["burst duration [0.2, 1]", { ...STARS, duration: [0.2, 1] }, false], ["burst duration [0.5, 2.1]", { ...STARS, duration: [0.5, 2.1] }, false],
    ["size [10, 40]", { ...PETALS, size: [10, 40] }, true], ["size [9, 20]", { ...PETALS, size: [9, 20] }, false], ["size [10, 41]", { ...PETALS, size: [10, 41] }, false],
    ["sway 0", { ...PETALS, sway: 0 }, true], ["sway 80", { ...PETALS, sway: 80 }, true], ["sway 81", { ...PETALS, sway: 81 }, false], ["sway -1", { ...PETALS, sway: -1 }, false],
    ["spread [20, 120]", { ...STARS, spread: [20, 120] }, true], ["spread [19, 90]", { ...STARS, spread: [19, 90] }, false], ["spread [20, 121]", { ...STARS, spread: [20, 121] }, false],
    ["rotate 720", { ...PETALS, rotate: 720 }, true], ["rotate 721", { ...PETALS, rotate: 721 }, false], ["rotate NaN", { ...PETALS, rotate: NaN }, false],
    ["opacity [0, 1, 1]", { ...PETALS, opacity: [0, 1, 1] }, true], ["opacity above 1", { ...PETALS, opacity: [0, 1.1, 0] }, false], ["opacity of 2", { ...PETALS, opacity: [0, 1] }, false],
    ["5 colours", STARS, true], ["6 colours", { ...STARS, colors: [...STARS.colors, "#000000"] }, false], ["#rgb", { ...PETALS, colors: ["#f0a"] }, true], ["a colour word", { ...PETALS, colors: ["pink"] }, false],
  ];
  for (const [what, spec, want] of TABLE) it(`${what}: ${want ? "accepted" : "refused"}`, () => { expect(ok(spec), what).toBe(want); });
  it("canonical: NFC, #rgb widened, numbers to two decimals; a prototype key is an unknown key", () => {
    const v = (A.checkAmbient({ preset: "fall", glyphs: ["é"], colors: ["#F0A"], sway: 12.3456 }) as any).value;
    expect([v.glyphs[0], v.colors[0], v.sway]).toEqual(["é", "#ff00aa", 12.35]);
    expect(ok(JSON.parse('{"preset":"fall","glyphs":["x"],"__proto__":{"a":1}}'))).toBe(false);
    expect(ok(Object.assign(Object.create({ preset: "fall" }), { glyphs: ["x"] }))).toBe(false);
  });
  it("a glyph picture must be one of the instance's own (when the caller says which are)", () => {
    const id = "a".repeat(32);
    expect(ok({ preset: "fall", glyphs: [{ asset: id }] }, (x) => x === id)).toBe(true);
    expect(ok({ preset: "fall", glyphs: [{ asset: id }] }, () => false)).toBe(false);
  });
  it("1 KiB is reachable: one grapheme can be long (a base and many combining marks) — refused by bytes alone", () => {
    const long = "x" + "\u0331".repeat(400);                 // 1 grapheme, 801 bytes
    expect(ok({ preset: "fall", glyphs: [long] })).toBe(true);           // one fits under 1 KiB with every default

    const r = A.checkAmbient({ preset: "fall", glyphs: [long, long] });
    expect(r).toEqual({ ok: false, errors: [{ path: "ambient", problem: "at most 1024 bytes" }] });
  });
  it("at most 1 KiB, canonical", () => {
    expect(A.AMBIENT_SPEC_MAX_BYTES).toBe(1024);
    // The largest spec the bounds allow fits: 4 two-character emoji glyphs, 5 colours, every number long.
    const big = { preset: "burst-on-click", glyphs: ["👨‍👩‍👧‍👦👨‍👩‍👧‍👦", "🏳️‍🌈🏳️‍🌈", "👩🏽‍🚀👩🏽‍🚀", "🧑🏿‍🤝‍🧑🏻🧑🏿‍🤝‍🧑🏻"], colors: STARS.colors, count: 16, duration: [0.33, 1.99], size: [10.55, 39.99], sway: 79.99, spread: [20.11, 119.99], rotate: 719.99, opacity: [0.11, 0.99, 0.55] };
    expect(ok(big)).toBe(true);
    const r = A.checkAmbient({ ...big, glyphs: Array(4).fill("👨‍👩‍👧‍👦".repeat(2)) });
    expect(r.ok ? Buffer.byteLength(JSON.stringify(r.value)) : 0).toBeLessThanOrEqual(1024);
  });
});

function tools(opts: { agentEdit?: boolean } = {}) {
  const dir = tmp();
  let now = 1_000_000;
  const clock = () => now;
  const store = new ThemeStore(dir);
  let changed = 0;
  const web = { themes: { agent_edit: opts.agentEdit ?? true } };
  const app = new WebAppearance(store, () => web, () => { changed++; }, new AppearanceLimiter(clock), clock);
  return { dir, store, app, web, changed: () => changed, tick: (ms: number) => { now += ms; } };
}

describe("set_web_ambient / clear_web_ambient", () => {
  it("places its kind: a loop and a click together; stored, for the page, in get_web_theme; one change each", () => {
    const t = tools();
    expect(t.app.handleTool("alpha", "set_web_ambient", PETALS)).toMatchObject({ kind: "loop", ambient: { by: "agent", spec: { preset: "fall" } } });
    t.tick(31_000);
    expect(t.app.handleTool("alpha", "set_web_ambient", STARS)).toMatchObject({ kind: "click" });
    const page = t.store.ambients();
    expect(Object.keys(page)).toEqual(["alpha"]);
    expect(Object.keys(page.alpha!)).toEqual(["loop", "click"]);
    expect((t.app.getTheme("alpha") as any).ambient).toMatchObject({ loop: { by: "agent" }, click: { by: "agent" } });
    expect((t.app.getTheme("alpha") as any).limits.changes).toBe(8);
    expect([t.changed(), t.store.get("alpha").theme]).toEqual([2, { v: 1 }]);   // not a theme key
  });
  it("a new loop replaces only the loop", () => {
    const t = tools();
    t.app.handleTool("alpha", "set_web_ambient", PETALS); t.tick(31_000);
    t.app.handleTool("alpha", "set_web_ambient", STARS); t.tick(31_000);
    t.app.handleTool("alpha", "set_web_ambient", { preset: "rise", glyphs: ["🏮"] });
    const a = t.store.ambients().alpha!;
    expect([a.loop!.spec.preset, a.click!.spec.preset]).toEqual(["rise", "burst-on-click"]);
  });
  it("an invalid spec: errors, nothing stored, nothing counted", () => {
    const t = tools();
    expect(t.app.handleTool("alpha", "set_web_ambient", { ...PETALS, count: 99 })).toHaveProperty("errors");
    expect(t.app.handleTool("alpha", "set_web_ambient", { preset: "fall", glyphs: [{ asset: "b".repeat(32) }] })).toHaveProperty("errors");
    expect([t.store.ambients(), (t.app.getTheme("alpha") as any).limits.changes, t.changed()]).toEqual([{}, 10, 0]);
  });
  it("refused: the fleet switch, the lock, the rate limit — each costs nothing", () => {
    const off = tools({ agentEdit: false });
    expect(off.app.handleTool("alpha", "set_web_ambient", PETALS)).toMatchObject({ error: "theme_editing_off" });
    const t = tools();
    t.app.humanLock("alpha", true);
    expect(t.app.handleTool("alpha", "set_web_ambient", PETALS)).toMatchObject({ error: "locked" });
    expect(t.app.handleTool("alpha", "clear_web_ambient", {})).toMatchObject({ error: "locked" });
    t.app.humanLock("alpha", false);
    t.app.handleTool("alpha", "set_web_ambient", PETALS);
    expect(t.app.handleTool("alpha", "set_web_ambient", STARS)).toMatchObject({ error: "rate_limited" });
    expect(Object.keys(t.store.ambients().alpha!)).toEqual(["loop"]);
  });
  it("one a person set: the agent can't replace or clear it; clear-all keeps it and says so", () => {
    const t = tools();
    expect(t.app.humanSetAmbient("alpha", PETALS)).toMatchObject({ ok: true, kind: "loop", ambient: { by: "human" } });
    expect(t.app.handleTool("alpha", "set_web_ambient", { preset: "twinkle", glyphs: ["✦"] })).toMatchObject({ error: "person_placed" });
    expect(t.app.handleTool("alpha", "clear_web_ambient", { which: "loop" })).toMatchObject({ error: "person_placed" });
    expect(t.app.handleTool("alpha", "set_web_ambient", STARS)).toMatchObject({ kind: "click" });   // the other kind is free
    t.tick(31_000);
    expect(t.app.handleTool("alpha", "clear_web_ambient", {})).toMatchObject({ removed: ["click"], kept: ["loop"] });
    expect(t.app.handleTool("alpha", "clear_web_ambient", { which: "both" })).toMatchObject({ error: "which" });
  });
  it("a person's clear and reset; a person's write is never limited", () => {
    const t = tools();
    t.app.handleTool("alpha", "set_web_ambient", PETALS);
    expect(t.app.humanSetAmbient("alpha", null, "click")).toMatchObject({ ok: true, removed: [] });
    expect(t.app.humanSetAmbient("alpha", STARS)).toMatchObject({ ok: true });
    expect(t.app.humanSetAmbient("alpha", { preset: "x" })).toMatchObject({ error: "ambient", status: 400 });
    expect(t.app.humanSetAmbient("alpha", null, "nope")).toMatchObject({ error: "which", status: 400 });
    t.app.humanReset("alpha");
    expect(t.store.ambients()).toEqual({});
  });
  it("an agent's own reset (reset_web_theme) is its theme only: the ambient stays", () => {
    const t = tools();
    t.app.handleTool("alpha", "set_web_ambient", PETALS); t.tick(31_000);
    t.app.handleTool("alpha", "reset_web_theme", {});
    expect(Object.keys(t.store.ambients().alpha!)).toEqual(["loop"]);
  });
});

describe("glyph pictures", () => {
  it("their own slot: png/webp/gif, 64 KiB, 128 px", () => {
    const s = new ThemeStore(tmp());
    expect(s.addAsset("a", "glyph", png(128, 128))).toMatchObject({ ok: true });
    expect(s.addAsset("a", "glyph", png(129, 8))).toMatchObject({ ok: false, error: "asset_dimensions" });
    expect(s.addAsset("a", "glyph", JPEG)).toMatchObject({ ok: false, error: "asset_type" });
    expect(GLYPH_ASSET_LIMIT).toEqual({ maxBytes: 64 * 1024, maxSide: 128, files: 4 });
  });
  it("at most 4: an unused one makes room (oldest first); when all 4 are in use, refused", () => {
    const t = tools();
    const ids = [1, 2, 3, 4].map(i => (t.store.addAsset("alpha", "glyph", png(8, 8, [i, i, i])) as any).id as string);
    const fifth = t.store.addAsset("alpha", "glyph", png(8, 8, [5, 5, 5]));
    expect(fifth).toMatchObject({ ok: true });
    expect(t.store.get("alpha").assets.map(a => a.id)).toEqual([...ids.slice(1), (fifth as any).id]);
    expect(readdirSync(readdirSync(join(t.dir, "web-themes")).map(d => join(t.dir, "web-themes", d))[0]!)).toHaveLength(4);
    const inUse = t.store.get("alpha").assets.map(a => ({ asset: a.id }));
    expect(t.app.handleTool("alpha", "set_web_ambient", { preset: "fall", glyphs: inUse })).toMatchObject({ kind: "loop" });
    expect(t.store.addAsset("alpha", "glyph", png(8, 8, [6, 6, 6]))).toMatchObject({ ok: false, error: "asset_quota" });
  });
  it("replacing or clearing the ambient deletes the glyph pictures no ambient names now", () => {
    const t = tools();
    const id = (t.store.addAsset("alpha", "glyph", png(8, 8)) as any).id;
    t.app.handleTool("alpha", "set_web_ambient", { preset: "fall", glyphs: [{ asset: id }] }); t.tick(31_000);
    expect(t.store.asset("alpha", id)).not.toBeNull();
    t.app.handleTool("alpha", "set_web_ambient", PETALS);
    expect([t.store.asset("alpha", id), t.store.get("alpha").assets]).toEqual([null, []]);
  });
});

describe("what is stored", () => {
  it("is checked again on load: a tightened rule, a wrong kind or a changed id drops it; the theme stays", async () => {
    const t = tools();
    t.app.handleTool("alpha", "set_web_theme", { set: { accent: "#8b5cf6" } }); t.tick(31_000);
    t.app.handleTool("alpha", "set_web_ambient", PETALS);
    const fs = await import("node:fs");
    const doc = JSON.parse(fs.readFileSync(t.store.path, "utf8"));
    const keep = JSON.parse(JSON.stringify(doc));
    doc.instances.alpha.placements.ambient.loop.spec.count = 99;
    fs.writeFileSync(t.store.path, JSON.stringify(doc));
    const again = new ThemeStore(t.dir);
    expect([again.ambients(), again.get("alpha").theme.accent]).toEqual([{}, "#8b5cf6"]);
    keep.instances.alpha.placements.ambient = { click: keep.instances.alpha.placements.ambient.loop };
    fs.writeFileSync(t.store.path, JSON.stringify(keep));
    expect(new ThemeStore(t.dir).ambients()).toEqual({});
  });
  it("an older binary's view: the ambient is a placement, not a theme key — the theme checker never sees it", async () => {
    const { checkTheme } = await import("../src/web-theme.js");
    const t = tools();
    t.app.handleTool("alpha", "set_web_ambient", PETALS);
    expect(checkTheme(t.store.get("alpha").theme, { assets: new Set() }).ok).toBe(true);
    expect(Object.keys(t.store.get("alpha").theme)).toEqual(["v"]);
  });
});

describe("General: set_web_settings { what: \"ambient\" }", () => {
  function general() {
    const t = tools();
    const deps = {
      prefs: {} as any, ownerCss: {} as any, mods: {} as any, effects: {} as any,
      instances: () => ["alpha"], colour: () => ({ color: null, show: null }), setColour: () => ({ ok: true as const }),
      bannerFocus: () => null, setBannerFocus: () => ({ ok: true as const }), placements: () => [], announce: () => {},
      ambient: (n: string) => Object.fromEntries(Object.entries(t.store.get(n).placements.ambient).flatMap(([k, a]) => a ? [[k, { spec: a.spec, by: a.by }]] : [])),
      setAmbient: (n: string, spec: unknown, which?: unknown) => t.app.humanSetAmbient(n, spec, which),
    };
    return { t, g: new WebSettingsTools(deps) };
  }
  it("sets as the person (the agent can't change it after), clears, refuses an unknown instance or a bad spec", () => {
    const { t, g } = general();
    expect(g.change(undefined, { what: "ambient", instance: "alpha", ambient: PETALS })).toMatchObject({ ok: true, kind: "loop", now: { loop: { by: "human" } } });
    expect(t.app.handleTool("alpha", "set_web_ambient", { preset: "rise", glyphs: ["x"] })).toMatchObject({ error: "person_placed" });
    expect(g.change(undefined, { what: "ambient", instance: "alpha", ambient: null })).toMatchObject({ ok: true, removed: ["loop"], now: {} });
    expect(g.change(undefined, { what: "ambient", instance: "nobody", ambient: PETALS })).toMatchObject({ ok: false, error: "unknown_instance" });
    expect(g.change(undefined, { what: "ambient", instance: "alpha", ambient: { preset: "x" } })).toMatchObject({ ok: false, error: "ambient" });
    expect(g.change(undefined, { what: "ambient", instance: "alpha" })).toMatchObject({ ok: false, error: "ambient" });
  });
});

describe("the appearance view and preview", () => {
  it("get_web_appearance lists it; the preview draws the loop's glyphs still, behind the bubbles, in its colours", () => {
    const spec = (A.checkAmbient({ ...PETALS, colors: ["#f4a7b9"], count: 5 }) as any).value;
    const input = { entry: { name: "alpha" } as any, theme: { v: 1 } as any, card: {} as any, locked: false, agentEdit: true, limits: {}, ambient: { loop: { spec, by: "agent" } } };
    expect(appearanceView(input as any).ambient).toEqual([{ kind: "loop", by: "agent", spec }]);
    const svg = previewSvg(input as any, "dark", { avatar: null, portrait: null, banner: null, background: null });
    expect(svg.match(/fill="#f4a7b9">[🌸❀✿]</gu)).toHaveLength(5);
    expect(svg.indexOf("🌸")).toBeLessThan(svg.indexOf("A message from a person"));
    const none = previewSvg({ ...input, ambient: {} } as any, "dark", { avatar: null, portrait: null, banner: null, background: null });
    expect(none).not.toContain("🌸");
  });
});

describe("mods", () => {
  const limits = effectiveAppearanceLimits(undefined).limits;
  const ctx = { agendVersion: "2.3.0", limits, effects: null };
  const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
  const file = (b: Uint8Array | string) => { const bytes = Buffer.from(b as any); return { sha256: sha(bytes), b64: bytes.toString("base64") }; };
  const G = png(16, 16);
  const doc = (ambient: unknown, files: Record<string, unknown> = {}) => JSON.stringify({ format: "agend-mod", v: 1,
    manifest: { name: "petals", version: "1.0.0", title: "Petals", contents: { ambient: "ambient.json" } },
    files: { "ambient.json": file(JSON.stringify(ambient)), ...files } });
  it("a bundle's ambient: glyph pictures by path, checked as uploads; planned; a wrong kind or a missing picture refused", () => {
    const r = B.checkModBundle(doc({ loop: { preset: "fall", glyphs: ["🌸", { asset: "glyphs/petal.png" }] }, click: STARS }, { "glyphs/petal.png": file(G) }), ctx);
    expect(r.ok).toBe(true);
    const mod = (r as any).mod;
    expect(mod.ambient.pictures).toHaveLength(1);
    expect(mod.ambient.specs.loop.glyphs[1]).toEqual({ asset: mod.ambient.pictures[0].id });
    const plan = modPlan(mod, new Map());
    expect(plan.needs_target).toBe(true);
    expect(plan.items.find(i => i.part === "ambient")).toMatchObject({ loop: { preset: "fall" }, click: { preset: "burst-on-click" }, pictures: [{ path: "glyphs/petal.png", slot: "glyph" }] });
    const bad = B.checkModBundle(doc({ click: PETALS }), ctx);
    expect(bad.ok ? [] : bad.problems.map(p => p.path)).toEqual(["ambient.click.preset"]);
    const missing = B.checkModBundle(doc({ loop: { preset: "fall", glyphs: [{ asset: "glyphs/x.png" }] } }), ctx);
    expect(missing.ok).toBe(false);
    const jpeg = B.checkModBundle(doc({ loop: { preset: "fall", glyphs: [{ asset: "glyphs/x.jpg" }] } }, { "glyphs/x.jpg": file(JPEG) }), ctx);
    expect(jpeg.ok).toBe(false);
  });
  it("applies with the look (as the person), then exports back to an equal ambient", () => {
    const t = tools();
    const mod = (B.checkModBundle(doc({ loop: { preset: "fall", glyphs: [{ asset: "glyphs/petal.png" }] }, click: STARS }, { "glyphs/petal.png": file(G) }), ctx) as any).mod;
    const w = t.store.applyLook("alpha", { pictures: mod.ambient.pictures, ambient: mod.ambient.specs }, "human");
    expect(w.ok).toBe(true);
    (w as any).finalize();
    const rec = t.store.get("alpha");
    expect([rec.placements.ambient.loop?.by, rec.placements.ambient.click?.by, rec.assets.map(a => a.slot)]).toEqual(["human", "human", ["glyph"]]);
    const specs = { loop: rec.placements.ambient.loop!.spec, click: rec.placements.ambient.click!.spec };
    const built = buildModBundle({ name: "again", version: "1.0.0", title: "Again" }, { ambient: { specs, picture: id => { const a = t.store.asset("alpha", id); return a ? { bytes: a.bytes, kind: "png" } : null; } } });
    expect(built.ok).toBe(true);
    const back = B.checkModBundle((built as any).text, ctx);
    expect(back.ok && back.mod.ambient!.specs).toEqual(specs);
  });
});

// ── The page ──

class FakeAnimation {
  static all: FakeAnimation[] = [];
  playState = "running"; onfinish: (() => void) | null = null; oncancel: (() => void) | null = null;
  constructor(public el: any, public frames: any[], public opts: any) { FakeAnimation.all.push(this); }
  pause() { this.playState = "paused"; } play() { this.playState = "running"; }
  cancel() { if (this.playState === "idle") return; this.playState = "idle"; this.oncancel?.(); }
  finish() { this.playState = "finished"; this.onfinish?.(); }
}

async function pageLoad(opts: { url?: string; storage?: Record<string, string>; reduce?: boolean | "throws" | "missing" } = {}) {
  vi.resetModules();
  if (pg) { pg.restore(); pg = null; }
  pg = page({ url: opts.url ?? "http://127.0.0.1:19280/ui/chat/alpha", storage: opts.storage ?? {} });
  const g = globalThis as any;
  if (opts.reduce === "missing") g.matchMedia = undefined;
  else if (opts.reduce === "throws") g.matchMedia = () => { throw new Error("no"); };
  else g.matchMedia = (q: string) => ({ matches: !!opts.reduce && /reduced-motion: reduce/.test(q), addEventListener() {}, removeEventListener() {} });
  FakeAnimation.all = [];
  g.Element.prototype.animate = function (frames: any[], o: any) { return new FakeAnimation(this, frames, o); };
  await import("/ui/js/chat-strings.js");
  const amb = await import("/ui/js/chat-ambient.js");
  const themes = await import("/assets/app-themes.js");
  const P = await import("/assets/app-html.js");
  return { amb, themes, P, doc: pg.document as any };
}
const spec = (s: unknown) => (A.checkAmbient(s) as any).value;

describe("the page: when it shows", () => {
  it("by default — reduced motion on or off — and on the public link", async () => {
    for (const reduce of [false, true]) { const { amb } = await pageLoad({ reduce }); expect(amb.ambientBlock(), `reduce ${reduce}`).toBeNull(); }
    const { amb, doc } = await pageLoad({ reduce: true });
    doc.body.dataset.publicLink = "1";
    expect(amb.ambientBlock()).toBeNull();
  });
  it("hidden: the show switch off, ?safe=1, or this device following a system that asks for reduced motion (or can't say)", async () => {
    expect((await pageLoad({ storage: { agend_fx_show: "off" } })).amb.ambientBlock()).toBe("hidden");
    expect((await pageLoad({ url: "http://127.0.0.1:19280/ui/chat/alpha?safe=1" })).amb.ambientBlock()).toBe("safe");
    const follow = { agend_fx_follow_reduced_motion: "1" };
    expect((await pageLoad({ storage: follow, reduce: true })).amb.ambientBlock()).toBe("reducedMotion");
    expect((await pageLoad({ storage: follow, reduce: false })).amb.ambientBlock()).toBeNull();
    expect((await pageLoad({ storage: follow, reduce: "missing" })).amb.ambientBlock()).toBe("reducedMotion");
    expect((await pageLoad({ storage: follow, reduce: "throws" })).amb.ambientBlock()).toBe("reducedMotion");
    expect((await pageLoad({ reduce: "throws" })).amb.ambientBlock()).toBeNull();
    // An answer that isn't a yes or no is not a "no": following, it stays hidden.
    const odd = await pageLoad({ storage: follow });
    (globalThis as any).matchMedia = () => ({ matches: undefined, addEventListener() {}, removeEventListener() {} });
    expect(odd.amb.ambientBlock()).toBe("reducedMotion");
  });
  it("the page checks the spec again: out of bounds, a wrong kind or an unknown preset is not drawn", async () => {
    const { amb, themes } = await pageLoad();
    const good = spec(PETALS);
    expect(amb.sanitizeAmbient({ ...good, glyphs: ["x".repeat(33)] })).toBeNull();
    expect(amb.sanitizeAmbient({ ...good, glyphs: [""] })).toBeNull();
    expect(amb.sanitizeAmbient({ ...good, glyphs: ["x".repeat(32)] })).not.toBeNull();
    for (const [k, v] of [["sway", 81], ["rotate", 721], ["size", [9, 20]], ["spread", [20, 121]], ["duration", [3, 9]], ["opacity", [0, 2, 0]], ["glyphs", []], ["colors", "x"]] as const) {
      expect(amb.sanitizeAmbient({ ...good, [k]: v }), k).toEqual(k === "colors" ? { ...amb.sanitizeAmbient(good), colors: [] } : null);
    }
    themes.themesStore.set({ ambient: { alpha: { loop: { spec: good, by: "agent" } }, beta: { loop: { spec: { ...good, count: 99 }, by: "agent" } },
      gamma: { loop: { spec: spec(STARS), by: "agent" } }, delta: { click: { spec: { ...good, preset: "explode" }, by: "agent" } } } });
    expect(amb.ambientFor("alpha")).toMatchObject({ loop: { preset: "fall", count: 12 }, click: null });
    expect([amb.ambientFor("beta"), amb.ambientFor("gamma"), amb.ambientFor("delta"), amb.ambientFor("nobody"), amb.ambientFor("__proto__")]).toEqual([null, null, null, null, null]);
  });
});

function surfaceFor(doc: any) {
  const surface = doc.createElement("div"); surface.className = "chat-main";
  const layer = doc.createElement("div"); layer.className = "amb-layer";
  const scroller = doc.createElement("div"); scroller.className = "scroller";
  const msg = doc.createElement("a"); msg.className = "link"; scroller.appendChild(msg);
  const dock = doc.createElement("div"); dock.className = "dock";
  const input = doc.createElement("textarea"); dock.appendChild(input);
  const front = doc.createElement("div"); front.className = "amb-burst";
  surface.append(layer, scroller, dock, front);
  doc.body.appendChild(surface);
  layer.clientWidth = 390; layer.clientHeight = 700;
  return { surface, layer, scroller, msg, dock, input, front };
}

describe("the page: drawing", () => {
  it("a glyph is text, never markup: \"<b>x</b>\" past every server check is one text node, loop and burst alike (Fable R1 P2)", async () => {
    const { amb, doc } = await pageLoad();
    const s = surfaceFor(doc);
    const markup = "<b>x</b>";
    const run = amb.startAmbient({ name: "alpha", ambient: { loop: { ...spec(PETALS), glyphs: [markup], count: 3 }, click: { ...spec(STARS), glyphs: [markup], count: 4 } },
      layer: s.layer, front: s.front, surface: s.surface, doc });
    fire(s.msg, "pointerdown", { bubbles: true, clientX: 10, clientY: 10, button: 0 });
    const nodes = [...s.layer.children, ...s.front.children];
    expect(nodes).toHaveLength(7);
    for (const n of nodes) {
      expect(n.tagName.toLowerCase()).toBe("span");
      expect(n.children.length).toBe(0);
      expect(n.childNodes.map((c: any) => c.nodeType)).toEqual([3]);
      expect(n.textContent).toBe(markup);
    }
    expect(s.surface.querySelectorAll("b")).toHaveLength(0);
    run.stop();
  });
  it("a loop: count nodes, aria-hidden, CSSOM only (no style attribute), transform and opacity only, endless", async () => {
    const { amb, doc } = await pageLoad();
    const s = surfaceFor(doc);
    const run = amb.startAmbient({ name: "alpha", ambient: { loop: spec({ ...PETALS, count: 24 }), click: null }, layer: s.layer, front: s.front, surface: s.surface, doc });
    expect(s.layer.children.length).toBe(24);
    for (const n of s.layer.children) { expect(n.getAttribute("aria-hidden")).toBe("true"); expect(n.getAttribute("style")).toBeNull(); }
    expect(FakeAnimation.all).toHaveLength(24);
    for (const a of FakeAnimation.all) {
      expect(a.opts.iterations).toBe(Infinity);
      for (const f of a.frames) expect(Object.keys(f).filter(k => k !== "offset").sort()).toEqual(["opacity", "transform"]);
    }
    expect(run.stats()).toEqual({ nodes: 24, animations: 24, bursts: 0 });
    run.stop();
    expect([s.layer.children.length, FakeAnimation.all.every(a => a.playState === "idle")]).toEqual([0, true]);
  });
  it("a glyph picture is an <img> from the instance's own theme pictures, sized through the CSSOM", async () => {
    const { amb, doc } = await pageLoad();
    const s = surfaceFor(doc);
    amb.startAmbient({ name: "al pha", ambient: { loop: { ...spec(PETALS), glyphs: [{ asset: "c".repeat(32) }], count: 1 }, click: null }, layer: s.layer, front: s.front, surface: s.surface, doc });
    const img = s.layer.children[0];
    expect([img.tagName.toLowerCase(), img.getAttribute("src") ?? img.src, img.alt]).toEqual(["img", `/ui/img/theme/al%20pha/${"c".repeat(32)}`, ""]);
    expect(img.style.width).toMatch(/^\d+px$/);
  });
  it("bursts: passive pointerdown in the thread only, never cancelled; 3 at once at most (72 nodes with the loop); each cleans up", async () => {
    const { amb, doc } = await pageLoad();
    const s = surfaceFor(doc);
    const add = vi.spyOn(s.surface, "addEventListener");
    const run = amb.startAmbient({ name: "alpha", ambient: { loop: spec({ ...PETALS, count: 24 }), click: spec({ ...STARS, count: 16 }) }, layer: s.layer, front: s.front, surface: s.surface, doc });
    expect(add.mock.calls.find(c => c[0] === "pointerdown")?.[2]).toEqual({ passive: true });
    const down = (target: any) => { const ev = fire(target, "pointerdown", { bubbles: true, cancelable: true, clientX: 50, clientY: 60, button: 0 }); return ev; };
    const ev = down(s.msg);
    expect([ev.defaultPrevented, ev.propagationStopped ?? false]).toEqual([false, false]);
    expect(s.front.children.length).toBe(16);
    down(s.input);                                           // the composer: no stars
    const menu = doc.createElement("div"); menu.setAttribute("role", "menu"); const item = doc.createElement("button"); menu.appendChild(item); s.scroller.appendChild(menu);
    down(item);                                              // a menu open over the thread: no stars
    expect(s.front.children.length).toBe(16);
    down(s.msg); down(s.msg); down(s.msg);                   // a 4th while 3 are alive: ignored
    expect(run.stats()).toEqual({ nodes: 72, animations: 72, bursts: 3 });
    for (const a of FakeAnimation.all.filter(x => x.el.parentNode === s.front)) a.finish();
    expect(run.stats()).toEqual({ nodes: 24, animations: 24, bursts: 0 });
    down(s.msg);
    expect(run.stats().bursts).toBe(1);
    run.stop();
    expect([s.front.children.length, s.layer.children.length, s.surface.listenerCount("pointerdown")]).toEqual([0, 0, 0]);
  });
  it("a hidden tab pauses every animation; visible again plays them; stop removes the listener", async () => {
    const { amb, doc } = await pageLoad();
    const s = surfaceFor(doc);
    const run = amb.startAmbient({ name: "alpha", ambient: { loop: spec({ ...PETALS, count: 3 }), click: null }, layer: s.layer, front: s.front, surface: s.surface, doc });
    Object.defineProperty(doc, "visibilityState", { value: "hidden", configurable: true });
    fire(doc, "visibilitychange");
    expect(FakeAnimation.all.map(a => a.playState)).toEqual(["paused", "paused", "paused"]);
    Object.defineProperty(doc, "visibilityState", { value: "visible", configurable: true });
    fire(doc, "visibilitychange");
    expect(FakeAnimation.all.map(a => a.playState)).toEqual(["running", "running", "running"]);
    run.stop();
    expect(doc.listenerCount("visibilitychange")).toBe(0);
  });
  it("the counts the page draws never pass the caps, whatever the spec says", async () => {
    const { amb, doc } = await pageLoad();
    const s = surfaceFor(doc);
    amb.startAmbient({ name: "alpha", ambient: { loop: { ...spec(PETALS), count: 500 }, click: null }, layer: s.layer, front: s.front, surface: s.surface, doc });
    expect(s.layer.children.length).toBe(amb.AMBIENT_CAPS.loop);
  });
});

describe("the page: the chat", () => {
  async function mount(storage: Record<string, string> = {}, reduce = false) {
    const env = await pageLoad({ storage, reduce });
    const { P, themes, amb } = env;
    themes.themesStore.set({ ambient: { alpha: { loop: { spec: spec(PETALS), by: "agent" }, click: { spec: spec(STARS), by: "agent" } } } });
    let surface: any = null;
    const Chat = () => {
      const ref = P.useRef(null); surface = ref;
      return P.h("div", { ref, class: "chat-main" }, P.h(amb.ChatAmbient, { name: "alpha", surface: ref, part: "layer" }),
        P.h("div", { class: "scroller" }), P.h("div", { class: "dock" }), P.h(amb.ChatAmbient, { name: "alpha", surface: ref, part: "front" }));
    };
    // The modules were loaded afresh (resetModules): render with that same Preact, so its hooks are the component's.
    const pre = await import("/assets/preact.module.js");
    pre.render(P.h(Chat, {}), pg!.root); await settle(4);
    return { ...env, surface: () => surface.current, unmount: async () => { pre.render(null, pg!.root); await settle(4); } };
  }
  it("mounts both layers, marks the surface, runs; unmounting takes everything away", async () => {
    const { surface, unmount } = await mount();
    const el = surface();
    expect(el.classList.contains("has-amb")).toBe(true);
    expect([el.querySelector(".amb-layer").children.length, el.querySelector(".amb-burst") !== null]).toEqual([12, true]);
    await unmount();
    expect(FakeAnimation.all.every(a => a.playState === "idle")).toBe(true);
    expect(el.classList.contains("has-amb")).toBe(false);
  });
  it("following reduced motion while the system asks for it: nothing is drawn", async () => {
    const { surface } = await mount({ agend_fx_follow_reduced_motion: "1" }, true);
    expect([surface().querySelector(".amb-layer"), FakeAnimation.all.length]).toEqual([null, 0]);
  });
  it("turning the device switch on hides it at once; off again draws it", async () => {
    const { surface } = await mount({}, true);
    const motion = await import("/assets/fx-motion.js");
    motion.setFollowsReducedMotion(true); await settle(4);
    expect(surface().querySelector(".amb-layer")).toBeNull();
    motion.setFollowsReducedMotion(false); await settle(4);
    expect(surface().querySelector(".amb-layer").children.length).toBe(12);
  });
  it("the ⋯ menu: why it isn't showing, and choosing it fixes it right there (public link too); a person's Clear — none over the public link", async () => {
    const { amb, surface } = await mount({ agend_fx_follow_reduced_motion: "1" }, true);
    const clear = vi.fn();
    const items = amb.ambientMenuItems("alpha", { publicLink: false, clear });
    expect(items.map((i: any) => i.key)).toEqual(["ambient-blocked", "ambient-clear-loop", "ambient-clear-click"]);
    expect(items[0].label).toContain("reduced motion");
    expect(amb.ambientMenuItems("alpha", { publicLink: true, clear }).map((i: any) => i.key)).toEqual(["ambient-blocked"]);
    items[0].onSelect(); await settle(4);
    expect([pg!.storage.has("agend_fx_follow_reduced_motion"), surface().querySelector(".amb-layer").children.length]).toEqual([false, 12]);
    items[2].onSelect(); expect(clear).toHaveBeenCalledWith("alpha", "click");
    expect(amb.ambientMenuItems("nobody", { publicLink: false, clear })).toEqual([]);
    expect(amb.ambientMenuItems("alpha", { publicLink: false, clear }).map((i: any) => i.key)).toEqual(["ambient-clear-loop", "ambient-clear-click"]);
  });
  it("the show switch off: the ⋯ line turns it on here", async () => {
    const { amb, surface } = await mount({ agend_fx_show: "off" }, false);
    const [line] = amb.ambientMenuItems("alpha", { publicLink: false, clear: vi.fn() });
    expect([line.key, surface().querySelector(".amb-layer")]).toEqual(["ambient-blocked", null]);
    line.onSelect(); await settle(4);
    expect(amb.ambientBlock()).toBeNull();
  });
});

describe("the person's mods and the agent's export", () => {
  const limits = effectiveAppearanceLimits(undefined).limits;
  const ctx = () => ({ agendVersion: "2.3.0", limits, effects: null });
  const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
  const file = (b: Uint8Array | string) => { const bytes = Buffer.from(b as any); return { sha256: sha(bytes), b64: bytes.toString("base64") }; };
  function setup() {
    const dir = tmp();
    let clock = 1_000_000;
    const themes = new ThemeStore(dir);
    const prefs = new WebPrefsStore(dir, { exists: () => true } as never);
    const css = new OwnerCssStore(dir, prefs);
    const mods = new ModStore(dir, { themes, prefs, ownerCss: css, effects: null, context: ctx, isKnownInstance: (n: string) => n === "alpha", prefsIdentity: OPERATOR, clock: () => clock });
    const web = { themes: { agent_edit: true } };
    const app = new WebAppearance(themes, () => web, () => {}, new AppearanceLimiter(() => clock), () => clock);
    const agent = new AgentMods({ themes, mods, limiter: app.limiter, webConfig: () => web, context: ctx, notice: () => {}, changed: () => {}, clock: () => clock });
    return { themes, mods, app, agent, tick: (ms: number) => { clock += ms; } };
  }
  const bundleText = JSON.stringify({ format: "agend-mod", v: 1,
    manifest: { name: "petals", version: "1.0.0", title: "Petals", contents: { ambient: "ambient.json" } },
    files: { "ambient.json": file(JSON.stringify({ loop: { preset: "fall", glyphs: ["🌸", { asset: "glyphs/p.png" }] }, click: STARS })), "glyphs/p.png": file(png(16, 16)) } });
  it("stage → commit: the ambient part is ticked by default and applied to the target as the person's, its glyph picture with it", () => {
    const s = setup();
    const st = s.mods.stage("p", bundleText);
    if (!st.ok) throw new Error("stage");
    expect(st.plan.items.map(i => i.part)).toEqual(["ambient"]);
    expect(s.mods.commit("p", { stage: st.stage, plan_hash: st.plan_hash, include: { ambient: false } })).toMatchObject({ ok: false, error: "include" });
    const r = s.mods.commit("p", { stage: st.stage, plan_hash: st.plan_hash, include: { ambient: true }, target: "alpha" });
    expect(r).toMatchObject({ ok: true, applied: ["ambient"] });
    const rec = s.themes.get("alpha");
    expect([rec.placements.ambient.loop?.by, rec.placements.ambient.click?.spec.preset, rec.assets.map(a => a.slot)]).toEqual(["human", "burst-on-click", ["glyph"]]);
  });
  it("export_web_mod carries the ambient the agent set itself, never one a person set", () => {
    const s = setup();
    s.app.humanSetAmbient("alpha", PETALS);
    expect(s.app.handleTool("alpha", "set_web_ambient", STARS)).toMatchObject({ kind: "click" });
    const out = s.agent.handle("alpha", "export_web_mod", { name: "mine", version: "1.0.0" }) as any;
    const doc = JSON.parse(Buffer.from(out.files[0].data_b64, "base64").toString("utf8"));
    const amb = JSON.parse(Buffer.from(doc.files["ambient.json"].b64, "base64").toString("utf8"));
    expect(Object.keys(amb)).toEqual(["click"]);
    expect(B.checkModBundle(JSON.stringify(doc), ctx()).ok).toBe(true);
  });
});

interface Res { status: number; body: string }
function raw(port: number, method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<Res> {
  return new Promise((resolve, reject) => {
    const r = request({ host: "127.0.0.1", port, method, path, headers }, res => {
      const chunks: Buffer[] = []; res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    r.on("error", reject); if (body !== undefined) r.write(body); r.end();
  });
}

describe("the fleet: the agent's door, General's, GET /ui/themes and a person's route", () => {
  it("all wired to the same service", async () => {
    const { FleetManager } = await import("../src/fleet-manager.js");
    const { csrfTokenFor, tokenEpoch } = await import("../src/web-session.js");
    const fm = new FleetManager(tmp()) as any;
    const quiet = () => {};
    fm.logger = { info: quiet, warn: quiet, error: quiet, debug: quiet, trace: quiet, fatal: quiet, child: () => fm.logger };
    vi.spyOn(fm, "notifyFleetError").mockImplementation(() => true);
    fm.fleetConfig = { instances: { alpha: { working_directory: "/tmp" } }, defaults: {} };
    fm.initializeWebAuthTokens(); fm.startHealthServer(0);
    await vi.waitFor(() => expect(fm.getDashboardAccess().ready).toBe(true));
    const port = ((fm.healthServer as Server).address() as { port: number }).port, origin = `http://127.0.0.1:${port}`;
    const session = (tier: "admin" | "read") => {
      const { sessionId } = fm.webSessions.create({ tier, surface: "local", label: "t", tokenEpoch: tokenEpoch(fm.webToken) });
      return { cookie: `agend_session=${sessionId}`, origin, "x-agend-csrf": csrfTokenFor(sessionId), "content-type": "application/json" };
    };
    try {
      await expect(fm.handleWebThemeHttp("alpha", "set_web_ambient", PETALS)).resolves.toMatchObject({ kind: "loop" });
      expect(fm.webSettings.change(undefined, { what: "ambient", instance: "alpha", ambient: STARS })).toMatchObject({ ok: true, kind: "click" });
      expect(fm.webSettings.read(undefined).agents.find((a: any) => a.name === "alpha").ambient).toMatchObject({ loop: { by: "agent" }, click: { by: "human" } });
      const themes = JSON.parse((await raw(port, "GET", "/ui/themes", { cookie: session("read").cookie })).body);
      expect(Object.keys(themes.ambient.alpha)).toEqual(["loop", "click"]);
      const post = (h: Record<string, string>, body: unknown) => raw(port, "POST", "/ui/themes/alpha/ambient", h, JSON.stringify(body));
      expect((await post(session("read"), { which: "loop" })).status).toBe(403);
      expect(JSON.parse((await post(session("admin"), { which: "loop" })).body)).toMatchObject({ ok: true, removed: ["loop"] });
      expect(Object.keys(fm.themeStore.ambients().alpha)).toEqual(["click"]);
      // Typed IPC (the daemon's door): the connection's instance; and the agent endpoint (agend-agent's).
      const send = vi.fn();
      fm.instanceIpcClients.set("alpha", { send });
      fm.webAppearance.limiter.forget("alpha");
      fm.dispatchTypedIpc("alpha", { type: "fleet_set_web_ambient", fleetRequestId: "t1", payload: { preset: "twinkle", glyphs: ["✦"] } });
      expect(send.mock.calls.map(c => [c[0].type, c[0].fleetRequestId, c[0].result.kind])).toEqual([["fleet_web_theme_response", "t1", "loop"]]);
      const { dispatchAgentOperation } = await import("../src/agent-endpoint.js");
      fm.webAppearance.limiter.forget("alpha");
      expect(await dispatchAgentOperation(fm, "alpha", "ambient-clear", { which: "loop" })).toMatchObject({ removed: ["loop"] });
      fm.webAppearance.limiter.forget("alpha");
      expect(await dispatchAgentOperation(fm, "alpha", "ambient-set", PETALS)).toMatchObject({ kind: "loop" });
    } finally { await new Promise<void>(r => (fm.healthServer as Server).close(() => r())); }
  });
});

describe("the wiring", () => {
  it("both tools: IPC, the agent endpoint, worker and standard profiles — never general; no target in either schema", async () => {
    const perms = await import("../src/tool-permissions.js");
    const schemas = await import("../src/outbound-schemas.js");
    for (const tool of ["set_web_ambient", "clear_web_ambient"]) {
      expect(perms.TOOL_PROFILES.worker, tool).toContain(tool);
      expect(perms.TOOL_PROFILES.standard, tool).toContain(tool);
      expect(perms.TOOL_PROFILES.general, tool).not.toContain(tool);
      expect(Object.values(perms.IPC_TYPE_TOOLS)).toContain(tool);
      expect(Object.values(perms.EARLY_AGENT_OP_TOOLS)).toContain(tool);
    }
    for (const s of [schemas.SetWebAmbientArgs, schemas.ClearWebAmbientArgs]) expect(Object.keys(s.shape).filter(k => /instance|target|name/.test(k))).toEqual([]);
    expect(schemas.SetWebAmbientArgs.safeParse({ ...PETALS, instance: "other" }).success).toBe(false);
    expect(schemas.SetWebAmbientArgs.safeParse({ ...PETALS, layer: "front" }).success).toBe(false);
    expect(schemas.SetWebThemeAssetArgs.safeParse({ slot: "glyph", file: "p.png" }).success).toBe(true);
    const src = (await import("node:fs")).readFileSync(new URL("../src/daemon.ts", import.meta.url), "utf8");
    expect(src).toContain('set_web_ambient: "fleet_set_web_ambient", clear_web_ambient: "fleet_clear_web_ambient"');
  });
  it("agend-agent ambient set / clear: one op each, the spec as JSON", async () => {
    const { createServer } = await import("node:http");
    const { execFile } = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    const t = tools();
    const seen: Array<[string, unknown]> = [];
    const server = createServer((req, res) => { let body = ""; req.on("data", c => { body += c; }); req.on("end", () => {
      const p = JSON.parse(body); seen.push([p.op, p.args]);
      res.end(JSON.stringify(t.app.handleTool("a", p.op === "ambient-clear" ? "clear_web_ambient" : "set_web_ambient", p.args)));
    }); });
    await new Promise<void>(r => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as { port: number }).port;
    const home = tmp(), ws = tmp();
    const run = (...argv: string[]) => new Promise<{ code: number; out: string }>(resolve => execFile(process.execPath, ["--import", pathToFileURL(join(process.cwd(), "node_modules/tsx/dist/loader.mjs")).href, join(process.cwd(), "src/agent-cli.ts"), ...argv], {
      cwd: ws, env: { ...process.env, AGEND_PORT: String(port), AGEND_INSTANCE_NAME: "a", AGEND_HOME: home }, timeout: 60_000 }, (e, stdout, stderr) => resolve({ code: e ? (e as { code?: number }).code ?? 1 : 0, out: stdout + stderr })));
    try {
      expect(JSON.parse((await run("ambient", "set", JSON.stringify(PETALS))).out)).toMatchObject({ kind: "loop" });
      t.tick(31_000);
      expect(JSON.parse((await run("ambient", "clear", "loop")).out)).toMatchObject({ removed: ["loop"] });
      const bad = await run("ambient", "set", "{not json");
      expect([bad.code !== 0, bad.out]).toEqual([true, expect.stringContaining("not JSON")]);
      expect(seen).toEqual([["ambient-set", PETALS], ["ambient-clear", { which: "loop" }]]);
    } finally { await new Promise(r => server.close(r)); }
  }, 120_000);
});

describe("the page: the one-time reduced-motion note", () => {
  async function mountNote(storage: Record<string, string>, reduce: boolean, withAmbient = true, url?: string) {
    const env = await pageLoad({ storage, reduce, ...(url ? { url } : {}) });
    const { P, themes, amb } = env;
    themes.themesStore.set({ ambient: withAmbient ? { alpha: { loop: { spec: spec(PETALS), by: "agent" } } } : {} });
    const pre = await import("/assets/preact.module.js");
    pre.render(P.h("div", { class: "chat-main" }, P.h(amb.AmbientMotionNote, { name: "alpha" })), pg!.root); await settle(4);
    return { ...env, note: () => pg!.root.querySelector(".amb-note") };
  }
  it("the system asks for reduced motion and the ambient plays: said once on this device, with the switch that turns it off", async () => {
    const first = await mountNote({}, true);
    expect(first.note()).not.toBeNull();
    expect(first.note().getAttribute("role")).toBe("status");
    expect(first.note().textContent).toContain("reduced motion");
    expect(pg!.storage.get("agend_fx_motion_note_seen")).toBe("1");
    fire(first.note().querySelector(".amb-note-off"), "click", { bubbles: true, cancelable: true });
    await settle(2);
    expect([pg!.storage.get("agend_fx_follow_reduced_motion"), first.amb.ambientBlock()]).toEqual(["1", "reducedMotion"]);   // turned off right here
    expect(first.note()).toBeNull();
    const again = await mountNote({ agend_fx_motion_note_seen: "1" }, true);
    expect(again.note()).toBeNull();
  });
  it("the shared helper on its own (Canvas Worker effects may use it): due only for a clear system yes, not following, not seen", async () => {
    const cases: Array<[Record<string, string>, boolean | "throws", boolean]> = [
      [{}, true, true], [{}, false, false], [{}, "throws", false],
      [{ agend_fx_follow_reduced_motion: "1" }, true, false], [{ agend_fx_motion_note_seen: "1" }, true, false],
    ];
    for (const [storage, reduce, due] of cases) {
      await pageLoad({ storage, reduce });
      const motion = await import("/assets/fx-motion.js");
      expect(motion.motionNoteDue(), JSON.stringify([storage, reduce])).toBe(due);
    }
    await pageLoad({ reduce: true });
    (globalThis as any).matchMedia = () => ({ matches: undefined, addEventListener() {}, removeEventListener() {} });
    expect((await import("/assets/fx-motion.js")).motionNoteDue(), "an answer that isn't yes").toBe(false);
  });
  it("not shown: no reduced motion, this device follows it (nothing plays), no ambient here; × closes it", async () => {
    expect((await mountNote({}, false)).note()).toBeNull();
    expect((await mountNote({ agend_fx_follow_reduced_motion: "1" }, true)).note()).toBeNull();
    expect((await mountNote({}, true, false)).note()).toBeNull();
    const m = await mountNote({}, true);
    fire(m.note().querySelector(".amb-note-x"), "click", { bubbles: true });
    await settle(2);
    expect(m.note()).toBeNull();
  });
});

describe("the note and the ⋯ line, the cases Fable's #2124 R2 review left open", () => {
  it("never while nothing is drawn: the show switch off or ?safe=1 with reduced motion asked — no note, and the one-time flag is kept", async () => {
    for (const [storage, url] of [[{ agend_fx_show: "off" }, undefined], [{}, "http://127.0.0.1:19280/ui/chat/alpha?safe=1"]] as const) {
      const env = await pageLoad({ storage: { ...storage }, reduce: true, ...(url ? { url } : {}) });
      env.themes.themesStore.set({ ambient: { alpha: { loop: { spec: spec(PETALS), by: "agent" } } } });
      const pre = await import("/assets/preact.module.js");
      pre.render(env.P.h("div", { class: "chat-main" }, env.P.h(env.amb.AmbientMotionNote, { name: "alpha" })), pg!.root); await settle(4);
      expect(pg!.root.querySelector(".amb-note"), JSON.stringify([storage, url])).toBeNull();
      expect(pg!.storage.has("agend_fx_motion_note_seen"), "the one-time flag is not spent").toBe(false);
    }
  });
  it("an open note goes away when the ambient is cleared, or becomes hidden", async () => {
    const cleared = await (async () => {
      const env = await pageLoad({ reduce: true });
      env.themes.themesStore.set({ ambient: { alpha: { loop: { spec: spec(PETALS), by: "agent" } } } });
      const pre = await import("/assets/preact.module.js");
      pre.render(env.P.h("div", { class: "chat-main" }, env.P.h(env.amb.AmbientMotionNote, { name: "alpha" })), pg!.root); await settle(4);
      expect(pg!.root.querySelector(".amb-note")).not.toBeNull();
      env.themes.themesStore.set({ ambient: {} }); await settle(4);
      return pg!.root.querySelector(".amb-note");
    })();
    expect(cleared, "cleared").toBeNull();
    const env = await pageLoad({ reduce: true });
    env.themes.themesStore.set({ ambient: { alpha: { loop: { spec: spec(PETALS), by: "agent" } } } });
    const pre = await import("/assets/preact.module.js");
    pre.render(env.P.h("div", { class: "chat-main" }, env.P.h(env.amb.AmbientMotionNote, { name: "alpha" })), pg!.root); await settle(4);
    expect(pg!.root.querySelector(".amb-note")).not.toBeNull();
    env.themes.setThemesShown(false); await settle(4);
    expect(pg!.root.querySelector(".amb-note"), "hidden by the show switch").toBeNull();
  });
  it("?safe=1: the ⋯ line names safe mode and choosing it leaves safe mode (the same URL without safe)", async () => {
    const env = await pageLoad({ url: "http://127.0.0.1:19280/ui/chat/alpha?safe=1&x=2" });
    env.themes.themesStore.set({ ambient: { alpha: { loop: { spec: spec(PETALS), by: "agent" } } } });
    const [line] = env.amb.ambientMenuItems("alpha", { publicLink: false, clear: vi.fn() });
    expect([line.key, line.label]).toEqual(["ambient-blocked", expect.stringContaining("safe mode")]);
    line.onSelect();
    const went = new URL((globalThis as any).location.assigned);
    expect([went.pathname, went.searchParams.has("safe"), went.searchParams.get("x")]).toEqual(["/ui/chat/alpha", false, "2"]);
  });
});
