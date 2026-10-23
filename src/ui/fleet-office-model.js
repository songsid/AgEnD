// Fleet → Org chart → Office: the fleet as a small pixel office (fleet-office.js draws it, fleet-office-skin.js holds the
// art). This module is the pure part — no DOM, no drawing — so the layout, the poses, the filter, the walking paths and
// the traffic items' lifecycle are tested on their own.
//
// - The model: `offices: Office[]`, each { id, name, skin, members, layout?: { seats, waypoints, edges } }. v1 has one
//   office the page makes itself (AUTO_ID, "the whole fleet", built from the teams as the canvas is), whose member
//   filter is the team / people picker; any other office is the host's (GET /ui/offices, fleet-office-store.js),
//   checked again here.
//   The office editor (fleet-office-editor.js) adds, renames and deletes offices and picks who is in them; the layout
//   editor (fleet-office-layout.js, #2513) moves things on a zones skin and keeps them as the office's `overrides`
//   (fleet-office-pack.js) — both write the same model through the store's saveOffices().
// - The auto layout: a lobby (General and the instances in no team), then a room per team in fleet.yaml's order, in a
//   grid that wraps at the stage's width (a phone gets narrower rooms); a desk per member; a corridor graph of waypoints
//   (each desk's aisle, a spine down each room's left padding, its door, a corridor under each row of rooms and one down
//   the left margin) that traffic walks along (bfsPath).
// - Poses come from the org chart's states (fleet-org.js ORG_STATES / orgState); nothing here invents a status.
import { hue } from "./fleet-traffic.js";
import { checkLayoutOverrides } from "./fleet-office-pack.js";

// ── Poses: the org chart's states, as a character at a desk ──

/** The poses a skin draws (a frame strip each, fleet-office-skin.js); "away" (not in the fleet) is an empty desk. */
export const POSES = ["working", "idle", "paused", "needs", "walk"];
/**
 * fleet-org.js ORG_STATES → pose. Needs you, crashed and looks stuck call for the person (a light over the head);
 * starting sits at the desk, queued (waiting its turn to start, #2398) dozes without the closed sign.
 */
export const POSE_OF = { needs: "needs", crashed: "needs", stuck: "needs", starting: "idle", queued: "paused", working: "working", idle: "idle", paused: "paused", stopped: "paused", missing: "away" };
export const officePose = (state) => POSE_OF[state] || "idle";
/** The call light's tone: the state colours the canvas's dots use (crashed is danger; needs you and stuck are warn). */
export const lightOf = (state) => (state === "crashed" ? "danger" : state === "needs" || state === "stuck" ? "warn" : null);
/** A closed sign on the desk of an instance that is paused or stopped; the lamp is on while it works. */
export const signOf = (state) => (state === "paused" || state === "stopped" ? "closed" : null);
export const lampOf = (state) => state === "working";

/** A small stable number from a name (FNV-1a): the same instance always gets the same hair, line, turn. */
export const nameHash = (s) => { let h = 2166136261; for (const ch of String(s)) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619); } return h >>> 0; };
/** The frame of a looping strip at time `ms` (0 when still: the reduced-motion pose). */
export const frameAt = (ms, frames, fps) => (frames > 1 && ms > 0 ? Math.floor((ms / 1000) * fps) % frames : 0);

// ── Coats: the instance's identity colour when someone chose one, else its backend's ──

export const COATS = { "claude-code": "#d97757", codex: "#4b8bf4", "kiro-cli": "#9b6bff", grok: "#6b7280", other: "#3fa58c" };
/** `id`: identity-color.js identityOf(it); the automatic colour is everyone's, so the backend's says more. */
export function coatOf(it, id, mode = "dark") {
  if (id && !id.off && id.source && id.source !== "auto") return (mode === "light" ? id.light : id.dark) || COATS.other;
  return COATS[it && it.backend] || COATS.other;
}

// ── Who is shown: the auto office's member filter (a team, or the lobby; and/or pinned people) ──

export const AUTO_ID = "auto";
export const LOBBY = "\u0000lobby";
const MAX_NAMES = 500;
const nameList = (a) => (Array.isArray(a) ? [...new Set(a.filter((s) => typeof s === "string" && s && s.length <= 200))].slice(0, MAX_NAMES) : []);
/** The filter as stored, checked: { team: "" (all) | LOBBY | a team's name, pinned: instance names }. */
export function filterOk(x) {
  const f = x && typeof x === "object" ? x : {};
  return { team: typeof f.team === "string" && f.team.length <= 200 ? f.team : "", pinned: nameList(f.pinned) };
}

