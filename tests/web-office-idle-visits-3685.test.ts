/**
 * #3685: a pack's `idleVisits` — an idle person now and then goes and sits in another area for a while.
 * - The manifest's `idleVisits: [{ area, weight 1–100, minSeconds 5–600, maxSeconds min–600 }]` (≤ 8, an area the pack
 *   defines, none twice, with stateZones only); checked on the host by the same module.
 * - visitAt: pure and deterministic from name + time; each turn's weights are rolled against VISIT.STROLL; a visit
 *   lasts the walk there plus minSeconds–maxSeconds; visits never overlap; never to their own area.
 * - walkTargets: only the idle (not asleep, `wander` on) visit; a free seat of the area — not reserved for someone
 *   else unless lent, nobody's seat, no other visitor's; home when it ends; a pack without idleVisits: as before.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { page, type AppPage } from "./helpers/app-harness.js";
import * as HPK from "../src/ui/fleet-office-pack.js";

let p: AppPage;
let PK: any, Z: any, M: any;
beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19280/ui/fleet/org" });
  PK = await import("/ui/js/fleet-office-pack.js");
  Z = await import("/ui/js/fleet-office-zones.js");
  M = await import("/ui/js/fleet-office-model.js");
});
afterAll(async () => { await p.unmount(); p.restore(); });

const STRIP = (src: string) => ({ src, frames: 2, w: 16, h: 16 });
const VISITS = [{ area: "spring", weight: 30, minSeconds: 20, maxSeconds: 60 }];
const MANIFEST = (extra: any = {}) => ({ format: 1, id: "visitpack", background: "bg.png",
  areas: {
    work: { rect: [0, 0, 600, 360], seats: [[100, 100], [200, 100], [300, 100]] },
    lounge: { rect: [0, 360, 600, 360], seats: [[100, 500], [200, 500], [300, 500], [400, 500]] },
    spring: { rect: [700, 0, 580, 360], seats: [[800, 100], { x: 900, y: 100, for: ["orbit"] }, { x: 1000, y: 100, for: ["orbit"], lend: true }, [1100, 100]] },
    garden: { rect: [700, 360, 580, 360], seats: [[800, 500]] },
  },
  stateZones: { working: "work", idle: "lounge", default: "lounge" },
  characters: { default: { idle: STRIP("i.png") } }, ...extra });
const check = (mod: any, extra: any) => mod.checkSkinPack(MANIFEST(extra));
const packOf = (extra: any = {}) => { const c = check(PK, extra); if (!c.ok) throw new Error(c.error); return c.pack; };

describe("the manifest's idleVisits", () => {
  it("optional: checked as given; absent or [] leaves the pack without the key; the host checks the same", () => {
    const two = [...VISITS, { area: "garden", weight: 100, minSeconds: 5, maxSeconds: 5 }];
    expect(packOf({ idleVisits: two }).idleVisits).toEqual(two);
    expect("idleVisits" in packOf()).toBe(false);
    expect("idleVisits" in packOf({ idleVisits: [] })).toBe(false);
    expect(check(HPK, { idleVisits: two })).toEqual(check(PK, { idleVisits: two }));
    expect(check(HPK, { idleVisits: [{ ...VISITS[0], area: "pool" }] })).toEqual(check(PK, { idleVisits: [{ ...VISITS[0], area: "pool" }] }));
  });
  it("refused: an unknown area, one twice, out-of-range numbers, more than 8, unknown keys, no stateZones — with where", () => {
    const bad = (v: any) => check(PK, { idleVisits: v });
    const one = (patch: any) => bad([{ ...VISITS[0], ...patch }]);
    expect(one({ area: "pool" })).toEqual({ ok: false, error: "idleVisits[0].area: an area the pack defines" });
    expect(one({ area: "constructor" })).toEqual({ ok: false, error: "idleVisits[0].area: an area the pack defines" });
    expect(bad([VISITS[0], VISITS[0]])).toEqual({ ok: false, error: "idleVisits[1].area: an area not listed before" });
    expect(one({ weight: 0 })).toEqual({ ok: false, error: "idleVisits[0].weight: a whole number from 1 to 100" });
    expect(one({ weight: 101 })).toEqual({ ok: false, error: "idleVisits[0].weight: a whole number from 1 to 100" });
    expect(one({ weight: 1.5 })).toEqual({ ok: false, error: "idleVisits[0].weight: a whole number from 1 to 100" });
    expect(one({ minSeconds: 4 })).toEqual({ ok: false, error: "idleVisits[0].minSeconds: a whole number from 5 to 600" });
    expect(one({ minSeconds: 601, maxSeconds: 601 })).toEqual({ ok: false, error: "idleVisits[0].minSeconds: a whole number from 5 to 600" });
    expect(one({ minSeconds: 30, maxSeconds: 29 })).toEqual({ ok: false, error: "idleVisits[0].maxSeconds: a whole number from 30 to 600" });
    expect(one({ maxSeconds: 601 })).toEqual({ ok: false, error: "idleVisits[0].maxSeconds: a whole number from 20 to 600" });
    expect(one({ weight: undefined })).toEqual({ ok: false, error: "idleVisits[0].weight: a whole number from 1 to 100" });
    expect(one({ seat: 0 })).toEqual({ ok: false, error: 'idleVisits[0]: unknown key "seat"' });
    expect(bad(Array.from({ length: 9 }, () => VISITS[0]))).toEqual({ ok: false, error: "idleVisits: at most 8" });
    expect(bad({ spring: 1 })).toEqual({ ok: false, error: "idleVisits: a list" });
    expect(bad(["spring"])).toEqual({ ok: false, error: "idleVisits[0]: an object" });
    expect(check(PK, { idleVisits: VISITS, stateZones: undefined })).toEqual({ ok: false, error: "idleVisits: only with stateZones" });
  });
  it("zonesLayout carries it (none: [])", () => {
    expect(Z.zonesLayout(packOf({ idleVisits: VISITS }), []).idleVisits).toEqual(VISITS);
    expect(Z.zonesLayout(packOf(), []).idleVisits).toEqual([]);
  });
});

// A layout to walk on: no waypoints, so a stroll is always the seat and a walk is a straight line.
const graphOf = (idleVisits: any[] = VISITS) => ({ ...Z.zonesLayout(packOf(idleVisits.length ? { idleVisits } : {}), []), waypoints: [], edges: [] });
const HOME = { x: 100, y: 500 };
const STEP = 1000;
/** Every visit `name` makes over `turns` wander turns, sampled each STEP ms. */
function visitsOver(name: string, g: any, turns: number, home = HOME, from = "lounge") {
  const out: any[] = [];
  for (let t = 0; t < turns * Z.WANDER.PERIOD; t += STEP) {
    const v = Z.visitAt(name, home, g, t, from);
    if (v && !out.some((o) => o.start === v.start)) out.push(v);
  }
  return out;
}

