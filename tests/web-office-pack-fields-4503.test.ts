/**
 * #4503: three zones-pack fields.
 * - a seat's `standFacing`: whoever works there stands facing that way (the walk strip's first frame), not typing;
 * - a stop's `queue`: where seat i's worker waits off the platform; they step on once the train is in, with the time to;
 * - a vehicle seat's `worker`: that agent's workplace — it rides there while working, nobody else takes the seat.
 * Calls stay first: a worker rides only while working, so a call takes it out of the queue and off the train at once.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as PK from "../src/ui/fleet-office-pack.js";
// @ts-expect-error — a JS module of the app, with no types
import { createRiders } from "../src/ui/fleet-office-vehicles.js";
// @ts-expect-error — a JS module of the app, with no types
import { zonesLayout } from "../src/ui/fleet-office-zones.js";
import { OfficeActLimiter, OfficeActs } from "../src/web-office-acts.js";
import { page, type AppPage } from "./helpers/app-harness.js";

// workVehicleOf lives in fleet-office.js (a browser module): loaded once through the app harness.
let workVehicleOf: (vehicles: any[], name: string, state: string) => string | null;
beforeAll(async () => { const p = page(); workVehicleOf = (await import("/ui/js/fleet-office.js")).workVehicleOf; p.restore(); });

const FIXTURE = join(process.cwd(), "tests", "fixtures", "office-skin-clinic");
const MANIFEST = () => JSON.parse(readFileSync(join(FIXTURE, "manifest.json"), "utf8"));
const STRIP = { src: "fox_idle.png", frames: 4, w: 32, h: 48 };
// A square loop, 400 a side at 100 a second: 4 s a side, a 2 s stop at the corner (400, 0) from 4 s to 6 s of each 18 s lap.
const TRAIN = (more: object = {}) => ({ id: "loop", sprite: STRIP, path: [[0, 0], [400, 0], [400, 400], [0, 400]], speed: 100,
  stops: [{ at: 1, seconds: 2, platform: [420, 10] }], seats: [{ dx: -20 }, { dx: 0 }, { dx: 20 }], ...more });
const check = (m: object) => PK.checkSkinPack({ ...MANIFEST(), ...m }) as any;
const withVehicles = (vehicles: unknown) => check({ vehicles });
/** The fixture's first area, its first seat given `seat`'s extra fields. */
function withSeat(extra: object) {
  const m = MANIFEST(), [name, area] = Object.entries(m.areas)[0] as [string, any];
  const s0 = area.seats[0], xy = Array.isArray(s0) ? { x: s0[0], y: s0[1] } : { x: s0.x, y: s0.y };
  area.seats[0] = { ...xy, ...extra };
  return { r: PK.checkSkinPack(m) as any, name, xy };
}

describe("checked", () => {
  it("standFacing: kept on the seat, and on the desk zonesLayout gives whoever sits there", () => {
    const { r, name, xy } = withSeat({ standFacing: "left" });
    expect(r.ok).toBe(true);
    expect(r.pack.areas[name].seats[0]).toEqual({ ...xy, standFacing: "left" });
    const working = Object.entries(r.pack.stateZones).find(([, a]) => a === name)?.[0] ?? "working";
    const L = zonesLayout(r.pack, [{ name: "alpha", state: working, i: { name: "alpha" } }]);
    const desk = L.rooms[0].desks.find((d: any) => d.node.name === "alpha");
    expect(desk.seat).toEqual({ ...xy, standFacing: "left" });
    expect(withSeat({}).r.pack.areas[name].seats[0]).toEqual(xy);                                   // none: as before
  });
  it("queue and worker: kept; none: no key", () => {
    const r = withVehicles([TRAIN({ stops: [{ at: 1, platform: [420, 10], queue: [[460, 10], [480, 10]] }], seats: [{ worker: "alpha" }, { dx: 5 }] })]);
    expect(r.ok).toBe(true);
    const v = r.pack.vehicles[0];
    expect(v.stops[0].queue).toEqual([{ x: 460, y: 10 }, { x: 480, y: 10 }]);
    expect(v.seats).toEqual([{ dx: 0, dy: 0, worker: "alpha" }, { dx: 5, dy: 0 }]);
    const plain = withVehicles([TRAIN()]).pack.vehicles[0];
    expect(["queue" in plain.stops[0], plain.seats.some((s: any) => "worker" in s)]).toEqual([false, false]);
  });
  it.each([
    [() => withSeat({ standFacing: "north" }).r, ".seats[0].standFacing: up, down, left or right"],
    [() => withVehicles([TRAIN({ stops: [{ at: 1, platform: [420, 10], queue: [[1, 1], [2, 2], [3, 3], [4, 4]] }] })]), "vehicles[0].stops[0].queue: at most one point a seat (3)"],
    [() => withVehicles([TRAIN({ stops: [{ at: 1, platform: [420, 10], queue: [[99999, 1]] }] })]), "vehicles[0].stops[0].queue[0][0]: a number from 0 to"],
    [() => withVehicles([TRAIN({ seats: [{ worker: "same" }, { worker: "same" }] })]), "vehicles[0].seats[1].worker: an instance's name no other vehicle seat has"],
    [() => withVehicles([TRAIN({ seats: [{ worker: "same" }] }), TRAIN({ id: "bus", seats: [{ worker: "same" }] })]), "vehicles[1].seats[0].worker: an instance's name no other vehicle seat has"],
    [() => withVehicles([TRAIN({ seats: [{ worker: 7 }] })]), "vehicles[0].seats[0].worker: an instance's name"],
    [() => withVehicles([TRAIN({ seats: [{ worker: ["a"] }] })]), "vehicles[0].seats[0].worker: an instance's name no other vehicle seat has"],
  ])("refused (%#)", (make, message) => {
    const r = make();
    expect(r.ok).toBe(false);
    expect(r.error).toContain(message);
  });
});

