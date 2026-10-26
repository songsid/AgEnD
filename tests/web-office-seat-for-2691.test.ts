/**
 * #2691: a seat can be reserved for one or more instances.
 * - Pack: a seat is [x, y] or { x, y, for, lend } (`for` instance names as byInstance's, `lend` a boolean, default
 *   false); a checked plain seat stays { x, y }.
 * - assignSeats: someone wanting the area takes a free seat reserved for them first; the rest keep their slot or take
 *   the first free seat not reserved for someone else — a reserved one only when it says `lend`, and a borrower moves
 *   off when an owner comes. A reserved seat, not lent, none of whose owners want the area, is unavailable (overflow
 *   spots and `over` count without it). Seats without `for` behave as before.
 * - Edit layout: a selected seat's "Reserved for" (the office's members, several) and "Lend when away", saved as
 *   `overrides.seatFor: { area: { slot: { for, lend } } }`; on disk beside the offices (as #2665's night places), so
 *   an older host's strict check still reads every office.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";
import { OfficeStore, checkOffices, type Office } from "../src/web-office-store.js";
import { OfficeShareView, SOMEONE_ELSE } from "../src/office-share.js";
import * as HPK from "../src/ui/fleet-office-pack.js";

let p: AppPage;
let PK: any, LY: any, Z: any;
beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19280/ui/fleet/org" });
  PK = await import("/ui/js/fleet-office-pack.js");
  LY = await import("/ui/js/fleet-office-layout.js");
  Z = await import("/ui/js/fleet-office-zones.js");
});
afterAll(async () => { await p.unmount(); p.restore(); });

const STRIP = (src: string) => ({ src, frames: 2, w: 16, h: 16 });
/** A pack whose sofa seats lean towards each other: the left one is `lefty`'s, the right one `righty`'s; then a plain seat. */
const MANIFEST = (lounge: unknown[] = [{ x: 700, y: 300, for: ["lefty"] }, { x: 760, y: 300, for: ["righty"] }, [900, 300]]) => ({
  format: 1, id: "sofapack", background: "bg.png",
  areas: { desks: { rect: [0, 0, 600, 720], seats: [[100, 100], [200, 100]] }, lounge: { rect: [640, 0, 640, 720], seats: lounge } },
  stateZones: { working: "desks", idle: "lounge" }, characters: { default: { idle: STRIP("i.png") } } });
const packOf = (mod: any, lounge?: unknown[]) => { const c = mod.checkSkinPack(MANIFEST(lounge)); if (!c.ok) throw new Error(c.error); return c.pack; };
/** name → slot in `area` (overflow spots negative), from assignSeats' answer. */
const slots = (r: any) => Object.fromEntries([...r.seats].map(([n, s]: any) => [n, `${s.area}:${s.slot}`]));
const want = (...names: string[]) => names.map((n) => ({ name: n, area: "lounge" }));

