// M-3293 (#4119, the light version): play in the Office — pick a person up and drop them anywhere (they walk back to their
// seat along the usual route), and pat or feed them (a few hearts rising over the head and a speech bubble). M-3432
// (#4255): custom snacks from the active skin pack — drag onto a character to feed (plays optional `eat` strip), or drop
// on empty floor so nearby idle characters race to it (first eats, others scatter). The viewer's own: never stored on the
// host, never in a share link, never sent to an agent (unless Tell is ticked on their card). Pure — fleet-office.js wires
// it to the pointer, the walkers and the scene.
//
// Who may play: a single zones office on the dashboard itself (not All offices, not a share link's page, not while Edit
// layout is open), with the viewer's "Drag and pat" on (per device, on by default) — and never with reduced motion.
import { LOGICAL, SNACK_LIMITS, own, stripDurationMs } from "./fleet-office-pack.js";
import { nameHash } from "./fleet-office-model.js";
import { routeStaysInArea, WALK } from "./fleet-office-zones.js";

/**
 * LONG_MS: a touch held this long without moving picks a person up (a finger that moves first pans, as before); SLOP:
 * a mouse picks up once it moves this far (CSS px) — a press that never moves is a click (their card). REACT_MS: a
 * pat's or a feed's hearts and words last this long; HEARTS of them, rising RISE units.
 */
export const PLAY = { LONG_MS: 450, SLOP: 6, REACT_MS: 1800, HEARTS: 3, RISE: 26 };
export const PLAY_KINDS = ["pat", "feed"];

/** M-3432 (#4255): limits and timing for custom snacks, eating, and placed-snack races. */
export const SNACK = {
  MAX_PLACED: 6,
  MAX_RACERS: 4,
  TTL_MS: 30_000,
  CLAIM_DIST: 18,
  RACE_SPEED_MULT: 1.25,
  SPEED_VARIANCE: 0.08,
  EAT_MIN_MS: 800,
  EAT_MAX_MS: 10_000,
  EAT_DEFAULT_MS: 1800,
  SCATTER_MS: 1800,
};

/** Whether the viewer may play here: their toggle on, motion allowed, a single zones office of their own dashboard. */
export function playAllowed({ on, still, zones, overview, layout, shared }) {
  return !!on && !still && !!zones && !overview && !layout && !shared;
}

/**
 * M-3547: whether reduced motion is the only thing keeping play off here — the viewer's toggle on and a single zones
 * office of their own dashboard, but the device asks for reduced motion. The Office then says so where a person looks
 * for it (their card, and beside the greyed tick box); anywhere play is off for another reason, nothing is said.
 */
export function playOffForMotion({ on, still, zones, overview, layout, shared }) {
  return !!still && playAllowed({ on, still: false, zones, overview, layout, shared });
}

/**
 * The pick-up of one pointer: `down(id, type, x, y, t, name)` on a person (`name`; none: nothing to pick up) — a mouse
 * is "maybe" until it moves SLOP, a touch "press" until LONG_MS (`tick(t)`) or a move past SLOP first ("pan": the view's
 * own drag). Once "held", `move` carries them (`x`, `y` in the view's units; `px` the pointer's travel in CSS px decides
 * the slop). `up(id)` → { name, at } when they were held (dropped there), else null (a click, or a pan).
 */
export function createHold({ longMs = PLAY.LONG_MS, slop = PLAY.SLOP } = {}) {
  let s = null;
  return {
    down(id, type, x, y, t, name, cx = 0, cy = 0) {
      s = name ? { id, type, cx, cy, t0: t, name, state: type === "touch" ? "press" : "maybe", at: { x, y } } : null;
      return s ? s.state : null;
    },
    move(id, x, y, t, cx = 0, cy = 0) {
      if (!s || s.id !== id) return null;
      const far = Math.hypot(cx - s.cx, cy - s.cy) > slop;
      if (s.state === "maybe" && far) s.state = "held";
      else if (s.state === "press") { if (t - s.t0 >= longMs) s.state = "held"; else if (far) s.state = "pan"; }
      if (s.state === "held") s.at = { x, y };
      return s.state;
    },
    tick(t) { if (s && s.state === "press" && t - s.t0 >= longMs) s.state = "held"; return s ? s.state : null; },
    up(id) {
      if (!s || s.id !== id) return null;
      const r = s.state === "held" ? { name: s.name, at: { ...s.at } } : null;
      s = null;
      return r;
    },
    cancel() { s = null; },
    held() { return s && s.state === "held" ? { name: s.name, at: { ...s.at } } : null; },
    state() { return s ? s.state : null; },
  };
}

