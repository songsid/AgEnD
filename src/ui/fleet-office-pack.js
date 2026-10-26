// The Office view's skin-pack format, v1 (fleet-office-skin.js draws a checked pack; an admin uploads one — Fleet → Org
// chart → Office → Edit offices → Upload a skin pack — and the host keeps it, src/web-office-skins.ts, checking it with
// this same module: the page and the host agree on every rule).
// Its shape follows Star-Office-UI's scene (MIT; github.com/ringhyacinth/Star-Office-UI): one background on a 16:9
// logical canvas, named areas with ordered seat slots, furniture with a depth, and a state → area map. No code or art of
// it is used here — the idea of the format only.
//
// A pack is a JSON manifest plus images. Every coordinate is in logical units on a 1280×720 canvas (LOGICAL), which
// the page shows whole, then pans and zooms (fleet-office-view.js). Images are pixel art, drawn unsmoothed at `scale` logical units per image pixel.
//
//   {
//     "format": 1,                                    required
//     "id": "cozy",                                   letters, digits, - and _ (≤ 40); not a built-in skin's id
//     "scale": 2,                                     1–8 (default 2)
//     "background": "office.png",                     drawn over the whole 1280×720 canvas (16:9)
//     "foreground": "front.png",                      optional, with stateZones: drawn over the whole canvas (16:9, as
//                                                     the background) above the people, the furniture and the items in
//                                                     the air, below the name tags, bubbles and "+n" counts (and Edit
//                                                     layout's overlay): door frames, pillars, table fronts that hide
//                                                     whoever walks behind them — transparent everywhere else
//     "matte": "#1b1d24",                             optional (#2540): the colour around the scene where the Office
//                                                     view's panel is not 16:9 (or is zoomed out), "#rrggbb"; without it
//                                                     the page samples the background's edge pixels
//     "areas": {                                      named zones: a rect [x, y, w, h] and its seats, in the order
//       "desks":  { "rect": [40, 120, 620, 440], "seats": [[120, 220], [260, 220], …] },    they fill up
//       "lounge": { "rect": [700, 120, 540, 260], "seats": [[760, 260], …] } },
//                                                     a seat is [x, y], or (#2691) { "x": 760, "y": 260, "for":
//                                                     ["atlas", …], "lend": false }: reserved for those instances
//                                                     (names checked like byInstance's, ≤ 16, none twice) — whoever
//                                                     of them comes to the area takes it first, and nobody else does
//                                                     unless "lend" (default false) lends it while they are all
//                                                     elsewhere (a borrower moves off when one comes). A checked
//                                                     seat is { x, y } — plus, reserved, `for` and `lend`
//     "stateZones": { "working": "desks", "idle": "lounge", "needs": "alert", "default": "lounge" },
//                                                     the org chart's states (fleet-org.js ORG_STATES) → an area; a
//                                                     state it does not name goes to "default", else the first area
//     "door": [640, 700],                             optional: where someone new walks in from (default: bottom middle)
//     "waypoints": [{ "id": "hall", "x": 640, "y": 600 }, …], "edges": [["hall", "east"], …],
//                                                     optional: the walkable graph (else people walk straight)
//     "straight": true,                               optional (#2634): every walk goes across, then up or down — each
//                                                     diagonal leg an L, so the walkSide / walkDown / walkUp strips
//                                                     always fit (graph edges laid out across and up/down put the
//                                                     corners on the aisles); default false
//     "furniture": [ { "id": "rack", "sprite": STRIP, "x": 1020, "y": 140, "depth": 2,
//                      "activeWhen": "crashed", "activeSprite": STRIP, "activeFor": "atlas", "loop": true, "label": "Rack",
//                      "night": { "sprite": STRIP, "x": 300, "y": 420 },
//                      "walk": { "walk": STRIP, "walkDown": STRIP, "walkUp": STRIP, "walkSide": STRIP } } ],
//                                                     "label" (#2574): a name tag under it, like a person's
//                                                     (an NPC drawn as furniture). "night" (#2568), optional: at bedtime
//                                                     (when the viewer has it on: 00:00–06:00 their time) drawn as this
//                                                     strip, playing, at (x, y) — its own place for either left out.
//                                                     "walk" (#2596), optional: it strolls near its (x, y) and back
//                                                     like an idle person, drawn walking by these strips as a
//                                                     character set's walking poses ("walk" required); not at bedtime
//                                                     with a "night".
//                                                     drawn by depth: below 1000 under the people, 1000 and up over
//                                                     them; "depth": "y" (the string) sorts it among the people by base
//                                                     y — its anchor's y against each person's feet: someone whose feet
//                                                     are lower down (a greater y; a tie too) is drawn after it, in
//                                                     front. (x, y) is where the strip's anchor goes. `activeWhen` (a
//                                                     state, or a list): while anyone shown is in it, the item plays its
//                                                     strip (or `activeSprite`); otherwise it holds the first frame —
//                                                     or, with "loop": true (#2570), plays its strip all along.
//                                                     "activeFor" (an instance's name, or a list): only their state
//                                                     counts, not anyone's (a room several people take turns in)
//     "characters": { "default": { "working": STRIP, "idle": STRIP, "paused": STRIP, "needs": STRIP, "walk": STRIP,
//                                  "walkDown": STRIP, "walkUp": STRIP, "walkSide": STRIP },
//                     "fox": { … } },                 "default" with at least "idle" is required; a missing pose is idle.
//                                                     Walking (poseStrip): the current step's main axis picks the strip —
//                                                     |dy| > |dx|: walkDown (dy > 0, toward the viewer) or walkUp; else
//                                                     walkSide, drawn as it is when moving right and mirrored when moving
//                                                     left (so draw it facing right). A missing one is "walk", then idle
//                                                     ("walk" itself is never mirrored)
//                                                     A set may also have "prop": STRIP (#2562) — what its people
//                                                     send: their messages, work and reports fly as it, in place of
//                                                     the pack's "props" (a set without one: the pack's props)
//     "byInstance": { "atlas": "fox" },               optional: an instance name → its character set
//     "props": { "task": STRIP, "send": STRIP, "report": STRIP, "broadcast": STRIP },   optional traffic items
//     "bubbles": { "en": { "working": ["On it."] }, "zh-TW": { … } }   optional: short lines per state (≤ 12 a state,
//                                                     ≤ 40 characters each), in place of the page's own
//     "room": { "floor": "floor.png", "wall": "wall.png" }, "desk": { "back": …, "front": …, "lit": … }
//                                                     optional: for the desks layout (a pack without stateZones)
//   }
//
// A STRIP is { "src": "idle.png", "frames": 4, "w": 32, "h": 48, "fps": 4, "ax": 16, "ay": 44 }: `frames` frames of
// w×h image pixels side by side, left to right, no gaps (the image is frames·w × h; 4 frames is usual for a pose, 2 for
// walk, 1 for still furniture); played at `fps` (0: the first frame only — as reduced motion shows everything); (ax, ay)
// the image point put on the position (a character's seat is where its feet are). Suggested sizes at scale 2: a
// character 32×48, a prop 12×12, furniture as drawn. `src` is a file name in the pack: letters, digits, . _ - and /, no
// "..". The check is strict: an unknown key, a value out of range or a name that refers to nothing refuses the pack,
// with where it broke.
//
// Its displayed size: w·scale × h·scale logical units, unless the strip says `dw` and/or `dh` (logical units, 1–1280 and
// 1–720): its frame is then drawn dw × dh (still unsmoothed: nearest neighbour), and with only one of them the other keeps
// the frame's aspect. The anchor (ax, ay) stays in image pixels and moves with it. So art drawn at 120×120 px shows at
// 96×96 with "dw": 96, "dh": 96 — whatever the pack's scale. What a person hovers or clicks is the box drawn (stripBox).
//
// A name the pack declares and refers to (an area, a character set, a furniture item, an instance in byInstance, and the
// same in an office's overrides) is never one an object already has (Object.prototype's: "constructor", "toString",
// "__proto__", …): such a name is refused, and every lookup is of the pack's own names only (own()).
//
// The host keeps an uploaded pack whole and never changes it: every PNG starts with its signature, a STRIP's image is
// exactly frames·w × h, the background and the foreground are 16:9, and each file and the pack have a size cap (web-office-skins.ts).
//
// ── Layout overrides (the Office view's "Edit layout": a stored office's own positions on a zones pack) ──
//
// An office may keep `overrides` beside its skin — the pack stays as it was uploaded; the office moves things on it:
//
//   { "pack": "cozy",                                 the pack they were made on (on another pack they are ignored)
//     "seats": { "desks": [[120, 220], …] },          an area's seats: as many as the pack's, each inside the area's rect
//     "furniture": { "rack": [1000, 150] },           an item's (x, y)
//     "furnitureNight": { "elder": [300, 420] },      an item's night place (#2665: an item with a "night" only)
//     "seatFor": { "desks": { "0": { "for": ["atlas"], "lend": false } } },
//                                                     a seat's reservation by area and slot (#2691), in place of the
//                                                     pack's own for that seat; "for": [] is none (lends nothing)
//     "door": [640, 700],
//     "waypoints": [{ "id": "hall", "x": 640, "y": 600 }, …], "edges": [["hall", "east"], …] }
//                                                     the walkable graph, replaced whole (edges need waypoints)
//
// Every coordinate is on the same 1280×720 logical canvas, in the same ranges as the pack's. checkLayoutOverrides is
// the shape (the host checks it on every PUT /ui/offices); applyOverrides puts them on a checked pack, refusing a
// seat outside its area, an area or furniture the pack does not have, or a seat count that differs (the host checks
// that too, for a pack it keeps). A night place goes on the item's `night` (its x, y), so at bedtime (nightFurniture)
// it is the office's, else the pack's night x/y, else the item's (moved) day place. The host keeps `furnitureNight`
// and `seatFor` (#2691) beside the offices on disk, never inside them: an older host's stricter check would drop the
// office (#2665, web-office-store.ts).

