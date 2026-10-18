/**
 * #1629 r4 §4 / §7.5 (r4-5a): mod bundles.
 * - The check is whole and closed: a sha mismatch, a `..` path, an unused file, an unknown key or 8 MiB + 1 byte is
 *   refused; every part goes through its own validator (theme and pictures, identity, widgets, owner CSS, CW1 effects);
 *   the id is stable under file reordering; export → import is a round trip.
 * - Stage then commit: exactly the staged plan (a changed hash is 409), only the chosen parts, owner CSS never by
 *   default; a failure mid-commit restores every store; a stage expires (monotonic) and a restart forgets it.
 * - Effects go through the effect library under the mod's own holder (a fake with CW1's names); uninstall releases only
 *   that holder; replacing a version needs a confirmation.
 * - The routes: sessions only (never the CLI token), admin for writes, never over the public link (both layers).
 */
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", async importOriginal => {
  const real = await importOriginal<typeof import("node:child_process")>();
  const refuse = (name: string) => () => { throw new Error(`mods: no child process may start (${name})`); };
  return { ...real, spawn: refuse("spawn"), spawnSync: refuse("spawnSync"), exec: refuse("exec"), execSync: refuse("execSync"),
    execFile: refuse("execFile"), execFileSync: refuse("execFileSync"), fork: refuse("fork") };
});
// #1778 shape: a real FleetManager's pino transport opens <AGEND_HOME>/daemon.log late, racing the scratch home's removal (ENOTEMPTY).
vi.mock("../src/logger.js", async original => {
  const silent: Record<string, unknown> = new Proxy({}, { get: (_t, key) => (key === "child" ? () => silent : key === "level" ? "silent" : () => {}) });
  return { ...await original<typeof import("../src/logger.js")>(), createLogger: () => silent };
});

const B = await import("../src/web-mod-bundle.js");
const { buildModBundle } = await import("../src/web-mod-export.js");
const { ModStore, MOD_STAGE_MS, modHolder, modPlan } = await import("../src/web-mod-store.js");
const { ThemeStore } = await import("../src/web-theme-store.js");
const { WebPrefsStore, OPERATOR } = await import("../src/web-prefs.js");
const { OwnerCssStore } = await import("../src/web-owner-css-store.js");
const { effectiveAppearanceLimits } = await import("../src/web-appearance-limits.js");

const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "agend-mods-")); dirs.push(d); return d; };

// ── Fixtures ──
const crc = (b: Buffer) => { let c = ~0; for (const x of b) { c ^= x; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return (~c) >>> 0; };
const chunk = (t: string, d: Buffer) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
function png(w: number, h: number, rgb: number[]): Buffer {
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3, Buffer.from(rgb))]);
  const ih = Buffer.alloc(13); ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ih), chunk("IDAT", deflateSync(Buffer.concat(Array(h).fill(row)))), chunk("IEND", Buffer.alloc(0))]);
}
const BG = png(8, 8, [10, 20, 30]), AV = png(4, 4, [200, 100, 50]);
const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
const file = (b: Uint8Array | string) => { const bytes = typeof b === "string" ? Buffer.from(b) : Buffer.from(b); return { sha256: sha(bytes), b64: bytes.toString("base64") }; };
const HEADER = { spec: { v: 1, title: "Build", items: [{ type: "progress", label: "Tests", key: "tests" }] }, data: { tests: 10 } };
const SIDEBAR = { spec: { v: 1, title: "Fleet", items: [{ type: "stat", label: "Idle", bind: "fleet.idle" }] }, data: {} };
const EFFECT = { v: 1, runtime: "canvas-worker-v1", worker: "worker.js", name: "snow", title: "Snow", regions: ["chat"], layer: "behind", wants: ["state"], params: { count: { type: "int", min: 0, max: 10, default: 2 } } };

/** A bundle document (an object; `text()` makes the file). */
function bundle(over: { manifest?: Record<string, unknown>; files?: Record<string, unknown>; contents?: Record<string, unknown> } = {}) {
  const files: Record<string, unknown> = {
    "theme.json": file(JSON.stringify({ v: 1, accent: "#8b5cf6", font: "mono", background: { image: "pictures/bg.png", fit: "cover", opacity: 0.4 }, avatar: "pictures/me.png" })),
    "pictures/bg.png": file(BG), "pictures/me.png": file(AV),
    "identity.json": file(JSON.stringify({ tagline: "Reviews fast", bio: "Line one\nLine two" })),
    "widgets/header.json": file(JSON.stringify(HEADER)),
    "widgets/sidebar.json": file(JSON.stringify(SIDEBAR)),
    "css/custom.css": file(".chat { letter-spacing: 0.01em; }"),
    ...over.files,
  };
  const manifest = { name: "violet", version: "1.0.0", title: "Violet", author: "someone", contents: { theme: "theme.json", identity: "identity.json", widgets: { chat_header: "widgets/header.json", sidebar: "widgets/sidebar.json" }, ownerCss: { css: "css/custom.css" }, ...over.contents }, ...over.manifest };
  return { format: "agend-mod", v: 1, manifest, files };
}
const text = (doc: unknown) => JSON.stringify(doc);
const limits = effectiveAppearanceLimits(undefined).limits;
const ctx = (over: Partial<import("../src/web-mod-bundle.js").ModContext> = {}) => ({ agendVersion: "2.3.0", limits, effects: null, ...over });
const check = (doc: unknown, c = ctx()) => B.checkModBundle(typeof doc === "string" ? doc : text(doc), c);
const problems = (doc: unknown, c = ctx()) => { const r = check(doc, c); return r.ok ? [] : r.problems.map(p => `${p.path}: ${p.problem}`); };

