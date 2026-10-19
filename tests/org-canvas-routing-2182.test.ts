/**
 * #2182: the org canvas's traffic lines routed by libavoid (libavoid-js 0.4.5, the real WebAssembly build, in Node)
 * around the cards and through the team boxes' doors — the issue's acceptance on the screenshot's case (a sender
 * outside the awp-ota box, targets inside it and in the box of instances in no team) and on a busier fleet; the scene,
 * the checks on what crosses to and from the worker, the page's client, the lines' fallback to their lanes, and the
 * server side (the worker's own CSP, libavoid's two files, the public link).
 */
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { beforeAll, describe, expect, it } from "vitest";
// @ts-expect-error — a JS module of the app, with no types
import { OC, canvasLayout } from "../src/ui/fleet-canvas-layout.js";
// @ts-expect-error — a JS module of the app, with no types
import { ROUTE, SEPARATE, answerRoute, routeOk, routeScene, routeWith, sceneOk, separate } from "../src/ui/fleet-route-scene.js";
// @ts-expect-error — a JS module of the app, with no types
import { createRouteClient, TIMEOUT_MS, WASM_URL, WORKER_URL } from "../src/ui/fleet-route.js";
// @ts-expect-error — a JS module of the app, with no types
import { route as laneRoute, trafficEdges } from "../src/ui/fleet-traffic.js";
import { handleWebRequest } from "../src/web-api.js";
import { ROUTE_WORKER_CSP, ROUTE_WORKER_PATH, WEB_CONTENT_SECURITY_POLICY } from "../src/web-host-guard.js";
import { isPinnedLibavoid, LIBAVOID_PATHS, LIBAVOID_PREFIX, LIBAVOID_VERSION, libavoidFile } from "../src/web-libavoid.js";
import { isPublicWebRoute } from "../src/public-web-gateway.js";

type Pt = { x: number; y: number };
let A: any;
beforeAll(async () => {
  const { AvoidLib } = await import("libavoid-js");
  const wasm = new URL("libavoid.wasm", import.meta.resolve("libavoid-js")).pathname;
  await AvoidLib.load(wasm);
  A = AvoidLib.getInstance();
});

// ── Fixtures: demo names only ──
const N = (name: string) => ({ name });
const team = (name: string, n: number, from: number) => ({ name, nodes: Array.from({ length: n }, (_, i) => N(`${name}-${i + from}`)), counts: [] });
/** The screenshot's shape: General on top; awp-ota and other teams; instances in no team. */
function screenshotLayout(folded = new Set<string>(), narrow = false) {
  return canvasLayout({ top: [N("general")], teams: [team("platform", 4, 1), team("awp-ota", 5, 1), team("data", 3, 1)], rest: { nodes: [N("loner-1"), N("loner-2"), N("loner-3")], counts: [] } }, folded, { narrow });
}
/** A busier fleet: 60 cards in eight teams and no team. */
function fleet60() {
  const sizes = [8, 6, 9, 4, 7, 5, 3, 6];
  const teams = sizes.map((n, i) => team(i === 1 ? "awp-ota" : `team${i}`, n, 1));
  const used = 1 + sizes.reduce((a, b) => a + b, 0);
  return canvasLayout({ top: [N("general")], teams, rest: { nodes: Array.from({ length: 60 - used }, (_, i) => N(`loner-${i + 1}`)), counts: [] } });
}
const msg = (id: string, from: string, to: string, kind = "task") => ({ id, from, to, kind, state: "delivering", fading: false });
const cardOf = (L: any, name: string) => [...L.tops, ...L.boxes.flatMap((b: any) => b.cells)].find((c: any) => c.node.name === name);

/** Route the lines `trafficEdges` makes of `items` on `L` with real libavoid; the edges as drawn with the answer. */
function routed(L: any, items: any[]) {
  const lanes = trafficEdges(items, L);
  const scene = routeScene(L, lanes);
  const map = routeWith(A, scene);
  return { lanes, scene, map, edges: trafficEdges(items, L, { routed: map }) };
}

// ── The acceptance checks, as geometry ──
const segs = (p: Pt[]) => p.slice(1).map((q, i) => ({ a: p[i], b: q, h: p[i].y === q.y }));
const span = (s: any) => (s.h ? [Math.min(s.a.x, s.b.x), Math.max(s.a.x, s.b.x)] : [Math.min(s.a.y, s.b.y), Math.max(s.a.y, s.b.y)]);
const onRectEdge = (p: Pt, r: any) => ((Math.abs(p.x - r.x) < 0.5 || Math.abs(p.x - r.x - r.w) < 0.5) && p.y >= r.y - 0.5 && p.y <= r.y + r.h + 0.5)
  || ((Math.abs(p.y - r.y) < 0.5 || Math.abs(p.y - r.y - r.h) < 0.5) && p.x >= r.x - 0.5 && p.x <= r.x + r.w + 0.5);