export const LOGICAL = { w: 1280, h: 720 };
/** The people's depth: furniture below it is drawn under them, the rest over them. */
export const CHAR_DEPTH = 1000;
export const PACK_STATES = ["needs", "crashed", "stuck", "working", "idle", "paused", "stopped", "missing"];
const POSES = ["working", "idle", "paused", "needs", "walk", "walkDown", "walkUp", "walkSide"], PROPS = ["task", "send", "report", "broadcast"];
/** A character set's strips: its poses, and what its people send (#2562). */
const SET_STRIPS = [...POSES, "prop"];
/** A furniture item's walking strips (#2596): a character set's walking poses. */
const WALKS = ["walk", "walkDown", "walkUp", "walkSide"];
const BUILT_IN = new Set(["pixel", "studio"]);
/**
 * Ids built in after packs could be uploaded under them (#2631: "cozy"): a new upload is refused, but a pack the host
 * kept under one before (`kept`) is still read back, listed and deletable, and wins the id for the offices that name it.
 */
const RESERVED = new Set(["cozy"]);
const ID = /^[A-Za-z0-9_-]{1,40}$/;
const SRC = /^[A-Za-z0-9._/-]{1,200}$/;
const HEX = /^#[0-9a-f]{6}$/i;
const LIMIT = { areas: 32, seats: 64, furniture: 128, waypoints: 512, edges: 2048, sets: 64, byInstance: 500, lines: 12, line: 40, seatFor: 16 };

