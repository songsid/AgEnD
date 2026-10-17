// #1918 phase 3: live cross-instance traffic on the org canvas (fleet-canvas.js) — what src/fleet-traffic.ts sends: the
// stream's `traffic` items, and GET /ui/traffic's snapshot when the tab opens (and on the public link, which has no
// stream, every POLL_MS while the page is shown — the user's decision 1). Ids are opaque; there is never any text.
//
// - The store keeps each message's latest state: queued (a dotted line), delivering (a dash and a pulse), delivered
//   (the line stays FADE_MS while it fades, then goes); consumed, failed, uncertain or cancelled ends it at once (a
//   failed or uncertain delivery is Needs you's to show, #1386). A finished message never comes back.
// - Edges are routed metro-style through the lanes the layout keeps empty (beside the columns and between card rows
//   inside a box; the bus above each row of teams; the trunk at the left), so a line never crosses a card.
// - Near: one edge per (from, to, kind, phase), ×N when several share it. Far (zoomed out): one edge per team pair.
//   A broadcast (one message per recipient, sharing an `op`) is a fan-out from its sender; more than BUNDLE_AT
//   recipients, or far, it is one edge per recipient team, ×N (the user's decision 3). At most MAX_EDGES are drawn.
import { OC } from "./fleet-canvas-layout.js";

export const FADE_MS = 3000;
export const POLL_MS = 5000;
export const MAX_EDGES = 60;
export const BUNDLE_AT = 8;
export const FAR_K = 0.55;
const MAX_ITEMS = 400, MAX_DONE = 2000;
const LIVE = new Set(["queued", "delivering"]);
const ENDS = new Set(["consumed", "failed", "uncertain", "cancelled"]);
const KINDS = new Set(["task", "report", "query", "update", "send", "broadcast"]);
const mono = () => (typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now());

/** A traffic item as the server sends it, checked; null for anything else. */
export function itemOk(x) {
  if (!x || typeof x !== "object") return null;
  const { id, from, to, kind, state, op } = x;
  if (typeof id !== "string" || !/^[0-9a-f]{16}$/.test(id) || typeof from !== "string" || !from || typeof to !== "string" || !to) return null;
  if (!KINDS.has(kind) || !(LIVE.has(state) || state === "delivered" || ENDS.has(state))) return null;
  return { id, from, to, kind, state, ...(typeof op === "string" && /^[0-9a-f]{16}$/.test(op) ? { op } : {}) };
}

/**
 * The page's traffic: `apply(item, nowMs)` one stream item, `load(snapshot, nowMs)` a snapshot, `sweep(nowMs)` drops
 * faded lines; each returns whether anything shown changed. `items()` what to draw: { …item, fading }.
 */
export function createTrafficStore() {
  const items = new Map();          // id → { item, fadeAt }
  const done = new Set();           // ids that ended: a late item for one is ignored
  const finish = (id) => {
    items.delete(id);
    done.add(id);
    if (done.size > MAX_DONE) done.delete(done.values().next().value);
  };
  const store = {
    apply(raw, now = mono()) {
      const it = itemOk(raw);
      if (!it || done.has(it.id)) return false;
      const prev = items.get(it.id);
      if (ENDS.has(it.state)) { const had = !!prev; finish(it.id); return had; }
      if (prev && prev.item.state === "delivered") return false;                 // delivered never goes back
      if (prev && prev.item.state === it.state) return false;
      items.delete(it.id);
      items.set(it.id, { item: it, fadeAt: it.state === "delivered" ? now + FADE_MS : null });
      while (items.size > MAX_ITEMS) items.delete(items.keys().next().value);
      return true;
    },
    /** A snapshot is the truth for what is in flight: anything live it no longer lists has ended (missed while away). */
    load(snap, now = mono()) {
      const list = snap && Array.isArray(snap.items) ? snap.items.map(itemOk).filter(Boolean) : [];
      const listed = new Set(list.map((i) => i.id));
      let changed = false;
      for (const [id, e] of items) if (!listed.has(id) && LIVE.has(e.item.state)) { finish(id); changed = true; }
      // Delivered, for a line drawn here: it fades now (with no stream, the snapshot is the only news of it). Any other
      // finished message is not drawn (it finished up to two minutes ago), and an ended one goes.
      for (const it of list) {
        if (LIVE.has(it.state) || (it.state === "delivered" && items.has(it.id))) changed = store.apply(it, now) || changed;
        else { const had = items.has(it.id); finish(it.id); changed = changed || had; }
      }
      return changed;
    },
    sweep(now = mono()) {
      let changed = false;
      for (const [id, e] of items) if (e.fadeAt !== null && now >= e.fadeAt) { finish(id); changed = true; }
      return changed;
    },
    items: () => [...items.values()].map((e) => ({ ...e.item, fading: e.fadeAt !== null })),
    fadingCount: () => [...items.values()].filter((e) => e.fadeAt !== null).length,
  };
  return store;
}

