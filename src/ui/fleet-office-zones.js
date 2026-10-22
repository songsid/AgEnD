// The Office view's "zones" layout: used when a skin names areas for states (its pack's `stateZones`,
// fleet-office-pack.js). Each instance goes to the area for its state now and takes a seat slot there; when its state
// changes it walks (along the pack's waypoints) to the new area. Pure — fleet-office.js draws it. Also here: what a
// character says in its speech bubble, and which furniture is active.
import { LOGICAL } from "./fleet-office-pack.js";
import { nameHash, pathLength, along, routeVia } from "./fleet-office-model.js";

/** The area for a state: the pack's own, else its "default", else its first area. */
export function zoneOf(pack, state) {
  const z = pack.stateZones || {};
  return z[state] || z.default || Object.keys(pack.areas)[0];
}

/** How far apart overflow spots are, and how far they stay from the area's seats (logical units). */
export const OVERFLOW = { STEP: 56, CLEAR: 40, EDGE: 24 };
/** An area's overflow spots, for when its seats are taken: a grid inside its rect, clear of its seats, in reading order. */
export function overflowSpots(area) {
  const out = [], { x, y, w, h } = area.rect;
  for (let sy = y + OVERFLOW.EDGE + 30; sy <= y + h - OVERFLOW.EDGE; sy += OVERFLOW.STEP) {
    for (let sx = x + OVERFLOW.EDGE; sx <= x + w - OVERFLOW.EDGE; sx += OVERFLOW.STEP) {
      if (area.seats.every((s) => Math.hypot(s.x - sx, s.y - sy) >= OVERFLOW.CLEAR)) out.push({ x: sx, y: sy });
    }
  }
  return out;
}

/**
 * Seats for everyone: `wants` [{ name, area }] in the fleet's order; `prev` what the last call gave (name → { area,
 * slot }). Someone still in the same area keeps their slot; the others take the first free seat, in the area's order,
 * then an overflow spot (slot -1, -2, …). No two share one. Whoever finds neither is counted in `crowd` (area → n).
 * Returns { seats: Map name → { area, slot, x, y }, crowd: Map }.
 */
export function assignSeats(pack, wants, prev = new Map()) {
  const seats = new Map(), crowd = new Map(), taken = new Map(), spill = new Map();
  const spotsOf = (area) => { if (!spill.has(area)) spill.set(area, overflowSpots(pack.areas[area])); return spill.get(area); };
  const pos = (area, slot) => (slot >= 0 ? pack.areas[area].seats[slot] : spotsOf(area)[-slot - 1]);
  const usedIn = (area) => { if (!taken.has(area)) taken.set(area, new Set()); return taken.get(area); };
  const give = (name, area, slot) => { const p = pos(area, slot); usedIn(area).add(slot); seats.set(name, { area, slot, x: p.x, y: p.y }); };
  for (const w of wants) {
    const p = prev.get(w.name);
    if (!p || p.area !== w.area || !pack.areas[w.area] || !pos(w.area, p.slot) || usedIn(w.area).has(p.slot)) continue;
    give(w.name, w.area, p.slot);
  }
  for (const w of wants) {
    if (seats.has(w.name) || !pack.areas[w.area]) continue;
    const used = usedIn(w.area), area = pack.areas[w.area];
    let slot = area.seats.findIndex((_, i) => !used.has(i));
    if (slot < 0) { const j = spotsOf(w.area).findIndex((_, i) => !used.has(-i - 1)); slot = j < 0 ? null : -j - 1; }
    if (slot === null) crowd.set(w.area, (crowd.get(w.area) || 0) + 1);
    else give(w.name, w.area, slot);
  }
  return { seats, crowd };
}

/**
 * The zones layout for `nodes` (buildOrgView's) on a pack: everyone but the missing at their seat. The same shape as
 * the desks layout (rooms → desks with a seat), in logical units, plus `mode: "zones"`, the pack's areas and graph, the
 * seats given (`seats`, the next call's `prev`) and `crowd`.
 */
export function zonesLayout(pack, nodes, prev = new Map()) {
  const wants = nodes.filter((n) => n.state !== "missing").map((n) => ({ name: n.name, area: zoneOf(pack, n.state) }));
  const { seats, crowd } = assignSeats(pack, wants, prev);
  const desks = nodes.filter((n) => seats.has(n.name)).map((n) => {
    const s = seats.get(n.name);
    return { key: `zone/${n.name}`, node: n, x: s.x - 24, y: s.y - 52, w: 48, h: 66, seat: { x: s.x, y: s.y }, wp: null, area: s.area, slot: s.slot };
  });
  return { mode: "zones", rooms: [{ key: "\u0000zones", name: null, lobby: false, x: 0, y: 0, w: LOGICAL.w, h: LOGICAL.h, desks }], areas: pack.areas,
    waypoints: pack.waypoints || [], edges: pack.edges || [], door: pack.door, width: LOGICAL.w, height: LOGICAL.h, seats, crowd };
}

// ── Walking ──

/** Logical units per ms (crossing the canvas takes about six seconds). */
export const WALK = { SPEED: 0.2 };
/**
 * Where each character is. `sync(targets, now, graph, still)`: targets name → { x, y }; someone new is already there;
 * someone whose target moved walks from where they are now along the graph (routeVia) — or is there at once when
 * `still` (reduced motion); someone gone is forgotten. `at(name, now)` → { x, y, walking }; `moving(now)`.
 */
