/**
 * M-3286: an office's "Idle people stay in their own area" (Edit offices; default off).
 * - wanderTarget(…, area): only stroll spots inside the area's rect; of those, only ones whose walk there and back
 *   stays inside it; none such: ones whose walk enters no other area (corridors on the way); none: stays seated.
 * - walkTargets(…, ownArea): every stroll stays in its area (people: their seat's area; a walking NPC: the area its
 *   spot is in) and nobody goes on an idleVisit. Off: exactly as before.
 * - Kept by the host beside the list (`stayInArea: { "<office id>": true }`), never in an office's entry (an older host
 *   refuses the key there and drops the office); true only; off is no key. The page reads it, the editor saves it.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";
import { OfficeStore, checkOffices, officesOnDisk } from "../src/web-office-store.js";

let p: AppPage;
let PK: any, Z: any, M: any, O: any, S: any, E: any, app: any;
beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19280/ui/fleet/org" });
  app = await import("/assets/app-store.js");
  PK = await import("/ui/js/fleet-office-pack.js");
  Z = await import("/ui/js/fleet-office-zones.js");
  M = await import("/ui/js/fleet-office-model.js");
  O = await import("/ui/js/fleet-org.js");
  S = await import("/ui/js/fleet-office-store.js");
  E = await import("/ui/js/fleet-office-editor.js");
});
afterAll(async () => { await p.unmount(); p.restore(); });
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const STRIP = (src: string) => ({ src, frames: 2, w: 16, h: 16 });
// The tavern (lounge) sits below the work area; a corridor (no area) runs down the right side, x 600–700.
//   in1, in2: inside the tavern, joined to each other.          wk: in the work area, near a tavern seat.
//   via-wk:   inside the tavern, joined only to wk.     cor-in: inside the tavern, reachable only through the corridor.
const WAYPOINTS = [
  { id: "in1", x: 150, y: 450 }, { id: "in2", x: 250, y: 450 },
  { id: "wk", x: 150, y: 330 }, { id: "via-wk", x: 50, y: 420 },
  { id: "cor", x: 650, y: 450 }, { id: "cor-in", x: 560, y: 600 },
];
const EDGES = [["in1", "in2"], ["wk", "via-wk"], ["cor", "cor-in"]];
const MANIFEST = (extra: any = {}) => ({ format: 1, id: "tavernpack", background: "bg.png",
  areas: {
    work: { rect: [0, 0, 600, 360], seats: [[100, 100], [200, 100], [300, 100]] },
    lounge: { rect: [0, 360, 600, 360], seats: [[150, 520], [300, 520], [450, 520], [520, 650]] },
    spring: { rect: [700, 0, 580, 360], seats: [[800, 100], [900, 100]] },
  },
  stateZones: { working: "work", idle: "lounge", default: "lounge" },
  waypoints: WAYPOINTS, edges: EDGES,
  characters: { default: { idle: STRIP("i.png") } }, ...extra });
const packOf = (extra: any = {}) => { const c = PK.checkSkinPack(MANIFEST(extra)); if (!c.ok) throw new Error(c.error); return c.pack; };
const layoutOf = (extra: any = {}) => Z.zonesLayout(packOf(extra), []);
const inRect = (r: any, q: any) => q.x >= r.x && q.x <= r.x + r.w && q.y >= r.y && q.y <= r.y + r.h;

const { PERIOD } = { PERIOD: 40000 };
/** Every spot `name` (seated at `seat`) strolls to over `turns` wander turns. */
function spotsOver(name: string, seat: any, g: any, area: string | null, turns = 40) {
  const out = new Set<string>();
  for (let t = 0; t < turns * PERIOD; t += 500) { const q = Z.wanderTarget(name, seat, g, t, [seat], area); if (q !== seat) out.add(`${q.x},${q.y}`); }
  return out;
}