const WORDS = {
  en: { pat: "♪ Thanks!", feed: "Yum!" },
  "zh-TW": { pat: "♪ 謝謝！", feed: "好吃！" },
};
/** What a person says to a pat or a feed, in the page's language (English otherwise). */
export const reactWords = (kind, lang) => (WORDS[lang] || WORDS.en)[kind] || "";

/**
 * A reaction `r` ({ kind, t0 }) at `t`: its hearts — HEARTS of them over the head (dx, dy from the head, alpha), each
 * a little after the one before, rising and fading — and its words; null once it is over (or not started).
 */
export function reactionAt(r, t, lang = "en") {
  if (!r || !PLAY_KINDS.includes(r.kind)) return null;
  const f = (t - r.t0) / PLAY.REACT_MS;
  if (f < 0 || f >= 1) return null;
  const hearts = [];
  for (let i = 0; i < PLAY.HEARTS; i++) {
    const g = Math.min(1, Math.max(0, (f - i * 0.12) / (1 - (PLAY.HEARTS - 1) * 0.12)));
    if (g <= 0) continue;
    hearts.push({ dx: (i - (PLAY.HEARTS - 1) / 2) * 9, dy: -10 - g * PLAY.RISE, alpha: 1 - g });
  }
  return { f, hearts, say: reactWords(r.kind, lang) };
}

/** The look while a pat `r` shows at `t` (its own clip, so each pat plays from frame 0), or null. */
export function patLook(posed, r, t) {
  if (!r || r.kind !== "pat" || t < r.t0 || t >= (r.until ?? r.t0 + PLAY.REACT_MS)) return null;
  return { ...posed, pose: "pat", basePose: posed.pose, clip: `#pat${r.t0}` };
}

/** Reactions still showing at `t` (a Map name → { kind, t0, until? }; `until`: a pat strip's end), the rest dropped; whether any is left. */
export function pruneReactions(map, t) {
  for (const [n, r] of [...map]) if (t >= (r.until ?? r.t0 + PLAY.REACT_MS) || t < r.t0) map.delete(n);
  return map.size > 0;
}

const SCATTER_WORDS = { en: "Too slow!", "zh-TW": "被搶先了！" };
/** M-3432 (#4255): brief bubble for a losing snack racer heading back to their seat. */
export const scatterWords = (lang = "en") => SCATTER_WORDS[lang] || SCATTER_WORDS.en;

/** M-3432 (#4255): how long a character eats (ms) — clamped to [EAT_MIN_MS, EAT_MAX_MS], or EAT_DEFAULT_MS without an eat strip. */
export function eatDurationMs(charEatStrip = null, snackEatStrip = null) {
  const ms = Math.max(stripDurationMs(charEatStrip), stripDurationMs(snackEatStrip));
  return ms > 0 ? Math.max(SNACK.EAT_MIN_MS, Math.min(SNACK.EAT_MAX_MS, ms)) : SNACK.EAT_DEFAULT_MS;
}

/** M-3432 (#4255): deterministic speed multiplier for a racer chasing a placed snack (1.25× ± 8%). */
export function racerSpeedMult(name, snackKey) {
  const h = nameHash(`${name}\u0000${snackKey}`) % 1001;
  const frac = h / 500 - 1;
  return SNACK.RACE_SPEED_MULT * (1 + frac * SNACK.SPEED_VARIANCE);
}

function areaOfPoint(areas, pt) {
  if (!areas || typeof areas !== "object") return null;
  for (const [k, a] of Object.entries(areas)) {
    const r = a && a.rect;
    if (r && pt.x >= r.x && pt.x <= r.x + r.w && pt.y >= r.y && pt.y <= r.y + r.h) return k;
  }
  return null;
}

