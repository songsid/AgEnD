// A pack's vehicles (fleet-office-pack.js `vehicles`): a train round a loop of track. Where one is is a function of the
// wall clock alone, so every page shows it in the same place: it runs round its path at its speed and waits at each
// stop. People ride by their own choice (an agent's office_set `ride`): they walk to the platform, wait for the train
// to stop there, board, and ride in a seat (working there, moving with it); they get off only when it stops at a
// platform, then walk on. A pack may give an agent a seat as its workplace (#4503: a seat's `worker`): it rides there
// while working, and waits for the train at its seat's `queue` point. Pure — fleet-office.js draws the vehicles and
// moves the riders (the walkers' `ride`).

import { WALK, WANDER } from "./fleet-office-zones.js";

const LEGS = new WeakMap();
/** A vehicle's timetable: each leg (a path segment, then its stop's wait), in ms, and the whole lap. */
function legsOf(v) {
  let t = LEGS.get(v);
  if (t) return t;
  const n = v.path.length, wait = new Map(v.stops.map((s, i) => [s.at, i])), legs = [];
  let at = 0;
  for (let i = 0; i < n; i++) {
    const a = v.path[i], b = v.path[(i + 1) % n], len = Math.hypot(b.x - a.x, b.y - a.y), ms = (len / v.speed) * 1000;
    if (ms > 0) { legs.push({ kind: "run", a, b, from: at, ms }); at += ms; }
    const k = (i + 1) % n;
    if (wait.has(k)) { const si = wait.get(k), s = v.stops[si]; legs.push({ kind: "stop", at: v.path[k], stop: si, from: at, ms: s.seconds * 1000, h: unit(a, b) }); at += s.seconds * 1000; }
  }
  t = { legs, lap: at };
  LEGS.set(v, t);
  return t;
}
const unit = (a, b) => { const d = Math.hypot(b.x - a.x, b.y - a.y); return d > 0 ? { x: (b.x - a.x) / d, y: (b.y - a.y) / d } : { x: 1, y: 0 }; };

/**
 * Where vehicle `v` is at wall-clock `ms`: { x, y, heading: { x, y } (unit), stop: the stop index it waits at or null,
 * left: ms until it leaves (at a stop) }.
 */
export function vehicleAt(v, ms) {
  const { legs, lap } = legsOf(v);
  if (!(lap > 0)) return { x: v.path[0].x, y: v.path[0].y, heading: { x: 1, y: 0 }, stop: null, left: 0 };
  const t = ((ms % lap) + lap) % lap;
  for (const g of legs) {
    if (t >= g.from + g.ms) continue;
    const f = (t - g.from) / g.ms;
    if (g.kind === "stop") return { x: g.at.x, y: g.at.y, heading: g.h, stop: g.stop, left: g.ms - (t - g.from) };
    return { x: g.a.x + (g.b.x - g.a.x) * f, y: g.a.y + (g.b.y - g.a.y) * f, heading: unit(g.a, g.b), stop: null, left: 0 };
  }
  const last = legs[legs.length - 1];
  return last.kind === "stop" ? { x: last.at.x, y: last.at.y, heading: last.h, stop: last.stop, left: 0 } : { x: last.b.x, y: last.b.y, heading: unit(last.a, last.b), stop: null, left: 0 };
}

/** Which way a vehicle faces, for its picture: the heading's main axis. */
export const facing = (h) => (Math.abs(h.x) >= Math.abs(h.y) ? (h.x < 0 ? "left" : "right") : (h.y < 0 ? "up" : "down"));

/**
 * Seat `i` of vehicle `v` where it is (`at`, vehicleAt's), its offset (`dx` along the car, `dy` across it, as drawn
 * heading right) placed for the way the car faces: right (dx, dy); left (−dx, dy) — the same deck, mirrored, as the
 * picture is; down (−dy, dx); up (dy, −dx) — the car turned a quarter.
 */
export function seatAt(v, at, i) {
  const s = v.seats[i] || { dx: 0, dy: 0 }, f = facing(at.heading);
  const [ox, oy] = f === "right" ? [s.dx, s.dy] : f === "left" ? [-s.dx, s.dy] : f === "down" ? [-s.dy, s.dx] : [s.dy, -s.dx];
  return { x: Math.round(at.x + ox), y: Math.round(at.y + oy) };
}

/** How close (logical units) to the platform someone must stand to board, and the least wait left to step on. */
export const RIDE = { NEAR: 8, BOARD_MS: 400, SETTLE_MS: 60000 };
/** One lap of vehicle `v`, running and waiting (ms). */
export const lapMs = (v) => legsOf(v).lap;

/**
 * Who is riding, waiting or on their way (one page's own; every page works it out alike from the same clock and acts).
 * step({ wants, vehicles, wall, posOf, homeOf }) once a tick:
 * - `wants`: name → the vehicle id they want to ride, or null (`null` for everyone else in the office);
 * - `vehicles`: id → vehicle; `wall`: the wall clock; `posOf(name)`: where they are ({ x, y, walking }) or null;
 *   `homeOf(name)`: their seat (to pick the nearest platform); `sinceOf(name)`: when their ride began (wall clock), so
 *   a page opened long after shows them on board, not walking to a train they took long ago; `urgent(name)`: they
 *   must get off now (a call: #4415, nothing keeps a caller from the Help desk), where their seat is, between stops too.
 * Returns { targets: name → where to walk now (the platform, or their queue point), board: [{ name, vehicle, seat }], alight: [{ name, at }] };
 * `riding(name)` → { vehicle, seat } while on board; `clear()` forgets everyone and returns who was on board.
 */