export function createWalkers() {
  const by = new Map();
  const posAt = (w, now) => {
    if (!w.pts) return { x: w.to.x, y: w.to.y, walking: false };
    const t = (now - w.start) / w.ms;
    if (t >= 1) return { x: w.to.x, y: w.to.y, walking: false };
    const p = along(w.pts, Math.max(0, t));
    return { x: p.x, y: p.y, walking: true };
  };
  return {
    sync(targets, now, graph, still = false) {
      for (const name of [...by.keys()]) if (!targets.has(name)) by.delete(name);
      for (const [name, to] of targets) {
        const w = by.get(name);
        if (!w || still) { if (!w || w.to.x !== to.x || w.to.y !== to.y) by.set(name, { pts: null, to }); continue; }
        if (w.to.x === to.x && w.to.y === to.y) continue;
        const here = posAt(w, now), pts = routeVia(graph, { x: here.x, y: here.y }, { x: to.x, y: to.y });
        by.set(name, { pts, start: now, ms: Math.max(1, pathLength(pts) / WALK.SPEED), to });
      }
    },
    at(name, now) { const w = by.get(name); return w ? posAt(w, now) : null; },
    moving(now) { for (const w of by.values()) if (posAt(w, now).walking) return true; return false; },
  };
}

/**
 * The person at (x, y) in layout px as the scene draws them (#2431 review): each desk's box moved to where its person is
 * now (`posOf(desk)`: a walker's position; null: at the seat), the one drawn last (the nearest) tried first.
 */
export function personAt(desks, x, y, posOf) {
  const people = desks.filter((d) => d.node).map((d) => { const at = posOf(d) || d.seat; return { d, at, dx: at.x - d.seat.x, dy: at.y - d.seat.y }; })
    .sort((a, b) => a.at.y - b.at.y);
  for (let i = people.length - 1; i >= 0; i--) {
    const { d, dx, dy } = people[i];
    if (x >= d.x + dx && x < d.x + dx + d.w && y >= d.y + dy && y < d.y + dy + d.h) return d;
  }
  return null;
}

// ── Speech bubbles ──

/**
 * A round is PERIOD_MS; a character speaks in a round when it is their turn (one in SHARE, by name) — always when it
 * calls for the person — for SHOW_MS, its line typed at CHAR_MS a character. Never message content: only the lines given.
 */
export const BUBBLE = { PERIOD_MS: 10000, SHOW_MS: 4500, CHAR_MS: 55, SHARE: 4 };
/** The states whose bubble always shows (the person is called). */
export const CALLING = new Set(["needs", "crashed", "stuck"]);
/**
 * What `name` (in `state`) says at `ms`: { text, shown } (shown: how many characters are typed so far), or null.
 * `ms` 0 is still (reduced motion): the line of round 0, all of it, at once.
 */
export function bubbleAt(name, state, ms, lines) {
  if (!lines || !lines.length) return null;
  const h = nameHash(`${name}\u0000${state}`), always = CALLING.has(state);
  const t = Math.max(0, ms) + (h % BUBBLE.PERIOD_MS), round = Math.floor(t / BUBBLE.PERIOD_MS), into = t - round * BUBBLE.PERIOD_MS;
  if (!always && ((h >>> 8) + round) % BUBBLE.SHARE !== 0) return null;
  if (ms > 0 && !always && into > BUBBLE.SHOW_MS) return null;
  const text = lines[(h + round) % lines.length], all = [...text].length;
  return { text, shown: ms > 0 ? Math.min(all, 1 + Math.floor(into / BUBBLE.CHAR_MS)) : all };
}
/**
 * Where this frame's bubbles go so no two overlap (#2431: neighbours' bubbles covered each other on a phone). `items`:
 * { key, calling, shown, box, tail? } with `box` the bubble's whole box ({ x, y, w, h }, for its whole line, so it never
 * moves while typing out) and `tail` the point its tail reaches: the strip from the box down to it is kept clear too. The ones calling for the person go first (they always show), then the one that started earliest
 * (the most typed out) — one already showing keeps its place. Each takes its spot, or one row up (`lift`) when that is
 * free; else it waits for another round. Returns the placed ones, each with its `dy` (0 or -lift).
 */
export function placeBubbles(items, lift = 22) {
  const order = [...items].sort((a, b) => (Number(b.calling) - Number(a.calling)) || (b.shown - a.shown) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const taken = [], out = [];
  const hits = (r) => taken.some((t) => r.x < t.x + t.w && t.x < r.x + r.w && r.y < t.y + t.h && t.y < r.y + r.h);
  for (const it of order) {
    for (const dy of [0, -lift]) {
      const r = { x: it.box.x, y: it.box.y + dy, w: it.box.w, h: it.box.h };
      const t = it.tail ? { x: it.tail.x - 1, y: r.y + r.h, w: 9, h: Math.max(0, it.tail.y - (r.y + r.h)) } : null;
      if (hits(r) || (t && hits(t))) continue;
      taken.push(r); if (t) taken.push(t); out.push({ ...it, dy });
      break;
    }
  }
  return out;
}

/** The lines for a state: the skin's (in the page's language), else the page's own. */
export function linesFor(state, lang, pack, defaults) {
  const own = pack && pack.bubbles && pack.bubbles[lang] && pack.bubbles[lang][state];
  return own && own.length ? own : defaults[state] || [];
}

// ── Furniture ──

/** The furniture active now: an item whose `activeWhen` names a state someone shown is in. */
export function activeFurniture(pack, states) {
  const on = new Set();
  for (const f of (pack && pack.furniture) || []) if (f.activeWhen && f.activeWhen.some((s) => states.has(s))) on.add(f.id);
  return on;
}
