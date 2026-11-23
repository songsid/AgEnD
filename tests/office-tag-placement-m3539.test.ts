/**
 * M-3539: in a crowded Studio office (a Hub room's 30 agents) name tags covered each other, a person stood on 休息區, and
 * a tag could sit under the zoom control. Every tag now goes through one placer: clear of the others (badges included),
 * of each area's name and of what the page keeps clear over the scene (`env.keepClear`), at its place, else a row lower,
 * else compact; the hovered one always at its place; the walking after everyone at their place. An area's name a figure
 * stands on is written again over the people.
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

// The room's 30 agents (two of one name, labelled with their owner) and its assistant; 2 working, 1 paused, 5 stopped.
const NAMES = ["Atlas (Example owner)", "Quill", "Sage", "Nova", "Tide", "Atlas (Alex Sample)", "Pixel", "Ember", "Flint", "Harbor", "Iris", "Juniper", "Kite", "Lumen",
  "Maple", "Nimbus", "Onyx", "Pebble", "Quartz", "Reed", "Slate", "Thistle", "Umber", "Vale", "Willow", "Yarrow", "Zephyr", "Birch", "Cedar", "Dune", "Room assistant"];
const stateOf = (i: number) => (i === 1 || i === 10 ? "working" : i === 17 ? "paused" : i >= 25 && i < 30 ? "stopped" : "idle");
const touch = (a: any, b: any) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

function scene(style: string, { walkers = null as any, n = NAMES.length } = {}) {
  const base = K.SKINS.get(style), drawn: any[] = [], titled: string[] = [];
  const bubbles: any[] = [];
  const skin = { ...base, drawCharacter() {}, drawFurniture() {}, drawBackground() {},
    drawBubble: (ctx: any, x: number, y: number, text: string, env: any, lift = 0) => { if (text) bubbles.push(K.bubbleBox(ctx, x, y, text, lift)); }, drawAreaTitle: (ctx: any, area: any) => { titled.push(area.name); },
    drawTag: (ctx: any, x: number, y: number, look: any, env: any, compact = false) => { drawn.push({ label: look.label, x, y, compact, badge: look.badge }); } };
  const nodes = NAMES.slice(0, n).map((name, i) => ({ name, state: stateOf(i), i: { name } }));
  const L = Z.zonesLayout(base.pack, nodes);
  const looks = new Map(L.rooms.flatMap((r: any) => r.desks).filter((d: any) => d.node).map((d: any) => [d.key,
    { name: d.node.name, label: d.node.name, state: d.node.state, pose: d.node.state }]));
  const part = F.partOf(L, looks, skin, true, walkers || Z.createWalkers(), { frame: () => [], size: () => 0 });
  // Text as wide as the browser draws it: a CJK character a full em, any other about 0.6 em, at the font's px size.
  const ctx = new Proxy({ measureText(t: string) { const px = Number(/(\d+)px/.exec(this.font)?.[1] ?? 10);
    return { width: [...t].reduce((w, c) => w + (c.codePointAt(0)! >= 0x2e80 ? px : px * 0.6), 0) }; }, font: "" } as any,
    { get(o, k) { if (k in o) return typeof o[k] === "function" ? o[k].bind(o) : o[k]; return () => {}; }, set(o, k, v) { o[k] = v; return true; } });
  const env = { pal: { ...K.DEFAULT_PAL }, mode: "light", labels: { areas: { desks: "工作區", lounge: "休息區", alert: "求救區", nap: "午睡角" } } };
  const draw = ({ hot = null as string | null, ms = 0, keepClear = null as any[] | null } = {}) => {
    drawn.length = 0; titled.length = 0; bubbles.length = 0;
    F.drawPart(ctx, part, 1, 0, 0, ms, ms === 0, hot, keepClear ? { ...env, keepClear } : env);
    return [...drawn];
  };
  const box = (t: any) => K.tagFootprint(ctx, K.tagBox(ctx, t.x, t.y, t.label, t.compact), t.badge, t.compact);
  const titles = Object.values(L.areas).map((a: any) => K.areaTitleBox(ctx, a, env));
  return { L, part, draw, box, titles, titled, ctx, env, bubbles };
}
const noneTouch = (boxes: any[], what: string) => {
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) expect(touch(boxes[i], boxes[j]), `${what}: ${i}×${j}`).toBe(false);
};

describe("M-3539 name tags in a crowded Studio", () => {
  for (const style of ["studio", "studio-large"]) {
    it(`${style}: 31 people — no tag touches another or an area's name, and almost everyone has one`, () => {
      const s = scene(style), tags = s.draw(), boxes = tags.map(s.box);
      noneTouch(boxes, style);
      for (const b of boxes) for (const t of s.titles) expect(touch(b, t), `${style}: a tag on ${t.text}`).toBe(false);
      expect(new Set(tags.map((t) => t.label)).size).toBe(tags.length);
      expect(tags.length).toBeGreaterThanOrEqual(NAMES.length - 3);
    });
  }

  it("a tag stays within the sides of the area its person is in (「Atlas（Example …」 at the large lounge's first column)", () => {
    for (const style of ["studio", "studio-large"]) {
      const s = scene(style), seat = new Map([...s.L.seats]);
      for (const t of s.draw()) {
        const at: any = seat.get(t.label), ar: any = Object.values(s.L.areas).find((a: any) => at.x >= a.rect.x && at.x <= a.rect.x + a.rect.w && at.y >= a.rect.y && at.y <= a.rect.y + a.rect.h);
        if (!ar) continue;
        const b = K.tagBox(s.ctx, t.x, t.y, t.label, t.compact);
        expect([b.x >= ar.rect.x, b.x + b.w <= ar.rect.x + ar.rect.w], `${style}: ${t.label} in ${ar.name}`).toEqual([true, true]);
      }
    }
  });

  it("a tag that would touch one already drawn goes a row lower (16), else compact — never on top of it", () => {
    const s = scene("studio"), tags = s.draw(), seat = new Map([...s.L.seats]);
    const drops = new Set(tags.filter((t) => !t.compact).map((t) => t.y - (seat.get(t.label) as any).y));
    for (const d of drops) expect([0, 16]).toContain(d);
    for (const t of tags.filter((x) => x.compact)) expect([0, 12]).toContain(t.y - (seat.get(t.label) as any).y);
  });

  it("the hovered person's tag is drawn at their place, full, whatever is under it", () => {
    const s = scene("studio");
    for (const d of s.part.desks) {
      const t = s.draw({ hot: d.key }).find((x) => x.label === d.node.name);
      expect(t, d.node.name).toBeTruthy();
      expect([t.compact, t.y], d.node.name).toEqual([false, d.seat.y]);
    }
  });

  it("what the page keeps clear (the zoom control) gets no tag; with nothing kept clear the tags there are drawn", () => {
    const s = scene("studio-large");
    const before = s.draw().map((t) => ({ ...t, b: s.box(t) }));
    const lounge = s.L.areas.lounge.rect, keep = { x: lounge.x + lounge.w - 140, y: lounge.y, w: 140, h: 260 };
    const under = before.filter((t) => touch(t.b, keep));
    expect(under.length).toBeGreaterThan(0);                       // the box is over tags: what the test is about
    const after = s.draw({ keepClear: [keep] });
    for (const t of after) expect(touch(s.box(t), keep), t.label).toBe(false);
  });

  it("a tag that only a control is in the way of slides sideways past it, at its place, instead of going (the minimap and Cedar)", () => {
    const s = scene("studio-large"), seat = new Map([...s.L.seats]);
    const t0 = s.draw().find((t) => t.label === "Cedar"), b = s.box(t0);
    const keep = { x: b.x + Math.round(b.w / 2), y: b.y - 20, w: 120, h: 67 };     // the minimap over Cedar's tag's right half
    const t1 = s.draw({ keepClear: [keep] }).find((t) => t.label === "Cedar");
    expect(t1, "Cedar's tag is still drawn").toBeTruthy();
    expect([t1.y, t1.compact]).toEqual([(seat.get("Cedar") as any).y, false]);
    expect(touch(s.box(t1), keep)).toBe(false);
    expect(Math.abs(t1.x - t0.x)).toBeLessThanOrEqual(b.w);
  });

  it("no bubble covers an area's name (Studio (large)'s first lounge row speaks right under 休息區)", () => {
    const s = scene("studio-large");
    let n = 0;
    for (let ms = 1; ms < 120_000; ms += 1500) {
      s.draw({ ms });
      for (const b of s.bubbles) { n++; for (const t of s.titles) expect(touch(b, t), `${ms}: a bubble on ${t.text}`).toBe(false); }
    }
    expect(n).toBeGreaterThan(20);
  });

  it("an area's name is written again over the people only when a figure stands on it", () => {
    const s = scene("studio");
    s.draw();
    const on = new Set(s.titled);
    for (const a of Object.values(s.L.areas) as any[]) {
      const title = K.areaTitleBox(s.ctx, a, s.env);
      const covered = s.part.desks.some((d: any) => touch({ x: d.seat.x - 24, y: d.seat.y - 52, w: 48, h: 66 }, title));
      expect(on.has(a.name), a.name).toBe(covered);
    }
    const few = scene("studio", { n: 3 });
    few.draw();
    expect(few.titled).toEqual([]);
  });

  it("someone walking past a seated person's tag yields to it: the seated one keeps their place", () => {
    const walkers = Z.createWalkers(), s0 = scene("studio-large", { walkers });
    const desks = s0.part.desks, seated = desks.find((d: any) => d.node.name === "Quill"), walker = desks.find((d: any) => d.node.name === "Atlas (Example owner)");
    const graph = s0.L, targets = new Map(desks.map((d: any) => [d.node.name, d.seat]));
    walkers.sync(targets, 1000, graph, true);
    // Atlas walks off from just beside and above Quill's seat (so before Quill in drawing order): at 1001 still there.
    walkers.place(walker.node.name, { x: seated.seat.x + 20, y: seated.seat.y - 4 });   // a little higher: drawn (and tagged, by place) first
    walkers.sync(new Map([...targets, [walker.node.name, { x: seated.seat.x + 20 + 400, y: seated.seat.y }]]), 1000, graph, false);
    const tags = s0.draw({ ms: 1001 });
    const q = tags.find((t) => t.label === "Quill"), sg = tags.find((t) => t.label === walker.node.name);
    expect([q.compact, q.y]).toEqual([false, seated.seat.y]);
    if (sg) expect(touch(s0.box(sg), s0.box(q))).toBe(false);
  });
});

describe("M-3539 keepClearOf: the controls over the stage in scene units", () => {
  const el = (r: any) => ({ getBoundingClientRect: () => ({ ...r, right: r.left + r.width, bottom: r.top + r.height }) });
  it("the zoom stack's box, 4 CSS px round it, at the view's scale and origin; nothing outside the canvas", () => {
    const zoom = el({ left: 900, top: 80, width: 40, height: 200 }), away = el({ left: 2000, top: 80, width: 40, height: 40 });
    const root = { querySelectorAll: () => [zoom, away] };
    const cv = { closest: () => root, getBoundingClientRect: () => ({ left: 100, top: 50, width: 900, height: 600, right: 1000, bottom: 650 }) };
    const [b, ...rest] = F.keepClearOf(cv, { k: 0.5, x: 20, y: 10 });
    expect(rest).toEqual([]);
    expect(b).toEqual({ x: (900 - 100 - 4 - 20) / 0.5, y: (80 - 50 - 4 - 10) / 0.5, w: 48 / 0.5, h: 208 / 0.5 });
  });
  it("asks for the zoom stack, the minimap (leader's capture check: it covered Cedar's tag at 150%) and the floating zone chips", () => {
    let asked = "";
    const root = { querySelectorAll: (sel: string) => { asked = sel; return []; } };
    F.keepClearOf({ closest: () => root, getBoundingClientRect: () => ({ left: 0, top: 0, width: 10, height: 10, right: 10, bottom: 10 }) }, { k: 1, x: 0, y: 0 });
    expect(asked.split(",").map((x) => x.trim())).toEqual([".oo-zoom", ".oo-mini", ".oo-stage > .oo-zone-pills"]);
  });
  it("no canvas, no office round it, or no scale: nothing", () => {
    expect(F.keepClearOf(null, { k: 1, x: 0, y: 0 })).toEqual([]);
    expect(F.keepClearOf({ closest: () => null, getBoundingClientRect: () => ({}) }, { k: 1, x: 0, y: 0 })).toEqual([]);
  });
});

describe("M-3539 the idle never stroll or visit to the help desk", () => {
  const inR = (r: any, p: any) => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
  /** Every idle person's walk target over `turns` wander turns, in `L` (a layout), from `t0`. */
  const targets = (L: any, turns = 400) => {
    const desks = L.rooms.flatMap((r: any) => r.desks), out: any[] = [];
    for (let i = 0; i < turns; i++) for (const [name, at] of Z.walkTargets(desks, L, i * 1700, true, [], false, null, false)) out.push({ name, at });
    return out;
  };
  const nodes = NAMES.map((name) => ({ name, state: "idle", i: { name } }));

  for (const style of ["studio", "studio-large"]) {
    it(`${style}: the help desk is where the calling go, and no idle stroll ends there — while one would without the rule`, () => {
      const pack = K.SKINS.get(style).pack, L = Z.zonesLayout(pack, nodes), alert = L.areas.alert.rect;
      expect(Z.callingAreas(pack)).toEqual(["alert"]);
      expect(L.idleAvoid).toEqual(["alert"]);
      const now = targets(L), was = targets({ ...L, idleAvoid: [] });
      expect(was.some((x) => inR(alert, x.at)), "the old rule sent someone there: what this test is about").toBe(true);
      expect(now.filter((x) => inR(alert, x.at)).map((x) => x.name)).toEqual([]);
      expect(now.some((x) => !L.seats.has(x.name) || x.at.x !== L.seats.get(x.name).x || x.at.y !== L.seats.get(x.name).y)).toBe(true);   // still strolling
    });
  }

  it("a pack's idle visit to the help desk is never taken; its visits elsewhere still are (#3685)", () => {
    const base = K.SKINS.get("studio").pack;
    const pack = { ...base, idleVisits: [{ area: "alert", weight: 100, minSeconds: 5, maxSeconds: 10 }, { area: "nap", weight: 100, minSeconds: 5, maxSeconds: 10 }] };
    const L = Z.zonesLayout(pack, nodes), home = L.seats.get("Quill");
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i++) { const v = Z.visitAt("Quill", home, L, i * 1000, "lounge"); if (v) seen.add(v.area); }
    expect([...seen]).toEqual(["nap"]);
  });

  it("no calling area when a pack sends the calling where the idle live, or names none", () => {
    const base = K.SKINS.get("studio").pack;
    expect(Z.callingAreas({ ...base, stateZones: { ...base.stateZones, needs: "lounge", crashed: "lounge", stuck: "lounge" } })).toEqual([]);
    expect(Z.callingAreas({ ...base, stateZones: { idle: "lounge", default: "lounge" } })).toEqual([]);
  });

  it("the calling go where zoneOf sends them, fallbacks included (#4376 review): a default, else the first area", () => {
    const base = K.SKINS.get("studio").pack;
    const viaDefault = { ...base, stateZones: { idle: "lounge", default: "alert" } };
    expect(Z.callingAreas(viaDefault)).toEqual(["alert"]);
    const viaFirst = { ...base, stateZones: { idle: "lounge" } };
    expect(Z.callingAreas(viaFirst)).toEqual([Object.keys(base.areas)[0]]);
    // And the walk targets keep to it: no idle stroll ends in the default's help desk.
    const L = Z.zonesLayout(viaDefault, nodes.map((n) => ({ ...n }))), desks = L.rooms.flatMap((r: any) => r.desks), alert = L.areas.alert.rect;
    expect(L.idleAvoid).toEqual(["alert"]);
    for (let i = 0; i < 400; i++) for (const [name, at] of Z.walkTargets(desks, L, i * 1700, true, [], false, null, false)) expect(inR(alert, at), name).toBe(false);
  });
});

