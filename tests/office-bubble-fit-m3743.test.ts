/**
 * M-3743 (Fable's #4458 triage [C]): an Office speech bubble was placed over its speaker with nothing keeping it on screen, so
 * a speaker near the canvas's edge (more often now riders go round the map's rim, #4458) had its bubble cut off. Now the
 * Office passes the part of the scene on screen (`fit`) and the bubble's box stays inside it, its tail still at the speaker:
 * slid along the edge, lowered (a shorter tail) at the top, under the head (tail up) only when there is no room over it.
 * placeBubbles places the boxes as they are drawn (`boxAt`), so two kept-on-screen bubbles never overlap.
 * And (#4467 captures) the phone's ⋯ sheet's selects are no longer held to the bar's 150 px: "Pop-up window" was cut.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { page, type AppPage } from "./helpers/app-harness.js";

let p: AppPage;
let Z: any, K: any, F: any;
beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19280/ui/fleet/org" });
  Z = await import("/ui/js/fleet-office-zones.js");
  K = await import("/ui/js/fleet-office-skin.js");
  F = await import("/ui/js/fleet-office.js");
});
afterAll(async () => { await p.unmount(); p.restore(); });

const ctx0 = { save() {}, restore() {}, font: "", measureText: (t: string) => ({ width: t.length * 6 }) };
const inside = (b: any, f: any) => b.x >= f.l - 1e-9 && b.x + b.w <= f.r + 1e-9 && b.y >= f.t - 1e-9 && b.y + b.h <= f.b + 1e-9;
/** The box still over its speaker's x (its tail's foot then on its edge, the tail to the speaker). */
const over = (b: any, x: number) => b.x + 1 <= x && x <= b.x + b.w - 1;
const touch = (a: any, b: any) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const FIT = { l: 0, r: 400, t: 0, b: 300 };

