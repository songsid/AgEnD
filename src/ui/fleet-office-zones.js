// The Office view's "zones" layout: used when a skin names areas for states (its pack's `stateZones`,
// fleet-office-pack.js). Each instance goes to the area for its state now and takes a seat slot there; when its state
// changes it walks (along the pack's waypoints) to the new area. Pure — fleet-office.js draws it. Also here: what a
// character says in its speech bubble, and which furniture is active.
import { LOGICAL, own } from "./fleet-office-pack.js";
import { FLIGHT, nameHash, pathLength, along, routeVia } from "./fleet-office-model.js";
import { hue } from "./fleet-traffic.js";

/** The area for a state: the pack's own, else its "default", else its first area. */
export function zoneOf(pack, state) {
  const z = pack.stateZones || {};
  return own(z, state) || own(z, "default") || Object.keys(pack.areas)[0];
}

/**
 * How far apart overflow spots are, and how far they stay from the area's seats (logical units); TITLE: the band at
 * the top of an area its name is written in, kept clear. A crowded area packs tighter (STEPS, #2513: 70 instances, 42
 * idle, piled up in the lounge) before anyone is left to the "+N" count.
 */
export const OVERFLOW = { STEP: 56, CLEAR: 40, EDGE: 24, TITLE: 30, STEPS: [56, 46, 38, 32] };
function spotsAt(area, step) {
  const out = [], { x, y, w, h } = area.rect, clear = step === OVERFLOW.STEP ? OVERFLOW.CLEAR : Math.round(step * 0.72);
  for (let sy = y + OVERFLOW.EDGE + OVERFLOW.TITLE; sy <= y + h - OVERFLOW.EDGE; sy += step) {
    for (let sx = x + OVERFLOW.EDGE; sx <= x + w - OVERFLOW.EDGE; sx += step) {
      if (area.seats.every((s) => Math.hypot(s.x - sx, s.y - sy) >= clear)) out.push({ x: sx, y: sy });
    }
  }
  return out;
}
/**
 * An area's overflow spots, for when its seats are taken: a tidy grid inside its rect, clear of its seats and its
 * title, in reading order. `need`: how many are wanted — the widest spacing that fits them all, else the tightest.
 */
export function overflowSpots(area, need = 0) {
  let spots = [];
  for (const step of OVERFLOW.STEPS) { spots = spotsAt(area, step); if (spots.length >= need) return spots; }
  return spots;
}

/**
 * Seats for everyone: `wants` [{ name, area }] in the fleet's order; `prev` what the last call gave (name → { area,
 * slot }). Someone still in the same area keeps their slot; the others take the first free seat, in the area's order,
 * then an overflow spot (slot -1, -2, …). No two share one. Whoever finds neither is counted in `crowd` (area → n).
 * Returns { seats: Map name → { area, slot, x, y }, crowd: Map }.
 *
 * #2691: a seat may be reserved (its `for`). Whoever it is for, wanting its area, takes a free seat reserved for them
 * before anything else (the one they sat on last time, else their first in the area's order) — owners are seated
 * before anyone keeps a slot, so a borrower on an owner's seat moves off when the owner comes. Everyone else keeps
 * their slot or takes the first free seat not reserved for someone else: a plain one, else a reserved one that says
 * `lend` (one no owner of it took). A reserved seat not lent, none of whose owners wants the area, is unavailable:
 * the area's overflow spots and `over` count without it. Seats without `for` work as before.
 */
