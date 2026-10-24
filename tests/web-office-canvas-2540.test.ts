/**
 * #2540: the Office view fills the Fleet panel and pans and zooms like the org chart's canvas.
 * - The shared view (fleet-canvas-view.js, also the org canvas's): screen ↔ logical, zoom about a point, a pinch step,
 *   an overview click, the zoom keys.
 * - The Office's own (fleet-office-view.js): pixel levels (a logical unit is a whole number of device px) for the
 *   + / − steps, Fit (contain: the exact, non-integer scale that shows the whole scene) and Fill (cover: the panel
 *   filled, the overflow cropped), the opening views, keeping the scene on screen (clampPan), the kept view (per
 *   device, per office and style; a kept fit is fitted again) and the fit mode, the overview's box (inside the stage,
 *   scaled to it) and its frame (the part of the scene in view), the zoom's label, the layers' resolution, the matte
 *   from a background's edge pixels.
 * - The pack's `matte`: checked by the page's module and by the host (the same rules), lower-cased.
 * - The pack's `foreground` (a file in the pack, with stateZones) and furniture `depth: "y"` (sorted among the people);
 *   on the page a "y" item is drawn between the people by base y, and the foreground after people, furniture and
 *   props but before the name tags and bubbles.
 * - Fullscreen: the button and `f` (never while typing), the Fullscreen API on the container (webkit's too), synced by
 *   fullscreenchange; immersive (CSS) where the API is missing or refuses, left by Esc; only the stage and its floating
 *   controls show; a resize re-fits; a desk's chat leaves it; unmounting leaves it and its listeners.
 * - On the page: the canvas is the stage; + / − / 0 and the buttons zoom; a drag pans, a wheel and a pinch zoom; the
 *   overview shows the view; a click and a hover hit through the view; the view is kept and restored, clamped to the
 *   panel; the zoom's percentage beside the buttons; Fill (its words, kept per office, fitted again on a resize);
 *   the container fills the Fleet panel (no column cap, no auto margins); Edit layout's
 *   overlay follows the view and a handle dragged under zoom lands on the logical point under the pointer, while a drag
 *   off the handles pans; reduced motion draws each change at once; the matte is the pack's, else sampled, else the
 *   skin's token.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";
import { fire, MiniElement } from "./helpers/mini-dom.js";

const FIXTURE = join(process.cwd(), "tests", "fixtures", "office-skin-clinic");
const MANIFEST = () => JSON.parse(readFileSync(join(FIXTURE, "manifest.json"), "utf8"));
const FILES = { "office_bg.png": "a".repeat(32), "fox_idle.png": "b".repeat(32) };
const INSTANCES = [
  { name: "atlas", display_name: "Atlas", status: "running", backend: "claude-code" },
  { name: "quill", status: "running", backend: "kiro-cli" },
  { name: "sage", status: "paused", backend: "grok" },
];
const ORG = { general: ["atlas"], teams: [{ name: "Web", members: ["quill", "sage"] }], instances: {} };
const STORE = { ready: true, instances: INSTANCES, exec: { quill: "working" }, awaiting: {}, needs: [] };
const STAGE = { w: 960, h: 600 };                                    // the stage before it is measured (a test page has none)

let p: AppPage;
let V: any, OM: any, CV: any, PK: any, Z: any, K: any, app: any, nav: any, fleet: any, SK: any;
let offices: any = { rev: 0, offices: [] }, skins: any = { rev: "", packs: [] }, manifestAnswer: any = null;
beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19280/ui/fleet/org" });
  (globalThis as any).fetch = async (url: string, o: any = {}) => {
    if (url === "/ui/offices" && o.method === "PUT") return { ok: true, status: 200, json: async () => offices };
    if (url.startsWith("/ui/office-skins/")) return manifestAnswer ? { ok: true, status: 200, json: async () => manifestAnswer } : { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => (url === "/ui/org" ? ORG : url === "/ui/offices" ? offices : url === "/ui/office-skins" ? skins : {}) };
  };
  app = await import("/assets/app-store.js");
  nav = await import("/assets/app-nav.js");
  nav.startRouter(p.window);
  fleet = await import("/ui/js/panel-fleet.js");
  V = await import("/ui/js/fleet-office-view.js");
  OM = await import("/ui/js/fleet-office-model.js");
  CV = await import("/ui/js/fleet-canvas-view.js");
  PK = await import("/ui/js/fleet-office-pack.js");
  Z = await import("/ui/js/fleet-office-zones.js");
  K = await import("/ui/js/fleet-office-skin.js");
  SK = await import("/ui/js/fleet-office-store.js");
});
afterAll(async () => { await p.unmount(); p.restore(); delete (globalThis as any).fetch; });   // unmounted first: no draw loop outlives the page
beforeEach(async () => {
  await p.unmount();
  p.storage.clear();
  offices = { rev: 0, offices: [] }; skins = { rev: "", packs: [] }; manifestAnswer = null;
  nav.navigate("/ui/fleet/org");
  app.appStore.set(STORE);
});

describe("the shared view (fleet-canvas-view.js)", () => {
  it("screen ↔ logical round-trips; zoom about a point keeps that point; a pinch keeps the point under its midpoint", () => {
    const v = { k: 2, x: -100, y: 40 };
    expect(CV.toWorld(v, 300, 240)).toEqual({ x: 200, y: 100 });
    expect(CV.toScreen(v, 200, 100)).toEqual({ x: 300, y: 240 });
    const z = CV.zoomTo(v, 3, 300, 240);
    expect(CV.toWorld(z, 300, 240)).toEqual({ x: 200, y: 100 });
    const from = { mid: { x: 300, y: 240 }, dist: 100 }, to = { mid: { x: 350, y: 260 }, dist: 200 };
    const pv = CV.pinchTo(v, from, to, 4);
    expect([pv.k, CV.toWorld(pv, 350, 260)]).toEqual([4, { x: 200, y: 100 }]);
    expect(CV.pinchView(v, from, to).k).toBe(CV.K_MAX);                 // the org canvas's: 2 × 2, clamped to its range
    expect(CV.centreOn(v, { w: 800, h: 600 }, 10, 20)).toEqual({ k: 2, x: 380, y: 260 });
  });
  it("an overview click: the world point at the click, the overview drawn whole and centred; keys: + = in, - _ out, 0 fit, none with a modifier", () => {
    const rect = { left: 10, top: 20, width: 180, height: 120 }, box = { x: 0, y: 0, w: 1280, h: 720 };
    // 1280×720 in 180×120: scale 180/1280, the height 101.25 centred (9.375 above).
    expect(CV.miniPoint(rect, box, 10 + 90, 20 + 60)).toEqual({ x: 640, y: 360 });
    expect(CV.miniPoint(rect, box, 10, 20 + 9.375)).toEqual({ x: 0, y: 0 });
    expect(CV.miniPoint({ left: 0, top: 0, width: 0, height: 0 }, box, 1, 1)).toBeNull();
    const k = (key: string, mod: any = {}) => CV.zoomKey({ key, ...mod });
    expect([k("+"), k("="), k("-"), k("_"), k("0"), k("a"), k("+", { ctrlKey: true }), k("0", { metaKey: true }), k("-", { altKey: true })])
      .toEqual(["in", "in", "out", "out", "fit", null, null, null, null]);
  });
});

describe("pixel levels and Fit (fleet-office-view.js)", () => {
  it("snapK: a logical unit is a whole number of device px from one up; below one it is continuous; in range", () => {
    expect([V.snapK(1.4, 1), V.snapK(1.6, 1), V.snapK(0.7, 1), V.snapK(0.3, 2), V.snapK(0.8, 2), V.snapK(1.1, 1.5)]).toEqual([1, 2, 0.7, 0.3, 1, 4 / 3]);
    expect(V.snapK(100, 1)).toBe(V.OK_MAX);
    expect(V.snapK(0.001, 1)).toBe(V.OK_MIN);
    for (const dpr of [1, 1.25, 1.5, 2, 3]) for (const k of [0.6, 0.9, 1.3, 2.2, 5]) {
      const s = V.snapK(k, dpr);
      if (s * dpr >= 1) expect(V.isPixelK(s, dpr), `${k}@${dpr}`).toBe(true);
    }
  });
  it("stepK: + and − go level by level; below one device px a unit by 1.25, and back up onto level 1", () => {
    expect([V.stepK(1, 1, 1), V.stepK(2, 1, 1), V.stepK(2, -1, 1), V.stepK(1, -1, 1)]).toEqual([2, 3, 1, 0.8]);
    expect([V.stepK(0.5, 1, 2), V.stepK(1, 1, 2), V.stepK(1.5, -1, 2)]).toEqual([1, 1.5, 1]);   // dpr 2: 1, 2, 3 device px
    expect(V.stepK(0.9, 1, 1)).toBe(1);                                   // 0.9 × 1.25 passes level 1: onto it
    expect(V.stepK(0.5, 1, 1)).toBe(0.625);
    expect(V.stepK(V.OK_MAX, 1, 1)).toBe(V.OK_MAX);
    expect(V.stepK(V.OK_MIN, -1, 1)).toBe(V.OK_MIN);
  });
  it("Fit (contain): the exact scale that shows the whole scene, non-integer, centred — it fills the panel's width or height", () => {
    expect(V.fitScene(1280, 720, { w: 1700, h: 900 })).toEqual({ k: 1.25, x: 50, y: 0 });
    // The reported desktop: a 2231 × 1018 stage. The old rule took level 1 (a 1280 × 720 box in the middle); now 1.41.
    const big = V.fitScene(1280, 720, { w: 2231, h: 1018 });
    expect(big.k).toBeCloseTo(1018 / 720, 9);
    expect(big.y).toBeCloseTo(0, 9);
    expect(big.x).toBeCloseTo((2231 - 1280 * big.k) / 2, 9);
    expect(V.fitK(1280, 720, { w: 2600, h: 1500 })).toBeCloseTo(2600 / 1280, 9);   // 2.03: no snapping to 2
    expect(V.fitK(1280, 720, { w: 2500, h: 1500 })).toBeCloseTo(2500 / 1280, 9);
    expect(V.fitK(1280, 720, { w: 390, h: 700 })).toBeCloseTo(390 / 1280, 9);     // a phone
    expect(V.fitScene(1280, 720, STAGE)).toEqual({ k: 0.75, x: 0, y: 30 });
    expect(V.fitScene(1280, 720, STAGE, "contain")).toEqual(V.fitScene(1280, 720, STAGE));
    expect(V.fitK(1280, 720, { w: 1e6, h: 1e6 })).toBe(V.OK_MAX);                 // in range
    expect([V.fitModeOk("cover"), V.fitModeOk("contain"), V.fitModeOk("fill"), V.fitModeOk(null)]).toEqual(["cover", "contain", "contain", "contain"]);
  });
  it("Fill (cover): the smallest scale that fills both sides, centred; the overflow cropped on one axis only", () => {
    expect(V.fitScene(1280, 720, STAGE, "cover")).toEqual({ k: 600 / 720, x: (960 - 1280 * (600 / 720)) / 2, y: 0 });
    const v = V.fitScene(1280, 720, { w: 2231, h: 1018 }, "cover");
    expect(v.k).toBeCloseTo(2231 / 1280, 9);
    expect(v.x).toBeCloseTo(0, 9);
    expect(v.y).toBeCloseTo((1018 - 720 * v.k) / 2, 9);                    // above and below cropped evenly
    expect(v.y).toBeLessThan(0);
    for (const size of [STAGE, { w: 2231, h: 1018 }, { w: 390, h: 700 }]) {
      const c = V.fitScene(1280, 720, size, "cover"), n = V.fitScene(1280, 720, size, "contain");
      expect(1280 * c.k).toBeGreaterThanOrEqual(size.w - 1e-9); expect(720 * c.k).toBeGreaterThanOrEqual(size.h - 1e-9);
      expect(1280 * n.k).toBeLessThanOrEqual(size.w + 1e-9); expect(720 * n.k).toBeLessThanOrEqual(size.h + 1e-9);
      expect(V.clampPan(c, 1280, 720, size)).toEqual(c);                 // a fit is already on the scene
      expect(V.clampPan(n, 1280, 720, size)).toEqual(n);
    }
  });
  it("the opening: zones fitted (the office's mode); the desks from the top left at the pixel level nearest one CSS px", () => {
    expect(V.openingView(1280, 720, STAGE, 1, true)).toEqual(V.fitScene(1280, 720, STAGE));
    expect(V.openingView(1280, 720, STAGE, 2, true, "cover")).toEqual(V.fitScene(1280, 720, STAGE, "cover"));
    expect([V.desksK(1), V.desksK(1.25), V.desksK(1.5), V.desksK(2), V.desksK(3)]).toEqual([1, 0.8, 4 / 3, 1, 1]);
    expect(V.openingView(960, 2000, STAGE, 1.5, false)).toEqual({ k: 4 / 3, x: 0, y: 0 });
  });
  it("clampPan: the scene never goes off-screen — larger than the panel it covers it (no gap), smaller it is centred on that axis (#2585 B)", () => {
    expect(V.clampPan({ k: 1, x: 5000, y: -5000 }, 1280, 720, STAGE)).toEqual({ k: 1, x: 0, y: 600 - 720 });
    expect(V.clampPan({ k: 1, x: -5000, y: 5000 }, 1280, 720, STAGE)).toEqual({ k: 1, x: 960 - 1280, y: 0 });
    expect(V.clampPan({ k: 2, x: -300, y: -200 }, 1280, 720, STAGE)).toEqual({ k: 2, x: -300, y: -200 });   // inside: as it is
    // Smaller than the panel (zoomed out): centred, wherever it was dragged (the canvas's middle is the scene's).
    expect(V.clampPan({ k: 0.5, x: -100, y: 900 }, 1280, 720, STAGE)).toEqual({ k: 0.5, x: (960 - 640) / 2, y: (600 - 360) / 2 });
    expect(V.clampPan({ k: 0.5, x: 200, y: 100 }, 1280, 720, STAGE)).toEqual({ k: 0.5, x: 160, y: 120 });
    // Smaller on one axis only: centred on that one, kept on the scene on the other.
    expect(V.clampPan({ k: 1, x: 37, y: -50 }, 760, 1400, STAGE)).toEqual({ k: 1, x: (960 - 760) / 2, y: -50 });
    expect(V.clampPan({ k: 1, x: -400, y: 300 }, 2000, 300, STAGE)).toEqual({ k: 1, x: -400, y: 150 });
    // A kept view from a bigger panel (k 1 centred on a 2231 px stage), restored on 975 × 720: the scene's left edge
    // was cut off and its frame stuck at the overview's left; clamped, the scene covers the stage.
    const kept = V.savedOf({ k: 1, x: (2231 - 1280) / 2, y: 149 }, { w: 2231, h: 1018 });
    const back = V.clampPan(V.viewFromSaved(kept, { w: 975, h: 720 }), 1280, 720, { w: 975, h: 720 });
    expect(back.x).toBeLessThanOrEqual(0); expect(back.x).toBeGreaterThanOrEqual(975 - 1280);
    expect(back.y).toBe(0);
  });
  it("the kept view: the zoom and the logical point in the middle; restored about the same point at this screen's level; odd ones refused", () => {
    const v = { k: 2, x: -800, y: -420 };
    const s = V.savedOf(v, STAGE);
    expect(s).toEqual({ k: 2, cx: 640, cy: 360 });
    expect(V.viewFromSaved(s, { w: 1200, h: 800 })).toEqual({ k: 2, x: 600 - 1280, y: 400 - 720 });
    expect(V.viewFromSaved({ k: 1.333, cx: 640, cy: 360 }, STAGE).k).toBe(1.333);   // a fit's non-integer zoom: as kept
    expect(V.savedOf(v, STAGE, true)).toEqual({ k: 2, cx: 640, cy: 360, fit: true });   // a fit: fitted again when restored
    expect(V.savedOk({ k: 1, cx: 1, cy: 2, fit: true })).toEqual({ k: 1, cx: 1, cy: 2, fit: true });
    expect(V.savedOk({ k: 1, cx: 1, cy: 2, fit: "yes" })).toEqual({ k: 1, cx: 1, cy: 2 });
    expect([V.savedOk({ k: "2", cx: 1, cy: 1 }), V.savedOk({ k: 0, cx: 1, cy: 1 }), V.savedOk({ k: 1, cx: NaN, cy: 1 }), V.savedOk(null), V.savedOk({ k: 1, cx: 1e9, cy: 0 })])
      .toEqual([null, null, null, null, null]);
    expect(V.savedOk({ k: 99, cx: 1, cy: 2 })).toEqual({ k: V.OK_MAX, cx: 1, cy: 2 });
  });
  it("the store keeps a view per office and style, the most recent few; blocked storage keeps nothing and throws nothing", () => {
    const m = new Map<string, string>();
    const storage = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); } };
    const st = SK.createOfficeStore({ storage });
    st.saveView("auto@studio", { k: 2, cx: 640.12345, cy: 360 });
    expect(st.view("auto@studio")).toEqual({ k: 2, cx: 640.123, cy: 360 });
    expect(st.view("auto@pixel")).toBeNull();
    expect(JSON.parse(m.get("agend_org_office_view")!)).toEqual({ "auto@studio": [2, 640.123, 360] });
    for (let i = 0; i < 40; i++) st.saveView(`o${i}@studio`, { k: 1, cx: i, cy: 0 });
    const kept = Object.keys(JSON.parse(m.get("agend_org_office_view")!));
    expect([kept.length, kept.at(-1), kept.includes("auto@studio")]).toEqual([32, "o39@studio", false]);
    m.set("agend_org_office_view", "{ nope");
    expect(st.view("o39@studio")).toBeNull();
    st.saveView("fit@studio", { k: 1.4, cx: 640, cy: 360, fit: true });
    expect(JSON.parse(m.get("agend_org_office_view")!)["fit@studio"]).toEqual([1.4, 640, 360, 1]);
    expect(st.view("fit@studio")).toEqual({ k: 1.4, cx: 640, cy: 360, fit: true });
    // The fit mode: per office and style, "contain" unless Fill was chosen; only Fill is written.
    expect(st.fitMode("auto@studio")).toBe("contain");
    st.saveFitMode("auto@studio", "cover"); st.saveFitMode("ops@studio", "cover");
    expect([st.fitMode("auto@studio"), st.fitMode("ops@studio"), st.fitMode("auto@pixel")]).toEqual(["cover", "cover", "contain"]);
    st.saveFitMode("auto@studio", "contain");
    expect(JSON.parse(m.get("agend_org_office_fit")!)).toEqual({ "ops@studio": "cover" });
    m.set("agend_org_office_fit", JSON.stringify({ "ops@studio": "sideways" }));
    expect(st.fitMode("ops@studio")).toBe("contain");
    const blocked = SK.createOfficeStore({ storage: { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } } });
    expect(() => blocked.saveView("a@b", { k: 1, cx: 0, cy: 0 })).not.toThrow();
    expect(blocked.view("a@b")).toBeNull();
    expect(() => blocked.saveFitMode("a@b", "cover")).not.toThrow();
    expect(blocked.fitMode("a@b")).toBe("contain");
  });
  it("the overview's box: inside the stage with a margin at the bottom right, the scene's aspect, scaled to the stage", () => {
    for (const size of [STAGE, { w: 2231, h: 1018 }, { w: 1331, h: 1018 }, { w: 500, h: 360 }, { w: 300, h: 200 }]) {
      const b = V.miniBox(size, 1280, 720);
      expect(b.x).toBeGreaterThanOrEqual(12); expect(b.y).toBeGreaterThanOrEqual(12);
      expect(b.x + b.w).toBe(size.w - 12); expect(b.y + b.h).toBe(size.h - 12);
      expect(Math.abs(b.w / b.h - 16 / 9)).toBeLessThan(0.05);
    }
    expect(V.miniBox({ w: 2231, h: 1018 }, 1280, 720).w).toBe(280);         // a big panel: the largest
    expect(V.miniBox(STAGE, 1280, 720).w).toBe(Math.round(960 / 7));        // scaled to the stage
    expect(V.miniBox({ w: 500, h: 360 }, 1280, 720).w).toBe(120);           // a small one: the smallest
    const tall = V.miniBox(STAGE, 960, 4000);                              // a tall desks layout: a third of the height at most
    expect(tall.h).toBeLessThanOrEqual(200); expect(tall.y + tall.h).toBe(588);
  });
  it("the overview's frame: the part of the scene in view, never outside it; the zoom's label", () => {
    expect(V.miniFrame({ k: 0.75, x: 0, y: 30 }, STAGE, 1280, 720)).toEqual({ x: 0, y: 0, width: 1280, height: 720 });
    expect(V.miniFrame({ k: 2, x: -300, y: -200 }, STAGE, 1280, 720)).toEqual({ x: 150, y: 100, width: 480, height: 300 });
    const f = V.miniFrame({ k: 1, x: 480, y: 0 }, STAGE, 1280, 720);
    expect([f.x, f.width]).toEqual([0, 480]);
    expect([V.zoomLabel(1), V.zoomLabel(0.75), V.zoomLabel(1018 / 720), V.zoomLabel(8)]).toEqual(["100%", "75%", "141%", "800%"]);
  });
  it("the layers' resolution: the view's own; over the budget, divided by a whole number (an integer, crisp scale-up)", () => {
    expect(V.layerScale(2, 1280, 720)).toBe(2);
    const a = 6, ls = V.layerScale(a, 1280, 720);
    expect(Number.isInteger(a / ls)).toBe(true);
    expect(Math.ceil(1280 * ls) * Math.ceil(720 * ls)).toBeLessThanOrEqual(V.LAYER_MAX.area * 1.01);
    expect(V.layerScale(0.4, 20000, 20000)).toBeLessThanOrEqual(0.4);
  });
  it("edgeMatte: the mean of the opaque edge pixels as #rrggbb; none opaque: null", () => {
    const px = (...rgba: number[][]) => new Uint8ClampedArray(rgba.flat());
    expect(V.edgeMatte([px([10, 20, 30, 255], [30, 40, 50, 255]), px([20, 30, 40, 255], [0, 0, 0, 0])])).toBe("#141e28");
    expect(V.edgeMatte([px([255, 255, 255, 0])])).toBeNull();
    expect(V.edgeMatte([])).toBeNull();
  });
});

describe("the pack's matte: the page's check and the host's are the same", () => {
  it("#rrggbb only, lower-cased; anything else refused with where it broke; absent: none", () => {
    const m = MANIFEST();
    expect(PK.checkSkinPack({ ...m, matte: "#1B1D24" })).toMatchObject({ ok: true, pack: { matte: "#1b1d24" } });
    expect(PK.skinPackOk(m).matte).toBeUndefined();
    for (const bad of ["#fff", "1b1d24", "#1b1d2", "#1b1d24ff", "red", "rgb(1,2,3)", 0x1b1d24, null, "#gggggg"]) {
      expect(PK.checkSkinPack({ ...m, matte: bad }), String(bad)).toEqual({ ok: false, error: "matte: a colour as #rrggbb" });
    }
    expect([PK.matteOk("#abcdef"), PK.matteOk("#ABCDEF"), PK.matteOk(" #abcdef")]).toEqual([true, true, false]);
  });
});

describe("the pack's foreground and y-sorted furniture: the page's check", () => {
  const item = (id: string, depth: unknown) => ({ id, sprite: { src: "fox_idle.png", frames: 4, w: 32, h: 48 }, x: 100, y: 100, ...(depth === undefined ? {} : { depth }) });
  it("foreground: a file name in the pack, with stateZones only; listed among the pack's images", () => {
    const m = MANIFEST();
    const pk = PK.skinPackOk({ ...m, foreground: "front.png" });
    expect(pk.foreground).toBe("front.png");
    expect(PK.packImages(pk)).toContain("front.png");
    expect(PK.skinPackOk(m).foreground).toBeUndefined();
    for (const bad of ["../x.png", "/x.png", 7, ""]) expect(PK.checkSkinPack({ ...m, foreground: bad }), String(bad)).toEqual({ ok: false, error: "foreground: a file name in the pack" });
    const { stateZones: _z, ...desks } = m;
    expect(PK.checkSkinPack({ ...desks, foreground: "front.png" })).toEqual({ ok: false, error: "foreground: only with stateZones" });
  });
  it('depth "y" is kept (among the people, after the numbers under them); numbers keep their meaning; any other string is refused', () => {
    const m = MANIFEST();
    const pk = PK.skinPackOk({ ...m, furniture: [item("over", 1000), item("pillar", "y"), item("rug", 5), item("plain", undefined)] });
    expect(pk.furniture.map((f: any) => [f.id, f.depth])).toEqual([["plain", 0], ["rug", 5], ["pillar", "y"], ["over", 1000]]);
    for (const bad of ["Y", "x", "", "5", 1.5, true]) {
      expect(PK.checkSkinPack({ ...m, furniture: [item("pillar", bad)] }), String(bad)).toEqual({ ok: false, error: 'furniture[0].depth: a whole number from -10000 to 10000, or "y"' });
    }
  });
});

// ── On the page ──

function fakeCtx(px: number[] = [0, 0, 0, 0]) {
  const calls: Array<[string, any[], any?]> = [];
  const t: any = { calls, measureText: (s: string) => ({ width: [...String(s)].length * 6 }), createPattern: () => ({ pattern: true }),
    getImageData: (_x: number, _y: number, w: number, hh: number) => ({ data: new Uint8ClampedArray(Array.from({ length: w * hh }, () => px).flat()) }) };
  return new Proxy(t, { get(o, k) { if (k in o) return o[k]; return (...a: unknown[]) => { calls.push([String(k), a, k === "fillRect" ? o.fillStyle : undefined]); }; }, set(o, k, v) { o[k] = v; return true; } });
}

describe("the Office canvas on the page", () => {
  const proto = MiniElement.prototype as any;
  let edge: number[] = [0, 0, 0, 0];
  beforeEach(() => { edge = [0, 0, 0, 0]; proto.getContext = function () { return (this._ctx ??= fakeCtx(edge)); }; });
  afterEach(() => {
    delete proto.getContext;
    delete (globalThis as any).AgendAuth; delete (p.window as any).AgendAuth;
  });
  const mount = async () => { await p.mount(h(fleet.FleetPanel, { route: { panel: "fleet", tab: "org" }, navKey: `fleet:org|${Math.random()}|en` })); await settle(6); };
  const office = async () => { await mount(); p.root.querySelectorAll(".oc-tools .seg-inline button")[2].click(); await settle(6); };
  const studio = () => localStorage.setItem("agend_org_office_skin", "studio");
  /** The view, read back from the overview's frame (its data-k/x/y: the whole view; x, y, width, height: the part in view). */
  const shown = () => {
    const r = p.root.querySelector(".oo-mini-view");
    const [k, x, y] = ["data-k", "data-x", "data-y"].map((a) => Number(r.getAttribute(a)));
    return { k, x, y };
  };
  const clamped = (v: any, size = STAGE) => V.clampPan(v, 1280, 720, size);
  const near = (a: any, b: any) => { expect(a.k).toBeCloseTo(b.k, 6); expect(a.x).toBeCloseTo(b.x, 6); expect(a.y).toBeCloseTo(b.y, 6); };
  const key = async (k: string) => { fire(p.root.querySelector(".oo-canvas"), "keydown", { key: k }); await settle(2); };

  it("full-bleed: the canvas is the stage (its bitmap too), the zones scene opens whole; the controls and the overview are there", async () => {
    studio(); await office();
    const cv = p.root.querySelector(".oo-canvas");
    expect([cv.style.width, cv.style.height, cv.width, cv.height]).toEqual(["960px", "600px", 960, 600]);
    expect([cv.getAttribute("role"), cv.getAttribute("tabindex")]).toEqual(["application", "0"]);
    expect(p.root.querySelectorAll(".oo-zoom button").map((b: any) => b.getAttribute("aria-label")))
      .toEqual(["Zoom in", "Zoom out", "Fit the office", "Fill the panel (the scene's overflow is cropped; drag to see it)", "Fullscreen"]);
    near(shown(), V.fitScene(1280, 720, STAGE));
    expect(p.root.querySelector(".oo-mini").getAttribute("viewBox")).toBe("0 0 1280 720");
    // The overview: inside the stage, bottom right, scaled to it; its frame on the scene (here: all of it).
    const mini = p.root.querySelector(".oo-mini"), b = V.miniBox(STAGE, 1280, 720);
    expect(["left", "top", "width", "height"].map((a) => mini.style[a])).toEqual([`${b.x}px`, `${b.y}px`, `${b.w}px`, `${b.h}px`]);
    expect(["x", "y", "width", "height"].map((a) => Number(p.root.querySelector(".oo-mini-view").getAttribute(a)))).toEqual([0, 0, 1280, 720]);
    // The zoom's percentage beside the buttons, first in the group.
    const pct = p.root.querySelector(".oo-zoom .oo-zoom-pct");
    expect([pct.textContent, pct.getAttribute("aria-label")]).toEqual(["75%", "Zoom 75%"]);
    expect(p.root.querySelector(".oo-zoom").children[0]).toBe(pct);
    expect(p.root.querySelectorAll(".oo-mini-dot").length).toBe(3);
  });
  it("Fill: a toggle beside Fit — cover (the panel filled, the overflow cropped and pannable), kept per office, 0 and a resize fit by it", async () => {
    const RO = (globalThis as any).ResizeObserver;
    let measure: any = null;
    (globalThis as any).ResizeObserver = class { constructor(fn: any) { measure = fn; } observe() {} disconnect() {} };
    try { studio(); await office(); } finally { (globalThis as any).ResizeObserver = RO; }
    const fill = () => p.root.querySelector(".oo-zoom .oo-fill");
    const order = p.root.querySelectorAll(".oo-zoom button").map((b: any) => b.className.split(" ")[1]);
    expect(order.indexOf("oo-fill")).toBe(order.indexOf("oo-fit") + 1);   // next to Fit
    expect([fill().textContent, fill().getAttribute("aria-pressed")]).toEqual(["Fill", "false"]);
    fill().click(); await settle(2);
    const cover = V.fitScene(1280, 720, STAGE, "cover");
    near(shown(), cover);
    expect(fill().getAttribute("aria-pressed")).toBe("true");
    expect(p.root.querySelector(".oo-zoom-pct").textContent).toBe("83%");
    expect(JSON.parse(localStorage.getItem("agend_org_office_fit")!)).toEqual({ "auto@studio": "cover" });
    // The cropped sides are a drag away, never further than the scene's edge.
    const cv = p.root.querySelector(".oo-canvas");
    fire(cv, "pointerdown", { pointerId: 1, pointerType: "mouse", button: 0, clientX: 100, clientY: 100 });
    fire(cv, "pointermove", { pointerId: 1, pointerType: "mouse", clientX: 400, clientY: 100 });
    fire(cv, "pointerup", { pointerId: 1, pointerType: "mouse" }); await settle(2);
    near(shown(), { k: cover.k, x: 0, y: 0 });
    await key("0");                                                        // Fit goes by the mode: cover again
    near(shown(), cover);
    // A resize fits it again, to the new size, in its mode.
    Object.defineProperty(proto, "clientWidth", { configurable: true, get() { return this.className.includes("oo-stage") ? 1400 : 0; } });
    p.root.querySelector(".oo-stage").clientHeight = 700;
    try {
      measure(); await settle(4);
      near(shown(), V.fitScene(1280, 720, { w: 1400, h: 700 }, "cover"));
      expect(p.root.querySelector(".oo-canvas").style.width).toBe("1400px");
    } finally { delete proto.clientWidth; p.root.querySelector(".oo-stage").clientHeight = 0; }
    // Kept for this office: it opens filled; Desks (another style) is not.
    await p.unmount(); await office();
    near(shown(), cover);
    expect(fill().getAttribute("aria-pressed")).toBe("true");
    const style = p.root.querySelectorAll(".oo-bar select")[1];
    style.value = "pixel"; fire(style, "change"); await settle(6);
    expect(fill().getAttribute("aria-pressed")).toBe("false");
    // Off again: contain.
    style.value = "studio"; fire(style, "change"); await settle(6);
    fill().click(); await settle(2);
    near(shown(), V.fitScene(1280, 720, STAGE));
    expect(fill().getAttribute("aria-pressed")).toBe("false");
    expect(JSON.parse(localStorage.getItem("agend_org_office_fit")!)).toEqual({});
  });
  it("Fill and the zoom label in both languages", async () => {
    const I = await import("/assets/app-i18n.js");
    I.setLang("zh-TW", { store: false });
    try { expect([I.t("orgo.fill"), I.t("orgo.zoomLevel", "141%")]).toEqual(["填滿", "縮放 141%"]); expect(I.t("orgo.fillTitle")).toContain("填滿"); }
    finally { I.setLang("en", { store: false }); }
    expect([I.t("orgo.fill"), I.t("orgo.zoomLevel", "141%")]).toEqual(["Fill", "Zoom 141%"]);
  });
  it("+ - 0 on the canvas (and the buttons): level by level about the middle, then Fit; none in a form field or with a modifier", async () => {
    studio(); await office();
    const v0 = V.fitScene(1280, 720, STAGE);
    await key("+");
    const v1 = clamped(CV.zoomTo(v0, V.stepK(0.75, 1, 1), 480, 300));
    near(shown(), v1);
    await key("=");
    near(shown(), clamped(CV.zoomTo(v1, 1, 480, 300)));
    expect(p.root.querySelector(".oo-zoom-pct").textContent).toBe("100%");
    p.root.querySelector(".oo-zoom-in").click(); await settle(2);
    expect(shown().k).toBe(2);
    expect(p.root.querySelector(".oo-zoom-pct").textContent).toBe("200%");
    await key("-");
    expect(shown().k).toBe(1);
    fire(p.root.querySelector(".oo-canvas"), "keydown", { key: "+", ctrlKey: true }); await settle(2);
    expect(shown().k).toBe(1);                                          // the browser's own zoom
    await key("0");
    near(shown(), v0);
    p.root.querySelector(".oo-zoom-in").click(); await settle(2);
    p.root.querySelector(".oo-fit").click(); await settle(2);
    near(shown(), v0);
    p.root.querySelector(".oo-zoom-out").click(); await settle(2);
    expect(shown().k).toBeCloseTo(0.6, 9);
  });
  it("a drag pans (the click that ends it opens nothing, the scene kept on screen); the wheel and a pinch zoom continuously about the pointer", async () => {
    studio(); await office();
    const cv = p.root.querySelector(".oo-canvas"), v0 = shown();
    fire(cv, "pointerdown", { pointerId: 1, pointerType: "mouse", button: 0, clientX: 100, clientY: 100 });
    fire(cv, "pointermove", { pointerId: 1, pointerType: "mouse", clientX: 102, clientY: 101 });   // under the slop: not yet
    near(shown(), v0);
    fire(cv, "pointermove", { pointerId: 1, pointerType: "mouse", clientX: 160, clientY: 130 });
    fire(cv, "pointerup", { pointerId: 1, pointerType: "mouse", clientX: 160, clientY: 130 });
    // As wide as the stage and shorter (960 × 540 in 960 × 600): it covers the width and is centred on the height
    // (#2585 B), so this drag moves it neither way.
    near(shown(), clamped({ k: v0.k, x: v0.x + 58, y: v0.y + 29 }));
    expect([shown().x, shown().y]).toEqual([0, 30]);
    fire(cv, "click", { clientX: 160, clientY: 130 });
    expect(location.pathname).toBe("/ui/fleet/org");
    await settle(2);
    // The wheel: continuous (only + and − go by pixel levels), the point under the pointer kept.
    const before = shown();
    fire(cv, "wheel", { deltaY: -500, clientX: 300, clientY: 200 }); await settle(2);
    const w = shown();
    expect(w.k).toBeCloseTo(0.75 * Math.exp(0.75), 9);                   // 1.59, not snapped
    expect(CV.toWorld(w, 300, 200).x).toBeCloseTo(CV.toWorld(before, 300, 200).x, 6);
    // A pinch: two fingers, their span doubled → twice the zoom, the point under the midpoint follows it.
    fire(cv, "pointerdown", { pointerId: 7, pointerType: "touch", clientX: 400, clientY: 300 });
    fire(cv, "pointerdown", { pointerId: 8, pointerType: "touch", clientX: 500, clientY: 300 });
    const at = CV.toWorld(shown(), 450, 300);
    fire(cv, "pointermove", { pointerId: 8, pointerType: "touch", clientX: 600, clientY: 300 });
    fire(cv, "pointerup", { pointerId: 7, pointerType: "touch" }); fire(cv, "pointerup", { pointerId: 8, pointerType: "touch" });
    const pv = shown();
    expect(pv.k).toBeCloseTo(2 * 0.75 * Math.exp(0.75), 9);
    expect(CV.toWorld(pv, 500, 300).x).toBeCloseTo(at.x, 6);
  });
  it("hover and click hit through the view: zoomed in and panned, a person opens where they are drawn", async () => {
    studio(); await office();
    await key("+"); await key("+"); await key("+");                       // 0.9375, 1, 2
    const cv = p.root.querySelector(".oo-canvas");
    expect(shown().k).toBe(2);
    fire(cv, "pointerdown", { pointerId: 1, pointerType: "mouse", button: 0, clientX: 500, clientY: 300 });
    fire(cv, "pointermove", { pointerId: 1, pointerType: "mouse", clientX: 400, clientY: 250 });
    fire(cv, "pointerup", { pointerId: 1, pointerType: "mouse" });
    await settle(2);
    const v = shown();
    expect(v.k).toBe(2);
    const nodes = [{ name: "atlas", state: "idle" }, { name: "quill", state: "working" }, { name: "sage", state: "paused" }].map((n) => ({ ...n, i: { name: n.name } }));
    const seat = Z.zonesLayout(K.STUDIO_PACK, nodes).seats.get("quill");
    const s = CV.toScreen(v, seat.x, seat.y - 20);
    fire(cv, "pointermove", { clientX: s.x, clientY: s.y, pointerType: "mouse" }); await settle(2);
    expect(p.root.querySelector(".oo-tip strong")?.textContent).toBe("quill");
    fire(cv, "pointerdown", { pointerId: 2, pointerType: "mouse", button: 0, clientX: s.x, clientY: s.y });
    fire(cv, "pointerup", { pointerId: 2, pointerType: "mouse" });
    fire(cv, "click", { clientX: s.x, clientY: s.y }); await settle(2);
    expect(location.pathname).toBe("/ui/chat/quill");
    nav.navigate("/ui/fleet/org"); await settle(2);
    // The same logical point at the opening view's screen position is somewhere else now: nobody there.
    const old = CV.toScreen(V.fitScene(1280, 720, STAGE), seat.x, seat.y - 20);
    fire(cv, "pointermove", { clientX: old.x, clientY: old.y, pointerType: "mouse" }); await settle(2);
    expect(p.root.querySelector(".oo-tip strong")?.textContent ?? null).not.toBe("quill");
  });
  it("#2585 B: a scene smaller than the stage is centred on that axis — opening, a drag, Fit and a zoom out alike", async () => {
    localStorage.setItem("agend_org_office_skin", "pixel"); await office();
    const [, , w, h] = p.root.querySelector(".oo-mini").getAttribute("viewBox").split(" ").map(Number);
    /** Centred on an axis where the scene is smaller; on the other, covering the stage (no gap at either edge). */
    const centred = (v: any, why: string) => {
      const sw = w * v.k, sh = h * v.k;
      if (sw < STAGE.w) expect(v.x, `${why}: x`).toBeCloseTo((STAGE.w - sw) / 2, 6); else { expect(v.x, why).toBeLessThanOrEqual(0); expect(v.x + sw, why).toBeGreaterThanOrEqual(STAGE.w - 1e-6); }
      if (sh < STAGE.h) expect(v.y, `${why}: y`).toBeCloseTo((STAGE.h - sh) / 2, 6); else { expect(v.y, why).toBeLessThanOrEqual(0); expect(v.y + sh, why).toBeGreaterThanOrEqual(STAGE.h - 1e-6); }
    };
    const v0 = shown();
    expect(w * v0.k, "the desks scene is as wide as its rooms: narrower than the stage here").toBeLessThan(STAGE.w);
    expect(v0.x, "not at the stage's left edge").toBeGreaterThan(OM.OF.M);
    centred(v0, "opening");
    const cv = p.root.querySelector(".oo-canvas");
    fire(cv, "pointerdown", { pointerId: 1, pointerType: "mouse", button: 0, clientX: 100, clientY: 100 });
    fire(cv, "pointermove", { pointerId: 1, pointerType: "mouse", clientX: 300, clientY: 260 });
    fire(cv, "pointerup", { pointerId: 1, pointerType: "mouse", clientX: 300, clientY: 260 }); await settle(2);
    centred(shown(), "after a drag");
    await key("0"); centred(shown(), "Fit");
    await key("-"); await key("-");
    const out = shown();
    expect([w * out.k < STAGE.w, h * out.k < STAGE.h], "zoomed out: smaller both ways").toEqual([true, true]);
    centred(out, "zoomed out");
    await key("+"); await key("+"); await key("+"); centred(shown(), "zoomed in");
    await p.unmount();
  });
  it("the view is kept per office and style (a moment after it moves, and when the view goes) and restored, kept on screen", async () => {
    studio(); await office();
    await key("+"); await key("+"); await key("+");
    await new Promise((r) => setTimeout(r, 450));
    const kept = JSON.parse(localStorage.getItem("agend_org_office_view")!);
    expect(Object.keys(kept)).toEqual(["auto@studio"]);
    expect(kept["auto@studio"][0]).toBe(2);
    await p.unmount();
    localStorage.setItem("agend_org_office_view", JSON.stringify({ "auto@studio": [2, 640, 360], "auto@pixel": [3, 10, 10] }));
    await office();
    near(shown(), { k: 2, x: 480 - 640 * 2, y: 300 - 360 * 2 });
    // Desks: its own kept view; Studio's untouched.
    const style = p.root.querySelectorAll(".oo-bar select")[1];
    style.value = "pixel"; fire(style, "change"); await settle(6);
    const d = shown();                                                   // centred on (10, 10): its corner would leave a gap
    expect([d.k, d.x]).toEqual([3, 0]);                                  // wider than the stage: no gap at the left
    expect(d.y).toBeGreaterThanOrEqual(0); expect(d.y).toBeLessThan(300 - 30);   // shorter: wholly inside
    // Moved, then the view goes at once: kept on the way out (a fit: marked so, fitted again next time).
    await key("0"); await p.unmount();
    const after = JSON.parse(localStorage.getItem("agend_org_office_view")!);
    expect(after["auto@studio"]).toEqual([2, 640, 360]);
    expect(after["auto@pixel"][0]).toBeLessThan(3);
    expect(after["auto@pixel"][3]).toBe(1);
  });
  it("Edit layout under zoom: the overlay follows the view; a handle dragged lands on the logical point under the pointer; a drag off the handles pans", async () => {
    const was = (globalThis as any).Image;
    (globalThis as any).Image = class { onload: any = null; onerror: any = null; set src(_u: string) { setTimeout(() => this.onload && this.onload(), 0); } };
    try {
      skins = { rev: "r", packs: [{ id: "clinic-sample", name: "Clinic", sha: "e".repeat(32) }] }; manifestAnswer = { manifest: MANIFEST(), files: FILES };
      offices = { rev: 3, offices: [{ id: "clinic", name: "Clinic", skin: "clinic-sample", members: ["quill"] }] };
      localStorage.setItem("agend_org_office", "clinic");
      const auth = { canWrite: async () => true }; (globalThis as any).AgendAuth = auth; (p.window as any).AgendAuth = auth;
      await office(); await settle(6);
      p.root.querySelector(".oo-layout").click(); await settle(4);
      await key("+"); await key("+"); await key("+");
      const v = shown();
      expect(v.k).toBe(2);
      const ov = p.root.querySelector(".ol-overlay");
      const box = ["left", "top", "width", "height"].map((a) => parseFloat(ov.style[a]));
      expect(box[0]).toBeCloseTo(v.x, 6); expect(box[1]).toBeCloseTo(v.y, 6);
      expect([box[2], box[3]]).toEqual([1280 * 2, 720 * 2]);
      const svg = p.root.querySelector(".ol-svg");
      svg.getBoundingClientRect = () => ({ left: box[0], top: box[1], width: box[2], height: box[3], right: box[0] + box[2], bottom: box[1] + box[3] });
      // A handle: it moves, the view does not.
      const seat = p.root.querySelector('[data-handle="seat:desks:0"]');
      const to = CV.toScreen(v, 300, 300);
      fire(seat, "pointerdown", { pointerId: 3, pointerType: "mouse", button: 0, clientX: CV.toScreen(v, 212, 240).x, clientY: CV.toScreen(v, 212, 240).y });
      fire(svg, "pointermove", { pointerId: 3, pointerType: "mouse", clientX: to.x, clientY: to.y });
      fire(svg, "pointerup", { pointerId: 3, pointerType: "mouse" }); await settle(3);
      expect(p.root.querySelector('[data-handle="seat:desks:0"]').getAttribute("aria-label")).toBe("Seat 1 in desks at 300, 300");
      near(shown(), v);
      // Off the handles, on the overlay: it pans; the overlay goes with it.
      fire(svg, "pointerdown", { pointerId: 4, pointerType: "mouse", button: 0, clientX: 200, clientY: 200 });
      fire(svg, "pointermove", { pointerId: 4, pointerType: "mouse", clientX: 240, clientY: 210 });
      fire(svg, "pointerup", { pointerId: 4, pointerType: "mouse" }); await settle(2);
      near(shown(), { k: 2, x: v.x + 40, y: v.y + 10 });
      expect(parseFloat(p.root.querySelector(".ol-overlay").style.left)).toBeCloseTo(v.x + 40, 6);
      // The keyboard path: the arrows move a handle (never the view); + still zooms with a handle focused.
      fire(p.root.querySelector('[data-handle="seat:desks:0"]'), "keydown", { key: "ArrowRight" }); await settle(2);
      expect(p.root.querySelector('[data-handle="seat:desks:0"]').getAttribute("aria-label")).toBe("Seat 1 in desks at 301, 300");
      near(shown(), { k: 2, x: v.x + 40, y: v.y + 10 });
      fire(p.root.querySelector('[data-handle="seat:desks:0"]'), "keydown", { key: "+" }); await settle(2);
      expect(shown().k).toBe(3);
    } finally { (globalThis as any).Image = was; }
  });
  it("reduced motion: a zoom is drawn at once (never animated)", async () => {
    const real = (globalThis as any).matchMedia;
    (globalThis as any).matchMedia = (q: string) => ({ matches: /reduce/.test(q), addEventListener() {}, removeEventListener() {} });
    try {
      studio(); await office();
      const ctx = p.root.querySelector(".oo-canvas")._ctx;
      const clears = () => ctx.calls.filter(([k]: any) => k === "clearRect").length;
      const n = clears();
      fire(p.root.querySelector(".oo-canvas"), "keydown", { key: "+" });
      expect(clears()).toBe(n + 1);                                       // drawn in the same turn, once
      const last = ctx.calls.filter(([k]: any) => k === "setTransform").at(-1)[1];
      expect(last[0]).toBeCloseTo(V.stepK(0.75, 1, 1), 9);
    } finally { (globalThis as any).matchMedia = real; }
  });
  it("a phone (390 CSS px wide at DPR 3): the canvas is the stage at the device's ratio, the scene opens whole (the exact fit: no level fits), the controls are there", async () => {
    const realDpr = (globalThis as any).devicePixelRatio;
    Object.defineProperty(proto, "clientWidth", { configurable: true, get() { return this.className.includes("oo-stage") ? 390 : 0; } });
    (globalThis as any).devicePixelRatio = 3;
    try {
      studio(); await office();
      const cv = p.root.querySelector(".oo-canvas");
      expect([cv.style.width, cv.style.height, cv.width, cv.height]).toEqual(["390px", "600px", 1170, 1800]);
      expect(shown().k).toBeCloseTo(390 / 1280, 9);                        // the whole width in view
      expect(p.root.querySelectorAll(".oo-zoom button")).toHaveLength(5);
      fire(cv, "keydown", { key: "+" }); await settle(2);
      expect(shown().k * 3).toBeCloseTo(1, 9);                             // + goes onto 1 device px a unit
    } finally { delete proto.clientWidth; (globalThis as any).devicePixelRatio = realDpr; }
  });
  it("the stylesheet: the Office fills the panel (no cap, no auto margins, no frame), the stage pans on touch, the overview leaves a phone", () => {
    const css = readFileSync(join(process.cwd(), "src", "ui", "shared", "app.css"), "utf8");
    // The column: no max-width and no `margin: 0 auto` (in the panel's flex column an auto margin shrank it to its
    // toolbar's width and centred it), the whole width; the containers under it too.
    const col = css.match(/\n\.p-fleet \.panel-body > \.col:has\(> \.oc-office\) \{[^}]*\}/)![0];
    for (const w of ["flex: 1 0 auto", "max-width: none", "padding: 0", "margin: 0;", "width: 100%", "align-self: stretch"]) expect(col).toContain(w);
    expect(css.match(/\n\.oc-office \{[^}]*\}/)![0]).toContain("width: 100%");
    expect(css.match(/\n\.oo \{[^}]*\}/)![0]).toContain("width: 100%");
    for (const sel of [/\n\.oc-office \{[^}]*\}/, /\n\.oo \{[^}]*\}/, /\n\.oo-stage \{[^}]*\}/]) expect(css.match(sel)![0]).not.toMatch(/max-width|aspect-ratio|[^-]height: \d|margin: 0 auto/);
    expect(css.match(/\n\.oo-mini \{[^}]*\}/)![0]).toContain("right: auto; bottom: auto");   // placed by the page (miniBox)
    const stage = css.match(/\n\.oo-stage \{[^}]*\}/)![0];
    expect(stage).toContain("touch-action: none");
    expect(stage).toContain("overflow: hidden");
    expect(stage).not.toMatch(/border|border-radius|height: clamp/);
    const phone = css.slice(css.indexOf(".oc-office > .oc-bar { padding: var(--s-2) var(--s-3); }"));
    expect(phone.slice(0, 600)).toContain(".oo-mini { display: none; }");
  });
  it("draw order: a depth \"y\" item between the people by base y; the foreground after people, furniture and props, before the tags and bubbles", async () => {
    const real = (globalThis as any).matchMedia, was = (globalThis as any).Image;
    (globalThis as any).matchMedia = (q: string) => ({ matches: /reduce/.test(q), addEventListener() {}, removeEventListener() {} });
    (globalThis as any).Image = class { onload: any = null; onerror: any = null; u = ""; set src(u: string) { this.u = u; setTimeout(() => this.onload && this.onload(), 0); } };
    try {
      const m = MANIFEST();
      m.foreground = "front.png";
      // People stand at y 208 (atlas, lounge), 240 (quill, desks) and 572 (sage, nap): the pillar at 400 goes between.
      m.furniture = [{ id: "pillar", sprite: { src: "pillar.png", frames: 1, w: 16, h: 64 }, x: 640, y: 400, depth: "y" },
        { id: "rug", sprite: { src: "pillar.png", frames: 1, w: 16, h: 64 }, x: 40, y: 700, depth: 3 }];
      skins = { rev: "r", packs: [{ id: "clinic-sample", name: "Clinic", sha: "f".repeat(32) }] };
      manifestAnswer = { manifest: m, files: { ...FILES, "front.png": "e".repeat(32), "pillar.png": "9".repeat(32) } };
      localStorage.setItem("agend_org_office_skin", "clinic-sample");
      await office(); await settle(6);
      const c = p.root.querySelector(".oo-canvas")._ctx.calls, frame = c.slice(c.map(([k]: any) => k).lastIndexOf("clearRect"));
      const img = (id: string) => (call: any) => call[0] === "drawImage" && String(call[1][0]?.u).endsWith(`/img/${id}.png`);
      const at = (id: string) => frame.map((call: any, i: number) => (img(id)(call) ? i : -1)).filter((i: number) => i >= 0);
      const fox = at("b".repeat(32)), [rug, pillar] = at("9".repeat(32)), [fg] = at("e".repeat(32));
      const foot = (i: number) => frame[i][1][6] + 44 * 2;                // its box's top + ay·scale: where its feet are
      expect(fox.map(foot).sort((a: number, b: number) => a - b)).toEqual([208, 240, 572]);
      expect(rug).toBeLessThan(Math.min(...fox));                          // a number under 1000: under everyone
      expect(fox.filter((i: number) => i < pillar).map(foot)).toEqual([208, 240]);
      expect(fox.filter((i: number) => i > pillar).map(foot)).toEqual([572]);
      expect(fg).toBeGreaterThan(Math.max(...fox, pillar));
      expect(frame[fg][1].slice(1)).toEqual([0, 0, 1280, 720]);
      const words = frame.map((call: any, i: number) => (call[0] === "fillText" ? i : -1)).filter((i: number) => i >= 0);
      expect(words.length).toBeGreaterThan(0);                            // the name tags (and any bubble): all after it
      expect(Math.min(...words)).toBeGreaterThan(fg);
    } finally { (globalThis as any).matchMedia = real; (globalThis as any).Image = was; }
  });
  it("the matte paints the whole canvas (and the stage): Studio's hall floor, Desks' background token; a pack's own `matte`; else its background's edge, sampled", async () => {
    const lastFrame = () => { const c = p.root.querySelector(".oo-canvas")._ctx.calls; return c.slice(c.map(([k]: any) => k).lastIndexOf("clearRect")); };
    const firstFill = () => lastFrame().find(([k]: any) => k === "fillRect")[2];
    studio(); await office();
    expect(firstFill()).toBe("#262626");                                   // the studio's own (its hall), not the page's grey
    expect(firstFill()).not.toBe(K.DEFAULT_PAL.bg);
    const rect = lastFrame().find(([k]: any) => k === "fillRect")[1];
    expect(rect).toEqual([0, 0, 960, 600]);                                // the whole canvas
    expect(p.root.querySelector(".oo-stage").style["background-color"]).toBe("#262626");
    await p.unmount();
    localStorage.setItem("agend_org_office_skin", "pixel");
    await office();
    expect(firstFill()).toBe(K.DEFAULT_PAL.bg);                            // Desks: its floor is the page's background
    await p.unmount();
    const was = (globalThis as any).Image;
    (globalThis as any).Image = class { onload: any = null; onerror: any = null; set src(_u: string) { setTimeout(() => this.onload && this.onload(), 0); } };
    try {
      skins = { rev: "r", packs: [{ id: "clinic-sample", name: "Clinic", sha: "c".repeat(32) }] }; manifestAnswer = { manifest: { ...MANIFEST(), matte: "#ABCDEF" }, files: FILES };
      localStorage.setItem("agend_org_office_skin", "clinic-sample");
      await office(); await settle(6);
      expect(firstFill()).toBe("#abcdef");
      expect(p.root.querySelector(".oo-mini-matte").getAttribute("fill")).toBe("#abcdef");
      await p.unmount();
      edge = [16, 32, 48, 255];
      skins = { rev: "r", packs: [{ id: "clinic-sample", name: "Clinic", sha: "d".repeat(32) }] }; manifestAnswer = { manifest: MANIFEST(), files: FILES };
      await office(); await settle(6);
      expect(firstFill()).toBe("#102030");
    } finally { (globalThis as any).Image = was; }
  });

  describe("fullscreen", () => {
    const D = () => p.document as any;
    let calls: string[] = [];
    afterEach(() => {
      const d = D();
      for (const k of ["fullscreenElement", "webkitFullscreenElement", "exitFullscreen", "webkitExitFullscreen", "fullscreenEnabled"]) delete d[k];
      d.documentElement.classList.remove("oo-immersive");
    });
    const oo = () => p.root.querySelector(".oo");
    const cls = () => String(oo().className);
    const fsBtn = () => p.root.querySelector(".oo-fs");
    /** The Fullscreen API on the container: `how` "ok" (it goes fullscreen, then the change event), "reject", "throw". */
    const native = (how = "ok", prefix = "") => {
      calls = [];
      const d = D(), el = oo(), elKey = prefix ? "webkitFullscreenElement" : "fullscreenElement";
      const change = () => fire(d, prefix ? "webkitfullscreenchange" : "fullscreenchange");
      el[prefix ? "webkitRequestFullscreen" : "requestFullscreen"] = function () {
        calls.push("request");
        if (how === "throw") throw new Error("no");
        if (how === "reject") return prefix ? (fire(d, "webkitfullscreenerror"), undefined) : Promise.reject(new Error("refused"));
        d[elKey] = this; change();
        return prefix ? undefined : Promise.resolve();
      };
      d[prefix ? "webkitExitFullscreen" : "exitFullscreen"] = () => { calls.push("exit"); d[elKey] = null; change(); return prefix ? undefined : Promise.resolve(); };
    };

    it("the button (labelled, a tooltip): the Fullscreen API on the container; only the stage and its floating controls show; again: out", async () => {
      studio(); await office();
      expect([fsBtn().getAttribute("aria-label"), fsBtn().getAttribute("title")]).toEqual(["Fullscreen", "Fullscreen"]);
      expect(p.root.querySelector(".oo-fs-bar")).toBeNull();
      native();
      fsBtn().click(); await settle(4);
      expect(calls).toEqual(["request"]);
      expect(cls().split(" ")).toEqual(["oo", "fs", "native"]);
      expect([fsBtn().getAttribute("aria-label"), fsBtn().getAttribute("title")]).toEqual(["Exit fullscreen", "Exit fullscreen"]);
      // The floating cluster: zoom, Fit, Exit, the overview and a compact office switcher (all inside the stage).
      const stage = p.root.querySelector(".oo-stage");
      for (const sel of [".oo-zoom", ".oo-mini", ".oo-fs-bar"]) expect(stage.contains(p.root.querySelector(sel)), sel).toBe(true);
      const sw = p.root.querySelector(".oo-fs-office");
      expect([sw.tagName.toLowerCase(), sw.getAttribute("aria-label")]).toEqual(["select", "Office"]);
      expect(D().documentElement.classList.contains("oo-immersive")).toBe(false);   // the API's top layer needs no lift
      fsBtn().click(); await settle(4);
      expect(calls).toEqual(["request", "exit"]);
      expect(cls()).toBe("oo");
      expect(p.root.querySelector(".oo-fs-bar")).toBeNull();
    });
    it("`f` toggles it from the view or with nothing focused; never while typing, with a modifier, or over Edit offices", async () => {
      studio(); await office();
      native();
      fire(p.root.querySelector(".oo-canvas"), "keydown", { key: "f" }); await settle(4);
      expect(cls()).toContain("native");
      fire(p.root.querySelector(".oo-canvas"), "keydown", { key: "F" }); await settle(4);
      expect(cls()).toBe("oo");
      fire(D().body, "keydown", { key: "f" }); await settle(4);
      expect(cls()).toContain("native");
      fire(D().body, "keydown", { key: "f" }); await settle(4);
      calls = [];
      fire(p.root.querySelector(".oo-office"), "keydown", { key: "f" });
      fire(p.root.querySelector(".oo-canvas"), "keydown", { key: "f", ctrlKey: true });
      fire(p.root.querySelector(".oo-canvas"), "keydown", { key: "f", metaKey: true });
      const input = D().createElement("input");
      D().body.appendChild(input);
      fire(input, "keydown", { key: "f" });
      const elsewhere = D().createElement("button");                     // a control outside the view (another panel)
      D().body.appendChild(elsewhere);
      fire(elsewhere, "keydown", { key: "f" });
      input.remove(); elsewhere.remove();
      await settle(4);
      expect(calls).toEqual([]);
      expect(cls()).toBe("oo");
    });
    it("the browser's own way out (fullscreenchange, and webkit's) is followed; webkit's request is used when it is the only one", async () => {
      studio(); await office();
      native();
      fsBtn().click(); await settle(4);
      expect(cls()).toContain("native");
      D().fullscreenElement = null; fire(D(), "fullscreenchange"); await settle(4);   // the person pressed Esc
      expect(cls()).toBe("oo");
      expect(fsBtn().getAttribute("aria-label")).toBe("Fullscreen");
      // Another element going fullscreen is not this view's.
      D().fullscreenElement = D().body; fire(D(), "fullscreenchange"); await settle(4);
      expect(cls()).toBe("oo");
      D().fullscreenElement = null;
      delete oo().requestFullscreen; delete D().exitFullscreen;
      native("ok", "webkit");
      fsBtn().click(); await settle(4);
      expect([calls, cls()]).toEqual([["request"], "oo fs native"]);
      D().webkitFullscreenElement = null; fire(D(), "webkitfullscreenchange"); await settle(4);
      expect(cls()).toBe("oo");
    });
    it("immersive where the API is missing (an iPhone), disabled, rejected or throws: the container covers the window; Esc leaves", async () => {
      studio(); await office();
      const root = D().documentElement;
      fsBtn().click(); await settle(4);                                  // no requestFullscreen at all
      expect(cls()).toBe("oo fs immersive");
      expect(root.classList.contains("oo-immersive")).toBe(true);
      expect(fsBtn().getAttribute("aria-label")).toBe("Exit fullscreen");
      fire(p.root.querySelector(".oo-canvas"), "keydown", { key: "Escape" }); await settle(4);
      expect(cls()).toBe("oo");
      expect(root.classList.contains("oo-immersive")).toBe(false);
      for (const how of ["reject", "throw", "disabled", "webkit-error"]) {
        if (how === "webkit-error") { delete oo().requestFullscreen; native("reject", "webkit"); } else native(how === "disabled" ? "ok" : how);
        if (how === "disabled") D().fullscreenEnabled = false;
        fsBtn().click(); await settle(4);
        expect(cls(), how).toBe("oo fs immersive");
        expect(calls, how).toEqual(how === "disabled" ? [] : ["request"]);
        if (how === "disabled") delete D().fullscreenEnabled;
        fire(D().body, "keydown", { key: "f" }); await settle(4);       // `f` leaves it too
        expect(cls(), how).toBe("oo");
        expect(root.classList.contains("oo-immersive")).toBe(false);
      }
      fire(D().body, "keydown", { key: "Escape" }); await settle(4);    // Esc out of fullscreen: nothing to do
      expect(cls()).toBe("oo");
    });
    it("in fullscreen the stage re-fits to its new size (untouched), and keeps the same point in the middle once moved; live updates go on", async () => {
      const RO = (globalThis as any).ResizeObserver;
      let measure: any = null;
      (globalThis as any).ResizeObserver = class { constructor(fn: any) { measure = fn; } observe() {} disconnect() {} };
      try { studio(); await office(); } finally { (globalThis as any).ResizeObserver = RO; }
      fsBtn().click(); await settle(4);
      let W = 1700;
      Object.defineProperty(proto, "clientWidth", { configurable: true, get() { return this.className.includes("oo-stage") ? W : 0; } });
      p.root.querySelector(".oo-stage").clientHeight = 900;               // a plain field in the test page
      try {
        measure(); await settle(4);
        const cv = p.root.querySelector(".oo-canvas");
        expect([cv.style.width, cv.style.height]).toEqual(["1700px", "900px"]);
        near(shown(), V.fitScene(1280, 720, { w: 1700, h: 900 }));          // the opening again: fitted to the new size
        // Moved (zoomed in), then resized: the logical point in the middle stays there.
        p.root.querySelector(".oo-zoom-in").click(); await settle(2);
        const mid = () => { const f = p.root.querySelector(".oo-mini-view"), n = (a: string) => Number(f.getAttribute(a));
          return [n("x") + n("width") / 2, n("y") + n("height") / 2]; };
        const m0 = mid();
        W = 1500; measure(); await settle(4);
        expect(p.root.querySelector(".oo-canvas").style.width).toBe("1500px");
        expect(mid()[0]).toBeCloseTo(m0[0], 6);
        expect(mid()[1]).toBeCloseTo(m0[1], 6);
        expect(p.root.querySelectorAll(".oo-mini-dot.st-working")).toHaveLength(1);
        app.appStore.set({ ...STORE, exec: { quill: "working", atlas: "working" } }); await settle(6);
        expect(p.root.querySelectorAll(".oo-mini-dot.st-working")).toHaveLength(2);
        expect(cls()).toBe("oo fs immersive");
      } finally { delete proto.clientWidth; p.root.querySelector(".oo-stage").clientHeight = 0; }
    });
    it("a desk's chat leaves fullscreen first", async () => {
      studio(); await office();
      fsBtn().click(); await settle(4);
      p.root.querySelector('.oo-desk[data-name="atlas"]').click(); await settle(4);
      expect(location.pathname).toContain("atlas");
      expect(cls()).toBe("oo");
      expect(D().documentElement.classList.contains("oo-immersive")).toBe(false);
    });
    it("unmounting leaves it: the API's fullscreen is exited, immersive's lift removed, the listeners gone", async () => {
      const d = D(), before = ["fullscreenchange", "webkitfullscreenchange", "fullscreenerror", "keydown"].map((k) => d.listenerCount(k));
      studio(); await office();
      native();
      fsBtn().click(); await settle(4);
      expect(cls()).toContain("native");
      await p.unmount();
      expect(calls).toEqual(["request", "exit"]);
      expect(["fullscreenchange", "webkitfullscreenchange", "fullscreenerror", "keydown"].map((k) => d.listenerCount(k))).toEqual(before);
      await office();
      fsBtn().click(); await settle(4);                                  // no API this time: immersive
      expect(cls()).toBe("oo fs immersive");
      expect(d.documentElement.classList.contains("oo-immersive")).toBe(true);
      await p.unmount();
      expect(d.documentElement.classList.contains("oo-immersive")).toBe(false);
    });
    it("its words in both languages; the stylesheet: only the stage shows, immersive covers the window (safe areas kept) above the chrome", async () => {
      const I = await import("/assets/app-i18n.js");
      I.setLang("zh-TW", { store: false });
      try { expect([I.t("orgo.fullscreen"), I.t("orgo.exitFullscreen")]).toEqual(["全螢幕", "結束全螢幕"]); } finally { I.setLang("en", { store: false }); }
      expect([I.t("orgo.fullscreen"), I.t("orgo.exitFullscreen")]).toEqual(["Fullscreen", "Exit fullscreen"]);
      const css = readFileSync(join(process.cwd(), "src", "ui", "shared", "app.css"), "utf8");
      expect(css).toContain(".oo.fs > :not(.oo-stage) { display: none; }");
      expect(css).toContain(".oo.fs > .oo-stage { flex: 1 1 auto; min-height: 0; }");
      expect(css).toContain("padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);");
      const imm = css.match(/\n\.oo\.fs\.immersive \{[^}]*\}/)![0];
      for (const w of ["position: fixed", "inset: 0", "width: 100dvw", "height: 100dvh", "z-index: 50"]) expect(imm).toContain(w);
      expect(css).toContain("html.oo-immersive .p-fleet > .panel-body { z-index: 50; }");
      expect(css).toContain("html.oo-immersive, html.oo-immersive body { overflow: hidden; }");
    });
  });
});