describe("bubbleBox with `fit`: the box stays on screen, its tail at the speaker", () => {
  it("no fit, or room all round: exactly as before (from 10 left of the tail, over the head)", () => {
    const old = K.bubbleBox(ctx0, 200, 100, "Need you!"), fitted = K.bubbleBox(ctx0, 200, 100, "Need you!", 0, false, FIT);
    expect(fitted).toEqual(old);
    expect([old.x, old.y, old.below]).toEqual([190, 75, undefined]);
    expect(K.bubbleBox(ctx0, 200, 100, "Need you!", 22, true, FIT)).toEqual(K.bubbleBox(ctx0, 200, 100, "Need you!", 22, true));
  });
  it("a speaker by the right edge: the box slides left to end at the edge, still over the speaker", () => {
    for (const x of [385, 390, 395, 399]) {
      const b = K.bubbleBox(ctx0, x, 100, "Working on it…", 0, false, FIT);
      expect(K.bubbleBox(ctx0, x, 100, "Working on it…").x + b.w, "it ran off before").toBeGreaterThan(400);
      expect(inside(b, FIT), `x ${x}`).toBe(true);
      expect(over(b, x), `x ${x}`).toBe(true);
      expect(b.y).toBe(75);                                                   // the same height
    }
  });
  it("a flipped call by the left edge: the box slides right, still over the speaker", () => {
    const b = K.bubbleBox(ctx0, 20, 100, "Need you!", 0, true, FIT);
    expect(K.bubbleBox(ctx0, 20, 100, "Need you!", 0, true).x, "it ran off before").toBeLessThan(0);
    expect(inside(b, FIT)).toBe(true);
    expect(over(b, 20)).toBe(true);
  });
  it("by the top: lowered (a shorter tail) while it still fits over the head", () => {
    const b = K.bubbleBox(ctx0, 200, 30, "Need you!", 0, false, FIT);   // the usual box: 30 - 19 - 6 = 5
    expect(b.y).toBe(5);                                                    // still fits: unchanged
    const lifted = K.bubbleBox(ctx0, 200, 30, "Need you!", 22, false, FIT);
    expect(K.bubbleBox(ctx0, 200, 30, "Need you!", 22).y, "it ran off before").toBeLessThan(0);
    expect([lifted.y, lifted.below]).toEqual([0, undefined]);               // at the top, over the head (a 5 px tail)
    expect(lifted.y + lifted.h).toBeLessThanOrEqual(30 - 3);
  });
  it("no room over the head: under it, its tail up, still on screen", () => {
    const b = K.bubbleBox(ctx0, 200, 12, "Need you!", 0, false, FIT);
    expect(b.below).toBe(true);
    expect(b.y).toBe(18);                                                   // 6 under the tail's point
    expect(inside(b, FIT)).toBe(true);
  });
  it("a corner: both at once", () => {
    const b = K.bubbleBox(ctx0, 392, 10, "Taking a break", 0, false, FIT);
    expect(inside(b, FIT)).toBe(true);
    expect(over(b, 392)).toBe(true);
    expect(b.below).toBe(true);
  });
  it("drawBubble draws the box bubbleBox gives (the tail from its top when under the head)", () => {
    const path: Array<[string, number, number]> = [];
    const ctx = { ...ctx0, fillStyle: "", strokeStyle: "", lineWidth: 1, textBaseline: "", textAlign: "",
      beginPath() {}, closePath() {}, fill() {}, stroke() {}, fillText() {},
      moveTo(x: number, y: number) { path.push(["m", x, y]); }, lineTo(x: number, y: number) { path.push(["l", x, y]); } };
    K.pixelSkin.drawBubble(ctx, 392, 10, "Taking a break", { mode: "light" }, 0, false, FIT);
    const b = K.bubbleBox(ctx0, 392, 10, "Taking a break", 0, false, FIT);
    const xs = path.map((q) => q[1]), ys = path.map((q) => q[2]);
    expect(Math.min(...xs.filter((_, i) => !(xs[i] === 392 && ys[i] === 10)))).toBe(b.x);
    expect(Math.max(...xs)).toBe(b.x + b.w);
    expect(path.some(([, x, y]) => x === 392 && y === 10)).toBe(true);      // the tail's point: the speaker
    const tip = path.findIndex(([, x, y]) => x === 392 && y === 10);
    expect([path[tip - 1]![2], path[tip + 1]![2]]).toEqual([b.y, b.y]);     // from the box's top edge
  });
});

