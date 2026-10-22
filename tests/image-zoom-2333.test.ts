/**
 * #2333: zoom and pan in the chat image lightbox. A 1500×5581 before/after sheet opened fitted at ~15% and could not be
 * zoomed. Here: the zoom math (pure), the controller driven by the events a browser sends (fakes for the stage and
 * the picture, so positions are known), and the lightbox's toolbar and keys in the mini DOM. What a browser draws is
 * the PR's smoke (Chromium + WebKit, desk + phone).
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { fire, installDom, settle } from "./helpers/mini-dom.js";
import { h, page, type AppPage } from "./helpers/app-harness.js";

let Z: any;
beforeAll(async () => {
  // @ts-expect-error — a JS module of the app, with no types
  Z = await import("../src/ui/image-zoom.js");
});

const TALL = { w: 1500, h: 5581 };
const DESK = { x: 16, y: 56, w: 1334, h: 812 };   // a 1366×884 stage inside the lightbox's padding
const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;

describe("the zoom math", () => {
  it("fit shows the whole picture and never enlarges; fit width spans the view", () => {
    expect(Z.fitScale(DESK, TALL)).toBeCloseTo(812 / 5581, 9);
    expect(Z.fitWidthScale(DESK, TALL)).toBeCloseTo(1334 / 1500, 9);
    expect(Z.fitScale(DESK, { w: 200, h: 100 })).toBe(1);
    expect(Z.fitWidthScale(DESK, { w: 200, h: 100 })).toBe(1);
  });

  it("fit centres the picture; fit width starts at the top, centred across", () => {
    const f = Z.fitView(DESK, TALL);
    expect(near(f.ty, DESK.y) && near(f.tx, DESK.x + (DESK.w - TALL.w * f.s) / 2)).toBe(true);
    const w = Z.fitWidthView(DESK, TALL);
    expect([near(w.tx, DESK.x), near(w.ty, DESK.y)]).toEqual([true, true]);
  });

  it("zooming keeps the picture point under the cursor where it is", () => {
    const f = Z.fitView(DESK, TALL);
    const px = 683, py = 300;   // a point whose 100% view needs no clamping (the clamp wins at an edge: next test)
    const ix = (px - f.tx) / f.s, iy = (py - f.ty) / f.s;   // the picture point under the cursor
    const z = Z.zoomAt(f, 1, px, py, DESK, TALL);
    expect(z.s).toBe(1);
    expect([(px - z.tx) / z.s, (py - z.ty) / z.s].map(Math.round)).toEqual([Math.round(ix), Math.round(iy)]);
  });

  it("the scale stays between fit and 8×", () => {
    const f = Z.fitView(DESK, TALL);
    expect(Z.zoomAt(f, 0.01, 0, 0, DESK, TALL).s).toBeCloseTo(Z.fitScale(DESK, TALL), 9);
    expect(Z.zoomAt(f, 100, 0, 0, DESK, TALL).s).toBe(Z.MAX_SCALE);
  });

  it("the pan is clamped: no gap at an edge it overflows, centred on an axis it does not fill", () => {
    const z = Z.clampPan({ s: 1, tx: 500, ty: 400 }, DESK, TALL);
    expect([z.tx, z.ty]).toEqual([DESK.x, DESK.y]);                      // dragged right/down past the corner
    const far = Z.clampPan({ s: 1, tx: -9999, ty: -99999 }, DESK, TALL);
    expect([far.tx, far.ty]).toEqual([DESK.x + DESK.w - 1500, DESK.y + DESK.h - 5581]);
    const small = Z.clampPan({ s: 0.1, tx: 0, ty: 0 }, DESK, TALL);
    expect([small.tx, small.ty]).toEqual([DESK.x + (DESK.w - 150) / 2, DESK.y + (DESK.h - 558.1) / 2]);
  });

  it("overflows: fit does not, fit width of a tall sheet does", () => {
    expect(Z.overflows(Z.fitView(DESK, TALL), DESK, TALL)).toBe(false);
    expect(Z.overflows(Z.fitWidthView(DESK, TALL), DESK, TALL)).toBe(true);
  });
});

/** A stage and a picture the controller can drive: known geometry, listeners, the events a browser sends. */
function rig(nat = TALL, stageBox = { w: 1366, h: 884 }, pad = { l: 16, t: 56, r: 16, b: 16 }) {
  const listeners = (o: any) => {
    o.ls = new Map<string, Array<{ fn: any; capture: boolean }>>();
    o.addEventListener = (t: string, fn: any, opt?: any) => { o.ls.set(t, [...(o.ls.get(t) ?? []), { fn, capture: opt === true || !!opt?.capture }]); };
    o.removeEventListener = (t: string, fn: any) => { o.ls.set(t, (o.ls.get(t) ?? []).filter((l: any) => l.fn !== fn)); };
    o.emit = (t: string, init: any = {}) => {
      const e = { type: t, target: init.target ?? o, defaultPrevented: false, stopped: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; }, ...init };
      for (const l of o.ls.get(t) ?? []) l.fn(e);
      return e;
    };
    o.classList = { set: new Set<string>(), toggle(c: string, on: boolean) { on ? this.set.add(c) : this.set.delete(c); }, add(c: string) { this.set.add(c); }, remove(c: string) { this.set.delete(c); }, contains(c: string) { return this.set.has(c); } };
    return o;
  };
  const stage = listeners({ getBoundingClientRect: () => ({ left: 0, top: 0, width: stageBox.w, height: stageBox.h }), captured: [] as number[] });
  stage.setPointerCapture = (id: number) => stage.captured.push(id);
  const img = listeners({ naturalWidth: nat.w, naturalHeight: nat.h, complete: false, style: { transform: "" } });
  const g = globalThis as any;
  const savedCS = g.getComputedStyle;
  g.getComputedStyle = (el: any) => el === stage ? { paddingLeft: `${pad.l}px`, paddingTop: `${pad.t}px`, paddingRight: `${pad.r}px`, paddingBottom: `${pad.b}px` } : {};
  const changes: any[] = [];
  const zoom = Z.createZoom({ stage, img, onChange: (c: any) => changes.push(c) });
  img.emit("load");
  const z = () => { const m = /translate\(([-\d.e]+)px, ([-\d.e]+)px\) scale\(([-\d.e]+)\)/.exec(img.style.transform)!; return { tx: +m[1]!, ty: +m[2]!, s: +m[3]! }; };
  const ptr = (type: string, id: number, x: number, y: number, kind = "mouse", target: any = img) => stage.emit(type, { pointerId: id, clientX: x, clientY: y, pointerType: kind, button: 0, target });
  return { stage, img, zoom, z, changes, ptr, restore: () => { g.getComputedStyle = savedCS; zoom.destroy(); } };
}
const VIEW = { x: 16, y: 56, w: 1334, h: 812 };