describe("wanderTarget with the person's area", () => {
  const SEAT = { x: 150, y: 520 };
  it("off (no area): a stroll may end in another area — the work area's waypoint (today's behaviour, the control)", () => {
    expect(Z.WANDER.PERIOD).toBe(PERIOD);
    const spots = spotsOver("atlas", SEAT, layoutOf(), null);
    expect(spots.has("150,330")).toBe(true);
  });
  it("on: only spots inside the area whose walk stays inside it — never wk (in the work area); via-wk is walked to straight (no graph path from in1)", () => {
    const g = layoutOf();
    const spots = spotsOver("atlas", SEAT, g, "lounge");
    expect([...spots].sort()).toEqual(["150,450", "250,450", "50,420"]);
    for (const s of spots) { const [x, y] = s.split(",").map(Number); expect(inRect(g.areas.lounge.rect, { x, y })).toBe(true); }
  });
  it("on, and a spot inside the area can only be reached through another area: stays seated", () => {
    // The seat's nearest waypoint is wk (the work area): the walk to via-wk (inside the tavern) goes through it.
    const g = { ...layoutOf(), waypoints: WAYPOINTS.filter((w) => ["wk", "via-wk"].includes(w.id)), edges: [["wk", "via-wk"]] };
    const seat = { x: 150, y: 380 };
    expect(spotsOver("atlas", seat, g, null).size).toBeGreaterThan(0);                         // off: strolls
    expect(spotsOver("atlas", seat, g, "lounge").size).toBe(0);                                 // on: seated
  });
  it("on, and no walk stays inside: a spot whose walk only crosses a corridor (no area) is still taken", () => {
    const g = { ...layoutOf(), waypoints: WAYPOINTS.filter((w) => ["cor", "cor-in"].includes(w.id)), edges: [["cor", "cor-in"]] };
    const seat = { x: 590, y: 450 };                                   // its nearest waypoint is cor (the corridor)
    expect([...spotsOver("atlas", seat, g, "lounge")]).toEqual(["560,600"]);
  });
  it("on, the corridor fallback: a leg that cuts through another area between two corners rules the spot out", () => {
    // The seat's nearest waypoint is w (outside every area); the spot is t, inside the tavern.
    const g = (w: any) => ({ ...layoutOf(), waypoints: [w, { id: "t", x: 560, y: 500 }], edges: [[w.id, "t"]] });
    const seat = { x: 560, y: 380 };
    expect([...spotsOver("atlas", seat, g({ id: "w", x: 660, y: 420 }), "lounge")]).toEqual(["560,500"]);   // corridor only: kept
    // seat → (640, 300): neither end is in the work area, but the leg cuts its corner (x 595, y 345): ruled out.
    expect(spotsOver("atlas", seat, g({ id: "w", x: 640, y: 300 }), null).size).toBeGreaterThan(0);       // off: strolls
    expect(spotsOver("atlas", seat, g({ id: "w", x: 640, y: 300 }), "lounge").size).toBe(0);
  });
  it("on, on a straight graph: the same spots (an L between two points of a rect area stays in it)", () => {
    const g = layoutOf();
    expect(spotsOver("atlas", SEAT, { ...g, straight: true }, "lounge")).toEqual(spotsOver("atlas", SEAT, g, "lounge"));
  });
  it("an area the layout does not have: as off", () => {
    const g = layoutOf();
    expect(spotsOver("atlas", SEAT, g, "nowhere")).toEqual(spotsOver("atlas", SEAT, g, null));
  });
});

describe("walkTargets with ownArea", () => {
  const VISITS = [{ area: "spring", weight: 100, minSeconds: 5, maxSeconds: 5 }];
  const desksOf = (g: any) => [
    { node: { name: "atlas", state: "idle" }, seat: { x: 150, y: 520 }, area: "lounge" },
    { node: { name: "quill", state: "idle" }, seat: { x: 300, y: 520 }, area: "lounge" },
    { node: { name: "sage", state: "idle" }, seat: { x: 450, y: 520 }, area: "lounge" },
  ].map((d) => ({ ...d, night: false, g }));
  const run = (g: any, ownArea: boolean, furniture: any[] = []) => {
    const desks = desksOf(g), memo = { claims: new Map(), idle: null }, seen: any[] = [];
    for (let t = 0; t < 45 * PERIOD; t += 1000) for (const [name, q] of Z.walkTargets(desks, g, t, true, furniture, false, memo, ownArea)) seen.push({ name, q });
    return seen;
  };
  it("off: idleVisits send people to the spring and strolls reach the work area (the control)", () => {
    const seen = run(layoutOf({ idleVisits: VISITS }), false);
    const g = layoutOf({ idleVisits: VISITS });
    expect(seen.some(({ q }) => inRect(g.areas.spring.rect, q))).toBe(true);
    expect(seen.some(({ q }) => inRect(g.areas.work.rect, q))).toBe(true);
  });
  it("on: nobody leaves the tavern — no visits, no stroll outside it — yet they still stroll", () => {
    const g = layoutOf({ idleVisits: VISITS });
    const seen = run(g, true);
    for (const { q } of seen) expect(inRect(g.areas.lounge.rect, q)).toBe(true);
    const seats = new Set(desksOf(g).map((d) => `${d.seat.x},${d.seat.y}`));
    expect(seen.some(({ q }) => !seats.has(`${q.x},${q.y}`))).toBe(true);
  });
  it("on: a walking NPC strolls only in the area its spot is in", () => {
    const g = layoutOf();
    const npc = { id: "barkeep", x: 150, y: 400, walk: true };
    const off = run(g, false, [npc]).filter(({ name }) => name === "furniture/barkeep");
    const on = run(g, true, [npc]).filter(({ name }) => name === "furniture/barkeep");
    expect(off.some(({ q }) => inRect(g.areas.work.rect, q))).toBe(true);
    expect(on.every(({ q }) => inRect(g.areas.lounge.rect, q))).toBe(true);
    expect(on.some(({ q }) => q.x !== npc.x || q.y !== npc.y)).toBe(true);
  });
});

