/**
 * M-3648: a call's bubble always shows. M-3539 (#4376) made the areas' names block every bubble; on Cozy a stuck or
 * calling agent stands right under "Help desk", both its spots met the name, and "Hmm, stuck?" was left out (beta.20) —
 * and with it the click that opens their chat (#4283). Now the names block chatter only: a call tries a second row up,
 * then may cover a name (never a tag or another bubble), and failing all that is drawn at its own spot.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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

describe("placeBubbles: area names block chatter, never a call", () => {
  const name = B(90, 70, 120, 40);                                     // an area's name over both spots (y 80 and 58)
  it("chatter under a name: left out, as M-3539 has it", () => {
    expect(Z.placeBubbles([{ key: "idle", calling: false, shown: 5, box: B(100, 80) }], 22, [], [name])).toEqual([]);
  });
  it("a call under a name: a second row up when that is clear", () => {
    const placed = Z.placeBubbles([{ key: "stuck", calling: true, shown: 5, box: B(100, 80) }], 22, [], [B(90, 56, 120, 40)]);
    expect(placed.map((b: any) => [b.key, b.dy])).toEqual([["stuck", -44]]);
  });
  it("a call with every row under the name: it covers the name, at its own spot", () => {
    const placed = Z.placeBubbles([{ key: "stuck", calling: true, shown: 5, box: B(100, 80) }], 22, [], [B(0, 0, 400, 200)]);
    expect(placed.map((b: any) => [b.key, b.dy])).toEqual([["stuck", 0]]);
  });
  it("covering a name, a call still keeps off name tags and other bubbles where it can", () => {
    // Its own spot is under a tag; a row up only a name: it takes the row up, over the name.
    const placed = Z.placeBubbles([{ key: "stuck", calling: true, shown: 5, box: B(100, 80) }], 22, [B(100, 85, 40, 10)], [B(0, 0, 400, 200)]);
    expect(placed.map((b: any) => [b.key, b.dy])).toEqual([["stuck", -22]]);
  });
  it("nowhere clear at all: a call is drawn at its own spot anyway; chatter beside it still waits", () => {
    const placed = Z.placeBubbles([{ key: "stuck", calling: true, shown: 5, box: B(100, 80) }, { key: "idle", calling: false, shown: 5, box: B(100, 80) }],
      22, [B(0, 0, 400, 200)], []);
    expect(placed.map((b: any) => [b.key, b.dy])).toEqual([["stuck", 0]]);
  });
});

/** Cozy, as the page draws it (drawPart), its bubbles and names recorded; one agent stuck, one idle. */
function cozy(lang: "en" | "zh-TW", stuck = "stuck") {
  const base = K.SKINS.get("cozy"), bubbles: any[] = [];
  const skin = { ...base, drawCharacter() {}, drawFurniture() {}, drawBackground() {}, drawTag() {},
    drawBubble: (ctx: any, x: number, y: number, text: string, env: any, lift = 0) => { if (text) bubbles.push({ text, box: K.bubbleBox(ctx, x, y, text, lift) }); } };
  const nodes = [{ name: "example-agent", state: stuck, i: { name: "example-agent" } }, { name: "general", state: "idle", i: { name: "general" } }];
  const L = Z.zonesLayout(base.pack, nodes);
  const looks = new Map(L.rooms.flatMap((r: any) => r.desks).filter((d: any) => d.node).map((d: any) => [d.key,
    { name: d.node.name, label: d.node.name, state: d.node.state, pose: d.node.state }]));
  const part = { ...F.partOf(L, looks, skin, true, Z.createWalkers(), { frame: () => [], size: () => 0 }), lang };
  const ctx = new Proxy({ measureText(t: string) { const px = Number(/(\d+)px/.exec(this.font)?.[1] ?? 10);
    return { width: [...t].reduce((w, c) => w + (c.codePointAt(0)! >= 0x2e80 ? px : px * 0.6), 0) }; }, font: "" } as any,
    { get(o, k) { if (k in o) return typeof o[k] === "function" ? o[k].bind(o) : o[k]; return () => {}; }, set(o, k, v) { o[k] = v; return true; } });
  const env = { pal: { ...K.DEFAULT_PAL }, mode: "light", labels: { areas: lang === "en" ? { desks: "Desks", lounge: "Lounge", alert: "Help desk", nap: "Nap corner" } : { desks: "工作區", lounge: "休息區", alert: "求救區", nap: "午睡角" } } };
  const hits: any[] = [];
  F.drawPart(ctx, part, 1, 0, 0, 0, true, null, env, false, null, hits);
  const titles = base.areaTitleBox ? Object.values(L.areas).map((a: any) => base.areaTitleBox(ctx, a, env)) : [];
  return { bubbles, hits, titles, L };
}

describe("Cozy: a stuck agent at the Help desk has its bubble (beta.20 left it out)", () => {
  for (const lang of ["en", "zh-TW"] as const) {
    for (const state of ["stuck", "needs", "crashed"]) {
      it(`${lang}, ${state}: the call is drawn, and it is a click target (opens their chat, #4283)`, () => {
        const s = cozy(lang, state);
        expect(s.titles.length, "Cozy writes its areas' names").toBeGreaterThan(0);
        expect(s.bubbles.length, `${state} bubble drawn`).toBeGreaterThanOrEqual(1);
        expect(s.hits.some((h: any) => h.name === "example-agent"), "its click target").toBe(true);
      });
    }
  }
});