describe("placeBubbles places the boxes as drawn (`boxAt`)", () => {
  it("two speakers near the right edge: placed where they are drawn, so the slid box and its neighbour never overlap", () => {
    // "a" at 395: its box (26 wide) from 385 ran off; slid, it is 374…400 — over "b"'s 320…382, which its unslid box was not.
    const item = (key: string, x: number, text: string) => ({ key, calling: true, shown: 5, tail: { x, y: 100 },
      box: K.bubbleBox(ctx0, x, 100, text, 0, false, FIT), boxAt: (dy: number, flip: boolean) => K.bubbleBox(ctx0, x, 100, text, -dy, flip, FIT) });
    const items = [item("a", 395, "Hi"), item("b", 330, "Need you")];
    expect([items[0]!.box.x, items[0]!.box.x + items[0]!.box.w, items[1]!.box.x, items[1]!.box.x + items[1]!.box.w]).toEqual([374, 400, 320, 382]);
    const placed = Z.placeBubbles(items, 22);
    expect(placed.map((q: any) => [q.key, q.dy])).toEqual([["a", 0], ["b", -22]]);
    const boxes = placed.map((q: any) => q.boxAt(q.dy, !!q.flip));
    expect(touch(boxes[0], boxes[1])).toBe(false);
    for (const b of boxes) expect(inside(b, FIT)).toBe(true);
  });
  it("near the top, a row up is clamped back down — so it is checked where it is drawn, and a bubble that fits nowhere waits", () => {
    const item = (key: string, x: number) => ({ key, calling: true, shown: 5, tail: { x, y: 40 },
      box: K.bubbleBox(ctx0, x, 40, "Need you!", 0, false, FIT), boxAt: (dy: number, flip: boolean) => K.bubbleBox(ctx0, x, 40, "Need you!", -dy, flip, FIT) });
    const items = [item("a", 200), item("b", 150)];                      // b's box (140…208) on a's (190…258), its tail clear of it
    expect(items[0]!.boxAt(-22, false).y, "a row up is clamped to the top").toBe(0);
    const placed = Z.placeBubbles(items, 22);
    const boxes = placed.map((q: any) => q.boxAt(q.dy, !!q.flip));
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) expect(touch(boxes[i], boxes[j])).toBe(false);
    expect(placed.map((q: any) => q.key)).toEqual(["a"]);
    // The page gives each bubble its boxAt (the box drawn at each spot, kept on screen as drawBubble keeps it).
    expect(readFileSync("src/ui/fleet-office.js", "utf8")).toContain("boxAt: ((at) => (dy, flip) => bubbleBox(ctx, at.x, at.y, b.text, -dy, flip, fit))(sp)");
  });
  it("a box under its speaker keeps the strip from the speaker down to it clear (no other bubble on its tail)", () => {
    const under = { key: "a", calling: true, shown: 9, tail: { x: 200, y: 12 }, box: K.bubbleBox(ctx0, 200, 12, "Need you!", 0, false, FIT),
      boxAt: (dy: number, flip: boolean) => K.bubbleBox(ctx0, 200, 12, "Need you!", -dy, flip, FIT) };
    const tailStrip = { x: 199, y: 12, w: 9, h: 6 };
    const other = { key: "b", calling: false, shown: 1, tail: { x: 196, y: 40 }, box: { x: 186, y: 10, w: 30, h: 6 } };   // on the tail only
    const placed = Z.placeBubbles([under, other], 22);
    expect(placed.map((q: any) => q.key)).toEqual(["a"]);
    expect(touch(tailStrip, other.box)).toBe(true);
    expect(touch(under.box, other.box)).toBe(false);
  });
});

/** A zoned style as the page draws it (drawPart) on a canvas `cw` × `ch` bitmap px, the scene at `a` px a unit from (ox, oy). */
function drawn(style: string, view: (sp: { x: number; y: number }) => { ox: number; oy: number }, cw = 390 * 2, ch = 300 * 2, a = 2) {
  const base = K.SKINS.get(style), got: any[] = [];
  const skin = { ...base, drawCharacter() {}, drawFurniture() {}, drawBackground() {}, drawTag() {}, drawAreaTitle() {},
    drawBubble: (c: any, x: number, y: number, text: string, env: any, lift = 0, flip = false, fit: any = null) => { if (text) got.push({ text, tail: { x, y }, fit, box: K.bubbleBox(c, x, y, text, lift, flip, fit) }); } };
  const nodes = [{ name: "example-agent", state: "needs", i: { name: "example-agent" } }, { name: "general", state: "stuck", i: { name: "general" } }];
  const L = Z.zonesLayout(base.pack, nodes);
  const looks = new Map(L.rooms.flatMap((r: any) => r.desks).filter((d: any) => d.node).map((d: any) => [d.key,
    { name: d.node.name, label: d.node.name, state: d.node.state, pose: d.node.state }]));
  const part = () => ({ ...F.partOf(L, looks, skin, true, Z.createWalkers(), { frame: () => [], size: () => 0 }), lang: "en" });
  const mk = (canvas: any) => new Proxy({ canvas, measureText(t: string) { const px = Number(/(\d+)px/.exec(this.font)?.[1] ?? 10); return { width: [...t].length * px * 0.6 }; }, font: "" } as any,
    { get(o, k) { if (k in o) return typeof o[k] === "function" ? o[k].bind(o) : o[k]; return () => {}; }, set(o, k, v) { o[k] = v; return true; } });
  const env = { pal: { ...K.DEFAULT_PAL }, mode: "light", labels: { areas: { desks: "Desks", lounge: "Lounge", alert: "Help desk", nap: "Nap corner" } } };
  // Where the speakers' bubbles point, with the whole scene in view (no canvas: no fit).
  F.drawPart(mk(undefined), part(), 1, 0, 0, 0, true, null, env, false, null, []);
  const sp = got.splice(0)[0].tail;
  const { ox, oy } = view(sp), hits: any[] = [];
  F.drawPart(mk({ width: cw, height: ch }), part(), a, ox, oy, 0, true, null, env, false, null, hits);
  return { bubbles: got, hits, sp, ox, oy, a, cw, ch };
}