/**
 * The rooms of the auto office, from buildOrgView's answer: the lobby (General, then the instances in no team), then
 * each team. `filter`: a team keeps that room only (a team no longer defined: all of them); pinned people keep only
 * them, in whichever rooms they are (a room left with nobody goes). An empty team stays an empty room; an empty lobby goes.
 */
export function officeRooms(view, filter) {
  const lobby = { key: LOBBY, name: null, lobby: true, nodes: [...view.top, ...view.rest.nodes] };
  const all = [lobby, ...view.teams.map((tm) => ({ key: tm.name, name: tm.name, lobby: false, nodes: tm.nodes }))];
  const f = filterOk(filter);
  const picked = f.team && all.some((r) => r.key === f.team) ? all.filter((r) => r.key === f.team) : all;
  if (!f.pinned.length) return picked.filter((r) => r.nodes.length || !r.lobby);
  const pinned = new Set(f.pinned);
  return picked.map((r) => ({ ...r, nodes: r.nodes.filter((n) => pinned.has(n.name)) })).filter((r) => r.nodes.length);
}

/** A stored office's members: instance names, or `team:<name>` for a team's; none means everyone. */
export function membersOf(office, view) {
  const every = [...view.top, ...view.teams.flatMap((tm) => tm.nodes), ...view.rest.nodes];
  const byName = new Map(every.map((n) => [n.name, n]));
  if (!office.members.length) return [...byName.values()];
  const out = new Map();
  for (const m of office.members) {
    const team = m.startsWith("team:") ? view.teams.find((tm) => tm.name === m.slice(5)) : null;
    for (const n of team ? team.nodes : byName.has(m) ? [byName.get(m)] : []) if (!out.has(n.name)) out.set(n.name, n);
  }
  return [...out.values()];
}

// ── The model, as stored: checked defensively (it is a browser's localStorage today, a server's later) ──

const ID = /^[A-Za-z0-9_-]{1,40}$/;
const MAX_OFFICES = 20, MAX_SEATS = 500, MAX_WAYPOINTS = 2000, MAX_EDGES = 8000, MAX_COORD = 20000;
const coordOk = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= MAX_COORD;
const pointsOk = (list, max, extra) => {
  const out = [], ids = new Set();
  for (const p of Array.isArray(list) ? list.slice(0, max) : []) {
    if (!p || typeof p !== "object" || typeof p.id !== "string" || !p.id || p.id.length > 64 || ids.has(p.id) || !coordOk(p.x) || !coordOk(p.y)) continue;
    ids.add(p.id);
    out.push({ id: p.id, x: p.x, y: p.y, ...extra(p) });
  }
  return out;
};
/** A layout: seats (optionally assigned to an instance), waypoints, and edges between known waypoints; null if none. */
export function layoutOk(x) {
  if (!x || typeof x !== "object") return null;
  const seats = pointsOk(x.seats, MAX_SEATS, (p) => (typeof p.instance === "string" && p.instance && p.instance.length <= 200 ? { instance: p.instance } : {}));
  if (!seats.length) return null;
  const waypoints = pointsOk(x.waypoints, MAX_WAYPOINTS, () => ({}));
  const known = new Set(waypoints.map((w) => w.id));
  const edges = (Array.isArray(x.edges) ? x.edges.slice(0, MAX_EDGES) : [])
    .filter((e) => Array.isArray(e) && e.length === 2 && known.has(e[0]) && known.has(e[1]) && e[0] !== e[1]).map((e) => [e[0], e[1]]);
  return { seats, waypoints, edges };
}
/** One office, checked; null for anything that is not one (the auto office's id is the page's own). */
export function officeOk(x) {
  if (!x || typeof x !== "object" || typeof x.id !== "string" || !ID.test(x.id) || x.id === AUTO_ID) return null;
  const name = typeof x.name === "string" && x.name.trim() ? x.name.trim().slice(0, 60) : x.id;
  const skin = typeof x.skin === "string" && ID.test(x.skin) ? x.skin : "pixel";
  const ov = x.overrides === undefined ? null : checkLayoutOverrides(x.overrides);
  return { id: x.id, name, skin, members: nameList(x.members), layout: layoutOk(x.layout), ...(ov && ov.ok ? { overrides: ov.overrides } : {}) };
}
/** A stored list of offices: the valid ones, ids unique, at most MAX_OFFICES. */
export function officesOk(list) {
  const out = [], ids = new Set();
  for (const x of Array.isArray(list) ? list : []) {
    const o = officeOk(x);
    if (!o || ids.has(o.id)) continue;
    ids.add(o.id);
    out.push(o);
    if (out.length >= MAX_OFFICES) break;
  }
  return out;
}

