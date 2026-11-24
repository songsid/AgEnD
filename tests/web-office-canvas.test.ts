/**
 * A pack's own canvas (`canvas: [w, h]`): every coordinate is checked against it; the scene, the editor and the
 * background follow it; the host wants a background of its shape; an office's overrides keep to their pack's canvas.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as PK from "../src/ui/fleet-office-pack.js";
import { zonesLayout } from "../src/ui/fleet-office-zones.js";
import { addWaypoint, moveHandle } from "../src/ui/fleet-office-layout.js";
import { checkSkinUpload } from "../src/web-office-skins.js";
import { checkOffices } from "../src/web-office-store.js";

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
    expect(r.ok ? null : r.detail).toMatch(/must be the canvas's shape, 1280:960/);
    expect(checkSkinUpload({ manifest: { ...MANIFEST(), canvas: [2560, 1440] }, files: { "office_bg.png": b64("office_bg.png"), "fox_idle.png": b64("fox_idle.png") } }, "me", 1).ok).toBe(true);
  });
});
