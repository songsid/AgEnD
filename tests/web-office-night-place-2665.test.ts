/**
 * #2665: Edit layout places a furniture item's night place (#2568's `night`).
 * - Each item with a `night` has a night handle ("Item {id} (night)"): on its night place, or on its day place while it
 *   sleeps in place (it follows the item there); dragged, the item has its own; its reset puts back the pack's.
 * - Saved as `overrides.furnitureNight: { id: [x, y] }`, checked like `furniture` (an item's id, on the canvas; on a
 *   pack: an item it has, with a night). At bedtime nightFurniture uses it, by day the item stays where it is. A pack
 *   that lost the item drops only that entry when drawn (fitNight).
 * - Downgrade: on disk the host keeps the night places beside the offices (`furnitureNight` by office id), never in
 *   their overrides, so an older host's strict check (an unknown key drops the office) still reads every office.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";
import { OfficeStore, checkOffices } from "../src/web-office-store.js";
import * as HPK from "../src/ui/fleet-office-pack.js";

let p: AppPage;
let PK: any, LY: any, F: any;
beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19280/ui/fleet/org" });
  PK = await import("/ui/js/fleet-office-pack.js");
  LY = await import("/ui/js/fleet-office-layout.js");
  F = await import("/ui/js/fleet-office.js");
});
afterAll(async () => { await p.unmount(); p.restore(); });

const STRIP = (src: string) => ({ src, frames: 2, w: 16, h: 16 });
/** A pack: `sleeper` sleeps in place, `napper` on a bed elsewhere, `lamp` has no night. */
const MANIFEST = () => ({ format: 1, id: "nightpack", background: "bg.png", areas: { lounge: { rect: [0, 0, 1280, 720], seats: [[100, 100]] } }, stateZones: { idle: "lounge" },
  characters: { default: { idle: STRIP("i.png") } },
  furniture: [{ id: "sleeper", sprite: STRIP("a.png"), x: 300, y: 300, depth: "y", night: { sprite: STRIP("a_sleep.png") } },
    { id: "napper", sprite: STRIP("b.png"), x: 500, y: 300, depth: "y", night: { sprite: STRIP("b_sleep.png"), x: 220, y: 410 } },
    { id: "lamp", sprite: STRIP("lamp.png"), x: 700, y: 100 }] });
const packOf = (mod: any) => { const c = mod.checkSkinPack(MANIFEST()); if (!c.ok) throw new Error(c.error); return c.pack; };
const nightOf = (pk: any, id: string) => { const f = pk.furniture.find((x: any) => x.id === id); return [f.night.x, f.night.y]; };

describe("the night handles", () => {
  it("one per item with a night, labelled as its night: in place on its day place, else on its own", () => {
    const hs = LY.handlesOf(packOf(PK)).filter((x: any) => x.kind === "night");
    expect(hs.map((x: any) => [x.key, x.label, x.x, x.y, x.inPlace])).toEqual([
      ["night:sleeper", "Item sleeper (night)", 300, 300, true], ["night:napper", "Item napper (night)", 220, 410, false]]);
    expect(hs.find((x: any) => x.key === "night:napper").day).toEqual({ x: 500, y: 300 });
  });
  it("in place it follows the item; dragged away it is the item's own (rounded, on the canvas); the item stays", () => {
    const base = packOf(PK);
    const moved = LY.moveHandle(base, "furn:sleeper", 340, 320);
    expect(LY.handlesOf(moved).find((x: any) => x.key === "night:sleeper")).toMatchObject({ x: 340, y: 320, inPlace: true });
    const own = LY.moveHandle(moved, "night:sleeper", 900.4, 9999);
    expect(nightOf(own, "sleeper")).toEqual([900, 720]);
    expect(own.furniture.find((x: any) => x.id === "sleeper")).toMatchObject({ x: 340, y: 320 });
    expect(LY.moveHandle(base, "night:lamp", 1, 1).furniture.find((x: any) => x.id === "lamp").night).toBeNull();   // no night: nothing to move
  });
  it("in place → dragged → reset: back in place, no override; a bed elsewhere → reset: back to the pack's", () => {
    const base = packOf(PK);
    const dragged = LY.moveHandle(base, "night:sleeper", 800, 500);
    expect(LY.layoutOverrides(base, dragged)).toEqual({ pack: "nightpack", furnitureNight: { sleeper: [800, 500] } });
    const back = LY.resetNight(dragged, base, "sleeper");
    expect(nightOf(back, "sleeper")).toEqual([null, null]);
    expect(LY.layoutOverrides(base, back)).toBeNull();
    const bed = LY.resetNight(LY.moveHandle(base, "night:napper", 10, 10), base, "napper");
    expect([nightOf(bed, "napper"), LY.layoutOverrides(base, bed)]).toEqual([[220, 410], null]);
  });
});