describe("a reserved seat in a pack", () => {
  it("is { x, y, for, lend }, checked like byInstance names; a plain seat stays { x, y }", () => {
    const pk = packOf(PK, [{ x: 700, y: 300, for: ["lefty", "righty"], lend: true }, { x: 760, y: 300, for: "solo" }, [900, 300], { x: 950, y: 300 }]);
    expect(pk.areas.lounge.seats).toEqual([{ x: 700, y: 300, for: ["lefty", "righty"], lend: true }, { x: 760, y: 300, for: ["solo"], lend: false }, { x: 900, y: 300 }, { x: 950, y: 300 }]);
    expect(pk.areas.desks.seats).toEqual([{ x: 100, y: 100 }, { x: 200, y: 100 }]);
  });
  it("refuses a bad one, saying where", () => {
    const err = (seat: unknown) => { const c = PK.checkSkinPack(MANIFEST([seat])); return c.ok ? "ok" : c.error; };
    expect(err({ x: 700, y: 300, for: ["a"], lend: "yes" })).toBe("areas.lounge.seats[0].lend: true or false");
    expect(err({ x: 700, y: 300, lend: true })).toBe("areas.lounge.seats[0].lend: only with for");
    expect(err({ x: 700, y: 300, for: [] })).toBe("areas.lounge.seats[0].for: at least one instance");
    expect(err({ x: 700, y: 300, for: ["a", "a"] })).toBe("areas.lounge.seats[0].for: a name twice");
    expect(err({ x: 700, y: 300, for: ["constructor"] })).toBe("areas.lounge.seats[0].for[0]: an instance's name");
    expect(err({ x: 700, y: 300, for: ["a"], who: 1 })).toBe('areas.lounge.seats[0]: unknown key "who"');
    expect(err({ x: 10, y: 300, for: ["a"] })).toBe("areas.lounge.seats[0]: outside its area's rect");
    expect(err({ x: 700, y: 9999 })).toBe("areas.lounge.seats[0].y: a number from 0 to 720");
    expect(err([700])).toBe("areas.lounge.seats[0]: [x, y]");
  });
});