describe("a worker's seat (createRiders)", () => {
  const train = (more: object = {}) => withVehicles([TRAIN(more)]).pack.vehicles[0];
  const world = (v: any, wants: Record<string, string | null>, pos: (n: string) => any) => ({
    wants: new Map(Object.entries(wants)), vehicles: new Map([["loop", v]]), posOf: pos, homeOf: () => null });
  it("rides only while working, and a call (needs, crashed, stuck) never", () => {
    const v = train({ seats: [{ worker: "alpha" }, {}] });
    expect(workVehicleOf([v], "alpha", "working")).toBe("loop");
    for (const state of ["idle", "needs", "crashed", "stuck", "paused"]) expect(workVehicleOf([v], "alpha", state)).toBeNull();
    expect(workVehicleOf([v], "beta", "working")).toBeNull();
  });
  it("the worker takes their own seat; everyone else only the others, even with the worker's free", () => {
    const v = train({ seats: [{ worker: "alpha" }, { worker: "beta" }, {}] }), at = { x: 420, y: 10, walking: false };
    const r = createRiders(), w = world(v, { guest: "loop", other: "loop", beta: "loop" }, () => at);
    r.step({ ...w, wall: 0 });
    expect(r.step({ ...w, wall: 4200 }).board).toEqual([{ name: "guest", vehicle: "loop", seat: 2 }, { name: "beta", vehicle: "loop", seat: 1 }]);
    expect(r.phase("other")).toBe("waiting");                                   // seat 0 is alpha's, though alpha is not here
    const r2 = createRiders(), w2 = world(v, { alpha: "loop" }, () => at);
    r2.step({ ...w2, wall: 0 });
    expect(r2.step({ ...w2, wall: 4200 }).board).toEqual([{ name: "alpha", vehicle: "loop", seat: 0 }]);
  });
  it("a page opened long after: on board in their own seat", () => {
    const v = train({ seats: [{}, { worker: "alpha" }] }), r = createRiders();
    const s = r.step({ ...world(v, { alpha: "loop" }, () => null), wall: 500000, sinceOf: () => 0 });
    expect(s.board).toEqual([{ name: "alpha", vehicle: "loop", seat: 1 }]);
  });
  it("waits at their queue point, steps onto the platform once the train is in, boards there", () => {
    const v = train({ stops: [{ at: 1, seconds: 2, platform: [420, 10], queue: [[460, 10]] }], seats: [{ worker: "alpha" }, {}] });
    const r = createRiders();
    let pos: any = { x: 100, y: 100, walking: false };
    const w = world(v, { alpha: "loop", guest: "loop" }, (n) => (n === "alpha" ? pos : { x: 300, y: 300, walking: true }));
    let s = r.step({ ...w, wall: 1000 });
    expect(s.targets.get("alpha")).toEqual({ x: 460, y: 10 });                 // their queue point, not the platform
    expect(s.targets.get("guest")).toEqual({ x: 420, y: 10 });                 // no worker: the platform, as before
    pos = { x: 460, y: 10, walking: false };
    s = r.step({ ...w, wall: 1000 });
    expect(r.phase("alpha")).toBe("waiting");
    s = r.step({ ...w, wall: 4000 });                                            // in, 2 s left: time to step 40 units
    expect([r.phase("alpha"), s.targets.get("alpha"), s.board]).toEqual(["stepping", { x: 420, y: 10 }, []]);
    pos = { x: 420, y: 10, walking: false };
    expect(r.step({ ...w, wall: 4800 }).board).toEqual([{ name: "alpha", vehicle: "loop", seat: 0 }]);
  });
  it("no time to reach the platform: waits for the next; it leaves while they step: back to the queue", () => {
    const v = train({ stops: [{ at: 1, seconds: 2, platform: [420, 10], queue: [[420, 300]] }], seats: [{ worker: "alpha" }] });
    let pos: any = { x: 420, y: 300, walking: false };
    const r = createRiders(), w = world(v, { alpha: "loop" }, () => pos);
    r.step({ ...w, wall: 0 });
    r.step({ ...w, wall: 4000 });                                                // 290 units at 0.2 a ms: 1.45 s, a tick and the board time — not in 2 s
    expect(r.phase("alpha")).toBe("waiting");
    const v2 = train({ stops: [{ at: 1, seconds: 8, platform: [420, 10], queue: [[420, 300]] }], seats: [{ worker: "alpha" }] });
    const r2 = createRiders(), w2 = world(v2, { alpha: "loop" }, () => pos);
    r2.step({ ...w2, wall: 0 });
    r2.step({ ...w2, wall: 4000 });                                              // 8 s at the stop: on their way
    expect(r2.phase("alpha")).toBe("stepping");
    pos = { x: 420, y: 150, walking: true };
    const s = r2.step({ ...w2, wall: 11900 });                                   // it has left (100 ms short of the board time)
    expect([r2.phase("alpha"), s.targets.get("alpha"), s.board]).toEqual(["going", { x: 420, y: 300 }, []]);
  });
  it("a call takes a waiting worker out of the queue, and a riding one off at once", () => {
    const v = train({ stops: [{ at: 1, seconds: 2, platform: [420, 10], queue: [[460, 10]] }], seats: [{ worker: "alpha" }] });
    const at = { x: 460, y: 10, walking: false }, r = createRiders();
    let state = "working";
    const tick = (wall: number) => r.step({ wants: new Map([["alpha", workVehicleOf([v], "alpha", state)]]), vehicles: new Map([["loop", v]]),
      posOf: () => at, homeOf: () => null, wall, urgent: () => state !== "working" && state !== "idle" });
    tick(0);
    expect(r.phase("alpha")).toBe("waiting");
    state = "needs";
    const s = tick(500);
    expect([r.phase("alpha"), s.targets.has("alpha")]).toEqual([null, false]); // free to walk to the Help desk
    state = "working";
    tick(1000); tick(4000);
    r.step({ wants: new Map([["alpha", "loop"]]), vehicles: new Map([["loop", v]]), posOf: () => ({ x: 420, y: 10, walking: false }), homeOf: () => null, wall: 4200 });
    expect(r.riding("alpha")).toEqual({ vehicle: "loop", seat: 0 });
    state = "stuck";
    expect(tick(9000).alight.map((a: any) => a.name)).toEqual(["alpha"]);       // between stops, at once
    expect(r.riding("alpha")).toBeNull();
  });
});

