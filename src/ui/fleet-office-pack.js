// The Office view's skin-pack format, v1 (fleet-office-skin.js draws a checked pack; an admin uploads one — Fleet → Org
// chart → Office → Edit offices → Upload a skin pack — and the host keeps it, src/web-office-skins.ts, checking it with
// this same module: the page and the host agree on every rule).
// Its shape follows Star-Office-UI's scene (MIT; github.com/ringhyacinth/Star-Office-UI): one background on a 16:9
// logical canvas, named areas with ordered seat slots, furniture with a depth, and a state → area map. No code or art of
// it is used here — the idea of the format only.
//
// A pack is a JSON manifest plus images. Every coordinate is in logical units on a 1280×720 canvas (LOGICAL), or on the
// pack's own `canvas: [w, h]` (#4405: 640×360 to 5120×2880, CANVAS), which the page shows whole, then pans and zooms (fleet-office-view.js). Images are pixel art, drawn unsmoothed at `scale` logical units per image pixel.
//
//   {
//     "format": 1,                                    required
//     "id": "cozy",                                   letters, digits, - and _ (≤ 40); not a built-in skin's id
//     "scale": 2,                                     1–8 (default 2)
//     "canvas": [2560, 1440],                         optional (#4405): the logical canvas, CANVAS.min to CANVAS.max
//     "background": "office.png",                     drawn over the whole canvas (16:9; with "canvas", its shape)
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
//     "mailDrop": [640, 420],                         optional (#2736): where a letter from another office lands (more
//                                                     waiting step GAP px right of it, past any seat); default: the
//                                                     waypoint nearest the middle off every seat (fleet-office-zones.js
//                                                     dropPoint)
//     "waypoints": [{ "id": "hall", "x": 640, "y": 600 }, …], "edges": [["hall", "east"], …],
//                                                     optional: the walkable graph (else people walk straight)
//     "straight": true,                               optional (#2634): every walk goes across, then up or down — each
//                                                     diagonal leg an L, so the walkSide / walkDown / walkUp strips
//                                                     always fit (graph edges laid out across and up/down put the
//                                                     corners on the aisles); default false
//     "idleVisits": [{ "area": "spring", "weight": 20, "minSeconds": 30, "maxSeconds": 90 }, …],
//                                                     optional (#3685), with stateZones: ≤ 8, each an area the pack
//                                                     defines (none twice); weight 1–100, minSeconds 5–600,
//                                                     maxSeconds minSeconds–600 (whole numbers). At each of an idle
//                                                     person's stroll turns (fleet-office-zones.js WANDER, VISIT) the
//                                                     entries' weights are rolled against today's stroll near the
//                                                     seat, which weighs 100 (VISIT.STROLL): one entry of weight 20 is
//                                                     a visit at 20 / 120 of the turns. A visit walks to a free seat
//                                                     of that area (not reserved for someone else unless lent, nobody
//                                                     sitting there, no other visitor's), stays minSeconds–maxSeconds
//                                                     there and walks back (none free: a stroll that turn). Never their
//                                                     own area, only while idle, and like strolls not with reduced
//                                                     motion, nor in All offices or Edit layout
//     "furniture": [ { "id": "rack", "sprite": STRIP, "x": 1020, "y": 140, "depth": 2,
//                      "activeWhen": "crashed", "activeSprite": STRIP, "activeFor": "atlas", "loop": true, "activeOn": "seated", "hides": true, "label": "Rack",
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
//                                                     counts, not anyone's (a room several people take turns in).
//                                                     "activeOn" (#2698): "state" (the default) turns it active as the
//                                                     state changes; "seated" only once one of them in that state is
//                                                     at the seat zones gave them, not walking — back as they walk off.
//                                                     "hides": true (#2698, only with activeFor): while active, the
//                                                     people it is active for are not drawn (walking, they always
//                                                     are); their name tags and bubbles are drawn on it, in one row at
//                                                     its tag point, and hovering or clicking it hits them
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
//                                                     And "bubbles" (#3681): its people's own lines, as the pack's
//                                                     "bubbles" below (not a strip: kept apart, as bubblesBySet)
//     "byInstance": { "atlas": "fox" },               optional: an instance name → its character set
//     "props": { "task": STRIP, "send": STRIP, "report": STRIP, "broadcast": STRIP },   optional traffic items
//     "bubbles": { "en": { "working": ["On it."] }, "zh-TW": { … } }   optional: short lines per state (≤ 12 a state,
//                                                     ≤ 40 characters each), in place of the page's own; M-3293:
//                                                     also "pat" and "feed" (what a person says to a pat or a feed in
//                                                     the Office; none: the page's own words)
//     "bubblesByInstance": { "atlas": { "en": { "idle": ["Coffee?"] } } }
//                                                     optional (#3681): an instance's own lines, as "bubbles" (names
//                                                     checked like byInstance's, ≤ 500). A person's line for a state
//                                                     (linesFor): theirs here, else their character set's "bubbles"
//                                                     (byInstance's set, else "default"), else the pack's "bubbles",
//                                                     else the page's own — each by the page's language and the state
//     "room": { "floor": "floor.png", "wall": "wall.png" }, "desk": { "back": …, "front": …, "lit": … }
//                                                     optional: for the desks layout (a pack without stateZones)
//     "portraits": { "default": FACE, "byInstance": { "atlas": FACE }, "byUser": { "discord:1": FACE }, "npc": { "<item id>": FACE } }
//                                                     optional (#2861): the dialogue box's faces — FACE is a file, or
//                                                     { "idle", "working", "needs" } files; PNGs up to 1024×1536 (host)
//     "dialogBox": { "frame": "box.png", "slice": 8, "background": "#rrggbb", "border", "text", "name" }
//                                                     optional (#2861): the box's 9-slice frame (≤ 512×512) and colours
//       "bubble": { "frame", "slice" (default 6), "background", "border", "text", "name", "enter": "pop"|"fade"|"none" }
//                                                     optional: the reply over a head (talk "Over their head"), the same
//     "levels": {                                     optional (#2661): the Office levels' words
//       "titles": [{ "from": 1, "name": "Intern" }, …],   the title from each level up (≤ 32, `from` 0–100000
//                                                     rising, a name 1–24 characters), in place of the page's own
//       "fixed": { "atlas": { "title": "Founder", "hideLevel": true } } }
//                                                     a title pinned on an instance (or an NPC: a furniture item's
//                                                     id) whatever its level (≤ 500); hideLevel: its badge is a mark,
//                                                     its card has no "Lv n" or XP bar. #3679: the fleet may keep
//                                                     its own `levels` for every office (checkLevels: these rules);
//                                                     a pack's own titles win over it, and its fixed entries over
//                                                     the fleet's, name by name (fleet-office-levels.js mergeLevels)
//   }
//
// A STRIP is { "src": "idle.png", "frames": 4, "w": 32, "h": 48, "fps": 4, "ax": 16, "ay": 44 }: `frames` frames of
// w×h image pixels side by side, left to right, no gaps (the image is frames·w × h; 4 frames is usual for a pose, 2 for
// walk, 1 for still furniture); played at `fps` (0: the first frame only — as reduced motion shows everything); (ax, ay)
// the image point put on the position (a character's seat is where its feet are). Suggested sizes at scale 2: a
// character 32×48, a prop 12×12, furniture as drawn. `src` is a file name in the pack: letters, digits, . _ - and /, no
// "..". Optional "row" and "col" (0–4095) cut the frames from a bigger sheet: frame i is the w×h cell at column col+i
// of row `row` (so several poses can share one picture, which must then be at least (col+frames)·w × (row+1)·h).
// The check is strict: an unknown key, a value out of range or a name that refers to nothing refuses the pack,
// with where it broke.
//
// Its displayed size: w·scale × h·scale logical units, unless the strip says `dw` and/or `dh` (logical units, 1 to the
// canvas's width and 1 to its height): its frame is then drawn dw × dh (still unsmoothed: nearest neighbour), and with only one of them the other keeps
// the frame's aspect. The anchor (ax, ay) stays in image pixels and moves with it. So art drawn at 120×120 px shows at
// 96×96 with "dw": 96, "dh": 96 — whatever the pack's scale. What a person hovers or clicks is the box drawn (stripBox).
//
// A name the pack declares and refers to (an area, a character set, a furniture item, an instance in byInstance or
// bubblesByInstance, and the same in an office's overrides) is never one an object already has (Object.prototype's:
// "constructor", "toString", "__proto__", …): such a name is refused, and every lookup is of the pack's own names only
// (own()).
//
// The host keeps an uploaded pack whole and never changes it: every PNG starts with its signature, a STRIP's image is
// exactly frames·w × h, the background and the foreground are 16:9 (or the pack's canvas's shape), and each file and the pack have a size cap (web-office-skins.ts).
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
//     "door": [640, 700], "mailDrop": [640, 420],     (#2736: kept beside the offices on disk, as furnitureNight)
//     "waypoints": [{ "id": "hall", "x": 640, "y": 600 }, …], "edges": [["hall", "east"], …] }
//                                                     the walkable graph, replaced whole (edges need waypoints)
//
// Every coordinate is on the same logical canvas as the pack's (1280×720, or its own), in the same ranges. checkLayoutOverrides is
// the shape (the host checks it on every PUT /ui/offices); applyOverrides puts them on a checked pack, refusing a
// seat outside its area, an area or furniture the pack does not have, or a seat count that differs (the host checks
// that too, for a pack it keeps). A night place goes on the item's `night` (its x, y), so at bedtime (nightFurniture)
// it is the office's, else the pack's night x/y, else the item's (moved) day place. The host keeps `furnitureNight`
// and `seatFor` (#2691) beside the offices on disk, never inside them: an older host's stricter check would drop the
// office (#2665, web-office-store.ts).