describe("assignSeats with reserved seats", () => {
  it("two people arriving in either order sit in their reserved seats (first come, first kept would not)", () => {
    const plain = packOf(PK, [[700, 300], [760, 300], [900, 300]]), sofa = packOf(PK);
    expect(slots(Z.assignSeats(plain, want("righty", "lefty")))).toEqual({ righty: "lounge:0", lefty: "lounge:1" });   // control: back to back
    for (const order of [want("righty", "lefty"), want("lefty", "righty")]) expect(slots(Z.assignSeats(sofa, order))).toEqual({ lefty: "lounge:0", righty: "lounge:1" });
    // One at a time, either way round: the first sits down, then the second arrives (prev kept as the page keeps it).
    for (const [first, second] of [["lefty", "righty"], ["righty", "lefty"]]) {
      const a = Z.assignSeats(sofa, [{ name: first, area: "lounge" }, { name: second, area: "desks" }]);
      const b = Z.assignSeats(sofa, want(first, second), a.seats);
      expect(slots(b)).toEqual({ lefty: "lounge:0", righty: "lounge:1" });
    }
    // Someone else arriving first takes the plain seat, not theirs.
    expect(slots(Z.assignSeats(sofa, want("other", "righty", "lefty")))).toEqual({ other: "lounge:2", lefty: "lounge:0", righty: "lounge:1" });
  });
  it("an absent owner's seat stays empty without lend", () => {
    const pk = packOf(PK, [{ x: 700, y: 300, for: ["owner"] }, [900, 300]]);
    const r = Z.assignSeats(pk, want("a", "b"));
    expect(slots(r)).toEqual({ a: "lounge:1", b: "lounge:-1" });
    expect([...r.over]).toEqual(["lounge"]);                                    // 2 people, 1 seat they may have
  });
  it("is lent with lend (plain seats first), and the borrower moves off when the owner comes", () => {
    const pk = packOf(PK, [{ x: 700, y: 300, for: ["owner"], lend: true }, [900, 300]]);
    const r1 = Z.assignSeats(pk, want("a", "b"));
    expect(slots(r1)).toEqual({ a: "lounge:1", b: "lounge:0" });
    expect([...r1.over]).toEqual([]);
    const r2 = Z.assignSeats(pk, want("a", "b", "owner"), r1.seats);
    expect(slots(r2)).toEqual({ owner: "lounge:0", a: "lounge:1", b: "lounge:-1" });
    expect(r2.seats.get("b")).not.toMatchObject({ x: 700, y: 300 });          // a new target: walked to, like any seat change
    const r3 = Z.assignSeats(pk, want("a", "b", "c"), r2.seats);                 // the owner leaves: lent again (b keeps their spot)
    expect(slots(r3)).toEqual({ a: "lounge:1", b: "lounge:-1", c: "lounge:0" });
  });
  it("a seat reserved for two people goes to whichever comes; the one sitting keeps it when the other comes", () => {
    const pk = packOf(PK, [{ x: 700, y: 300, for: ["x", "y"] }, [900, 300]]);
    expect(slots(Z.assignSeats(pk, want("y")))).toEqual({ y: "lounge:0" });
    expect(slots(Z.assignSeats(pk, want("x")))).toEqual({ x: "lounge:0" });
    const one = Z.assignSeats(pk, want("y"));
    expect(slots(Z.assignSeats(pk, want("x", "y"), one.seats))).toEqual({ y: "lounge:0", x: "lounge:1" });
    expect(slots(Z.assignSeats(pk, want("x", "y")))).toEqual({ x: "lounge:0", y: "lounge:1" });   // together: the fleet's order
  });
  it("plain seats ([x, y] or { x, y }) behave as before, call after call", () => {
    const arrays = packOf(PK, [[700, 300], [760, 300], [900, 300]]), objects = packOf(PK, [{ x: 700, y: 300 }, { x: 760, y: 300 }, { x: 900, y: 300 }]);
    expect(objects).toEqual(arrays);
    const steps = [want("c", "a", "b", "d", "e"), want("a", "d", "e"), [...want("a", "e"), { name: "d", area: "desks" }], want("b", "c", "d", "e", "a")];
    let prev = new Map();
    for (const wants of steps) {
      const r = Z.assignSeats(arrays, wants, prev);
      expect(r.seats.size + [...r.crowd.values()].reduce((x: number, y: number) => x + y, 0)).toBe(wants.length);
      prev = r.seats;
    }
    // Each keeps their slot; newcomers take the first free one, then overflow spots.
    const a = Z.assignSeats(arrays, want("c", "a", "b", "d"));
    expect(slots(a)).toEqual({ c: "lounge:0", a: "lounge:1", b: "lounge:2", d: "lounge:-1" });
    expect(slots(Z.assignSeats(arrays, want("a", "d", "e"), a.seats))).toEqual({ a: "lounge:1", d: "lounge:-1", e: "lounge:0" });
  });
  it("an area whose free seats are all reserved for absent people counts them unavailable: overflow and over, the crowd unchanged", () => {
    const pk = packOf(PK, [{ x: 700, y: 300, for: ["gone1"] }, { x: 760, y: 300, for: ["gone2"] }, [900, 300]]);
    const r = Z.assignSeats(pk, want("a", "b", "c"));
    expect(slots(r)).toEqual({ a: "lounge:2", b: "lounge:-1", c: "lounge:-2" });
    expect([[...r.over], r.crowd.size]).toEqual([["lounge"], 0]);
    expect(Z.overflowSpots(pk.areas.lounge, 2).length).toBeGreaterThanOrEqual(2);
    const back = Z.assignSeats(pk, want("a", "gone1"));                        // an owner here: their seat counts again
    expect([[...back.over], slots(back)]).toEqual([[], { gone1: "lounge:0", a: "lounge:2" }]);
  });
  it("at bedtime a bed reserved for someone who will not come is no bed; one with a bed of their own goes first", () => {
    const m = MANIFEST();
    const pk = PK.checkSkinPack({ ...m, areas: { ...m.areas, nap: { rect: [0, 400, 600, 320], seats: [{ x: 100, y: 500, for: ["late"] }, [300, 500]] } },
      stateZones: { working: "desks", idle: "lounge", paused: "nap" } }).pack;
    const node = (name: string, state: string) => ({ name, state, i: { name } });
    const L = Z.zonesLayout(pk, [node("early", "idle"), node("mid", "idle"), node("late", "idle")], new Map(), { night: true });
    const where = Object.fromEntries([...L.seats].map(([n, s]: any) => [n, `${s.area}:${s.slot}`]));
    expect(where).toEqual({ late: "nap:0", early: "nap:1", mid: "lounge:2" });
    const L2 = Z.zonesLayout(pk, [node("early", "idle"), node("mid", "idle")], new Map(), { night: true });
    expect(Object.fromEntries([...L2.seats].map(([n, s]: any) => [n, `${s.area}:${s.slot}`]))).toEqual({ early: "nap:1", mid: "lounge:2" });
  });
  // #2693 review (Prism P2): who goes to bed is what the seat assignment gives, not a count of people and beds.
  describe("bedtime goes by the beds actually given", () => {
    const napPack = (nap: unknown[]) => {
      const m = MANIFEST();
      return PK.checkSkinPack({ ...m, areas: { ...m.areas, nap: { rect: [0, 400, 600, 320], seats: nap } },
        stateZones: { working: "desks", idle: "lounge", paused: "nap" } }).pack;
    };
    const node = (name: string, state: string) => ({ name, state, i: { name } });
    const at = (pk: any, nodes: any[]) => Object.fromEntries([...Z.zonesLayout(pk, nodes, new Map(), { night: true }).seats].map(([n, s]: any) => [n, `${s.area}:${s.slot}`]));
    it("a paused outsider does not keep an idle owner out of their only bed (it stayed empty)", () => {
      const where = at(napPack([{ x: 100, y: 500, for: ["owner"] }]), [node("paused", "paused"), node("owner", "idle")]);
      expect(where.owner).toBe("nap:0");
      expect(where.paused).toMatch(/^nap:-\d+$/);                      // the bed is not theirs: an overflow spot, as by day
    });
    it("two beds for one owner are one bed: another sleeper dozes in the lounge, not in the nap area's overflow", () => {
      const where = at(napPack([{ x: 100, y: 500, for: ["owner"] }, { x: 300, y: 500, for: ["owner"] }]), [node("owner", "idle"), node("other", "idle")]);
      expect(where).toEqual({ owner: "nap:0", other: "lounge:2" });
    });
    it("the awake keep their beds: a sleeper takes only a bed left free, else dozes where they are", () => {
      const pk = napPack([[100, 500]]);
      expect(at(pk, [node("tired", "idle"), node("paused", "paused")])).toEqual({ paused: "nap:0", tired: "lounge:2" });
      // A sleeper who held the bed last time keeps it only when nobody awake needs it.
      const prev = new Map([["tired", { area: "nap", slot: 0 }]]);
      const L = Z.zonesLayout(pk, [node("tired", "idle"), node("paused", "paused")], prev, { night: true });
      expect(Object.fromEntries([...L.seats].map(([n, s]: any) => [n, `${s.area}:${s.slot}`]))).toEqual({ paused: "nap:0", tired: "lounge:2" });
      expect(at(pk, [node("tired", "idle"), node("dozy", "idle")])).toEqual({ tired: "nap:0", dozy: "lounge:2" });
    });
    it("an owner takes their lent bed back from someone awake on it, as by day", () => {
      const where = at(napPack([{ x: 100, y: 500, for: ["owner"], lend: true }]), [node("borrower", "paused"), node("owner", "idle")]);
      expect(where.owner).toBe("nap:0");
      expect(where.borrower).toMatch(/^nap:-\d+$/);
    });
  });
});

