/**
 * A pack's vehicles (a train on a loop of track) and the people who ride them:
 * - the pack's `vehicles`, checked (path, speed, stops with platforms, seats, pictures by heading) and their pictures
 *   loaded and size-checked as strips;
 * - where a vehicle is at a time (a function of the clock: round its path, waiting at each stop), its seats turned with it;
 * - riders: walk to the platform, wait, board only while it stops there, ride in a free seat, get off only at a stop;
 * - walkers that ride (their position is their seat's) and get off (place);
 * - office_set `ride`: an agent's own choice of a vehicle of its office, longer than an act, refused where it cannot be.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as PK from "../src/ui/fleet-office-pack.js";
// @ts-expect-error — a JS module of the app, with no types
import { createRiders, facing, seatAt, vehicleAt } from "../src/ui/fleet-office-vehicles.js";
// @ts-expect-error — a JS module of the app, with no types
import { createWalkers } from "../src/ui/fleet-office-zones.js";
import { OfficeActLimiter, OfficeActs, OFFICE_ACT_LIMITS, officeSpots } from "../src/web-office-acts.js";

const FIXTURE = join(process.cwd(), "tests", "fixtures", "office-skin-clinic");
const MANIFEST = () => JSON.parse(readFileSync(join(FIXTURE, "manifest.json"), "utf8"));
const STRIP = { src: "fox_idle.png", frames: 4, w: 32, h: 48 };
// A square loop, 400 a side at 100 a second: 4 s a side, a 2 s stop at the corner (400, 0).
const TRAIN = () => ({ id: "loop", label: "Loop line", sprite: STRIP, path: [[0, 0], [400, 0], [400, 400], [0, 400]], speed: 100,
  stops: [{ at: 1, seconds: 2, platform: [420, 10] }], seats: [{ dx: -20 }, { dx: 0 }, { dx: 20, dy: 5 }] });
const packWith = (vehicles: unknown) => PK.checkSkinPack({ ...MANIFEST(), vehicles }) as any;

describe("a pack's vehicles", () => {
  it("checked: defaults filled, its picture a strip like any other; none: no key", () => {
    const r = packWith([{ ...TRAIN(), speed: undefined, stops: [{ at: 1, platform: [420, 10] }] }]);
    expect(r.ok).toBe(true);
    const v = r.pack.vehicles[0];
    expect([v.id, v.label, v.speed, v.stops[0].seconds, v.seats.length]).toEqual(["loop", "Loop line", 80, 8, 3]);
    expect(v.seats[0]).toEqual({ dx: -20, dy: 0 });
    expect(PK.packStrips(r.pack).map((s: any) => s.at)).toContain("vehicles.loop.sprite");
    expect(PK.packSceneImages(r.pack)).toContain("fox_idle.png");
    expect("vehicles" in (PK.checkSkinPack(MANIFEST()) as any).pack).toBe(false);
    const by = packWith([{ ...TRAIN(), sprite: undefined, sprites: { right: STRIP, up: STRIP }, fronts: { right: STRIP } }]);
    expect(Object.keys(by.pack.vehicles[0].sprites)).toEqual(["right", "up"]);
    expect(Object.keys(by.pack.vehicles[0].fronts)).toEqual(["right"]);                   // its front edge, over the riders
    expect(PK.packStrips(by.pack).map((s: any) => s.at)).toContain("vehicles.loop.fronts.right");
  });
  it.each([
    [{ path: [[0, 0], [10, 0]] }, "vehicles[0].path: at least 3 points (a loop)"],
    [{ path: [[0, 0], [10, 0], [1300, 0]] }, "vehicles[0].path[2][0]: a number from 0 to 1280"],
    [{ speed: 1 }, "vehicles[0].speed: a number from 5 to 600"],
    [{ stops: [{ at: 9, platform: [1, 1] }] }, "vehicles[0].stops[0].at: a whole number from 0 to 3"],
    [{ stops: [{ at: 1, platform: [1, 1] }, { at: 1, platform: [2, 2] }] }, "vehicles[0].stops[1].at: a path point no other stop has"],
    [{ stops: [] }, "vehicles[0].stops: at least one stop, for its seats to be boarded"],
    [{ sprite: undefined }, "vehicles[0]: a sprite, or sprites by heading"],
    [{ sprites: { sideways: STRIP } }, 'vehicles[0].sprites: unknown key "sideways"'],
    [{ seats: [{ for: ["alpha"] }] }, 'vehicles[0].seats[0]: unknown key "for"'],      // who rides is the agents' choice
    [{ wheels: 4 }, 'vehicles[0]: unknown key "wheels"'],
  ])("refused, saying where: %j", (extra, error) => {
    expect(packWith([{ ...TRAIN(), ...extra }])).toEqual({ ok: false, error });
  });
  it("at most four; two may not share an id", () => {
    expect(packWith([TRAIN(), TRAIN()]).error).toBe("vehicles[1].id: a new name of letters, digits, _ or - (not an inherited one)");
    expect(packWith(Array.from({ length: 5 }, (_, i) => ({ ...TRAIN(), id: `v${i}` }))).error).toBe("vehicles: at most 4");
  });
});

describe("where a vehicle is (vehicleAt): the clock alone", () => {
  const v = () => packWith([TRAIN()]).pack.vehicles[0];
  it("round the loop at its speed, waiting at its stop, lap after lap", () => {
    const t = v();                                              // lap: 16 s running + 2 s at the stop = 18 s
    expect(vehicleAt(t, 0)).toMatchObject({ x: 0, y: 0, stop: null, heading: { x: 1, y: 0 } });
    expect(vehicleAt(t, 2000)).toMatchObject({ x: 200, y: 0, stop: null });
    expect(vehicleAt(t, 4500)).toMatchObject({ x: 400, y: 0, stop: 0 });
    expect(vehicleAt(t, 4500).left).toBe(1500);
    expect(vehicleAt(t, 7000)).toMatchObject({ x: 400, y: 100, stop: null, heading: { x: 0, y: 1 } });
    expect(vehicleAt(t, 18000 + 2000)).toMatchObject({ x: 200, y: 0 });                 // the next lap
    expect(vehicleAt(t, -16000)).toMatchObject({ x: 200, y: 0 });                       // before the epoch too
  });
  it("seats turn with it; its picture faces the main axis", () => {
    const t = v();
    expect(seatAt(t, { x: 100, y: 0, heading: { x: 1, y: 0 } }, 2)).toEqual({ x: 120, y: 5 });
    expect(seatAt(t, { x: 400, y: 100, heading: { x: 0, y: 1 } }, 2)).toEqual({ x: 395, y: 120 });     // down: (−dy, dx)
    expect(seatAt(t, { x: 100, y: 400, heading: { x: -1, y: 0 } }, 2)).toEqual({ x: 80, y: 405 });     // left: the deck mirrored (−dx, dy)
    expect(seatAt(t, { x: 0, y: 200, heading: { x: 0, y: -1 } }, 2)).toEqual({ x: 5, y: 180 });        // up: (dy, −dx)
    expect([facing({ x: 1, y: 0 }), facing({ x: -1, y: 0.2 }), facing({ x: 0, y: -1 }), facing({ x: 0.1, y: 1 })]).toEqual(["right", "left", "up", "down"]);
  });
});

describe("riders (createRiders)", () => {
  const v = () => packWith([TRAIN()]).pack.vehicles[0];
  const world = (wanted: Record<string, string | null>, pos: Record<string, any>) => ({
    wants: new Map(Object.entries(wanted)), vehicles: new Map([["loop", v()]]),
    posOf: (n: string) => pos[n] ?? null, homeOf: () => ({ x: 380, y: 30 }),
  });
  it("walk to the platform, wait, board only while it stops there, then off only at a stop", () => {
    const r = createRiders(), pos: Record<string, any> = { a: { x: 100, y: 100, walking: false } };
    let s = r.step({ ...world({ a: "loop" }, pos), wall: 1000 });
    expect(s.targets.get("a")).toEqual({ x: 420, y: 10 });                              // on the way
    pos.a = { x: 420, y: 10, walking: false };
    s = r.step({ ...world({ a: "loop" }, pos), wall: 1000 });                           // there, the train is not
    expect([r.phase("a"), s.board]).toEqual(["waiting", []]);
    s = r.step({ ...world({ a: "loop" }, pos), wall: 4200 });                           // it stops: on board, seat 0
    expect(s.board).toEqual([{ name: "a", vehicle: "loop", seat: 0 }]);
    expect(r.riding("a")).toEqual({ vehicle: "loop", seat: 0 });
    s = r.step({ ...world({ a: null }, pos), wall: 10000 });                            // wants off between stops: stays on
    expect([s.alight, r.riding("a")]).toEqual([[], { vehicle: "loop", seat: 0 }]);
    s = r.step({ ...world({ a: null }, pos), wall: 18000 + 4200 });                     // the next stop: off at the platform
    expect(s.alight).toEqual([{ name: "a", at: { x: 420, y: 10 } }]);
    expect(r.riding("a")).toBeNull();
  });
  it("never boards a train about to leave, nor a full one; each rider their own seat", () => {
    const r = createRiders(), at = { x: 420, y: 10, walking: false }, pos: Record<string, any> = { a: at, b: at, c: at, d: at };
    const all = { a: "loop", b: "loop", c: "loop", d: "loop" };
    r.step({ ...world(all, pos), wall: 0 });
    expect(r.step({ ...world(all, pos), wall: 5900 }).board).toEqual([]);              // 100 ms left
    const s = r.step({ ...world(all, pos), wall: 4100 });
    expect(s.board.map((b: any) => [b.name, b.seat])).toEqual([["a", 0], ["b", 1], ["c", 2]]);
    expect(r.phase("d")).toBe("waiting");                                               // full: the next one
  });
  it("a page opened long after a ride began shows the rider on board (not walking to a train taken long ago)", () => {
    const r = createRiders(), w = world({ a: "loop", b: "loop" }, {});
    const s = r.step({ ...w, wall: 500000, sinceOf: (n: string) => (n === "a" ? 500000 - 200000 : 500000 - 5000) });
    expect(s.board).toEqual([{ name: "a", vehicle: "loop", seat: 0 }]);               // a lap (18 s) and the walk ago
    expect([r.phase("b"), s.targets.get("b")]).toEqual(["going", { x: 420, y: 10 }]);   // just set: walks to the platform
  });
  it("a caller (#4415) gets off at once, where their seat is, between stops too; then walks to the Help desk", () => {
    const r = createRiders(), w = createWalkers(), graph = { waypoints: [], edges: [], areas: {} }, at = { x: 420, y: 10, walking: false };
    let calling = false;
    const tick = (wall: number) => r.step({ ...world({ a: calling ? null : "loop" }, { a: w.at("a", wall) ?? at }), wall, urgent: () => calling });
    w.sync(new Map([["a", at]]), 0, graph, true);
    tick(0); tick(0);                                                                  // at the platform: waiting
    const on = tick(4100).board[0], car = v();
    w.ride("a", () => seatAt(car, vehicleAt(car, 9000), on.seat));
    expect(w.at("a", 9000)).toMatchObject({ riding: true });
    calling = true;                                                                    // between stops (9 s: on the far side)
    const s = tick(9000), seat = seatAt(car, vehicleAt(car, 9000), on.seat);
    expect(vehicleAt(car, 9000).stop).toBeNull();
    expect(s.alight).toEqual([{ name: "a", at: seat }]);
    expect(r.riding("a")).toBeNull();
    for (const a of s.alight) w.place(a.name, a.at);
    const desk = { x: 40, y: 600 };                                                    // the Help desk seat
    w.sync(new Map([["a", desk]]), 9000, graph, false);
    expect(w.at("a", 9001)).toMatchObject({ walking: true });
    expect(w.at("a", 9001)).not.toHaveProperty("riding");
  });
  it("the vehicle gone, or the riders cleared: set down where they are; clear() says who was on board", () => {
    const r = createRiders(), at = { x: 420, y: 10, walking: false }, there = { x: 380, y: 0, walking: false, riding: true };
    r.step({ ...world({ a: "loop", b: "loop" }, { a: at, b: at }), wall: 0 });
    r.step({ ...world({ a: "loop", b: "loop" }, { a: at, b: at }), wall: 4100 });
    const s = r.step({ wants: new Map([["a", "loop"], ["b", "loop"]]), vehicles: new Map(), wall: 5000, posOf: () => there, homeOf: () => null });
    expect(s.alight).toEqual([{ name: "a", at: { x: 380, y: 0 } }, { name: "b", at: { x: 380, y: 0 } }]);
    expect([r.riding("a"), r.riding("b")]).toEqual([null, null]);
    r.step({ ...world({ a: "loop" }, { a: at }), wall: 0 });
    r.step({ ...world({ a: "loop" }, { a: at }), wall: 4100 });
    expect([r.clear(), r.clear()]).toEqual([["a"], []]);
  });
  it("gone from the office, or the vehicle gone: forgotten", () => {
    const r = createRiders(), at = { x: 420, y: 10, walking: false };
    r.step({ ...world({ a: "loop" }, { a: at }), wall: 0 });
    r.step({ ...world({ a: "loop" }, { a: at }), wall: 4100 });
    expect(r.riding("a")).not.toBeNull();
    r.step({ ...world({}, {}), wall: 5000 });
    expect(r.phase("a")).toBeNull();
  });
});

describe("walkers that ride", () => {
  it("their position is their seat's, sync leaves them be, place() gets them off", () => {
    const w = createWalkers(), graph = { waypoints: [], edges: [], areas: {} };
    w.sync(new Map([["a", { x: 10, y: 10 }]]), 0, graph, true);
    let at = { x: 100, y: 50 };
    w.ride("a", () => at);
    expect(w.at("a", 5)).toMatchObject({ x: 100, y: 50, walking: false, riding: true });
    at = { x: 140, y: 50 };
    w.sync(new Map([["a", { x: 10, y: 10 }]]), 6, graph, false);
    expect(w.at("a", 7)).toMatchObject({ x: 140, y: 50, riding: true });
    w.place("a", { x: 420, y: 10 });
    expect(w.at("a", 8)).toMatchObject({ x: 420, y: 10, walking: false });
  });
  it("a fresh sync (a new office or style) sets a rider down at their target: no gliding on a vehicle that is gone", () => {
    const w = createWalkers(), graph = { waypoints: [], edges: [], areas: {} };
    w.sync(new Map([["a", { x: 10, y: 10 }]]), 0, graph, true);
    w.ride("a", () => ({ x: 100, y: 50 }));
    w.sync(new Map([["a", { x: 10, y: 10 }]]), 5, graph, false, true);
    expect(w.at("a", 6)).toEqual({ x: 10, y: 10, walking: false });
  });
});

describe("office_set ride", () => {
  const pack = packWith([TRAIN()]).pack, plain = (PK.checkSkinPack(MANIFEST()) as any).pack;
  const office = { id: "o", name: "O", skin: "clinic-sample", members: ["alpha", "beta"] };
  const make = (p = pack) => new OfficeActs({ offices: () => [office as any], pack: () => p, chart: () => ({ names: ["alpha", "beta"], teams: [] }),
    people: () => ({ stateOf: () => "working", displayName: () => undefined }), changed: () => {} }, { limiter: new OfficeActLimiter(() => 0) });
  it("office_view lists the vehicles; a ride is kept an hour by default, up to 8", () => {
    expect(officeSpots(office as any, pack).vehicles).toEqual([{ id: "loop", label: "Loop line", seats: 3, platforms: [{ x: 420, y: 10 }] }]);
    const a = make(), r = a.set("alpha", { ride: "loop" }) as any;
    expect(r.act.ride).toBe("loop");
    expect(r.act.until - r.act.since).toBe(OFFICE_ACT_LIMITS.rideDefaultSeconds * 1000);
    expect((a.set("beta", { ride: "loop", seconds: 28800 }) as any).act.ride).toBe("loop");
  });
  it.each([
    [{ ride: "bus" }, "ride", 'ride: "bus" is not a vehicle of o; office_view lists them.'],
    [{ ride: "loop", go: { waypoint: "w" } }, "ride", "ride: not with go (riding, you go where the vehicle goes)."],
    [{ ride: "loop", seconds: 30 }, "seconds", "seconds: 60 to 28800 for a ride."],
    [{ say: "hi", seconds: 600 }, "seconds", "seconds: 5 to 120."],
  ])("refused: %j", (args, error, message) => {
    expect(make().set("alpha", args)).toMatchObject({ error, message });
  });
  it("an office with no vehicles says so", () => {
    expect(make(plain).set("alpha", { ride: "loop" })).toMatchObject({ error: "ride", message: 'ride: o has no vehicles (its style "clinic-sample").' });
  });
});