/** Problems with drawn lines `edges` on `L`: the issue's acceptance, each a short note (none: all met). */
function problems(L: any, edges: any[]) {
  const out: string[] = [];
  const cards = [...L.tops, ...L.boxes.flatMap((b: any) => b.cells)];
  for (const e of edges) {
    const p: Pt[] = e.pts;
    if (segs(p).some((s) => s.a.x !== s.b.x && s.a.y !== s.b.y)) out.push(`${e.key}: not orthogonal`);
    // Every line ends on a card (its own), never on a box edge.
    const za = e.a.c, zz = e.z.c;
    if (!za || !onRectEdge(p[0], za)) out.push(`${e.key}: does not start on its card`);
    if (!zz || !onRectEdge(p[p.length - 1], zz)) out.push(`${e.key}: does not end on its card`);
    for (const s of segs(p)) {
      const [lo, hi] = span(s), c = s.h ? s.a.y : s.a.x;
      for (const b of L.boxes) {
        // Never along a box border (within 6 px of it, for more than 12 px).
        const lines = s.h ? [b.y, b.y + b.h] : [b.x, b.x + b.w];
        const [blo, bhi] = s.h ? [b.x, b.x + b.w] : [b.y, b.y + b.h];
        if (lines.some((v) => Math.abs(v - c) < 6) && Math.min(hi, bhi) - Math.max(lo, blo) > 12) out.push(`${e.key}: runs along ${b.name ?? "no team"}'s border`);
        // Never through a header band (its name and count).
        if (s.h ? c > b.y && c < b.y + OC.HEAD && hi > b.x && lo < b.x + b.w : c > b.x && c < b.x + b.w && hi > b.y && lo < b.y + OC.HEAD) out.push(`${e.key}: crosses ${b.name ?? "no team"}'s header`);
      }
      for (const k of cards) if (s.h ? c > k.y + 1 && c < k.y + k.h - 1 && hi > k.x + 1 && lo < k.x + k.w - 1 : c > k.x + 1 && c < k.x + k.w - 1 && hi > k.y + 1 && lo < k.y + k.h - 1) out.push(`${e.key}: through ${k.node.name}`);
    }
    // The arrowhead (the last 14 px, 9 px either side) clears every box border.
    const z = p[p.length - 1], y = p[p.length - 2];
    const t = Math.min(1, 14 / Math.hypot(z.x - y.x, z.y - y.y)), s0 = { x: z.x + (y.x - z.x) * t, y: z.y + (y.y - z.y) * t };
    const head = { x0: Math.min(s0.x, z.x) - (z.y === y.y ? 0 : 9), x1: Math.max(s0.x, z.x) + (z.y === y.y ? 0 : 9), y0: Math.min(s0.y, z.y) - (z.y === y.y ? 9 : 0), y1: Math.max(s0.y, z.y) + (z.y === y.y ? 9 : 0) };
    for (const b of L.boxes) {
      const vx = [b.x, b.x + b.w].some((x) => x > head.x0 && x < head.x1) && head.y1 > b.y && head.y0 < b.y + b.h;
      const hy = [b.y, b.y + b.h].some((v) => v > head.y0 && v < head.y1) && head.x1 > b.x && head.x0 < b.x + b.w;
      if (vx || hy) out.push(`${e.key}: arrowhead on ${b.name ?? "no team"}'s border`);
    }
  }
  // No two lines share a run: never closer than 4 px along more than 8 px.
  for (let i = 0; i < edges.length; i++) for (let j = i + 1; j < edges.length; j++) {
    for (const s1 of segs(edges[i].pts)) for (const s2 of segs(edges[j].pts)) {
      if (s1.h !== s2.h) continue;
      const c1 = s1.h ? s1.a.y : s1.a.x, c2 = s2.h ? s2.a.y : s2.a.x, [l1, h1] = span(s1), [l2, h2] = span(s2);
      if (Math.abs(c1 - c2) < 4 && Math.min(h1, h2) - Math.max(l1, l2) > 8) out.push(`${edges[i].key} and ${edges[j].key} share a run`);
    }
  }
  return [...new Set(out)];
}
const length = (p: Pt[]) => p.slice(1).reduce((n, q, i) => n + Math.abs(q.x - p[i].x) + Math.abs(q.y - p[i].y), 0);