describe("the office's own reservations (overrides.seatFor)", () => {
  it("checkLayoutOverrides: an area's name, a seat's number, instance names (none: no reservation) and lend", () => {
    const ov = { pack: "sofapack", seatFor: { lounge: { 2: { for: ["other"], lend: true }, 0: { for: [], lend: false } } } };
    expect(PK.checkLayoutOverrides(ov)).toEqual({ ok: true, overrides: { pack: "sofapack", seatFor: { lounge: { 0: { for: [], lend: false }, 2: { for: ["other"], lend: true } } } } });
    const err = (seatFor: unknown) => PK.checkLayoutOverrides({ pack: "sofapack", seatFor }).error;
    expect(err({ constructor: {} })).toBe("overrides.seatFor.constructor: an area's name");
    expect(err({ lounge: { x: { for: [] } } })).toBe("overrides.seatFor.lounge.x: a seat's number, 0 to 63");
    expect(err({ lounge: { 64: { for: [] } } })).toBe("overrides.seatFor.lounge.64: a seat's number, 0 to 63");
    expect(err({ lounge: { 0: { for: "a" } } })).toBe("overrides.seatFor.lounge.0.for: a list");
    expect(err({ lounge: { 0: { for: ["a"], lend: 1 } } })).toBe("overrides.seatFor.lounge.0.lend: true or false");
    expect(err({ lounge: { 0: { for: ["a", "a"] } } })).toBe("overrides.seatFor.lounge.0.for: a name twice");
    expect(err({ lounge: { 0: { for: ["a"], who: 1 } } })).toBe('overrides.seatFor.lounge.0: unknown key "who"');
  });
  it("applyOverrides puts them on the pack's seats (a moved seat keeps its reservation); overridesBetween saves only what differs", () => {
    const base = packOf(PK);
    expect(PK.applyOverrides(base, { pack: "sofapack", seatFor: { attic: { 0: { for: [], lend: false } } } })).toEqual({ ok: false, error: "overrides.seatFor.attic: an area the pack defines" });
    expect(PK.applyOverrides(base, { pack: "sofapack", seatFor: { lounge: { 3: { for: [], lend: false } } } })).toEqual({ ok: false, error: "overrides.seatFor.lounge.3: a seat the area has (it has 3)" });
    const ov = { pack: "sofapack", seats: { lounge: [[710, 310], [760, 300], [900, 300]] }, seatFor: { lounge: { 0: { for: [], lend: false }, 2: { for: ["other"], lend: true } } } };
    const r = PK.applyOverrides(base, ov);
    expect(r.pack.areas.lounge.seats).toEqual([{ x: 710, y: 310 }, { x: 760, y: 300, for: ["righty"], lend: false }, { x: 900, y: 300, for: ["other"], lend: true }]);
    expect(base.areas.lounge.seats[0]).toEqual({ x: 700, y: 300, for: ["lefty"], lend: false });   // the pack as it was
    expect(PK.overridesBetween(base, r.pack)).toEqual(ov);
    const moved = PK.applyOverrides(base, { pack: "sofapack", seats: { lounge: [[710, 310], [760, 300], [900, 300]] } }).pack;
    expect(moved.areas.lounge.seats[0]).toEqual({ x: 710, y: 310, for: ["lefty"], lend: false });
    expect(PK.overridesBetween(base, moved)).toEqual({ pack: "sofapack", seats: { lounge: [[710, 310], [760, 300], [900, 300]] } });
  });
  it("a pack that lost the area or the seat drops only that entry when drawn (fitSeatFor); the rest of the layout stays", () => {
    const base = packOf(PK);
    const ov = { pack: "sofapack", door: [10, 10], seatFor: { lounge: { 1: { for: ["a"], lend: false }, 9: { for: ["b"], lend: false } }, attic: { 0: { for: ["c"], lend: false } } } };
    expect(PK.fitSeatFor(base, ov)).toEqual({ pack: "sofapack", door: [10, 10], seatFor: { lounge: { 1: { for: ["a"], lend: false } } } });
    expect(PK.fitSeatFor(base, { pack: "sofapack", seatFor: { attic: { 0: { for: ["c"], lend: false } } } })).toEqual({ pack: "sofapack" });
    expect(PK.fitSeatFor(base, { pack: "other", seatFor: { attic: {} } })).toEqual({ pack: "other", seatFor: { attic: {} } });
    expect(PK.applyOverrides(base, PK.fitSeatFor(base, ov)).ok).toBe(true);
    // #2693 review (Prism P3): an area gone with no slots under it is dropped too (0 of 0 kept), the rest kept.
    const empty = { pack: "sofapack", door: [10, 10], seatFor: { removed: {} } };
    expect(PK.checkLayoutOverrides(empty).ok).toBe(true);
    expect(PK.fitSeatFor(base, empty)).toEqual({ pack: "sofapack", door: [10, 10] });
    expect(PK.applyOverrides(base, PK.fitSeatFor(base, empty)).ok).toBe(true);
    expect(PK.fitSeatFor(base, { pack: "sofapack", seatFor: { removed: {}, lounge: { 1: { for: ["a"], lend: false } } } }))
      .toEqual({ pack: "sofapack", seatFor: { lounge: { 1: { for: ["a"], lend: false } } } });
  });
});

