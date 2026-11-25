/**
 * M-3722 (b), found in #4449's captures: with exactly one agent calling, its "Need you!" bubble covered the "Help desk"
 * (求救區) name on the default Cozy, and Studio. The caller stands at the name's height, so every row's TAIL met the name and
 * placeBubbles fell back to covering it (M-3648: a name never keeps a call out). Now an area's name keeps a bubble's BOX
 * off it (a row up, or the box on the tail's left), a tail may cross it, and the Office writes a crossed name again over
 * the tail (as over a figure standing on it, M-3539). M-3648 holds: a call with no clear spot still covers a name.
 * Every zoned style, en and zh-TW, each calling state, drawn as the page draws it (drawPart).
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

const B = (x: number, y: number, w = 60, h = 18) => ({ x, y, w, h });
const touch = (a: any, b: any) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

describe("bubbleBox: the flipped box", () => {
  it("sits on the tail's left, the same size and height, its tail still under its bottom edge", () => {
    const ctx = { save() {}, restore() {}, font: "", measureText: (t: string) => ({ width: t.length * 6 }) };
    const usual = K.bubbleBox(ctx, 200, 100, "Need you!"), flip = K.bubbleBox(ctx, 200, 100, "Need you!", 0, true);
    expect([flip.w, flip.h, flip.y]).toEqual([usual.w, usual.h, usual.y]);
    expect(usual.x).toBe(190);                                           // the usual box: from 10 left of the tail
    expect(flip.x + flip.w).toBe(214);                                   // flipped: ends 14 right of it
    expect(flip.x + 4 <= 201 && 206 <= flip.x + flip.w - 4).toBe(true);  // the tail's foot (x+1..x+6) inside its bottom edge
  });
});

describe("placeBubbles: a name keeps a call's box off it, not its tail", () => {
  const tail = { x: 110, y: 112 };                                     // the head, at the name's height
  const name = B(80, 100, 90, 18);
  it("a call whose tail crosses a name: a row up, its box clear of the name", () => {
    const [b] = Z.placeBubbles([{ key: "c", calling: true, shown: 5, box: B(100, 87), tail }], 22, [], [name]);
    expect(b.dy).toBe(-22);
    expect(touch({ ...b.box, y: b.box.y + b.dy }, name)).toBe(false);
  });
  it("its own row and the one up both on the name, the left side clear: the box goes to the tail's left", () => {
    const wide = B(100, 40, 200, 70);                                   // covers the usual box at 0 and -22, not the flipped one
    const [b] = Z.placeBubbles([{ key: "c", calling: true, shown: 5, box: B(100, 87), flipBox: B(40, 87), tail }], 22, [], [wide]);
    expect([b.dy, b.flip]).toEqual([0, true]);
  });
  it("M-3648 still: with no clear spot a call covers the name at its own spot (never left out)", () => {
    const [b] = Z.placeBubbles([{ key: "c", calling: true, shown: 5, box: B(100, 87), flipBox: B(40, 87), tail }], 22, [], [B(0, 0, 400, 200)]);
    expect([b.dy, b.flip ?? false]).toEqual([0, false]);
  });
  it("`air`: a box that would sit within 3 px of a name moves on, as if it touched it", () => {
    const near = B(161, 70, 40, 18);                                     // 1 px right of the usual box (x 100..160), its row
    expect(Z.placeBubbles([{ key: "c", calling: true, shown: 5, box: B(100, 70), tail: { x: 110, y: 95 } }], 22, [], [near])[0].dy).toBe(0);
    expect(Z.placeBubbles([{ key: "c", calling: true, shown: 5, box: B(100, 70), tail: { x: 110, y: 95 } }], 22, [], [near], Z.NAME_AIR)[0].dy).toBe(-22);
    expect(Z.NAME_AIR).toBe(3);
    expect(readFileSync("src/ui/fleet-office.js", "utf8")).toMatch(/placeBubbles\(thinBubbles\([^;]*titleBoxes, 3\)/);   // the page passes it (as a number: no new import)
  });
  it("chatter is placed as before: no flip, and a name over every row leaves it out", () => {
    expect(Z.placeBubbles([{ key: "idle", calling: false, shown: 5, box: B(100, 87), flipBox: B(40, 87), tail }], 22, [], [B(0, 0, 400, 200)])).toEqual([]);
  });
});

/** A zoned style as the page draws it (drawPart): one agent calling, General idle; its bubbles, names and draw order. */
function drawn(style: string, lang: "en" | "zh-TW", state: string) {
  const base = K.SKINS.get(style), order: any[] = [];
  const skin = { ...base, drawCharacter() {}, drawFurniture() {}, drawBackground() {}, drawTag() {},
    drawBubble: (ctx: any, x: number, y: number, text: string, env: any, lift = 0, flip = false) => { if (text) order.push({ kind: "bubble", text, box: K.bubbleBox(ctx, x, y, text, lift, flip), tail: { x, y } }); },
    drawAreaTitle: (ctx: any, ar: any, env: any) => { order.push({ kind: "title", box: base.areaTitleBox(ctx, ar, env) }); } };
  const nodes = [{ name: "example-agent", state, i: { name: "example-agent" } }, { name: "general", state: "idle", i: { name: "general" } }];
  const L = Z.zonesLayout(base.pack, nodes);
  const looks = new Map(L.rooms.flatMap((r: any) => r.desks).filter((d: any) => d.node).map((d: any) => [d.key,
    { name: d.node.name, label: d.node.name, state: d.node.state, pose: d.node.state }]));
  const part = { ...F.partOf(L, looks, skin, true, Z.createWalkers(), { frame: () => [], size: () => 0 }), lang };
  const ctx = new Proxy({ measureText(t: string) { const px = Number(/(\d+)px/.exec(this.font)?.[1] ?? 10);
    return { width: [...t].reduce((w, c) => w + (c.codePointAt(0)! >= 0x2e80 ? px : px * 0.6), 0) }; }, font: "" } as any,
    { get(o, k) { if (k in o) return typeof o[k] === "function" ? o[k].bind(o) : o[k]; return () => {}; }, set(o, k, v) { o[k] = v; return true; } });
  const env = { pal: { ...K.DEFAULT_PAL }, mode: "light", labels: { areas: lang === "en" ? { desks: "Desks", lounge: "Lounge", alert: "Help desk", nap: "Nap corner" } : { desks: "工作區", lounge: "休息區", alert: "求救區", nap: "午睡角" } } };
  F.drawPart(ctx, part, 1, 0, 0, 0, true, null, env, false, null, []);
  const titles = Object.values(L.areas).map((a: any) => base.areaTitleBox(ctx, a, env));
  return { order, titles, bubbles: order.filter((o) => o.kind === "bubble") };
}