describe("the bundle check", () => {
  it("a whole bundle: every part checked and canonical; pictures named by their ids", () => {
    const r = check(bundle());
    expect(r.ok, JSON.stringify(!r.ok && r.problems)).toBe(true);
    if (!r.ok) return;
    const m = r.mod;
    expect(m.id).toMatch(/^[0-9a-f]{32}$/);
    expect(m.theme!.theme).toMatchObject({ v: 1, accent: "#8b5cf6", font: "mono", background: { fit: "cover", opacity: 0.4 } });
    expect(m.theme!.pictures.map(p => [p.path, p.slot])).toEqual([["pictures/bg.png", "background"], ["pictures/me.png", "avatar"]]);
    expect(m.theme!.theme.background!.image).toBe(m.theme!.pictures[0]!.id);
    expect(m.identity).toEqual({ tagline: "Reviews fast", bio: "Line one\nLine two" });
    expect(Object.keys(m.widgets)).toEqual(["chat_header", "sidebar"]);
    expect(m.ownerCss!.text).toBe(".chat { letter-spacing: 0.01em; }");
  });
  it("the id is the content: stable under file reordering, moved by any byte", () => {
    const a = check(bundle()), doc = bundle();
    const reordered = { ...doc, files: Object.fromEntries(Object.entries(doc.files).reverse()) };
    const b = check(reordered);
    const c = check(bundle({ files: { "css/custom.css": file(".chat { letter-spacing: 0.02em; }") } }));
    expect([a.ok && b.ok && a.mod.id === b.mod.id, a.ok && c.ok && a.mod.id !== c.mod.id]).toEqual([true, true]);
  });
  const REFUSED: Array<[string, unknown, RegExp]> = [
    ["a sha256 that is not its bytes", bundle({ files: { "pictures/bg.png": { sha256: sha("x"), b64: BG.toString("base64") } } }), /sha256 does not match/],
    ["a .. path", bundle({ files: { "pictures/../x.png": file(BG) } }), /no \.\. or empty segment/],
    ["an empty segment", bundle({ files: { "pictures//x.png": file(BG) } }), /no \.\. or empty segment/],
    ["an uppercase path", bundle({ files: { "Pictures/x.png": file(BG) } }), /lowercase path/],
    ["a file no part uses", bundle({ files: { "extra.txt": file("hi") } }), /files\.extra\.txt: not used by any part/],
    ["a file two parts use", bundle({ contents: { identity: "theme.json" } }), /already used by another part/],
    ["a file that is also a directory", bundle({ files: { "theme.json/x": file("x") } }), /both a file and a directory/],
    ["a part naming a missing file", bundle({ contents: { identity: "nope.json" } }), /no file nope\.json/],
    ["an unknown top-level key", { ...bundle(), script: "x" }, /^script: unknown key/],
    ["an unknown manifest key", bundle({ manifest: { homepage: "https://x" } }), /manifest\.homepage: unknown key/],
    ["an unknown contents key", bundle({ contents: { html: "x.html" } }), /manifest\.contents\.html: unknown key/],
    ["format", { ...bundle(), format: "zip" }, /format: must be/],
    ["v 2", { ...bundle(), v: 2 }, /v: must be 1/],
    ["a bad name", bundle({ manifest: { name: "Violet!" } }), /manifest\.name/],
    ["a bad version", bundle({ manifest: { version: "1.0" } }), /manifest\.version/],
    ["requires a newer AgEnD", bundle({ manifest: { requires: { agend: ">=9.0.0" } } }), /needs AgEnD >=9\.0\.0/],
    ["requires in another form", bundle({ manifest: { requires: { agend: "^2.3.0" } } }), /manifest\.requires/],
    ["bad base64", bundle({ files: { "css/custom.css": { sha256: sha("x"), b64: "@@@" } } }), /\{ sha256, b64 \}/],
    ["a card in the theme", bundle({ files: { "theme.json": file(JSON.stringify({ v: 1, card: { tagline: "x" } })) }, contents: { theme: "theme.json", identity: undefined }, manifest: {} }), /theme\.card/],
    ["a theme colour that fails contrast", bundle({ files: { "theme.json": file(JSON.stringify({ v: 1, colors: { dark: { bg: "#000000", text: "#111111" } } })), "pictures/bg.png": undefined, "pictures/me.png": undefined } }), /theme\.colors\.dark/],
    ["a picture that is not a picture", bundle({ files: { "pictures/bg.png": file("not a png") } }), /theme\.background\.image: asset_type/],
    ["one picture in two slots", bundle({ files: { "pictures/me.png": file(BG) } }), /a picture holds one slot/],
    ["an unknown theme key", bundle({ files: { "theme.json": file(JSON.stringify({ v: 1, css: "x", background: { image: "pictures/bg.png", fit: "cover", opacity: 0.4 }, avatar: "pictures/me.png" })) } }), /theme\.css: unknown key/],
    ["a bio with 4 line breaks", bundle({ files: { "identity.json": file(JSON.stringify({ bio: "a\nb\nc\nd\ne" })) } }), /identity\.bio/],
    ["identity with an extra key", bundle({ files: { "identity.json": file(JSON.stringify({ tagline: "x", avatar: "y" })) } }), /identity: \{ tagline\?, bio\? \}/],
    ["a widget spec with a list in the chat header", bundle({ files: { "widgets/header.json": file(JSON.stringify({ spec: { v: 1, title: "x", items: [{ type: "list", key: "a" }] }, data: {} })) } }), /widgets\.chat_header\.items\.0\.type/],
    ["a sidebar widget with the instance's cost", bundle({ files: { "widgets/sidebar.json": file(JSON.stringify({ spec: { v: 1, title: "x", items: [{ type: "stat", label: "c", bind: "cost_usd" }] }, data: {} })) } }), /widgets\.sidebar\.items\.0\.bind/],
    ["widget data no item shows", bundle({ files: { "widgets/header.json": file(JSON.stringify({ ...HEADER, data: { other: 1 } })) } }), /widgets\.chat_header\.data\.other/],
    ["custom CSS with @import", bundle({ files: { "css/custom.css": file("@import url(x.css);") } }), /ownerCss\.css: at_rule/],
    ["custom CSS loading from the internet", bundle({ files: { "css/custom.css": file("a { background: url(https://evil/x.png) }") } }), /ownerCss\.css: url/],
    ["custom CSS naming an asset the bundle does not carry", bundle({ files: { "css/custom.css": file(`a { background: url("asset:${"a".repeat(32)}") }`) } }), /ownerCss\.css: unknown_asset/],
    ["a CSS asset that is not a picture or font", bundle({ files: { "css/x.bin": file("MZ...") }, contents: { ownerCss: { css: "css/custom.css", assets: ["css/x.bin"] } } }), /ownerCss\.assets\.css\/x\.bin/],
    ["effects on a fleet without an effect runtime", bundle({ files: { "effects/snow/effect.json": file(JSON.stringify(EFFECT)), "effects/snow/worker.js": file("agend.ready()") }, contents: { effects: ["effects/snow"] } }), /effects_unavailable/],
    ["contents naming nothing", { ...bundle(), manifest: { name: "x", version: "1.0.0", title: "x", contents: {} }, files: {} }, /manifest\.contents: names nothing/],
  ];
  it.each(REFUSED)("refused: %s", (_d, doc, pattern) => {
    const p = problems(doc);
    expect(p.some(x => pattern.test(x)), p.join(" | ")).toBe(true);
  });
  it("8 MiB + 1 byte is refused before it is parsed", () => {
    expect(problems("x".repeat(B.MOD_MAX_BYTES + 1))).toEqual(["root: at most 8 MiB"].map(s => s.replace("root", "")));
  });
  it("custom CSS naming the asset it carries, by the id it will have", () => {
    const font = Buffer.concat([Buffer.from("wOF2"), Buffer.alloc(64, 1)]);
    const sniffOk = (B.checkModBundle(text(bundle({ files: { "css/f.woff2": file(font), "css/custom.css": file("a { color: red }") }, contents: { ownerCss: { css: "css/custom.css", assets: ["css/f.woff2"] } } })), ctx()));
    expect(sniffOk.ok, "an asset no text names is carried (and the plain text passes)").toBe(true);
    if (!sniffOk.ok) return;
    const id = sniffOk.mod.ownerCss!.assets[0]!.id;
    expect(check(bundle({ files: { "css/f.woff2": file(font), "css/custom.css": file(`@font-face { font-family: x; src: url("asset:${id}") }`) }, contents: { ownerCss: { css: "css/custom.css", assets: ["css/f.woff2"] } } })).ok).toBe(true);
  });
  it("a picture asset for the CSS is named by its kept bytes' id", () => {
    const first = check(bundle({ files: { "css/p.png": file(BG) }, contents: { ownerCss: { css: "css/custom.css", assets: ["css/p.png"] } } }));
    expect(first.ok).toBe(true);
    const id = first.ok ? first.mod.ownerCss!.assets[0]!.id : "";
    expect(check(bundle({ files: { "css/p.png": file(BG), "css/custom.css": file(`a { background: url("asset:${id}") }`) }, contents: { ownerCss: { css: "css/custom.css", assets: ["css/p.png"] } } })).ok).toBe(true);
  });
  it("CW1 effects: each entry through the runtime's checker; a theme's placements resolve their params (non-defaults kept)", () => {
    const c = ctx({ effects: B.cw1EffectChecker() });
    const withFx = (placed: unknown) => bundle({ files: {
      "effects/snow/effect.json": file(JSON.stringify(EFFECT)), "effects/snow/worker.js": file("agend.ready()"),
      "theme.json": file(JSON.stringify({ v: 1, accent: "#8b5cf6", background: { image: "pictures/bg.png", fit: "cover", opacity: 0.4 }, avatar: "pictures/me.png", effects: placed })) },
      contents: { effects: ["effects/snow"] } });
    const r = check(withFx([{ effect: "effects/snow", params: { count: 5 } }]), c);
    expect(r.ok, JSON.stringify(!r.ok && r.problems)).toBe(true);
    if (r.ok) {
      expect(r.mod.effects.map(e => [e.path, e.summary.title, e.summary.regions])).toEqual([["effects/snow", "Snow", ["chat"]]]);
      expect(r.mod.theme!.effects).toEqual([{ effect: "effects/snow", params: { count: 5 } }]);
    }
    const d = check(withFx([{ effect: "effects/snow", params: { count: 2 } }]), c);
    expect(d.ok && d.mod.theme!.effects[0]!.params, "a default is not an override").toEqual({});
    expect(problems(withFx([{ effect: "effects/snow", params: { count: 11 } }]), c)).toEqual(["theme.effects.0.params: invalid_params"]);
    expect(problems(withFx([{ effect: "effects/snow", params: { speed: 1 } }]), c)).toEqual(["theme.effects.0.params: invalid_params"]);
    expect(problems(withFx([{ effect: "effects/rain" }]), c)).toEqual(["theme.effects.0: effects/rain is not one of this bundle's effects"]);
    const bad = bundle({ files: { "effects/snow/effect.json": file(JSON.stringify({ ...EFFECT, runtime: "html" })), "effects/snow/worker.js": file("agend.ready()") }, contents: { effects: ["effects/snow"] } });
    expect(problems(bad, c).some(p => p.startsWith("effects.effects/snow/"))).toBe(true);
  });
  it("#2017: a theme may place only effects that play in chat; a non-chat effect may still come as a library entry", () => {
    const c = ctx({ effects: B.cw1EffectChecker() });
    const GLOW = { ...EFFECT, name: "glow", title: "Glow", regions: ["header", "page"] };
    const doc = (placed: unknown) => bundle({ files: {
      "effects/snow/effect.json": file(JSON.stringify(EFFECT)), "effects/snow/worker.js": file("agend.ready()"),
      "effects/glow/effect.json": file(JSON.stringify(GLOW)), "effects/glow/worker.js": file("agend.ready()//glow"),
      "theme.json": file(JSON.stringify({ v: 1, accent: "#8b5cf6", background: { image: "pictures/bg.png", fit: "cover", opacity: 0.4 }, avatar: "pictures/me.png", effects: placed })) },
      contents: { effects: ["effects/snow", "effects/glow"] } });
    const fine = check(doc([{ effect: "effects/snow" }]), c);
    expect(fine.ok, JSON.stringify(!fine.ok && fine.problems)).toBe(true);
    if (fine.ok) expect(fine.mod.effects.map(e => e.path), "the non-chat effect is a library entry").toEqual(["effects/snow", "effects/glow"]);
    const refused = check(doc([{ effect: "effects/snow" }, { effect: "effects/glow" }]), c);
    expect(refused.ok, "the whole mod is refused: nothing to stage or commit").toBe(false);
    expect(problems(doc([{ effect: "effects/snow" }, { effect: "effects/glow" }]), c)).toEqual(["theme.effects.1: effect_region: effects/glow's regions do not include chat"]);
  });
  it("export → import: what a fleet builds, it accepts (and card pictures never travel)", () => {
    const built = buildModBundle({ name: "out", version: "2.0.0", title: "Out" }, {
      theme: { theme: { v: 1, accent: "#8b5cf6", background: { image: "a".repeat(32), fit: "contain", opacity: 0.5 }, card: { tagline: "x", portrait: "b".repeat(32) } }, picture: () => ({ bytes: BG, kind: "png" }) },
      identity: { tagline: "Hello" },
      widgets: { chat_header: HEADER as never, sidebar: SIDEBAR as never },
      ownerCss: { text: "a { color: red }", assets: [] },
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.filename).toBe("out-2.0.0.agendmod.json");
    const r = check(built.text);
    expect(r.ok, JSON.stringify(!r.ok && r.problems)).toBe(true);
    if (r.ok) {
      expect(r.mod.theme!.theme.card).toBeUndefined();
      expect(r.mod.theme!.theme.background).toMatchObject({ fit: "contain", opacity: 0.5 });
      expect(Object.keys(JSON.parse(built.text).files).sort()).toEqual(["css/custom.css", "identity.json", "pictures/background.png", "theme.json", "widgets/chat-header.json", "widgets/sidebar.json"]);
    }
    expect(buildModBundle({ name: "x", version: "1.0.0", title: "x" }, {})).toEqual({ ok: false, error: "nothing_to_export" });
  });
});

/** A fake effect library with CW1's names: records every call; can be told to fail a step. */
function fakeLibrary() {
  const calls: string[] = [];
  const claims = new Set<string>();
  const lib = {
    calls, claims, failCommit: false, failRelease: false, staged: new Map<string, string[]>(),
    stage(entries: readonly ReadonlyMap<string, Uint8Array>[], principal: { kind: string; id: string }, opts: { holder: string }) {
      calls.push(`stage ${principal.kind}:${principal.id} ${opts.holder} ${entries.length}`);
      const id = `s${lib.staged.size}`;
      lib.staged.set(id, entries.map((_, i) => `${String(i).padStart(32, "e")}`.slice(-32)));
      (lib as any).holderOf = opts.holder;
      return { ok: true as const, stageId: id, ids: lib.staged.get(id)! };
    },
    commit(stageId: string) {
      calls.push(`commit ${stageId}`);
      if (lib.failCommit) return { ok: false as const, error: "store_failed" };
      const ids = lib.staged.get(stageId)!;
      const holder = (lib as any).holderOf as string;
      for (const id of ids) claims.add(`${holder}/${id}`);
      return { ok: true as const, ids, created: ids, undo: () => { calls.push(`undo ${stageId}`); for (const id of ids) claims.delete(`${holder}/${id}`); return true; } };
    },
    abort(stageId: string) { calls.push(`abort ${stageId}`); },
    collectUnreferenced(ids: readonly string[]) { calls.push(`collect ${ids.join(",")}`); },
    releaseHolder(holder: string, principal: { kind: string; id: string }) {
      calls.push(`release ${holder} ${principal.kind}:${principal.id}`);
      if (lib.failRelease) return { ok: false as const, error: "reference_provider_failed" };
      const released = [...claims].filter(c => c.startsWith(`${holder}/`));
      for (const c of released) claims.delete(c);
      return { ok: true as const, released: released.map(c => c.split("/")[1]!), undo: () => { for (const c of released) claims.add(c); return true; } };
    },
  };
  return lib;
}

function setup(opts: { effects?: boolean } = {}) {
  const dir = tmp();
  let clock = 1_000_000;
  const themes = new ThemeStore(dir);
  const prefs = new WebPrefsStore(dir, { exists: () => true } as never);
  const css = new OwnerCssStore(dir, prefs);
  const lib = fakeLibrary();
  const known = new Set(["alpha", "beta"]);
  const store = new ModStore(dir, {
    themes, prefs, ownerCss: css, effects: opts.effects ? lib : null,
    context: () => ctx(opts.effects ? { effects: B.cw1EffectChecker() } : {}),
    isKnownInstance: n => known.has(n), prefsIdentity: OPERATOR, clock: () => clock,
  });
  return { dir, themes, prefs, css, lib, store, tick: (ms: number) => { clock += ms; } };
}
const ALL = { theme: true, identity: true, widgets: { chat_header: true, sidebar: true }, ownerCss: true };

describe("stage, then commit", () => {
  it("stage shows the plan in full — the custom CSS's whole text, unverified author, nothing applied yet", () => {
    const s = setup();
    const r = s.store.stage("person:discord:1", text(bundle()));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.items.map(i => i.part)).toEqual(["theme", "identity", "widget", "widget", "ownerCss"]);
    expect(r.plan.items.find(i => i.part === "ownerCss")).toMatchObject({ text: ".chat { letter-spacing: 0.01em; }" });
    expect(r.plan.warnings).toEqual(["owner_css_unchecked: Custom CSS from this file — read it before turning it on."]);
    expect([r.plan.mod.author, r.plan.needs_target, r.plan_hash]).toEqual(["someone", true, expect.stringMatching(/^[0-9a-f]{32}$/)]);
    expect([s.themes.get("alpha").theme, s.store.list().mods]).toEqual([{ v: 1 }, []]);
  });
  it("commit applies exactly the chosen parts to the chosen agent, as a person's; the file is kept, the index written", () => {
    const s = setup();
    const st = s.store.stage("p", text(bundle()));
    if (!st.ok) throw new Error("stage");
    const r = s.store.commit("p", { stage: st.stage, plan_hash: st.plan_hash, include: { theme: true, identity: true, widgets: { chat_header: true } }, target: "alpha" });
    expect(r).toMatchObject({ ok: true, applied: ["theme", "identity", "widget:chat_header"] });
    const rec = s.themes.get("alpha");
    expect([rec.theme.accent, rec.theme.card, rec.by, rec.placements.widgets.chat_header?.by]).toEqual(["#8b5cf6", { tagline: "Reviews fast", bio: "Line one\nLine two" }, "human", "human"]);
    expect(rec.assets.map(a => a.slot).sort()).toEqual(["avatar", "background"]);
    expect(s.themes.asset("alpha", rec.theme.avatar!)?.mime).toBe("image/png");
    expect([s.prefs.read(OPERATOR).values["widget.sidebar"], s.css.state("p").active], "not chosen: not applied").toEqual([undefined, null]);
    const list = s.store.list().mods;
    expect(list).toMatchObject([{ name: "violet", version: "1.0.0", target: "alpha", installedBy: "p", parts: ["theme", "identity", "widget:chat_header"] }]);
    expect(s.store.bundleText(list[0]!.id)).toBe(text(bundle()));
    expect(s.store.staged("p"), "the stage is done").toBeNull();
  });
  it("a widget a mod placed is a person's: the agent may give it values, never replace or remove it (#1894 review)", async () => {
    const s = setup();
    const st = s.store.stage("p", text(bundle()));
    if (!st.ok) throw new Error("stage");
    s.store.commit("p", { stage: st.stage, plan_hash: st.plan_hash, include: { widgets: { chat_header: true } }, target: "alpha" });
    const { WebAppearance } = await import("../src/web-appearance.js");
    const app = new WebAppearance(s.themes, () => null);
    expect(app.handleTool("alpha", "set_web_widget", { slot: "chat_header", spec: HEADER.spec })).toMatchObject({ error: "person_placed" });
    expect(app.handleTool("alpha", "remove_web_widget", { slot: "chat_header" })).toMatchObject({ error: "person_placed" });
    expect(app.handleTool("alpha", "set_web_widget", { slot: "chat_header", data: { tests: 90 } })).toMatchObject({ widget: { by: "human", data: { tests: 90 } } });
  });
  it("the sidebar widget goes to the page's preferences; custom CSS to the person, as a trial", () => {
    const s = setup();
    const st = s.store.stage("p", text(bundle()));
    if (!st.ok) throw new Error("stage");
    const r = s.store.commit("p", { stage: st.stage, plan_hash: st.plan_hash, include: { widgets: { sidebar: true }, ownerCss: true } });
    expect(r).toMatchObject({ ok: true, applied: ["widget:sidebar", "ownerCss"], css: { trial: expect.any(String), sha: expect.any(String), previous: null } });
    expect(s.prefs.read(OPERATOR).values["widget.sidebar"]).toEqual(SIDEBAR);
    expect(s.css.state("p")).toMatchObject({ text: ".chat { letter-spacing: 0.01em; }", pending: { sha: (r as any).css.sha } });
    expect(s.themes.get("alpha").theme, "no target: no instance touched").toEqual({ v: 1 });
  });
  it("the plan must be the staged one: a changed hash is 409; an unknown stage 404; another person's stage is theirs", () => {
    const s = setup();
    const st = s.store.stage("p", text(bundle()));
    if (!st.ok) throw new Error("stage");
    expect(s.store.commit("p", { stage: st.stage, plan_hash: "0".repeat(32), include: ALL, target: "alpha" })).toMatchObject({ ok: false, status: 409, error: "plan_changed" });
    expect(s.store.commit("q", { stage: st.stage, plan_hash: st.plan_hash, include: ALL, target: "alpha" })).toMatchObject({ ok: false, status: 404, error: "unknown_stage" });
    expect(s.store.commit("p", { stage: "x", plan_hash: st.plan_hash, include: ALL, target: "alpha" })).toMatchObject({ status: 404 });
    expect(s.store.commit("p", { stage: st.stage, plan_hash: st.plan_hash, include: { theme: "yes" }, target: "alpha" })).toMatchObject({ status: 400, error: "include" });
    expect(s.store.commit("p", { stage: st.stage, plan_hash: st.plan_hash, include: { theme: true }, target: "ghost" })).toMatchObject({ status: 400, error: "target" });
    expect(s.store.commit("p", { stage: st.stage, plan_hash: st.plan_hash, include: {} })).toMatchObject({ status: 400, error: "include" });
    expect(s.themes.get("alpha").theme).toEqual({ v: 1 });
  });
  it("a stage lasts 10 minutes (monotonic); a new one replaces the person's; abort drops it", () => {
    const s = setup();
    const a = s.store.stage("p", text(bundle()));
    if (!a.ok) throw new Error("stage");
    s.tick(MOD_STAGE_MS + 1);
    expect(s.store.commit("p", { stage: a.stage, plan_hash: a.plan_hash, include: ALL, target: "alpha" })).toMatchObject({ status: 404, error: "unknown_stage" });
    const b = s.store.stage("p", text(bundle())), c = s.store.stage("p", text(bundle()));
    if (!b.ok || !c.ok) throw new Error("stage");
    expect(s.store.staged("p")?.stage).toBe(c.stage);
    expect(s.store.abort("p", b.stage)).toMatchObject({ status: 404 });
    expect(s.store.abort("p", c.stage)).toEqual({ ok: true });
    expect(s.store.staged("p")).toBeNull();
  });
  it("a failure mid-commit restores every store: theme record, pictures, preferences, custom CSS assets, effects", () => {
    const s = setup({ effects: true });
    s.themes.setTheme("alpha", { v: 1, font: "inter" }, "agent");
    s.prefs.write(OPERATOR, new Map([["widget.sidebar", { spec: { v: 1, title: "Mine", items: [{ type: "stat", label: "Idle", bind: "fleet.idle" }] }, data: {} }]]));
    const before = { theme: s.themes.get("alpha"), prefs: s.prefs.read(OPERATOR).values["widget.sidebar"], files: readdirSync(s.dir) };
    const doc = bundle({ files: { "effects/snow/effect.json": file(JSON.stringify(EFFECT)), "effects/snow/worker.js": file("agend.ready()"), "css/p.png": file(png(2, 2, [1, 2, 3])) },
      contents: { effects: ["effects/snow"], ownerCss: { css: "css/custom.css", assets: ["css/p.png"] } } });
    const st = s.store.stage("p", text(doc));
    if (!st.ok) throw new Error(JSON.stringify(st));
    vi.spyOn(s.css, "save").mockReturnValue({ ok: false, status: 503, error: "prefs_unwritable" });
    const r = s.store.commit("p", { stage: st.stage, plan_hash: st.plan_hash, include: { ...ALL, effects: true }, target: "alpha" });
    expect(r).toMatchObject({ ok: false, status: 503, error: "prefs_unwritable" });
    expect(s.themes.get("alpha")).toEqual(before.theme);
    expect(readdirSync(join(s.dir, "web-themes")).flatMap(d => readdirSync(join(s.dir, "web-themes", d))), "the import's pictures are gone").toEqual([]);
    expect(s.prefs.read(OPERATOR).values["widget.sidebar"]).toEqual(before.prefs);
    expect(s.css.state("p").assets, "the CSS asset it added is gone").toEqual([]);
    expect(s.lib.calls.filter(c => c.startsWith("undo")), "the effect claim undone").toEqual(["undo s0"]);
    expect([s.store.list().mods, existsSync(join(s.dir, "web-mods"))]).toEqual([[], false]);
  });
  it("an index that can't be written: everything undone, the bundle file removed", () => {
    const s = setup();
    const st = s.store.stage("p", text(bundle()));
    if (!st.ok) throw new Error("stage");
    mkdirSync(join(s.dir, "web-mods.json"));                                    // a directory: the write fails
    const r = s.store.commit("p", { stage: st.stage, plan_hash: st.plan_hash, include: ALL, target: "alpha" });
    expect(r).toMatchObject({ ok: false, status: 503, error: "mods_write_failed" });
    expect([s.themes.get("alpha").theme, s.prefs.read(OPERATOR).values["widget.sidebar"], s.css.state("p").active]).toEqual([{ v: 1 }, undefined, null]);
    expect(readdirSync(join(s.dir, "web-mods"))).toEqual([]);
  });
  it("card text from a mod keeps the card's pictures (identity is text only)", () => {
    const s = setup();
    const portrait = s.themes.addAsset("alpha", "portrait", png(6, 9, [1, 1, 1]));
    if (!portrait.ok) throw new Error("asset");
    s.themes.setTheme("alpha", { v: 1, card: { portrait: portrait.id, tagline: "Old" } }, "agent");
    const st = s.store.stage("p", text(bundle()));
    if (!st.ok) throw new Error("stage");
    s.store.commit("p", { stage: st.stage, plan_hash: st.plan_hash, include: { identity: true }, target: "alpha" });
    expect(s.themes.get("alpha").theme.card).toEqual({ portrait: portrait.id, tagline: "Reviews fast", bio: "Line one\nLine two" });
  });
  it("pictures the import replaced go only once all of it held", () => {
    const s = setup();
    const old = s.themes.addAsset("alpha", "background", png(3, 3, [9, 9, 9]));
    if (!old.ok) throw new Error("asset");
    s.themes.setTheme("alpha", { v: 1, background: { image: old.id, fit: "cover", opacity: 1 } }, "agent");
    const st = s.store.stage("p", text(bundle()));
    if (!st.ok) throw new Error("stage");
    const files = () => readdirSync(join(s.dir, "web-themes")).flatMap(d => readdirSync(join(s.dir, "web-themes", d)));
    expect(files()).toContain(`${old.id}.png`);
    expect(s.store.commit("p", { stage: st.stage, plan_hash: st.plan_hash, include: { theme: true }, target: "alpha" })).toMatchObject({ ok: true });
    expect([s.themes.asset("alpha", old.id), s.themes.get("alpha").assets.some(a => a.id === old.id)]).toEqual([null, false]);
    expect(files(), "the replaced picture's file is deleted once the import held").not.toContain(`${old.id}.png`);
  });
  it("custom CSS and the sidebar widget are never applied unless ticked (a plan without them: nothing of the person changes)", () => {
    const s = setup();
    const st = s.store.stage("p", text(bundle()));
    if (!st.ok) throw new Error("stage");
    s.store.commit("p", { stage: st.stage, plan_hash: st.plan_hash, include: { theme: true }, target: "alpha" });
    expect([s.css.state("p").versions, s.prefs.read(OPERATOR).values["widget.sidebar"]]).toEqual([[], undefined]);
  });
});