export function createRiders() {
  const by = new Map();
  const near = (a, b) => !!a && !!b && Math.hypot(a.x - b.x, a.y - b.y) <= RIDE.NEAR;
  return {
    step({ wants, vehicles, wall, posOf, homeOf, sinceOf = null, urgent = null }) {
      const targets = new Map(), board = [], alight = [];
      for (const name of [...by.keys()]) if (!wants.has(name)) by.delete(name);   // gone from the office
      const used = (vid) => new Set([...by.values()].filter((r) => r.phase === "riding" && r.vehicle === vid).map((r) => r.seat));
      for (const [name, vid] of wants) {
        let r = by.get(name);
        const v = vid ? vehicles.get(vid) : null;
        if (r && r.phase === "riding") {
          const rv = vehicles.get(r.vehicle);
          if (!rv) {                                                               // its vehicle is gone: off where they are
            const p = posOf(name);
            if (p) alight.push({ name, at: { x: p.x, y: p.y } });
            by.delete(name); continue;
          }
          const at = vehicleAt(rv, wall);
          if (urgent && urgent(name)) { alight.push({ name, at: seatAt(rv, at, r.seat) }); by.delete(name); continue; }
          if (v && vid === r.vehicle) continue;                                    // riding on
          if (at.stop !== null) { alight.push({ name, at: rv.stops[at.stop].platform }); by.delete(name); }
          continue;                                                                // off only at a stop
        }
        if (!v || !v.seats.length || !v.stops.length) { if (r) by.delete(name); continue; }
        // #4503: a seat with a `worker` is theirs alone; they take no other, and everyone else takes only the others.
        const own = v.seats.findIndex((s) => s.worker === name);
        const freeSeat = () => { const taken = used(vid); return own >= 0 ? (taken.has(own) ? -1 : own) : v.seats.findIndex((s, i) => !s.worker && !taken.has(i)); };
        // A page opened long after the ride began (more than a lap and the walk ago, `since`): they are on board already.
        const since = sinceOf ? sinceOf(name) : null;
        if (!r && since !== null && wall - since > lapMs(v) + RIDE.SETTLE_MS) {
          const seat = freeSeat();
          if (seat >= 0) { by.set(name, { phase: "riding", vehicle: vid, seat }); board.push({ name, vehicle: vid, seat }); continue; }
        }
        if (!r || r.vehicle !== vid) {
          const home = homeOf(name) || posOf(name) || v.stops[0].platform;
          let best = 0;
          v.stops.forEach((s, i) => { if (Math.hypot(s.platform.x - home.x, s.platform.y - home.y) < Math.hypot(v.stops[best].platform.x - home.x, v.stops[best].platform.y - home.y)) best = i; });
          r = { phase: "going", vehicle: vid, stop: best, track: v.path[v.stops[best].at] };
          by.set(name, r);
        }
        // A worker waits at their seat's queue point (#4503), and steps onto the platform ("stepping") once the train is in.
        const stop = v.stops[r.stop], platform = stop.platform, wait = (stop.queue && stop.queue[own]) || platform, here = posOf(name);
        const at = vehicleAt(v, wall), open = at.stop === r.stop && at.left >= RIDE.BOARD_MS;
        if (r.phase === "stepping" && !open) r.phase = "going";                    // it left before they got there: back in line
        targets.set(name, r.phase === "stepping" ? platform : wait);
        if (r.phase === "going" && here && !here.walking && near(here, wait)) r.phase = "waiting";
        if (r.phase !== "waiting" && r.phase !== "stepping") continue;
        if (!open) continue;                                                       // the train is not in (or is leaving)
        const seat = freeSeat();
        if (seat < 0) continue;                                                    // full: wait for the next one
        if (!near(here, platform)) {
          // Off the platform: step on only with the time to get there (the walk, then up to a tick till it is seen), else wait.
          if (r.phase === "waiting" && at.left < Math.hypot(wait.x - platform.x, wait.y - platform.y) / WALK.SPEED + WANDER.TICK + RIDE.BOARD_MS) continue;
          r.phase = "stepping"; targets.set(name, platform);
          continue;
        }
        r.phase = "riding"; r.seat = seat;
        targets.delete(name);
        board.push({ name, vehicle: vid, seat });
      }
      return { targets, board, alight };
    },
    riding(name) { const r = by.get(name); return r && r.phase === "riding" ? { vehicle: r.vehicle, seat: r.seat } : null; },
    /** #4503: where the train they wait for (or walk to) stops, or null. */
    waitingFor(name) { const r = by.get(name); return r && r.phase !== "riding" ? r.track : null; },
    phase(name) { const r = by.get(name); return r ? r.phase : null; },
    clear() { const on = [...by].filter(([, r]) => r.phase === "riding").map(([n]) => n); by.clear(); return on; },
  };
}