// ── Where a name is on the canvas ──

/** The team a name is drawn in (its first, if it is in two), null for General, undefined when it is not on the canvas. */
function teamOf(L, name) {
  if (L.tops.some((c) => c.node.name === name)) return null;
  const b = L.boxes.find((x) => x.nodes.some((n) => n.name === name));
  return b ? b : undefined;
}
/** An end of a line: General's card, a member's card, or its folded team's box. */
function endOf(L, name) {
  const top = L.tops.find((c) => c.node.name === name);
  if (top) return { kind: "top", c: top, key: top.key };
  const b = teamOf(L, name);
  if (!b) return null;
  if (b.folded) return { kind: "box", b, key: `box:${b.key}` };
  const i = b.cells.findIndex((c) => c.node.name === name);
  return { kind: "cell", b, i, c: b.cells[i], key: b.cells[i].key };
}

// ── Routing: lanes the layout keeps empty ──

const firstBusOf = (L) => Math.min(...L.boxes.map((b) => b.busY));
/** From an end up to its row's bus lane: the points, and the lane's y. `o` spreads lines sharing a lane. */
function outward(L, end, o) {
  if (end.kind === "top") {
    const x = end.c.x + end.c.w / 2 + Math.max(-end.c.w / 2 + 12, Math.min(end.c.w / 2 - 12, o * 2.4));
    const bus = firstBusOf(L) + o;
    return { pts: [{ x, y: end.c.y + end.c.h }, { x, y: bus }], bus };
  }
  const b = end.b;
  if (end.kind === "box") {
    const x = b.x + b.w / 2 + o * 1.5;
    return { pts: [{ x, y: b.y }, { x, y: b.busY + o }], bus: b.busY + o };
  }
  const { PAD, GAP, NW, NH } = OC;
  const card = end.c, col = end.i % b.cols, rowI = Math.floor(end.i / b.cols), lines = Math.ceil(b.cells.length / b.cols);
  const io = Math.max(-PAD / 2 + 3, Math.min(PAD / 2 - 3, o * 0.5));
  const leftLane = b.x + PAD / 2 + io, rightLane = b.x + b.w - PAD / 2 + io;
  let pts;
  if (col === 0 || col === b.cols - 1) {
    const left = col === 0, lane = left ? leftLane : rightLane, cy = card.y + NH / 2 + io;
    pts = [{ x: left ? card.x : card.x + NW, y: cy }, { x: lane, y: cy }, { x: lane, y: b.y }];
  } else {
    // A middle column: down into the gutter below its row, across to the nearer side lane.
    const gy = card.y + NH + (rowI === lines - 1 ? PAD : GAP) / 2 + io / 2, cx = card.x + NW / 2 + o;
    const lane = cx - b.x < b.w / 2 ? leftLane : rightLane;
    pts = [{ x: cx, y: card.y + NH }, { x: cx, y: gy }, { x: lane, y: gy }, { x: lane, y: b.y }];
  }
  const top = pts[pts.length - 1];
  pts.push({ x: top.x, y: b.busY + o });
  return { pts, bus: b.busY + o };
}
/** The points of a line from one end to the other: up to the bus, along it (and the trunk, between rows), down. */
export function route(L, a, z, o) {
  const p = outward(L, a, o), q = outward(L, z, o);
  const back = [...q.pts].reverse();
  if (Math.abs(p.bus - q.bus) < 1) return [...p.pts, ...back];
  const tx = OC.TRUNK - 12 - o;
  return [...p.pts, { x: tx, y: p.bus }, { x: tx, y: q.bus }, ...back];
}
/** An orthogonal polyline as SVG path data, its corners rounded. */
export function pathOf(pts, r = 8) {
  const q = pts.filter((pt, i) => !i || pt.x !== pts[i - 1].x || pt.y !== pts[i - 1].y);
  let d = `M${q[0].x} ${q[0].y}`;
  for (let i = 1; i < q.length - 1; i++) {
    const a = q[i - 1], b = q[i], c = q[i + 1];
    const r1 = Math.min(r, Math.hypot(b.x - a.x, b.y - a.y) / 2, Math.hypot(c.x - b.x, c.y - b.y) / 2);
    const u = { x: Math.sign(a.x - b.x), y: Math.sign(a.y - b.y) }, v = { x: Math.sign(c.x - b.x), y: Math.sign(c.y - b.y) };
    d += ` L${b.x + u.x * r1} ${b.y + u.y * r1} Q${b.x} ${b.y} ${b.x + v.x * r1} ${b.y + v.y * r1}`;
  }
  const last = q[q.length - 1];
  return `${d} L${last.x} ${last.y}`;
}
/** Where a line's ×N goes: the middle of its longest straight run. */
export function badgeAt(pts) {
  let best = pts[0], len = -1;
  for (let i = 1; i < pts.length; i++) {
    const l = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    if (l > len) { len = l; best = { x: (pts[i].x + pts[i - 1].x) / 2, y: (pts[i].y + pts[i - 1].y) / 2 }; }
  }
  return best;
}

