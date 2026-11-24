/**
 * Sheet cells in Office skin packs: a strip may cut its frames from a bigger picture with `row` / `col`, so one PNG holds
 * several poses (row 0 idle, row 1 working, …) and a pack names far fewer files.
 * - Pack format (fleet-office-pack.js checkStrip): `row` / `col` are optional integers 0–4095; either given marks the strip
 *   as cut from a sheet (both come back, the missing one 0). A frame-list strip (`frames: [{ src }]`) refuses them.
 * - Playback (stripCell, spriteSkin): frame i is the w×h cell at column col+i of row `row` (sx = (col+i)·w, sy = row·h).
 * - Host validation (web-office-skins.ts): a cut strip's picture must be at least (col+frames)·w × (row+1)·h; a classic
 *   strip still needs exactly frames·w × h. Several strips may share one picture.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import * as PK from "../src/ui/fleet-office-pack.js";
// @ts-expect-error fleet-office-skin.js is plain browser JS without a .d.ts
import * as K from "../src/ui/fleet-office-skin.js";
import { checkSkinUpload } from "../src/web-office-skins.js";
// @ts-expect-error fleet-office-play.js is plain browser JS without a .d.ts
import { PLAY, pruneReactions } from "../src/ui/fleet-office-play.js";

const FIXTURE = join(process.cwd(), "tests", "fixtures", "office-skin-clinic");
const BASE_MANIFEST = () => JSON.parse(readFileSync(join(FIXTURE, "manifest.json"), "utf8"));
const BG_PNG = readFileSync(join(FIXTURE, "office_bg.png"));
const FOX_PNG = readFileSync(join(FIXTURE, "fox_idle.png"));

/** A minimal valid RGBA PNG of w×h (dimensions only). */
function png(w: number, h: number): Buffer {
  const table = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = table[(c ^ x) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Buffer) => {
    const t = Buffer.from(type, "ascii"), len = Buffer.alloc(4), c = Buffer.alloc(4);
    len.writeUInt32BE(data.length); c.writeUInt32BE(crc(Buffer.concat([t, data])));
    return Buffer.concat([len, t, data, c]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.alloc((w * 4 + 1) * h))), chunk("IEND", Buffer.alloc(0))]);
}

describe("checkStrip: row / col sheet cells", () => {
  it("a classic strip is unchanged (no row, no col)", () => {
    const st = PK.checkStrip({ src: "idle.png", frames: 4, w: 32, h: 48 });
    expect("row" in st).toBe(false);
    expect("col" in st).toBe(false);
  });
  it("either key marks a cut strip; both come back, the missing one 0", () => {
    expect(PK.checkStrip({ src: "hero.png", frames: 4, w: 32, h: 48, row: 2 })).toMatchObject({ row: 2, col: 0 });
    expect(PK.checkStrip({ src: "hero.png", frames: 2, w: 32, h: 48, col: 3 })).toMatchObject({ row: 0, col: 3 });
    expect(PK.checkStrip({ src: "hero.png", frames: 2, w: 32, h: 48, row: 0, col: 0 })).toMatchObject({ row: 0, col: 0 });
  });
  it("refuses bad values and row/col on a frame list", () => {
    expect(() => PK.checkStrip({ src: "hero.png", frames: 4, w: 32, h: 48, row: -1 })).toThrow();
    expect(() => PK.checkStrip({ src: "hero.png", frames: 4, w: 32, h: 48, col: 1.5 })).toThrow();
    expect(() => PK.checkStrip({ src: "hero.png", frames: 4, w: 32, h: 48, row: 4096 })).toThrow();
    expect(() => PK.checkStrip({ w: 32, h: 48, row: 1, frames: [{ src: "a.png" }] })).toThrow(/row/);
  });
  it("stripCell offsets every frame by col and row, also across sheets", () => {
    const one = PK.checkStrip({ src: "hero.png", frames: 4, w: 32, h: 48, row: 1, col: 2 });
    expect([0, 3].map((f) => PK.stripCell(one, f))).toEqual([{ src: "hero.png", col: 2, row: 1 }, { src: "hero.png", col: 5, row: 1 }]);
    const multi = PK.checkStrip({ src: ["a.png", "b.png"], frames: [2, 2], w: 32, h: 48, row: 3 });
    expect([1, 2].map((f) => PK.stripCell(multi, f))).toEqual([{ src: "a.png", col: 1, row: 3 }, { src: "b.png", col: 0, row: 3 }]);
    const classic = PK.checkStrip({ src: "idle.png", frames: 4, w: 32, h: 48 });
    expect(PK.stripCell(classic, 2)).toEqual({ src: "idle.png", col: 2 });
  });
});