/**
 * M-3432 (#4255): client-local snack manager for a single zones office.
 * Handles direct feeds, placed snacks on the floor (max MAX_PLACED, TTL_MS expiry),
 * nearby idle racers (max MAX_RACERS per snack, honoring stayInArea), claim → eat, and losing-racer scatter.
 */
export function createSnacks() {
  let seq = 0;
  let placed = [];
  const eating = new Map();
  const scatter = new Map();

  const busySet = () => {
    const busy = new Set(eating.keys());
    for (const p of placed) for (const n of p.racers) busy.add(n);
    return busy;
  };

  const pickRacers = (item, t, { desks = [], walkers = null, hidden = null, ownArea = false, graph = null } = {}, cap = SNACK.MAX_RACERS) => {
    if (cap <= 0) return [];
    const busy = busySet();
    const candidates = [];
    for (const d of desks) {
      const name = d && d.node && d.node.name;
      if (!name || d.node.state !== "idle" || d.night) continue;
      if (busy.has(name) || (hidden && hidden.has(name))) continue;
      if (ownArea && (item.area === null || d.area !== item.area)) continue;
      const pos = (walkers && walkers.at(name, t)) || d.seat;
      if (!pos) continue;
      if (ownArea && graph && !routeStaysInArea(pos, { x: item.x, y: item.y }, graph, d.area, d.seat)) continue;
      const dist = Math.hypot(pos.x - item.x, pos.y - item.y);
      if (dist > item.radius) continue;
      candidates.push({ name, dist, eta: dist / racerSpeedMult(name, item.id) });
    }
    candidates.sort((a, b) => (a.eta - b.eta) || (a.dist - b.dist) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return candidates.slice(0, cap).map((c) => c.name);
  };

  const feed = (name, snack, { x, y, t, charEatStrip = null }) => {
    for (const p of placed) p.racers = p.racers.filter((n) => n !== name);
    scatter.delete(name);
    const durationMs = eatDurationMs(charEatStrip, snack && snack.eat);
    eating.set(name, { snackId: snack ? snack.id : null, x, y, t0: t, until: t + durationMs });
    return { durationMs };
  };

  return {
    feed,
    place(snack, at, t, ctx = {}) {
      if (!snack || !at) return null;
      const cw = (ctx.graph && ctx.graph.width) || LOGICAL.w, ch = (ctx.graph && ctx.graph.height) || LOGICAL.h;
      const x = Math.max(16, Math.min(cw - 16, Math.round(at.x)));
      const y = Math.max(16, Math.min(ch - 16, Math.round(at.y)));
      while (placed.length >= SNACK.MAX_PLACED) placed.shift();
      const item = {
        id: `sn-${++seq}`,
        snackId: snack.id,
        x,
        y,
        t0: t,
        radius: snack.radius ?? SNACK_LIMITS.defaultRadius,
        area: areaOfPoint(ctx.areas, { x, y }),
        racers: [],
      };
      item.racers = pickRacers(item, t, ctx, SNACK.MAX_RACERS);
      placed.push(item);
      return item;
    },
    step(t, ctx = {}) {
      const { desks = [], walkers = null, hidden = null, ownArea = false, graph = null, snacksById = null, charEatOf = null, onClaim = null } = ctx;
      let changed = false;
      for (const [n, e] of [...eating]) if (t >= e.until || t < e.t0) { eating.delete(n); changed = true; }
      for (const [n, s] of [...scatter]) if (t >= s.until || t < s.t0) scatter.delete(n);
      const deskByName = new Map(desks.filter((d) => d && d.node).map((d) => [d.node.name, d]));
      const kept = [];
      for (const p of placed) {
        if (t - p.t0 >= SNACK.TTL_MS || t < p.t0) { changed = true; continue; }
        const beforeLen = p.racers.length;
        p.racers = p.racers.filter((n) => {
          const d = deskByName.get(n);
          if (!d || d.node.state !== "idle" || d.night || eating.has(n) || (hidden && hidden.has(n))) return false;
          if (ownArea) {
            if (p.area === null || d.area !== p.area) return false;
            const pos = (walkers && walkers.at(n, t)) || d.seat;
            if (graph && pos && !routeStaysInArea(pos, { x: p.x, y: p.y }, graph, d.area, d.seat)) return false;
          }
          return true;
        });
        if (p.racers.length !== beforeLen) changed = true;
        // Check if any racer reached CLAIM_DIST.
        const reached = [];
        for (const n of p.racers) {
          const d = deskByName.get(n);
          const pos = (walkers && walkers.at(n, t)) || (d && d.seat);
          if (!pos) continue;
          const dist = Math.hypot(pos.x - p.x, pos.y - p.y);
          if (dist <= SNACK.CLAIM_DIST) reached.push({ name: n, dist, speed: racerSpeedMult(n, p.id) });
        }
        if (reached.length) {
          reached.sort((a, b) => (a.dist - b.dist) || (b.speed - a.speed) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
          const winner = reached[0].name;
          const losers = p.racers.filter((n) => n !== winner);
          const snack = snacksById ? snacksById.get(p.snackId) || null : null;
          const charEat = typeof charEatOf === "function" ? charEatOf(winner) : null;
          feed(winner, snack, { x: p.x, y: p.y, t, charEatStrip: charEat });
          for (const loser of losers) scatter.set(loser, { t0: t, until: t + SNACK.SCATTER_MS });
          if (typeof onClaim === "function") onClaim(winner, snack, p);
          changed = true;
          continue;
        }
        if (p.racers.length < SNACK.MAX_RACERS) {
          const added = pickRacers(p, t, { desks, walkers, hidden, ownArea, graph }, SNACK.MAX_RACERS - p.racers.length);
          if (added.length) { p.racers.push(...added); changed = true; }
        }
        kept.push(p);
      }
      placed = kept;
      return changed;
    },
    targets(t) {
      const out = new Map();
      for (const [name, e] of eating) {
        if (t >= e.t0 && t < e.until) out.set(name, { x: e.x, y: e.y });
      }
      for (const p of placed) {
        for (const name of p.racers) {
          if (!out.has(name)) out.set(name, { x: p.x, y: p.y, speed: WALK.SPEED * racerSpeedMult(name, p.id) });
        }
      }
      return out;
    },
    placedList() { return [...placed]; },
    eatingOf(name, t) {
      const e = eating.get(name);
      return e && t >= e.t0 && t < e.until ? e : null;
    },
    scatterOf(name, t) {
      const s = scatter.get(name);
      return s && t >= s.t0 && t < s.until ? s : null;
    },
    active(t) {
      if (placed.length > 0) return true;
      for (const e of eating.values()) if (t >= e.t0 && t < e.until) return true;
      for (const s of scatter.values()) if (t >= s.t0 && t < s.until) return true;
      return false;
    },
    /** M-3445: stop a picked-up character's active snack race/eating so dragging takes clean priority. */
    cancel(name) {
      if (!name) return;
      eating.delete(name);
      scatter.delete(name);
      for (const p of placed) p.racers = p.racers.filter((n) => n !== name);
    },
    clear() { placed = []; eating.clear(); scatter.clear(); },
  };
}

/** M-3445 (#4266): logical hit radius for dropping a dragged character onto another seat in their area. */
export const SEAT_DRAG = { DROP_RADIUS: 36 };

/** M-3445 (#4266): whether `name` is allowed by #2691 reservation rules to sit on `seat`. */
export function canSitOnSeat(seat, name) {
  if (!seat || !name) return false;
  return !seat.for || seat.for.includes(name) || seat.lend === true;
}

/**
 * M-3445 (#4266): every seat in `name`'s current area that `name` can legally be dropped onto without
 * violating #2691 seat reservations (owners keep priority over borrowers; an owner with a free/own reserved
 * seat chooses among their reserved seats). Returns [{ area, slot, x, y, current, occupant }].
 */
export function seatDropTargets(pack, desks, name) {
  if (!pack || !pack.areas || !Array.isArray(desks) || !name) return [];
  const d = desks.find((x) => x && x.node && x.node.name === name);
  if (!d) return [];
  const area = own(pack.areas, d.area);
  if (!area || !Array.isArray(area.seats) || !area.seats.length) return [];
  const occBySlot = new Map();
  for (const other of desks) {
    if (!other || !other.node || other.node.name === name || other.area !== d.area || other.slot < 0) continue;
    occBySlot.set(other.slot, other.node.name);
  }
  const mine = (s, who) => !!s.for && s.for.includes(who);
  const ownedSlots = [];
  for (let i = 0; i < area.seats.length; i++) if (mine(area.seats[i], name)) ownedSlots.push(i);
  const hasOwnClaim = ownedSlots.some((i) => {
    if (i === d.slot) return true;
    const occ = occBySlot.get(i);
    return !occ || !mine(area.seats[i], occ);
  });
  const out = [];
  for (let i = 0; i < area.seats.length; i++) {
    const s = area.seats[i], occ = occBySlot.get(i) || null;
    if (hasOwnClaim) {
      if (!mine(s, name)) continue;
      if (occ && mine(s, occ)) {
        const oldSeat = d.slot >= 0 ? area.seats[d.slot] : null;
        if (!oldSeat || !mine(oldSeat, occ)) continue;
      }
    } else {
      if (!canSitOnSeat(s, name)) continue;
      if (occ && mine(s, occ)) continue;
    }
    out.push({ area: d.area, slot: i, x: s.x, y: s.y, current: i === d.slot, occupant: occ });
  }
  return out;
}

/** M-3445 (#4266): nearest legal seat in `name`'s current area within `radius` of logical point `at`, or null. */
export function findSeatDropTarget(pack, desks, name, at, radius = SEAT_DRAG.DROP_RADIUS) {
  if (!at || !Number.isFinite(at.x) || !Number.isFinite(at.y)) return null;
  let best = null, bestDist = radius;
  for (const cand of seatDropTargets(pack, desks, name)) {
    const dist = Math.hypot(at.x - cand.x, at.y - cand.y);
    if (dist <= bestDist && (!best || dist < bestDist || cand.slot < best.slot)) {
      best = cand;
      bestDist = dist;
    }
  }
  return best;
}

/**
 * M-3445 (#4266): apply dropping `name` onto `target` seat in their area.
 * Updates live `seats` map and per-office `prefs` ({ [name]: { [area]: slot } }), swapping cleanly when the
 * target is occupied and the vacated seat is legal for the previous occupant, and clearing stale prefs for
 * taken slots so other agents returning to the area later do not collide.
 */
export function applySeatDrop({ pack, desks, seats, prefs, name, target }) {
  const nextSeats = new Map(seats || []);
  const nextPrefs = {};
  for (const [k, v] of Object.entries(prefs || {})) {
    if (v && typeof v === "object" && !Array.isArray(v)) nextPrefs[k] = { ...v };
  }
  const clearSlotPref = (areaName, slot, keepName) => {
    for (const [who, byArea] of Object.entries(nextPrefs)) {
      if (who === keepName || !byArea) continue;
      if (own(byArea, areaName) === slot) {
        delete byArea[areaName];
        if (!Object.keys(byArea).length) delete nextPrefs[who];
      }
    }
  };
  const d = Array.isArray(desks) ? desks.find((x) => x && x.node && x.node.name === name) : null;
  const area = pack && pack.areas ? own(pack.areas, target.area) : null;
  nextSeats.set(name, { area: target.area, slot: target.slot, x: target.x, y: target.y });
  nextPrefs[name] = { ...(nextPrefs[name] || {}), [target.area]: target.slot };
  clearSlotPref(target.area, target.slot, name);
  let swapped = null;
  const occ = target.occupant;
  if (occ && occ !== name) {
    const oldSlot = d && d.area === target.area && d.slot >= 0 ? d.slot : -1;
    const oldSeat = oldSlot >= 0 && area && area.seats ? area.seats[oldSlot] : null;
    if (oldSeat && canSitOnSeat(oldSeat, occ)) {
      nextSeats.set(occ, { area: target.area, slot: oldSlot, x: oldSeat.x, y: oldSeat.y });
      nextPrefs[occ] = { ...(nextPrefs[occ] || {}), [target.area]: oldSlot };
      clearSlotPref(target.area, oldSlot, occ);
      swapped = { name: occ, slot: oldSlot, seat: { x: oldSeat.x, y: oldSeat.y } };
    } else {
      nextSeats.delete(occ);
      if (nextPrefs[occ]) {
        delete nextPrefs[occ][target.area];
        if (!Object.keys(nextPrefs[occ]).length) delete nextPrefs[occ];
      }
    }
  }
  return { seats: nextSeats, prefs: nextPrefs, swapped };
}

/**
 * M-3445 (#4266): when `stayInArea` is enabled and a dragged character is dropped on empty floor (not on a seat),
 * ensure they land at a point whose walk back to `seat` stays inside `area` (clamping to the area rect, or
 * returning straight to `seat` if no in-area route exists).
 */
export function clampDropForArea(at, seat, graph, area) {
  if (!seat) return at;
  if (!at || !graph || !graph.areas) return seat;
  const a = own(graph.areas, area);
  if (!a || !a.rect) return seat;
  const r = a.rect;
  const inArea = (p) => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
  if (inArea(at) && routeStaysInArea(at, seat, graph, area, null)) return at;
  const pad = Math.min(4, r.w / 2, r.h / 2);
  const clamped = {
    x: Math.max(r.x + pad, Math.min(r.x + r.w - pad, at.x)),
    y: Math.max(r.y + pad, Math.min(r.y + r.h - pad, at.y)),
  };
  return routeStaysInArea(clamped, seat, graph, area, null) ? clamped : { x: seat.x, y: seat.y };
}

/**
 * M-3432 (#4255): owned snack-drag lifecycle controller.
 * Manages the four global pointer/key listeners with a single cancellation handle and generation fence so
 * drag replacement, play loss, Office/skin changes, and unmount immediately detach all listeners and block stale commits.
 */
export function createSnackDrag(win = globalThis) {
  let gen = 0;
  let cancelActive = null;
  return {
    active() { return cancelActive !== null; },
    start({ pid, sx, sy, slop = PLAY.SLOP, onMove, onCommit, onCancel }) {
      if (cancelActive) cancelActive();
      const myGen = ++gen;
      let dragging = false, lastDrop = null, live = true;
      const detach = () => {
        if (!live) return;
        live = false;
        win.removeEventListener?.("pointermove", onMoveEv, true);
        win.removeEventListener?.("pointerup", onUpEv, true);
        win.removeEventListener?.("pointercancel", onCancelEv, true);
        win.removeEventListener?.("keydown", onKeyEv, true);
        if (cancelActive === cancel) cancelActive = null;
      };
      const cancel = () => {
        if (!live) return;
        const wasDragging = dragging;
        detach();
        lastDrop = null;
        if (typeof onCancel === "function") onCancel({ dragging: wasDragging });
      };
      const finish = (commit) => {
        if (!live || myGen !== gen) return;
        const drop = lastDrop, wasDragging = dragging;
        detach();
        lastDrop = null;
        if (commit && wasDragging && drop) {
          if (typeof onCommit === "function") onCommit(drop);
        } else if (typeof onCancel === "function") {
          onCancel({ dragging: wasDragging });
        }
      };
      const onMoveEv = (ev) => {
        if (!live || myGen !== gen || ev.pointerId !== pid) return;
        const starting = !dragging && Math.hypot(ev.clientX - sx, ev.clientY - sy) > slop;
        if (starting) dragging = true;
        if (!dragging) return;
        lastDrop = typeof onMove === "function" ? onMove(ev, { starting }) : null;
      };
      const onUpEv = (ev) => { if (ev.pointerId === pid) finish(true); };
      const onCancelEv = (ev) => { if (ev.pointerId === pid) finish(false); };
      const onKeyEv = (ev) => { if (ev.key === "Escape") { ev.preventDefault?.(); finish(false); } };
      cancelActive = cancel;
      win.addEventListener?.("pointermove", onMoveEv, true);
      win.addEventListener?.("pointerup", onUpEv, true);
      win.addEventListener?.("pointercancel", onCancelEv, true);
      win.addEventListener?.("keydown", onKeyEv, true);
      return cancel;
    },
    retire() {
      gen++;
      if (cancelActive) cancelActive();
    },
  };
}