describe("Edit layout's seat reservations", () => {
  afterEach(async () => { await p.unmount(); });
  const mount = async (members: string[]) => {
    const base = packOf(PK), saved: any[] = [];
    await p.mount(h(LY.LayoutEditor, { base, start: base, dock: false, members, onChange() {}, onSave: async (ov: any) => { saved.push(ov); return { ok: true }; }, onClose() {} }));
    await settle(4);
    return { base, saved };
  };
  const handle = (k: string) => p.root.querySelector(`[data-handle="seat:${k}"]`);
  const pick = (name: string) => [...p.root.querySelectorAll(".ol-for label")].find((l: any) => l.textContent.trim() === name).querySelector("input");
  it("a reserved seat says whom for and is ringed; reserveSeat sets or clears it", () => {
    const base = packOf(PK);
    expect(LY.handlesOf(base).filter((x: any) => x.kind === "seat" && x.key.startsWith("seat:lounge")).map((x: any) => [x.label, x.for ?? null, x.lend ?? null])).toEqual([
      ["Seat 1 in lounge, reserved for lefty", ["lefty"], false], ["Seat 2 in lounge, reserved for righty", ["righty"], false], ["Seat 3 in lounge", null, null]]);
    const r = LY.reserveSeat(base, "seat:lounge:2", ["a", "b", "a"], true);
    expect(r.areas.lounge.seats[2]).toEqual({ x: 900, y: 300, for: ["a", "b"], lend: true });
    expect(LY.reserveSeat(r, "seat:lounge:2", []).areas.lounge.seats[2]).toEqual({ x: 900, y: 300 });
    expect(LY.reserveSeat(base, "seat:attic:0", ["a"])).toBe(base);
    expect(LY.moveHandle(base, "seat:lounge:0", 720, 320).areas.lounge.seats[0]).toEqual({ x: 720, y: 320, for: ["lefty"], lend: false });   // moved, still theirs
  });
  it("the selected seat offers the office's members (several) and Lend when away; Save sends seatFor; unpicking all is none", async () => {
    const { saved } = await mount(["lefty", "righty", "other"]);
    expect(p.root.querySelector(".ol-for")).toBeNull();                          // nothing selected
    fire(handle("lounge:2"), "focus"); await settle(2);
    expect(p.root.querySelectorAll(".ol-for label").map((l: any) => l.textContent.trim())).toEqual(["lefty", "righty", "other"]);
    expect(p.root.querySelector(".ol-lend").disabled).toBe(true);               // nobody picked: nothing to lend
    fire(pick("other"), "change"); await settle(2);
    fire(pick("righty"), "change"); await settle(2);
    fire(p.root.querySelector(".ol-lend"), "change"); await settle(2);
    expect(handle("lounge:2").getAttribute("aria-label")).toBe("Seat 3 in lounge, reserved for other, righty at 900, 300");
    expect(handle("lounge:2").querySelector(".ol-for-ring")).not.toBeNull();
    p.root.querySelector(".ol-save").click(); await settle(4);
    expect(saved).toEqual([{ pack: "sofapack", seatFor: { lounge: { 2: { for: ["other", "righty"], lend: true } } } }]);
    fire(handle("lounge:0"), "focus"); await settle(2);
    fire(pick("lefty"), "change"); await settle(2);                              // the pack's own: unpicked
    p.root.querySelector(".ol-save").click(); await settle(4);
    expect(saved[1]).toEqual({ pack: "sofapack", seatFor: { lounge: { 0: { for: [], lend: false }, 2: { for: ["other", "righty"], lend: true } } } });
  });
  it("someone the seat is for who is not a member any more is listed too, so they can be unpicked", async () => {
    await mount(["other"]);
    fire(handle("lounge:0"), "focus"); await settle(2);
    expect(p.root.querySelectorAll(".ol-for label").map((l: any) => l.textContent.trim())).toEqual(["other", "lefty"]);
  });
});