// ── Layout ──

/**
 * Sizes in CSS px. A desk cell DW×DH (the character, the desk, the name tag, and its aisle at the bottom); a room's
 * padding PAD and header HEAD; GAP between rooms (the corridor runs in it); M the stage's margin. SEAT_Y: where the
 * character sits in its cell; AISLE: the aisle's distance from the cell's bottom.
 */
export const OF = { DW: 96, DH: 104, PAD: 12, HEAD: 26, GAP: 24, M: 12, SEAT_Y: 40, AISLE: 6, EMPTY_H: 64, MAX_COLS: 6 };
const colsFor = (n) => (n <= 3 ? Math.max(1, n) : n <= 4 ? 2 : n <= 9 ? 3 : n <= 16 ? 4 : n <= 30 ? 5 : 6);

/**
 * The auto office: `rooms` (officeRooms) packed into rows at `width` CSS px. Each room { key, name, lobby, x, y, w, h,
 * desks }; each desk { key, node, x, y, w, h, seat: { x, y }, wp } (wp: the aisle waypoint in front of it). And the
 * corridor graph: `waypoints` [{ id, x, y }], `edges` [[a, b]]. The same rooms and width always give the same picture.
 */
export function autoLayout(rooms, { width = 960 } = {}) {
  const { DW, DH, PAD, HEAD, GAP, M } = OF;
  const maxCols = Math.max(1, Math.min(OF.MAX_COLS, Math.floor((width - 2 * M - 2 * PAD) / DW)));
  const out = [], waypoints = [], edges = [];
  const wp = (id, x, y) => { waypoints.push({ id, x, y }); return id; };
  let x = M, y = M, rowH = 0, row = 0;
  const rows = [[]];
  rooms.forEach((r, ri) => {
    const n = r.nodes.length, cols = Math.min(colsFor(n), maxCols), lines = Math.ceil(n / cols);
    const w = 2 * PAD + cols * DW, h = n ? HEAD + PAD + lines * DH : OF.EMPTY_H;
    if (rows[row].length && x + w > width - M) { y += rowH + GAP; x = M; rowH = 0; row++; rows.push([]); }
    const room = { key: r.key, name: r.name, lobby: r.lobby, x, y, w, h, cols, desks: [], ri, row };
    const spineX = x + PAD / 2;
    let prevSpine = null;
    for (let line = 0; line < lines; line++) {
      const aisleY = y + HEAD + PAD + (line + 1) * DH - OF.AISLE;
      const spine = wp(`s${ri}.${line}`, spineX, aisleY);
      if (prevSpine) edges.push([prevSpine, spine]);
      prevSpine = spine;
      let prev = spine;
      for (let c = 0; c < cols && line * cols + c < n; c++) {
        const i = line * cols + c, dx = x + PAD + c * DW, dy = y + HEAD + PAD + line * DH;
        const aisle = wp(`a${ri}.${i}`, dx + DW / 2, aisleY);
        edges.push([prev, aisle]);
        prev = aisle;
        room.desks.push({ key: `${r.key}/${r.nodes[i].name}`, node: r.nodes[i], x: dx, y: dy, w: DW, h: DH, seat: { x: dx + DW / 2, y: dy + OF.SEAT_Y }, wp: aisle });
      }
    }
    const door = wp(`d${ri}`, spineX, y + h);
    if (prevSpine) edges.push([prevSpine, door]);
    room.door = door;
    out.push(room);
    rows[row].push(room);
    x += w + GAP;
    rowH = Math.max(rowH, h);
  });
  // The corridors: one under each row of rooms (each door drops to it), joined down the left margin.
  let prevLeft = null;
  rows.forEach((list, k) => {
    if (!list.length) return;
    const cy = Math.max(...list.map((r) => r.y + r.h)) + GAP / 2;
    let prev = wp(`L${k}`, M / 2, cy);
    if (prevLeft) edges.push([prevLeft, prev]);
    prevLeft = prev;
    for (const r of list) {
      const c = wp(`c${k}.${r.ri}`, r.x + PAD / 2, cy);
      edges.push([prev, c], [r.door, c]);
      prev = c;
    }
  });
  const right = out.length ? Math.max(...out.map((r) => r.x + r.w)) : 0, bottom = out.length ? Math.max(...out.map((r) => r.y + r.h)) : 0;
  return { rooms: out, waypoints, edges, width: Math.max(width, right + M), height: bottom + GAP / 2 + M };
}

