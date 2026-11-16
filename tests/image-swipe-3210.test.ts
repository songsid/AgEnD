/**
 * M-3210 (the user, phone): in the image viewer a picture that fits swipes like a phone's photo viewer — sideways to the
 * previous / next picture, up or down to close, following the finger, the backdrop fading as it is pulled; a short, slow
 * one springs back; past the ends it gives a little and springs back; a zoomed-in picture pans instead; a second finger
 * pinches; a mouse or a pen never swipes. The controller (image-zoom.js) driven by the pointer events a browser sends,
 * on fakes for the stage and the picture (known geometry) and a clock of our own (a flick is distance over time).
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";

let Z: any;
beforeAll(async () => {
  // @ts-expect-error — a JS module of the app, with no types
  Z = await import("../src/ui/image-zoom.js");
});

const PHOTO = { w: 1200, h: 900 };   // a landscape photo on a 390×844 phone: fits at 0.3

function rig(o: { ends?: boolean } = {}) {
  const listeners = (x: any) => {
    x.ls = new Map<string, Array<(e: any) => void>>();
    x.addEventListener = (t: string, fn: any) => { x.ls.set(t, [...(x.ls.get(t) ?? []), fn]); };
    x.removeEventListener = (t: string, fn: any) => { x.ls.set(t, (x.ls.get(t) ?? []).filter((f: any) => f !== fn)); };
    x.emit = (t: string, init: any = {}) => {
      const e = { type: t, target: x, defaultPrevented: false, stopped: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; }, ...init };
      for (const fn of x.ls.get(t) ?? []) fn(e);
      return e;
    };
    x.classList = { set: new Set<string>(), toggle(c: string, on: boolean) { on ? this.set.add(c) : this.set.delete(c); }, add(c: string) { this.set.add(c); }, remove(c: string) { this.set.delete(c); }, contains(c: string) { return this.set.has(c); } };
    return x;
  };
  const box = { left: 0 };   // the stage's place on the screen (it moves while the next picture slides in)
  const stage = listeners({ getBoundingClientRect: () => ({ left: box.left, top: 0, width: 390, height: 844 }), setPointerCapture() {} });
  const img = listeners({ naturalWidth: PHOTO.w, naturalHeight: PHOTO.h, complete: false, style: { transform: "" } });
  const g = globalThis as any;
  const savedCS = g.getComputedStyle, savedNow = performance.now;
  let clock = 1000;
  (performance as any).now = () => clock;
  g.getComputedStyle = (el: any) => el === stage ? { paddingLeft: "16px", paddingTop: "56px", paddingRight: "16px", paddingBottom: "72px" } : {};
  const seen = { swipes: [] as number[], dismissed: 0, pulls: [] as number[] };
  const zoom = Z.createZoom({ stage, img, onChange() {},
    canSwipe: (d: number) => !o.ends || false, onSwipe: (d: number) => seen.swipes.push(d), onDismiss: () => { seen.dismissed++; }, onPull: (p: number) => seen.pulls.push(p) });
  img.emit("load");
  const z = () => { const m = /translate\(([-\d.e]+)px, ([-\d.e]+)px\) scale\(([-\d.e]+)\)/.exec(img.style.transform)!; return { tx: +m[1]!, ty: +m[2]!, s: +m[3]! }; };
  const ptr = (type: string, id: number, x: number, y: number, kind = "touch") => stage.emit(type, { pointerId: id, clientX: x, clientY: y, pointerType: kind, button: 0, target: img });
  /** One finger from (x0,y0) through (x1,y1) over `ms`; `lift`: false keeps it down. */
  const drag = (x0: number, y0: number, x1: number, y1: number, ms = 400, kind = "touch", lift = true) => {
    ptr("pointerdown", 1, x0, y0, kind);
    for (let i = 1; i <= 4; i++) { clock += ms / 4; ptr("pointermove", 1, x0 + ((x1 - x0) * i) / 4, y0 + ((y1 - y0) * i) / 4, kind); }
    if (lift) ptr("pointerup", 1, x1, y1, kind);
  };
  return { stage, img, zoom, z, ptr, drag, seen, box, tick: (ms: number) => { clock += ms; },
    restore: () => { g.getComputedStyle = savedCS; (performance as any).now = savedNow; zoom.destroy(); } };
}