describe("saved, checked and used at bedtime", () => {
  it("checkLayoutOverrides: an item's id and a point on the canvas; applyOverrides: an item the pack has, with a night", () => {
    const base = packOf(PK);
    const ov = { pack: "nightpack", furnitureNight: { sleeper: [800, 500] } };
    expect(PK.checkLayoutOverrides(ov)).toEqual({ ok: true, overrides: ov });
    expect(PK.checkLayoutOverrides({ pack: "nightpack", furnitureNight: { sleeper: [1300, 0] } })).toEqual({ ok: false, error: "overrides.furnitureNight.sleeper[0]: a number from 0 to 1280" });
    expect(PK.checkLayoutOverrides({ pack: "nightpack", furnitureNight: { sleeper: [1, 2, 3] } })).toEqual({ ok: false, error: "overrides.furnitureNight.sleeper: [x, y]" });
    expect(PK.checkLayoutOverrides({ pack: "nightpack", furnitureNight: { constructor: [1, 2] } })).toEqual({ ok: false, error: "overrides.furnitureNight.constructor: an item's id" });
    expect(PK.applyOverrides(base, { pack: "nightpack", furnitureNight: { ghost: [1, 2] } })).toEqual({ ok: false, error: "overrides.furnitureNight.ghost: an item with a night the pack has" });
    expect(PK.applyOverrides(base, { pack: "nightpack", furnitureNight: { lamp: [1, 2] } })).toEqual({ ok: false, error: "overrides.furnitureNight.lamp: an item with a night the pack has" });
    const r = PK.applyOverrides(base, ov);
    expect([r.ok, nightOf(r.pack, "sleeper"), nightOf(base, "sleeper")]).toEqual([true, [800, 500], [null, null]]);    // the pack as it was
    expect(PK.overridesBetween(base, r.pack)).toEqual(ov);
  });
  it("at bedtime the saved night place; by day the item where it stands; with a day move too, an in-place one sleeps at the new place", () => {
    const base = packOf(PK);
    const r = PK.applyOverrides(base, { pack: "nightpack", furniture: { sleeper: [350, 330], napper: [520, 310] }, furnitureNight: { napper: [1000, 600] } }).pack;
    const at = (list: any[]) => Object.fromEntries(list.map((x: any) => [x.id, [x.x, x.y]]));
    expect(at(F.nightFurniture(r.furniture))).toEqual({ sleeper: [350, 330], napper: [1000, 600], lamp: [700, 100] });
    expect(at(r.furniture)).toEqual({ sleeper: [350, 330], napper: [520, 310], lamp: [700, 100] });               // by day
    expect(F.nightGhostsOf(r).map((x: any) => [x.id, x.sprite.src, x.x, x.y])).toEqual([["sleeper", "a_sleep.png", 350, 330], ["napper", "b_sleep.png", 1000, 600]]);
  });
  it("a pack that lost the item (or its night) drops only that entry when drawn; the rest of the layout stays", () => {
    const base = packOf(PK);
    const ov = { pack: "nightpack", door: [10, 10], furnitureNight: { napper: [1, 1], gone: [2, 2] } };
    expect(PK.fitNight(base, ov)).toEqual({ pack: "nightpack", door: [10, 10], furnitureNight: { napper: [1, 1] } });
    expect(PK.fitNight(base, { pack: "nightpack", furnitureNight: { gone: [2, 2] } })).toEqual({ pack: "nightpack" });
    expect(PK.fitNight(base, { pack: "other", furnitureNight: { gone: [2, 2] } })).toEqual({ pack: "other", furnitureNight: { gone: [2, 2] } });
    expect(PK.applyOverrides(base, PK.fitNight(base, ov)).ok).toBe(true);
  });
});