/**
 * A stored office with its own layout: one room (named for the office) around its seats. A seat assigned to a member
 * holds them; the other members take the free seats in order; `unseated` counts who found none.
 */
export function customLayout(office, nodes) {
  const { DW, DH, PAD, HEAD, M } = OF;
  const lay = office.layout;
  const left = new Map(nodes.map((n) => [n.name, n]));
  const taken = lay.seats.map((s) => { const n = s.instance ? left.get(s.instance) : undefined; if (n) left.delete(n.name); return n || null; });
  const rest = [...left.values()];
  const desks = lay.seats.map((s, i) => {
    const node = taken[i] || (rest.length ? rest.shift() : null);
    return { key: `${office.id}/${s.id}`, node, x: s.x - DW / 2, y: s.y - OF.SEAT_Y, w: DW, h: DH, seat: { x: s.x, y: s.y }, wp: null };
  });
  const xs = [...desks.flatMap((d) => [d.x, d.x + d.w]), ...lay.waypoints.map((w) => w.x)];
  const ys = [...desks.flatMap((d) => [d.y, d.y + d.h]), ...lay.waypoints.map((w) => w.y)];
  const x0 = Math.max(0, Math.min(...xs) - PAD), y0 = Math.max(0, Math.min(...ys) - PAD - HEAD);
  const room = { key: office.id, name: office.name, lobby: false, x: x0, y: y0, w: Math.max(...xs) + PAD - x0, h: Math.max(...ys) + PAD - y0, desks, ri: 0, row: 0 };
  return { rooms: [room], waypoints: lay.waypoints, edges: lay.edges, width: room.x + room.w + M, height: room.y + room.h + M, unseated: rest.length };
}

/**
 * The backing store's px per CSS px for a W × H (CSS px) canvas at `dpr` (#2431 review): the device's ratio while the
 * bitmap stays one a browser can paint (each side at most 16384, at most 32 Mi px in all — Chromium gives a larger one
 * back blank, without an error); a bigger layout (custom seats far out) is drawn coarser instead of not at all.
 */
export const CANVAS_MAX = { side: 16384, area: 32 * 1024 * 1024 };
export function backingScale(w, h, dpr) {
  return Math.min(dpr, CANVAS_MAX.side / Math.max(1, w), CANVAS_MAX.side / Math.max(1, h), Math.sqrt(CANVAS_MAX.area / Math.max(1, w * h)));
}

/** Every desk with someone at it, in reading order. */
export const desksOf = (L) => L.rooms.flatMap((r) => r.desks).filter((d) => d.node);
/** The desk at (x, y) in layout px, or null. */
export const deskAt = (L, x, y) => desksOf(L).find((d) => x >= d.x && x < d.x + d.w && y >= d.y && y < d.y + d.h) || null;

// ── Walking: shortest paths on the waypoint graph ──

/** The fewest-hops path from waypoint `a` to `b` (both ids, both included); null when there is none. */
export function bfsPath(edges, a, b) {
  if (a === b) return [a];
  const next = new Map();
  for (const [u, v] of edges) {
    if (!next.has(u)) next.set(u, []);
    if (!next.has(v)) next.set(v, []);
    next.get(u).push(v);
    next.get(v).push(u);
  }
  if (!next.has(a) || !next.has(b)) return null;
  const from = new Map([[a, null]]), queue = [a];
  for (let i = 0; i < queue.length; i++) {
    const u = queue[i];
    for (const v of next.get(u)) {
      if (from.has(v)) continue;
      from.set(v, u);
      if (v === b) {
        const path = [b];
        for (let p = u; p !== null; p = from.get(p)) path.push(p);
        return path.reverse();
      }
      queue.push(v);
    }
  }
  return null;
}
/** The waypoint nearest a point; null when there are none. */
export function nearestWaypoint(waypoints, p) {
  let best = null, d = Infinity;
  for (const w of waypoints) { const e = Math.hypot(w.x - p.x, w.y - p.y); if (e < d) { d = e; best = w; } }
  return best;
}
/**
 * The way from one instance's desk to another's (its first desk, if it has two): its seat, the waypoints between the
 * nearest waypoints of the two seats, the other seat. A straight line when the graph has no way; null when either is
 * not drawn.
 */
