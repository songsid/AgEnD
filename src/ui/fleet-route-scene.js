// #2182: the org canvas's traffic lines routed around the canvas, not along fixed lanes. libavoid (Adaptagrams, through
// libavoid-js 0.4.5, LGPL-2.1-or-later, an npm dependency served unmodified from /ui/vendor/) routes each line between
// fixed obstacles; this module says what the obstacles are (pure: the worker, the page and the tests share it).
//
// - Obstacles: every card (General's and the members'), a folded team's box, each open box's header band (its name and
//   count are drawn over the lines) and its border as wall pieces in front of its cards. The gaps between the pieces —
//   the box's padding and the gutters between its rows and columns (L.pad, L.gap: wide enough for a few lines each)
//   — are the only doors, so a line crosses a border at right angles, through a door, and never runs along it.
// - Ends: pins on each card's sides (several on the long sides, one on the short), facing out; a line ends on a card,
//   never on a box. A card with more lines than pins gets more, so two lines never start at one point. A short side
//   facing a neighbour across less than ROUTE.SIDE (a column gutter, a phone's box padding) has no pin (#2329): a line
//   into it would turn in that narrow gap with no room left for its arrowhead. libavoid turns a line into its pin right
//   at the card's buffer, which leaves a head no straight run: lengthen() moves that turn out where there is room.
// - Separation: libavoid nudges lines that share a run ROUTE.NUDGE apart; the same two ends and kind are one line (×N)
//   before they get here (fleet-traffic.js).
// A route that comes back otherwise (not orthogonal, not ending on its two shapes) is not drawn: that line keeps the
// lane route (fleet-traffic.js route()).
import { OC } from "./fleet-canvas-layout.js";

/** Buffer around every obstacle, the distance nudging keeps between lines, the cost of a bend, pins on a long side. */
export const ROUTE = { BUF: 5, NUDGE: 8, SEG: 60, PINS: 4, MAX_PINS: 64, MAX_POINTS: 64, MAX_SHAPES: 600, MAX_CONNS: 120, SIDE: 30, RUN: 16 };
/** libavoid's ConnDirFlags: the way a line leaves a pin. */
const UP = 1, DOWN = 2, LEFT = 4, RIGHT = 8;
/** A shape's `sides`: which short sides have a pin (absent: both). */
const SIDE_L = 1, SIDE_R = 2;
const sidesOf = (sh) => sh.sides ?? SIDE_L | SIDE_R;
const pinsOn = (sh) => ROUTE.PINS * 2 + ((sidesOf(sh) & SIDE_L) ? 1 : 0) + ((sidesOf(sh) & SIDE_R) ? 1 : 0);

/** The shape a line's end is on: a card (General's or a member's) or a folded team's box. Null: not routed here. */
function endShape(end) {
  if (!end) return null;
  if (end.kind === "top" || end.kind === "cell") return { key: end.key, x: end.c.x, y: end.c.y, w: end.c.w, h: end.c.h };
  if (end.kind === "box" && end.b.folded) return { key: end.key, x: end.b.x, y: end.b.y, w: end.b.w, h: end.b.h };
  return null;
}

/**
 * The scene for layout `L` and the lines `lines` ([{ key, a, z }], a and z ends as fleet-traffic.js endOf gives them):
 * { shapes: [{ x, y, w, h, pins, sides? }], conns: [{ key, a, z }], boxes: [{ x, y, w, h }] } — `pins` 0 none (an
 * obstacle only), 1 the usual pins, more: that many on each long side (a busy card); `sides` the short sides with a pin
 * (1 left, 2 right; absent: both); every pin takes one line; `a`/`z` index
 * shapes; `boxes` the open teams' outlines (separate() keeps lines off them). A line whose end is not a card or a folded box is left out (it keeps its lane).
 */