describe("Edit layout's night handles", () => {
  afterEach(async () => { await p.unmount(); });
  const mount = async (start?: any) => {
    const base = packOf(PK), saved: any[] = [];
    await p.mount(h(LY.LayoutEditor, { base, start: start ?? base, dock: false, onChange() {}, onSave: async (ov: any) => { saved.push(ov); return { ok: true }; }, onClose() {} }));
    await settle(4);
    return { base, saved };
  };
  const handle = (k: string) => p.root.querySelector(`[data-handle="night:${k}"]`);
  it("listed and drawn with a moon; a bed elsewhere is joined to its day place by a line", async () => {
    await mount();
    expect([handle("sleeper").getAttribute("aria-label"), handle("napper").getAttribute("aria-label"), handle("lamp")]).toEqual(["Item sleeper (night) at 300, 300", "Item napper (night) at 220, 410", null]);
    expect(p.root.querySelectorAll(".ol-night .ol-moon").length).toBe(2);
    const lines = p.root.querySelectorAll(".ol-night-line");
    expect(lines.map((l: any) => ["x1", "y1", "x2", "y2"].map((a) => Number(l.getAttribute(a))))).toEqual([[500, 300, 220, 410]]);
  });
  it("dragged: Save sends furnitureNight; its reset (on the selected handle) puts it back in place", async () => {
    const { saved } = await mount();
    const svg = p.root.querySelector(".ol-svg");
    svg.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1280, height: 720, right: 1280, bottom: 720 });
    fire(handle("sleeper"), "pointerdown", { pointerId: 1, clientX: 300, clientY: 300 }); await settle(1);
    fire(svg, "pointermove", { pointerId: 1, clientX: 820, clientY: 480 }); await settle(1);
    fire(svg, "pointerup", { pointerId: 1 }); await settle(2);
    expect(handle("sleeper").getAttribute("aria-label")).toBe("Item sleeper (night) at 820, 480");
    p.root.querySelector(".ol-save").click(); await settle(4);
    expect(saved).toEqual([{ pack: "nightpack", furnitureNight: { sleeper: [820, 480] } }]);
    fire(handle("sleeper"), "keydown", { key: "ArrowLeft" }); await settle(2);
    p.root.querySelector(".ol-night-reset").click(); await settle(2);
    expect(handle("sleeper").getAttribute("aria-label")).toBe("Item sleeper (night) at 300, 300");
    p.root.querySelector(".ol-save").click(); await settle(4);
    expect(saved[1]).toBeNull();
  });
});

