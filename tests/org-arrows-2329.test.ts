/**
 * #2329: the org canvas's arrowheads — small, in stroke widths, ending off the card; none where the line's last run
 * cannot hold one; no side pin facing a narrow gutter; the turn into a pin moved out for the head; the lane route's
 * side entries a head's width apart. Pure geometry, with the real libavoid (libavoid-js 0.4.5, WebAssembly, in Node).
 */
import { beforeAll, describe, expect, it } from "vitest";
// @ts-expect-error — a JS module of the app, with no types
import { OC, canvasLayout } from "../src/ui/fleet-canvas-layout.js";
// @ts-expect-error — a JS module of the app, with no types
import { ROUTE, SEPARATE, lengthen, routeScene, routeWith } from "../src/ui/fleet-route-scene.js";
// @ts-expect-error — a JS module of the app, with no types
import { HEAD, headFits, lastRun, strokeOf, trafficEdges, trimEnds } from "../src/ui/fleet-traffic.js";

type Pt = { x: number; y: number };
let A: any;
beforeAll(async () => {
  const { AvoidLib } = await import("libavoid-js");
  await AvoidLib.load(new URL("libavoid.wasm", import.meta.resolve("libavoid-js")).pathname);
  A = AvoidLib.getInstance();
});

// ── Fixtures: demo names only ──
const N = (name: string) => ({ name });
const team = (name: string, names: string[]) => ({ name, nodes: names.map(N), counts: [] });
const DEV = ["dev-web", "dev-web-codex", "reviewer-a", "reviewer-b", "coordinator", "dev-1", "dev-2", "dev-3", "dev-4", "docs-writer", "release-bot", "tester", "auditor"];
/** The user's shape: General on top; a 13-member team; a small one; two in no team. */
const devLayout = (narrow = false) => canvasLayout({ top: [N("general")], teams: [team("agend-dev", DEV), team("ops", ["ops-deploy", "ops-monitor", "ops-backup"])],
  rest: { nodes: [N("scout"), N("notes-drafter")], counts: [] } }, new Set(), { narrow });
const msg = (id: string, from: string, to: string, kind = "send", extra: Record<string, unknown> = {}) => ({ id, from, to, kind, state: "delivering", fading: false, ...extra });
/** Its traffic: delegations from General, neighbours both ways, two into General, one from another team. */
const TRAFFIC = [
  ...[["general", "dev-1"], ["general", "dev-2"], ["general", "reviewer-a"], ["general", "coordinator"]].map(([a, z], i) => msg(`w${i}`, a, z, "task", { phase: "work" })),
  ...[["dev-1", "reviewer-a", "send"], ["reviewer-a", "dev-1", "report"], ["dev-web", "dev-web-codex", "send"], ["dev-web-codex", "dev-web", "send"], ["dev-web", "general", "send"],
    ["dev-web-codex", "general", "report"], ["coordinator", "dev-4", "task"], ["dev-3", "dev-4", "send"], ["tester", "auditor", "send"], ["ops-deploy", "dev-2", "send"],
    ["release-bot", "docs-writer", "send"]].map(([a, z, k], i) => msg(`l${i}`, a, z, k)),
];
const cards = (L: any) => [...L.tops, ...L.boxes.flatMap((b: any) => b.cells)];
const cardOf = (L: any, name: string) => cards(L).find((c: any) => c.node.name === name);
/** The drawn path's first and last points. */
const ends = (d: string) => { const n = d.match(/-?[\d.]+/g)!.map(Number); return [{ x: n[0], y: n[1] }, { x: n[n.length - 2], y: n[n.length - 1] }]; };
const gapTo = (p: Pt, c: any) => Math.hypot(Math.max(c.x - p.x, 0, p.x - c.x - c.w), Math.max(c.y - p.y, 0, p.y - c.y - c.h));
/** Route the edges with libavoid; the edges as drawn with its answer. */
function routed(L: any, items: any[]) {
  const scene = routeScene(L, trafficEdges(items, L));
  const map = routeWith(A, scene);
  return { scene, map, edges: trafficEdges(items, L, { routed: map }) };
}