describe("#1897 review: commit checks the state it was consented for, and undoes everything", () => {
  it("the 20-mod cap holds at commit, not only at stage (21 people stage 21 mods first)", () => {
    const s = setup();
    const staged = Array.from({ length: 21 }, (_, i) => { const r = s.store.stage(`p${i}`, text(bundle({ manifest: { name: `m${i}` } }))); if (!r.ok) throw new Error("stage"); return r; });
    staged.slice(0, 20).forEach((st, i) => expect(s.store.commit(`p${i}`, { stage: st.stage, plan_hash: st.plan_hash, include: { identity: true }, target: "alpha" }).ok, `#${i}`).toBe(true));
    expect(s.store.commit("p20", { stage: staged[20]!.stage, plan_hash: staged[20]!.plan_hash, include: { identity: true }, target: "alpha" })).toMatchObject({ ok: false, status: 409, error: "mods_quota" });
    expect(s.store.list().mods).toHaveLength(20);
  });
  it("two people replacing the same version: the second finds the plan changed (it would replace another version now)", () => {
    const s = setup();
    const v1 = s.store.stage("p", text(bundle()));
    if (!v1.ok) throw new Error("stage");
    s.store.commit("p", { stage: v1.stage, plan_hash: v1.plan_hash, include: { identity: true }, target: "alpha" });
    const v2 = s.store.stage("P", text(bundle({ manifest: { version: "2.0.0" } }))), v3 = s.store.stage("Q", text(bundle({ manifest: { version: "3.0.0" } })));
    if (!v2.ok || !v3.ok) throw new Error("stage");
    expect(s.store.commit("P", { stage: v2.stage, plan_hash: v2.plan_hash, include: { identity: true, replace: true }, target: "alpha" })).toMatchObject({ ok: true });
    expect(s.store.commit("Q", { stage: v3.stage, plan_hash: v3.plan_hash, include: { identity: true, replace: true }, target: "alpha" })).toMatchObject({ ok: false, status: 409, error: "plan_changed" });
    expect(s.store.list().mods.map(m => m.version)).toEqual(["2.0.0"]);
  });
  it("two people installing two versions of a new name: the second must review it as a replacement", () => {
    const s = setup();
    const a = s.store.stage("P", text(bundle({ manifest: { version: "1.0.0" } }))), b = s.store.stage("Q", text(bundle({ manifest: { version: "1.1.0" } })));
    if (!a.ok || !b.ok) throw new Error("stage");
    expect(s.store.commit("P", { stage: a.stage, plan_hash: a.plan_hash, include: { identity: true }, target: "alpha" }).ok).toBe(true);
    expect(s.store.commit("Q", { stage: b.stage, plan_hash: b.plan_hash, include: { identity: true }, target: "alpha" })).toMatchObject({ ok: false, status: 409, error: "plan_changed" });
    const again = s.store.stage("Q", text(bundle({ manifest: { version: "1.1.0" } })));
    expect(again.ok && again.plan.mod.replaces?.version).toBe("1.0.0");
  });
  it("a participant that throws (a real filesystem failure) is undone like one that answers an error", () => {
    const s = setup();
    s.themes.setTheme("alpha", { v: 1, card: { tagline: "Before" } }, "agent");
    writeFileSync(join(s.dir, "web-owner-css"), "not a directory");                 // the CSS store can't write: ENOTDIR
    const st = s.store.stage("p", text(bundle()));
    if (!st.ok) throw new Error("stage");
    const r = s.store.commit("p", { stage: st.stage, plan_hash: st.plan_hash, include: { identity: true, ownerCss: true }, target: "alpha" });
    expect(r).toMatchObject({ ok: false, status: 503, error: "mod_apply_failed" });
    expect([s.themes.get("alpha").theme.card, s.store.list().mods]).toEqual([{ tagline: "Before" }, []]);
  });
  it("custom CSS undo restores what was there: a trial already running, and a kept version (controls)", () => {
    for (const keptBefore of [false, true]) {
      const s = setup();
      const blue = s.css.save("p", "a { color: blue }");
      if (!blue.ok) throw new Error("save");
      if (keptBefore) expect(s.css.keep("p", blue.trial).ok).toBe(true);
      const before = s.css.state("p");
      const st = s.store.stage("p", text(bundle({ files: { "css/custom.css": file("a { color: red }") } })));
      if (!st.ok) throw new Error("stage");
      mkdirSync(join(s.dir, "web-mods.json"));                                        // the final index write fails
      expect(s.store.commit("p", { stage: st.stage, plan_hash: st.plan_hash, include: { ownerCss: true } })).toMatchObject({ ok: false, status: 503 });
      const after = s.css.state("p");
      expect([after.active, after.text, after.pending?.id ?? null, after.versions.map(v => v.sha)], keptBefore ? "kept" : "on trial").toEqual([before.active, "a { color: blue }", before.pending?.id ?? null, before.versions.map(v => v.sha)]);
    }
  });
});