describe("M-3210: a picture that fits swipes under a finger", () => {
  let r: ReturnType<typeof rig> | null = null;
  afterEach(() => { r?.restore(); r = null; });

  it("sideways: the picture follows the finger; far enough to the left is the next, to the right the previous; its click is no click", () => {
    r = rig();
    const f = r.z();
    r.drag(300, 400, 180, 404, 400, "touch", false);
    expect([r.z().tx - f.tx, r.z().ty - f.ty, r.z().s], "follows sideways only").toEqual([-120, 0, f.s]);
    r.ptr("pointerup", 1, 180, 404);
    const c = r.stage.emit("click", { target: r.img });
    expect([r.seen.swipes, c.stopped]).toEqual([[1], true]);
    r.drag(100, 400, 260, 410);
    expect(r.seen.swipes).toEqual([1, -1]);
  });

  it("a short, slow one springs back (eased) and steps nothing; a short flick steps", () => {
    r = rig();
    const f = r.z();
    r.drag(200, 400, 150, 400, 600);                          // 50 px in 600 ms: under 22% of the view, no flick
    expect([r.seen.swipes, r.z(), r.img.classList.contains("lb-snap")]).toEqual([[], f, true]);
    r.drag(200, 400, 150, 400, 60);                           // the same 50 px in 60 ms: a flick
    expect(r.seen.swipes).toEqual([1]);
  });

  it("past the first or the last picture it gives a little and springs back", () => {
    r = rig({ ends: true });
    const f = r.z();
    r.drag(300, 400, 100, 400, 400, "touch", false);
    expect(r.z().tx - f.tx, "a third of the finger's way").toBeCloseTo(-60, 6);
    r.ptr("pointerup", 1, 100, 400);
    expect([r.seen.swipes, r.z()]).toEqual([[], f]);
  });

  it("up or down: it follows the finger, the pull is reported (the backdrop fades), far enough closes; less springs back to 0", () => {
    r = rig();
    const f = r.z();
    r.drag(200, 300, 204, 500, 400, "touch", false);
    expect([r.z().tx - f.tx, r.z().ty - f.ty]).toEqual([0, 200]);
    expect(r.seen.pulls.at(-1)).toBeCloseTo(200 / (716 * 0.5), 6);   // the view is 844 − 56 − 72 tall
    r.ptr("pointerup", 1, 204, 500);
    expect(r.seen.dismissed).toBe(1);
    r.drag(200, 300, 200, 340, 600);                          // 40 px, slow
    expect([r.seen.dismissed, r.seen.pulls.at(-1), r.z()]).toEqual([1, 0, f]);
    r.drag(200, 500, 200, 280, 400);                          // up closes too
    expect(r.seen.dismissed).toBe(2);
  });

  it("zoomed in, a finger pans the picture and never swipes", () => {
    r = rig();
    r.zoom.actual(195, 400);
    const z0 = r.z();
    r.drag(300, 400, 100, 400);
    expect([r.seen.swipes, r.seen.dismissed, r.z().tx - z0.tx]).toEqual([[], 0, 200 * -1]);
  });

  it("a mouse or a pen never swipes (the desk has the arrow keys and Esc)", () => {
    r = rig();
    const f = r.z();
    r.drag(300, 400, 50, 400, 100, "mouse");
    r.drag(200, 300, 200, 700, 100, "pen");
    expect([r.seen.swipes, r.seen.dismissed, r.z()]).toEqual([[], 0, f]);
  });

  it("a second finger turns a swipe into a pinch, from where the picture is; the pull goes back to 0", () => {
    r = rig();
    const f = r.z();
    r.drag(200, 300, 200, 400, 200, "touch", false);
    r.ptr("pointerdown", 2, 260, 400);
    expect([r.z(), r.seen.pulls.at(-1)]).toEqual([f, 0]);
    r.ptr("pointermove", 1, 140, 400); r.ptr("pointermove", 2, 320, 400);
    r.ptr("pointerup", 2, 320, 400); r.ptr("pointerup", 1, 140, 400);
    expect([r.seen.dismissed, r.seen.swipes, r.z().s > f.s]).toEqual([0, [], true]);
  });

  // CI flake on #4037 (traced): a slow 35 px swipe stepped — it began 30 ms after the last step, while the stage slid in from
  // 28% to the left; measured in the stage, the start was 100 px off. A swipe is measured on the screen.
  it("a swipe that starts while the stage slides in is measured on the screen: a slow, short one still springs back", () => {
    r = rig();
    r.box.left = -100;                                        // mid slide-in at pointerdown
    r.ptr("pointerdown", 1, 250, 400);
    r.box.left = 0;                                           // settled by the first move
    for (const x of [243, 236, 229, 222, 215]) { r.tick(90); r.ptr("pointermove", 1, x, 401); }
    r.ptr("pointerup", 1, 215, 401);
    expect(r.seen.swipes).toEqual([]);
  });

  it("a touch the browser takes back (pointercancel) springs back and steps nothing", () => {
    r = rig();
    const f = r.z();
    r.drag(300, 400, 60, 400, 100, "touch", false);
    r.ptr("pointercancel", 1, 60, 400);
    expect([r.seen.swipes, r.z()]).toEqual([[], f]);
  });
});