describe("the screenshot's case: General → two in awp-ota and one in no team", () => {
  const items = [msg("1", "general", "awp-ota-1"), msg("2", "general", "awp-ota-4"), msg("3", "general", "loner-2")];
  it("every line is routed, starts and ends on its cards, and meets the acceptance — no shared run, no border, no header, no arrowhead on a border", () => {
    const L = screenshotLayout();
    const { edges, map } = routed(L, items);
    expect([map.size, edges.every((e: any) => e.routed), problems(L, edges)]).toEqual([3, true, []]);
  });
  it("each takes the shortest clear channel: no longer than the distance between its ends plus one door's detour (the lane to no team, the control, is not)", () => {
    const L = screenshotLayout();
    const { edges, lanes } = routed(L, items);
    // Into a box through a side door: down past its header and padding and back, at most.
    const detour = 2 * (OC.HEAD + OC.PAD) + 40;
    const within = (p: Pt[]) => length(p) <= Math.abs(p[p.length - 1].x - p[0].x) + Math.abs(p[p.length - 1].y - p[0].y) + detour;
    expect([edges.map((e: any) => [e.key, within(e.pts)]), lanes.map((e: any) => within(e.pts))])
      .toEqual([edges.map((e: any) => [e.key, true]), [true, true, false]]);
  });
  it("its lane route, today's: the lines that share General's stub — the bug, kept as the control", () => {
    const L = screenshotLayout();
    expect(problems(L, trafficEdges(items, L)).some((p) => / share a run$/.test(p))).toBe(true);
  });
  it("on a phone's narrow packing (its tighter gutters) too", () => {
    const L = screenshotLayout(new Set(), true);
    const { edges, map } = routed(L, items);
    expect([L.gap, L.pad, map.size, problems(L, edges)]).toEqual([OC.GAP_NARROW, OC.PAD_NARROW, 3, []]);
  });
  it("the same two ends and kind are one line with ×N (stacked, never two lines on one run)", () => {
    const L = screenshotLayout();
    const { edges } = routed(L, [...items, msg("4", "general", "awp-ota-1"), msg("5", "general", "awp-ota-1")]);
    const one = edges.filter((e: any) => e.names.includes("awp-ota-1"));
    expect([one.length, one[0].n, one[0].badge !== null, problems(L, edges)]).toEqual([1, 3, true, []]);
  });
  it("a task, its report back and a message between the same two cards: three lines, apart", () => {
    const L = screenshotLayout();
    const { edges, map } = routed(L, [msg("1", "general", "awp-ota-1"), msg("2", "awp-ota-1", "general", "report"), msg("3", "general", "awp-ota-1", "send")]);
    expect([edges.length, map.size, problems(L, edges)]).toEqual([3, 3, []]);
  });
});

describe("a busier fleet: 60 cards, 20 lines between teams", () => {
  it("meets the acceptance on every line", () => {
    const L = fleet60();
    const names = [...L.tops, ...L.boxes.flatMap((b: any) => b.cells)].map((c: any) => c.node.name);
    let seed = 11;
    const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
    const items: any[] = [];
    while (items.length < 20) { const a = names[rnd(names.length)], z = names[rnd(names.length)]; if (a !== z) items.push(msg(String(items.length), a, z)); }
    const { edges, map } = routed(L, items);
    if (process.env.SHOW) console.log("P60", JSON.stringify(problems(L, edges)), JSON.stringify(edges.filter((e: any) => e.key.includes("team7-2")).map((e: any) => e.pts)), JSON.stringify(L.boxes.filter((b: any) => ["team7", "team6", "team4"].includes(b.name)).map((b: any) => [b.name, b.x, b.y, b.w, b.h, b.cells.map((c: any) => [c.node.name, c.x, c.y])])));
    expect([map.size, problems(L, edges)]).toEqual([edges.length, []]);
  });
});