export function routeScene(L, lines) {
  const shapes = [], boxes = [], at = new Map();
  const add = (s, pins) => { shapes.push({ x: s.x, y: s.y, w: s.w, h: s.h, pins }); return shapes.length - 1; };
  for (const c of L.tops) at.set(c.key, add(c, 1));
  const { NW, NH, HEAD } = OC, PAD = L.pad ?? OC.PAD, GAP = L.gap ?? OC.GAP;
  for (const b of L.boxes) {
    if (b.folded) { at.set(`box:${b.key}`, add(b, 1)); continue; }
    if (!b.cells.length) { add(b, 0); continue; }
    boxes.push({ x: b.x, y: b.y, w: b.w, h: b.h });
    for (const c of b.cells) at.set(c.key, add(c, 1));
    add({ x: b.x - 1, y: b.y - 1, w: b.w + 2, h: HEAD + 1 }, 0);
    const lines = Math.ceil(b.cells.length / b.cols);
    for (let col = 0; col < b.cols; col++) add({ x: b.x + PAD + col * (NW + GAP), y: b.y + b.h - 1, w: NW, h: 2 }, 0);
    for (const x of [b.x - 1, b.x + b.w - 1]) for (let row = 0; row < lines; row++) add({ x, y: b.y + HEAD + PAD + row * (NH + GAP), w: 2, h: NH }, 0);
  }
  const conns = [], demand = new Map();
  for (const ln of lines) {
    const a = endShape(ln.a), z = endShape(ln.z);
    if (!a || !z || !at.has(a.key) || !at.has(z.key) || a.key === z.key) continue;
    const ia = at.get(a.key), iz = at.get(z.key);
    conns.push({ key: ln.key, a: ia, z: iz });
    for (const i of [ia, iz]) demand.set(i, (demand.get(i) || 0) + 1);
  }
  // A short side with a pin only where a line has room to turn into it with its head: ROUTE.SIDE to the nearest shape
  // beside it (a neighbour card, a box's wall piece).
  for (const sh of shapes) {
    if (!sh.pins) continue;
    let left = Infinity, right = Infinity;
    for (const o of shapes) {
      if (o === sh || o.y >= sh.y + sh.h || o.y + o.h <= sh.y) continue;
      if (o.x + o.w <= sh.x) left = Math.min(left, sh.x - o.x - o.w);
      if (o.x >= sh.x + sh.w) right = Math.min(right, o.x - sh.x - sh.w);
    }
    const sides = (left >= ROUTE.SIDE ? SIDE_L : 0) | (right >= ROUTE.SIDE ? SIDE_R : 0);
    if (sides !== (SIDE_L | SIDE_R)) sh.sides = sides;
  }
  // A line each: a shape with more lines than pins gets more pins on its long sides (two lines never leave one point:
  // libavoid cannot nudge apart runs that start at the same point).
  for (const [i, n] of demand) if (n > pinsOn(shapes[i])) shapes[i].pins = Math.min(ROUTE.MAX_PINS, Math.ceil((n - (pinsOn(shapes[i]) - ROUTE.PINS * 2)) / 2));
  return { shapes, conns, boxes };
}

/** A scene from anywhere else (the worker's message): only numbers in range, only indexes it has. Null: refused. */
export function sceneOk(s) {
  if (!s || !Array.isArray(s.shapes) || !Array.isArray(s.conns) || !Array.isArray(s.boxes) || s.shapes.length > ROUTE.MAX_SHAPES || s.conns.length > ROUTE.MAX_CONNS
    || s.boxes.length > ROUTE.MAX_SHAPES) return null;
  const num = (v) => typeof v === "number" && Number.isFinite(v) && Math.abs(v) < 1e6;
  for (const b of s.boxes) if (!b || ![b.x, b.y, b.w, b.h].every(num) || b.w <= 0 || b.h <= 0) return null;
  for (const sh of s.shapes) if (!sh || ![sh.x, sh.y, sh.w, sh.h].every(num) || sh.w <= 0 || sh.h <= 0 || !Number.isInteger(sh.pins) || sh.pins < 0 || sh.pins > ROUTE.MAX_PINS
    || (sh.sides !== undefined && (!Number.isInteger(sh.sides) || sh.sides < 0 || sh.sides > (SIDE_L | SIDE_R)))) return null;
  for (const c of s.conns) {
    if (!c || typeof c.key !== "string" || c.key.length > 2048) return null;
    for (const i of [c.a, c.z]) if (!Number.isInteger(i) || i < 0 || i >= s.shapes.length || !s.shapes[i].pins) return null;
  }
  return s;
}