describe("the head and the ends", () => {
  it("strokes by kind and phase: the work and its report 3 px, a team pair 3.5, the rest 2.5", () => {
    expect([strokeOf("task", "work"), strokeOf("report", "return"), strokeOf("team", "live"), strokeOf("team", "work"), strokeOf("send", "live"), strokeOf("task", "fading")])
      .toEqual([3, 3, 3.5, 3, 2.5, 2.5]);
  });
  it("a head fits a last run that holds the tip's gap, the head and a little line — not a hair less", () => {
    for (const w of [2.5, 3, 3.5]) {
      const need = HEAD.GAP + HEAD.LEN * w + HEAD.ROOM;
      expect([headFits(need, w), headFits(need - 0.01, w)]).toEqual([true, false]);
    }
    // Small: at most 3 stroke widths long, narrower than long; the tip a few px off the card.
    expect([HEAD.LEN <= 3, HEAD.WIDE < HEAD.LEN, HEAD.GAP >= 2 && HEAD.GAP <= 6, HEAD.BACK < HEAD.LEN]).toEqual([true, true, true, true]);
  });
  it("trimEnds: the start along its first run, the end back along its last; middle points of a straight run dropped; each run keeps 1 px", () => {
    const pts = [{ x: 0, y: 0 }, { x: 0, y: 10 }, { x: 0, y: 20 }, { x: 30, y: 20 }, { x: 30, y: 40 }];
    expect(trimEnds(pts, 3.5, 6)).toEqual([{ x: 0, y: 3.5 }, { x: 0, y: 20 }, { x: 30, y: 20 }, { x: 30, y: 34 }]);
    expect(trimEnds([{ x: 0, y: 0 }, { x: 5, y: 0 }], 3, 3)).toEqual([{ x: 3, y: 0 }, { x: 4, y: 0 }]);
    expect([lastRun(pts), lastRun([{ x: 0, y: 0 }, { x: 0, y: 10 }, { x: 0, y: 25 }])]).toEqual([20, 25]);
  });
  it("every drawn line starts START off its card and its head's tip ends GAP short of its card; with no head the line itself ends GAP short", () => {
    const L = devLayout();
    const edges = trafficEdges(TRAFFIC, L);
    const seen = { head: 0, none: 0 };
    for (const e of edges) {
      const [s, z] = ends(e.d), last = e.pts[e.pts.length - 1];
      const a = cardOf(L, e.names[0]), b = cardOf(L, e.names[1]);
      expect(gapTo(s, a)).toBeCloseTo(HEAD.START, 5);
      expect(e.w).toBe(strokeOf(e.hue, e.phase));
      expect(e.head).toBe(headFits(lastRun(e.pts), e.w));
      // The path stops BACK stroke widths inside the head: the tip is GAP off the card.
      expect(gapTo(z, b)).toBeCloseTo(HEAD.GAP + (e.head ? HEAD.BACK * e.w : 0), 5);
      expect(gapTo(last, b)).toBe(0);                                              // the route itself still ends on its card
      seen[e.head ? "head" : "none"]++;
    }
    expect(seen.head).toBeGreaterThan(0);
  });
  it("a line whose last run is too short draws no head (and keeps its route)", () => {
    const L = devLayout();
    const [e] = trafficEdges([msg("1", "dev-1", "reviewer-a")], L);
    const short = [...e.pts.slice(0, -1), e.pts[e.pts.length - 1]];
    // The same route with its last run cut to 6 px: no head.
    const p = short.slice(-2), dx = Math.sign(p[1].x - p[0].x), dy = Math.sign(p[1].y - p[0].y);
    short[short.length - 2] = { x: p[1].x - dx * 6, y: p[1].y - dy * 6 };
    const map = new Map([[e.key, short]]);
    const [f] = trafficEdges([msg("1", "dev-1", "reviewer-a")], L, { routed: map });
    expect([f.routed, f.head, lastRun(f.pts)]).toEqual([true, false, 6]);
  });
});