describe("M-3539 a new office or style places everyone at once (Prism #4376 P2)", () => {
  const graph = { waypoints: [], edges: [] };
  /** Someone half-way along a walk to `to`. */
  const walkingTo = (to: any) => {
    const w = Z.createWalkers();
    w.sync(new Map([["Quill", { x: 100, y: 100 }]]), 0, graph);
    w.sync(new Map([["Quill", to]]), 0, graph);
    const mid = w.at("Quill", 500);
    expect(mid.walking).toBe(true);                                 // under way: what the test is about
    return w;
  };
  it("a walk under way to the very seat the new layout gives (Studio and Studio (large) share the work seats) stops there", () => {
    const to = { x: 400, y: 100 }, w = walkingTo(to);
    w.sync(new Map([["Quill", to]]), 500, graph, false, true);
    expect(w.at("Quill", 501)).toEqual({ x: 400, y: 100, walking: false });
  });
  it("and to another seat: there at once", () => {
    const w = walkingTo({ x: 400, y: 100 });
    w.sync(new Map([["Quill", { x: 50, y: 300 }]]), 500, graph, false, true);
    expect(w.at("Quill", 501)).toEqual({ x: 50, y: 300, walking: false });
  });
  it("an ordinary sync in the same style keeps the walk going", () => {
    const to = { x: 400, y: 100 }, w = walkingTo(to);
    const before = w.at("Quill", 600);
    w.sync(new Map([["Quill", to]]), 500, graph);
    expect(w.at("Quill", 600)).toEqual(before);
    expect(before.walking).toBe(true);
  });
});