// ── Edges ──

/** The colour family of a kind: task, report, broadcast, and the rest (send, query, update). */
export const hue = (kind) => (kind === "task" || kind === "report" || kind === "broadcast" ? kind : "send");
const phaseOf = (it) => (it.fading ? "fading" : it.state === "queued" ? "queued" : "live");
const RANK = { live: 0, queued: 1, fading: 2 };

/**
 * The lines to draw from the store's items on layout `L`. `far`: zoomed out (one line per team pair). Each edge:
 * { key, hue, phase, n, from, to, d, pts, badge } — `from`/`to` the instance (or team) names it joins, for search.
 */
export function trafficEdges(items, L, { far = false, max = MAX_EDGES } = {}) {
  if (!L.boxes.length && L.tops.length < 2) return [];
  const groups = new Map();
  const add = (key, g) => { const cur = groups.get(key); if (cur) { cur.n += g.n; cur.names.push(...g.names); } else groups.set(key, g); };
  const teamKey = (name) => { const t = teamOf(L, name); return t === null ? "\u0000general" : t ? t.key : undefined; };
  const teamEnd = (name) => { const t = teamOf(L, name); return t === null ? endOf(L, name) : t ? { kind: "box", b: t, key: `box:${t.key}` } : null; };
  // Broadcasts: one fan-out per op; big ones (or far) bundle per recipient team.
  const byOp = new Map();
  for (const it of items) if (it.kind === "broadcast" && it.op) { const l = byOp.get(it.op) || []; l.push(it); byOp.set(it.op, l); }
  const bundled = new Set();
  for (const list of byOp.values()) if (far || list.length > BUNDLE_AT) for (const it of list) bundled.add(it.id);
  for (const it of items) {
    const phase = phaseOf(it), names = [it.from, it.to];
    if (far || bundled.has(it.id)) {
      const ta = teamKey(it.from), tb = teamKey(it.to);
      if (ta === tb) continue;                                                     // inside one team: not drawn far away
      const k = far ? "team" : "broadcast";
      const a = far ? teamEnd(it.from) : endOf(L, it.from), z = teamEnd(it.to);
      if (!a || !z) continue;
      add(`${k}|${a.key}>${z.key}|${phase === "fading" ? "fading" : "live"}`, { a, z, hue: k === "team" ? "team" : "broadcast", phase: phase === "fading" ? "fading" : phase, n: 1, names });
      continue;
    }
    const a = endOf(L, it.from), z = endOf(L, it.to);
    if (!a || !z || a.key === z.key) continue;                                     // both in one folded team
    add(`${a.key}>${z.key}|${hue(it.kind)}|${phase}`, { a, z, hue: hue(it.kind), phase, n: 1, names });
  }
  const list = [...groups.entries()].sort((x, y) => RANK[x[1].phase] - RANK[y[1].phase]).slice(0, max);
  return list.map(([key, g], i) => {
    const o = ((i % 7) - 3) * 7;                                                    // neighbours 7 px apart (within the ±22 px bus lane)
    const pts = route(L, g.a, g.z, o);
    return { key, hue: g.hue, phase: g.phase, n: g.n, names: [...new Set(g.names)], d: pathOf(pts), pts, badge: g.n > 1 ? badgeAt(pts) : null };
  });
}

/** For the list: what each instance is sending now, in words ("task → quill"), live messages only. */
export function sendingBy(items) {
  const out = new Map();
  for (const it of items) {
    if (it.fading) continue;
    const l = out.get(it.from) || [];
    const key = `${it.kind}>${it.to}>${it.state}`;
    if (!l.some((x) => x.key === key)) l.push({ key, kind: it.kind, to: it.to, queued: it.state === "queued" });
    out.set(it.from, l);
  }
  return out;
}