describe("visitAt", () => {
  it("pure and deterministic: the same answer whatever order it is asked in", () => {
    const g = graphOf(), ts = Array.from({ length: 400 }, (_, i) => i * 7919);
    const forward = ts.map((t) => Z.visitAt("atlas", HOME, g, t, "lounge"));
    const backward = [...ts].reverse().map((t) => Z.visitAt("atlas", HOME, g, t, "lounge")).reverse();
    expect(backward).toEqual(forward);
    expect(forward.some(Boolean)).toBe(true);
  });
  it("a visit starts on a wander turn, lasts the longest walk there plus minSeconds–maxSeconds (whole seconds); visits never overlap", () => {
    // The seat is walkTargets' to pick: the visit leaves room for the farthest one (here a straight line to each).
    const g = graphOf(), walk = Math.max(...g.areas.spring.seats.map((q: any) => Math.ceil(Math.hypot(q.x - HOME.x, q.y - HOME.y) / Z.WALK.SPEED)));
    for (const name of ["atlas", "quill", "sage"]) {
      const vs = visitsOver(name, g, 200);
      expect(vs.length).toBeGreaterThan(5);
      const phase = M.nameHash(name) % Z.WANDER.PERIOD;
      vs.forEach((v, i) => {
        expect(v.area).toBe("spring");
        expect((v.start + phase) % Z.WANDER.PERIOD).toBe(0);
        const stay = v.end - v.start - walk - Z.VISIT.SLACK;
        expect(stay).toBe(v.stay);
        expect(stay % 1000).toBe(0);
        expect(stay).toBeGreaterThanOrEqual(20000);
        expect(stay).toBeLessThanOrEqual(60000);
        if (i) expect(v.start).toBeGreaterThanOrEqual(vs[i - 1].end + walk);   // home again before the next one
        expect(Z.visitAt(name, HOME, g, v.end - 1, "lounge")).toEqual(v);
        expect(Z.visitAt(name, HOME, g, v.start - 1, "lounge")?.start).not.toBe(v.start);
      });
    }
  });
  it("the weights against STROLL (100): weight 100 is a visit at about half the turns that start at home", () => {
    const g = graphOf([{ area: "spring", weight: 100, minSeconds: 5, maxSeconds: 5 }]);
    let rolled = 0, visited = 0;
    for (const name of ["a", "b", "c", "d", "e", "f", "g", "h"]) {
      const phase = M.nameHash(name) % Z.WANDER.PERIOD;
      for (let turn = 1; turn < 200; turn++) {
        const t = turn * Z.WANDER.PERIOD - phase;
        const before = Z.visitAt(name, HOME, g, t - 1, "lounge");
        if (before) continue;                                           // still away: this turn rolls nothing
        rolled++;
        if (Z.visitAt(name, HOME, g, t, "lounge")?.start === t) visited++;
      }
    }
    expect(visited / rolled).toBeGreaterThan(0.35);
    expect(visited / rolled).toBeLessThan(0.65);
  });
  it("never to their own area, nor an area the layout lacks; no idleVisits: always null", () => {
    expect(visitsOver("atlas", graphOf(), 200, { x: 800, y: 100 }, "spring")).toEqual([]);
    expect(visitsOver("atlas", { ...graphOf(), areas: { lounge: graphOf().areas.lounge } }, 100)).toEqual([]);
    expect(visitsOver("atlas", graphOf([]), 100)).toEqual([]);
  });
});

