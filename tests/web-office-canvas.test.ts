/**
 * A pack's own canvas (`canvas: [w, h]`): every coordinate is checked against it; the scene, the editor and the
 * background follow it; the host wants a background of its shape; an office's overrides keep to their pack's canvas.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as PK from "../src/ui/fleet-office-pack.js";
// @ts-expect-error — a JS module of the app, with no types
import { WANDER, walkTargets, zonesLayout } from "../src/ui/fleet-office-zones.js";
// @ts-expect-error — a JS module of the app, with no types
import * as V from "../src/ui/fleet-office-view.js";
// @ts-expect-error — a JS module of the app, with no types
import { spriteSkin } from "../src/ui/fleet-office-skin.js";
// @ts-expect-error — a JS module of the app, with no types
import { addWaypoint, moveHandle } from "../src/ui/fleet-office-layout.js";
import { checkSkinUpload } from "../src/web-office-skins.js";
import { checkOffices } from "../src/web-office-store.js";
import { dropConflicts, overrideConflicts } from "../src/web-office-pack-tools.js";

const FIXTURE = join(process.cwd(), "tests", "fixtures", "office-skin-clinic");
const MANIFEST = () => JSON.parse(readFileSync(join(FIXTURE, "manifest.json"), "utf8"));
const BIG = () => ({ ...MANIFEST(), canvas: [2560, 1440], areas: { ...MANIFEST().areas, east: { rect: [2000, 900, 400, 400], seats: [[2100, 1000], [2200, 1100]] } } });

describe("a pack's canvas", () => {
  it("none: 1280×720 as before (no key added); its own: kept, and every coordinate may use it", () => {
    const plain = (PK.checkSkinPack(MANIFEST()) as any).pack;
    expect("canvas" in plain).toBe(false);
    expect(PK.canvasOf(plain)).toEqual({ w: 1280, h: 720 });
    const r = PK.checkSkinPack(BIG()) as any;
    expect(r.ok).toBe(true);
    expect(r.pack.canvas).toEqual({ w: 2560, h: 1440 });
    expect(r.pack.areas.east.rect).toEqual({ x: 2000, y: 900, w: 400, h: 400 });
    if (MANIFEST().door === undefined) expect(r.pack.door).toEqual({ x: 1280, y: 1430 });   // the default door: the canvas's foot
    // The same seat on the default canvas: refused, saying the range.
    expect(PK.checkSkinPack({ ...BIG(), canvas: undefined })).toEqual({ ok: false, error: "areas.east.rect[0]: a number from 0 to 1280" });
    // A check after a big one is back on the default (nothing leaks between checks).
    expect(PK.checkSkinPack({ ...MANIFEST(), door: [1300, 10] })).toEqual({ ok: false, error: "door[0]: a number from 0 to 1280" });
  });
  it.each([
    [[1920, 1080], true], [[5120, 2880], true], [[639, 720], false], [[1280, 2881], false], [[1280.5, 720], false], ["big", false], [[1280], false],
  ])("canvas %j: %s", (canvas, ok) => {
    expect((PK.checkSkinPack({ ...MANIFEST(), canvas }) as any).ok).toBe(ok);
  });
  it("the scene and the editor are the pack's canvas", () => {
    const pack = (PK.checkSkinPack(BIG()) as any).pack;
    const L = zonesLayout(pack, []);
    expect([L.width, L.height]).toEqual([2560, 1440]);
    expect(moveHandle(pack, "door", 9999, 9999).door).toEqual({ x: 2560, y: 1440 });
    const w = addWaypoint(pack);
    expect(w.pack.waypoints.at(-1)).toMatchObject({ x: 1280, y: 720 });              // the middle of this canvas
  });
  it("an office's overrides keep to their pack's canvas", () => {
    const pack = (PK.checkSkinPack({ ...BIG(), id: "big" }) as any).pack;
    const office = (overrides: unknown) => [{ id: "o", name: "O", skin: "big", members: [], overrides }];
    const where = (ov: unknown, packOf?: any) => { const r = checkOffices(office(ov), packOf); return r.ok ? null : r.detail; };
    expect(where({ pack: "big", door: [2500, 1400] }, (id: string) => (id === "big" ? pack : null))).toBeNull();
    expect(where({ pack: "big", door: [2561, 10] }, (id: string) => (id === "big" ? pack : null))).toBe("offices[0].overrides.door[0]: a number from 0 to 2560");
    // Applied to a smaller pack than the one they were made for: refused, saying the canvas.
    const small = (PK.checkSkinPack({ ...MANIFEST(), id: "big" }) as any).pack;
    expect(PK.applyOverrides(small, { pack: "big", door: [2000, 10] })).toEqual({ ok: false, error: "overrides.door: a point on the canvas (1280×720)" });
  });
  it("the host wants the background in the canvas's shape", () => {
    const b64 = (f: string) => readFileSync(join(FIXTURE, f)).toString("base64");
    const r = checkSkinUpload({ manifest: { ...MANIFEST(), canvas: [1280, 960] }, files: { "office_bg.png": b64("office_bg.png"), "fox_idle.png": b64("fox_idle.png") } }, "me", 1);
    expect(r.ok).toBe(false);
    expect(r.ok ? null : r.detail).toMatch(/must be the canvas's shape, 4:3/);
    expect(checkSkinUpload({ manifest: { ...MANIFEST(), canvas: [2560, 1440] }, files: { "office_bg.png": b64("office_bg.png"), "fox_idle.png": b64("fox_idle.png") } }, "me", 1).ok).toBe(true);
  });
  it("a pack re-uploaded on a smaller canvas: the office's points off it are conflicts; dropped, the rest stays", () => {
    const small = (PK.checkSkinPack({ ...MANIFEST(), id: "big" }) as any).pack;      // the same id, no canvas: 1280×720
    const offices = [{ id: "o", name: "O", skin: "big", members: [], overrides: { pack: "big", door: [2000, 1300], mailDrop: [600, 400] } }];
    const c = overrideConflicts(offices as never, small);
    // Without dropping: one conflict, the door (the change is refused, naming it).
    expect(c).toEqual([{ office: "o", name: "O", entry: "door", rule: "door: a point on the canvas (1280×720)" }]);
    // Dropping it: the office keeps its mail drop, and what is left fits the smaller pack.
    const [o] = dropConflicts(offices as never, c) as any[];
    expect(o.overrides).toEqual({ pack: "big", mailDrop: [600, 400] });
    expect(PK.applyOverrides(small, o.overrides).ok).toBe(true);
    // On the canvas they were made for: no conflict at all.
    const big = (PK.checkSkinPack({ ...BIG(), id: "big" }) as any).pack;
    expect(overrideConflicts(offices as never, big)).toEqual([]);
  });
  it("its background picture not loaded: the fallback hall paints the whole big canvas, not 1280×720 of it", () => {
    const pack = (PK.checkSkinPack(BIG()) as any).pack;
    const rects: number[][] = [];
    const ctx: any = new Proxy({}, { get: (_t, k) => (k === "fillRect" ? (...a: number[]) => rects.push(a) : k === "measureText" ? () => ({ width: 10 }) : () => {}), set: () => true });
    spriteSkin(pack, new Map()).drawBackground(ctx, zonesLayout(pack, []), { mode: "dark", pal: { border: "#000", text: "#fff" }, labels: { areas: {} } });
    expect(rects[0]).toEqual([0, 0, 2560, 1440]);
  });
  it("#4458 [D]: the background and foreground shrunk below 1 px a picture px are smoothed (high); at 1x and over, not", () => {
    const pack = (PK.checkSkinPack({ ...BIG(), foreground: "office_bg.png" }) as any).pack;
    const im = { width: 2048, height: 1152 };                                       // 0.8 px a unit on the 2560 canvas
    const seen = (scale: number) => {
      const got: any[] = [], ctx: any = { imageSmoothingEnabled: true, imageSmoothingQuality: "low", save() {}, restore() {},
        getTransform: () => ({ a: scale, b: 0 }), drawImage() { got.push([this.imageSmoothingEnabled, this.imageSmoothingQuality]); } };
      const sk = spriteSkin(pack, new Map([["office_bg.png", im]]));
      sk.drawBackground(ctx, zonesLayout(pack, []), {}); sk.drawForeground(ctx, zonesLayout(pack, []), {});
      return got;
    };
    expect(seen(0.1)).toEqual([[true, "high"], [true, "high"]]);                   // a phone's fit: shrunk
    expect(seen(0.8)).toEqual([[false, "low"], [false, "low"]]);                   // exactly 1 px a picture px
    expect(seen(2)).toEqual([[false, "low"], [false, "low"]]);                     // zoomed in: pixel art
    const none: any = { imageSmoothingEnabled: true, save() {}, restore() {}, drawImage() { this.at = this.imageSmoothingEnabled; } };
    spriteSkin(pack, new Map([["office_bg.png", im]])).drawBackground(none, zonesLayout(pack, []), {});
    expect(none.at).toBe(false);                                                    // no transform to read: as before
  });
  it("people walk the whole big canvas: an idle person in an area past 1280 strolls there, never clamped to 1280×720", () => {
    const pack = (PK.checkSkinPack({ ...BIG(), stateZones: { ...MANIFEST().stateZones, idle: "east", default: "east" },
      waypoints: [...MANIFEST().waypoints, { id: "e1", x: 2150, y: 1180 }, { id: "e2", x: 2300, y: 1000 }],
      edges: [...MANIFEST().edges, ["e1", "e2"]] }) as any).pack;
    const L = zonesLayout(pack, [{ name: "alpha", state: "idle", label: "Alpha" }]);
    const desks = L.rooms.flatMap((r: any) => r.desks);
    expect(desks[0].seat.x).toBeGreaterThan(1280);
    const spots = Array.from({ length: 2 * WANDER.PERIOD / 1000 }, (_, i) => walkTargets(desks, L, i * 1000).get("alpha"));
    const away = spots.filter((q: any) => q.x !== desks[0].seat.x || q.y !== desks[0].seat.y);
    expect(away.length).toBeGreaterThan(0);
    for (const q of spots) { expect(q.x).toBeGreaterThan(1280); expect(q.x).toBeLessThanOrEqual(2560); expect(q.y).toBeLessThanOrEqual(1440); }
  });
});

describe("the view of a big canvas (#4405: Fit on a phone)", () => {
  const PHONE = { w: 390, h: 600 };
  it("Fit (contain) shows a 5120×2880 canvas whole on a phone, centred; − reaches it and stops at the scene's floor", () => {
    const v = V.fitScene(5120, 2880, PHONE);
    expect(v.k).toBeCloseTo(390 / 5120, 9);
    expect(5120 * v.k).toBeLessThanOrEqual(PHONE.w + 1e-9);
    expect(v.x).toBeCloseTo(0, 9);
    expect(V.minK(5120, 2880)).toBe(V.OK_FLOOR);
    expect(V.OK_FLOOR).toBeCloseTo(0.025, 12);                                    // 5120 units still 128 px wide
    // Zooming out from 0.1 goes on, below Fit, down to the floor and no further.
    let k = 0.1; const lo = V.minK(5120, 2880);
    for (let i = 0; i < 40; i++) k = V.stepK(k, -1, 3, lo);
    expect(k).toBe(lo);
    expect(V.zoomOffice({ k: 0.1, x: 0, y: 0 }, 0.001, 0, 0, lo).k).toBe(lo);
    expect(V.snapK(0.001, 1, lo)).toBe(lo);
    // A kept view at that zoom comes back as it was (the store's check keeps it; the scene's floor allows it).
    const kept = V.savedOk({ k: 0.03, cx: 2560, cy: 1440 });
    expect(kept.k).toBe(0.03);
    expect(V.viewFromSaved(kept, PHONE, lo).k).toBe(0.03);
  });
  it("the floor follows the scene's size, never below OK_FLOOR; the default canvas keeps OK_MIN exactly as before", () => {
    expect(V.minK(1280, 720)).toBe(V.OK_MIN);
    expect(V.minK(640, 360)).toBe(V.OK_MIN);
    expect(V.minK(2560, 1440)).toBeCloseTo(0.05, 12);
    expect(V.minK(5120, 360)).toBeCloseTo(0.025, 12);
    expect(V.minK(100000, 720)).toBe(V.OK_FLOOR);
    // The ordinary canvas: Fit, − and a kept view as before.
    expect(V.fitScene(1280, 720, PHONE).k).toBeCloseTo(390 / 1280, 9);
    expect(V.fitK(1280, 720, { w: 50, h: 50 })).toBe(V.OK_MIN);
    expect(V.stepK(V.OK_MIN, -1, 1)).toBe(V.OK_MIN);
    expect(V.viewFromSaved({ k: 0.03, cx: 640, cy: 360 }, PHONE).k).toBe(V.OK_MIN);
  });
});