describe("the scene", () => {
  it("cards and General have pins; each open box its header band and wall pieces in front of its cards (the gaps are its doors)", () => {
    const L = screenshotLayout();
    const { shapes } = routeScene(L, []);
    const awp = L.boxes.find((b: any) => b.name === "awp-ota");
    const inBox = shapes.filter((s: any) => s.x >= awp.x - 1 && s.x + s.w <= awp.x + awp.w + 1 && s.y >= awp.y - 1 && s.y + s.h <= awp.y + awp.h + 1);
    const cols = awp.cells.slice(0, awp.cols).map((c: any) => c.x), rows = [...new Set(awp.cells.map((c: any) => c.y))];
    expect([
      inBox.filter((s: any) => s.pins === 1).length,                                        // its 5 cards
      inBox.some((s: any) => s.pins === 0 && s.y === awp.y - 1 && s.h === OC.HEAD + 1),      // the header band
      inBox.filter((s: any) => s.pins === 0 && s.h === 2).map((s: any) => [s.x, s.w]),       // below each column
      inBox.filter((s: any) => s.pins === 0 && s.w === 2).map((s: any) => [s.x, s.y, s.h]),  // beside each row, both sides
      shapes.filter((s: any) => s.pins === 1).length,                                        // every card
    ]).toEqual([5, true, cols.map((x: number) => [x, OC.NW]), [awp.x - 1, awp.x + awp.w - 1].flatMap((x: number) => rows.map((y) => [x, y, OC.NH])), 1 + 4 + 5 + 3 + 3]);
  });
  it("a folded team is one shape with pins (a line to it ends on it); a line to an open box (a broadcast bundle) is left to its lane", () => {
    const L = screenshotLayout(new Set(["data"]));
    const lanes = trafficEdges([msg("1", "general", "data-1")], L);
    const scene = routeScene(L, lanes);
    const box = L.boxes.find((b: any) => b.name === "data");
    expect([scene.conns.length, scene.shapes[scene.conns[0].z]]).toEqual([1, { x: box.x, y: box.y, w: box.w, h: box.h, pins: 1 }]);
    const open = screenshotLayout();
    const a = { kind: "top", c: open.tops[0], key: open.tops[0].key }, z = { kind: "box", b: open.boxes[0], key: `box:${open.boxes[0].key}` };
    expect(routeScene(open, [{ key: "k", a, z }]).conns).toEqual([]);
  });
  it("a card with more lines than pins gets more pins on its long sides: two lines never leave one point", () => {
    const L = screenshotLayout();
    const names = [...L.boxes.flatMap((b: any) => b.cells)].map((c: any) => c.node.name);
    const kinds = ["task", "send", "report", "broadcast"];
    const items = names.flatMap((n: string, i: number) => kinds.map((k) => msg(`${i}${k}`, n, "general", k)));
    const scene = routeScene(L, trafficEdges(items, L));
    const n = scene.conns.length, out = routeWith(A, scene);
    const atGeneral = [...out.values()].map((p: Pt[]) => `${p[p.length - 1].x},${p[p.length - 1].y}`);
    expect([n > ROUTE.PINS * 2 + 2, scene.shapes[0].pins, out.size, new Set(atGeneral).size]).toEqual([true, Math.ceil((n - 2) / 2), n, n]);
  });
});

describe("the separation pass (where libavoid's nudging leaves lines too close)", () => {
  // Two cards far apart, a wide channel; two lines whose middle runs are 2 px apart.
  const scene = { shapes: [{ x: 0, y: 0, w: 40, h: 20, pins: 1 }, { x: 0, y: 200, w: 40, h: 20, pins: 1 }, { x: 300, y: 0, w: 40, h: 20, pins: 1 }, { x: 300, y: 200, w: 40, h: 20, pins: 1 }],
    conns: [{ key: "a", a: 0, z: 1 }, { key: "b", a: 2, z: 3 }], boxes: [] as any[] };
  const lineA = [{ x: 40, y: 10 }, { x: 150, y: 10 }, { x: 150, y: 210 }, { x: 40, y: 210 }];
  it("moves a middle run to SEPARATE from its neighbour, its two joining runs following; the ends stay on their pins", () => {
    const out = separate(new Map([["a", lineA], ["b", [{ x: 300, y: 12 }, { x: 152, y: 12 }, { x: 152, y: 208 }, { x: 300, y: 208 }]]]), scene);
    const a = out.get("a"), b = out.get("b");
    expect([Math.abs(a[1].x - b[1].x) >= SEPARATE, a[0], a[3], b[0], b[3], a[1].x === a[2].x, b[1].x === b[2].x]).toEqual([true, lineA[0], lineA[3], { x: 300, y: 12 }, { x: 300, y: 208 }, true, true]);
  });
  it("never into a shape's buffer, never onto a box's border, never flipping a joining run — or it stays as it was", () => {
    // A wall right beside the run on one side and a box border on the other: no room; left as libavoid gave it.
    // Obstacles just left of A's run and just right of B's, wide enough that every place either could go (up to six
    // SEPARATE steps) is inside one: neither moves.
    const tight = { ...scene, shapes: [...scene.shapes, { x: 100, y: 30, w: 44, h: 160, pins: 0 }, { x: 156, y: 30, w: 40, h: 160, pins: 0 }] };
    const b0 = [{ x: 300, y: 12 }, { x: 152, y: 12 }, { x: 152, y: 208 }, { x: 300, y: 208 }];
    const out = separate(new Map([["a", lineA], ["b", b0]]), tight);
    expect(["shapes", out.get("a"), out.get("b")]).toEqual(["shapes", lineA, b0]);
    // And a box's border: every place A's run could go (SEPARATE steps from B's, leftwards; a wall on the right) is
    // within 7 px of a border.
    const edge = separate(new Map([["a", lineA], ["b", b0]]), { ...scene, shapes: [...scene.shapes, { x: 156, y: 30, w: 40, h: 160, pins: 0 }],
      boxes: [{ x: 0, y: -50, w: 144, h: 320 }, { x: 0, y: -50, w: 131, h: 320 }, { x: 0, y: -50, w: 119, h: 320 }] });
    expect(["border", edge.get("a"), edge.get("b")]).toEqual(["border", lineA, b0]);
  });
  it("a joining run never turns back: a move that would only fit past its corner is not made", () => {
    // A: up from its card, right, down a run at x 150 (y 100..210) beside B's (x 152); every place left of it to x 122
    // is in an obstacle, and x 116 would turn A's joining run (120 → 150) back on itself. B is boxed in both ways.
    const s2 = { shapes: [{ x: 0, y: 0, w: 40, h: 20, pins: 1 }, { x: 0, y: 200, w: 40, h: 20, pins: 1 }, { x: 300, y: 0, w: 40, h: 20, pins: 1 }, { x: 300, y: 200, w: 40, h: 20, pins: 1 },
      { x: 126, y: 110, w: 18, h: 80, pins: 0 }, { x: 156, y: 30, w: 40, h: 160, pins: 0 }, { x: 60, y: 20, w: 58, h: 70, pins: 0 }],
      conns: [{ key: "a", a: 0, z: 1 }, { key: "b", a: 2, z: 3 }], boxes: [] as any[] };
    const a0 = [{ x: 20, y: 20 }, { x: 20, y: 96 }, { x: 120, y: 96 }, { x: 120, y: 100 }, { x: 150, y: 100 }, { x: 150, y: 210 }, { x: 40, y: 210 }];
    const b0 = [{ x: 300, y: 12 }, { x: 152, y: 12 }, { x: 152, y: 208 }, { x: 300, y: 208 }];
    const out = separate(new Map([["a", a0], ["b", b0]]), s2);
    expect([out.get("a"), out.get("b")]).toEqual([a0, b0]);
  });
  it("first and last runs (on a pin) are never moved", () => {
    const short = new Map([["a", [{ x: 40, y: 10 }, { x: 300, y: 10 }]], ["b", [{ x: 40, y: 12 }, { x: 300, y: 12 }]]]);
    expect([...separate(short, { ...scene, conns: [] }).values()]).toEqual([...short.values()]);
  });
});