describe("the controller", () => {
  let r: ReturnType<typeof rig> | null = null;
  afterEach(() => { r?.restore(); r = null; });

  it("on load: fitted, shown, the level reported", () => {
    r = rig();
    expect(r.z().s).toBeCloseTo(Z.fitScale(VIEW, TALL), 9);
    expect([r.img.classList.contains("lb-ready"), r.changes.at(-1).mode]).toEqual([true, "fit"]);
  });

  it("a wheel over a fitted picture zooms around the cursor", () => {
    r = rig();
    const before = r.z();
    const e = r.stage.emit("wheel", { deltaY: -100, deltaMode: 0, clientX: 683, clientY: 300 });
    const after = r.z();
    expect([e.defaultPrevented, after.s > before.s]).toEqual([true, true]);
    expect(Math.round((300 - after.ty) / after.s)).toBe(Math.round((300 - before.ty) / before.s));
  });

  it("once it overflows, a plain wheel scrolls it and ctrl+wheel (a trackpad pinch) still zooms", () => {
    r = rig();
    r.zoom.fitWidth();
    const top = r.z();
    r.stage.emit("wheel", { deltaY: 300, deltaMode: 0, clientX: 683, clientY: 300 });
    expect([r.z().s, r.z().ty]).toEqual([top.s, top.ty - 300]);
    expect(r.changes.at(-1).mode, "still fit width: the scale did not change").toBe("width");
    r.stage.emit("wheel", { deltaY: -50, deltaMode: 0, ctrlKey: true, clientX: 683, clientY: 300 });
    expect(r.z().s).toBeGreaterThan(top.s);
  });

  it("a mouse click on the picture toggles fit ↔ 100% at that point; the click is not the dark area's", () => {
    r = rig();
    const f = r.z();
    r.ptr("pointerdown", 1, 683, 400); r.ptr("pointerup", 1, 683, 400);
    const c = r.stage.emit("click", { target: r.img, clientX: 683, clientY: 400 });
    const one = r.z();
    expect([one.s, c.stopped]).toEqual([1, true]);
    expect(Math.round((400 - one.ty) / one.s)).toBe(Math.round((400 - f.ty) / f.s));
    r.ptr("pointerdown", 1, 683, 400); r.ptr("pointerup", 1, 683, 400);
    r.stage.emit("click", { target: r.img, clientX: 683, clientY: 400 });
    expect(r.z().s).toBeCloseTo(f.s, 9);
  });

  it("a drag pans a zoomed picture, captures the pointer only once it moves, and its click neither toggles nor closes", () => {
    r = rig();
    r.zoom.actual(683, 400);
    const z0 = r.z();
    r.ptr("pointerdown", 1, 600, 400);
    r.ptr("pointermove", 1, 602, 401);
    expect(r.stage.captured, "within the slop: not a drag yet").toEqual([]);
    r.ptr("pointermove", 1, 550, 300);
    r.ptr("pointerup", 1, 550, 300);
    const c = r.stage.emit("click", { target: r.stage });
    expect([r.z().tx - z0.tx, r.z().ty - z0.ty, r.stage.captured, c.stopped, c.defaultPrevented]).toEqual([-50, -100, [1], true, true]);
    expect(r.z().s).toBe(1);
  });

  it("a drag over a fitted picture moves nothing, and still is no click", () => {
    r = rig();
    const z0 = r.z();
    r.ptr("pointerdown", 1, 600, 400, "mouse", r.stage); r.ptr("pointermove", 1, 400, 400, "mouse", r.stage); r.ptr("pointerup", 1, 400, 400, "mouse", r.stage);
    const c = r.stage.emit("click", { target: r.stage });
    expect([r.z(), c.stopped]).toEqual([z0, true]);
  });

  it("touch: a single tap does nothing (and a tap on the dark area still closes); a double tap toggles fit ↔ 100% there", () => {
    r = rig();
    const f = r.z();
    r.ptr("pointerdown", 1, 683, 400, "touch"); r.ptr("pointerup", 1, 683, 400, "touch");
    const c1 = r.stage.emit("click", { target: r.img });
    expect([r.z().s, c1.stopped]).toEqual([f.s, false]);
    const dark = r.stage.emit("click", { target: r.stage });
    expect(dark.stopped, "the lightbox's own click handler closes on the dark area").toBe(false);
    r.ptr("pointerdown", 1, 690, 405, "touch"); r.ptr("pointerup", 1, 690, 405, "touch");
    const c2 = r.stage.emit("click", { target: r.img });
    expect([r.z().s, c2.stopped]).toEqual([1, true]);
  });

  it("a pen is a mouse: its click toggles, and two quick pen taps are two clicks, not also a double tap (Fable, #2340)", () => {
    r = rig();
    const f = r.z();
    r.ptr("pointerdown", 1, 683, 400, "pen"); r.ptr("pointerup", 1, 683, 400, "pen");
    const c1 = r.stage.emit("click", { target: r.img, clientX: 683, clientY: 400 });
    expect([r.z().s, c1.stopped]).toEqual([1, true]);
    r.ptr("pointerdown", 1, 684, 401, "pen"); r.ptr("pointerup", 1, 684, 401, "pen");
    expect(r.z().s, "the second tap's pointerup alone changes nothing").toBe(1);
    const c2 = r.stage.emit("click", { target: r.img, clientX: 684, clientY: 401 });
    expect([r.z().s, c2.stopped]).toEqual([f.s, true]);
  });

  it("touch: two taps far apart are not a double tap", () => {
    r = rig();
    const f = r.z();
    r.ptr("pointerdown", 1, 100, 400, "touch"); r.ptr("pointerup", 1, 100, 400, "touch");
    r.ptr("pointerdown", 1, 600, 400, "touch"); r.ptr("pointerup", 1, 600, 400, "touch");
    expect(r.z().s).toBeCloseTo(f.s, 9);
  });

  it("touch: a pinch zooms around the fingers' midpoint and pans with it; one finger left pans on", () => {
    r = rig();
    const f = r.z();
    r.ptr("pointerdown", 1, 633, 400, "touch"); r.ptr("pointerdown", 2, 733, 400, "touch");
    const ix = (683 - f.tx) / f.s;
    r.ptr("pointermove", 1, 583, 400, "touch"); r.ptr("pointermove", 2, 783, 400, "touch");   // fingers twice as far apart
    const p = r.z();
    expect(p.s).toBeCloseTo(f.s * 2, 6);
    expect((683 - p.tx) / p.s).toBeCloseTo(ix, 6);
    expect(r.stage.captured).toEqual([1, 2]);
    r.ptr("pointerup", 2, 783, 400, "touch");
    r.ptr("pointermove", 1, 583, 300, "touch");
    expect(r.z().ty).toBeCloseTo(p.ty - 100, 6);
    r.ptr("pointerup", 1, 583, 300, "touch");
    expect(r.stage.emit("click", { target: r.img }).stopped, "a pinch is never a tap").toBe(true);
  });

  it("touch: a pinch lifted straight away is no tap: its click does not reach the dark area (which would close)", () => {
    r = rig();
    r.ptr("pointerdown", 1, 633, 400, "touch"); r.ptr("pointerdown", 2, 733, 400, "touch");
    r.ptr("pointermove", 1, 613, 400, "touch"); r.ptr("pointermove", 2, 753, 400, "touch");
    r.ptr("pointerup", 2, 753, 400, "touch"); r.ptr("pointerup", 1, 613, 400, "touch");
    expect(r.stage.emit("click", { target: r.stage }).stopped).toBe(true);
  });

  it("touch: fingers that move together carry the picture with them while pinching", () => {
    r = rig();
    r.zoom.actual(683, 400);
    const z0 = r.z();
    r.ptr("pointerdown", 1, 633, 400, "touch"); r.ptr("pointerdown", 2, 733, 400, "touch");
    r.ptr("pointermove", 1, 613, 360, "touch"); r.ptr("pointermove", 2, 713, 360, "touch");   // same spread, 20 left and 40 up
    expect([r.z().s, r.z().tx - z0.tx, r.z().ty - z0.ty]).toEqual([1, -20, -40]);
  });

  it("buttons and keys: zoomBy steps by STEP around the middle; fit, fit width and actual size", () => {
    r = rig();
    const f = r.z();
    r.zoom.zoomBy(Z.STEP);
    expect(r.z().s).toBeCloseTo(f.s * Z.STEP, 9);
    r.zoom.actual();
    expect(r.z().s).toBe(1);
    r.zoom.fitWidth();
    expect([r.z().s, r.changes.at(-1).mode]).toEqual([Math.min(1, VIEW.w / 1500), "width"]);
    r.zoom.toggle();
    expect([r.z().s, r.changes.at(-1).mode], "anything but fit toggles back to fit").toEqual([f.s, "fit"]);
  });

  it("fit is measured from the stage when asked: a phone-size stage fits the phone", () => {
    r = rig();
    r.stage.getBoundingClientRect = () => ({ left: 0, top: 0, width: 390, height: 700 });
    r.zoom.fit();
    expect(r.z().s).toBeCloseTo(Math.min(1, 358 / 1500, 628 / 5581), 9);
  });

  it("a picture that fails to load is shown as a broken one, and the toolbar has no level", () => {
    r = rig();
    r.img.emit("error");
    expect([r.img.classList.contains("lb-err"), r.img.classList.contains("lb-ready"), r.changes.at(-1)]).toEqual([true, false, null]);
    r.zoom.zoomBy(2);
    expect(r.img.classList.contains("lb-err")).toBe(true);
  });
});