const key = (q: any) => `${q.x},${q.y}`;
const idleAt = (name: string, seat: any, area = "lounge", extra: any = {}) => ({ node: { name, state: "idle" }, seat, area, ...extra });

describe("walkTargets with idleVisits", () => {
  it("only the idle visit — not the working, the asleep, nor anyone with wander off; home again when it ends", () => {
    const g = graphOf();
    const desks = [idleAt("atlas", HOME), { node: { name: "quill", state: "working" }, seat: { x: 100, y: 100 }, area: "work" },
      idleAt("sage", { x: 200, y: 500 }, "lounge", { night: true }), { node: { name: "orbit2", state: "paused" }, seat: { x: 300, y: 500 }, area: "lounge" }];
    let away = 0;
    for (let t = 0; t < 120 * Z.WANDER.PERIOD; t += STEP) {
      const m = Z.walkTargets(desks, g, t), v = Z.visitAt("atlas", HOME, g, t, "lounge");
      for (const d of desks.slice(1)) expect(m.get(d.node.name)).toBe(d.seat);
      // Away only on a visit (and home again once its stay is over, before the visit's own end).
      if (m.get("atlas") !== HOME) { away++; expect(v).not.toBeNull(); expect(key(m.get("atlas"))).toMatch(/^(800|1000|1100),100$/); } else if (!v) expect(m.get("atlas")).toBe(HOME);
      expect(Z.walkTargets(desks, g, t, false).get("atlas")).toBe(HOME);
    }
    expect(away).toBeGreaterThan(0);
  });
  it("a free seat: never one reserved for someone else (unless lent) nor anyone's; its owner may use theirs", () => {
    const g = graphOf();
    const sitting = { node: { name: "quill", state: "working" }, seat: { x: 1100, y: 100 }, area: "spring" };   // on the spring's last seat
    const seen = new Set<string>(), owner = new Set<string>();
    for (let t = 0; t < 300 * Z.WANDER.PERIOD; t += STEP) {
      const m = Z.walkTargets([idleAt("atlas", HOME), idleAt("orbit", { x: 200, y: 500 }), sitting], g, t);
      const a = m.get("atlas"), o = m.get("orbit");
      if (a.x !== HOME.x || a.y !== HOME.y) seen.add(key(a));
      if (o.x !== 200 || o.y !== 500) owner.add(key(o));
    }
    expect([...seen].sort()).toEqual(["1000,100", "800,100"]);                 // not 900 (orbit's, not lent), not 1100 (taken)
    expect(owner.has("900,100")).toBe(true);                                    // orbit's own reserved seat is free for orbit
    expect(owner.has("1100,100")).toBe(false);
  });
  it("no two walkers share a target; whoever finds no free seat strolls (here: stays home) instead", () => {
    const g = graphOf([{ area: "garden", weight: 100, minSeconds: 60, maxSeconds: 120 }]);   // the garden has one seat
    const desks = ["a", "b", "c", "d", "e", "f"].map((n, i) => idleAt(n, { x: 100 + i * 60, y: 600 }));
    let crowded = 0;
    for (let t = 0; t < 100 * Z.WANDER.PERIOD; t += STEP) {
      const m = Z.walkTargets(desks, g, t);
      const out = desks.filter((d) => key(m.get(d.node.name)) !== key(d.seat)).map((d) => key(m.get(d.node.name)));
      expect(new Set(out).size).toBe(out.length);
      for (const q of out) expect(q).toBe("800,500");
      // On a visit and not yet home: the walk there from their seat plus the stay (then home, before the visit's end).
      const on = desks.filter((d) => { const v = Z.visitAt(d.node.name, d.seat, g, t, "lounge"); return v && t < v.start + Math.ceil(Math.hypot(800 - d.seat.x, 500 - d.seat.y) / Z.WALK.SPEED) + v.stay; });
      if (on.length > 1) { crowded++; expect(out.length).toBe(1); }
      if (on.length) {                                                          // the earliest visit holds the seat
        const first = [...on].sort((x, y) => Z.visitAt(x.node.name, x.seat, g, t, "lounge").start - Z.visitAt(y.node.name, y.seat, g, t, "lounge").start || (x.node.name < y.node.name ? -1 : 1))[0];
        expect(key(m.get(first.node.name))).toBe("800,500");
      }
    }
    expect(crowded).toBeGreaterThan(0);
  });
  it("a visit never takes a stroller's spot, nor a stroller a visitor's seat", () => {
    const pk = packOf({ idleVisits: [{ area: "spring", weight: 100, minSeconds: 5, maxSeconds: 30 }], waypoints: [{ id: "w1", x: 150, y: 450 }, { id: "w2", x: 250, y: 450 }, { id: "on", x: 800, y: 100 }], edges: [["w1", "w2"]] });
    const g = Z.zonesLayout(pk, []);
    const desks = ["a", "b", "c", "d"].map((n, i) => idleAt(n, { x: 100 + i * 100, y: 500 }));
    for (let t = 0; t < 60 * Z.WANDER.PERIOD; t += STEP) {
      const m = Z.walkTargets(desks, g, t);
      const out = desks.filter((d) => key(m.get(d.node.name)) !== key(d.seat)).map((d) => key(m.get(d.node.name)));
      expect(new Set(out).size).toBe(out.length);
    }
  });
});