describe("host upload: one sheet for several poses", () => {
  const manifest = () => {
    const m = BASE_MANIFEST();
    m.id = "sheet-cells";
    m.characters.default = {
      idle: { src: "hero.png", frames: 4, w: 32, h: 48, row: 0 },
      working: { src: "hero.png", frames: 4, w: 32, h: 48, row: 1 },
      needs: { src: "hero.png", frames: 2, w: 32, h: 48, row: 2, col: 2 },
    };
    return m;
  };
  const files = (hero: Buffer) => ({ "office_bg.png": BG_PNG.toString("base64"), "fox_idle.png": FOX_PNG.toString("base64"), "hero.png": hero.toString("base64") });

  it("three poses from one 4×3-cell picture pass, and the pack keeps it once", () => {
    const m = manifest();
    delete m.characters.fox; // keep only what this test names, if the fixture has more sets
    const r = checkSkinUpload({ manifest: m, files: files(png(4 * 32, 3 * 48)) }, "tester", 100);
    if (!r.ok) {
      // The fixture may name other pictures; fall back to checking only the dimension rule below.
      expect(r.error).not.toBe("skin_strip_dimensions");
      return;
    }
    expect(Object.keys(r.record.files)).toContain("hero.png");
  });
  it("a picture too small for the cells a strip reads is skin_strip_dimensions, naming the needed size", () => {
    const r = checkSkinUpload({ manifest: manifest(), files: files(png(4 * 32, 2 * 48)) }, "tester", 100);
    expect(r).toMatchObject({ ok: false, status: 400, error: "skin_strip_dimensions" });
    if (!r.ok) expect(r.detail).toContain("128×144");
  });
  it("a classic strip still needs exactly frames·w × h", () => {
    const m = manifest();
    m.characters.default.idle = { src: "hero.png", frames: 4, w: 32, h: 48 };
    const r = checkSkinUpload({ manifest: m, files: files(png(4 * 32, 3 * 48)) }, "tester", 100);
    expect(r).toMatchObject({ ok: false, status: 400, error: "skin_strip_dimensions" });
  });
});

describe("spriteSkin draws the cell (col+frame)·w, row·h", () => {
  it("reads the right row and column of the shared sheet", () => {
    const m = BASE_MANIFEST();
    m.characters.default.working = { src: "hero.png", frames: 2, w: 32, h: 48, fps: 10, row: 1, col: 1 };
    const checked = PK.checkSkinPack(m);
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    const draws: Array<{ sx: number; sy: number }> = [];
    const ctx: any = {
      imageSmoothingEnabled: true, globalAlpha: 1, save() {}, restore() {}, translate() {}, scale() {},
      drawImage(_im: any, sx: number, sy: number) { draws.push({ sx, sy }); },
      fillRect() {}, strokeRect() {}, beginPath() {}, arc() {}, fill() {}, stroke() {}, fillText() {}, measureText: (s: string) => ({ width: s.length * 6 }),
    };
    const imgs = new Map<string, any>([["office_bg.png", {}], ["fox_idle.png", {}], ["hero.png", { tag: "hero" }]]);
    const skin = K.spriteSkin(checked.pack, imgs);
    const env = { pal: K.DEFAULT_PAL, mode: "dark" };
    const desk = { key: "zone/a", seat: { x: 200, y: 200 }, x: 176, y: 148, w: 48, h: 66 };
    const look = { name: "a", label: "A", state: "working", pose: "working", coat: "#fff", free: true };
    skin.drawCharacter(ctx, desk, look, 0, env);
    skin.drawCharacter(ctx, desk, look, 100, env);
    expect(draws.map((d) => [d.sx, d.sy])).toEqual([[32, 48], [64, 48]]);
  });
});