describe("what crosses to and from the worker is checked", () => {
  const ok = () => ({ shapes: [{ x: 0, y: 0, w: 10, h: 10, pins: 1 }, { x: 50, y: 0, w: 10, h: 10, pins: 1 }], conns: [{ key: "k", a: 0, z: 1 }], boxes: [{ x: -20, y: -20, w: 100, h: 60 }] });
  it("a scene: finite numbers in range, pin counts in range, indexes it has, ends with pins, bounded sizes", () => {
    const bad = [
      null, {}, { shapes: [], conns: null, boxes: [] }, { ...ok(), boxes: undefined }, { ...ok(), boxes: [{ x: 0, y: 0, w: -1, h: 5 }] },
      { ...ok(), shapes: [{ x: NaN, y: 0, w: 10, h: 10, pins: 1 }, ok().shapes[1]] },
      { ...ok(), shapes: [{ x: 0, y: 0, w: 0, h: 10, pins: 1 }, ok().shapes[1]] },
      { ...ok(), shapes: [{ x: 0, y: 0, w: 10, h: 10, pins: 1.5 }, ok().shapes[1]] },
      { ...ok(), shapes: [{ x: 0, y: 0, w: 10, h: 10, pins: ROUTE.MAX_PINS + 1 }, ok().shapes[1]] },
      { ...ok(), conns: [{ key: "k", a: 0, z: 2 }] },
      { ...ok(), conns: [{ key: "k", a: 0, z: 1.5 }] },
      { ...ok(), shapes: [ok().shapes[0], { ...ok().shapes[1], pins: 0 }] },
      { ...ok(), conns: [{ key: 7, a: 0, z: 1 }] },
      { shapes: Array.from({ length: ROUTE.MAX_SHAPES + 1 }, () => ok().shapes[0]), conns: [], boxes: [] },
      { ...ok(), shapes: [{ x: 2e6, y: 0, w: 10, h: 10, pins: 1 }, ok().shapes[1]] },
    ];
    expect([sceneOk(ok()) !== null, bad.map((s) => sceneOk(s))]).toEqual([true, bad.map(() => null)]);
  });
  it("a route: orthogonal, finite, at most MAX_POINTS, from its first shape's edge to its second's", () => {
    const s = ok(), c = s.conns[0];
    expect(routeOk([{ x: 10, y: 5 }, { x: 30, y: 5 }, { x: 30, y: 8 }, { x: 50, y: 8 }], s, c)).not.toBeNull();
    const bad = [
      [{ x: 10, y: 5 }, { x: 50, y: 8 }],                                   // diagonal
      [{ x: 12, y: 5 }, { x: 50, y: 5 }],                                   // not on the first card
      [{ x: 10, y: 5 }, { x: 45, y: 5 }],                                   // not on the second
      [{ x: 10, y: 5 }, { x: Infinity, y: 5 }],
      Array.from({ length: ROUTE.MAX_POINTS + 1 }, (_, i) => ({ x: 10, y: 5 + i * 0 })),
      "nope",
    ];
    expect(bad.map((p) => routeOk(p, s, c))).toEqual(bad.map(() => null));
  });
});