export function assignSeats(pack, wants, prev = new Map()) {
  const seats = new Map(), crowd = new Map(), taken = new Map(), spill = new Map(), demand = new Map(), wanting = new Map();
  const areaOf = (a) => own(pack.areas, a);
  for (const w of wants) {
    demand.set(w.area, (demand.get(w.area) || 0) + 1);
    if (!wanting.has(w.area)) wanting.set(w.area, new Set());
    wanting.get(w.area).add(w.name);
  }
  const mine = (s, name) => !!s.for && s.for.includes(name);
  const lent = (s) => !!s.for && s.lend === true;
  // The seats someone wanting the area may end up on: plain, lent, or reserved for someone who wants it.
  const usable = (area) => areaOf(area).seats.filter((s) => !s.for || s.lend === true || s.for.some((n) => wanting.get(area).has(n))).length;
  const spotsOf = (area) => {
    if (!spill.has(area)) spill.set(area, overflowSpots(areaOf(area), Math.max(0, (demand.get(area) || 0) - usable(area))));
    return spill.get(area);
  };
  const pos = (area, slot) => (slot >= 0 ? areaOf(area).seats[slot] : spotsOf(area)[-slot - 1]);
  const usedIn = (area) => { if (!taken.has(area)) taken.set(area, new Set()); return taken.get(area); };
  const give = (name, area, slot) => { const p = pos(area, slot); usedIn(area).add(slot); seats.set(name, { area, slot, x: p.x, y: p.y }); };
  const free = (w) => !seats.has(w.name) && !!areaOf(w.area);
  // Owners first: their own seat from last time, then their first free one.
  for (const w of wants) {
    const p = prev.get(w.name), s = p && p.area === w.area && p.slot >= 0 && areaOf(w.area) ? areaOf(w.area).seats[p.slot] : null;
    if (s && mine(s, w.name) && !usedIn(w.area).has(p.slot)) give(w.name, w.area, p.slot);
  }
  for (const w of wants) {
    if (!free(w)) continue;
    const used = usedIn(w.area), slot = areaOf(w.area).seats.findIndex((s, i) => mine(s, w.name) && !used.has(i));
    if (slot >= 0) give(w.name, w.area, slot);
  }
  for (const w of wants) {
    const p = prev.get(w.name);
    if (!free(w) || !p || p.area !== w.area || !pos(w.area, p.slot) || usedIn(w.area).has(p.slot)) continue;
    const s = p.slot >= 0 ? areaOf(w.area).seats[p.slot] : null;
    if (s && s.for && !lent(s)) continue;                       // reserved for someone else (theirs would be taken above)
    give(w.name, w.area, p.slot);
  }
  for (const w of wants) {
    if (!free(w)) continue;
    const used = usedIn(w.area), area = areaOf(w.area);
    let slot = area.seats.findIndex((s, i) => !s.for && !used.has(i));
    if (slot < 0) slot = area.seats.findIndex((s, i) => lent(s) && !used.has(i));
    if (slot < 0) { const j = spotsOf(w.area).findIndex((_, i) => !used.has(-i - 1)); slot = j < 0 ? null : -j - 1; }
    if (slot === null) crowd.set(w.area, (crowd.get(w.area) || 0) + 1);
    else give(w.name, w.area, slot);
  }
  // Over capacity: more people want the area than it has seats for them (their bubbles and tags are thinned, fleet-office.js).
  const over = new Set([...demand].filter(([a, n]) => areaOf(a) && n > usable(a)).map(([a]) => a));
  return { seats, crowd, over };
}

/**
 * The zones layout for `nodes` (buildOrgView's) on a pack: everyone but the missing at their seat. The same shape as
 * the desks layout (rooms → desks with a seat), in logical units, plus `mode: "zones"`, the pack's areas and graph (and
 * its `straight`, #2634), the seats given (`seats`, the next call's `prev`), `crowd` and `over` (the areas over capacity).
 */
export function zonesLayout(pack, nodes, prev = new Map(), { night = false } = {}) {
  // At night (#2568) the idle go to bed: the area asleep people go to while it has a free seat; the rest doze where they are.
  const bed = zoneOf(pack, "paused"), bedSeats = own(pack.areas, bed)?.seats || [], sleepers = new Set(), inBed = new Set();
  const wantsOf = (beds) => nodes.filter((n) => n.state !== "missing").map((n) => ({ name: n.name, area: beds.has(n.name) ? bed : zoneOf(pack, n.state) }));
  let placed = assignSeats(pack, wantsOf(inBed), prev);
  if (night) {
    // #2691 review: who goes to bed is decided by the seat assignment itself (assignSeats' reservation rules), one
    // sleeper at a time — whoever has a bed of their own there first, then the rest in the fleet's order. A sleeper
    // goes to bed only if it gives them a bed (never an overflow spot) without taking one from anyone already in one
    // (the awake first, then the sleepers admitted before), unless it is a bed reserved for them: an owner comes first,
    // as by day. Everyone else dozes where they are.
    const inABed = (r) => new Set([...r.seats].filter(([, s]) => s.area === bed && s.slot >= 0).map(([name]) => name));
    const idle = nodes.filter((n) => n.state === "idle");
    const hasBed = (n) => bedSeats.some((s) => s.for && s.for.includes(n.name));
    for (const n of idle) sleepers.add(n.name);
    for (const n of [...idle.filter(hasBed), ...idle.filter((n) => !hasBed(n))]) {
      const trial = assignSeats(pack, wantsOf(new Set([...inBed, n.name])), prev), s = trial.seats.get(n.name);
      if (!s || s.area !== bed || s.slot < 0) {
        if (!hasBed(n)) break;                                  // no bed free for anyone without one: none for the rest either
        continue;
      }
      const before = inABed(placed), after = inABed(trial);
      const theirs = !!bedSeats[s.slot].for && bedSeats[s.slot].for.includes(n.name);
      if (!theirs && [...before].some((m) => !after.has(m))) continue;
      inBed.add(n.name);
      placed = trial;
    }
  }
  const { seats, crowd, over } = placed;
  const desks = nodes.filter((n) => seats.has(n.name)).map((n) => {
    const s = seats.get(n.name);
    return { key: `zone/${n.name}`, node: n, x: s.x - 24, y: s.y - 52, w: 48, h: 66, seat: { x: s.x, y: s.y }, wp: null, area: s.area, slot: s.slot, night: sleepers.has(n.name) };
  });
  return { mode: "zones", rooms: [{ key: "\u0000zones", name: null, lobby: false, x: 0, y: 0, w: LOGICAL.w, h: LOGICAL.h, desks }], areas: pack.areas,
    waypoints: pack.waypoints || [], edges: pack.edges || [], straight: pack.straight === true, door: pack.door, width: LOGICAL.w, height: LOGICAL.h, seats, crowd, over };
}