const onEdge = (p, s) => (Math.abs(p.x - s.x) < 0.5 || Math.abs(p.x - s.x - s.w) < 0.5) && p.y >= s.y - 0.5 && p.y <= s.y + s.h + 0.5
  || (Math.abs(p.y - s.y) < 0.5 || Math.abs(p.y - s.y - s.h) < 0.5) && p.x >= s.x - 0.5 && p.x <= s.x + s.w + 0.5;
/**
 * A route for connection `c` of `scene`, or null: at most MAX_POINTS finite points, every segment horizontal or
 * vertical, starting on its first shape's edge and ending on its second's.
 */
export function routeOk(pts, scene, c) {
  if (!Array.isArray(pts) || pts.length < 2 || pts.length > ROUTE.MAX_POINTS) return null;
  for (const p of pts) if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
  for (let i = 1; i < pts.length; i++) if (pts[i].x !== pts[i - 1].x && pts[i].y !== pts[i - 1].y) return null;
  if (!onEdge(pts[0], scene.shapes[c.a]) || !onEdge(pts[pts.length - 1], scene.shapes[c.z])) return null;
  return pts.map((p) => ({ x: p.x, y: p.y }));
}

/** The worker's answer to a route request `m`: its scene checked (sceneOk) before libavoid sees any of it. */
export function answerRoute(A, m) {
  const scene = sceneOk(m && m.scene);
  return { type: "routes", id: m.id, routes: scene ? [...routeWith(A, scene)] : null };
}

/** What separate() and lengthen() share, on `scene` and the routes' points `pts` (which they move in place). */
function mover(scene, pts) {
  const B = ROUTE.BUF - 0.5, OVER = 8;
  const segsOf = (r, p) => p.slice(1).map((q, i) => ({ r, i, h: p[i].y === q.y }));
  const coord = (p, s) => (s.h ? p[s.i].y : p[s.i].x);
  const span = (p, s) => (s.h ? [Math.min(p[s.i].x, p[s.i + 1].x), Math.max(p[s.i].x, p[s.i + 1].x)] : [Math.min(p[s.i].y, p[s.i + 1].y), Math.max(p[s.i].y, p[s.i + 1].y)]);
  /**
   * A segment from a to b clear of every shape's buffer (but `own`, the card a line's first or last run starts on at its
   * pin), and not along a box's border (through a door, say).
   */
  const clear = (a, b, own = -1) => {
    const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x), y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y), h = y0 === y1;
    return scene.shapes.every((sh, k) => k === own || x1 <= sh.x - B || x0 >= sh.x + sh.w + B || y1 <= sh.y - B || y0 >= sh.y + sh.h + B)
      && (scene.boxes ?? []).every((bx) => (h ? [bx.y, bx.y + bx.h].every((v) => Math.abs(v - y0) >= SEPARATE + 1) || Math.min(x1, bx.x + bx.w) - Math.max(x0, bx.x) <= 12
        : [bx.x, bx.x + bx.w].every((v) => Math.abs(v - x0) >= SEPARATE + 1) || Math.min(y1, bx.y + bx.h) - Math.max(y0, bx.y) <= 12));
  };
  const connOf = new Map(scene.conns.map((c) => [c.key, c]));
  /** The segments of other lines (and this one's) parallel to segment s of line r, overlapping it, closer than SEPARATE. */
  const near = (r, s, c, lo, hi) => {
    const out = [];
    pts.forEach((p, r2) => segsOf(r2, p).forEach((t) => {
      if (t.h !== s.h || (r2 === r && t.i === s.i)) return;
      const [l2, h2] = span(p, t);
      if (Math.min(hi, h2) - Math.max(lo, l2) > OVER) out.push(coord(p, t));
    }));
    return out.filter((c2) => Math.abs(c2 - c) < SEPARATE - 1e-6);              // libavoid's points carry float noise
  };
  return { segsOf, coord, span, clear, near, connOf };
}

/**
 * libavoid nudges lines that share a run apart, but not always: in a channel shared by many lines it packs them closer
 * than ROUTE.NUDGE, and lines fanning out of one card can come back on the very same run. This pass moves the middle
 * segments of such lines (never a line's first or last, which end on a pin) sideways to the nearest place at least
 * SEPARATE from every parallel line along them — only where the moved segment and the two it joins stay clear of
 * every shape's buffer and keep their direction. What cannot move stays as libavoid left it.
 */