export const LOGICAL = { w: 1280, h: 720 };
/** A pack's own canvas (`canvas: [w, h]`, logical units): from CANVAS.min to CANVAS.max a side; without one, LOGICAL. */
export const CANVAS = { min: { w: 640, h: 360 }, max: { w: 5120, h: 2880 } };
/** The canvas a checked pack's scene is on: its own, else LOGICAL (every built-in style, every older pack). */
export const canvasOf = (pack) => (pack && pack.canvas) || LOGICAL;
// The canvas the manifest being checked declares (checkSkinPack), or an office's overrides are checked on
// (checkLayoutOverrides: its pack's, else CANVAS.max when the pack is not known yet; applyOverrides then keeps every
// point on the pack's own). Both checks are synchronous.
let C = LOGICAL;

/** The people's depth: furniture below it is drawn under them, the rest over them. */
export const CHAR_DEPTH = 1000;
export const PACK_STATES = ["needs", "crashed", "stuck", "working", "idle", "paused", "stopped", "missing"];
/** M-3293 (#4119): what a bubbles table may name — the states, and the Office's two reactions (a pat, a feed). */
export const BUBBLE_KEYS = [...PACK_STATES, "pat", "feed"];
const POSES = ["working", "idle", "paused", "needs", "walk", "walkDown", "walkUp", "walkSide", "walkLeft"], PROPS = ["task", "send", "report", "broadcast"];
/** A character set's strips: its poses, optional eat (M-3432 #4255), dragged (M-3445 #4267) and pat poses, a still `stand` (its card
 * avatar), and what its people send (#2562). */
const SET_STRIPS = [...POSES, "eat", "dragged", "pat", "stand", "prop"];
/** A furniture item's walking strips (#2596): a character set's walking poses. */
const WALKS = ["walk", "walkDown", "walkUp", "walkSide", "walkLeft"];
const BUILT_IN = new Set(["pixel", "studio"]);
/**
 * Ids built in after packs could be uploaded under them (#2631: "cozy"; #2947: "guild", "school"): a new upload is
 * refused, but a pack the host kept under one before (`kept`) is still read back, listed and deletable, and wins the id
 * for the offices that name it.
 */
const RESERVED = new Set(["cozy", "guild", "school"]);
const ID = /^[A-Za-z0-9_-]{1,40}$/;
const SRC = /^[A-Za-z0-9._/-]{1,200}$/;
const HEX = /^#[0-9a-f]{6}$/i;
const LIMIT = { areas: 32, seats: 64, furniture: 128, waypoints: 512, edges: 2048, sets: 64, byInstance: 500, lines: 12, line: 40, seatFor: 16, titles: 32, title: 24, fixed: 500,
  portraitInstances: 500, portraitUsers: 200, portraitNpcs: 128, slice: 128, idleVisits: 8 };
/** M-3394 (#4231): strip animation caps — per-sheet frames, multi-sheet count, total frames, and per-frame duration (ms). */
export const STRIP_LIMITS = { sheetFrames: 32, sheets: 32, frames: 600, minMs: 33, maxMs: 60000 };
/** M-3432 (#4255): snack manifest caps — entries per pack, attraction radius (logical units), and label length. */
export const SNACK_LIMITS = { max: 12, minRadius: 60, maxRadius: 1280, defaultRadius: 260, labelMax: 24 };
/** #2861: a portrait's expressions, by the state it is shown in (a missing one: idle, then any given). */
export const PORTRAIT_STATES = ["idle", "working", "needs"];
/** M-3433 (#4256): optional agent profile card style & layout enums and caps. */
export const CARD_PRESETS = ["default", "rpg", "compact", "dossier"];
export const CARD_RADII = ["none", "sm", "md", "lg"];
export const CARD_AVATAR_SIZES = ["sm", "md", "lg"];
export const CARD_AVATAR_SOURCES = ["sprite", "portrait"];
export const CARD_HEADER_ALIGNS = ["left", "center"];
export const CARD_SECTIONS = ["header", "level", "rows", "now", "tell", "actions"];
export const CARD_ROWS = ["office", "model", "backend", "today", "firstSeen"];
/** How a pack's card pops up (card.motion.enter); "none" keeps it still. */
export const CARD_ENTERS = ["none", "fade", "pop", "rise", "slide", "bounce"];
export const CARD_HIDE = ["instance", "title", "badge", "level", "xpBar", "office", "model", "backend", "today", "firstSeen", "now"];
export const CARD_STYLE_COLORS = ["background", "border", "text", "muted", "accent", "barTrack", "barFill", "buttonBg", "buttonText", "buttonPrimaryBg", "buttonPrimaryText"];
export const CARD_LIMITS = { widthMin: 280, widthMax: 400, gapMax: 240, motionMsMin: 80, motionMsMax: 1200, sliceMax: 128, textContrast: 4.5, uiContrast: 3.0 };
/** #2861: a person's account as the chat records it (`adapter:id`, web-chat-history.ts FROM). */
const ACCOUNT = /^[^\s:]{1,64}:[^\s:]{1,128}$/;

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
  return { x: num(v[0], 0, C.w, `${at}[0]`), y: num(v[1], 0, C.h, `${at}[1]`) };
}
/** Where an item sorts: by depth, a "y" one among the people (after every number under them, before the rest). */
const order = (f) => (f.depth === "y" ? CHAR_DEPTH - 0.5 : f.depth);
/** A furniture item's numeric depth (its "y" is taken before this). */
function depth(v, at) { if (!Number.isInteger(v) || v < -10000 || v > 10000) throw new Refused(at, 'a whole number from -10000 to 10000, or "y"'); return v; }
function list(v, max, at) { if (!Array.isArray(v)) throw new Refused(at, "a list"); if (v.length > max) throw new Refused(at, `at most ${max}`); return v; }

/** Whether `v` is a pack's `matte`: a colour as #rrggbb (six hex digits, either case). */
export const matteOk = (v) => typeof v === "string" && HEX.test(v);

