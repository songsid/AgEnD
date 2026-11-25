/**
 * M-3743, #4474 review (Prism): a page whose fleet-office-zones.js is still the older one (a browser holding it across an
 * update: the page links, the module is not re-fetched) places bubbles with the release tip's placeBubbles, which knows no
 * `boxAt`: it moves each `box` by dy. A box lifted a row up near the top is kept on screen — moved back down — so two such
 * boxes could be drawn over each other. The page now checks each placed bubble again where it is drawn (its box and its
 * tail, in placing order) and leaves out one that would meet another. Here the page runs with that retained function
 * (tests/fixtures/office-zones-place-c2b0e3895.js, verbatim) in place of the current one.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { page, type AppPage } from "./helpers/app-harness.js";
import { placeBubbles as retainedPlace } from "./fixtures/office-zones-place-c2b0e3895.js";

let p: AppPage;
let Z: any, K: any, F: any;
beforeAll(async () => {
  vi.doMock("/ui/js/fleet-office-zones.js", async () => ({ ...(await vi.importActual<any>("/ui/js/fleet-office-zones.js")), placeBubbles: retainedPlace }));
  p = page({ url: "http://127.0.0.1:19280/ui/fleet/org" });
  Z = await import("/ui/js/fleet-office-zones.js");
  K = await import("/ui/js/fleet-office-skin.js");
  F = await import("/ui/js/fleet-office.js");
});
afterAll(async () => { await p.unmount(); p.restore(); vi.doUnmock("/ui/js/fleet-office-zones.js"); });

const ctx0 = { save() {}, restore() {}, font: "", measureText: (t: string) => ({ width: t.length * 6 }) };
const touch = (a: any, b: any) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const FIT = { l: 0, r: 400, t: 0, b: 300 };

describe("the retained placeBubbles (no boxAt) with the kept-on-screen boxes: the control", () => {
  it("is the one the page links here", () => {
    expect(Z.placeBubbles).toBe(retainedPlace);
  });
  it("Prism's pair: callers at (200,40) and (150,40), \"Need you!\" — it keeps both, and as drawn they overlap", () => {
    const item = (key: string, x: number) => ({ key, calling: true, shown: 5, tail: { x, y: 40 },
      box: K.bubbleBox(ctx0, x, 40, "Need you!", 0, false, FIT), boxAt: (dy: number, flip: boolean) => K.bubbleBox(ctx0, x, 40, "Need you!", -dy, flip, FIT) });
    const placed = retainedPlace([item("a", 200), item("b", 150)], 22);
    expect(placed.map((q: any) => [q.key, q.dy])).toEqual([["a", 0], ["b", -22]]);
    const drawn = placed.map((q: any) => q.boxAt(q.dy, !!q.flip));
    expect([drawn[0].x, drawn[0].y, drawn[1].x, drawn[1].y]).toEqual([190, 15, 140, 0]);
    expect(touch(drawn[0], drawn[1])).toBe(true);
  });
});

/** Callers near the canvas's top (a = 2: the view placed so their heads are ~12 units under it), as the page draws them. */
function drawn(style: string, n = 8) {
  const base = K.SKINS.get(style), got: any[] = [];
  const skin = { ...base, drawCharacter() {}, drawFurniture() {}, drawBackground() {}, drawTag() {}, drawAreaTitle() {},
    drawBubble: (c: any, x: number, y: number, text: string, env: any, lift = 0, flip = false, fit: any = null) => { if (text) got.push({ text, at: { x, y }, box: K.bubbleBox(c, x, y, text, lift, flip, fit) }); } };
  const nodes = Array.from({ length: n }, (_, i) => ({ name: `example-${i}`, state: ["needs", "stuck", "crashed"][i % 3], i: { name: `example-${i}` } }));
  const L = Z.zonesLayout(base.pack, nodes);
  const looks = new Map(L.rooms.flatMap((r: any) => r.desks).filter((d: any) => d.node).map((d: any) => [d.key,
    { name: d.node.name, label: d.node.name, state: d.node.state, pose: d.node.state }]));
  const part = () => ({ ...F.partOf(L, looks, skin, true, Z.createWalkers(), { frame: () => [], size: () => 0 }), lang: "en" });
  const mk = (canvas: any) => new Proxy({ canvas, measureText(t: string) { const px = Number(/(\d+)px/.exec(this.font)?.[1] ?? 10); return { width: [...t].length * px * 0.6 }; }, font: "" } as any,
    { get(o, k) { if (k in o) return typeof o[k] === "function" ? o[k].bind(o) : o[k]; return () => {}; }, set(o, k, v) { o[k] = v; return true; } });
  const env = { pal: { ...K.DEFAULT_PAL }, mode: "light", labels: { areas: { desks: "Desks", lounge: "Lounge", alert: "Help desk", nap: "Nap corner" } } };
  F.drawPart(mk(undefined), part(), 1, 0, 0, 0, true, null, env, false, null, []);
  const heads = got.splice(0).map((b) => b.at);
  const topY = Math.min(...heads.map((h) => h.y)), midX = heads.reduce((s, h) => s + h.x, 0) / heads.length;
  F.drawPart(mk({ width: 780, height: 600 }), part(), 2, Math.round(390 - midX * 2), Math.round((12 - topY) * 2), 0, true, null, env, false, null, []);
  return got;
}

describe("the page with the retained placeBubbles: callers at the top of the canvas, every zoned style", () => {
  for (const style of ["studio", "cozy", "guild", "school"]) {
    it(`${style}: no drawn bubble over another's box or tail`, () => {
      const got = drawn(style);
      expect(got.length).toBeGreaterThan(0);
      for (let i = 0; i < got.length; i++) for (let j = 0; j < got.length; j++) {
        if (i === j) continue;
        if (i < j) expect(touch(got[i].box, got[j].box), `${got[i].text} / ${got[j].text}: boxes`).toBe(false);
        expect(touch(got[i].box, got[j].box.tail), `${got[i].text} over ${got[j].text}'s tail`).toBe(false);
      }
    });
  }
});