describe("on the host, rollback-safe (as #2665's night places)", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
  const store = () => { const d = mkdtempSync(join(tmpdir(), "agend-seatfor-")); dirs.push(d); return { d, s: new OfficeStore(d, (id) => (id === "sofapack" ? packOf(HPK) : null)) }; };
  const OFFICE = (ov: any) => ({ id: "room", name: "Room", skin: "sofapack", members: [], overrides: ov });
  /**
   * An older host's read: the file needs version/rev/offices (other keys are not looked at); each office's keys, then
   * its overrides' keys, are a closed list — anything else drops that office. `night`: a host with #2665 (2.3.2-beta.9),
   * whose list has furnitureNight; without it, beta.1…beta.8.
   */
  const olderReads = (doc: any, night = false) => {
    if (doc.version !== 1 || !Number.isSafeInteger(doc.rev) || !Array.isArray(doc.offices)) return null;
    const closed = (o: any, keys: string[]) => Object.keys(o).every((k) => keys.includes(k));
    return doc.offices.filter((o: any) => closed(o, ["id", "name", "skin", "members", "layout", "overrides"])
      && (o.overrides === undefined || closed(o.overrides, ["pack", "seats", "furniture", ...(night ? ["furnitureNight"] : []), "door", "waypoints", "edges"])));
  };
  const SEATFOR = { lounge: { 2: { for: ["other"], lend: true } } };

  it("the stand-in is the older rule: seatFor inside the overrides drops the office there (control)", () => {
    expect(HPK.checkLayoutOverrides({ pack: "sofapack", seating: {} })).toEqual({ ok: false, error: 'overrides: unknown key "seating"' });
    expect(olderReads({ version: 1, rev: 1, offices: [OFFICE({ pack: "sofapack", seatFor: SEATFOR })] })).toEqual([]);
    expect(olderReads({ version: 1, rev: 1, offices: [OFFICE({ pack: "sofapack", seatFor: SEATFOR })] }, true)).toEqual([]);
  });
  it("written beside the offices (with night places beside them too); both older reads keep every office; read back whole", () => {
    const { d, s } = store();
    const ov = { pack: "sofapack", door: [5, 5], seatFor: SEATFOR };
    expect(s.replace([OFFICE(ov), { id: "plain", name: "Plain", skin: "pixel", members: [] }], 0).ok).toBe(true);
    const doc = JSON.parse(readFileSync(join(d, "web-offices.json"), "utf8"));
    expect(doc.offices[0].overrides).toEqual({ pack: "sofapack", door: [5, 5] });
    expect(doc.seatFor).toEqual({ room: SEATFOR });
    expect(doc).not.toHaveProperty("furnitureNight");
    expect(olderReads(doc).map((o: any) => o.id)).toEqual(["room", "plain"]);
    expect(olderReads(doc, true).map((o: any) => o.id)).toEqual(["room", "plain"]);
    expect(new OfficeStore(d).list().offices[0].overrides).toEqual(ov);
    expect(s.list().offices[0].overrides).toEqual(ov);
  });
  it("an older host's save (no key) reads back without them, the office kept; one that no longer checks is left out alone", () => {
    const { d, s } = store();
    expect(s.replace([OFFICE({ pack: "sofapack", seatFor: SEATFOR })], 0).ok).toBe(true);
    const doc = JSON.parse(readFileSync(join(d, "web-offices.json"), "utf8"));
    expect(doc.offices[0].overrides).toEqual({ pack: "sofapack" });
    writeFileSync(join(d, "web-offices.json"), JSON.stringify({ version: 1, rev: doc.rev + 1, offices: olderReads(doc) }));
    expect(new OfficeStore(d).list().offices).toEqual([OFFICE({ pack: "sofapack" })]);
    // A broken reservation beside a good night place: the night place and the office stay.
    writeFileSync(join(d, "web-offices.json"), JSON.stringify({ ...doc, furnitureNight: { room: {} }, seatFor: { room: { lounge: { 0: { for: "x" } } } } }));
    expect(new OfficeStore(d).list().offices).toEqual([OFFICE({ pack: "sofapack", furnitureNight: {} })]);
  });
  it("a write naming a seat the pack lacks is refused, saying where", () => {
    const bad = checkOffices([OFFICE({ pack: "sofapack", seatFor: { lounge: { 5: { for: ["a"], lend: false } } } })], (id) => (id === "sofapack" ? packOf(HPK) : null));
    expect(bad).toEqual({ ok: false, status: 400, error: "offices_invalid", detail: "offices[0].overrides.seatFor.lounge.5: a seat the area has (it has 3)" });
  });
});