export const SEPARATE = 6;
export function separate(routes, scene) {
  const keys = [...routes.keys()];
  const pts = keys.map((k) => routes.get(k).map((p) => ({ x: p.x, y: p.y })));
  const { segsOf, coord, span, clear, near, connOf } = mover(scene, pts);
  for (let pass = 0; pass < 8; pass++) {
    let moved = false;
    pts.forEach((p, r) => segsOf(r, p).forEach((s) => {
      if (s.i === 0 || s.i + 1 >= p.length - 1) return;                 // a first or last segment ends on a pin
      const c = coord(p, s), [lo, hi] = span(p, s);
      const close = near(r, s, c, lo, hi);
      if (!close.length) return;
      // Try the nearest places SEPARATE from the lines it is close to, both ways.
      const tries = [...new Set(close.flatMap((c2) => [1, 2, 3, 4, 5, 6].flatMap((m) => [c2 + m * SEPARATE, c2 - m * SEPARATE])))].sort((u, v) => Math.abs(u - c) - Math.abs(v - c));
      for (const c2 of tries) {
        const a = { ...p[s.i] }, b = { ...p[s.i + 1] };
        if (s.h) { a.y = c2; b.y = c2; } else { a.x = c2; b.x = c2; }
        const prev = p[s.i - 1], next = p[s.i + 2];
        // The joining segments keep their direction (never shrink through zero).
        const dir = (u, v) => Math.sign(s.h ? v.y - u.y : v.x - u.x);
        if (dir(prev, a) !== dir(prev, p[s.i]) || dir(b, next) !== dir(p[s.i + 1], next) || dir(prev, a) === 0 || dir(b, next) === 0) continue;
        const c0 = connOf.get(keys[r]);
        if (!clear(a, b) || !clear(prev, a, s.i - 1 === 0 && c0 ? c0.a : -1) || !clear(b, next, s.i + 2 === p.length - 1 && c0 ? c0.z : -1)) continue;
        const old = [p[s.i], p[s.i + 1]];
        p[s.i] = a; p[s.i + 1] = b;
        const ok = !near(r, s, c2, lo, hi).length && [s.i - 1, s.i + 1].every((j) => { const t = { r, i: j, h: !s.h }; const [l3, h3] = span(p, t); return !near(r, t, coord(p, t), l3, h3).length; });
        if (ok) { moved = true; break; }
        [p[s.i], p[s.i + 1]] = old;
      }
    }));
    if (!moved) break;
  }
  return new Map(keys.map((k, i) => [k, pts[i]]));
}

/**
 * #2329: room for each line's arrowhead. libavoid turns a line into its last pin right at the card's buffer, so the
 * last run (where the head goes) is a few px long. This pass moves the turn before it out from the card until the last
 * run is ROUTE.RUN long (or up to 3 × SEPARATE more; where none fits, the longest that does): only where the moved segment and the two it joins stay clear of
 * every shape's buffer, at least SEPARATE from every parallel line, and the run before the turn keeps its direction and
 * 4 px. A line whose turn cannot move keeps its short run (fleet-traffic.js draws it with no head).
 */