describe("the lightbox's zoom toolbar and keys", () => {
  let panel: any, lb: any, current: AppPage | null = null;
  const A = "a".repeat(32), B = "b".repeat(32);
  beforeAll(async () => {
    // @ts-expect-error — a JS module of the app, with no types
    await import("../src/ui/chat-render.js");
    // @ts-expect-error — a JS module of the app, with no types
    await import("../src/ui/preview.js");
    const base = installDom({ storage: { agend_tour_done: "1" } });
    // @ts-expect-error — a JS module of the app, with no types
    panel = await import("../src/ui/panel-chat.js");
    // @ts-expect-error — a JS module of the app, with no types
    lb = await import("../src/ui/image-lightbox.js");
    const { appStore } = await import("/assets/app-store.js");
    panel.boot({ stream: { on() {} }, boot: null, deps: { fetch: () => new Promise(() => {}) } });
    appStore.set({ ready: true, instances: [{ name: "w", status: "running" }] });
    base.restore();
  });
  afterEach(async () => {
    await current?.unmount();
    lb.closeLightbox();
    panel.store.state.msgs.w = [];
    current?.restore();
    current = null;
  });
  const photo = (id: string, name: string) => ({ id, kind: "photo", name, size: 10 });
  async function open(atts: unknown[]) {
    current = page({ storage: { agend_tour_done: "1" } });
    panel.store.state.msgs.w = [{ boot: "b", id: 1, instance: "w", sender: "w", role: "agent", text: "look", ts: "2026-01-01T00:00:01Z", attachments: atts }];
    await current.mount(h(panel.ChatPanel, { route: { instance: "w" }, navKey: "one" }));
    const doc = current.document as any;
    fire(doc.querySelector(".msg .att-img"), "click", { button: 0 }); await settle();
    return doc;
  }
  /** What a browser does when the picture arrives: its natural size, the stage's box, then "load". The mini DOM has no
   *  computed padding, so the view is the whole 1366×884 stage: fit = 884 / 5581 → 16%, fit width = 1366 / 1500 → 91%. */
  async function load(doc: any, w = 1500, hgt = 5581) {
    const d = doc.querySelector("dialog.lb");
    const stage = d.querySelector(".lb-stage"), img = d.querySelector(".lb-img");
    stage.getBoundingClientRect = () => ({ left: 0, top: 0, right: 1366, bottom: 884, width: 1366, height: 884 });
    Object.assign(img, { naturalWidth: w, naturalHeight: hgt });
    fire(img, "load", { bubbles: false }); await settle();
    return d;
  }
  const level = (d: any) => d.querySelector(".lb-level").textContent;

  it("the toolbar: −, the level, +, Fit width — labelled, disabled until the picture has loaded", async () => {
    const doc = await open([photo(A, "sheet.png")]);
    const d = doc.querySelector("dialog.lb");
    const btns = [".lb-zoom-out", ".lb-level", ".lb-zoom-in", ".lb-fit-width"].map((s) => d.querySelector(s));
    expect(btns.map((b: any) => [b.getAttribute("aria-label"), b.disabled])).toEqual([
      ["Zoom out (−)", true], ["% — click for fit or actual size (0 / 1)", true], ["Zoom in (+)", true], ["Fit width (W)", true]]);
    expect(level(d)).toBe("…");
    await load(doc);
    expect([level(d), btns.every((b: any) => !b.disabled), d.querySelector(".lb-img").classList.contains("lb-ready")]).toEqual(["16%", true, true]);
  });

  it("keys: 1 → 100%, + and − step, 0 → fit, W → fit width (pressed); a modifier is the browser's", async () => {
    const doc = await open([photo(A, "sheet.png")]);
    const d = await load(doc);
    const key = async (k: string, init: Record<string, unknown> = {}) => { const e = fire(d, "keydown", { key: k, cancelable: true, ...init }); await settle(); return e; };
    await key("1"); expect(level(d)).toBe("100%");
    await key("+"); expect(level(d)).toBe("125%");
    await key("-"); expect(level(d)).toBe("100%");
    await key("0"); expect(level(d)).toBe("16%");
    await key("w");
    expect([level(d), d.querySelector(".lb-fit-width").getAttribute("aria-pressed")]).toEqual(["91%", "true"]);
    const ctrl = await key("+", { ctrlKey: true });
    expect([ctrl.defaultPrevented, level(d)]).toEqual([false, "91%"]);
  });

  it("the buttons: + zooms, the level toggles fit ↔ 100%, − zooms out", async () => {
    const doc = await open([photo(A, "sheet.png")]);
    const d = await load(doc);
    d.querySelector(".lb-level").click(); await settle();
    expect(level(d)).toBe("100%");
    d.querySelector(".lb-zoom-in").click(); await settle();
    expect(level(d)).toBe("125%");
    d.querySelector(".lb-zoom-out").click(); await settle();
    expect(level(d)).toBe("100%");
    d.querySelector(".lb-level").click(); await settle();
    expect(level(d)).toBe("16%");
  });

  it("stepping to another image hides it until it has loaded, then fits it", async () => {
    const doc = await open([photo(A, "a.png"), photo(B, "b.png")]);
    const d = await load(doc);
    fire(d, "keydown", { key: "1" }); await settle();
    d.querySelector(".lb-next").click(); await settle();
    expect([level(d), d.querySelector(".lb-img").classList.contains("lb-ready"), d.querySelector(".lb-img").getAttribute("src")]).toEqual(["…", false, `/ui/file/${B}`]);
    await load(doc, 800, 600);
    expect(level(d)).toBe("100%");
  });

  // The user's report on beta.24: with 7 images, Next "flashes once and then the next image is not visible", the level
  // "…". A picture the thumbnails already loaded is in the cache: its load comes right after the step's render, before
  // a passive effect — so the step's hiding has to happen in that same commit, never after the load.
  it("Next / Prev across 3 images, cached and not: each one shown (lb-ready) with its level a percentage, never '…'", async () => {
    const C = "c".repeat(32);
    const doc = await open([photo(A, "a.png"), photo(B, "b.png"), photo(C, "c.png")]);
    const d = await load(doc);
    const img = d.querySelector(".lb-img");
    const state = () => [img.getAttribute("src"), img.classList.contains("lb-ready"), level(d)];
    /** A cached picture: its load as soon as the step has rendered (a microtask), before the frame effects wait for. */
    const cached = async (button: string, w: number, hgt: number) => {
      d.querySelector(button).click();
      for (let i = 0; i < 3; i++) await Promise.resolve();
      Object.assign(img, { naturalWidth: w, naturalHeight: hgt });
      fire(img, "load", { bubbles: false });
      await settle();
    };
    const seen: unknown[] = [state()];
    await cached(".lb-next", 884, 884);                                     // → b, cached
    seen.push(state());
    d.querySelector(".lb-next").click(); await settle();                    // → c, not cached: hidden until it loads
    seen.push(state());
    await load(doc, 442, 442);
    seen.push(state());
    await cached(".lb-prev", 1768, 884);                                    // ← b, cached again
    seen.push(state());
    await cached(".lb-next", 884, 1768);                                    // → c, cached now
    seen.push(state());
    expect(seen).toEqual([[`/ui/file/${A}`, true, "16%"], [`/ui/file/${B}`, true, "100%"], [`/ui/file/${C}`, false, "…"], [`/ui/file/${C}`, true, "100%"],
      [`/ui/file/${B}`, true, "77%"], [`/ui/file/${C}`, true, "50%"]]);
  });
  it("a step to a picture that is complete already (the same file again: no load comes) fits it at once", async () => {
    const doc = await open([photo(A, "a.png"), photo(A, "a-again.png")]);
    const d = await load(doc, 884, 884);
    d.querySelector(".lb-img").complete = true;                              // as the browser has it: loaded, and the src unchanged
    d.querySelector(".lb-next").click(); await settle();
    expect([d.querySelector(".lb-count").textContent, d.querySelector(".lb-img").classList.contains("lb-ready"), level(d)]).toEqual(["2 / 2", true, "100%"]);
  });

  it("the arrows still step and Esc still closes with zoom keys in place", async () => {
    const doc = await open([photo(A, "a.png"), photo(B, "b.png")]);
    const d = await load(doc);
    fire(d, "keydown", { key: "ArrowRight" }); await settle();
    expect(d.querySelector(".lb-img").getAttribute("src")).toBe(`/ui/file/${B}`);
    fire(d, "cancel", { bubbles: false }); await settle();
    expect(doc.querySelector("dialog.lb")).toBeNull();
  });
});