describe("the lane route (the fallback)", () => {
  it("lines into one card's side meet it a head's width apart (7 px), not 3.5", () => {
    const L = devLayout();
    // Several lines from General into reviewer-a (a side column): each its own lane offset.
    const items = ["send", "task", "report", "broadcast"].map((k, i) => msg(String(i), "general", "reviewer-a", k));
    const ys = trafficEdges(items, L).map((e: any) => e.pts[e.pts.length - 1]).filter((p: Pt) => p.x === cardOf(L, "reviewer-a").x || p.x === cardOf(L, "reviewer-a").x + OC.NW).map((p: Pt) => p.y).sort((a: number, b: number) => a - b);
    expect(ys.length).toBeGreaterThan(1);
    for (let i = 1; i < ys.length; i++) expect(ys[i] - ys[i - 1]).toBeGreaterThanOrEqual(2 * HEAD.WIDE * 2.5 / 2 + 1);
  });
  it("a single line into a card's side, on either side, has room for its head", () => {
    const L = devLayout();
    const box = L.boxes.find((b: any) => b.name === "agend-dev");
    const left = box.cells[0].node.name, right = box.cells[box.cols - 1].node.name;
    for (const z of [left, right]) {
      const [e] = trafficEdges([msg("1", "general", z)], L);
      expect([z, e.head]).toEqual([z, true]);
    }
  });
});