class Refused extends Error { constructor(at, why) { super(`${at}: ${why}`); } }
/** `o[k]` when it is o's own property, else undefined: a name from a pack or a page never reaches Object.prototype. */
export const own = (o, k) => (o !== null && typeof o === "object" && typeof k === "string" && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined);
/** Whether `k` is a name every object already has ("constructor", "toString", "__proto__", …): never a pack's name. */
export const inherited = (k) => typeof k === "string" && k in Object.prototype;
/** A name a pack declares or refers to: ID's letters, never an inherited one. */
const nameOk = (k) => typeof k === "string" && ID.test(k) && !inherited(k);
const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
function keys(v, allowed, at) { for (const k of Object.keys(v)) if (!allowed.includes(k)) throw new Refused(at, `unknown key "${k}"`); }
function obj(v, at) { if (!isObj(v)) throw new Refused(at, "an object"); return v; }
function int(v, lo, hi, at) { if (!Number.isInteger(v) || v < lo || v > hi) throw new Refused(at, `a whole number from ${lo} to ${hi}`); return v; }
function num(v, lo, hi, at) { if (typeof v !== "number" || !Number.isFinite(v) || v < lo || v > hi) throw new Refused(at, `a number from ${lo} to ${hi}`); return v; }
function src(v, at) { if (typeof v !== "string" || !SRC.test(v) || v.includes("..") || v.startsWith("/")) throw new Refused(at, "a file name in the pack"); return v; }
function point(v, at) {
  if (!Array.isArray(v) || v.length !== 2) throw new Refused(at, "[x, y]");
  return { x: num(v[0], 0, LOGICAL.w, `${at}[0]`), y: num(v[1], 0, LOGICAL.h, `${at}[1]`) };
}
/** Where an item sorts: by depth, a "y" one among the people (after every number under them, before the rest). */
const order = (f) => (f.depth === "y" ? CHAR_DEPTH - 0.5 : f.depth);
/** A furniture item's numeric depth (its "y" is taken before this). */
function depth(v, at) { if (!Number.isInteger(v) || v < -10000 || v > 10000) throw new Refused(at, 'a whole number from -10000 to 10000, or "y"'); return v; }
function list(v, max, at) { if (!Array.isArray(v)) throw new Refused(at, "a list"); if (v.length > max) throw new Refused(at, `at most ${max}`); return v; }

/** Whether `v` is a pack's `matte`: a colour as #rrggbb (six hex digits, either case). */
export const matteOk = (v) => typeof v === "string" && HEX.test(v);

/** A frame strip, strictly; `scale` the pack's (its displayed size, dw × dh, is resolved here). */
export function checkStrip(v, at = "strip", scale = 2) {
  obj(v, at);
  keys(v, ["src", "frames", "w", "h", "fps", "ax", "ay", "dw", "dh"], at);
  const w = int(v.w, 1, 512, `${at}.w`), h = int(v.h, 1, 512, `${at}.h`);
  const dw0 = v.dw === undefined ? null : num(v.dw, 1, LOGICAL.w, `${at}.dw`), dh0 = v.dh === undefined ? null : num(v.dh, 1, LOGICAL.h, `${at}.dh`);
  const dw = dw0 ?? (dh0 !== null ? (dh0 * w) / h : w * scale), dh = dh0 ?? (dw0 !== null ? (dw0 * h) / w : h * scale);
  return { src: src(v.src, `${at}.src`), frames: int(v.frames, 1, 32, `${at}.frames`), w, h, fps: v.fps === undefined ? 4 : num(v.fps, 0, 30, `${at}.fps`),
    ax: v.ax === undefined ? w / 2 : num(v.ax, 0, w, `${at}.ax`), ay: v.ay === undefined ? h : num(v.ay, 0, h, `${at}.ay`), dw, dh };
}
/** A furniture item's night (#2568): { sprite, x, y } — at bedtime it is drawn as `sprite` (playing) at (x, y), its own place when left out. */
function nightOf(v, at, scale) {
  if (v === undefined) return null;
  obj(v, at); keys(v, ["sprite", "x", "y"], at);
  return { sprite: checkStrip(v.sprite, `${at}.sprite`, scale), x: v.x === undefined ? null : num(v.x, 0, LOGICAL.w, `${at}.x`), y: v.y === undefined ? null : num(v.y, 0, LOGICAL.h, `${at}.y`) };
}
/** A furniture item's walk (#2596): its walking strips, picked by heading as a character set's (poseStrip); "walk" required. */
function walkOf(v, at, scale) {
  if (v === undefined) return null;
  const w = strips(v, WALKS, at, scale);
  if (!w.walk) throw new Refused(`${at}.walk`, "required");
  return w;
}
/** Whose state an item's activeWhen watches (#2570): an instance's name, or a list of up to `max` (8). */
function names(v, at, max = 8) {
  const one = (s, here) => { if (typeof s !== "string" || !s || s.length > 200 || inherited(s) || /[\u0000-\u001f\u007f]/.test(s)) throw new Refused(here, "an instance's name"); return s; };
  return Array.isArray(v) ? list(v, max, at).map((s, i) => one(s, `${at}[${i}]`)) : [one(v, at)];
}
/** Whom a seat is reserved for (#2691): instances' names (as names()), up to LIMIT.seatFor, none twice; `empty` may be []. */
function owners(v, at, empty = false) {
  const out = names(v, at, LIMIT.seatFor);
  if (!out.length && !empty) throw new Refused(at, "at least one instance");
  if (new Set(out).size !== out.length) throw new Refused(at, "a name twice");
  return out;
}
/**
 * A seat (#2691): [x, y], or { x, y, for, lend } — reserved for `for` (lent to anyone while they are all elsewhere when
 * `lend`). Checked: { x, y }, with `for` and `lend` only when reserved, so a plain seat is what it always was.
 */
