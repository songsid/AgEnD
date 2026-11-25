/**
 * #4467 review: nothing new in the Office keeps a caller from the Help desk or hides who is calling.
 * - cardStay: whoever's card is open stays where they are, unless carried or calling (needs, crashed, stuck): then they
 *   walk to their Help-desk seat as usual.
 * - Hide names and levels (drawPart's tagsOff "names"): a caller keeps their tag; a tile too small to read (true) none.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { page, type AppPage } from "./helpers/app-harness.js";

let p: AppPage, Z: any, K: any, F: any;
beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19280/ui/fleet/org" });
  Z = await import("/ui/js/fleet-office-zones.js");
  K = await import("/ui/js/fleet-office-skin.js");
  F = await import("/ui/js/fleet-office.js");
});
afterAll(async () => { await p.unmount(); p.restore(); });

const CALLS = ["needs", "crashed", "stuck"];
const layout = (state: string) => Z.zonesLayout(K.SKINS.get("cozy").pack, [
  { name: "alpha", state, i: { name: "alpha" } }, { name: "beta", state: "idle", i: { name: "beta" } }]);
const desks = (L: any) => L.rooms.flatMap((r: any) => r.desks).filter((d: any) => d.node);
const targets = (L: any, t: number) => Z.walkTargets(desks(L), L, t, false);
const xy = (v: any) => (Array.isArray(v) ? { x: v[0], y: v[1] } : { x: v.x, y: v.y });

describe("cardStay: a carded person stays put, a caller does not", () => {
  /** Alpha idle and standing at their place; then their state turns to `state` (the targets as the walk tick has them). */
  const setUp = (state: string) => {
    const w = Z.createWalkers(), L1 = layout("idle");
    w.sync(targets(L1, 0), 0, L1, true);
    const L2 = layout(state);
    return { w, L2, here: w.at("alpha", 1000), to: targets(L2, 1000) };
  };
  it("idle with the card open: the target is where they stand", () => {
    const { w, here, to } = setUp("idle");
    F.cardStay(to, { name: "alpha", state: "idle", walks: true }, null, w, 1000);
    expect(to.get("alpha")).toEqual({ x: here.x, y: here.y });
  });
  for (const state of CALLS) it(`card open, then ${state}: the target is their Help-desk seat, and they get there`, () => {
    const { w, L2, here, to } = setUp(state);
    const seat = to.get("alpha");
    expect(L2.areas.alert.seats.map(xy), "the target walkTargets gives a caller is a Help-desk seat").toContainEqual({ x: seat.x, y: seat.y });
    expect({ x: seat.x, y: seat.y }).not.toEqual({ x: here.x, y: here.y });
    F.cardStay(to, { name: "alpha", state, walks: true }, null, w, 1000);
    expect(to.get("alpha")).toBe(seat);
    w.sync(to, 1000, L2);
    expect(w.at("alpha", 1000 + 600000)).toMatchObject({ x: seat.x, y: seat.y, walking: false });
  });
  it("no card, a card that does not walk (the overview), or one carried: the targets are untouched", () => {
    const { w, to } = setUp("idle"), was = new Map(to);
    F.cardStay(to, null, null, w, 1000);
    F.cardStay(to, { name: "alpha", state: "idle", walks: false }, null, w, 1000);
    F.cardStay(to, { name: "alpha", state: "idle", walks: true }, { name: "alpha", at: { x: 1, y: 2 } }, w, 1000);
    expect(to).toEqual(was);
  });
});

describe("Hide names and levels: a caller keeps their tag", () => {
  /** Cozy as the page draws it (drawPart), Alpha in `state` and Beta idle: whose tags are drawn. */
  const tags = (state: string, tagsOff: boolean | string) => {
    const base = K.SKINS.get("cozy"), drawn: string[] = [];
    const skin = { ...base, drawCharacter() {}, drawFurniture() {}, drawBackground() {}, drawBubble() {}, drawAreaTitle() {},
      drawTag: (_c: any, _x: number, _y: number, look: any) => { drawn.push(look.name); } };
    const L = layout(state);
    const looks = new Map(desks(L).map((d: any) => [d.key, { name: d.node.name, label: d.node.name, state: d.node.state, pose: d.node.state }]));
    const part = F.partOf(L, looks, skin, true, Z.createWalkers(), { frame: () => [], size: () => 0 });
    const ctx = new Proxy({ measureText: (t: string) => ({ width: t.length * 6 }), font: "" } as any,
      { get(o, k) { if (k in o) return o[k]; return () => {}; }, set(o, k, v) { o[k] = v; return true; } });
    F.drawPart(ctx, part, 1, 0, 0, 0, true, null, { pal: { ...K.DEFAULT_PAL }, mode: "light", labels: { areas: {} } }, tagsOff, null, []);
    return [...new Set(drawn)].filter((n) => n === "alpha" || n === "beta").sort();   // the people, not the style's NPCs
  };
  it("shown: everyone's tag", () => { expect(tags("needs", false)).toEqual(["alpha", "beta"]); });
  for (const state of CALLS) it(`hidden, Alpha ${state}: Alpha's tag only`, () => { expect(tags(state, "names")).toEqual(["alpha"]); });
  it("hidden, nobody calling: no tag", () => { expect(tags("idle", "names")).toEqual([]); });
  it("a tile too small to read (true): no tag, a caller's neither", () => { expect(tags("needs", true)).toEqual([]); });
});