describe("libavoid's pins", () => {
  it("a card's short side has a pin only with ROUTE.SIDE beside it: the outer columns' outer sides on a desktop, none in a gutter or on a phone", () => {
    for (const narrow of [false, true]) {
      const L = devLayout(narrow);
      const { shapes } = routeScene(L, []);
      const box = L.boxes.find((b: any) => b.name === "agend-dev");
      const sideOf = (c: any) => { const s = shapes.find((x: any) => x.x === c.x && x.y === c.y && x.pins); return s.sides ?? 3; };
      // Beside a card: a neighbour across the gutter (L.gap), else the box's wall across its padding (L.pad less the
      // wall piece's 1 px) — or nothing (the last row's open end).
      const room = (i: number, d: number) => {
        const col = i % box.cols, j = i + d;
        if (col + d >= 0 && col + d < box.cols && j < box.cells.length) return L.gap;
        return col + d < 0 || col + d >= box.cols ? L.pad - 1 : Infinity;
      };
      const want = (i: number) => (room(i, -1) >= ROUTE.SIDE ? 1 : 0) | (room(i, 1) >= ROUTE.SIDE ? 2 : 0);
      expect(box.cells.map((c: any, i: number) => [c.node.name, sideOf(c)])).toEqual(box.cells.map((c: any, i: number) => [c.node.name, want(i)]));
      // The middle column never has one; on a phone no member card does.
      expect(box.cells.filter((_: any, i: number) => i % box.cols === 1 && i + 1 < box.cells.length).every((c: any) => sideOf(c) === 0)).toBe(true);
      if (narrow) expect(box.cells.slice(0, -1).every((c: any) => sideOf(c) === 0)).toBe(true);
      expect(sideOf(L.tops[0])).toBe(3);                                         // General: room both ways
    }
    expect([OC.GAP < ROUTE.SIDE, OC.PAD - 1 >= ROUTE.SIDE, OC.PAD_NARROW - 1 < ROUTE.SIDE]).toEqual([true, true, true]);
  });
  it("a card with no side pin and more lines than its pins gets more on its long sides (none of its lines share a pin)", () => {
    const L = devLayout();
    // 9 lines: one more than its 8 pins (4 on each long side, none on the short), fewer than a card with side pins has.
    const items = ["send", "task", "report"].flatMap((k) => ["dev-web", "reviewer-a", "dev-2"].map((a) => msg(`${a}${k}`, a, "coordinator", k)));
    const scene = routeScene(L, trafficEdges(items, L));
    const c = cardOf(L, "coordinator"), sh = scene.shapes.find((x: any) => x.x === c.x && x.y === c.y && x.pins);
    expect([sh.sides, items.length, sh.pins]).toEqual([0, 9, Math.ceil(9 / 2)]);
    const out = routeWith(A, scene), at = [...out.values()].map((p: Pt[]) => `${p[p.length - 1].x},${p[p.length - 1].y}`);
    expect([out.size, new Set(at).size]).toEqual([9, 9]);
  });
  it("no routed line ends on a card's side across a narrow gutter (the head squeezed between two cards)", () => {
    for (const narrow of [false, true]) {
      const L = devLayout(narrow);
      const { edges, map } = routed(L, TRAFFIC);
      expect(map.size).toBe(edges.length);
      for (const e of edges) {
        const z = e.pts[e.pts.length - 1], c = cardOf(L, e.names[1]);
        const onSide = z.x === c.x || z.x === c.x + c.w;
        if (!onSide) continue;
        const neighbour = cards(L).filter((k: any) => k !== c && k.y < c.y + c.h && k.y + k.h > c.y)
          .map((k: any) => (z.x === c.x ? c.x - k.x - k.w : k.x - c.x - c.w)).filter((g: number) => g >= 0);
        expect([e.key, neighbour.every((g: number) => g >= ROUTE.SIDE)]).toEqual([e.key, true]);
      }
    }
  });
  it("the turn into the last pin is moved out: on a desktop all but a few lines get a head; the routes still meet #2182's rules", () => {
    const L = devLayout();
    const { edges } = routed(L, TRAFFIC);
    const heads = edges.filter((e: any) => e.head).length;
    expect(heads).toBeGreaterThanOrEqual(edges.length - 2);
    // Orthogonal, ends on their cards, through no card.
    for (const e of edges) {
      const p: Pt[] = e.pts;
      expect(p.slice(1).every((q, i) => q.x === p[i].x || q.y === p[i].y)).toBe(true);
      expect([gapTo(p[0], cardOf(L, e.names[0])), gapTo(p[p.length - 1], cardOf(L, e.names[1]))]).toEqual([0, 0]);
      for (const k of cards(L)) for (let i = 1; i < p.length; i++) {
        const x0 = Math.min(p[i - 1].x, p[i].x), x1 = Math.max(p[i - 1].x, p[i].x), y0 = Math.min(p[i - 1].y, p[i].y), y1 = Math.max(p[i - 1].y, p[i].y);
        expect(x1 > k.x + 1 && x0 < k.x + k.w - 1 && y1 > k.y + 1 && y0 < k.y + k.h - 1).toBe(false);
      }
    }
  });
});