describe("the worker's answer (#2194 review)", () => {
  it("checks the scene before libavoid sees it: a scene sceneOk refuses gets no routes, though libavoid could route it", () => {
    const L = screenshotLayout();
    const good = routeScene(L, trafficEdges([msg("1", "general", "awp-ota-1")], L));
    // One card with more pins than ROUTE.MAX_PINS: sceneOk refuses it, though libavoid would route it.
    const many = { ...good, shapes: good.shapes.map((sh: any, i: number) => (i === good.conns[0].a ? { ...sh, pins: ROUTE.MAX_PINS + 1 } : sh)) };
    expect(routeWith(A, many).size).toBe(1);
    const ok = answerRoute(A, { type: "route", id: 7, scene: good }), refused = answerRoute(A, { type: "route", id: 8, scene: many });
    expect([ok.type, ok.id, ok.routes.length, refused.id, refused.routes]).toEqual(["routes", 7, 1, 8, null]);
  });
});

describe("the lines fall back to their lanes", () => {
  const items = [msg("1", "general", "awp-ota-1"), msg("2", "general", "loner-2")];
  it("a line the answer has no route for keeps its lane; zoomed out, no routed line at all", () => {
    const L = screenshotLayout();
    const { map, lanes } = routed(L, items);
    const keep = new Map([...map].slice(0, 1));
    const edges = trafficEdges(items, L, { routed: keep });
    expect(edges.map((e: any) => e.routed)).toEqual([true, false]);
    expect(edges[1].pts).toEqual(lanes[1].pts);
    expect(trafficEdges(items, L, { far: true, routed: map }).every((e: any) => !e.routed)).toBe(true);
  });
  it("a line that changed phase keeps the route its ends and kind had (no jump while the next answer is on its way), lent once", () => {
    const L = screenshotLayout();
    const { map } = routed(L, [msg("1", "general", "awp-ota-1")]);
    const now = [{ ...msg("1", "general", "awp-ota-1"), fading: true }, { ...msg("2", "general", "awp-ota-1"), state: "queued" }];
    const edges = trafficEdges(now, L, { routed: map });
    expect(edges.map((e: any) => e.routed).sort()).toEqual([false, true]);
    expect(edges.find((e: any) => e.routed).pts).toEqual([...map.values()][0]);
  });
});