function seatOf(v, at, rect) {
  let p = null, extra = {};
  if (isObj(v)) {
    keys(v, ["x", "y", "for", "lend"], at);
    p = { x: num(v.x, 0, LOGICAL.w, `${at}.x`), y: num(v.y, 0, LOGICAL.h, `${at}.y`) };
    if (v.lend !== undefined && typeof v.lend !== "boolean") throw new Refused(`${at}.lend`, "true or false");
    if (v.lend !== undefined && v.for === undefined) throw new Refused(`${at}.lend`, "only with for");
    if (v.for !== undefined) extra = { for: owners(v.for, `${at}.for`), lend: v.lend === true };
  } else p = point(v, at);
  if (p.x < rect.x || p.x > rect.x + rect.w || p.y < rect.y || p.y > rect.y + rect.h) throw new Refused(at, "outside its area's rect");
  return { ...p, ...extra };
}
function strips(v, names, at, scale) {
  obj(v, at);
  keys(v, names, at);
  return Object.fromEntries(Object.entries(v).map(([k, s]) => [k, checkStrip(s, `${at}.${k}`, scale)]));
}
function states(v, at) {
  const one = (s, here) => { if (!PACK_STATES.includes(s)) throw new Refused(here, `one of ${PACK_STATES.join(", ")}`); return s; };
  return Array.isArray(v) ? list(v, 8, at).map((s, i) => one(s, `${at}[${i}]`)) : [one(v, at)];
}

/**
 * A pack's manifest, strictly: { ok: true, pack } or { ok: false, error: "<where>: <why>" }. `kept`: a pack the host
 * keeps already (read back, not uploaded), which may hold a RESERVED id.
 */