describe("lengthen()", () => {
  // Two cards far apart; a line out of the first's bottom, along, and down into the second's top 5 px after its turn.
  const scene = { shapes: [{ x: 0, y: 0, w: 40, h: 20, pins: 1 }, { x: 200, y: 200, w: 40, h: 20, pins: 1 }], conns: [{ key: "k", a: 0, z: 1 }], boxes: [] };
  const line = [{ x: 20, y: 20 }, { x: 20, y: 100 }, { x: 0, y: 100 }, { x: 0, y: 195 }, { x: 220, y: 195 }, { x: 220, y: 200 }];
  it("moves the turn before the last run out until the run is ROUTE.RUN", () => {
    const out = lengthen(new Map([["k", line]]), scene).get("k");
    expect(out.slice(-3)).toEqual([{ x: 0, y: 200 - ROUTE.RUN }, { x: 220, y: 200 - ROUTE.RUN }, { x: 220, y: 200 }]);
    expect(out.slice(0, 3)).toEqual(line.slice(0, 3));
  });
  it("leaves a run that is long enough, and one whose turn cannot move (a shape in the way; the run before it would turn back)", () => {
    const long = [...line.slice(0, -2), { x: 220, y: 170 }, { x: 220, y: 200 }].map((p, i) => (i === 3 ? { x: 0, y: 170 } : p));
    expect(lengthen(new Map([["k", long]]), scene).get("k")).toEqual(long);
    // A wall just above the target's buffer: no room to move the turn out.
    const walled = { ...scene, shapes: [...scene.shapes, { x: 100, y: 186, w: 140, h: 2, pins: 0 }] };
    // Short of RUN: the longest run that fits, the turn just clear of the wall's buffer (188 + 4.5 → 193).
    const near = lengthen(new Map([["k", line]]), walled).get("k");
    expect(near.slice(-3)).toEqual([{ x: 0, y: 193 }, { x: 220, y: 193 }, { x: 220, y: 200 }]);
    // The run before the turn would turn back: it leaves a card whose bottom is 10 px above the target's top.
    const low = { ...scene, shapes: [{ x: 0, y: 150, w: 40, h: 40, pins: 1 }, scene.shapes[1]] };
    const tight = [{ x: 20, y: 190 }, { x: 20, y: 194 }, { x: 220, y: 194 }, { x: 220, y: 200 }];
    expect(lengthen(new Map([["k", tight]]), low).get("k")).toEqual(tight);
    // A middle run that would turn back (it comes down 5 px to the turn): the turn moves only as far as keeps it going
    // down 4 px — never up past where it started.
    const side = { ...scene, shapes: [{ x: 0, y: 170, w: 40, h: 40, pins: 1 }, scene.shapes[1]] };
    const back = [{ x: 40, y: 190 }, { x: 100, y: 190 }, { x: 100, y: 195 }, { x: 220, y: 195 }, { x: 220, y: 200 }];
    expect(lengthen(new Map([["k", back]]), side).get("k").slice(-3)).toEqual([{ x: 100, y: 194 }, { x: 220, y: 194 }, { x: 220, y: 200 }]);
  });
  it("keeps SEPARATE from a parallel line: a second line along the new run's height is passed by", () => {
    const other = [{ x: 30, y: 20 }, { x: 30, y: 60 }, { x: 140, y: 60 }, { x: 140, y: 200 - ROUTE.RUN }, { x: 300, y: 200 - ROUTE.RUN }, { x: 300, y: 300 }];
    const two = { ...scene, shapes: [...scene.shapes, { x: 280, y: 300, w: 40, h: 20, pins: 1 }], conns: [...scene.conns, { key: "o", a: 0, z: 2 }] };
    const out = lengthen(new Map([["k", line], ["o", other]]), two).get("k");
    const y = out[out.length - 2].y;
    expect(Math.abs(y - (200 - ROUTE.RUN))).toBeGreaterThanOrEqual(SEPARATE);
    expect(200 - y).toBeGreaterThanOrEqual(ROUTE.RUN);
  });
  it("a parallel line SEPARATE away up to libavoid's float noise does not count as close", () => {
    const y0 = 200 - ROUTE.RUN + SEPARATE - 6e-10;
    const other = [{ x: 30, y: 20 }, { x: 30, y: 60 }, { x: 140, y: 60 }, { x: 140, y: y0 }, { x: 300, y: y0 }, { x: 300, y: 300 }];
    const two = { ...scene, shapes: [...scene.shapes, { x: 280, y: 300, w: 40, h: 20, pins: 1 }], conns: [...scene.conns, { key: "o", a: 0, z: 2 }] };
    expect(lengthen(new Map([["k", line], ["o", other]]), two).get("k")[line.length - 2]).toEqual({ x: 220, y: 200 - ROUTE.RUN });
  });
  it("ROUTE.RUN holds a head on the heaviest card line (the work, 3 px)", () => {
    expect([headFits(ROUTE.RUN, 3), headFits(ROUTE.RUN, 2.5)]).toEqual([true, true]);
  });
});