describe("the page's client", () => {
  /** A fake Worker: records what it is sent; the test answers. */
  function rig({ wasmOk = true } = {}) {
    const workers: any[] = [], timers: Array<{ f: () => void; ms: number; live: boolean }> = [];
    let fetches = 0;
    class FakeWorker {
      sent: any[] = []; terminated = false; onmessage: any = null; onerror: any = null;
      constructor(public url: string, public opts: any) { workers.push(this); }
      postMessage(m: any) { this.sent.push(m); }
      terminate() { this.terminated = true; }
      answer(m: any) { this.onmessage?.({ data: m }); }
    }
    const client = createRouteClient({
      Worker: FakeWorker,
      fetch: async (url: string) => { fetches++; return { ok: wasmOk, status: wasmOk ? 200 : 404, url, arrayBuffer: async () => new ArrayBuffer(8) }; },
      timers: { set: (f: () => void, ms: number) => { const t = { f, ms, live: true }; timers.push(t); return t; }, clear: (t: any) => { if (t) t.live = false; } },
    });
    const tick = () => new Promise((r) => setTimeout(r, 0));
    return { client, workers, timers, fetches: () => fetches, tick };
  }
  const scene = () => ({ shapes: [{ x: 0, y: 0, w: 10, h: 10, pins: 1 }, { x: 50, y: 0, w: 10, h: 10, pins: 1 }], conns: [{ key: "k", a: 0, z: 1 }] });
  const good = [{ x: 10, y: 5 }, { x: 50, y: 5 }];
  it("one module worker at the worker's path, the wasm fetched once by the page and handed over; the answer checked", async () => {
    const r = rig();
    const p = r.client.route(scene());
    await r.tick(); await r.tick();
    const w = r.workers[0];
    expect([r.workers.length, w.url, w.opts, w.sent[0].type, w.sent[0].wasm instanceof ArrayBuffer, w.sent[1].type]).toEqual([1, WORKER_URL, { type: "module" }, "init", true, "route"]);
    w.answer({ type: "routes", id: w.sent[1].id, routes: [["k", good], ["other", good], ["k2", [{ x: 1, y: 1 }]]] });
    expect([...(await p)!]).toEqual([["k", good]]);
    const q = r.client.route(scene());
    await r.tick();
    w.answer({ type: "routes", id: w.sent[2].id, routes: [["k", [{ x: 10, y: 5 }, { x: 50, y: 8 }]]] });   // diagonal: dropped
    expect([[...(await q)!], r.fetches(), r.workers.length, WASM_URL]).toEqual([[], 1, 1, `${LIBAVOID_PREFIX}libavoid.wasm`]);
  });
  it("a newer scene replaces one still waiting (null for it); an answer to an older id is ignored", async () => {
    const r = rig();
    const first = r.client.route(scene());
    await r.tick(); await r.tick();
    const second = r.client.route(scene()), third = r.client.route(scene());
    expect(await second).toBeNull();
    const w = r.workers[0];
    w.answer({ type: "routes", id: 999, routes: [["k", good]] });
    w.answer({ type: "routes", id: w.sent[1].id, routes: [["k", good]] });
    expect((await first)!.size).toBe(1);
    await r.tick();
    w.answer({ type: "routes", id: w.sent[2].id, routes: [["k", good]] });
    expect((await third)!.size).toBe(1);
  });
  it("a route slower than TIMEOUT_MS ends the worker (null); two failures in a row and this page stops asking", async () => {
    const r = rig();
    const p = r.client.route(scene());
    await r.tick(); await r.tick();
    const t = r.timers.find((x) => x.live && x.ms === TIMEOUT_MS)!;
    t.f();
    expect([await p, r.workers[0].terminated, r.client.available]).toEqual([null, true, true]);
    const q = r.client.route(scene());
    await r.tick(); await r.tick();
    r.workers[1].answer({ type: "failed" });
    expect([await q, r.client.available, await r.client.route(scene()), r.workers.length]).toEqual([null, false, null, 2]);
  });
  it("#2194 review: closed, timed out or replaced while the .wasm is on its way — no worker is left behind, and never two", async () => {
    let workers: any[] = [], timers: any[] = [];
    let release: (() => void) | null = null;
    class W2 { terminated = false; onmessage: any = null; onerror: any = null; sent: any[] = []; constructor() { workers.push(this); } postMessage(m: any) { this.sent.push(m); } terminate() { this.terminated = true; } }
    /** A fresh client (no .wasm yet), whose fetches the test releases. */
    const fresh = () => { workers = []; timers = []; return createRouteClient({
      Worker: W2,
      fetch: () => new Promise((r) => { release = () => r({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8) }); }),
      timers: { set: (f: () => void, ms: number) => { const t = { f, ms, live: true }; timers.push(t); return t; }, clear: (t: any) => { if (t) t.live = false; } },
    }); };
    const tick = () => new Promise((r) => setTimeout(r, 0));
    // Closed while fetching: nothing is started when the bytes arrive.
    let client = fresh();
    const p = client.route(scene()); await tick();
    client.close();
    release!(); await tick(); await tick();
    expect([await p, workers.length]).toEqual([null, 0]);
    // Timed out while fetching, then asked again: the first start makes nothing; the second makes the one worker.
    client = fresh();
    const q = client.route(scene()); await tick();
    const first = release!;
    timers.find((t) => t.live && t.ms === TIMEOUT_MS).f();
    expect(await q).toBeNull();
    const r = client.route(scene()); await tick();
    const second = release!;
    first(); await tick(); await tick();
    second(); await tick(); await tick();
    expect([workers.length, workers.filter((w) => !w.terminated).length]).toEqual([1, 1]);
    workers[0].onmessage({ data: { type: "routes", id: workers[0].sent[1].id, routes: [["k", [{ x: 10, y: 5 }, { x: 50, y: 5 }]]] } });
    expect((await r)!.size).toBe(1);
  });
  it("no wasm (a 404): null, and a later try; no Worker at all: null, never a throw", async () => {
    const r = rig({ wasmOk: false });
    expect(await r.client.route(scene())).toBeNull();
    const none = createRouteClient({ Worker: null as any, fetch: async () => { throw new Error("never"); } });
    expect([await none.route(scene()), none.available]).toEqual([null, false]);
  });
});