export function checkSkinPack(x, { kept = false } = {}) {
  try {
    obj(x, "pack");
    keys(x, ["format", "id", "scale", "background", "foreground", "matte", "areas", "stateZones", "door", "waypoints", "edges", "straight", "furniture", "characters", "byInstance", "props", "bubbles", "room", "desk"], "pack");
    if (x.format !== 1) throw new Refused("format", "1");
    if (typeof x.id !== "string" || !ID.test(x.id)) throw new Refused("id", "1–40 letters, digits, _ or -");
    if (BUILT_IN.has(x.id) || (!kept && RESERVED.has(x.id))) throw new Refused("id", "a built-in skin's id");
    const scale = x.scale === undefined ? 2 : int(x.scale, 1, 8, "scale");
    if (x.matte !== undefined && !matteOk(x.matte)) throw new Refused("matte", "a colour as #rrggbb");
    if (x.straight !== undefined && typeof x.straight !== "boolean") throw new Refused("straight", "true or false");
    const areas = {};
    const rawAreas = x.areas === undefined ? {} : obj(x.areas, "areas");
    if (Object.keys(rawAreas).length > LIMIT.areas) throw new Refused("areas", `at most ${LIMIT.areas}`);
    for (const [name, a] of Object.entries(rawAreas)) {
      const at = `areas.${name}`;
      if (!nameOk(name)) throw new Refused(at, "a name of letters, digits, _ or - (not an inherited one)");
      obj(a, at); keys(a, ["rect", "seats"], at);
      if (!Array.isArray(a.rect) || a.rect.length !== 4) throw new Refused(`${at}.rect`, "[x, y, w, h]");
      const [rx, ry] = [num(a.rect[0], 0, LOGICAL.w, `${at}.rect[0]`), num(a.rect[1], 0, LOGICAL.h, `${at}.rect[1]`)];
      const rect = { x: rx, y: ry, w: num(a.rect[2], 1, LOGICAL.w - rx, `${at}.rect[2]`), h: num(a.rect[3], 1, LOGICAL.h - ry, `${at}.rect[3]`) };
      const seats = list(a.seats, LIMIT.seats, `${at}.seats`).map((s, i) => seatOf(s, `${at}.seats[${i}]`, rect));
      if (!seats.length) throw new Refused(`${at}.seats`, "at least one seat");
      areas[name] = { name, rect, seats };
    }
    let stateZones = null;
    if (x.stateZones !== undefined) {
      obj(x.stateZones, "stateZones");
      if (!Object.keys(areas).length) throw new Refused("stateZones", "needs areas");
      stateZones = {};
      for (const [s, area] of Object.entries(x.stateZones)) {
        if (s !== "default" && !PACK_STATES.includes(s)) throw new Refused(`stateZones.${s}`, `a state (${PACK_STATES.join(", ")}) or "default"`);
        if (typeof area !== "string" || !own(areas, area)) throw new Refused(`stateZones.${s}`, "an area the pack defines");
        stateZones[s] = area;
      }
      if (x.background === undefined) throw new Refused("background", "required with stateZones");
    }
    if (x.foreground !== undefined && !stateZones) throw new Refused("foreground", "only with stateZones");
    const waypoints = [], ids = new Set();
    for (const [i, w] of list(x.waypoints ?? [], LIMIT.waypoints, "waypoints").entries()) {
      const at = `waypoints[${i}]`;
      obj(w, at); keys(w, ["id", "x", "y"], at);
      if (typeof w.id !== "string" || !ID.test(w.id) || ids.has(w.id)) throw new Refused(`${at}.id`, "a new name of letters, digits, _ or -");
      ids.add(w.id);
      waypoints.push({ id: w.id, x: num(w.x, 0, LOGICAL.w, `${at}.x`), y: num(w.y, 0, LOGICAL.h, `${at}.y`) });
    }
    const edges = list(x.edges ?? [], LIMIT.edges, "edges").map((e, i) => {
      if (!Array.isArray(e) || e.length !== 2 || !ids.has(e[0]) || !ids.has(e[1]) || e[0] === e[1]) throw new Refused(`edges[${i}]`, "two different waypoint ids");
      return [e[0], e[1]];
    });
    const fids = new Set();
    const furniture = list(x.furniture ?? [], LIMIT.furniture, "furniture").map((f, i) => {
      const at = `furniture[${i}]`;
      obj(f, at); keys(f, ["id", "sprite", "x", "y", "depth", "activeWhen", "activeSprite", "activeFor", "loop", "label", "night", "walk"], at);
      if (!nameOk(f.id) || fids.has(f.id)) throw new Refused(`${at}.id`, "a new name of letters, digits, _ or - (not an inherited one)");
      fids.add(f.id);
      if (f.activeSprite !== undefined && f.activeWhen === undefined) throw new Refused(`${at}.activeSprite`, "only with activeWhen");
      if (f.activeFor !== undefined && f.activeWhen === undefined) throw new Refused(`${at}.activeFor`, "only with activeWhen");
      if (f.loop !== undefined && typeof f.loop !== "boolean") throw new Refused(`${at}.loop`, "true or false");
      if (f.label !== undefined && (typeof f.label !== "string" || !f.label.trim() || [...f.label].length > LIMIT.line || /[\u0000-\u001f\u007f]/.test(f.label))) throw new Refused(`${at}.label`, `1–${LIMIT.line} characters`);
      return { id: f.id, sprite: checkStrip(f.sprite, `${at}.sprite`, scale), x: num(f.x, 0, LOGICAL.w, `${at}.x`), y: num(f.y, 0, LOGICAL.h, `${at}.y`),
        depth: f.depth === "y" ? "y" : depth(f.depth ?? 0, `${at}.depth`), activeWhen: f.activeWhen === undefined ? null : states(f.activeWhen, `${at}.activeWhen`),
        activeSprite: f.activeSprite === undefined ? null : checkStrip(f.activeSprite, `${at}.activeSprite`, scale),
        activeFor: f.activeFor === undefined ? null : names(f.activeFor, `${at}.activeFor`), loop: f.loop === true, label: f.label === undefined ? null : f.label.trim(), night: nightOf(f.night, `${at}.night`, scale),
        walk: walkOf(f.walk, `${at}.walk`, scale) };
    }).sort((a, b) => order(a) - order(b));
    const sets = obj(x.characters, "characters");
    if (Object.keys(sets).length > LIMIT.sets) throw new Refused("characters", `at most ${LIMIT.sets} sets`);
    const characters = {};
    for (const [k, v] of Object.entries(sets)) {
      if (!nameOk(k)) throw new Refused(`characters.${k}`, "a name of letters, digits, _ or - (not an inherited one)");
      characters[k] = strips(v, SET_STRIPS, `characters.${k}`, scale);
      if (!characters[k].idle) throw new Refused(`characters.${k}.idle`, "required");
    }
    if (!own(characters, "default")) throw new Refused("characters.default", "required");
    const byInstance = {};
    const rawBy = x.byInstance === undefined ? {} : obj(x.byInstance, "byInstance");
    if (Object.keys(rawBy).length > LIMIT.byInstance) throw new Refused("byInstance", `at most ${LIMIT.byInstance}`);
    for (const [k, v] of Object.entries(rawBy)) {
      if (inherited(k)) throw new Refused(`byInstance.${k}`, "an instance's name (not an inherited one)");
      if (typeof v !== "string" || !own(characters, v)) throw new Refused(`byInstance.${k}`, "a character set the pack defines");
      byInstance[k] = v;
    }
    const bubbles = {};
    for (const [lang, table] of Object.entries(x.bubbles === undefined ? {} : obj(x.bubbles, "bubbles"))) {
      if (lang !== "en" && lang !== "zh-TW") throw new Refused(`bubbles.${lang}`, '"en" or "zh-TW"');
      obj(table, `bubbles.${lang}`);
      bubbles[lang] = {};
      for (const [s, lines] of Object.entries(table)) {
        const at = `bubbles.${lang}.${s}`;
        if (!PACK_STATES.includes(s)) throw new Refused(at, "a state");
        bubbles[lang][s] = list(lines, LIMIT.lines, at).map((l, i) => {
          if (typeof l !== "string" || !l.trim() || [...l].length > LIMIT.line || /[\u0000-\u001f\u007f]/.test(l)) throw new Refused(`${at}[${i}]`, `1–${LIMIT.line} characters`);
          return l.trim();
        });
      }
    }
    const room = x.room === undefined ? {} : obj(x.room, "room"), desk = x.desk === undefined ? {} : obj(x.desk, "desk");
    keys(room, ["floor", "wall"], "room"); keys(desk, ["back", "front", "lit"], "desk");
    const opt = (v, at) => (v === undefined ? undefined : src(v, at));
    return { ok: true, pack: {
      format: 1, id: x.id, scale, background: opt(x.background, "background"), foreground: opt(x.foreground, "foreground"), matte: x.matte === undefined ? undefined : x.matte.toLowerCase(), areas, stateZones,
      door: x.door === undefined ? { x: LOGICAL.w / 2, y: LOGICAL.h - 10 } : point(x.door, "door"), waypoints, edges, straight: x.straight === true, furniture, characters, byInstance,
      props: x.props === undefined ? {} : strips(x.props, PROPS, "props", scale), bubbles,
      room: { floor: opt(room.floor, "room.floor"), wall: opt(room.wall, "room.wall") }, desk: { back: opt(desk.back, "desk.back"), front: opt(desk.front, "desk.front"), lit: opt(desk.lit, "desk.lit") },
    } };
  } catch (err) {
    if (err instanceof Refused) return { ok: false, error: err.message };
    throw err;
  }
}
/** The checked pack, or null. */
export const skinPackOk = (x) => { const r = checkSkinPack(x); return r.ok ? r.pack : null; };
/** Every image a pack names (what a loader fetches before spriteSkin draws). */
export const packImages = (pack) => [...new Set([pack.background, pack.foreground, pack.room.floor, pack.room.wall, pack.desk.back, pack.desk.front, pack.desk.lit,
  ...pack.furniture.flatMap((f) => [f.sprite.src, f.activeSprite && f.activeSprite.src, f.night && f.night.sprite.src, ...Object.values(f.walk || {}).map((st) => st.src)]),
  ...Object.values(pack.characters).flatMap((s) => Object.values(s).map((st) => st.src)), ...Object.values(pack.props).map((st) => st.src)].filter(Boolean))];

