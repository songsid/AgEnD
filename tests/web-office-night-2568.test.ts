/**
 * #2568: bedtime — when it is on (per device, off by default), from 00:00 to 06:00 on the viewer's clock the idle
 * people of a zones office go to bed: the area asleep people go to, while it has a free seat; the rest doze where they
 * are. Their state stays idle (the tooltip and the list say so); they are drawn asleep and do not stroll. Anyone with
 * something to do (working, calling) is where their state sends them, and back to bed when it is done. A furniture
 * item (an NPC) may have a `night`: a strip drawn, playing, at bedtime — at its own place, or another one.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { page, type AppPage } from "./helpers/app-harness.js";

let p: AppPage;
let Z: any, S: any, PK: any, F: any;
beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19280/ui/fleet/org" });
  Z = await import("/ui/js/fleet-office-zones.js");
  S = await import("/ui/js/fleet-office-store.js");
  PK = await import("/ui/js/fleet-office-pack.js");
  F = await import("/ui/js/fleet-office.js");
});
afterAll(async () => { await p.unmount(); p.restore(); });

const PACK = {
  areas: {
    work: { rect: { x: 0, y: 0, w: 400, h: 300 }, seats: [{ x: 100, y: 100 }, { x: 200, y: 100 }] },
    lounge: { rect: { x: 400, y: 0, w: 400, h: 300 }, seats: [{ x: 500, y: 100 }, { x: 600, y: 100 }, { x: 700, y: 100 }] },
    nap: { rect: { x: 0, y: 400, w: 400, h: 300 }, seats: [{ x: 100, y: 500 }, { x: 200, y: 500 }] },
  },
  stateZones: { working: "work", idle: "lounge", paused: "nap", stopped: "nap", default: "lounge" },
  waypoints: [{ id: "door", x: 640, y: 700 }], edges: [], door: { x: 640, y: 700 },
};
const N = (name: string, state: string) => ({ name, state });
const where = (L: any) => Object.fromEntries(L.rooms[0].desks.map((d: any) => [d.node.name, [d.area, !!d.night]]));

describe("isNight", () => {
  it("00:00 up to (not at) 06:00", () => {
    const at = (h: number, m = 0) => Z.isNight(new Date(2026, 9, 24, h, m));
    expect([at(23, 59), at(0), at(3), at(5, 59), at(6), at(12)]).toEqual([false, true, true, true, false, false]);
  });
});

describe("zonesLayout at night", () => {
  it("the idle go to bed while a bed is free, the rest doze in the lounge; working stays at work; by day as before", () => {
    const nodes = [N("a", "idle"), N("b", "idle"), N("c", "idle"), N("w", "working")];
    expect(where(Z.zonesLayout(PACK, nodes, new Map(), { night: true }))).toEqual({ a: ["nap", true], b: ["nap", true], c: ["lounge", true], w: ["work", false] });
    expect(where(Z.zonesLayout(PACK, nodes))).toEqual({ a: ["lounge", false], b: ["lounge", false], c: ["lounge", false], w: ["work", false] });
  });
  it("someone already asleep keeps their bed: fewer free for the idle", () => {
    const L = Z.zonesLayout(PACK, [N("p", "paused"), N("a", "idle"), N("b", "idle")], new Map(), { night: true });
    expect(where(L)).toEqual({ p: ["nap", false], a: ["nap", true], b: ["lounge", true] });
  });
  it("a sleeper at night does not stroll", () => {
    const L = Z.zonesLayout(PACK, [N("a", "idle")], new Map(), { night: true });
    const d = L.rooms[0].desks;
    for (let t = 0; t < 2 * Z.WANDER.PERIOD; t += 1000) expect(Z.walkTargets(d, L, t).get("a")).toBe(d[0].seat);
  });
});

describe("the setting", () => {
  it("M-3560: its label — English reworded to match the zh-TW meaning; zh-TW unchanged", async () => {
    const I = await import("/assets/app-i18n.js");
    expect(I.tIn("en", "orgo.nightOn")).toBe("Bedtime (0–6): idle agents sleep");
    expect(I.tIn("zh-TW", "orgo.nightOn")).toBe("0–6 點就寢：閒著的人去睡");
  });
  it("off by default, kept per device", () => {
    const m = new Map<string, string>();
    const st = S.createOfficeStore({ storage: { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) } });
    expect(st.nightOn()).toBe(false);
    st.saveNightOn(true);
    expect(st.nightOn()).toBe(true);
    st.saveNightOn(false);
    expect(st.nightOn()).toBe(false);
  });
});

describe("furniture at night", () => {
  const STRIP = (src: string) => ({ src, frames: 2, w: 16, h: 16 });
  const base = () => ({ format: 1, id: "n", background: "bg.png", areas: { lounge: { rect: [0, 0, 1280, 720], seats: [[100, 100]] } }, stateZones: { idle: "lounge" },
    characters: { default: { idle: STRIP("i.png") } },
    furniture: [{ id: "elder", sprite: STRIP("elder.png"), x: 300, y: 300, depth: "y", night: { sprite: STRIP("fox.png") } },
      { id: "dean", sprite: STRIP("dean.png"), x: 500, y: 300, depth: "y", night: { sprite: STRIP("dean_sleep.png"), x: 220, y: 410 } },
      { id: "lamp", sprite: STRIP("lamp.png"), x: 700, y: 100 }] });
  it("checked like a strip, its picture the pack's; an unknown key refused", () => {
    const c = PK.checkSkinPack(base());
    expect(c.ok).toBe(true);
    expect(PK.packImages(c.pack)).toEqual(expect.arrayContaining(["fox.png", "dean_sleep.png"]));
    const bad = base(); (bad.furniture[0] as any).night.when = "always";
    expect(PK.checkSkinPack(bad)).toEqual({ ok: false, error: 'furniture[0].night: unknown key "when"' });
  });
  it("with #2570's keys: loop, activeWhen/activeFor and night on one item all kept; at night its night strip plays", () => {
    const m = base();
    m.furniture = [{ ...m.furniture[0], loop: true, activeWhen: "needs", activeFor: "atlas", activeSprite: STRIP("look.png") } as any];
    const f = PK.checkSkinPack(m).pack.furniture[0];
    expect([f.loop, f.activeFor, f.activeSprite.src, f.night.sprite.src]).toEqual([true, ["atlas"], "look.png", "fox.png"]);
    const n = F.nightFurniture([f])[0];
    expect([n.sprite.src, n.activeSprite, n.asleep]).toEqual(["fox.png", null, true]);
  });
  it("nightFurniture: its night strip, playing, at its night place (its own when none); the rest as they are", () => {
    const f = F.nightFurniture(PK.checkSkinPack(base()).pack.furniture);
    const by = Object.fromEntries(f.map((x: any) => [x.id, [x.sprite.src, x.x, x.y, !!x.asleep]]));
    expect(by).toEqual({ elder: ["fox.png", 300, 300, true], dean: ["dean_sleep.png", 220, 410, true], lamp: ["lamp.png", 700, 100, false] });
  });
});