describe("drawPart: a speaker at the canvas's edge, every zoned style — the bubble is drawn whole on screen", () => {
  const EDGES: Record<string, (sp: { x: number; y: number }) => { ox: number; oy: number }> = {
    // the speaker's head 14 bitmap px in from that edge (a = 2: 7 units); the scene placed so
    right: (sp) => ({ ox: 780 - 14 - sp.x * 2, oy: 300 - sp.y * 2 }),
    left: (sp) => ({ ox: 14 - sp.x * 2, oy: 300 - sp.y * 2 }),
    top: (sp) => ({ ox: 390 - sp.x * 2, oy: 14 - sp.y * 2 }),
    "top right": (sp) => ({ ox: 780 - 14 - sp.x * 2, oy: 14 - sp.y * 2 }),
  };
  for (const style of ["studio", "cozy", "guild", "school"]) for (const [edge, view] of Object.entries(EDGES)) {
    it(`${style}, ${edge}: inside the canvas (8 px in), its tail at the speaker, the tap box the same`, () => {
      const s = drawn(style, view);
      const mine = s.bubbles.find((b) => b.tail.x === s.sp.x && b.tail.y === s.sp.y);
      expect(mine, "the edge speaker's bubble is drawn").toBeTruthy();
      for (const b of s.bubbles) {
        const px = { x: s.ox + b.box.x * s.a, y: s.oy + b.box.y * s.a, w: b.box.w * s.a, h: b.box.h * s.a };
        // The tap box is the drawn box (officeBubbleAt finds the bubble where it is).
        expect(s.hits.some((h) => Math.abs(h.box.x - px.x) < 1e-6 && Math.abs(h.box.y - px.y) < 1e-6 && Math.abs(h.box.w - px.w) < 1e-6), b.text).toBe(true);
        const onScreen = b.tail.x * s.a + s.ox >= 0 && b.tail.x * s.a + s.ox <= s.cw && b.tail.y * s.a + s.oy >= 0 && b.tail.y * s.a + s.oy <= s.ch;
        if (!onScreen) continue;                                            // a speaker off screen: nothing to keep
        expect(px.x >= 8 - 1e-6 && px.x + px.w <= s.cw - 8 + 1e-6 && px.y >= 8 - 1e-6 && px.y + px.h <= s.ch - 8 + 1e-6, `${b.text} ${JSON.stringify(px)}`).toBe(true);
        expect(over(b.box, b.tail.x)).toBe(true);
      }
      const boxes = s.bubbles.map((b) => b.box);
      for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) expect(touch(boxes[i], boxes[j]), "no two bubbles overlap as drawn").toBe(false);
    });
  }
  it("the control: the same edge speaker without fit (an older skin ignoring it) ran off the right edge", () => {
    const s = drawn("cozy", EDGES.right!);
    const mine = s.bubbles.find((b) => b.tail.x === s.sp.x && b.tail.y === s.sp.y)!;
    const old = K.bubbleBox(ctx0, mine.tail.x, mine.tail.y, mine.text);
    expect(s.ox + (old.x + old.w) * s.a).toBeGreaterThan(s.cw);
  });
});

describe("the ⋯ sheet's selects (#4467 captures: \"Pop-up windov\" on a 390 px phone)", () => {
  it("take 62% of the row, not the Office bar's 150 px cap", () => {
    const css = readFileSync("src/ui/shared/app.css", "utf8");
    expect(css).toContain(".oo-sheet .oo-pick .tb-select { width: 62%; max-width: none; min-height: var(--tap); font-size: var(--fs-md); }");
    expect(css).toMatch(/\.oo-pick \.tb-select \{ max-width: 150px; \}/);   // the bar's own cap stays
  });
});