describe("effects, replace and uninstall (the library under the mod's own holder)", () => {
  const fx = (version = "1.0.0", worker = "agend.ready()") => bundle({ manifest: { version }, files: { "effects/snow/effect.json": file(JSON.stringify(EFFECT)), "effects/snow/worker.js": file(worker),
    "theme.json": file(JSON.stringify({ v: 1, accent: "#8b5cf6", background: { image: "pictures/bg.png", fit: "cover", opacity: 0.4 }, avatar: "pictures/me.png", effects: [{ effect: "effects/snow", params: { count: 4 } }] })) },
    contents: { effects: ["effects/snow"] } });
  it("staged under the person and the mod's holder; committed; placed with its overrides on the target", () => {
    const s = setup({ effects: true });
    const st = s.store.stage("p", text(fx()));
    if (!st.ok) throw new Error(JSON.stringify(st));
    const id = st.plan.mod.id;
    expect(s.lib.calls).toEqual([`stage human:p ${modHolder(id)} 1`]);
    expect(s.store.commit("p", { stage: st.stage, plan_hash: st.plan_hash, include: { theme: false, effects: false }, target: "alpha" })).toMatchObject({ status: 400 });
    expect(s.store.commit("p", { stage: st.stage, plan_hash: st.plan_hash, include: { theme: true }, target: "alpha" }), "the theme places effects: effects must come too").toMatchObject({ status: 400, error: "include" });
    const r = s.store.commit("p", { stage: st.stage, plan_hash: st.plan_hash, include: { theme: true, effects: true }, target: "alpha" });
    expect(r).toMatchObject({ ok: true, applied: ["effects", "theme"] });
    expect(s.themes.get("alpha").placements.effects).toMatchObject([{ id: s.lib.staged.get("s0")![0], by: "human", params: { count: 4 } }]);
    expect(s.store.list().mods[0]).toMatchObject({ effects: [{ path: "effects/snow", id: s.lib.staged.get("s0")![0] }], created: s.lib.staged.get("s0") });
  });
  it("staged effects not chosen are let go (abort)", () => {
    const s = setup({ effects: true });
    const st = s.store.stage("p", text(fx()));
    if (!st.ok) throw new Error("stage");
    s.store.commit("p", { stage: st.stage, plan_hash: st.plan_hash, include: { identity: true }, target: "alpha" });
    expect(s.lib.calls.slice(1)).toEqual(["abort s0"]);
  });
  it("another version of an installed name: replace must be confirmed; then the old one's holder is released, its file gone", () => {
    const s = setup({ effects: true });
    const a = s.store.stage("p", text(fx("1.0.0")));
    if (!a.ok) throw new Error("stage");
    s.store.commit("p", { stage: a.stage, plan_hash: a.plan_hash, include: { theme: true, effects: true }, target: "alpha" });
    const oldId = a.plan.mod.id;
    const b = s.store.stage("p", text(fx("1.1.0", "agend.ready();")));
    if (!b.ok) throw new Error("stage");
    expect(b.plan.mod.replaces).toEqual({ id: oldId, version: "1.0.0" });
    expect(s.store.commit("p", { stage: b.stage, plan_hash: b.plan_hash, include: { effects: true } })).toMatchObject({ status: 409, error: "replaces" });
    expect(s.store.commit("p", { stage: b.stage, plan_hash: b.plan_hash, include: { effects: true, replace: true } })).toMatchObject({ ok: true });
    expect(s.store.list().mods.map(m => m.version)).toEqual(["1.1.0"]);
    expect(s.lib.calls).toContain(`release ${modHolder(oldId)} human:p`);
    expect(s.lib.calls.at(-1)).toBe(`collect ${s.lib.staged.get("s0")!.join(",")}`);
    expect(s.store.bundleText(oldId)).toBeNull();
  });
  it("replace: the old holder is released last; refused, every store is restored first and then the new commit undone", () => {
    const s = setup({ effects: true });
    const a = s.store.stage("p", text(fx("1.0.0")));
    if (!a.ok) throw new Error("stage");
    s.store.commit("p", { stage: a.stage, plan_hash: a.plan_hash, include: { theme: true, effects: true }, target: "alpha" });
    const before = { theme: s.themes.get("alpha"), list: s.store.list().mods };
    const b = s.store.stage("p", text(fx("1.1.0", "agend.ready();")));
    if (!b.ok) throw new Error("stage");
    s.lib.failRelease = true;
    s.lib.calls.length = 0;
    expect(s.store.commit("p", { stage: b.stage, plan_hash: b.plan_hash, include: { theme: true, effects: true, replace: true }, target: "alpha" })).toMatchObject({ ok: false, status: 409, error: "effects_release_refused" });
    expect(s.lib.calls, "commit first, release last, then the commit undone").toEqual(["commit s1", `release ${modHolder(a.plan.mod.id)} human:p`, "undo s1"]);
    expect([s.themes.get("alpha"), s.store.list().mods]).toEqual([before.theme, before.list]);
    expect(s.store.bundleText(b.plan.mod.id), "the new file is gone").toBeNull();
    expect(s.store.bundleText(a.plan.mod.id), "the old one stays").not.toBeNull();
  });
  it("a reviewed proposal whose replace is refused at the release stays proposed (the index is restored whole)", () => {
    const s = setup({ effects: true });
    const a = s.store.stage("p", text(fx("1.0.0")));
    if (!a.ok) throw new Error("stage");
    s.store.commit("p", { stage: a.stage, plan_hash: a.plan_hash, include: { effects: true } });
    const agentFile = (() => { const d = fx("1.1.0", "agend.ready();") as any; delete d.manifest.contents.ownerCss; delete d.files["css/custom.css"]; return text(d); })();
    const next = B.checkModBundle(agentFile, ctx({ effects: B.cw1EffectChecker() }));
    if (!next.ok) throw new Error(JSON.stringify(next.problems));
    expect(s.store.propose("alpha", agentFile, next.mod)).toMatchObject({ ok: true });
    const b = s.store.stageProposal("p", "alpha");
    if (!b.ok) throw new Error("stage");
    s.lib.failRelease = true;
    expect(s.store.commit("p", { stage: b.stage, plan_hash: b.plan_hash, include: { effects: true, replace: true } })).toMatchObject({ ok: false, error: "effects_release_refused" });
    expect(s.store.proposals().map(p => p.version)).toEqual(["1.1.0"]);
    expect(s.store.stageProposal("p", "alpha").ok, "and can be opened again").toBe(true);
  });
  it("uninstall releases only this mod's holder, removes its file and entry, and leaves what it applied", () => {
    const s = setup({ effects: true });
    const st = s.store.stage("p", text(fx()));
    if (!st.ok) throw new Error("stage");
    s.store.commit("p", { stage: st.stage, plan_hash: st.plan_hash, include: { theme: true, effects: true }, target: "alpha" });
    const id = st.plan.mod.id;
    const r = s.store.uninstall(id);
    expect(r).toMatchObject({ ok: true, released: s.lib.staged.get("s0") });
    expect(s.lib.calls.at(-1), "the released ids go to the guarded collector, after the write").toBe(`collect ${s.lib.staged.get("s0")!.join(",")}`);
    expect([s.store.list().mods, s.store.bundleText(id), s.themes.get("alpha").theme.accent]).toEqual([[], null, "#8b5cf6"]);
    expect(s.store.uninstall(id)).toMatchObject({ status: 404 });
  });
  it("a release the library refuses: nothing changes (the mod stays installed)", () => {
    const s = setup({ effects: true });
    const st = s.store.stage("p", text(fx()));
    if (!st.ok) throw new Error("stage");
    s.store.commit("p", { stage: st.stage, plan_hash: st.plan_hash, include: { effects: true } });
    s.lib.failRelease = true;
    expect(s.store.uninstall(st.plan.mod.id)).toMatchObject({ ok: false, status: 409, error: "effects_release_refused" });
    expect(s.store.list().mods).toHaveLength(1);
    expect(s.lib.calls.some(c => c.startsWith("collect")), "nothing collected when nothing was released").toBe(false);
  });
  it("an index write that fails after a release puts the release back", () => {
    const s = setup({ effects: true });
    const st = s.store.stage("p", text(fx()));
    if (!st.ok) throw new Error("stage");
    s.store.commit("p", { stage: st.stage, plan_hash: st.plan_hash, include: { effects: true } });
    const claims = [...s.lib.claims];
    rmSync(join(s.dir, "web-mods.json")); mkdirSync(join(s.dir, "web-mods.json"));
    expect(s.store.uninstall(st.plan.mod.id)).toMatchObject({ ok: false, status: 503 });
    expect([...s.lib.claims]).toEqual(claims);
  });
  it("limits: 20 installed; an unreadable index refuses every write", () => {
    const s = setup();
    for (let i = 0; i < 20; i++) {
      const st = s.store.stage("p", text(bundle({ manifest: { name: `m${i}` } })));
      if (!st.ok) throw new Error(JSON.stringify(st));
      expect(s.store.commit("p", { stage: st.stage, plan_hash: st.plan_hash, include: { identity: true }, target: "alpha" })).toMatchObject({ ok: true });
    }
    expect(s.store.stage("p", text(bundle({ manifest: { name: "m20" } })))).toMatchObject({ ok: false, status: 409, error: "mods_quota" });
    const t = setup();
    mkdirSync(join(t.dir, "web-mods.json"));
    expect(t.store.stage("p", text(bundle()))).toMatchObject({ ok: false, status: 503, error: "mods_unreadable" });
    expect(t.store.list()).toMatchObject({ mods: [], unreadable: true });
  });
  it("the plan names which installed mod a bundle would replace, and whether this very one is installed", () => {
    const installed = new Map([["a".repeat(32), { name: "violet", version: "0.9.0" } as never]]);
    const r = check(bundle());
    if (!r.ok) throw new Error("check");
    expect(modPlan(r.mod, installed).mod).toMatchObject({ installed: false, replaces: { id: "a".repeat(32), version: "0.9.0" } });
  });
});

