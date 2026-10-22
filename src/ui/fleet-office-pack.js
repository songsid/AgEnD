// The Office view's skin-pack format, v1 (fleet-office-skin.js draws a checked pack; nothing loads one from outside yet).
// Its shape follows Star-Office-UI's scene (MIT; github.com/ringhyacinth/Star-Office-UI): one background on a 16:9
// logical canvas, named areas with ordered seat slots, furniture with a depth, and a state → area map. No code or art of
// it is used here — the idea of the format only.
//
// A pack is a JSON manifest plus images. Every coordinate is in logical units on a 1280×720 canvas (LOGICAL), which
// the page scales to fit its width. Images are pixel art, drawn unsmoothed at `scale` logical units per image pixel.
//
//   {
//     "format": 1,                                    required
//     "id": "cozy",                                   letters, digits, - and _ (≤ 40); not a built-in skin's id
//     "scale": 2,                                     1–8 (default 2)
//     "background": "office.png",                     drawn over the whole 1280×720 canvas (16:9)
//     "areas": {                                      named zones: a rect [x, y, w, h] and its seats, in the order
//       "desks":  { "rect": [40, 120, 620, 440], "seats": [[120, 220], [260, 220], …] },    they fill up
//       "lounge": { "rect": [700, 120, 540, 260], "seats": [[760, 260], …] } },
//     "stateZones": { "working": "desks", "idle": "lounge", "needs": "alert", "default": "lounge" },
//                                                     the org chart's states (fleet-org.js ORG_STATES) → an area; a
//                                                     state it does not name goes to "default", else the first area
//     "door": [640, 700],                             optional: where someone new walks in from (default: bottom middle)
//     "waypoints": [{ "id": "hall", "x": 640, "y": 600 }, …], "edges": [["hall", "east"], …],
//                                                     optional: the walkable graph (else people walk straight)
//     "furniture": [ { "id": "rack", "sprite": STRIP, "x": 1020, "y": 140, "depth": 2,
//                      "activeWhen": "crashed", "activeSprite": STRIP } ],
//                                                     drawn by depth: below 1000 under the people, 1000 and up over
//                                                     them; (x, y) is where the strip's anchor goes. `activeWhen` (a
//                                                     state, or a list): while anyone shown is in it, the item plays its
//                                                     strip (or `activeSprite`); otherwise it holds the first frame
//     "characters": { "default": { "working": STRIP, "idle": STRIP, "paused": STRIP, "needs": STRIP, "walk": STRIP },
//                     "fox": { … } },                 "default" with at least "idle" is required; a missing pose is idle
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
// TODO(office editor): the planned editor follows the reference's approach — a "show coordinates" overlay on the
// canvas and dragging furniture and seats, the positions saved into the office (PUT /ui/offices) — out of v1.

export const LOGICAL = { w: 1280, h: 720 };
/** The people's depth: furniture below it is drawn under them, the rest over them. */
export const CHAR_DEPTH = 1000;
export const PACK_STATES = ["needs", "crashed", "stuck", "working", "idle", "paused", "stopped", "missing"];
const POSES = ["working", "idle", "paused", "needs", "walk"], PROPS = ["task", "send", "report", "broadcast"];
const BUILT_IN = new Set(["pixel", "studio"]);
const ID = /^[A-Za-z0-9_-]{1,40}$/;
const SRC = /^[A-Za-z0-9._/-]{1,200}$/;
const LIMIT = { areas: 32, seats: 64, furniture: 128, waypoints: 512, edges: 2048, sets: 64, byInstance: 500, lines: 12, line: 40 };

class Refused extends Error { constructor(at, why) { super(`${at}: ${why}`); } }
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
function list(v, max, at) { if (!Array.isArray(v)) throw new Refused(at, "a list"); if (v.length > max) throw new Refused(at, `at most ${max}`); return v; }

/** A frame strip, strictly. */
export function checkStrip(v, at = "strip") {
  obj(v, at);
  keys(v, ["src", "frames", "w", "h", "fps", "ax", "ay"], at);
  const w = int(v.w, 1, 512, `${at}.w`), h = int(v.h, 1, 512, `${at}.h`);
  return { src: src(v.src, `${at}.src`), frames: int(v.frames, 1, 32, `${at}.frames`), w, h, fps: v.fps === undefined ? 4 : num(v.fps, 0, 30, `${at}.fps`),
    ax: v.ax === undefined ? w / 2 : num(v.ax, 0, w, `${at}.ax`), ay: v.ay === undefined ? h : num(v.ay, 0, h, `${at}.ay`) };
}
function strips(v, names, at) {
  obj(v, at);
  keys(v, names, at);
  return Object.fromEntries(Object.entries(v).map(([k, s]) => [k, checkStrip(s, `${at}.${k}`)]));
}
function states(v, at) {
  const one = (s, here) => { if (!PACK_STATES.includes(s)) throw new Refused(here, `one of ${PACK_STATES.join(", ")}`); return s; };
  return Array.isArray(v) ? list(v, 8, at).map((s, i) => one(s, `${at}[${i}]`)) : [one(v, at)];
}