/** Every frame strip a checked pack names, with where (the host checks each image is frames·w × h). */
export function packStrips(pack) {
  const out = [];
  for (const f of pack.furniture) {
    out.push({ at: `furniture.${f.id}.sprite`, strip: f.sprite });
    if (f.activeSprite) out.push({ at: `furniture.${f.id}.activeSprite`, strip: f.activeSprite });
    if (f.night) out.push({ at: `furniture.${f.id}.night.sprite`, strip: f.night.sprite });
    for (const [k, st] of Object.entries(f.walk || {})) out.push({ at: `furniture.${f.id}.walk.${k}`, strip: st });
  }
  for (const [k, set] of Object.entries(pack.characters)) for (const [pose, st] of Object.entries(set)) out.push({ at: `characters.${k}.${pose}`, strip: st });
  for (const [k, st] of Object.entries(pack.props)) out.push({ at: `props.${k}`, strip: st });
  return out;
}

// ── Layout overrides ──

const OV_LIMIT = { areas: LIMIT.areas, seats: LIMIT.seats, furniture: LIMIT.furniture, waypoints: LIMIT.waypoints, edges: LIMIT.edges };
/** A seat's slot in `seatFor` (#2691): its index in the area's order, as a key ("0", "1", …). */
const SLOT = /^(0|[1-9][0-9]{0,2})$/;
/** A seat's reservation as an override keeps it: { for, lend }, or null (not reserved). */
const reservedOf = (s) => (s.for && s.for.length ? { for: [...s.for], lend: s.lend === true } : null);
/** A seat with reservation `r` ({ for, lend }; for [] or null: none) in place of its own. */
const reserve = (s, r) => { const { for: _f, lend: _l, ...p } = s; return r && r.for.length ? { ...p, for: [...r.for], lend: r.lend === true } : p; };
/** An office's layout overrides, strictly (their shape and ranges): { ok: true, overrides } or { ok: false, error }. */
export function checkLayoutOverrides(x) {
  try {
    obj(x, "overrides");
    keys(x, ["pack", "seats", "furniture", "furnitureNight", "seatFor", "door", "waypoints", "edges"], "overrides");
    if (typeof x.pack !== "string" || !ID.test(x.pack)) throw new Refused("overrides.pack", "1–40 letters, digits, _ or -");
    const out = { pack: x.pack };
    if (x.seats !== undefined) {
      obj(x.seats, "overrides.seats");
      if (Object.keys(x.seats).length > OV_LIMIT.areas) throw new Refused("overrides.seats", `at most ${OV_LIMIT.areas} areas`);
      out.seats = {};
      for (const [area, list0] of Object.entries(x.seats)) {
        const at = `overrides.seats.${area}`;
        if (!nameOk(area)) throw new Refused(at, "an area's name");
        const pts = list(list0, OV_LIMIT.seats, at).map((p, i) => { const q = point(p, `${at}[${i}]`); return [q.x, q.y]; });
        if (!pts.length) throw new Refused(at, "at least one seat");
        out.seats[area] = pts;
      }
    }
    if (x.furniture !== undefined) {
      obj(x.furniture, "overrides.furniture");
      if (Object.keys(x.furniture).length > OV_LIMIT.furniture) throw new Refused("overrides.furniture", `at most ${OV_LIMIT.furniture}`);
      out.furniture = {};
      for (const [id, p] of Object.entries(x.furniture)) {
        if (!nameOk(id)) throw new Refused(`overrides.furniture.${id}`, "an item's id");
        const q = point(p, `overrides.furniture.${id}`);
        out.furniture[id] = [q.x, q.y];
      }
    }
    if (x.furnitureNight !== undefined) {
      obj(x.furnitureNight, "overrides.furnitureNight");
      if (Object.keys(x.furnitureNight).length > OV_LIMIT.furniture) throw new Refused("overrides.furnitureNight", `at most ${OV_LIMIT.furniture}`);
      out.furnitureNight = {};
      for (const [id, p] of Object.entries(x.furnitureNight)) {
        if (!nameOk(id)) throw new Refused(`overrides.furnitureNight.${id}`, "an item's id");
        const q = point(p, `overrides.furnitureNight.${id}`);
        out.furnitureNight[id] = [q.x, q.y];
      }
    }
    if (x.seatFor !== undefined) {
      obj(x.seatFor, "overrides.seatFor");
      if (Object.keys(x.seatFor).length > OV_LIMIT.areas) throw new Refused("overrides.seatFor", `at most ${OV_LIMIT.areas} areas`);
      out.seatFor = {};
      for (const [area, slots] of Object.entries(x.seatFor)) {
        const at = `overrides.seatFor.${area}`;
        if (!nameOk(area)) throw new Refused(at, "an area's name");
        obj(slots, at);
        if (Object.keys(slots).length > OV_LIMIT.seats) throw new Refused(at, `at most ${OV_LIMIT.seats} seats`);
        out.seatFor[area] = {};
        for (const [slot, r] of Object.entries(slots)) {
          const here = `${at}.${slot}`;
          if (!SLOT.test(slot) || Number(slot) >= OV_LIMIT.seats) throw new Refused(here, `a seat's number, 0 to ${OV_LIMIT.seats - 1}`);
          obj(r, here); keys(r, ["for", "lend"], here);
          if (!Array.isArray(r.for)) throw new Refused(`${here}.for`, "a list");
          if (r.lend !== undefined && typeof r.lend !== "boolean") throw new Refused(`${here}.lend`, "true or false");
          out.seatFor[area][slot] = { for: owners(r.for, `${here}.for`, true), lend: r.lend === true };
        }
      }
    }
    if (x.door !== undefined) { const q = point(x.door, "overrides.door"); out.door = [q.x, q.y]; }
    if (x.edges !== undefined && x.waypoints === undefined) throw new Refused("overrides.edges", "only with waypoints");
    if (x.waypoints !== undefined) {
      const ids = new Set();
      out.waypoints = list(x.waypoints, OV_LIMIT.waypoints, "overrides.waypoints").map((w, i) => {
        const at = `overrides.waypoints[${i}]`;
        obj(w, at); keys(w, ["id", "x", "y"], at);
        if (typeof w.id !== "string" || !ID.test(w.id) || ids.has(w.id)) throw new Refused(`${at}.id`, "a new name of letters, digits, _ or -");
        ids.add(w.id);
        return { id: w.id, x: num(w.x, 0, LOGICAL.w, `${at}.x`), y: num(w.y, 0, LOGICAL.h, `${at}.y`) };
      });
      const seen = new Set();
      out.edges = list(x.edges ?? [], OV_LIMIT.edges, "overrides.edges").map((e, i) => {
        if (!Array.isArray(e) || e.length !== 2 || !ids.has(e[0]) || !ids.has(e[1]) || e[0] === e[1]) throw new Refused(`overrides.edges[${i}]`, "two different waypoint ids");
        const k = e[0] < e[1] ? `${e[0]}\u0000${e[1]}` : `${e[1]}\u0000${e[0]}`;
        if (seen.has(k)) throw new Refused(`overrides.edges[${i}]`, "joined twice");
        seen.add(k);
        return [e[0], e[1]];
      });
    }
    return { ok: true, overrides: out };
  } catch (err) {
    if (err instanceof Refused) return { ok: false, error: err.message };
    throw err;
  }
}