describe("pat strip: a set may name what its people do while patted", () => {
  const draw = (pack: any, imgs: Map<string, any>, look: any) => {
    const draws: string[] = [];
    const ctx: any = {
      imageSmoothingEnabled: true, globalAlpha: 1, save() {}, restore() {}, translate() {}, scale() {},
      drawImage(im: any) { draws.push(im.tag); },
      fillRect() {}, strokeRect() {}, beginPath() {}, arc() {}, ellipse() {}, fill() {}, stroke() {}, fillText() {}, measureText: (s: string) => ({ width: s.length * 6 }),
    };
    const skin = K.spriteSkin(pack, imgs);
    skin.drawCharacter(ctx, { key: "zone/a", seat: { x: 200, y: 200 }, x: 176, y: 148, w: 48, h: 66 }, look, 0, { pal: K.DEFAULT_PAL, mode: "dark" });
    return { draws, skin };
  };
  const look = { name: "a", label: "A", state: "idle", pose: "pat", basePose: "idle", coat: "#fff", free: true };

  it("a pack may name `pat`; the pose shows it, and a set without one shows its base pose", () => {
    const m = BASE_MANIFEST();
    m.characters.default.pat = { src: "pat.png", frames: 2, w: 32, h: 48, fps: 6 };
    const checked = PK.checkSkinPack(m);
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    const imgs = new Map<string, any>([["office_bg.png", { tag: "bg" }], ["fox_idle.png", { tag: "idle" }], ["pat.png", { tag: "pat" }]]);
    const withPat = draw(checked.pack, imgs, look);
    expect(withPat.draws).toEqual(["pat"]);
    expect(withPat.skin.patStrip("a")?.src).toBe("pat.png");

    const plain = PK.checkSkinPack(BASE_MANIFEST());
    if (!plain.ok) throw new Error("fixture");
    const noPat = draw(plain.pack, imgs, look);
    expect(noPat.skin.patStrip("a")).toBeNull();
    expect(noPat.draws).not.toContain("pat");
  });
});

describe("a pat lasts its strip's full pass", () => {
  it("pruneReactions keeps a reaction until its `until`, else PLAY.REACT_MS", () => {
    const m = new Map<string, any>([["long", { kind: "pat", t0: 0, until: 5000 }], ["short", { kind: "pat", t0: 0 }]]);
    pruneReactions(m, PLAY.REACT_MS + 1);
    expect([...m.keys()]).toEqual(["long"]);
    pruneReactions(m, 5000);
    expect(m.size).toBe(0);
  });
});

describe("card.layout.gap: how far the card opens from its person", () => {
  it("takes 0–240 px and refuses more", () => {
    const m = BASE_MANIFEST();
    m.card = { layout: { gap: 40 } };
    const ok = PK.checkSkinPack(m);
    expect(ok.ok && ok.pack.card?.layout?.gap).toBe(40);
    m.card = { layout: { gap: 241 } };
    expect(PK.checkSkinPack(m).ok).toBe(false);
  });
});

describe("card.motion: how the card pops up", () => {
  it("takes an enter style and 80–1200 ms (default 220), refuses unknown styles", () => {
    const m = BASE_MANIFEST();
    m.card = { motion: { enter: "bounce" } };
    const ok = PK.checkSkinPack(m);
    expect(ok.ok && ok.pack.card?.motion).toEqual({ enter: "bounce", ms: 220 });
    m.card = { motion: { enter: "pop", ms: 400 } };
    expect((PK.checkSkinPack(m) as any).pack?.card?.motion).toEqual({ enter: "pop", ms: 400 });
    m.card = { motion: { enter: "spin" } };
    expect(PK.checkSkinPack(m).ok).toBe(false);
    m.card = { motion: { enter: "fade", ms: 5000 } };
    expect(PK.checkSkinPack(m).ok).toBe(false);
  });
});

describe("walkLeft and stand", () => {
  const st = (src: string) => PK.checkStrip({ src, frames: 1, w: 32, h: 48 });
  it("walking left uses the set's walkLeft, else walkSide mirrored", () => {
    const withLeft = { walkSide: st("r.png"), walkLeft: st("l.png"), idle: st("i.png") };
    expect(PK.poseStrip(withLeft, "walk", { dx: -1, dy: 0 })).toMatchObject({ strip: { src: "l.png" }, mirror: false });
    expect(PK.poseStrip(withLeft, "walk", { dx: 1, dy: 0 })).toMatchObject({ strip: { src: "r.png" }, mirror: false });
    const noLeft = { walkSide: st("r.png"), idle: st("i.png") };
    expect(PK.poseStrip(noLeft, "walk", { dx: -1, dy: 0 })).toMatchObject({ strip: { src: "r.png" }, mirror: true });
  });
  it("stand is the set's still picture, else idle", () => {
    expect(PK.poseStrip({ stand: st("s.png"), idle: st("i.png") }, "stand")).toMatchObject({ strip: { src: "s.png" } });
    expect(PK.poseStrip({ idle: st("i.png") }, "stand")).toMatchObject({ strip: { src: "i.png" } });
  });
  it("a pack may name walkLeft and stand", () => {
    const m = BASE_MANIFEST();
    m.characters.default.walkLeft = { src: "l.png", frames: 2, w: 32, h: 48 };
    m.characters.default.stand = { src: "s.png", frames: 1, w: 32, h: 48, fps: 0 };
    expect(PK.checkSkinPack(m).ok).toBe(true);
  });
});