export function walkPath(L, from, to) {
  const desks = desksOf(L);
  const a = desks.find((d) => d.node.name === from), z = desks.find((d) => d.node.name === to);
  if (!a || !z || a === z) return null;
  return routeVia(L, a.seat, z.seat, a.wp, z.wp);
}
/**
 * The way between two points on a waypoint graph ({ waypoints, edges }): from `a` to its waypoint (`wa`, else the
 * nearest), the fewest hops to `z`'s, then `z`. A straight line when the graph has no way.
 */
export function routeVia(graph, a, z, wa = null, wz = null) {
  const byId = new Map(graph.waypoints.map((w) => [w.id, w]));
  const pa = (wa && byId.get(wa)) || nearestWaypoint(graph.waypoints, a), pz = (wz && byId.get(wz)) || nearestWaypoint(graph.waypoints, z);
  const ids = pa && pz ? bfsPath(graph.edges, pa.id, pz.id) : null;
  return ids ? [a, ...ids.map((id) => byId.get(id)), z] : [a, z];
}
export const pathLength = (pts) => pts.reduce((s, p, i) => (i ? s + Math.hypot(p.x - pts[i - 1].x, p.y - pts[i - 1].y) : 0), 0);
/** The point a fraction `t` (0–1) of the way along a polyline. */
export function along(pts, t) {
  const total = pathLength(pts);
  if (!total) return { x: pts[0].x, y: pts[0].y };
  let left = Math.max(0, Math.min(1, t)) * total;
  for (let i = 1; i < pts.length; i++) {
    const l = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    if (left <= l && l > 0) { const k = left / l; return { x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * k, y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * k }; }
    left -= l;
  }
  const last = pts[pts.length - 1];
  return { x: last.x, y: last.y };
}

// ── Traffic: an item carried from desk to desk ──

/** px per ms along the path, the shortest and longest trip, the stagger between items that arrive together. */
export const FLIGHT = { SPEED: 0.35, MIN_MS: 900, MAX_MS: 4000, STAGGER_MS: 150, MAX: 40 };
const MAX_SEEN = 2000;
/**
 * The items in the air. `sync(items, now, still)` takes fleet-traffic.js's store items: each new one (a message, a
 * delegation's work, its report coming back) starts one trip from its sender's desk to its receiver's; a delegation with
 * no report (stale) and anything seen before start none; `still` (reduced motion) starts none. `frame(now, L)` the
 * trips under way on layout L: { id, hue, kind, x, y, t }, finished ones dropped; a trip whose desks are not drawn goes.
 */
export function createFlights({ max = FLIGHT.MAX } = {}) {
  const seen = new Set();
  let trips = [];
  return {
    sync(items, now, still = false) {
      let k = 0, started = 0;
      for (const it of items || []) {
        if (seen.has(it.id)) continue;
        seen.add(it.id);
        if (seen.size > MAX_SEEN) seen.delete(seen.values().next().value);
        if (still || it.phase === "stale") continue;
        trips.push({ id: it.id, from: it.from, to: it.to, kind: it.kind, hue: hue(it.kind), start: now + k++ * FLIGHT.STAGGER_MS, L: null, pts: null, ms: 0 });
        started++;
      }
      if (trips.length > max) trips = trips.slice(trips.length - max);
      return started;
    },
    frame(now, L) {
      const out = [];
      trips = trips.filter((f) => {
        if (f.L !== L) { f.L = L; f.pts = walkPath(L, f.from, f.to); f.ms = f.pts ? Math.min(FLIGHT.MAX_MS, Math.max(FLIGHT.MIN_MS, pathLength(f.pts) / FLIGHT.SPEED)) : 0; }
        if (!f.pts) return false;
        const t = (now - f.start) / f.ms;
        if (t >= 1) return false;
        if (t >= 0) { const p = along(f.pts, t); out.push({ id: f.id, hue: f.hue, kind: f.kind, x: p.x, y: p.y, t }); }
        return true;
      });
      return out;
    },
    size: () => trips.length,
  };
}

/** How many delegations each instance is working on now (the folders on its desk). */
export function workOn(items) {
  const out = new Map();
  for (const it of items || []) if (it.phase === "work") out.set(it.to, (out.get(it.to) || 0) + 1);
  return out;
}