/**
 * A checked pack with an office's checked overrides on it: { ok: true, pack } (a new object; the pack is untouched) or
 * { ok: false, error }. Overrides made on another pack change nothing (ok, the pack as it is).
 */
export function applyOverrides(pack, ov) {
  try {
    if (!ov || ov.pack !== pack.id) return { ok: true, pack };
    const areas = { ...pack.areas };
    for (const [name, pts] of Object.entries(ov.seats || {})) {
      const a = own(pack.areas, name), at = `overrides.seats.${name}`;
      if (!a) throw new Refused(at, "an area the pack defines");
      if (pts.length !== a.seats.length) throw new Refused(at, `${a.seats.length} seats, as the pack has`);
      const r = a.rect;
      areas[name] = { ...a, seats: pts.map(([x, y], i) => {
        if (x < r.x || x > r.x + r.w || y < r.y || y > r.y + r.h) throw new Refused(`${at}[${i}]`, "outside its area's rect");
        return { ...a.seats[i], x, y };                                                     // its reservation kept (#2691)
      }) };
    }
    for (const [name, slots] of Object.entries(ov.seatFor || {})) {
      const a = own(areas, name), at = `overrides.seatFor.${name}`;
      if (!a) throw new Refused(at, "an area the pack defines");
      for (const slot of Object.keys(slots)) if (!a.seats[Number(slot)]) throw new Refused(`${at}.${slot}`, `a seat the area has (it has ${a.seats.length})`);
      areas[name] = { ...a, seats: a.seats.map((s, i) => { const v = own(slots, String(i)); return v ? reserve(s, v) : s; }) };
    }
    const fids = new Set(pack.furniture.map((f) => f.id));
    for (const id of Object.keys(ov.furniture || {})) if (!fids.has(id)) throw new Refused(`overrides.furniture.${id}`, "an item the pack has");
    const nids = new Set(pack.furniture.filter((f) => f.night).map((f) => f.id));
    for (const id of Object.keys(ov.furnitureNight || {})) if (!nids.has(id)) throw new Refused(`overrides.furnitureNight.${id}`, "an item with a night the pack has");
    const furniture = pack.furniture.map((f) => {
      const q = own(ov.furniture, f.id), n = own(ov.furnitureNight, f.id);
      if (!q && !n) return f;
      return { ...f, ...(q ? { x: q[0], y: q[1] } : {}), ...(n ? { night: { ...f.night, x: n[0], y: n[1] } } : {}) };
    });
    const door = ov.door ? { x: ov.door[0], y: ov.door[1] } : pack.door;
    const graph = ov.waypoints ? { waypoints: ov.waypoints.map((w) => ({ ...w })), edges: (ov.edges || []).map((e) => [e[0], e[1]]) } : { waypoints: pack.waypoints, edges: pack.edges };
    return { ok: true, pack: { ...pack, areas, furniture, door, ...graph } };
  } catch (err) {
    if (err instanceof Refused) return { ok: false, error: err.message };
    throw err;
  }
}