describe("over the public link", () => {
  const source = (offices: Office[]): any => ({
    status: () => ({ instances: [{ name: "lefty" }, { name: "righty" }, { name: "secret" }] }), org: () => ({ teams: [] }),
    offices: () => ({ rev: 1, offices }), acts: () => [], traffic: () => ({ now: "t", items: [] }), needs: () => [], hidden: (n: string) => n === "secret",
  });
  it("a seat reserved for someone not shown keeps its reservation, not the name; the stored office and pack are unchanged", () => {
    const office: Office = { id: "room", name: "Room", skin: "sofapack", members: [],
      overrides: { pack: "sofapack", seatFor: { lounge: { 0: { for: ["secret"], lend: false }, 1: { for: ["righty", "secret"], lend: true }, 2: { for: [], lend: false } } } } };
    const before = JSON.stringify(office);
    const v = new OfficeShareView({ office: "room", text: false }, source([office]));
    expect(v.officeList().offices[0]!.overrides!.seatFor).toEqual({ lounge: { 0: { for: [SOMEONE_ELSE], lend: false }, 1: { for: ["righty"], lend: true }, 2: { for: [], lend: false } } });
    const kept = { id: "sofapack", sha: "s", manifest: MANIFEST([{ x: 700, y: 300, for: ["secret"] }, { x: 760, y: 300, for: "righty" }, [900, 300]]), files: {} };
    const keptBefore = JSON.stringify(kept);
    const out = v.pack(kept) as any;
    expect(out.manifest.areas.lounge.seats).toEqual([{ x: 700, y: 300, for: [SOMEONE_ELSE] }, { x: 760, y: 300, for: ["righty"] }, [900, 300]]);
    expect(JSON.stringify([v.officeList(), out])).not.toContain("secret");
    expect([JSON.stringify(office), JSON.stringify(kept)]).toEqual([before, keptBefore]);
    // What the page makes of it: still a pack and overrides it checks, the hidden seat still reserved.
    const checked = HPK.checkSkinPack(out.manifest);
    expect(checked.ok && checked.pack.areas.lounge.seats[0]).toEqual({ x: 700, y: 300, for: [SOMEONE_ELSE], lend: false });
    expect(HPK.checkLayoutOverrides(v.officeList().offices[0]!.overrides).ok).toBe(true);
  });
});