/** A pack's manifest, strictly: { ok: true, pack } or { ok: false, error: "<where>: <why>" }. */
export function checkSkinPack(x) {
  try {
    obj(x, "pack");
    keys(x, ["format", "id", "scale", "background", "areas", "stateZones", "door", "waypoints", "edges", "furniture", "characters", "byInstance", "props", "bubbles", "room", "desk"], "pack");
    if (x.format !== 1) throw new Refused("format", "1");
    if (typeof x.id !== "string" || !ID.test(x.id)) throw new Refused("id", "1–40 letters, digits, _ or -");
    if (BUILT_IN.has(x.id)) throw new Refused("id", "a built-in skin's id");
    const scale = x.scale === undefined ? 2 : int(x.scale, 1, 8, "scale");
    const areas = {};
    const rawAreas = x.areas === undefined ? {} : obj(x.areas, "areas");
    if (Object.keys(rawAreas).length > LIMIT.areas) throw new Refused("areas", `at most ${LIMIT.areas}`);
    for (const [name, a] of Object.entries(rawAreas)) {
      const at = `areas.${name}`;
      if (!ID.test(name)) throw new Refused(at, "a name of letters, digits, _ or -");
      obj(a, at); keys(a, ["rect", "seats"], at);
      if (!Array.isArray(a.rect) || a.rect.length !== 4) throw new Refused(`${at}.rect`, "[x, y, w, h]");
      const [rx, ry] = [num(a.rect[0], 0, LOGICAL.w, `${at}.rect[0]`), num(a.rect[1], 0, LOGICAL.h, `${at}.rect[1]`)];
      const rect = { x: rx, y: ry, w: num(a.rect[2], 1, LOGICAL.w - rx, `${at}.rect[2]`), h: num(a.rect[3], 1, LOGICAL.h - ry, `${at}.rect[3]`) };
      const seats = list(a.seats, LIMIT.seats, `${at}.seats`).map((s, i) => {
        const p = point(s, `${at}.seats[${i}]`);
        if (p.x < rect.x || p.x > rect.x + rect.w || p.y < rect.y || p.y > rect.y + rect.h) throw new Refused(`${at}.seats[${i}]`, "outside its area's rect");
        return p;
      });
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
        if (typeof area !== "string" || !areas[area]) throw new Refused(`stateZones.${s}`, "an area the pack defines");
        stateZones[s] = area;
      }
      if (x.background === undefined) throw new Refused("background", "required with stateZones");
    }
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
      obj(f, at); keys(f, ["id", "sprite", "x", "y", "depth", "activeWhen", "activeSprite"], at);
      if (typeof f.id !== "string" || !ID.test(f.id) || fids.has(f.id)) throw new Refused(`${at}.id`, "a new name of letters, digits, _ or -");
      fids.add(f.id);
      if (f.activeSprite !== undefined && f.activeWhen === undefined) throw new Refused(`${at}.activeSprite`, "only with activeWhen");
      return { id: f.id, sprite: checkStrip(f.sprite, `${at}.sprite`), x: num(f.x, 0, LOGICAL.w, `${at}.x`), y: num(f.y, 0, LOGICAL.h, `${at}.y`),
        depth: int(f.depth ?? 0, -10000, 10000, `${at}.depth`), activeWhen: f.activeWhen === undefined ? null : states(f.activeWhen, `${at}.activeWhen`),
        activeSprite: f.activeSprite === undefined ? null : checkStrip(f.activeSprite, `${at}.activeSprite`) };
    }).sort((a, b) => a.depth - b.depth);
    const sets = obj(x.characters, "characters");
    if (Object.keys(sets).length > LIMIT.sets) throw new Refused("characters", `at most ${LIMIT.sets} sets`);
    const characters = {};
    for (const [k, v] of Object.entries(sets)) {
      if (!ID.test(k)) throw new Refused(`characters.${k}`, "a name of letters, digits, _ or -");
      characters[k] = strips(v, POSES, `characters.${k}`);
      if (!characters[k].idle) throw new Refused(`characters.${k}.idle`, "required");
    }
    if (!characters.default) throw new Refused("characters.default", "required");
    const byInstance = {};
    const rawBy = x.byInstance === undefined ? {} : obj(x.byInstance, "byInstance");
    if (Object.keys(rawBy).length > LIMIT.byInstance) throw new Refused("byInstance", `at most ${LIMIT.byInstance}`);
    for (const [k, v] of Object.entries(rawBy)) { if (typeof v !== "string" || !characters[v]) throw new Refused(`byInstance.${k}`, "a character set the pack defines"); byInstance[k] = v; }
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
      format: 1, id: x.id, scale, background: opt(x.background, "background"), areas, stateZones,
      door: x.door === undefined ? { x: LOGICAL.w / 2, y: LOGICAL.h - 10 } : point(x.door, "door"), waypoints, edges, furniture, characters, byInstance,
      props: x.props === undefined ? {} : strips(x.props, PROPS, "props"), bubbles,
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
export const packImages = (pack) => [...new Set([pack.background, pack.room.floor, pack.room.wall, pack.desk.back, pack.desk.front, pack.desk.lit,
  ...pack.furniture.flatMap((f) => [f.sprite.src, f.activeSprite && f.activeSprite.src]),
  ...Object.values(pack.characters).flatMap((s) => Object.values(s).map((st) => st.src)), ...Object.values(pack.props).map((st) => st.src)].filter(Boolean))];