// ── Walking ──

/** Logical units per ms (crossing the canvas takes about six seconds). */
export const WALK = { SPEED: 0.2 };
/** The step of a polyline a fraction `t` (0–1) of the way along it: { dx, dy } (its direction), or null (no length). */
export function headingAt(pts, t) {
  const total = pathLength(pts);
  if (!total) return null;
  let left = Math.max(0, Math.min(1, t)) * total;
  for (let i = 1; i < pts.length; i++) {
    const dx = pts[i].x - pts[i - 1].x, dy = pts[i].y - pts[i - 1].y, l = Math.hypot(dx, dy);
    if (l > 0 && (left <= l || i === pts.length - 1)) return { dx, dy };
    left -= l;
  }
  return null;
}
/**
 * #2634: a polyline with each diagonal leg made an L — across first, then up or down — so a character set's three
 * walking strips always fit; legs already across or up/down are kept, and no point repeats (no zero-length leg).
 */
export function straighten(pts) {
  const out = [];
  const add = (x, y) => { const l = out[out.length - 1]; if (!l || l.x !== x || l.y !== y) out.push({ x, y }); };
  for (const p of pts) { const l = out[out.length - 1]; if (l && l.x !== p.x && l.y !== p.y) add(p.x, l.y); add(p.x, p.y); }
  return out;
}
// ── Night (#2568) ──

/** Bedtime on the viewer's clock: from FROM o'clock to TO o'clock the idle sleep (anyone with work still gets up for it). */
export const NIGHT = { FROM: 0, TO: 6, TICK: 60000 };
export const isNight = (d = new Date()) => { const h = d.getHours(); return NIGHT.FROM <= NIGHT.TO ? h >= NIGHT.FROM && h < NIGHT.TO : h >= NIGHT.FROM || h < NIGHT.TO; };

// ── Wandering (#2560) ──

/**
 * An idle person now and then strolls to a spot near their seat and back, so a quiet room is not a row of statues:
 * every PERIOD ms (each person's own phase, from their name) they are AWAY ms at a waypoint within REACH of the seat —
 * one no seat of the office is on (taken or free), picked anew each time — then walk back. Pure: the page asks every TICK ms and walks the change.
 */
export const WANDER = { PERIOD: 40000, AWAY: 8000, REACH: 220, TICK: 1000 };
/** Where `name`, seated at `seat`, should be at `t` (ms) while idle: a spot near the seat, or the seat. */
export function wanderTarget(name, seat, graph, t, seats = []) {
  const near = (graph.waypoints || []).filter((w) => Math.hypot(w.x - seat.x, w.y - seat.y) <= WANDER.REACH
    && !seats.some((s) => Math.hypot(w.x - s.x, w.y - s.y) < 4));
  if (!near.length) return seat;
  const h = nameHash(name), k = t + (h % WANDER.PERIOD), turn = Math.floor(k / WANDER.PERIOD);
  if (k - turn * WANDER.PERIOD >= WANDER.AWAY) return seat;
  const w = near[nameHash(`${name}\u0000${turn}`) % near.length];
  return { x: w.x, y: w.y };
}
/** An NPC drawn as furniture (#2596: an item with `walk`): its walker's name — never a person's, and its own phase. */
export const npcKey = (f) => `furniture/${f.id}`;
/** Everyone's walk target: their seat, or — idle and `wander` on — wanderTarget's spot (one person a spot: whoever
 * would share it stays seated this time). And, `wander` on, each item of `furniture` with a `walk` (#2596): its spot
 * (x, y), or a stroll near it as an idle person's (by npcKey) — none at `night` for one with a night place (asleep there). */