describe("on the host, rollback-safe", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
  const store = () => { const d = mkdtempSync(join(tmpdir(), "agend-night-")); dirs.push(d); return { d, s: new OfficeStore(d, (id) => (id === "nightpack" ? packOf(HPK) : null)) }; };
  const OFFICE = (ov: any) => ({ id: "room", name: "Room", skin: "nightpack", members: [], overrides: ov });
  /**
   * The older host's read (2.3.2-beta.1…beta.8, before #2665): the file needs version/rev/offices (other keys are not
   * looked at); each office's keys, then its overrides' keys, are a closed list — anything else drops that office.
   */
  const olderReads = (doc: any) => {
    if (doc.version !== 1 || !Number.isSafeInteger(doc.rev) || !Array.isArray(doc.offices)) return null;
    const closed = (o: any, keys: string[]) => Object.keys(o).every((k) => keys.includes(k));
    return doc.offices.filter((o: any) => closed(o, ["id", "name", "skin", "members", "layout", "overrides"])
      && (o.overrides === undefined || (closed(o.overrides, ["pack", "seats", "furniture", "door", "waypoints", "edges"])
        && Object.values(o.overrides.furniture ?? {}).every((q: any) => Array.isArray(q) && q.length === 2))));
  };

  it("the stand-in is the older rule: an unknown overrides key is refused by the shared check's own keys list (control)", () => {
    expect(HPK.checkLayoutOverrides({ pack: "nightpack", bedtime: {} })).toEqual({ ok: false, error: 'overrides: unknown key "bedtime"' });
    expect(olderReads({ version: 1, rev: 1, offices: [OFFICE({ pack: "nightpack", furnitureNight: { sleeper: [1, 1] } })] })).toEqual([]);   // inside: dropped
  });
  it("written beside the offices; every office still passes the older read; read back whole", () => {
    const { d, s } = store();
    const ov = { pack: "nightpack", furniture: { lamp: [710, 110] }, furnitureNight: { sleeper: [800, 500] } };
    expect(s.replace([OFFICE(ov), { id: "plain", name: "Plain", skin: "pixel", members: [] }], 0).ok).toBe(true);
    const doc = JSON.parse(readFileSync(join(d, "web-offices.json"), "utf8"));
    expect(doc.offices[0]).not.toHaveProperty("overrides");                                     // #2706: beside the offices too
    expect(doc.overrides).toEqual({ room: { pack: "nightpack", furniture: { lamp: [710, 110] } } });
    expect(doc.furnitureNight).toEqual({ room: { sleeper: [800, 500] } });
    expect(olderReads(doc).map((o: any) => o.id)).toEqual(["room", "plain"]);
    expect(new OfficeStore(d).list().offices[0].overrides).toEqual(ov);
    expect(s.list().offices[0].overrides).toEqual(ov);
  });
  it("no night places: no key beside the offices; an older host's save (no keys) reads back without its layout, the office kept", () => {
    const { d, s } = store();
    expect(s.replace([OFFICE({ pack: "nightpack", door: [5, 5] })], 0).ok).toBe(true);
    expect(JSON.parse(readFileSync(join(d, "web-offices.json"), "utf8"))).not.toHaveProperty("furnitureNight");
    expect(s.replace([OFFICE({ pack: "nightpack", furnitureNight: { napper: [9, 9] } })], 1).ok).toBe(true);
    const doc = JSON.parse(readFileSync(join(d, "web-offices.json"), "utf8"));
    expect(doc.overrides).toEqual({ room: { pack: "nightpack" } });
    const older = { version: 1, rev: doc.rev + 1, offices: olderReads(doc) };                  // what an older host writes back
    writeFileSync(join(d, "web-offices.json"), JSON.stringify(older));
    // #2706: the overrides were beside the office as well, so an older host's save leaves it without its layout.
    expect(new OfficeStore(d).list().offices).toEqual([{ id: "room", name: "Room", skin: "nightpack", members: [] }]);
  });
  it("a night place that no longer checks is left out on read, the office kept; a write naming an item without a night is refused", () => {
    const { d, s } = store();
    expect(s.replace([OFFICE({ pack: "nightpack", door: [5, 5] })], 0).ok).toBe(true);
    const doc = JSON.parse(readFileSync(join(d, "web-offices.json"), "utf8"));
    writeFileSync(join(d, "web-offices.json"), JSON.stringify({ ...doc, furnitureNight: { room: { sleeper: [9999, 0] } } }));
    expect(new OfficeStore(d).list().offices).toEqual([OFFICE({ pack: "nightpack", door: [5, 5] })]);
    const bad = checkOffices([OFFICE({ pack: "nightpack", furnitureNight: { lamp: [1, 1] } })], (id) => (id === "nightpack" ? packOf(HPK) : null));
    expect(bad).toEqual({ ok: false, status: 400, error: "offices_invalid", detail: "offices[0].overrides.furnitureNight.lamp: an item with a night the pack has" });
  });
});