export function lengthen(routes, scene) {
  const keys = [...routes.keys()];
  const pts = keys.map((k) => routes.get(k).map((p) => ({ x: p.x, y: p.y })));
  const { coord, span, clear, near, connOf } = mover(scene, pts);
  pts.forEach((p, r) => {
    const n = p.length;
    if (n < 4) return;                                                  // the turn's other end is the first pin
    const z = p[n - 1], y = p[n - 2], x = p[n - 3], w = p[n - 4], h = y.y === z.y;
    const at = (q) => (h ? q.x : q.y);
    const u = Math.sign(at(y) - at(z));                                 // out from the card
    if (!u || Math.abs(at(y) - at(z)) >= ROUTE.RUN) return;
    const c0 = connOf.get(keys[r]);
    const run = Math.abs(at(y) - at(z)), tries = [];
    for (let t = ROUTE.RUN; t <= ROUTE.RUN + 3 * SEPARATE; t++) tries.push(t);
    for (let t = ROUTE.RUN - 1; t > run; t--) tries.push(t);           // short of RUN (a phone's gutter): the longest that fits
    for (const t of tries) {
      const c2 = at(z) + u * t;
      const a = h ? { x: c2, y: x.y } : { x: x.x, y: c2 }, b = h ? { x: c2, y: y.y } : { x: y.x, y: c2 };
      if (Math.sign(at(a) - at(w)) !== Math.sign(at(x) - at(w)) || Math.abs(at(a) - at(w)) < 4) continue;
      if (!clear(a, b) || !clear(w, a, n - 4 === 0 && c0 ? c0.a : -1) || !clear(b, z, c0 ? c0.z : -1)) continue;
      const old = [p[n - 3], p[n - 2]];
      p[n - 3] = a; p[n - 2] = b;
      const ok = [n - 4, n - 3, n - 2].every((i) => { const s = { r, i, h: i === n - 3 ? !h : h }; const [lo, hi] = span(p, s); return !near(r, s, coord(p, s), lo, hi).length; });
      if (ok) return;
      [p[n - 3], p[n - 2]] = old;
    }
  });
  return new Map(keys.map((k, i) => [k, pts[i]]));
}

/**
 * Route `scene` with libavoid instance `A` (libavoid-js 0.4.5's: its constants are numbers on `A`). A Map of
 * connection key → points, for the routes that pass routeOk only.
 */
export function routeWith(A, scene) {
  const r = new A.Router(A.OrthogonalRouting);
  try {
    r.setRoutingParameter(A.shapeBufferDistance, ROUTE.BUF);
    r.setRoutingParameter(A.idealNudgingDistance, ROUTE.NUDGE);
    r.setRoutingParameter(A.segmentPenalty, ROUTE.SEG);
    r.setRoutingOption(A.nudgeOrthogonalSegmentsConnectedToShapes, true);
    r.setRoutingOption(A.nudgeSharedPathsWithCommonEndPoint, true);
    for (const [k, v] of Object.entries(ROUTE.EXTRA_OPT ?? {})) r.setRoutingOption(A[k], v);
    for (const [k, v] of Object.entries(ROUTE.EXTRA_PARAM ?? {})) r.setRoutingParameter(A[k], v);
    // The router owns its shapes, pins and connectors (A.destroy(r) frees them); the points, rectangles and ends it
    // copies are freed here, or the wasm heap grows with every route.
    const temp = (o) => { made.push(o); return o; }, made = [];
    const refs = scene.shapes.map((s) => {
      const ref = new A.ShapeRef(r, temp(new A.Rectangle(temp(new A.Point(s.x, s.y)), temp(new A.Point(s.x + s.w, s.y + s.h)))));
      if (s.pins) {
        const k = s.pins === 1 ? ROUTE.PINS : s.pins;
        const pin = (x, y, dir) => new A.ShapeConnectionPin(ref, 1, x, y, true, 0, dir).setExclusive(true);
        for (let i = 1; i <= k; i++) { pin(i / (k + 1), 0, UP); pin(i / (k + 1), 1, DOWN); }
        if (sidesOf(s) & SIDE_L) pin(0, 0.5, LEFT);
        if (sidesOf(s) & SIDE_R) pin(1, 0.5, RIGHT);
      }
      return ref;
    });
    const conns = scene.conns.map((c) => new A.ConnRef(r, temp(new A.ConnEnd(refs[c.a], 1)), temp(new A.ConnEnd(refs[c.z], 1))));
    for (const o of made.splice(0)) A.destroy(o);
    r.processTransaction();
    const out = new Map();
    scene.conns.forEach((c, i) => {
      const line = conns[i].displayRoute(), pts = [];
      for (let k = 0; k < line.size() && k <= ROUTE.MAX_POINTS; k++) { const p = line.get_ps(k); pts.push({ x: p.x, y: p.y }); }
      const ok = routeOk(pts, scene, c);
      if (ok) out.set(c.key, ok);
    });
    return ROUTE.SEPARATE === false ? out : lengthen(separate(out, scene), scene);
  } finally {
    A.destroy(r);
  }
}