/**
 * #2665: overrides with only the night places `pack` can take (an item it has, with a `night`): a pack changed since
 * (an item dropped, or its night) drops that entry, never the rest of the layout. applyOverrides itself stays strict
 * (a write naming an item the pack lacks is refused, as for `furniture`).
 */
export function fitNight(pack, ov) {
  if (!ov || !ov.furnitureNight || ov.pack !== pack.id) return ov;
  const ok = new Set(pack.furniture.filter((f) => f.night).map((f) => f.id));
  const kept = Object.entries(ov.furnitureNight).filter(([id]) => ok.has(id));
  if (kept.length === Object.keys(ov.furnitureNight).length) return ov;
  const { furnitureNight: _gone, ...rest } = ov;
  return kept.length ? { ...rest, furnitureNight: Object.fromEntries(kept) } : rest;
}

/**
 * #2691: overrides with only the reservations `pack` can take (an area it has, a seat that area has): a pack changed
 * since drops that entry, never the rest of the layout (as fitNight; applyOverrides stays strict).
 */
export function fitSeatFor(pack, ov) {
  if (!ov || !ov.seatFor || ov.pack !== pack.id) return ov;
  let dropped = false;
  const kept = {};
  for (const [area, slots] of Object.entries(ov.seatFor)) {
    const a = own(pack.areas, area);
    const ok = Object.entries(slots).filter(([slot]) => a && !!a.seats[Number(slot)]);
    // An area the pack no longer has is dropped even with no slots under it (`{}`: 0 kept of 0, yet applyOverrides refuses it).
    if (!a || ok.length !== Object.keys(slots).length) dropped = true;
    if (ok.length) kept[area] = Object.fromEntries(ok);
  }
  if (!dropped) return ov;
  const { seatFor: _gone, ...rest } = ov;
  return Object.keys(kept).length ? { ...rest, seatFor: kept } : rest;
}

/**
 * What an edited layout keeps as overrides: only the parts that differ from the pack's own (`edited` is a pack with
 * the same areas and furniture, positions moved); null when nothing does (the office goes back to the pack's).
 */
export function overridesBetween(pack, edited) {
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const ov = { pack: pack.id };
  for (const [name, a] of Object.entries(pack.areas)) {
    const e = own(edited.areas, name), xy = (s) => [s.x, s.y];
    if (e && !same(a.seats.map(xy), e.seats.map(xy))) (ov.seats ||= {})[name] = e.seats.map(xy);
    // #2691: a seat whose reservation differs from the pack's (none where the pack has one: for []).
    if (e) e.seats.forEach((s, i) => {
      const was = a.seats[i] ? reservedOf(a.seats[i]) : null, now = reservedOf(s);
      if (a.seats[i] && !same(was, now)) ((ov.seatFor ||= {})[name] ||= {})[String(i)] = now || { for: [], lend: false };
    });
  }
  const at = new Map(pack.furniture.map((f) => [f.id, f]));
  for (const f of edited.furniture) { const o = at.get(f.id); if (o && (o.x !== f.x || o.y !== f.y)) (ov.furniture ||= {})[f.id] = [f.x, f.y]; }
  // #2665: a night place that differs from the pack's (its own x/y, or in place: null); in place again is no entry.
  for (const f of edited.furniture) {
    const o = at.get(f.id);
    if (!o || !o.night || !f.night || f.night.x === null || f.night.y === null) continue;
    if (o.night.x !== f.night.x || o.night.y !== f.night.y) (ov.furnitureNight ||= {})[f.id] = [f.night.x, f.night.y];
  }
  if (pack.door.x !== edited.door.x || pack.door.y !== edited.door.y) ov.door = [edited.door.x, edited.door.y];
  if (!same(pack.waypoints, edited.waypoints) || !same(pack.edges, edited.edges)) {
    ov.waypoints = edited.waypoints.map((w) => ({ id: w.id, x: w.x, y: w.y }));
    ov.edges = edited.edges.map((e) => [e[0], e[1]]);
  }
  return Object.keys(ov).length > 1 ? ov : null;
}

// ── Drawing a strip: which one a pose shows, and the box it covers ──

/**
 * The strip a character set shows for `pose` (heading: the current step { dx, dy }, while walking): { strip, mirror }, or
 * null (no set). Walking: |dy| > |dx| → walkDown (dy > 0) or walkUp, else walkSide (mirror: moving left); a missing one
 * → "walk" (never mirrored) → idle. Any other pose: its own strip, else idle.
 */
export function poseStrip(set, pose, heading = null) {
  if (!set || typeof set !== "object") return null;
  if (pose === "walk" && heading) {
    const dx = Number(heading.dx) || 0, dy = Number(heading.dy) || 0;
    if (dx || dy) {
      const dir = Math.abs(dy) > Math.abs(dx) ? (dy > 0 ? "walkDown" : "walkUp") : "walkSide";
      const st = own(set, dir);
      if (st) return { strip: st, mirror: dir === "walkSide" && dx < 0 };
    }
  }
  const st = own(set, pose) || own(set, "idle");
  return st ? { strip: st, mirror: false } : null;
}
/** The strip a furniture item shows while it walks (#2596: an NPC with `walk`, `walking` and `heading` set where it is
 * drawn): its walk strip by heading, as a character's (poseStrip); null when it stands (its own sprite, as before). */
export const walkStrip = (f) => (f && f.walking && f.walk ? poseStrip(f.walk, "walk", f.heading) : null);
/** The box (logical units) a strip covers with its anchor at (x, y): its displayed size; mirrored about the anchor. */
export function stripBox(st, x, y, mirror = false) {
  const kx = st.dw / st.w, ky = st.dh / st.h;
  return { x: Math.round(x - (mirror ? st.w - st.ax : st.ax) * kx), y: Math.round(y - st.ay * ky), w: st.dw, h: st.dh };
}
