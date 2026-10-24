/**
 * #2596: an NPC drawn as furniture can stroll near its spot, like an idle person.
 * - The format: a furniture item's optional `walk` — strips keyed walk (required), walkDown, walkUp, walkSide; checked
 *   like every strip, its pictures the pack's and its strips listed for the host's size check.
 * - walkTargets: with `wander` on, an item with a walk gets wanderTarget's spot near its (x, y) in its AWAY window (its
 *   own phase, by npcKey), its spot otherwise; none with `wander` off, nor at night for one with a `night`.
 * - Drawn: where its walker is (strollFurniture), walking by its walk strip for the heading (walkSide mirrored left).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { page, type AppPage } from "./helpers/app-harness.js";

const FIXTURE = join(process.cwd(), "tests", "fixtures", "office-skin-clinic");
const MANIFEST = () => JSON.parse(readFileSync(join(FIXTURE, "manifest.json"), "utf8"));
const STRIP = (src: string) => ({ src, frames: 2, w: 16, h: 16 });

let p: AppPage;
let Z: any, PK: any, F: any;
beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19280/ui/fleet/org" });
  Z = await import("/ui/js/fleet-office-zones.js");
  PK = await import("/ui/js/fleet-office-pack.js");
  F = await import("/ui/js/fleet-office.js");
});
afterAll(async () => { await p.unmount(); p.restore(); });

const withWalk = (walk: any) => ({ ...MANIFEST(), furniture: [{ id: "keeper", sprite: STRIP("keeper.png"), x: 300, y: 300, depth: "y", label: "Shopkeeper", ...(walk === undefined ? {} : { walk }) }] });

describe("the format: a furniture item's walk", () => {
  it("strips keyed walk, walkDown, walkUp, walkSide, checked like any; absent: null", () => {
    const c = PK.checkSkinPack(withWalk({ walk: STRIP("k_walk.png"), walkSide: STRIP("k_side.png") }));
    expect(c.ok).toBe(true);
    const w = c.pack.furniture[0].walk;
    expect(Object.keys(w).sort()).toEqual(["walk", "walkSide"]);
    expect([w.walk.src, w.walk.dw, w.walk.ax]).toEqual(["k_walk.png", 32, 8]);   // the pack's scale, as every strip
    expect(PK.checkSkinPack(withWalk(undefined)).pack.furniture[0].walk).toBeNull();
  });
  it("refused: not an object, an unknown key, a bad strip, no walk", () => {
    expect(PK.checkSkinPack(withWalk("walk.png"))).toEqual({ ok: false, error: "furniture[0].walk: an object" });
    expect(PK.checkSkinPack(withWalk({ walk: STRIP("a.png"), run: STRIP("b.png") }))).toEqual({ ok: false, error: 'furniture[0].walk: unknown key "run"' });
    expect(PK.checkSkinPack(withWalk({ walk: { ...STRIP("a.png"), frames: 0 } }))).toEqual({ ok: false, error: "furniture[0].walk.walk.frames: a whole number from 1 to 32" });
    expect(PK.checkSkinPack(withWalk({ walkUp: STRIP("a.png") }))).toEqual({ ok: false, error: "furniture[0].walk.walk: required" });
  });
  it("its pictures are the pack's, its strips listed for the host's size check", () => {
    const pack = PK.checkSkinPack(withWalk({ walk: STRIP("k_walk.png"), walkUp: STRIP("k_up.png"), walkDown: STRIP("k_down.png"), walkSide: STRIP("k_side.png") })).pack;
    expect(PK.packImages(pack)).toEqual(expect.arrayContaining(["k_walk.png", "k_up.png", "k_down.png", "k_side.png"]));
    expect(PK.packStrips(pack).filter((s: any) => s.at.startsWith("furniture.keeper.walk.")).map((s: any) => s.at).sort())
      .toEqual(["furniture.keeper.walk.walk", "furniture.keeper.walk.walkDown", "furniture.keeper.walk.walkSide", "furniture.keeper.walk.walkUp"]);
  });
});

describe("walkTargets: an NPC strolls near its spot", () => {
  const GRAPH = { waypoints: [{ id: "a", x: 400, y: 300 }, { id: "b", x: 300, y: 200 }, { id: "far", x: 1100, y: 600 }], edges: [], areas: {} };
  const keeper = { id: "keeper", x: 300, y: 300, walk: { walk: STRIP("k.png") }, night: null };
  const ts = Array.from({ length: 80 }, (_, i) => i * 500);   // one PERIOD
  const at = (f: any, t: number, wander = true, night = false) => Z.walkTargets([], GRAPH, t, wander, [f], night).get(Z.npcKey(f));
  it("AWAY ms of every PERIOD at a near waypoint, its spot the rest; never the far one", () => {
    const spots = ts.map((t) => at(keeper, t));
    const away = spots.filter((q: any) => q.x !== 300 || q.y !== 300);
    expect(away.length * 500).toBe(Z.WANDER.AWAY);
    for (const q of away) expect(["400,300", "300,200"]).toContain(`${q.x},${q.y}`);
  });
  it("its own phase by npcKey: the same as wanderTarget's for that name", () => {
    for (const t of ts) expect(at(keeper, t)).toEqual(Z.wanderTarget(Z.npcKey(keeper), { x: 300, y: 300 }, GRAPH, t, []));
    expect(Z.npcKey(keeper)).toBe("furniture/keeper");
  });
  it("no stroll: wander off; at night with a night place; without a walk, no walker at all", () => {
    expect(ts.some((t) => at(keeper, t, false) !== undefined)).toBe(false);
    const sleeper = { ...keeper, night: { sprite: STRIP("z.png"), x: null, y: null } };
    expect(ts.some((t) => at(sleeper, t, true, true) !== undefined)).toBe(false);
    expect(ts.some((t) => { const q = at(keeper, t, true, true); return q.x !== 300 || q.y !== 300; })).toBe(true);   // no night place: strolls on
    expect(ts.some((t) => at({ ...keeper, walk: null }, t) !== undefined)).toBe(false);
  });
  it("never onto a seat of the office", () => {
    const g = { ...GRAPH, areas: { lounge: { seats: [{ x: 400, y: 300 }] } } };
    for (const t of ts) { const q = Z.walkTargets([], g, t, true, [keeper]).get("furniture/keeper"); expect(`${q.x},${q.y}`).not.toBe("400,300"); }
  });
});

describe("walkTargets: an NPC's spot is its own (#2596 review)", () => {
  const keeper = { id: "keeper", x: 300, y: 300, walk: { walk: STRIP("k.png") }, night: null };
  const alice = { node: { name: "alice", state: "idle" }, seat: { x: 212, y: 240 } };
  const ts = Array.from({ length: 80 }, (_, i) => i * 500);   // one PERIOD
  const targets = (waypoints: any[], t: number) => Z.walkTargets([alice], { waypoints, edges: [], areas: {} }, t, true, [keeper]);
  it("a waypoint on the keeper's spot: Alice never strolls onto it, and the two never share a target (Prism's case, t=3000)", () => {
    const on = [{ id: "w", x: 300, y: 300 }];
    for (const t of [3000, ...ts]) {
      const m = targets(on, t), a = m.get("alice"), k = m.get("furniture/keeper");
      expect(`${a.x},${a.y}`).not.toBe("300,300");
      expect(`${a.x},${a.y}`).not.toBe(`${k.x},${k.y}`);
    }
  });
  it("control: a waypoint off its spot is still strolled to, by each in turn, never by both at once", () => {
    const off = [{ id: "w", x: 400, y: 300 }];
    const seen = { alice: false, keeper: false };
    for (const t of ts) {
      const m = targets(off, t), a = m.get("alice"), k = m.get("furniture/keeper");
      if (a.x === 400) seen.alice = true;
      if (k.x === 400) seen.keeper = true;
      expect(`${a.x},${a.y}`).not.toBe(`${k.x},${k.y}`);
    }
    expect(seen.alice || seen.keeper).toBe(true);
  });
});

describe("drawn where it walks, by its walk strip", () => {
  const walk = { walk: STRIP("w.png"), walkDown: STRIP("d.png"), walkUp: STRIP("u.png"), walkSide: STRIP("s.png") };
  it("strollFurniture: moved to its walker, walking with the heading; asleep or no walker: where it is", () => {
    const f = { id: "keeper", x: 300, y: 300, walk, sprite: STRIP("k.png") };
    const walkers = new Map([["furniture/keeper", { x: 350, y: 300, walking: true, heading: { dx: 1, dy: 0 } }]]);
    const [m] = F.strollFurniture([f], (k: string) => walkers.get(k) || null);
    expect([m.x, m.y, m.walking, m.heading]).toEqual([350, 300, true, { dx: 1, dy: 0 }]);
    expect(F.strollFurniture([{ ...f, asleep: true }], (k: string) => walkers.get(k))[0].x).toBe(300);
    expect(F.strollFurniture([{ ...f, id: "lamp" }], (k: string) => walkers.get(k) || null)[0].x).toBe(300);
  });
  it("walkStrip by heading: down, up, side (mirrored going left); only walk: walk, never mirrored; standing: none", () => {
    const pick = (w: any, dx: number, dy: number) => { const r = PK.walkStrip({ walk: w, walking: true, heading: { dx, dy } }); return [r.strip.src, r.mirror]; };
    expect(pick(walk, 0, 5)).toEqual(["d.png", false]);
    expect(pick(walk, 1, -5)).toEqual(["u.png", false]);
    expect(pick(walk, 5, 1)).toEqual(["s.png", false]);
    expect(pick(walk, -5, 1)).toEqual(["s.png", true]);
    expect(pick({ walk: walk.walk }, -5, 0)).toEqual(["w.png", false]);
    expect(PK.walkStrip({ walk, walking: false })).toBeNull();
    expect(PK.walkStrip({ walk: null, walking: true })).toBeNull();
  });
});