export function walkTargets(desks, graph, t, wander = true, furniture = [], night = false) {
  // Every seat of the office (anyone's, taken or not: someone may sit down on it any moment), not only the ones in use.
  // And each walking NPC's spot (#2596 review): its home, where it stands outside its stroll and goes back to whenever
  // its stroll would collide, so nobody else's stroll may end there — no two walkers ever share a target.
  const homes = wander ? furniture.filter((f) => f.walk && !(night && f.night)).map((f) => ({ x: f.x, y: f.y })) : [];
  const seats = [...Object.values(graph.areas || {}).flatMap((a) => a.seats || []), ...desks.map((d) => d.seat), ...homes];
  const used = new Set(homes.map((h) => `${h.x},${h.y}`));
  const stroll = (name, home) => {
    const p = wanderTarget(name, home, graph, t, seats), k = `${p.x},${p.y}`;
    if (p === home || used.has(k)) return home;
    used.add(k);
    return p;
  };
  const out = new Map(desks.map((d) => [d.node.name, !wander || d.node.state !== "idle" || d.night ? d.seat : stroll(d.node.name, d.seat)]));
  if (wander) for (const f of furniture) if (f.walk && !(night && f.night)) out.set(npcKey(f), stroll(npcKey(f), { x: f.x, y: f.y }));
  return out;
}

// ── Mail from another office (#2564) ──

/**
 * Something sent to a person here by someone who is not (in another office, or in none): it flies in at the door and
 * lands on the floor near the middle of the room; the person walks over, picks it up and walks back to their seat.
 * MAX_WAIT: a letter no one picks up is gone after it; GAP: letters waiting side by side; SEARCH: how far from the
 * middle a landing spot is looked for when no waypoint will do; ASLEEP: who does not get up
 * for it (it waits for them to wake, up to MAX_WAIT).
 */
export const MAIL = { MAX_WAIT: 60000, GAP: 16, SEARCH: 320, ASLEEP: new Set(["paused", "stopped"]), MAX: 20 };
/**
 * Where the `n`th waiting letter lands: `n` GAPs along from the waypoint nearest the room's middle — the nearest whose
 * spot (offset included) no seat of the office is on, taken or free (someone may sit there any moment; #2561 likewise);
 * with none, the nearest point round the middle (rings GAP·2 apart, inside the room) that no seat is on; with none of
 * those either, null — the letter is not delivered here (never on a seat).
 */
export function dropPoint(L, n = 0) {
  const mid = { x: L.width / 2, y: L.height * 0.55 }, d = (p, q) => Math.hypot(p.x - q.x, p.y - q.y);
  const seats = [...Object.values(L.areas || {}).flatMap((a) => a.seats || []), ...desksIn(L).map((q) => q.seat)];
  const onSeat = (p) => seats.some((q) => d(p, q) < 4);
  const spots = (L.waypoints || []).map((w) => ({ x: Math.round(w.x + n * MAIL.GAP), y: Math.round(w.y), from: w }))
    .filter((p) => !onSeat(p.from) && !onSeat(p)).sort((p, q) => d(p.from, mid) - d(q.from, mid));
  if (spots.length) return { x: spots[0].x, y: spots[0].y };
  const inRoom = (p) => p.x >= 0 && p.y >= 0 && p.x <= L.width && p.y <= L.height;
  for (let r = 0; r <= MAIL.SEARCH; r += 2 * MAIL.GAP) {
    for (let k = 0, m = r ? 16 : 1; k < m; k++) {
      const a = (2 * Math.PI * k) / m, p = { x: Math.round(mid.x + r * Math.cos(a) + n * MAIL.GAP), y: Math.round(mid.y + r * Math.sin(a)) };
      if (inRoom(p) && !onSeat(p)) return p;
    }
  }
  return null;
}
const desksIn = (L) => (L.rooms || []).flatMap((r) => r.desks || []).filter((d) => d.node);
/**
 * The letters of one office. `sync(items, now, L, still)`: each new traffic item to someone drawn here from someone
 * who is not becomes a letter (none with reduced motion, nor for a stale delegation; a zones office only).
 * `frame(now, L, walkers)` → what to draw, { id, hue, kind, from, x, y, t } (t: its flight, 0 on the floor), picking
 * up the letters whose person stands on them, and dropping those gone too long or whose person left. `targets(L)`:
 * name → where to walk to pick one up (the first waiting for them; none while they are asleep). `prime(items)`: mark as
 * seen what was in the air before this office was shown (a new office's or style's mail starts empty). `size()`.
 */