describe("one agent calling, every zoned style: its bubble clears every area's name", () => {
  const styles = () => ["studio", "cozy", "guild", "school"].filter((s) => K.SKINS.get(s)?.areaTitleBox);
  it("the zoned styles are all here (a renamed or new one is checked too)", () => {
    expect(styles()).toEqual(["studio", "cozy", "guild", "school"]);
  });
  for (const style of ["studio", "cozy", "guild", "school"]) for (const lang of ["en", "zh-TW"] as const) for (const state of ["needs", "stuck", "crashed"]) {
    it(`${style}, ${lang}, ${state}: the call is drawn, its box on no name; a name its tail crosses is written again after it`, () => {
      const s = drawn(style, lang, state);
      expect(s.bubbles.length, "the call is drawn (M-3648)").toBe(1);
      const [b] = s.bubbles;
      const air = (t: any) => ({ x: t.x - 3, y: t.y - 3, w: t.w + 6, h: t.h + 6 });       // and keeps a little air off it
      expect(s.titles.filter((t: any) => touch(b.box, air(t))), "its box covers no area name").toEqual([]);
      const tailRect = { x: b.tail.x - 1, y: b.box.y + b.box.h, w: 9, h: Math.max(0, b.tail.y - (b.box.y + b.box.h)) };
      const at = s.order.indexOf(b);
      for (const t of s.titles.filter((t: any) => touch(tailRect, t))) {
        expect(s.order.slice(at + 1).some((o: any) => o.kind === "title" && touch(o.box, t)), "the crossed name is written again over the tail").toBe(true);
      }
    });
  }
});