describe("the server side", () => {
  function get(path: string): Promise<{ status: number; headers: Record<string, string>; body: Buffer | string }> {
    return new Promise((resolve) => {
      let status = 0;
      const headers: Record<string, string> = { "content-security-policy": WEB_CONTENT_SECURITY_POLICY };   // applyWebSecurityHeaders, before routing
      const res = {
        setHeader(k: string, v: string) { headers[k.toLowerCase()] = v; },
        writeHead(c: number, h?: Record<string, string>) { status = c; for (const [k, v] of Object.entries(h ?? {})) headers[k.toLowerCase()] = v; return res; },
        end(b?: Buffer | string) { resolve({ status, headers, body: b ?? "" }); },
      } as unknown as ServerResponse;
      const TOKEN = "u".repeat(48);
      const req = Object.assign(new EventEmitter(), { method: "GET", url: path, headers: { "x-agend-token": TOKEN }, destroy() {}, resume() {} }) as unknown as IncomingMessage;
      const ctx = { webToken: TOKEN, sseClients: new Set(), fleetConfig: { instances: {} }, logger: { info() {}, debug() {}, error() {} }, getUiStatus: () => ({}) } as never;
      handleWebRequest(req, res, new URL(`http://127.0.0.1:19280${path}`), ctx);
    });
  }
  it("the route worker arrives with its own policy (WebAssembly, no network, no eval); every other script keeps the page's", async () => {
    const w = await get(ROUTE_WORKER_PATH), other = await get("/ui/js/fleet-canvas.js");
    expect([w.status, w.headers["content-security-policy"], other.headers["content-security-policy"]]).toEqual([200, ROUTE_WORKER_CSP, WEB_CONTENT_SECURITY_POLICY]);
    expect(ROUTE_WORKER_CSP.split("; ")).toEqual(["default-src 'none'", "script-src 'self' 'wasm-unsafe-eval'", "connect-src blob:"]);
    expect(WEB_CONTENT_SECURITY_POLICY).not.toMatch(/wasm-unsafe-eval|unsafe-eval/);
    expect(WORKER_URL).toBe(ROUTE_WORKER_PATH);
  });
  it("libavoid's two files: the installed package's own, unmodified, with their types and a long cache; nothing else under the prefix", async () => {
    const js = await get(`${LIBAVOID_PREFIX}libavoid.js`), wasm = await get(`${LIBAVOID_PREFIX}libavoid.wasm`);
    const dist = new URL(".", import.meta.resolve("libavoid-js")).pathname;
    expect([js.status, js.headers["content-type"], Buffer.compare(Buffer.from(js.body as Buffer), readFileSync(`${dist}index.js`))]).toEqual([200, "application/javascript; charset=utf-8", 0]);
    expect([wasm.status, wasm.headers["content-type"], wasm.headers["cache-control"], Buffer.compare(Buffer.from(wasm.body as Buffer), readFileSync(`${dist}libavoid.wasm`))])
      .toEqual([200, "application/wasm", "private, max-age=31536000, immutable", 0]);
    expect([libavoidFile(`${LIBAVOID_PREFIX}index-node.mjs`), libavoidFile(`${LIBAVOID_PREFIX}../package.json`), libavoidFile("/ui/vendor/libavoid-0.4.4/libavoid.wasm")]).toEqual([null, null, null]);
  });
  it("one version everywhere: package.json's exact pin, the installed package, the served path, the worker's import", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    const installed = JSON.parse(readFileSync(new URL("../package.json", import.meta.resolve("libavoid-js").replace(/dist\/[^/]+$/, "dist/")), "utf8"));
    const worker = readFileSync(new URL("../src/ui/fleet-route-worker.js", import.meta.url), "utf8");
    expect([pkg.dependencies["libavoid-js"], installed.version, LIBAVOID_VERSION, worker.includes(`from "${LIBAVOID_PREFIX}libavoid.js"`)]).toEqual([LIBAVOID_VERSION, LIBAVOID_VERSION, "0.4.5", true]);
    // Another version, or another package, installed under the name: not served (the canvas keeps its lanes).
    expect([isPinnedLibavoid(installed), isPinnedLibavoid({ ...installed, version: "0.4.4" }), isPinnedLibavoid({ ...installed, name: "libavoid" }), isPinnedLibavoid(null)]).toEqual([true, false, false, false]);
  });
  it("the public link serves the worker and libavoid's two files, and nothing else under /ui/vendor/", () => {
    expect([isPublicWebRoute("GET", ROUTE_WORKER_PATH), ...LIBAVOID_PATHS.map((p) => isPublicWebRoute("GET", p)), isPublicWebRoute("GET", `${LIBAVOID_PREFIX}x.js`), isPublicWebRoute("POST", LIBAVOID_PATHS[0])])
      .toEqual([true, true, true, false, false]);
  });
});