describe("office_set ride and workers' seats", () => {
  const office = { id: "o", name: "O", skin: "clinic-sample", members: ["alpha", "beta"] };
  const make = (p: any) => new OfficeActs({ offices: () => [office as any], pack: () => p, chart: () => ({ names: ["alpha", "beta"], teams: [] }),
    people: () => ({ stateOf: () => "idle", displayName: () => undefined }), changed: () => {} }, { limiter: new OfficeActLimiter(() => 0) });
  it("refused when every seat is another agent's workplace; the worker itself may ride", () => {
    const p = withVehicles([TRAIN({ seats: [{ worker: "alpha" }] })]).pack;
    expect(make(p).set("beta", { ride: "loop" })).toMatchObject({ error: "ride", message: 'ride: every seat of "loop" is another agent\'s workplace.' });
    expect((make(p).set("alpha", { ride: "loop" }) as any).act.ride).toBe("loop");
    expect((make(withVehicles([TRAIN({ seats: [{ worker: "alpha" }, {}] })]).pack).set("beta", { ride: "loop" }) as any).act.ride).toBe("loop");
  });
});

describe("drawn (drawPart)", () => {
  let p: AppPage, Z: any, K: any, F: any;
  beforeAll(async () => {
    p = page({ url: "http://127.0.0.1:19280/ui/fleet/org" });
    Z = await import("/ui/js/fleet-office-zones.js");
    K = await import("/ui/js/fleet-office-skin.js");
    F = await import("/ui/js/fleet-office.js");
  });
  afterAll(async () => { await p.unmount(); p.restore(); });
  /** Cozy with every seat of every area (the Help desk's too) facing `facing` (or plain), one agent in `state`: what drawCharacter got. */
  function drawn(state: string, facing: string | null, waitingFor: ((n: string) => any) | null = null, preview: any = null) {
    const base = K.SKINS.get("cozy"), calls: any[] = [];
    const pack = { ...base.pack, areas: Object.fromEntries(Object.entries(base.pack.areas).map(([k, a]: [string, any]) => [k,
      { ...a, seats: a.seats.map((s: any) => (facing ? { ...s, standFacing: facing } : s)) }])) };
    const skin = { ...base, pack, drawCharacter: (_c: any, _b: any, look: any, ms: number) => calls.push({ look, ms }), drawFurniture() {}, drawBackground() {}, drawTag() {}, drawBubble() {} };
    const L = Z.zonesLayout(pack, [{ name: "example-agent", state, i: { name: "example-agent" } }]);
    const looks = new Map(L.rooms.flatMap((r: any) => r.desks).filter((d: any) => d.node).map((d: any) => [d.key,
      { name: d.node.name, label: d.node.name, state: d.node.state, pose: d.node.state }]));
    const part = { ...F.partOf(L, looks, skin, true, Z.createWalkers(), { frame: () => [], size: () => 0 }), lang: "en", waitingFor, preview: { current: preview } };
    const ctx = new Proxy({ measureText: (t: string) => ({ width: t.length * 6 }), font: "" } as any,
      { get(o, k) { if (k in o) return typeof o[k] === "function" ? o[k].bind(o) : o[k]; return () => {}; }, set(o, k, v) { o[k] = v; return true; } });
    F.drawPart(ctx, part, 1, 0, 0, 1234, false, null, { pal: { ...K.DEFAULT_PAL }, mode: "light", labels: { areas: {} } }, false, null, []);
    const desk = L.rooms[0].desks[0];
    return { ...calls.find((c) => c.look.name === "example-agent"), seat: desk.seat };
  }
  it("working at a standing desk: the walk strip's first frame, facing that way", () => {
    expect(drawn("working", "left")).toMatchObject({ look: { pose: "walk", heading: { dx: -1, dy: 0 } }, ms: 0 });
    expect(drawn("working", "up")).toMatchObject({ look: { pose: "walk", heading: { dx: 0, dy: -1 } }, ms: 0 });
  });
  it("no standFacing, or not working (a call above all): their own pose, playing", () => {
    expect(drawn("working", null)).toMatchObject({ look: { pose: "working" }, ms: 1234 });
    const L = drawn("needs", "left");
    expect(L.look.pose).not.toBe("walk");
    expect(L.ms).toBe(1234);
  });
  it("a walking pose preview at a standing desk animates, and clearing it restores the still first frame", () => {
    const pv = { name: "example-agent", pose: "walkUp", t0: 42 };
    expect(drawn("working", "left", null, pv)).toMatchObject({ look: { pose: "walk", heading: { dx: 0, dy: -1 }, clip: "#42" }, ms: 1234 });
    expect(drawn("working", "left")).toMatchObject({ look: { pose: "walk", heading: { dx: -1, dy: 0 } }, ms: 0 });
    expect(drawn("needs", "left", null, pv).look.clip).toBeUndefined();
  });
  it("a queue worker's walking preview animates without losing the waiting direction when it ends", () => {
    const at = drawn("working", null).seat;
    const waiting = () => ({ x: at.x + 200, y: at.y + 10 });
    expect(drawn("working", null, waiting, { name: "example-agent", pose: "walkUp", t0: 7 })).toMatchObject({ look: { pose: "walk", heading: { dx: 0, dy: -1 }, clip: "#7" }, ms: 1234 });
    expect(drawn("working", null, waiting)).toMatchObject({ look: { pose: "walk", heading: { dx: 200, dy: 10 } }, ms: 0 });
  });
  it("working and waiting for their train: stands facing where it stops", () => {
    const at = drawn("working", null).seat;
    expect(drawn("working", null, () => ({ x: at.x + 200, y: at.y + 10 }))).toMatchObject({ look: { pose: "walk", heading: { dx: 200, dy: 10 } }, ms: 0 });
    expect(drawn("idle", null, () => ({ x: at.x + 200, y: at.y }))).not.toMatchObject({ look: { pose: "walk" } });
  });
});
