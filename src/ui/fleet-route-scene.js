// #2182: the org canvas's traffic lines routed around the canvas, not along fixed lanes. libavoid (Adaptagrams, through
// libavoid-js 0.4.5, LGPL-2.1-or-later, an npm dependency served unmodified from /ui/vendor/) routes each line between
// fixed obstacles; this module says what the obstacles are (pure: the worker, the page and the tests share it).
//
// - Obstacles: every card (General's and the members'), a folded team's box, each open box's header band (its name and
//   count are drawn over the lines) and its border as wall pieces in front of its cards. The gaps between the pieces —
//   the box's padding and the gutters between its rows and columns (L.pad, L.gap: wide enough for a few lines each)
//   — are the only doors, so a line crosses a border at right angles, through a door, and never runs along it.
// - Ends: pins on each card's sides (several on the long sides, one on the short), facing out; a line ends on a card,
//   never on a box. A card with more lines than pins shares them.
// - Separation: libavoid nudges lines that share a run ROUTE.NUDGE apart; the same two ends and kind are one line (×N)
//   before they get here (fleet-traffic.js).
// A route that comes back otherwise (not orthogonal, not ending on its two shapes) is not drawn: that line keeps the
// lane route (fleet-traffic.js route()).
import { OC } from "./fleet-canvas-layout.js";

/** Buffer around every obstacle, the distance nudging keeps between lines, the cost of a bend, pins on a long side. */
export const ROUTE = { BUF: 5, NUDGE: 8, SEG: 60, PINS: 4, MAX_POINTS: 64, MAX_SHAPES: 600, MAX_CONNS: 120 };
/** libavoid's ConnDirFlags: the way a line leaves a pin. */
const UP = 1, DOWN = 2, LEFT = 4, RIGHT = 8;
const PINS_PER_CARD = ROUTE.PINS * 2 + 2;

/** The shape a line's end is on: a card (General's or a member's) or a folded team's box. Null: not routed here. */
function endShape(end) {
  if (!end) return null;
  if (end.kind === "top" || end.kind === "cell") return { key: end.key, x: end.c.x, y: end.c.y, w: end.c.w, h: end.c.h };
  if (end.kind === "box" && end.b.folded) return { key: end.key, x: end.b.x, y: end.b.y, w: end.b.w, h: end.b.h };
  return null;
}

/**
 * The scene for layout `L` and the lines `lines` ([{ key, a, z }], a and z ends as fleet-traffic.js endOf gives them):
 * { shapes: [{ x, y, w, h, pins: 0 | 1 | 2 }], conns: [{ key, a, z }] } — `pins` 0 none, 1 exclusive (a line each),
 * 2 shared; `a`/`z` index shapes. A line whose end is not a card or a folded box is left out (it keeps its lane).
 */
export function routeScene(L, lines) {
  const shapes = [], at = new Map();
  const add = (s, pins) => { shapes.push({ x: s.x, y: s.y, w: s.w, h: s.h, pins }); return shapes.length - 1; };
  for (const c of L.tops) at.set(c.key, add(c, 1));
  const { NW, NH, HEAD } = OC, PAD = L.pad ?? OC.PAD, GAP = L.gap ?? OC.GAP;
  for (const b of L.boxes) {
    if (b.folded) { at.set(`box:${b.key}`, add(b, 1)); continue; }
    if (!b.cells.length) { add(b, 0); continue; }
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
  for (const [i, n] of demand) if (n > PINS_PER_CARD) shapes[i].pins = 2;
  return { shapes, conns };
}

/** A scene from anywhere else (the worker's message): only numbers in range, only indexes it has. Null: refused. */
export function sceneOk(s) {
  if (!s || !Array.isArray(s.shapes) || !Array.isArray(s.conns) || s.shapes.length > ROUTE.MAX_SHAPES || s.conns.length > ROUTE.MAX_CONNS) return null;
  const num = (v) => typeof v === "number" && Number.isFinite(v) && Math.abs(v) < 1e6;
  for (const sh of s.shapes) if (!sh || ![sh.x, sh.y, sh.w, sh.h].every(num) || sh.w <= 0 || sh.h <= 0 || ![0, 1, 2].includes(sh.pins)) return null;
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
    // The router owns its shapes, pins and connectors (A.destroy(r) frees them); the points, rectangles and ends it
    // copies are freed here, or the wasm heap grows with every route.
    const temp = (o) => { made.push(o); return o; }, made = [];
    const refs = scene.shapes.map((s) => {
      const ref = new A.ShapeRef(r, temp(new A.Rectangle(temp(new A.Point(s.x, s.y)), temp(new A.Point(s.x + s.w, s.y + s.h)))));
      if (s.pins) {
        const pin = (x, y, dir) => new A.ShapeConnectionPin(ref, 1, x, y, true, 0, dir).setExclusive(s.pins === 1);
        for (let i = 1; i <= ROUTE.PINS; i++) { pin(i / (ROUTE.PINS + 1), 0, UP); pin(i / (ROUTE.PINS + 1), 1, DOWN); }
        pin(0, 0.5, LEFT); pin(1, 0.5, RIGHT);
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
    return out;
  } finally {
    A.destroy(r);
  }
}