describe("#3697 review: arrival and seats already taken", () => {
  // A graph where the area's middle is near and its one seat far: home → w1 → w2 (by the middle) → w3 → w4 → w5 → seat.
  const detour = () => {
    const pk = packOf({ idleVisits: [{ area: "garden", weight: 100, minSeconds: 5, maxSeconds: 5 }],
      areas: { ...MANIFEST().areas, garden: { rect: [700, 0, 580, 360], seats: [[800, 100]] } },
      waypoints: [{ id: "w1", x: 150, y: 450 }, { id: "w2", x: 990, y: 190 }, { id: "w3", x: 1270, y: 350 }, { id: "w4", x: 1270, y: 10 }, { id: "w5", x: 810, y: 10 }],
      edges: [["w1", "w2"], ["w2", "w3"], ["w3", "w4"], ["w4", "w5"]] });
    return Z.zonesLayout(pk, []);
  };
  const route = (g: any, a: any, z: any) => Math.ceil(M.pathLength(M.routeVia({ waypoints: g.waypoints, edges: g.edges }, a, z)) / Z.WALK.SPEED);
  it("a visit lasts until the stay is over at the seat walked to, however far along the graph that seat is", () => {
    const g = detour(), seat = { x: 800, y: 100 }, r = g.areas.garden.rect;
    const far = route(g, HOME, seat), middle = route(g, HOME, { x: r.x + r.w / 2, y: r.y + r.h / 2 });
    expect(far).toBeGreaterThan(middle + 3000);                                  // the case: the seat's walk is the longer one
    let checked = 0;
    for (const name of ["atlas", "quill", "sage", "orbit"]) {
      for (const v of visitsOver(name, g, 120)) {
        const at = (t: number) => Z.walkTargets([idleAt(name, HOME)], g, t).get(name);
        expect(key(at(v.start))).toBe(key(seat));
        const leave = v.start + far + 5000;                                       // arrived, then the stay (min = max = 5 s)
        expect(leave).toBeLessThanOrEqual(v.end);
        expect(key(at(leave - 1))).toBe(key(seat));
        expect(at(leave)).toBe(HOME);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(3);
  });
  it("with the page's memory: home once the stay is over; a visit taken late starts then, and only if it still fits", () => {
    const g = graphOf([{ area: "spring", weight: 100, minSeconds: 30, maxSeconds: 30 }]);
    const work = { node: { name: "atlas", state: "working" }, seat: { x: 100, y: 100 }, area: "work" };
    const walkTo = (q: any) => Math.ceil(Math.hypot(q.x - HOME.x, q.y - HOME.y) / Z.WALK.SPEED);
    let early = 0, late = 0;
    for (const v of visitsOver("atlas", g, 200)) {
      // From the start: the seat, then home when the stay is over — before the visit's own end when the seat is near.
      const memo = { claims: new Map(), idle: null };
      const seat = Z.walkTargets([idleAt("atlas", HOME)], g, v.start, true, [], false, memo).get("atlas");
      const leave = v.start + walkTo(seat) + 30000;
      expect(key(Z.walkTargets([idleAt("atlas", HOME)], g, leave - 1, true, [], false, memo).get("atlas"))).toBe(key(seat));
      if (leave < v.end) { early++; expect(Z.walkTargets([idleAt("atlas", HOME)], g, leave, true, [], false, memo).get("atlas")).toBe(HOME); }
      // Working at the start, idle 10 s later: the visit is taken then — it no longer fits (its end left room for a
      // walk from the start), so atlas stays home.
      const lateMemo = { claims: new Map(), idle: null };
      Z.walkTargets([work], g, v.start, true, [], false, lateMemo);
      const far = v.end - v.start - 30000;
      if (v.start + 10000 + walkTo(seat) + 30000 > v.end && walkTo(seat) > far - 10000) {
        late++;
        expect(Z.walkTargets([idleAt("atlas", HOME)], g, v.start + 10000, true, [], false, lateMemo).get("atlas")).toBe(HOME);
      }
    }
    expect(early).toBeGreaterThan(0);
    expect(late).toBeGreaterThan(0);
  });
  it("polled as the page does (every second, between visits' starts): every visit to a one-seat area is taken", () => {
    const g = graphOf([{ area: "garden", weight: 100, minSeconds: 5, maxSeconds: 5 }]);    // the garden has one seat
    for (const name of ["a", "atlas", "quill"]) {
      const memo = { claims: new Map(), idle: null }, sat = new Set<number>();
      const vs = visitsOver(name, g, 120);
      for (let t = 237; t < 120 * Z.WANDER.PERIOD; t += Z.WANDER.TICK) {        // ticks never on a visit's start
        if (key(Z.walkTargets([idleAt(name, HOME)], g, t, true, [], false, memo).get(name)) === "800,500") {
          const v = Z.visitAt(name, HOME, g, t, "lounge"); if (v) sat.add(v.start);
        }
      }
      expect(vs.length).toBeGreaterThan(3);
      expect(sat.size).toBe(vs.length);
    }
  });
  it("the walk home is part of the visit's epoch: the next visit, in the next epoch too, starts once they are home", () => {
    // A stay sized so a visit started on an epoch's last turn ends inside the epoch but its walk home does not.
    const g0 = detour(), seat = { x: 800, y: 100 }, there = route(g0, HOME, seat), back = route(g0, seat, HOME);
    const S = Math.floor((Z.WANDER.PERIOD - there - (Z.VISIT.SLACK ?? 0) - back / 2) / 1000);
    expect([back > 5000, S >= 5]).toEqual([true, true]);
    const pk = packOf({ idleVisits: [{ area: "garden", weight: 100, minSeconds: S, maxSeconds: S }],
      areas: { ...MANIFEST().areas, garden: { rect: [700, 0, 580, 360], seats: [[800, 100]] } },
      waypoints: g0.waypoints, edges: g0.edges });
    const g = Z.zonesLayout(pk, []);
    let crossed = 0;
    for (const name of ["atlas", "quill", "sage", "orbit", "a", "b", "c", "d", "e", "f", "g", "h"]) {
      const vs = visitsOver(name, g, 12 * Z.VISIT.EPOCH);
      const phase = M.nameHash(name) % Z.WANDER.PERIOD, epochOf = (v: any) => Math.floor((v.start + phase) / Z.WANDER.PERIOD / Z.VISIT.EPOCH);
      for (let i = 1; i < vs.length; i++) {
        expect(vs[i].start).toBeGreaterThanOrEqual(vs[i - 1].end + back);
        if (epochOf(vs[i]) !== epochOf(vs[i - 1])) crossed++;
      }
    }
    expect(crossed).toBeGreaterThan(0);                                         // the case: pairs across an epoch's edge
  });
  it("someone turning idle later never moves a visitor already in the seat, even with an earlier visit by the clock", () => {
    const g = graphOf([{ area: "garden", weight: 100, minSeconds: 100, maxSeconds: 100 }]);   // the garden has one seat
    const homeA = { x: 100, y: 500 }, homeB = { x: 200, y: 500 }, workB = { x: 100, y: 100 };
    let found = 0;
    for (const a of visitsOver("atlas", g, 400, homeA)) {
      const t = a.start, b = Z.visitAt("quill", homeB, g, t, "lounge");
      if (!b || !(b.start < a.start) || b.end < t + 21000 || found >= 3) continue;   // quill's visit is the earlier one by the clock
      found++;
      const memo = { claims: new Map(), idle: null };
      const working = [idleAt("atlas", homeA), { node: { name: "quill", state: "working" }, seat: workB, area: "work" }];
      expect(key(Z.walkTargets(working, g, t, true, [], false, memo).get("atlas"))).toBe("800,500");   // atlas takes it
      const both = [idleAt("atlas", homeA), idleAt("quill", homeB)];
      for (const dt of [1000, 5000, 20000]) {
        const m = Z.walkTargets(both, g, t + dt, true, [], false, memo);
        expect(key(m.get("atlas"))).toBe("800,500");                              // still atlas's
        expect(key(m.get("quill"))).not.toBe("800,500");
      }
      // Without the page's memory, the clock alone decides (the earliest visit first), as for a page opened now.
      expect(key(Z.walkTargets(both, g, t + 1000).get("quill"))).toBe("800,500");
    }
    expect(found).toBeGreaterThan(0);
  });
});

// The walkTargets before #3685, as it was: a pack without idleVisits must walk exactly so.
function walkTargetsBefore(desks: any[], graph: any, t: number, wander = true, furniture: any[] = [], night = false) {
  const homes = wander ? furniture.filter((f) => f.walk && !(night && f.night)).map((f) => ({ x: f.x, y: f.y })) : [];
  const seats = [...Object.values(graph.areas || {}).flatMap((a: any) => a.seats || []), ...desks.map((d) => d.seat), ...homes];
  const used = new Set(homes.map((h) => `${h.x},${h.y}`));
  const stroll = (name: string, home: any) => {
    const q = Z.wanderTarget(name, home, graph, t, seats), k = `${q.x},${q.y}`;
    if (q === home || used.has(k)) return home;
    used.add(k);
    return q;
  };
  const out = new Map(desks.map((d) => [d.node.name, !wander || d.node.state !== "idle" || d.night ? d.seat : stroll(d.node.name, d.seat)]));
  if (wander) for (const f of furniture) if (f.walk && !(night && f.night)) out.set(Z.npcKey(f), stroll(Z.npcKey(f), { x: f.x, y: f.y }));
  return out;
}

describe("a pack without idleVisits", () => {
  it("walks exactly as before (people and walking NPCs, day and night, wander on and off)", () => {
    const pk = packOf({ waypoints: [{ id: "w1", x: 150, y: 450 }, { id: "w2", x: 250, y: 450 }, { id: "w3", x: 350, y: 450 }, { id: "w4", x: 820, y: 200 }], edges: [["w1", "w2"], ["w2", "w3"]] });
    const g = Z.zonesLayout(pk, []), noKey = { ...g, idleVisits: undefined };
    const desks = [idleAt("atlas", { x: 100, y: 500 }), idleAt("quill", { x: 200, y: 500 }), idleAt("sage", { x: 300, y: 500 }, "lounge", { night: true }),
      { node: { name: "orbit", state: "working" }, seat: { x: 100, y: 100 }, area: "work" }];
    const furniture = [{ id: "cat", x: 400, y: 450, walk: { walk: {} } }, { id: "owl", x: 800, y: 250, walk: { walk: {} }, night: {} }];
    let moved = 0;
    for (let t = 0; t < 30 * Z.WANDER.PERIOD; t += 500) {
      for (const [wander, night] of [[true, false], [true, true], [false, false]] as const) {
        const want = walkTargetsBefore(desks, g, t, wander, furniture, night);
        expect(Z.walkTargets(desks, g, t, wander, furniture, night)).toEqual(want);
        expect(Z.walkTargets(desks, noKey, t, wander, furniture, night)).toEqual(want);
        if ([...want].some(([n, q]) => { const d = desks.find((x) => x.node.name === n); return d && q !== d.seat; })) moved++;
      }
    }
    expect(moved).toBeGreaterThan(0);                                            // the comparison saw strolls, not only seats
  });
});