export function createMail({ max = MAIL.MAX } = {}) {
  const seen = new Set();
  let letters = [];
  const here = (L, name) => desksIn(L).find((d) => d.node.name === name) || null;
  return {
    sync(items, now, L, still = false) {
      let started = 0;
      for (const it of items || []) {
        if (seen.has(it.id)) continue;
        seen.add(it.id);
        if (seen.size > 2000) seen.delete(seen.values().next().value);
        if (still || it.phase === "stale" || !L || L.mode !== "zones" || !here(L, it.to) || here(L, it.from)) continue;
        const drop = dropPoint(L, letters.filter((l) => l.to !== it.to).length % 4);
        if (!drop) continue;                                          // nowhere off the seats: not delivered here
        const pts = [{ x: L.door.x, y: L.door.y }, drop];
        letters.push({ id: it.id, from: it.from, to: it.to, kind: it.kind, hue: hue(it.kind), start: now, drop, pts,
          ms: Math.min(FLIGHT.MAX_MS, Math.max(FLIGHT.MIN_MS, pathLength(pts) / FLIGHT.SPEED)) });
        started++;
      }
      if (letters.length > max) letters = letters.slice(letters.length - max);
      return started;
    },
    frame(now, L, walkers) {
      const out = [];
      letters = letters.filter((l) => {
        if (!here(L, l.to)) return false;
        const t = (now - l.start) / l.ms;
        if (t < 1) { if (t >= 0) { const p = along(l.pts, t); out.push({ id: l.id, hue: l.hue, kind: l.kind, from: l.from, x: p.x, y: p.y, t }); } return true; }
        if (now - l.start - l.ms > MAIL.MAX_WAIT) return false;
        const w = walkers && walkers.at(l.to, now);
        if (w && !w.walking && Math.hypot(w.x - l.drop.x, w.y - l.drop.y) < 4) return false;   // picked up
        out.push({ id: l.id, hue: l.hue, kind: l.kind, from: l.from, x: l.drop.x, y: l.drop.y, t: 0 });
        return true;
      });
      return out;
    },
    targets(L, now) {
      const out = new Map();
      for (const l of letters) {
        if (out.has(l.to) || now - l.start < l.ms) continue;
        const d = here(L, l.to);
        if (d && !MAIL.ASLEEP.has(d.node.state) && !d.night) out.set(l.to, l.drop);   // asleep, or in bed for the night (#2568)
      }
      return out;
    },
    /** What is already in the traffic when this office's mail starts (#2564): seen, so it is not delivered again here. */
    prime(items) { for (const it of items || []) seen.add(it.id); },
    size: () => letters.length,
  };
}

/**
 * Where each character is. `sync(targets, now, graph, still)`: targets name → { x, y }; someone new is already there;
 * someone whose target moved walks from where they are now along the graph (routeVia; each diagonal leg an L when the
 * graph is `straight`, #2634) — or is there at once when `still` (reduced motion); someone gone is forgotten. `at(name, now)` → { x, y, walking } and, while walking, `heading`: the
 * current step's { dx, dy }, which picks a pack's walkDown / walkUp / walkSide strip; `moving(now)`.
 */
export function createWalkers() {
  const by = new Map();
  const posAt = (w, now) => {
    if (!w.pts) return { x: w.to.x, y: w.to.y, walking: false };
    const t = (now - w.start) / w.ms;
    if (t >= 1) return { x: w.to.x, y: w.to.y, walking: false };
    const p = along(w.pts, Math.max(0, t));
    return { x: p.x, y: p.y, walking: true, heading: headingAt(w.pts, Math.max(0, t)) };
  };
  return {
    sync(targets, now, graph, still = false) {
      for (const name of [...by.keys()]) if (!targets.has(name)) by.delete(name);
      for (const [name, to] of targets) {
        const w = by.get(name);
        if (!w || still) { if (!w || w.to.x !== to.x || w.to.y !== to.y) by.set(name, { pts: null, to }); continue; }
        if (w.to.x === to.x && w.to.y === to.y) continue;
        const here = posAt(w, now), via = routeVia(graph, { x: here.x, y: here.y }, { x: to.x, y: to.y });
        const pts = graph.straight ? straighten(via) : via;   // #2634: timed along the longer way
        by.set(name, { pts, start: now, ms: Math.max(1, pathLength(pts) / WALK.SPEED), to });
      }
    },
    at(name, now) { const w = by.get(name); return w ? posAt(w, now) : null; },
    moving(now) { for (const w of by.values()) if (posAt(w, now).walking) return true; return false; },
  };
}