describe("M-3539 a stroll never ends on someone else, nor with its tag past its area's edge", () => {
  const stacked = (a: any, b: any) => Math.abs(a.x - b.x) < 44 && Math.abs(a.y - b.y) < 60;
  for (const style of ["studio", "studio-large"]) {
    it(`${style}: 31 people (23 idle) over 400 samples 1.7 s apart — nobody stands on anybody or ends a stroll in the hall; the idle still stroll`, () => {
      const pack = K.SKINS.get(style).pack, nodes = NAMES.map((name, i) => ({ name, state: stateOf(i), i: { name } }));
      const L = Z.zonesLayout(pack, nodes), desks = L.rooms.flatMap((r: any) => r.desks);
      let strolled = 0;
      for (let i = 0; i < 400; i++) {
        const to = [...Z.walkTargets(desks, L, i * 1700, true, [], false, null, false)].map(([name, at]: any) => ({ name, at }));
        for (let a = 0; a < to.length; a++) for (let b = a + 1; b < to.length; b++) expect(stacked(to[a].at, to[b].at), `${i}: ${to[a].name} on ${to[b].name}`).toBe(false);
        for (const x of to) {
          const seat = L.seats.get(x.name);
          if (seat && (x.at.x !== seat.x || x.at.y !== seat.y)) {
            strolled++;
            const ar: any = Object.values(L.areas).find((a: any) => x.at.x >= a.rect.x && x.at.x <= a.rect.x + a.rect.w && x.at.y >= a.rect.y && x.at.y <= a.rect.y + a.rect.h);
            expect(ar, `${i}: ${x.name} ends a stroll in the hall`).toBeTruthy();
            expect(x.at.y + 18 <= ar.rect.y + ar.rect.h, `${i}: ${x.name}'s tag past ${ar.name}'s edge`).toBe(true);
          }
        }
      }
      expect(strolled).toBeGreaterThan(50);                         // fewer in a full plain Studio, but they stroll
    });
  }
});