/** M-3433 (#4256): WCAG 2.1 relative luminance (0–1) for a #rrggbb colour, or null when invalid. */
export function relativeLuminance(hex) {
  if (!matteOk(hex)) return null;
  const ch = (i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch(1) + 0.7152 * ch(3) + 0.0722 * ch(5);
}

/** M-3433 (#4256): WCAG 2.1 contrast ratio (1–21) between two #rrggbb colours, or 0 when either is invalid. */
export function contrastRatio(hexA, hexB) {
  const a = relativeLuminance(hexA), b = relativeLuminance(hexB);
  if (a === null || b === null) return 0;
  const hi = Math.max(a, b), lo = Math.min(a, b);
  return (hi + 0.05) / (lo + 0.05);
}

/** A frame strip, strictly; `scale` the pack's (its displayed size, dw × dh, is resolved here).
 * Supports three forms:
 * 1. Single horizontal sheet (existing): `{ src: "idle.png", frames: 4, w, h, fps?, durations?, once?, loopFrom? }`
 * 2. Multi-sheet sequence (#4231): `{ src: ["a.png", "b.png"], frames: 32 | [32, 16], w, h, fps?, durations?, once?, loopFrom? }`
 * 3. Frame list with per-frame durations (M-3394): `{ frames: [{ src: "f1.png", ms?: 1200 }, …], w, h, fps?, once?, loopFrom? }`
 */
export function checkStrip(v, at = "strip", scale = 2) {
  obj(v, at);
  keys(v, ["src", "frames", "durations", "w", "h", "fps", "ax", "ay", "dw", "dh", "once", "loopFrom", "row", "col"], at);
  const w = int(v.w, 1, 512, `${at}.w`), h = int(v.h, 1, 512, `${at}.h`);
  const dw0 = v.dw === undefined ? null : num(v.dw, 1, C.w, `${at}.dw`), dh0 = v.dh === undefined ? null : num(v.dh, 1, C.h, `${at}.dh`);
  const dw = dw0 ?? (dh0 !== null ? (dh0 * w) / h : w * scale), dh = dh0 ?? (dw0 !== null ? (dw0 * h) / w : h * scale);
  const ax = v.ax === undefined ? w / 2 : num(v.ax, 0, w, `${at}.ax`), ay = v.ay === undefined ? h : num(v.ay, 0, h, `${at}.ay`);
  if (v.once !== undefined && typeof v.once !== "boolean") throw new Refused(`${at}.once`, "true or false");
  const once = v.once === true;
  // Sheet cells: frames start at column `col` of row `row` (w×h cells), so one picture can hold several poses. Either
  // given marks the strip as cut from a larger sheet (its picture is then at least (col+frames)·w × (row+1)·h).
  const row = v.row === undefined ? undefined : int(v.row, 0, 4095, `${at}.row`);
  const col = v.col === undefined ? undefined : int(v.col, 0, 4095, `${at}.col`);
  let firstSrc, totalFrames, sheets = null, durations = null, fps = 4;

  if (v.src === undefined && Array.isArray(v.frames)) {
    // Form 3: explicit frame list [{ src, ms? }, …], each image 1 frame (w × h).
    if (row !== undefined || col !== undefined) throw new Refused(`${at}.row`, "row and col need src (a sheet); a frame list has one picture per frame");
    if (v.durations !== undefined) throw new Refused(`${at}.durations`, "use ms on each entry in frames");
    const items = list(v.frames, STRIP_LIMITS.frames, `${at}.frames`);
    if (!items.length) throw new Refused(`${at}.frames`, "at least 1 frame");
    fps = v.fps === undefined ? 4 : num(v.fps, 0, 30, `${at}.fps`);
    let hasMs = false;
    const parsed = items.map((e, i) => {
      const here = `${at}.frames[${i}]`;
      obj(e, here); keys(e, ["src", "ms"], here);
      const file = src(e.src, `${here}.src`);
      const ms = e.ms === undefined ? null : int(e.ms, STRIP_LIMITS.minMs, STRIP_LIMITS.maxMs, `${here}.ms`);
      if (ms !== null) hasMs = true;
      return { src: file, ms };
    });
    if (hasMs && v.fps === 0) throw new Refused(`${at}.fps`, "0 cannot be used with frame ms");
    firstSrc = parsed[0].src;
    totalFrames = parsed.length;
    sheets = parsed.map((e) => ({ src: e.src, frames: 1 }));
    if (hasMs) {
      const fallbackMs = Math.max(STRIP_LIMITS.minMs, Math.min(STRIP_LIMITS.maxMs, Math.round(1000 / (fps > 0 ? fps : 4))));
      durations = parsed.map((e) => e.ms ?? fallbackMs);
    }
  } else if (Array.isArray(v.src)) {
    // Form 2: multi-sheet sequence of horizontal strips.
    const files = list(v.src, STRIP_LIMITS.sheets, `${at}.src`).map((s, i) => src(s, `${at}.src[${i}]`));
    if (!files.length) throw new Refused(`${at}.src`, "at least 1 file");
    let counts;
    if (Array.isArray(v.frames)) {
      if (v.frames.length !== files.length) throw new Refused(`${at}.frames`, `must have ${files.length} entries (one per image in src)`);
      counts = v.frames.map((n, i) => int(n, 1, STRIP_LIMITS.sheetFrames, `${at}.frames[${i}]`));
    } else {
      const n = int(v.frames, 1, STRIP_LIMITS.sheetFrames, `${at}.frames`);
      counts = files.map(() => n);
    }
    totalFrames = counts.reduce((a, b) => a + b, 0);
    if (totalFrames > STRIP_LIMITS.frames) throw new Refused(`${at}.frames`, `at most ${STRIP_LIMITS.frames} frames in all`);
    firstSrc = files[0];
    sheets = files.map((file, i) => ({ src: file, frames: counts[i] }));
    if (v.durations !== undefined) {
      if (v.fps !== undefined) throw new Refused(`${at}.durations`, "cannot be used with fps");
      const ds = list(v.durations, STRIP_LIMITS.frames, `${at}.durations`);
      if (ds.length !== totalFrames) throw new Refused(`${at}.durations`, `must have ${totalFrames} entries (one per frame)`);
      durations = ds.map((d, i) => int(d, STRIP_LIMITS.minMs, STRIP_LIMITS.maxMs, `${at}.durations[${i}]`));
    } else {
      fps = v.fps === undefined ? 4 : num(v.fps, 0, 30, `${at}.fps`);
    }
  } else {
    // Form 1: single horizontal strip (unchanged for existing packs).
    firstSrc = src(v.src, `${at}.src`);
    totalFrames = int(v.frames, 1, STRIP_LIMITS.sheetFrames, `${at}.frames`);
    if (v.durations !== undefined) {
      if (v.fps !== undefined) throw new Refused(`${at}.durations`, "cannot be used with fps");
      const ds = list(v.durations, STRIP_LIMITS.sheetFrames, `${at}.durations`);
      if (ds.length !== totalFrames) throw new Refused(`${at}.durations`, `must have ${totalFrames} entries (one per frame)`);
      durations = ds.map((d, i) => int(d, STRIP_LIMITS.minMs, STRIP_LIMITS.maxMs, `${at}.durations[${i}]`));
    } else {
      fps = v.fps === undefined ? 4 : num(v.fps, 0, 30, `${at}.fps`);
    }
  }

  let loopFrom = 0;
  if (v.loopFrom !== undefined) {
    if (once) throw new Refused(`${at}.loopFrom`, "cannot be used with once");
    loopFrom = int(v.loopFrom, 0, totalFrames - 1, `${at}.loopFrom`);
  }

  return {
    src: firstSrc, frames: totalFrames, w, h, fps, ax, ay, dw, dh,
    ...(row !== undefined || col !== undefined ? { row: row ?? 0, col: col ?? 0 } : {}),
    ...(sheets ? { sheets } : {}),
    ...(durations ? { durations } : {}),
    ...(once ? { once: true } : {}),
    ...(loopFrom > 0 ? { loopFrom } : {}),
  };
}
/** A furniture item's night (#2568): { sprite, x, y } — at bedtime it is drawn as `sprite` (playing) at (x, y), its own place when left out. */
function nightOf(v, at, scale) {
  if (v === undefined) return null;
  obj(v, at); keys(v, ["sprite", "x", "y"], at);
  return { sprite: checkStrip(v.sprite, `${at}.sprite`, scale), x: v.x === undefined ? null : num(v.x, 0, C.w, `${at}.x`), y: v.y === undefined ? null : num(v.y, 0, C.h, `${at}.y`) };
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
    p = { x: num(v.x, 0, C.w, `${at}.x`), y: num(v.y, 0, C.h, `${at}.y`) };
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
 * A table of speech-bubble lines: { "en" | "zh-TW": { state: [line, …] } }, at most LIMIT.lines a state, each
 * 1–LIMIT.line characters on one line (trimmed). The pack's `bubbles`, and (#3681) a character set's and an instance's.
 */
function bubblesOf(v, at) {
  const out = {};
  for (const [lang, table] of Object.entries(obj(v, at))) {
    if (lang !== "en" && lang !== "zh-TW") throw new Refused(`${at}.${lang}`, '"en" or "zh-TW"');
    obj(table, `${at}.${lang}`);
    out[lang] = {};
    for (const [s, lines] of Object.entries(table)) {
      const here = `${at}.${lang}.${s}`;
      if (!BUBBLE_KEYS.includes(s)) throw new Refused(here, "a state, pat or feed");
      out[lang][s] = list(lines, LIMIT.lines, here).map((l, i) => {
        if (typeof l !== "string" || !l.trim() || [...l].length > LIMIT.line || /[\u0000-\u001f\u007f]/.test(l)) throw new Refused(`${here}[${i}]`, `1–${LIMIT.line} characters`);
        return l.trim();
      });
    }
  }
  return out;
}

/** #2661: a title's words — 1–LIMIT.title characters on one line. */
function titleText(v, at) {
  if (typeof v !== "string" || !v.trim() || [...v.trim()].length > LIMIT.title || /[\u0000-\u001f\u007f]/.test(v)) throw new Refused(at, `1–${LIMIT.title} characters`);
  return v.trim();
}
/** #2661: a pack's `levels` (titles, fixed), checked; null when it has none. */
function levelsOf(v) {
  if (v === undefined) return null;
  obj(v, "levels");
  keys(v, ["titles", "fixed"], "levels");
  const out = {};
  if (v.titles !== undefined) {
    let last = -1;
    out.titles = list(v.titles, LIMIT.titles, "levels.titles").map((t, i) => {
      const at = `levels.titles[${i}]`;
      obj(t, at); keys(t, ["from", "name"], at);
      const from = int(t.from, 0, 100000, `${at}.from`);
      if (from <= last) throw new Refused(`${at}.from`, "higher than the title before it");
      last = from;
      return { from, name: titleText(t.name, `${at}.name`) };
    });
  }
  if (v.fixed !== undefined) {
    obj(v.fixed, "levels.fixed");
    if (Object.keys(v.fixed).length > LIMIT.fixed) throw new Refused("levels.fixed", `at most ${LIMIT.fixed}`);
    out.fixed = {};
    for (const [k, f] of Object.entries(v.fixed)) {
      const at = `levels.fixed.${k}`;
      if (inherited(k)) throw new Refused(at, "an instance's name (not an inherited one)");
      obj(f, at); keys(f, ["title", "hideLevel"], at);
      if (f.hideLevel !== undefined && typeof f.hideLevel !== "boolean") throw new Refused(`${at}.hideLevel`, "true or false");
      out.fixed[k] = { title: titleText(f.title, `${at}.title`), hideLevel: f.hideLevel === true };
    }
  }
  return out;
}

/** #2861: one portrait — a file, or { idle, working, needs } files (at least one): always the expressions' object. */
function portraitOf(v, at) {
  if (typeof v === "string") return { idle: src(v, at) };
  obj(v, at); keys(v, PORTRAIT_STATES, at);
  const out = {};
  for (const k of PORTRAIT_STATES) if (v[k] !== undefined) out[k] = src(v[k], `${at}.${k}`);
  if (!Object.keys(out).length) throw new Refused(at, `a file, or at least one of ${PORTRAIT_STATES.join(", ")}`);
  return out;
}
/** #2861: a table of portraits by key (`keyOk` says which keys it takes), at most `max`. */
function portraitTable(v, at, max, keyOk, what) {
  if (v === undefined) return {};
  obj(v, at);
  if (Object.keys(v).length > max) throw new Refused(at, `at most ${max}`);
  const out = {};
  for (const [k, p] of Object.entries(v)) {
    if (inherited(k) || !keyOk(k)) throw new Refused(`${at}.${k}`, what);
    out[k] = portraitOf(p, `${at}.${k}`);
  }
  return out;
}
/**
 * #2861: a pack's `portraits` — `default` (agents), `byInstance`, `byUser` (a person's `adapter:id`) and `npc` (a
 * furniture item the pack defines: `fids`); null when it has none.
 */
function portraitsOf(v, fids) {
  if (v === undefined) return null;
  obj(v, "portraits");
  keys(v, ["default", "byInstance", "byUser", "npc"], "portraits");
  const instanceOk = (k) => !!k && k.length <= 200 && !/[\u0000-\u001f\u007f]/.test(k);
  return {
    ...(v.default !== undefined ? { default: portraitOf(v.default, "portraits.default") } : {}),
    byInstance: portraitTable(v.byInstance, "portraits.byInstance", LIMIT.portraitInstances, instanceOk, "an instance's name"),
    byUser: portraitTable(v.byUser, "portraits.byUser", LIMIT.portraitUsers, (k) => ACCOUNT.test(k), 'an account as "adapter:id"'),
    npc: portraitTable(v.npc, "portraits.npc", LIMIT.portraitNpcs, (k) => fids.has(k), "a furniture item the pack defines"),
  };
}
/** #2861: a pack's `dialogBox` — a 9-slice `frame` (`slice` image px a side) and colours; null when it has none. */
function dialogBoxOf(v) {
  if (v === undefined) return null;
  obj(v, "dialogBox");
  keys(v, ["frame", "slice", "background", "border", "text", "name", "bubble"], "dialogBox");
  const out = boxLookOf(v, "dialogBox", 8);
  if (v.bubble !== undefined) {
    // The reply over a head (the Office's "Over their head" talk): the same look, and how it comes in.
    obj(v.bubble, "dialogBox.bubble");
    keys(v.bubble, ["frame", "slice", "background", "border", "text", "name", "enter"], "dialogBox.bubble");
    out.bubble = boxLookOf(v.bubble, "dialogBox.bubble", 6);
    if (v.bubble.enter !== undefined) {
      if (!BUBBLE_ENTER.includes(v.bubble.enter)) throw new Refused("dialogBox.bubble.enter", `one of ${BUBBLE_ENTER.join(", ")}`);
      out.bubble.enter = v.bubble.enter;
    }
  }
  return out;
}
const BUBBLE_ENTER = ["pop", "fade", "none"];
/** A box's 9-slice frame (`slice` image px a side, else `slice0`) and colours (#rrggbb). */
function boxLookOf(v, at, slice0) {
  if (v.slice !== undefined && v.frame === undefined) throw new Refused(`${at}.slice`, "only with frame");
  const out = {};
  if (v.frame !== undefined) { out.frame = src(v.frame, `${at}.frame`); out.slice = v.slice === undefined ? slice0 : int(v.slice, 1, LIMIT.slice, `${at}.slice`); }
  for (const k of ["background", "border", "text", "name"]) {
    if (v[k] === undefined) continue;
    if (!matteOk(v[k])) throw new Refused(`${at}.${k}`, "a colour as #rrggbb");
    out[k] = v[k].toLowerCase();
  }
  return out;
}

/** M-3433 (#4256): a unique ordered list of allowed enum values. */
function uniqueEnumList(v, allowed, at) {
  const items = list(v, allowed.length, at), seen = new Set();
  return items.map((s, i) => {
    if (typeof s !== "string" || !allowed.includes(s)) throw new Refused(`${at}[${i}]`, `one of ${allowed.join(", ")}`);
    if (seen.has(s)) throw new Refused(`${at}[${i}]`, `"${s}" listed twice`);
    seen.add(s);
    return s;
  });
}

/**
 * M-3433 (#4256): a pack's optional `card` — agent profile card preset, visual style (strict #rrggbb colours with
 * WCAG contrast checks on explicit pairs, optional backgroundImage and 9-slice frame, corner radius), and layout
 * (avatar size/source, header alignment, width, section/row ordering, columns, hideable fields). Null when absent.
 */
function cardOf(v) {
  if (v === undefined) return null;
  obj(v, "card");
  keys(v, ["preset", "style", "layout", "motion"], "card");
  const out = {};
  if (v.preset !== undefined) {
    if (typeof v.preset !== "string" || !CARD_PRESETS.includes(v.preset)) throw new Refused("card.preset", `one of ${CARD_PRESETS.join(", ")}`);
    out.preset = v.preset;
  }
  if (v.style !== undefined) {
    const s = obj(v.style, "card.style");
    keys(s, [...CARD_STYLE_COLORS, "backgroundImage", "frame", "slice", "radius"], "card.style");
    if (s.slice !== undefined && s.frame === undefined) throw new Refused("card.style.slice", "only with frame");
    const st = {};
    for (const k of CARD_STYLE_COLORS) {
      if (s[k] === undefined) continue;
      if (!matteOk(s[k])) throw new Refused(`card.style.${k}`, "a colour as #rrggbb");
      st[k] = s[k].toLowerCase();
    }
    if (s.backgroundImage !== undefined) st.backgroundImage = src(s.backgroundImage, "card.style.backgroundImage");
    if (s.frame !== undefined) {
      st.frame = src(s.frame, "card.style.frame");
      st.slice = s.slice === undefined ? 8 : int(s.slice, 1, CARD_LIMITS.sliceMax, "card.style.slice");
    }
    if (s.radius !== undefined) {
      if (typeof s.radius !== "string" || !CARD_RADII.includes(s.radius)) throw new Refused("card.style.radius", `one of ${CARD_RADII.join(", ")}`);
      st.radius = s.radius;
    }
    const pairs = [
      ["text", "background", CARD_LIMITS.textContrast],
      ["muted", "background", CARD_LIMITS.textContrast],
      ["accent", "background", CARD_LIMITS.textContrast],
      ["buttonText", "buttonBg", CARD_LIMITS.textContrast],
      ["buttonPrimaryText", "buttonPrimaryBg", CARD_LIMITS.textContrast],
      ["border", "background", CARD_LIMITS.uiContrast],
      ["barFill", "barTrack", CARD_LIMITS.uiContrast],
    ];
    for (const [fg, bg, min] of pairs) {
      if (st[fg] && st[bg]) {
        const ratio = contrastRatio(st[fg], st[bg]);
        if (ratio < min) throw new Refused(`card.style.${fg}`, `contrast ratio against ${bg} must be at least ${min}:1 (got ${ratio.toFixed(2)}:1)`);
      }
    }
    out.style = st;
  }
  if (v.layout !== undefined) {
    const l = obj(v.layout, "card.layout");
    keys(l, ["avatarSize", "avatarSource", "headerAlign", "width", "gap", "sections", "rows", "rowColumns", "hide"], "card.layout");
    const ly = {};
    if (l.avatarSize !== undefined) {
      if (typeof l.avatarSize !== "string" || !CARD_AVATAR_SIZES.includes(l.avatarSize)) throw new Refused("card.layout.avatarSize", `one of ${CARD_AVATAR_SIZES.join(", ")}`);
      ly.avatarSize = l.avatarSize;
    }
    if (l.avatarSource !== undefined) {
      if (typeof l.avatarSource !== "string" || !CARD_AVATAR_SOURCES.includes(l.avatarSource)) throw new Refused("card.layout.avatarSource", `one of ${CARD_AVATAR_SOURCES.join(", ")}`);
      ly.avatarSource = l.avatarSource;
    }
    if (l.headerAlign !== undefined) {
      if (typeof l.headerAlign !== "string" || !CARD_HEADER_ALIGNS.includes(l.headerAlign)) throw new Refused("card.layout.headerAlign", `one of ${CARD_HEADER_ALIGNS.join(", ")}`);
      ly.headerAlign = l.headerAlign;
    }
    if (l.width !== undefined) ly.width = int(l.width, CARD_LIMITS.widthMin, CARD_LIMITS.widthMax, "card.layout.width");
    // How far (CSS px) the floating card opens from its person, beside the person's own half-width; the page's is 12.
    if (l.gap !== undefined) ly.gap = int(l.gap, 0, CARD_LIMITS.gapMax, "card.layout.gap");
    if (l.sections !== undefined) {
      const secs = uniqueEnumList(l.sections, CARD_SECTIONS, "card.layout.sections");
      if (!secs.includes("header") || !secs.includes("actions")) throw new Refused("card.layout.sections", 'must include "header" and "actions"');
      ly.sections = secs;
    }
    if (l.rows !== undefined) ly.rows = uniqueEnumList(l.rows, CARD_ROWS, "card.layout.rows");
    if (l.rowColumns !== undefined) {
      if (l.rowColumns !== 1 && l.rowColumns !== 2) throw new Refused("card.layout.rowColumns", "1 or 2");
      ly.rowColumns = l.rowColumns;
    }
    if (l.hide !== undefined) ly.hide = uniqueEnumList(l.hide, CARD_HIDE, "card.layout.hide");
    out.layout = ly;
  }
  if (v.motion !== undefined) {
    const mo = obj(v.motion, "card.motion");
    keys(mo, ["enter", "ms"], "card.motion");
    if (typeof mo.enter !== "string" || !CARD_ENTERS.includes(mo.enter)) throw new Refused("card.motion.enter", `one of ${CARD_ENTERS.join(", ")}`);
    out.motion = { enter: mo.enter, ms: mo.ms === undefined ? 220 : int(mo.ms, CARD_LIMITS.motionMsMin, CARD_LIMITS.motionMsMax, "card.motion.ms") };
  }
  return out;
}

/**
 * #3685: a pack's `idleVisits` — up to LIMIT.idleVisits { area, weight 1–100, minSeconds 5–600, maxSeconds minSeconds–600 },
 * each an area the pack defines, none twice; [] when it has none.
 */
function idleVisitsOf(v, areas) {
  const seen = new Set();
  return list(v ?? [], LIMIT.idleVisits, "idleVisits").map((e, i) => {
    const at = `idleVisits[${i}]`;
    obj(e, at); keys(e, ["area", "weight", "minSeconds", "maxSeconds"], at);
    if (typeof e.area !== "string" || !own(areas, e.area)) throw new Refused(`${at}.area`, "an area the pack defines");
    if (seen.has(e.area)) throw new Refused(`${at}.area`, "an area not listed before");
    seen.add(e.area);
    const minSeconds = int(e.minSeconds, 5, 600, `${at}.minSeconds`);
    return { area: e.area, weight: int(e.weight, 1, 100, `${at}.weight`), minSeconds, maxSeconds: int(e.maxSeconds, minSeconds, 600, `${at}.maxSeconds`) };
  });
}

/** M-3432 (#4255): a snack's label — string (1–24 chars) or `{ en?, "zh-TW"? }`. */
function snackLabelOf(v, at) {
  const ok = (s, here) => {
    if (typeof s !== "string" || !s.trim() || [...s.trim()].length > SNACK_LIMITS.labelMax || /[\u0000-\u001f\u007f]/.test(s)) {
      throw new Refused(here, `1–${SNACK_LIMITS.labelMax} characters`);
    }
    return s.trim();
  };
  if (typeof v === "string") return ok(v, at);
  obj(v, at);
  keys(v, ["en", "zh-TW"], at);
  const out = {};
  if (v.en !== undefined) out.en = ok(v.en, `${at}.en`);
  if (v["zh-TW"] !== undefined) out["zh-TW"] = ok(v["zh-TW"], `${at}.zh-TW`);
  if (!Object.keys(out).length) throw new Refused(at, 'a string, or { "en"?, "zh-TW"? }');
  return out;
}

/**
 * A pack's `vehicles` (a train on a loop of track): each runs round its closed `path` (logical points; the last joins
 * the first) at `speed` logical units a second, and waits `seconds` at each of its `stops` (a path point's index, with
 * the `platform` point people board from). `seats`: where riders sit, offsets from the vehicle's anchor as drawn
 * heading right (`dx` along the car, `dy` across it; fleet-office-vehicles.js seatAt places them for each heading).
 * `sprite` (its picture heading right; mirrored going left), or `sprites` by heading (`right`, `left`, `up`, `down`),
 * each a strip; `fronts` the same by heading, drawn over the riders (the car's front edge hiding their lower half). Who
 * rides is the agents' own choice (office_set `ride`), not the pack's.
 */
export const VEHICLE_LIMITS = { vehicles: 4, path: 64, stops: 8, seats: 16, minSpeed: 5, maxSpeed: 600, defaultSpeed: 80, maxSeconds: 600, defaultSeconds: 8, offset: 2000 };
const HEADINGS = ["right", "left", "up", "down"];
function vehiclesOf(v, scale) {
  if (v === undefined) return [];
  const seen = new Set();
  return list(v, VEHICLE_LIMITS.vehicles, "vehicles").map((x, i) => {
    const at = `vehicles[${i}]`;
    obj(x, at); keys(x, ["id", "label", "sprite", "sprites", "fronts", "path", "speed", "stops", "seats"], at);
    if (!nameOk(x.id) || seen.has(x.id)) throw new Refused(`${at}.id`, "a new name of letters, digits, _ or - (not an inherited one)");
    seen.add(x.id);
    if (x.label !== undefined && (typeof x.label !== "string" || !x.label.trim() || [...x.label].length > LIMIT.line || /[\u0000-\u001f\u007f]/.test(x.label))) throw new Refused(`${at}.label`, `1–${LIMIT.line} characters`);
    if (x.sprite === undefined && x.sprites === undefined) throw new Refused(at, "a sprite, or sprites by heading");
    let sprites = null;
    if (x.sprites !== undefined) {
      obj(x.sprites, `${at}.sprites`); keys(x.sprites, HEADINGS, `${at}.sprites`);
      sprites = {};
      for (const h of HEADINGS) if (x.sprites[h] !== undefined) sprites[h] = checkStrip(x.sprites[h], `${at}.sprites.${h}`, scale);
      if (!Object.keys(sprites).length) throw new Refused(`${at}.sprites`, "at least one heading");
    }
    let fronts = null;
    if (x.fronts !== undefined) {
      obj(x.fronts, `${at}.fronts`); keys(x.fronts, HEADINGS, `${at}.fronts`);
      fronts = {};
      for (const h of HEADINGS) if (x.fronts[h] !== undefined) fronts[h] = checkStrip(x.fronts[h], `${at}.fronts.${h}`, scale);
    }
    const path = list(x.path, VEHICLE_LIMITS.path, `${at}.path`).map((p, j) => point(p, `${at}.path[${j}]`));
    if (path.length < 3) throw new Refused(`${at}.path`, "at least 3 points (a loop)");
    const speed = x.speed === undefined ? VEHICLE_LIMITS.defaultSpeed : num(x.speed, VEHICLE_LIMITS.minSpeed, VEHICLE_LIMITS.maxSpeed, `${at}.speed`);
    const taken = new Set();
    const stops = list(x.stops ?? [], VEHICLE_LIMITS.stops, `${at}.stops`).map((s, j) => {
      const here = `${at}.stops[${j}]`;
      obj(s, here); keys(s, ["at", "seconds", "platform"], here);
      const k = int(s.at, 0, path.length - 1, `${here}.at`);
      if (taken.has(k)) throw new Refused(`${here}.at`, "a path point no other stop has");
      taken.add(k);
      return { at: k, seconds: s.seconds === undefined ? VEHICLE_LIMITS.defaultSeconds : num(s.seconds, 1, VEHICLE_LIMITS.maxSeconds, `${here}.seconds`), platform: point(s.platform, `${here}.platform`) };
    });
    const seats = list(x.seats ?? [], VEHICLE_LIMITS.seats, `${at}.seats`).map((s, j) => {
      const here = `${at}.seats[${j}]`;
      obj(s, here); keys(s, ["dx", "dy"], here);
      return { dx: num(s.dx ?? 0, -VEHICLE_LIMITS.offset, VEHICLE_LIMITS.offset, `${here}.dx`), dy: num(s.dy ?? 0, -VEHICLE_LIMITS.offset, VEHICLE_LIMITS.offset, `${here}.dy`) };
    });
    if (seats.length && !stops.length) throw new Refused(`${at}.stops`, "at least one stop, for its seats to be boarded");
    return { id: x.id, ...(x.label !== undefined ? { label: x.label.trim() } : {}), sprite: x.sprite === undefined ? null : checkStrip(x.sprite, `${at}.sprite`, scale),
      ...(sprites ? { sprites } : {}), ...(fronts && Object.keys(fronts).length ? { fronts } : {}), path, speed, stops, seats };
  });
}

/** M-3432 (#4255): a pack's optional `snacks` list — 1–12 snack items with sprites, optional eat overlay, and attraction radius. */
function snacksOf(v, scale) {
  if (v === undefined) return [];
  const items = list(v, SNACK_LIMITS.max, "snacks");
  if (!items.length) throw new Refused("snacks", "at least 1 snack");
  const seen = new Set();
  return items.map((e, i) => {
    const at = `snacks[${i}]`;
    obj(e, at);
    keys(e, ["id", "label", "sprite", "eat", "radius"], at);
    if (!nameOk(e.id) || seen.has(e.id)) throw new Refused(`${at}.id`, "a new name of letters, digits, _ or - (not an inherited one)");
    seen.add(e.id);
    const label = e.label === undefined ? null : snackLabelOf(e.label, `${at}.label`);
    const sprite = checkStrip(e.sprite, `${at}.sprite`, scale);
    const eat = e.eat === undefined ? null : checkStrip(e.eat, `${at}.eat`, scale);
    const radius = e.radius === undefined ? SNACK_LIMITS.defaultRadius : num(e.radius, SNACK_LIMITS.minRadius, SNACK_LIMITS.maxRadius, `${at}.radius`);
    return { id: e.id, ...(label !== null ? { label } : {}), sprite, ...(eat ? { eat } : {}), radius };
  });
}

/** M-3432 (#4255): display label for a checked snack in `lang` ("en" or "zh-TW"), falling back to its id. */
export function snackLabel(snack, lang = "en") {
  if (!snack) return "";
  if (typeof snack.label === "string") return snack.label;
  if (snack.label && typeof snack.label === "object") return own(snack.label, lang) || own(snack.label, "en") || own(snack.label, "zh-TW") || snack.id;
  return snack.id;
}

/**
 * #3679: the fleet-wide `levels` (Settings → Web dashboard → Level titles, kept in web-offices.json) checked by the very
 * rules a pack's are (levelsOf): { ok: true, levels } or { ok: false, error: "<where>: <why>" }. `v` must be an object.
 */
export function checkLevels(v) {
  try {
    if (v === undefined) throw new Refused("levels", "an object");
    return { ok: true, levels: levelsOf(v) };
  } catch (err) {
    if (err instanceof Refused) return { ok: false, error: err.message };
    throw err;
  }
}

/**
 * A pack's manifest, strictly: { ok: true, pack } or { ok: false, error: "<where>: <why>" }. `kept`: a pack the host
 * keeps already (read back, not uploaded), which may hold a RESERVED id.
 */
export function checkSkinPack(x, { kept = false } = {}) {
  try {
    obj(x, "pack");
    keys(x, ["format", "id", "scale", "canvas", "background", "foreground", "matte", "areas", "stateZones", "door", "mailDrop", "waypoints", "edges", "straight", "furniture", "characters", "byInstance", "props", "bubbles", "bubblesByInstance", "room", "desk", "levels", "portraits", "dialogBox", "idleVisits", "snacks", "card", "vehicles"], "pack");
    if (x.format !== 1) throw new Refused("format", "1");
    if (typeof x.id !== "string" || !ID.test(x.id)) throw new Refused("id", "1–40 letters, digits, _ or -");
    if (BUILT_IN.has(x.id) || (!kept && RESERVED.has(x.id))) throw new Refused("id", "a built-in skin's id");
    const scale = x.scale === undefined ? 2 : int(x.scale, 1, 8, "scale");
    let canvas = null;
    if (x.canvas !== undefined) {
      if (!Array.isArray(x.canvas) || x.canvas.length !== 2) throw new Refused("canvas", "[w, h]");
      canvas = { w: int(x.canvas[0], CANVAS.min.w, CANVAS.max.w, "canvas[0]"), h: int(x.canvas[1], CANVAS.min.h, CANVAS.max.h, "canvas[1]") };
    }
    C = canvas || LOGICAL;
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
      const [rx, ry] = [num(a.rect[0], 0, C.w, `${at}.rect[0]`), num(a.rect[1], 0, C.h, `${at}.rect[1]`)];
      const rect = { x: rx, y: ry, w: num(a.rect[2], 1, C.w - rx, `${at}.rect[2]`), h: num(a.rect[3], 1, C.h - ry, `${at}.rect[3]`) };
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
    if (x.idleVisits !== undefined && !stateZones) throw new Refused("idleVisits", "only with stateZones");
    const idleVisits = idleVisitsOf(x.idleVisits, areas);
    const waypoints = [], ids = new Set();
    for (const [i, w] of list(x.waypoints ?? [], LIMIT.waypoints, "waypoints").entries()) {
      const at = `waypoints[${i}]`;
      obj(w, at); keys(w, ["id", "x", "y"], at);
      if (typeof w.id !== "string" || !ID.test(w.id) || ids.has(w.id)) throw new Refused(`${at}.id`, "a new name of letters, digits, _ or -");
      ids.add(w.id);
      waypoints.push({ id: w.id, x: num(w.x, 0, C.w, `${at}.x`), y: num(w.y, 0, C.h, `${at}.y`) });
    }
    const edges = list(x.edges ?? [], LIMIT.edges, "edges").map((e, i) => {
      if (!Array.isArray(e) || e.length !== 2 || !ids.has(e[0]) || !ids.has(e[1]) || e[0] === e[1]) throw new Refused(`edges[${i}]`, "two different waypoint ids");
      return [e[0], e[1]];
    });
    const fids = new Set();
    const furniture = list(x.furniture ?? [], LIMIT.furniture, "furniture").map((f, i) => {
      const at = `furniture[${i}]`;
      obj(f, at); keys(f, ["id", "sprite", "x", "y", "depth", "activeWhen", "activeSprite", "activeFor", "loop", "activeOn", "hides", "label", "night", "walk"], at);
      if (!nameOk(f.id) || fids.has(f.id)) throw new Refused(`${at}.id`, "a new name of letters, digits, _ or - (not an inherited one)");
      fids.add(f.id);
      if (f.activeSprite !== undefined && f.activeWhen === undefined) throw new Refused(`${at}.activeSprite`, "only with activeWhen");
      if (f.activeFor !== undefined && f.activeWhen === undefined) throw new Refused(`${at}.activeFor`, "only with activeWhen");
      if (f.loop !== undefined && typeof f.loop !== "boolean") throw new Refused(`${at}.loop`, "true or false");
      if (f.activeOn !== undefined && f.activeOn !== "state" && f.activeOn !== "seated") throw new Refused(`${at}.activeOn`, '"state" or "seated"');
      if (f.activeOn !== undefined && f.activeWhen === undefined) throw new Refused(`${at}.activeOn`, "only with activeWhen");
      if (f.hides !== undefined && typeof f.hides !== "boolean") throw new Refused(`${at}.hides`, "true or false");
      if (f.hides !== undefined && f.activeFor === undefined) throw new Refused(`${at}.hides`, "only with activeFor");
      if (f.label !== undefined && (typeof f.label !== "string" || !f.label.trim() || [...f.label].length > LIMIT.line || /[\u0000-\u001f\u007f]/.test(f.label))) throw new Refused(`${at}.label`, `1–${LIMIT.line} characters`);
      return { id: f.id, sprite: checkStrip(f.sprite, `${at}.sprite`, scale), x: num(f.x, 0, C.w, `${at}.x`), y: num(f.y, 0, C.h, `${at}.y`),
        depth: f.depth === "y" ? "y" : depth(f.depth ?? 0, `${at}.depth`), activeWhen: f.activeWhen === undefined ? null : states(f.activeWhen, `${at}.activeWhen`),
        activeSprite: f.activeSprite === undefined ? null : checkStrip(f.activeSprite, `${at}.activeSprite`, scale),
        activeFor: f.activeFor === undefined ? null : names(f.activeFor, `${at}.activeFor`), loop: f.loop === true,
        activeOn: f.activeOn === "seated" ? "seated" : "state", hides: f.hides === true, label: f.label === undefined ? null : f.label.trim(), night: nightOf(f.night, `${at}.night`, scale),
        walk: walkOf(f.walk, `${at}.walk`, scale) };
    }).sort((a, b) => order(a) - order(b));
    const sets = obj(x.characters, "characters");
    if (Object.keys(sets).length > LIMIT.sets) throw new Refused("characters", `at most ${LIMIT.sets} sets`);
    const characters = {}, bubblesBySet = {};
    for (const [k, v] of Object.entries(sets)) {
      if (!nameOk(k)) throw new Refused(`characters.${k}`, "a name of letters, digits, _ or - (not an inherited one)");
      // #3681: a set's own lines sit beside its strips; the checked set stays strips only (packStrips, packImages).
      const { bubbles: setLines, ...poses } = obj(v, `characters.${k}`);
      characters[k] = strips(poses, SET_STRIPS, `characters.${k}`, scale);
      if (!characters[k].idle) throw new Refused(`characters.${k}.idle`, "required");
      if (setLines !== undefined) bubblesBySet[k] = bubblesOf(setLines, `characters.${k}.bubbles`);
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
    const bubbles = x.bubbles === undefined ? {} : bubblesOf(x.bubbles, "bubbles");
    // #3681: an instance's own lines, its name checked like byInstance's (an instance's name, never an inherited one).
    const bubblesByInstance = {};
    const rawVoices = x.bubblesByInstance === undefined ? {} : obj(x.bubblesByInstance, "bubblesByInstance");
    if (Object.keys(rawVoices).length > LIMIT.byInstance) throw new Refused("bubblesByInstance", `at most ${LIMIT.byInstance}`);
    for (const [k, v] of Object.entries(rawVoices)) {
      if (inherited(k)) throw new Refused(`bubblesByInstance.${k}`, "an instance's name (not an inherited one)");
      names(k, `bubblesByInstance.${k}`);
      bubblesByInstance[k] = bubblesOf(v, `bubblesByInstance.${k}`);
    }
    const levels = levelsOf(x.levels);
    const portraits = portraitsOf(x.portraits, fids), dialogBox = dialogBoxOf(x.dialogBox), card = cardOf(x.card);
    const snacks = snacksOf(x.snacks, scale);
    const vehicles = vehiclesOf(x.vehicles, scale);
    const room = x.room === undefined ? {} : obj(x.room, "room"), desk = x.desk === undefined ? {} : obj(x.desk, "desk");
    keys(room, ["floor", "wall"], "room"); keys(desk, ["back", "front", "lit"], "desk");
    const opt = (v, at) => (v === undefined ? undefined : src(v, at));
    return { ok: true, pack: {
      format: 1, id: x.id, scale, ...(canvas ? { canvas } : {}), background: opt(x.background, "background"), foreground: opt(x.foreground, "foreground"), matte: x.matte === undefined ? undefined : x.matte.toLowerCase(), areas, stateZones,
      door: x.door === undefined ? { x: C.w / 2, y: C.h - 10 } : point(x.door, "door"),
      mailDrop: x.mailDrop === undefined ? null : point(x.mailDrop, "mailDrop"), waypoints, edges, straight: x.straight === true, furniture, characters, byInstance,
      props: x.props === undefined ? {} : strips(x.props, PROPS, "props", scale), bubbles,
      // #3681: only when the pack has them, so an older pack checks to exactly what it did.
      ...(Object.keys(bubblesBySet).length ? { bubblesBySet } : {}), ...(Object.keys(bubblesByInstance).length ? { bubblesByInstance } : {}),
      room: { floor: opt(room.floor, "room.floor"), wall: opt(room.wall, "room.wall") }, desk: { back: opt(desk.back, "desk.back"), front: opt(desk.front, "desk.front"), lit: opt(desk.lit, "desk.lit") },
      ...(levels ? { levels } : {}), ...(idleVisits.length ? { idleVisits } : {}),
      ...(portraits ? { portraits } : {}), ...(dialogBox ? { dialogBox } : {}),
      ...(snacks.length ? { snacks } : {}), ...(card ? { card } : {}), ...(vehicles.length ? { vehicles } : {}),
    } };
  } catch (err) {
    if (err instanceof Refused) return { ok: false, error: err.message };
    throw err;
  } finally {
    C = LOGICAL;
  }
}
/** The checked pack, or null. */
export const skinPackOk = (x) => { const r = checkSkinPack(x); return r.ok ? r.pack : null; };
/** #2861 / #4256: pictures loaded lazily (portraits, dialogue-box frame, card background/frame). */
export const packPortraitImages = (pack) => {
  const p = pack.portraits, all = p ? [p.default, ...Object.values(p.byInstance), ...Object.values(p.byUser), ...Object.values(p.npc)] : [];
  const cs = pack.card && pack.card.style;
  return [...new Set([...all.flatMap((e) => (e ? Object.values(e) : [])), pack.dialogBox && pack.dialogBox.frame, pack.dialogBox && pack.dialogBox.bubble && pack.dialogBox.bubble.frame, cs && cs.backgroundImage, cs && cs.frame].filter(Boolean))];
};
/** The sheets a strip draws from, in order: `[{ src, frames }]` (single-sheet strips have one entry). */
export const stripSheets = (st) => (st && Array.isArray(st.sheets) ? st.sheets : st && st.src ? [{ src: st.src, frames: st.frames }] : []);
/** Every unique image file a strip references. */
export const stripImages = (st) => [...new Set(stripSheets(st).map((s) => s.src))];

/** The pictures the scene draws (what a loader fetches before spriteSkin draws). */
export const packSceneImages = (pack) => [...new Set([pack.background, pack.foreground, pack.room && pack.room.floor, pack.room && pack.room.wall,
  pack.desk && pack.desk.back, pack.desk && pack.desk.front, pack.desk && pack.desk.lit,
  ...packStrips(pack).flatMap(({ strip }) => stripImages(strip))].filter(Boolean))];
/** Every image a pack names: the scene's and (#2861) the dialogue box's — what an upload must send, and nothing else. */
export const packImages = (pack) => [...new Set([...packSceneImages(pack), ...packPortraitImages(pack)])];

/** Every frame strip a checked pack names, with where (the host checks each image is frames·w × h). */
export function packStrips(pack) {
  const out = [];
  if (!pack || typeof pack !== "object") return out;
  for (const f of pack.furniture || []) {
    if (f.sprite) out.push({ at: `furniture.${f.id}.sprite`, strip: f.sprite });
    if (f.activeSprite) out.push({ at: `furniture.${f.id}.activeSprite`, strip: f.activeSprite });
    if (f.night && f.night.sprite) out.push({ at: `furniture.${f.id}.night.sprite`, strip: f.night.sprite });
    for (const [k, st] of Object.entries(f.walk || {})) out.push({ at: `furniture.${f.id}.walk.${k}`, strip: st });
  }
  for (const [k, set] of Object.entries(pack.characters || {})) for (const [pose, st] of Object.entries(set)) out.push({ at: `characters.${k}.${pose}`, strip: st });
  for (const [k, st] of Object.entries(pack.props || {})) out.push({ at: `props.${k}`, strip: st });
  for (const sn of pack.snacks || []) {
    if (sn.sprite) out.push({ at: `snacks.${sn.id}.sprite`, strip: sn.sprite });
    if (sn.eat) out.push({ at: `snacks.${sn.id}.eat`, strip: sn.eat });
  }
  for (const v of pack.vehicles || []) {
    if (v.sprite) out.push({ at: `vehicles.${v.id}.sprite`, strip: v.sprite });
    for (const [h, st] of Object.entries(v.sprites || {})) out.push({ at: `vehicles.${v.id}.sprites.${h}`, strip: st });
    for (const [h, st] of Object.entries(v.fronts || {})) out.push({ at: `vehicles.${v.id}.fronts.${h}`, strip: st });
  }
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
export function checkLayoutOverrides(x, canvas = LOGICAL) {
  C = canvas;
  try {
    obj(x, "overrides");
    keys(x, ["pack", "seats", "furniture", "furnitureNight", "seatFor", "door", "mailDrop", "waypoints", "edges"], "overrides");
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
    if (x.mailDrop !== undefined) { const q = point(x.mailDrop, "overrides.mailDrop"); out.mailDrop = [q.x, q.y]; }
    if (x.edges !== undefined && x.waypoints === undefined) throw new Refused("overrides.edges", "only with waypoints");
    if (x.waypoints !== undefined) {
      const ids = new Set();
      out.waypoints = list(x.waypoints, OV_LIMIT.waypoints, "overrides.waypoints").map((w, i) => {
        const at = `overrides.waypoints[${i}]`;
        obj(w, at); keys(w, ["id", "x", "y"], at);
        if (typeof w.id !== "string" || !ID.test(w.id) || ids.has(w.id)) throw new Refused(`${at}.id`, "a new name of letters, digits, _ or -");
        ids.add(w.id);
        return { id: w.id, x: num(w.x, 0, C.w, `${at}.x`), y: num(w.y, 0, C.h, `${at}.y`) };
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
  } finally {
    C = LOGICAL;
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
    // Every point on the pack's own canvas (overrides checked before their pack was known were held to the largest).
    const cv = canvasOf(pack), on = (q, at) => { if (q && (q[0] > cv.w || q[1] > cv.h)) throw new Refused(at, `a point on the canvas (${cv.w}×${cv.h})`); };
    for (const [id, q] of Object.entries(ov.furniture || {})) on(q, `overrides.furniture.${id}`);
    for (const [id, q] of Object.entries(ov.furnitureNight || {})) on(q, `overrides.furnitureNight.${id}`);
    on(ov.door, "overrides.door"); on(ov.mailDrop, "overrides.mailDrop");
    for (const [i, w] of (ov.waypoints || []).entries()) on([w.x, w.y], `overrides.waypoints[${i}]`);
    const door = ov.door ? { x: ov.door[0], y: ov.door[1] } : pack.door;
    const mailDrop = ov.mailDrop ? { x: ov.mailDrop[0], y: ov.mailDrop[1] } : pack.mailDrop ?? null;
    const graph = ov.waypoints ? { waypoints: ov.waypoints.map((w) => ({ ...w })), edges: (ov.edges || []).map((e) => [e[0], e[1]]) } : { waypoints: pack.waypoints, edges: pack.edges };
    return { ok: true, pack: { ...pack, areas, furniture, door, mailDrop, ...graph } };
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
  // #2736: a mail drop placed (the pack has none) or moved from the pack's.
  const md = pack.mailDrop ?? null, ed = edited.mailDrop ?? null;
  if (ed && (!md || md.x !== ed.x || md.y !== ed.y)) ov.mailDrop = [ed.x, ed.y];
  if (!same(pack.waypoints, edited.waypoints) || !same(pack.edges, edited.edges)) {
    ov.waypoints = edited.waypoints.map((w) => ({ id: w.id, x: w.x, y: w.y }));
    ov.edges = edited.edges.map((e) => [e[0], e[1]]);
  }
  return Object.keys(ov).length > 1 ? ov : null;
}

// ── Drawing a strip: which one a pose shows, and the box it covers ──

/**
 * The strip a character set shows for `pose` (heading: the current step { dx, dy }, while walking): { strip, mirror }, or
 * null (no set). Walking: |dy| > |dx| → walkDown (dy > 0) or walkUp, else walkSide (moving left: the set's own walkLeft,
 * else walkSide mirrored); a missing one → "walk" (never mirrored) → idle. Any other pose: its own strip, else idle.
 */
export function poseStrip(set, pose, heading = null) {
  if (!set || typeof set !== "object") return null;
  if (pose === "walk" && heading) {
    const dx = Number(heading.dx) || 0, dy = Number(heading.dy) || 0;
    if (dx || dy) {
      const dir = Math.abs(dy) > Math.abs(dx) ? (dy > 0 ? "walkDown" : "walkUp") : "walkSide";
      const left = dir === "walkSide" && dx < 0 ? own(set, "walkLeft") : null;
      if (left) return { strip: left, mirror: false };
      const st = own(set, dir);
      if (st) return { strip: st, mirror: dir === "walkSide" && dx < 0 };
    }
  }
  const st = own(set, pose) || own(set, "idle");
  return st ? { strip: st, mirror: false } : null;
}
/** #4504: what the card's pose preview offers — every pose a character set may draw, walking by direction. */
export const PREVIEW_POSES = ["idle", "working", "paused", "needs", "walkDown", "walkUp", "walkSide", "walkLeft", "eat", "pat", "dragged", "stand"];
const PREVIEW_HEADINGS = { walkDown: { dx: 0, dy: 1 }, walkUp: { dx: 0, dy: -1 }, walkSide: { dx: 1, dy: 0 }, walkLeft: { dx: -1, dy: 0 } };
/** A look showing `pose` in place (a walking direction walks on the spot); a set without that strip shows its own pose. */
export function previewLook(look, pose) {
  const heading = PREVIEW_HEADINGS[pose];
  return heading ? { ...look, pose: "walk", heading } : { ...look, pose, basePose: look.pose };
}
/** The strip a furniture item shows while it walks (#2596: an NPC with `walk`, `walking` and `heading` set where it is
 * drawn): its walk strip by heading, as a character's (poseStrip); null when it stands (its own sprite, as before). */
export const walkStrip = (f) => (f && f.walking && f.walk ? poseStrip(f.walk, "walk", f.heading) : null);
/** The box (logical units) a strip covers with its anchor at (x, y): its displayed size; mirrored about the anchor. */
export function stripBox(st, x, y, mirror = false) {
  const kx = st.dw / st.w, ky = st.dh / st.h;
  return { x: Math.round(x - (mirror ? st.w - st.ax : st.ax) * kx), y: Math.round(y - st.ay * ky), w: st.dw, h: st.dh };
}

// ── M-3394 (#4231): multi-sheet & variable-duration strip playback ──

const DURATION_INDEX = new WeakMap();
const SHEET_INDEX = new WeakMap();

/** Binary search for the smallest index `i` in strictly-increasing `ends` with `value < ends[i]`. */
function upperBound(ends, value) {
  let lo = 0, hi = ends.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (value < ends[mid]) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

function durationIndex(st) {
  let idx = DURATION_INDEX.get(st);
  if (idx) return idx;
  const ends = new Array(st.durations.length);
  let sum = 0;
  for (let i = 0; i < st.durations.length; i++) { sum += st.durations[i]; ends[i] = sum; }
  const loopFrom = st.loopFrom > 0 && st.loopFrom < ends.length ? st.loopFrom : 0;
  const loopStart = loopFrom > 0 ? ends[loopFrom - 1] : 0;
  idx = { ends, total: sum, loopStart, loopSpan: sum - loopStart };
  DURATION_INDEX.set(st, idx);
  return idx;
}

function sheetIndex(st) {
  let idx = SHEET_INDEX.get(st);
  if (idx) return idx;
  const sheets = st.sheets, ends = new Array(sheets.length), starts = new Array(sheets.length);
  let sum = 0;
  for (let i = 0; i < sheets.length; i++) { starts[i] = sum; sum += sheets[i].frames; ends[i] = sum; }
  idx = { sheets, starts, ends };
  SHEET_INDEX.set(st, idx);
  return idx;
}

/**
 * The frame index (0 .. st.frames - 1) of a strip at elapsed time `ms`.
 * `ms <= 0` always yields frame 0 (reduced motion, still previews, or clip start).
 * Supports fixed `fps`, per-frame `durations`, `once: true` (play once and hold last frame),
 * and `loopFrom` (play intro `0 .. loopFrom - 1` once, then loop `loopFrom .. last`).
 */
export function stripFrameAt(st, ms) {
  if (!st || st.frames <= 1 || !(ms > 0)) return 0;
  if (Array.isArray(st.durations) && st.durations.length === st.frames) {
    const { ends, total, loopStart, loopSpan } = durationIndex(st);
    if (total <= 0) return 0;
    if (st.once) return ms >= total ? st.frames - 1 : upperBound(ends, ms);
    const t = loopStart > 0 && loopSpan > 0
      ? (ms < loopStart ? ms : loopStart + ((ms - loopStart) % loopSpan))
      : ms % total;
    return upperBound(ends, t);
  }
  if (!(st.fps > 0)) return 0;
  const raw = Math.floor((ms / 1000) * st.fps);
  if (st.once) return Math.min(st.frames - 1, raw);
  const lf = st.loopFrom > 0 && st.loopFrom < st.frames ? st.loopFrom : 0;
  if (lf > 0) return raw < lf ? raw : lf + ((raw - lf) % (st.frames - lf));
  return raw % st.frames;
}

/** Which image (`src`) and horizontal frame column (`col`) hold global frame index `frame` of `st`. */
export function stripCell(st, frame) {
  const f = Math.max(0, Math.min((st && st.frames ? st.frames : 1) - 1, Math.floor(Number(frame) || 0)));
  // A strip cut from a sheet (row/col) also says its row; a classic strip's cell keeps its { src, col } shape.
  const cut = !!st && (st.row !== undefined || st.col !== undefined), c0 = cut ? st.col || 0 : 0, at = cut ? { row: st.row || 0 } : {};
  if (!st || !Array.isArray(st.sheets)) return { src: st ? st.src : "", col: c0 + f, ...at };
  const { sheets, starts, ends } = sheetIndex(st);
  const i = upperBound(ends, f);
  return { src: sheets[i].src, col: c0 + f - starts[i], ...at };
}

/** The highest frame rate (frames/s) a strip needs for smooth playback; 0 when static. */
export function stripMaxFps(st) {
  if (!st || st.frames <= 1) return 0;
  if (Array.isArray(st.durations) && st.durations.length) {
    let minMs = Infinity;
    for (let i = 0; i < st.durations.length; i++) if (st.durations[i] < minMs) minMs = st.durations[i];
    return minMs > 0 && Number.isFinite(minMs) ? 1000 / minMs : 0;
  }
  return st.fps > 0 ? st.fps : 0;
}

/** M-3432 (#4255): total duration (ms) of one full pass through `st`; 0 when static or invalid. */
export function stripDurationMs(st) {
  if (!st || !(st.frames >= 1)) return 0;
  if (Array.isArray(st.durations) && st.durations.length === st.frames) {
    return durationIndex(st).total;
  }
  if (st.frames <= 1 || !(st.fps > 0)) return 0;
  return Math.round((st.frames / st.fps) * 1000);
}

/** The highest frame rate any strip in `pack` needs; 0 for built-ins without animated strips. */
export function packMaxFps(pack) {
  let max = 0;
  for (const { strip } of packStrips(pack)) {
    const f = stripMaxFps(strip);
    if (f > max) max = f;
  }
  return max;
}

/**
 * Per-entity clip clock: records when each key entered its current strip so `once` and `loopFrom`
 * start at frame 0 on pose/state changes and continue seamlessly across re-renders.
 */
export function createClipClocks() {
  const by = new Map();
  return {
    elapsed(key, strip, ms) {
      if (!(ms > 0) || !strip) return 0;
      const cur = by.get(key);
      if (cur && cur.strip === strip) return Math.max(0, ms - cur.since);
      by.set(key, { strip, since: ms });
      return 0;
    },
    prune(seen) {
      for (const k of [...by.keys()]) if (!seen.has(k)) by.delete(k);
    },
    clear() { by.clear(); },
  };
}