/**
 * The person at (x, y) in layout px as the scene draws them (#2431 review): each desk's box moved to where its person is
 * now (`posOf(desk)`: a walker's position; null: at the seat), the one drawn last (the nearest) tried first — the same
 * order the scene draws them in. `boxOf(desk, at)` (#2513 review): the box the skin draws that person in there (an
 * uploaded character's strip, anchor and size, in its current pose and walking direction); null: the desk's own box.
 */
export function personAt(desks, x, y, posOf, boxOf = null) {
  const people = desks.filter((d) => d.node).map((d) => ({ d, at: posOf(d) || { ...d.seat, walking: false, heading: null } }))
    .sort((a, b) => a.at.y - b.at.y);
  for (let i = people.length - 1; i >= 0; i--) {
    const { d, at } = people[i];
    const b = (boxOf && boxOf(d, at)) || { x: d.x + at.x - d.seat.x, y: d.y + at.y - d.seat.y, w: d.w, h: d.h };
    if (x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h) return d;
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
 * free; else it waits for another round. Returns the placed ones, each with its `dy` (0 or -lift). `rank` (optional,
 * bubbleRank): a lower one goes first (else: calling 0, the rest 2); `blocked`: boxes no bubble may cover (name tags).
 */
export function placeBubbles(items, lift = 22, blocked = []) {
  const rank = (it) => (it.rank ?? (it.calling ? 0 : 2));
  const order = [...items].sort((a, b) => (rank(a) - rank(b)) || (b.shown - a.shown) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const taken = [...blocked], out = [];
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

/** Who speaks first when bubbles compete: calling for the person, then working, then everyone else. */
export const bubbleRank = (state) => (CALLING.has(state) ? 0 : state === "working" ? 1 : 2);
/** At most this many bubbles in an area over capacity (#2513). */
export const CROWD_BUBBLES = 3;
/** States whose bubbles are left out in an area over capacity (the chatter; a call or work still speaks). */
const QUIET_IN_CROWD = new Set(["idle", "paused", "stopped", "starting", "queued"]);
/**
 * The bubbles a frame may show (#2513): in an area over capacity (`over`), none for idle or asleep people and at most
 * CROWD_BUBBLES, the highest ranked first (bubbleRank); elsewhere all of them. `items`: { area, state, shown, key, … }.
 */
export function thinBubbles(items, over) {
  const byArea = new Map(), out = [];
  for (const it of items) {
    if (!over || !over.has(it.area)) { out.push(it); continue; }
    if (QUIET_IN_CROWD.has(it.state)) continue;
    if (!byArea.has(it.area)) byArea.set(it.area, []);
    byArea.get(it.area).push(it);
  }
  for (const list of byArea.values()) {
    list.sort((a, b) => (bubbleRank(a.state) - bubbleRank(b.state)) || (b.shown - a.shown) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    out.push(...list.slice(0, CROWD_BUBBLES));
  }
  return out;
}

/** The lines for a state: the skin's (in the page's language), else the page's own. */
export function linesFor(state, lang, pack, defaults) {
  const mine = pack && own(own(pack.bubbles, lang), state);
  return Array.isArray(mine) && mine.length ? mine : own(defaults, state) || [];
}

// ── Furniture ──

/** The furniture active now: an item whose `activeWhen` names a state someone shown is in. */
export function activeFurniture(pack, states, byName = new Map()) {
  const on = new Set();
  for (const f of (pack && pack.furniture) || []) {
    if (!f.activeWhen) continue;
    // activeFor (#2570): only those people's states count; else anyone's shown.
    const hit = f.activeFor ? f.activeFor.some((n) => byName.has(n) && f.activeWhen.includes(byName.get(n))) : f.activeWhen.some((s) => states.has(s));
    if (hit) on.add(f.id);
  }
  return on;
}