describe("the office setting: host store, page model, editor", () => {
  const OFF = { id: "tavern", name: "Tavern", skin: "cozy", members: [] };
  const store = () => { const d = mkdtempSync(join(tmpdir(), "agend-m3286-")); dirs.push(d); return { d, s: new OfficeStore(d) }; };
  it("checked: true or false (false is no key), anything else refused", () => {
    expect(checkOffices([{ ...OFF, stayInArea: true }])).toEqual({ ok: true, offices: [{ ...OFF, stayInArea: true }] });
    expect(checkOffices([{ ...OFF, stayInArea: false }])).toEqual({ ok: true, offices: [OFF] });
    expect(checkOffices([{ ...OFF, stayInArea: "yes" }])).toMatchObject({ ok: false, status: 400, detail: "offices[0].stayInArea: true or false" });
  });
  it("on disk beside the list, never in the entry (an older host refuses the key there); read back whole", () => {
    const { d, s } = store();
    expect(s.replace([{ ...OFF, stayInArea: true }, { ...OFF, id: "hall", name: "Hall" }], 0).ok).toBe(true);
    const doc = JSON.parse(readFileSync(s.path, "utf8"));
    expect(doc.offices).toEqual([OFF, { ...OFF, id: "hall", name: "Hall" }]);
    expect(doc.stayInArea).toEqual({ tavern: true });
    expect(officesOnDisk([{ ...OFF, stayInArea: true } as any]).offices[0]).toEqual(OFF);
    expect(new OfficeStore(d).list().offices).toEqual([{ ...OFF, stayInArea: true }, { ...OFF, id: "hall", name: "Hall" }]);
  });
  it("a file an older host wrote (no key) reads as off; a value other than true reads as off", () => {
    const { d } = store();
    writeFileSync(join(d, "web-offices.json"), JSON.stringify({ version: 1, rev: 3, offices: [OFF, { ...OFF, id: "hall" }], stayInArea: { hall: "yes" } }));
    expect(new OfficeStore(d).list().offices).toEqual([OFF, { ...OFF, id: "hall" }]);
  });
  it("the page keeps it (true only) and saves it back", () => {
    expect(M.officeOk({ ...OFF, stayInArea: true }).stayInArea).toBe(true);
    expect("stayInArea" in M.officeOk({ ...OFF, stayInArea: "yes" })).toBe(false);
    expect(E.officeForSave({ ...OFF, stayInArea: true })).toEqual({ ...OFF, stayInArea: true });
    expect("stayInArea" in E.officeForSave({ ...OFF, stayInArea: undefined })).toBe(false);
  });
  describe("Edit offices", () => {
    const STORE = { ready: true, instances: [{ name: "atlas", status: "running", backend: "claude-code" }], exec: {}, awaiting: {}, needs: [] };
    beforeEach(async () => { await p.unmount(); app.appStore.set(STORE); });
    const mount = async (office: any) => {
      const puts: any[] = [];
      const st = S.createOfficeStore({ fetch: async (_u: string, o: any) => { puts.push(JSON.parse(o.body)); return { ok: true, status: 200, json: async () => ({ rev: 2, offices: [] }) }; } });
      const view = O.buildOrgView({ general: ["atlas"], teams: [], instances: {} }, app.appStore.get());
      await p.mount(h(E.OfficeEditor, { offices: [office], rev: 1, view, store: st, onSaved: () => {}, onClose: () => {} }));
      await settle(2);
      return puts;
    };
    const box = () => p.root.querySelector(".oe-stay-in-area");
    const save = async (puts: any[]) => { p.root.querySelector("#oeSave").click(); await settle(4); return puts.at(-1).offices[0]; };
    it("a box per office, off by default; ticking it saves stayInArea: true; unticking saves no key", async () => {
      let puts = await mount({ ...OFF, layout: null });
      expect(box().checked).toBe(false);
      expect(box().parentNode.textContent.trim()).toBe("Idle people stay in their own area");
      box().checked = true; fire(box(), "change"); await settle(2);
      expect(await save(puts)).toEqual({ ...OFF, stayInArea: true });
      await p.unmount();
      puts = await mount({ ...OFF, layout: null, stayInArea: true });
      expect(box().checked).toBe(true);
      box().checked = false; fire(box(), "change"); await settle(2);
      expect(await save(puts)).toEqual(OFF);
    });
  });
});