describe("the routes", () => {
  interface Res { status: number; headers: Record<string, string | string[] | undefined>; body: string }
  const raw = (port: number, method: string, path: string, headers: Record<string, string> = {}, body?: string) => new Promise<Res>((resolve, reject) => {
    const r = request({ host: "127.0.0.1", port, method, path, headers }, res => {
      const chunks: Buffer[] = []; res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    r.on("error", reject); if (body !== undefined) r.write(body); r.end();
  });
  async function fleet() {
    const { FleetManager } = await import("../src/fleet-manager.js");
    const { csrfTokenFor, tokenEpoch } = await import("../src/web-session.js");
    const dir = tmp();
    const fm = new FleetManager(dir) as any;
    const quiet = () => {};
    fm.logger = { info: quiet, warn: quiet, error: quiet, debug: quiet, trace: quiet, fatal: quiet, child: () => fm.logger };
    vi.spyOn(fm, "notifyFleetError").mockImplementation(() => true);
    fm.fleetConfig = { instances: { alpha: { working_directory: "/tmp" } }, defaults: {} };
    fm.initializeWebAuthTokens(); fm.startHealthServer(0);
    await vi.waitFor(() => expect(fm.getDashboardAccess().ready).toBe(true));
    const port = ((fm.healthServer as Server).address() as { port: number }).port, origin = `http://127.0.0.1:${port}`;
    const session = (tier: "admin" | "read" = "admin", userId = "42") => {
      const { sessionId } = fm.webSessions.create({ tier, surface: "local", label: "t", tokenEpoch: tokenEpoch(fm.webToken), owner: { adapterId: "discord", userId } });
      const cookie = `agend_session=${sessionId}`;
      return { read: { cookie }, write: { cookie, origin, "x-agend-csrf": csrfTokenFor(sessionId), "content-type": "application/json" } };
    };
    const stop = () => new Promise<void>(r => (fm.healthServer as Server).close(() => r()));
    return { fm, port, session, stop, csrfTokenFor, tokenEpoch };
  }
  it("stage → commit → list → file → export → re-import, from an admin session", async () => {
    const f = await fleet();
    try {
      const admin = f.session("admin").write;
      const st = await raw(f.port, "POST", "/ui/mods/stage", admin, text(bundle()));
      expect(st.status, st.body).toBe(200);
      const staged = JSON.parse(st.body);
      expect(JSON.parse((await raw(f.port, "GET", "/ui/mods", f.session("read", "43").read)).body), "another person: no stage of theirs").toMatchObject({ mods: [], staged: null });
      expect(JSON.parse((await raw(f.port, "GET", "/ui/mods", f.session("read").read)).body).staged, "the same person on another device sees theirs").toMatchObject({ stage: staged.stage });
      const c = await raw(f.port, "POST", "/ui/mods/commit", admin, JSON.stringify({ stage: staged.stage, plan_hash: staged.plan_hash, include: { theme: true, identity: true, widgets: { chat_header: true } }, target: "alpha" }));
      expect(c.status, c.body).toBe(200);
      const list = JSON.parse((await raw(f.port, "GET", "/ui/mods", f.session().read)).body);
      expect(list.mods).toMatchObject([{ name: "violet", target: "alpha" }]);
      const dl = await raw(f.port, "GET", `/ui/mods/file/${list.mods[0].id}`, f.session().read);
      expect([dl.status, dl.headers["content-disposition"], dl.body]).toEqual([200, 'attachment; filename="violet-1.0.0.agendmod.json"', text(bundle())]);
      const ex = await raw(f.port, "POST", "/ui/mods/export", admin, JSON.stringify({ instance: "alpha", name: "again", version: "1.0.1", title: "Again", include: { theme: true, identity: true, widgets: { chat_header: true } } }));
      expect([ex.status, ex.headers["content-disposition"]]).toEqual([200, 'attachment; filename="again-1.0.1.agendmod.json"']);
      const back = B.checkModBundle(ex.body, ctx());
      expect(back.ok, ex.body.slice(0, 300)).toBe(true);
      if (back.ok) expect([back.mod.theme!.theme.accent, back.mod.identity, Object.keys(back.mod.widgets)]).toEqual(["#8b5cf6", { tagline: "Reviews fast", bio: "Line one\nLine two" }, ["chat_header"]]);
      const un = await raw(f.port, "POST", "/ui/mods/uninstall", admin, JSON.stringify({ id: list.mods[0].id }));
      expect([un.status, f.fm.mods.list().mods]).toEqual([200, []]);
    } finally { await f.stop(); }
  }, 30_000);
  it("export uses the importer's title rule: U+034F alone is refused (400), a plain title round-trips (#1897 review)", async () => {
    const f = await fleet();
    try {
      f.fm.themeStore.setTheme("alpha", { v: 1, accent: "#8b5cf6" }, "agent");
      const go = (title: string) => raw(f.port, "POST", "/ui/mods/export", f.session().write, JSON.stringify({ instance: "alpha", name: "t", version: "1.0.0", title, include: { theme: true } }));
      const bad = await go("\u034f");
      expect([bad.status, JSON.parse(bad.body).error]).toEqual([400, "title"]);
      const ok = await go("Night");
      expect([ok.status, B.checkModBundle(ok.body, ctx()).ok]).toEqual([200, true]);
    } finally { await f.stop(); }
  }, 30_000);
  it("an agent's proposal over HTTP: listed, opened into a plan as this person's, dismissed (#1906 review)", async () => {
    const f = await fleet();
    try {
      const agentFile = (() => { const d = bundle() as any; delete d.manifest.contents.ownerCss; delete d.files["css/custom.css"]; return text(d); })();
      expect(f.fm.agentMods.handle("alpha", "propose_web_mod", { data_b64: Buffer.from(agentFile).toString("base64") })).toHaveProperty("proposed");
      expect(JSON.parse((await raw(f.port, "GET", "/ui/mods", f.session().read)).body).proposals).toMatchObject([{ instance: "alpha", name: "violet" }]);
      const st = await raw(f.port, "POST", "/ui/mods/proposal/stage", f.session().write, JSON.stringify({ instance: "alpha" }));
      expect([st.status, JSON.parse(st.body).plan.mod.name]).toEqual([200, "violet"]);
      expect((await raw(f.port, "POST", "/ui/mods/proposal/dismiss", f.session("read").write, JSON.stringify({ instance: "alpha" }))).status, "read-only").toBe(403);
      expect((await raw(f.port, "POST", "/ui/mods/proposal/dismiss", f.session().write, JSON.stringify({ instance: "alpha" }))).status).toBe(200);
      expect(f.fm.mods.proposals()).toEqual([]);
    } finally { await f.stop(); }
  }, 30_000);
  it("a read-only session can't write; the CLI's header token can't reach mods at all; anonymous 401", async () => {
    const f = await fleet();
    try {
      expect((await raw(f.port, "POST", "/ui/mods/stage", f.session("read").write, text(bundle()))).status).toBe(403);
      const token = { "x-agend-token": f.fm.getDashboardAccess().token, "content-type": "application/json" };
      const t = await raw(f.port, "POST", "/ui/mods/stage", token, text(bundle()));
      expect([t.status, JSON.parse(t.body).error]).toEqual([403, "mods_need_a_signed_in_session"]);
      expect((await raw(f.port, "GET", "/ui/mods", token)).status).toBe(403);
      expect((await raw(f.port, "GET", "/ui/mods")).status).toBe(401);
      const big = await raw(f.port, "POST", "/ui/mods/stage", { ...f.session().write, "content-length": String(B.MOD_MAX_BYTES + 1) }, "x".repeat(B.MOD_MAX_BYTES + 1));
      expect([big.status, JSON.parse(big.body).error]).toEqual([413, "mod_too_large"]);
    } finally { await f.stop(); }
  }, 30_000);
  it("the public link: no mod route on its manifest, and the handler refuses on its own", async () => {
    const { isPublicWebRoute } = await import("../src/public-web-gateway.js");
    const { handleWebRequest } = await import("../src/web-api.js");
    const { bindGatewayRequest } = await import("../src/web-request-context.js");
    for (const [m, p] of [["GET", "/ui/mods"], ["POST", "/ui/mods/stage"], ["POST", "/ui/mods/commit"], ["POST", "/ui/mods/uninstall"], ["POST", "/ui/mods/export"], ["GET", `/ui/mods/file/${"a".repeat(32)}`]] as const) {
      expect(isPublicWebRoute(m, p), `${m} ${p}`).toBe(false);
    }
    const f = await fleet();
    try {
      const { sessionId } = f.fm.webSessions.create({ tier: "admin", surface: "gateway", exposureId: "e".repeat(32), label: "t", tokenEpoch: f.tokenEpoch(f.fm.webToken) });
      for (const [method, path] of [["POST", "/ui/mods/stage"], ["GET", "/ui/mods"]] as const) {
        const status = await new Promise<number>(resolve => {
          let code = 0;
          const res: any = { headersSent: false, setHeader() {}, writeHead(c: number) { code = c; res.headersSent = true; return res; }, end() { resolve(code); } };
          const req = Object.assign(new EventEmitter(), { method, url: path, headers: { host: "x.trycloudflare.com", cookie: `__Host-agend_session=${sessionId}`, origin: "https://x.trycloudflare.com", "x-agend-csrf": f.csrfTokenFor(sessionId), "content-type": "application/json" }, destroy() {}, resume() {} });
          bindGatewayRequest(req, { surface: "gateway", exposureId: "e".repeat(32), expectedOrigin: "https://x.trycloudflare.com", isCurrent: () => true });
          expect(handleWebRequest(req as never, res, new URL(`https://x.trycloudflare.com${path}`), f.fm)).toBe(true);
        });
        expect(status, `${method} ${path}`).toBe(method === "GET" ? 404 : 403);
      }
    } finally { await f.stop(); }
  }, 30_000);
});

describe("the page: the Mods card", () => {
  it("an answer of another shape is \"couldn't load\", never a crash (#1897 CI: a {} answer)", async () => {
    const { page, settle } = await import("./helpers/app-harness.js");
    vi.resetModules();
    const pg = page({ url: "http://127.0.0.1:19280/settings/appearance" });
    try {
      const answers: unknown[] = [{}, { mods: "x" }, null, { mods: [], staged: { stage: 1 } }];
      vi.stubGlobal("fetch", async () => { const body = answers.shift(); return { ok: true, status: 200, json: async () => body }; });
      const P = await import("/assets/app-html.js");
      const { ModsCard } = await import("/ui/js/settings-mods.js");
      for (const expected of ["Couldn't load", "Couldn't load", "Couldn't load", "No mods installed."]) {
        P.render(null, pg.root); P.render(P.h(ModsCard, {}), pg.root); await settle(); await settle();
        expect(pg.root.textContent, expected).toContain(expected);
      }
    } finally { vi.unstubAllGlobals(); pg.restore(); }
  });
});

describe("the page: a plan's choices belong to its stage (#1897 review)", () => {
  const planOf = (stage: string, css = true) => ({ stage, plan_hash: `h-${stage}`, plan: { mod: { id: stage.repeat(32).slice(0, 32), name: `m-${stage}`, version: "1.0.0", title: `Mod ${stage}`, bytes: 10, installed: false },
    items: [{ part: "identity", tagline: "x" }, ...(css ? [{ part: "ownerCss", text: `/* ${stage} */`, assets: [] }] : [])], needs_target: true, warnings: [] } });
  async function mountCard(script: (url: string, body: string) => { status?: number; body: unknown }) {
    const { page, settle } = await import("./helpers/app-harness.js");
    vi.resetModules();
    const pg = page({ url: "http://127.0.0.1:19280/settings/appearance" });
    const calls: Array<[string, string]> = [];
    vi.stubGlobal("fetch", async (url: string, init: { body?: string } = {}) => { calls.push([url, init.body ?? ""]); const r = script(url, init.body ?? ""); return { ok: (r.status ?? 200) < 400, status: r.status ?? 200, json: async () => r.body }; });
    const P = await import("/assets/app-html.js");
    const { appStore } = await import("/assets/app-store.js");
    appStore.set({ instances: [{ name: "alpha", status: "running" }], exec: { alpha: "working" }, awaiting: {} });
    const { ModsCard } = await import("/ui/js/settings-mods.js");
    const { Toasts } = await import("/assets/ui-toast.js");
    P.render(P.h("div", null, P.h(ModsCard, {}), P.h(Toasts, {})), pg.root); await settle(); await settle();
    const tickCss = () => { const box = [...pg.root.querySelectorAll(".s-mod-tick")].find((l: any) => l.textContent.includes("Custom CSS"))!.querySelector("input") as any; box.checked = true; box.dispatchEvent(new (globalThis as any).Event("change", { bubbles: true })); };
    const cssTicked = () => ([...pg.root.querySelectorAll(".s-mod-tick")].find((l: any) => l.textContent.includes("Custom CSS"))!.querySelector("input") as any).checked;
    return { pg, settle, calls, tickCss, cssTicked };
  }
  it("a stage replaced on another device: a failed Cancel says so; the new stage starts unticked, and Install never carries the old consent", async () => {
    let staged = planOf("a");
    const t = await mountCard((url) => url === "/ui/mods" ? { body: { mods: [], staged, proposals: [] } } : url === "/ui/mods/abort" ? { status: 404, body: { error: "unknown_stage" } } : { body: { id: "x", applied: [] } });
    try {
      t.tickCss(); await t.settle();
      expect(t.cssTicked()).toBe(true);
      staged = planOf("b");                                                    // device B staged another file meanwhile
      (t.pg.root.querySelector(".s-mod-plan .btn:not(.btn-primary)") as any).click(); await t.settle(); await t.settle();
      expect(t.pg.root.querySelector(".s-mod-plan h4")!.textContent).toContain("Mod b");
      expect(t.cssTicked(), "B's custom CSS is not ticked").toBe(false);
      expect(t.pg.root.textContent).toContain("That import was replaced");
      const sel = t.pg.root.querySelector(".s-mod-plan select") as any; sel.value = "alpha"; sel.dispatchEvent(new (globalThis as any).Event("change", { bubbles: true })); await t.settle();
      (t.pg.root.querySelector(".s-mod-plan .btn-primary") as any).click(); await t.settle();
      const commit = t.calls.find(([u]) => u === "/ui/mods/commit")!;
      expect(JSON.parse(commit[1])).toMatchObject({ stage: "b", include: { ownerCss: false } });
    } finally { vi.unstubAllGlobals(); t.pg.restore(); }
  });
  it("control: an Install the host refuses for another reason keeps this stage's choices", async () => {
    const t = await mountCard((url) => url === "/ui/mods" ? { body: { mods: [], staged: planOf("a"), proposals: [] } } : { status: 400, body: { error: "target" } });
    try {
      t.tickCss(); await t.settle();
      const sel = t.pg.root.querySelector(".s-mod-plan select") as any; sel.value = "alpha"; sel.dispatchEvent(new (globalThis as any).Event("change", { bubbles: true })); await t.settle();
      (t.pg.root.querySelector(".s-mod-plan .btn-primary") as any).click(); await t.settle(); await t.settle();
      expect([t.cssTicked(), t.calls.filter(([u]) => u === "/ui/mods").length]).toEqual([true, 1]);
    } finally { vi.unstubAllGlobals(); t.pg.restore(); }
  });
  it("the theme is shown whole: both palettes, bubbles, label, background fit and opacity, the pictures themselves, effect placements", async () => {
    const { page, settle } = await import("./helpers/app-harness.js");
    vi.resetModules();
    const pg = page({ url: "http://127.0.0.1:19280/settings/appearance" });
    try {
      const P = await import("/assets/app-html.js");
      await import("/ui/js/settings-strings.js");
      const { ThemeDetail } = await import("/ui/js/settings-mods.js");
      const BG = "b".repeat(32), AV = "c".repeat(32);
      P.render(P.h(ThemeDetail, { theme: { v: 1, colors: { light: { bg: "#fafafa" }, dark: { text: "#eeeeee", agentBubble: "#222222" } }, bubble: { radius: 6, border: "accent" }, workingLabel: "Pondering",
        background: { image: BG, fit: "contain", opacity: 0.35 }, avatar: AV }, pictures: [{ path: "p/bg.png", slot: "background", id: BG, bytes: 2048 }, { path: "p/me.png", slot: "avatar", id: AV, bytes: 1024 }],
        effects: [{ effect: "effects/snow", id: "d".repeat(32), params: { count: 4 } }] }), pg.root); await settle();
      // Each field in its own labelled row (the raw view below repeats them, so it can't stand in for a row).
      const rows = [...pg.root.querySelectorAll(".s-mod-kv")].map((r: any) => r.textContent.replace(/\s+/g, " ").trim());
      for (const v of ["Light coloursbg #fafafa", "Dark colourstext #eeeeeeagentBubble #222222", "Bubbles6px · accent", "Working labelPondering", "Background fit and opacitycontain · 35%",
        "Background picturep/bg.png · 2 KiB", "Picture (face)p/me.png · 1 KiB", 'Places effecteffects/snow dddddddd · {"count":4}']) expect(rows, v).toContain(v);
      expect([...pg.root.querySelectorAll(".s-mod-pic img")].map((i: any) => i.getAttribute("src"))).toEqual([`/ui/mods/staged/${BG}`, `/ui/mods/staged/${AV}`]);
      expect(pg.root.querySelector("[style]"), "colours through the CSSOM (#1300), never a style= in the markup").toBeNull();
    } finally { pg.restore(); }
  });
  it("an agent widget previews with the chosen agent's values; the sidebar keeps the fleet's", async () => {
    const st = planOf("a", false);
    (st.plan.items as unknown[]).push({ part: "widget", slot: "chat_header", spec: { v: 1, title: "S", items: [{ type: "badge", label: "State", bind: "state" }] }, data: {} },
      { part: "widget", slot: "sidebar", spec: { v: 1, title: "F", items: [{ type: "stat", label: "Working", bind: "fleet.working" }] }, data: {} });
    const t = await mountCard((url) => url === "/ui/mods" ? { body: { mods: [], staged: st, proposals: [] } } : { body: {} });
    try {
      const badge = () => t.pg.root.querySelector(".aw-chat_header .aw-badge")!.textContent;
      expect(badge(), "no agent chosen yet").toBe("—");
      const sel = t.pg.root.querySelector(".s-mod-plan select") as any; sel.value = "alpha"; sel.dispatchEvent(new (globalThis as any).Event("change", { bubbles: true })); await t.settle();
      expect(badge()).toBe("working");
      expect(t.pg.root.querySelector(".aw-sidebar .aw-value")!.textContent).toBe("1");
    } finally { vi.unstubAllGlobals(); t.pg.restore(); }
  });
});

describe("the page", () => {
  it("custom CSS is never ticked by default; everything else the plan offers is", async () => {
    const { page } = await import("./helpers/app-harness.js");
    vi.resetModules();
    const pg = page({ url: "http://127.0.0.1:19280/settings/appearance" });
    try {
      const { defaultChoice } = await import("/ui/js/settings-mods.js");
      const r = check(bundle());
      if (!r.ok) throw new Error("check");
      expect(defaultChoice(modPlan(r.mod, new Map()))).toEqual({ theme: true, identity: true, effects: false, ownerCss: false, ambient: false, widgets: { chat_header: true, sidebar: true }, replace: false });
    } finally { pg.restore(); }
  });
});
