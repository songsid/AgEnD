// The Office view's art (fleet-office.js draws with it on a <canvas>). A skin draws a layout that fleet-office-model.js
// (desks) or fleet-office-zones.js (zones) made. Five skins are built in. Two draw everything procedurally — little
// pixel people, desks, lamps: "pixel" (the desks layout: a room per team, a desk per instance) and "studio" (the zones
// layout: work desks, a lounge, an alert corner and a nap corner; people walk to the area for their state). The third,
// "cozy" (#2631), is the zones layout on one picture shipped with the page (a warm pixel-art office), the same built-in
// people in it; "guild" and "school" (#2947) are two more such pictures on the cozy's arrangement. Every drawing call
// goes through the OfficeSkin interface below, so a skin pack (pictures from an artist,
// format v1 in fleet-office-pack.js) can replace any part; a part a pack does not supply falls back to the built-in
// drawing. An admin uploads a pack (#2513, the host keeps it: src/web-office-skins.ts); loadPackSkin() reads it back —
// its manifest checked here again (checkSkinPack), its pictures by their content ids — and spriteSkin() draws it.
//
// ── The interface ──
//
// @typedef {"working"|"idle"|"paused"|"needs"|"walk"} OfficePose   (fleet-office-model.js POSES; "away" draws no one)
// @typedef {{ pal: OfficePalette, mode: "dark"|"light", labels: { lobby, closed, areas: { [area]: string } } }} OfficeEnv
// @typedef {{ name: string, label: string, state: string, pose: OfficePose|"away", light: "warn"|"danger"|null,
//   lamp: boolean, sign: "closed"|null, coat: string, work: number, dim: boolean, match: boolean, free: boolean,
//   badge?: { text, tier } | { mark: true } }} OfficeLook
//   (one occupant; `free`: standing in a zone, not behind a desk cell; `badge`: its level on its name tag, #2661)
// @typedef {object} OfficeSkin
// @property {string} id
// @property {object} [pack]        a checked pack (fleet-office-pack.js); with `pack.stateZones` the zones layout is used
// @property {(ctx, L, env) => void} drawFloor            desks: under everything — the stage and the corridors (L.edges)
// @property {(ctx, room, env) => void} drawRoom          desks: a room's floor, wall and name (room: autoLayout's)
// @property {(ctx, desk, look, env) => void} drawDeskBack    desks: behind the character — chair, desk top, screen, lamp
// @property {(ctx, desk, look, env) => void} drawDeskFront   desks: in front — the desk's front, its sign, folders, name tag
// @property {(ctx, L, env) => void} [drawBackground]     zones: the whole 1280×720 background, areas and their names
// @property {(ctx, item, active, ms, env) => void} [drawFurniture]   zones: one furniture item (active: activeWhen holds)
// @property {(ctx, L, env) => void} [drawForeground]     zones: a pack's foreground over the whole 1280×720 scene, above
//   the people, furniture and items in the air, below the crowd counts, name tags and bubbles
// @property {(ctx, x, y, look, env, compact?) => void} [drawTag]   zones: a name tag under feet at (x, y) (compact: #2860)
// @property {(ctx, area, n, env) => void} [drawCrowd]    zones: an area's "+n" (who found no spot in it)
// @property {(ctx, desk, look, ms, env) => void} drawCharacter   the occupant in its pose at time `ms` (0: still); in
//   zones `desk` is the character's box at its current position (its feet at desk.seat); walking, `look.heading` is
//   the current step's { dx, dy }
// @property {(look, at) => {x, y, w, h}} [charBox]   zones: the box drawCharacter covers with the feet at `at`
//   ({ x, y, walking, heading }): what hover and click hit (fleet-office-zones.js personAt)
// @property {(ctx, prop, ms, env) => void} drawProp      a traffic item in the air: { kind, hue, x, y, t }
// @property {(ctx, x, y, text, env, lift?) => void} drawBubble  a speech bubble whose tail points at (x, y), its box `lift` px higher
// @property {(env) => string} matte   #2540: the colour around the scene (the Office fills the panel; the scene is 16:9)
// @property {object|null} [backdrop]  a pack's loaded background picture (the page samples its edges for the matte)
// The desks layout's back and front layers change only when the fleet (or the zoom) does: the renderer keeps them as
// pictures and draws the characters, props and bubbles each frame. In zones the background is kept; furniture, people (walking
// along the pack's waypoints), tags, props and bubbles are drawn each frame, furniture by depth around the people (depth "y":
// among them by base y), then the foreground, then the crowd counts, tags and bubbles.
import { t } from "/assets/app-i18n.js";
import { frameAt, nameHash } from "./fleet-office-model.js";
import { CHAR_DEPTH, LOGICAL, checkSkinPack, own, packPortraitImages, packSceneImages, poseStrip, stripBox, walkStrip } from "./fleet-office-pack.js";
import { tierColours } from "./fleet-office-levels.js";

export { nameHash };

// ── The palette: the dashboard's tokens, read by the renderer; furniture keeps its own wood and metal ──

/** @typedef {{ bg, surface, surface2, border, text, text2, text3, ok, warn, danger, focus, accent, accentDim, okBg, warnBg, dangerBg, fx: { task, send, report, broadcast } }} OfficePalette */
export const DEFAULT_PAL = {
  bg: "#212121", surface: "#2f2f2f", surface2: "#3a3a3a", border: "#3d3d3d", text: "#ececec", text2: "#b4b4b4", text3: "#a3a3a3",
  ok: "#4cc38a", warn: "#e3b341", danger: "#ff8a80", focus: "#7ab7ff", fx: { task: "#b794f6", send: "#2dd4bf", report: "#f472b6", broadcast: "#fb923c" },
  // #2661: the level badges' tiers (the status tokens and their tints).
  accent: "#7ab7ff", accentDim: "rgba(122, 183, 255, 0.14)", okBg: "rgba(76, 195, 138, 0.14)", warnBg: "rgba(227, 179, 65, 0.14)", dangerBg: "rgba(255, 138, 128, 0.14)",
};
/** Light or dark, from the page's own background token (whatever chose it: the person, the system, a theme). */
export function modeOf(pal) {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(pal && pal.bg).trim());
  if (!m) return "dark";
  const [r, g, b] = m.slice(1).map((x) => parseInt(x, 16));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 140 ? "light" : "dark";
}
const ROOM = {
  dark: { floorA: "#2b313b", floorB: "#272c35", wall: "#363d49", wallLine: "#454e5d", lobbyA: "#2f3330", lobbyB: "#2b2f2c", corridor: "#2a2a2a" },
  light: { floorA: "#efe7d8", floorB: "#e8dfcd", wall: "#ddd0b8", wallLine: "#cdbd9f", lobbyA: "#e6eadf", lobbyB: "#dfe4d7", corridor: "#ececec" },
};
const WOOD = { top: "#b07a45", edge: "#8a5a30", front: "#7a4f2a", leg: "#5c3b1f" };
const METAL = { frame: "#2b2f36", screenOff: "#3d4752", screenOn: "#9fe3ff", code: "#2d6f8f", pole: "#6b6f76", shade: "#d9b13b", chair: "#454b57", chairTop: "#545b69" };
const SKIN_TONES = ["#f2c9a0", "#e5b48a", "#c98e62", "#9a6440"];
const HAIR = ["#3b2a20", "#6b4423", "#c48a3a", "#1f1f24", "#7a4f8f", "#b9b9c2", "#a8452f"];

const P = 3;                                             // one art pixel of a character, in CSS px
const CX = 44, TOP = 14;                                 // the character's centre and head top in its desk cell
const px = (ctx, x, y, w, h, c) => { ctx.fillStyle = c; ctx.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h)); };
/** An art-pixel block of the character at desk `d`: column c, row r (0, 0 is the head's top-left), w×h art px. */
const art = (ctx, d, c, r, w, h, color, dy = 0) => px(ctx, d.x + CX - 5 * P + c * P, d.y + TOP + dy + r * P, w * P, h * P, color);

/** Text shortened to `max` px with an ellipsis (canvas measures; a grapheme cluster is not split). */
export function fitText(ctx, s, max) {
  const str = String(s);
  if (!ctx.measureText || ctx.measureText(str).width <= max) return str;
  const chars = Array.from(str);
  while (chars.length && ctx.measureText(`${chars.join("")}…`).width > max) chars.pop();
  return `${chars.join("")}…`;
}

// ── The built-in pixel skin ──

function drawFloor(ctx, L, env) {
  const r = ROOM[env.mode];
  ctx.save();
  ctx.strokeStyle = r.corridor;
  ctx.lineWidth = 10;
  ctx.lineCap = "round";
  const at = new Map(L.waypoints.map((w) => [w.id, w]));
  ctx.beginPath();
  for (const [a, b] of L.edges) { const p = at.get(a), q = at.get(b); if (p && q) { ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); } }
  ctx.stroke();
  ctx.restore();
}

function drawRoom(ctx, room, env) {
  const r = ROOM[env.mode], { pal } = env, T = 16;
  const [a, b] = room.lobby ? [r.lobbyA, r.lobbyB] : [r.floorA, r.floorB];
  px(ctx, room.x, room.y, room.w, room.h, a);
  for (let y = room.y + 26; y < room.y + room.h; y += T) for (let x = room.x + (((y - room.y) / T) % 2) * T; x < room.x + room.w; x += 2 * T) {
    px(ctx, x, y, Math.min(T, room.x + room.w - x), Math.min(T, room.y + room.h - y), b);
  }
  px(ctx, room.x, room.y, room.w, 26, r.wall);
  px(ctx, room.x, room.y + 24, room.w, 2, r.wallLine);
  if (room.lobby) {                                      // a plant by the lobby's wall
    const x = room.x + room.w - 22, y = room.y + 4;
    px(ctx, x + 3, y + 12, 10, 8, "#b5653a"); px(ctx, x, y + 4, 6, 8, "#3f8f4f"); px(ctx, x + 6, y, 5, 12, "#4fa65d"); px(ctx, x + 10, y + 5, 6, 7, "#3f8f4f");
  }
  ctx.save();
  ctx.strokeStyle = pal.border;
  ctx.lineWidth = 2;
  ctx.strokeRect(room.x + 1, room.y + 1, room.w - 2, room.h - 2);
  ctx.fillStyle = pal.text;
  ctx.font = "600 12px system-ui, sans-serif";
  ctx.textBaseline = "middle";
  const name = room.lobby ? env.labels.lobby : room.name;
  ctx.fillText(fitText(ctx, name, room.w - (room.lobby ? 48 : 52)), room.x + 10, room.y + 13);
  if (!room.lobby) {
    ctx.fillStyle = pal.text3;
    ctx.font = "11px system-ui, sans-serif";
    ctx.textAlign = "right";
    ctx.fillText(String(room.desks.filter((d) => d.node).length), room.x + room.w - 10, room.y + 13);
  }
  ctx.restore();
}

function drawDeskBack(ctx, d, look) {
  ctx.save();
  if (look.dim) ctx.globalAlpha = 0.35;
  // The chair (behind the character), the desk top, the screen, the lamp — and its light while it works.
  px(ctx, d.x + 30, d.y + 26, 30, 26, METAL.chair); px(ctx, d.x + 30, d.y + 26, 30, 4, METAL.chairTop);
  px(ctx, d.x + 8, d.y + 48, 80, 6, WOOD.top); px(ctx, d.x + 8, d.y + 53, 80, 1, WOOD.edge);
  if (look.lamp) {                                       // its light, from the shade down onto the desk
    ctx.fillStyle = "rgba(255, 214, 102, 0.5)";
    ctx.beginPath(); ctx.moveTo(d.x + 11, d.y + 31); ctx.lineTo(d.x + 19, d.y + 31); ctx.lineTo(d.x + 30, d.y + 49); ctx.lineTo(d.x + 8, d.y + 49); ctx.closePath(); ctx.fill();
  }
  px(ctx, d.x + 62, d.y + 28, 24, 18, METAL.frame); px(ctx, d.x + 64, d.y + 30, 20, 13, look.lamp ? METAL.screenOn : METAL.screenOff);
  px(ctx, d.x + 72, d.y + 46, 4, 2, METAL.frame);
  px(ctx, d.x + 11, d.y + 46, 8, 2, METAL.pole); px(ctx, d.x + 14, d.y + 31, 2, 15, METAL.pole);
  px(ctx, d.x + 9, d.y + 26, 12, 5, look.lamp ? "#ffd86b" : METAL.shade);
  ctx.restore();
}

function drawCharacter(ctx, d, look, ms, env) {
  if (look.pose === "away") return;
  const h = nameHash(look.name), skin = SKIN_TONES[h % SKIN_TONES.length], hair = HAIR[(h >>> 3) % HAIR.length];
  const coat = look.coat, shirt = "#f4f1ea", eye = "#1d1d22";
  const f = frameAt(ms, FRAMES[look.pose] || 1, FPS);
  ctx.save();
  if (look.dim) ctx.globalAlpha = 0.35;
  const head = (dy, closed) => {
    art(ctx, d, 2, 0, 6, 2, hair, dy); art(ctx, d, 2, 2, 6, 4, skin, dy); art(ctx, d, 2, 2, 1, 2, hair, dy); art(ctx, d, 7, 2, 1, 2, hair, dy);
    if (closed) { art(ctx, d, 3, 4, 1, 0.34, eye, dy); art(ctx, d, 6, 4, 1, 0.34, eye, dy); }
    else { art(ctx, d, 3, 3, 1, 1, eye, dy); art(ctx, d, 6, 3, 1, 1, eye, dy); }
    art(ctx, d, 2.6, 4.6, 0.7, 0.5, "rgba(255, 120, 120, 0.45)", dy); art(ctx, d, 6.7, 4.6, 0.7, 0.5, "rgba(255, 120, 120, 0.45)", dy);
  };
  const body = (dy) => { art(ctx, d, 1, 6, 8, 5, coat, dy); art(ctx, d, 4, 6, 2, 2, shirt, dy); };
  if (look.pose === "working") {
    head(0, false); body(0);
    // Typing: the hands take turns on the keyboard; the screen's lines change.
    art(ctx, d, 0, 8, 1, 3, coat); art(ctx, d, 9, 8, 1, 3, coat);
    art(ctx, d, 1, f % 2 ? 10.4 : 11, 2, 0.8, skin); art(ctx, d, 7, f % 2 ? 11 : 10.4, 2, 0.8, skin);
    if (!look.free) {                                    // the keyboard and the screen's lines (in zones the desk is furniture)
      px(ctx, d.x + 30, d.y + 47, 28, 3, "#d8d8dc");
      for (let i = 0; i < 3; i++) px(ctx, d.x + 66, d.y + 32 + i * 4, 4 + ((f + i * 3) % 4) * 3, 2, METAL.code);
    }
  } else if (look.pose === "idle") {
    head(0, false); body(0);
    // Tea: the cup comes up to sip on the second half of the loop; steam rises while it is down.
    const up = f >= 2;
    art(ctx, d, 0, 8, 1, 3, coat);
    if (up) { art(ctx, d, 7, 6, 2, 2, coat); art(ctx, d, 6, 4.7, 2, 1.6, "#ffffff"); art(ctx, d, 6, 4.7, 2, 0.4, "#8a5a30"); }
    else {
      art(ctx, d, 9, 8, 1, 2, coat); art(ctx, d, 8.6, 9.6, 2, 1.8, "#ffffff"); art(ctx, d, 8.6, 9.6, 2, 0.4, "#8a5a30");
      art(ctx, d, 9 + (f % 2) * 0.7, 7.6 - f * 0.5, 0.5, 0.8, "rgba(220, 220, 230, 0.7)");
    }
  } else if (look.pose === "paused") {
    // Asleep: head down on the desk, arms folded under it; Zzz rising.
    body(3); art(ctx, d, 1, 9.2, 8, 1.5, coat); head(4, true);
    ctx.fillStyle = env.pal.text2;
    ctx.font = "700 11px system-ui, sans-serif";
    const zs = ms > 0 ? f + 1 : 3;
    for (let i = 0; i < zs; i++) ctx.fillText(i ? "z" : "Z", d.x + CX + 12 + i * 7, d.y + TOP + 6 - i * 6);
  } else if (look.pose === "needs") {
    head(0, false); body(0);
    // A hand up, waving; the call light over the head blinks (warn, or danger when it crashed).
    art(ctx, d, 0, 8, 1, 3, coat); art(ctx, d, 9, 2 + f, 1, 6 - f, coat); art(ctx, d, 9 - f * 0.4, 1 + f, 1.4, 1.2, skin);
    const on = ms <= 0 || f === 0, c = look.light === "danger" ? env.pal.danger : env.pal.warn;
    ctx.globalAlpha = (look.dim ? 0.35 : 1) * (on ? 1 : 0.35);
    if (on) { ctx.fillStyle = c; ctx.globalAlpha *= 0.25; ctx.beginPath(); ctx.arc(d.x + CX, d.y + 6, 9, 0, Math.PI * 2); ctx.fill(); ctx.globalAlpha = look.dim ? 0.35 : 1; }
    px(ctx, d.x + CX - 4, d.y + 2, 8, 7, c); px(ctx, d.x + CX - 3, d.y + 9, 6, 2, METAL.pole);
  } else {
    // Walking: a bob, arms and legs swinging in turn.
    const up = f ? -1 : 0;
    head(up, false); body(up); art(ctx, d, 0, 7 + f * 0.5, 1, 3, coat, up); art(ctx, d, 9, 7.5 - f * 0.5, 1, 3, coat, up);
  }
  if (look.free && look.pose !== "paused") {             // standing: legs (behind a desk cell they are hidden)
    const step = look.pose === "walk" ? f : 0, legs = "#3a3f4b";
    art(ctx, d, 2.5, 11, 2, step ? 1.6 : 2, legs); art(ctx, d, 5.5, 11, 2, step ? 2 : 1.6, legs);
  }
  ctx.restore();
}

function drawDeskFront(ctx, d, look, env) {
  const { pal } = env;
  ctx.save();
  if (look.dim) ctx.globalAlpha = 0.35;
  if (!look.frontless) {                                 // (a skin pack's desk front drew it already)
    px(ctx, d.x + 10, d.y + 54, 76, 16, WOOD.front); px(ctx, d.x + 10, d.y + 54, 76, 2, WOOD.edge);
    px(ctx, d.x + 12, d.y + 70, 4, 6, WOOD.leg); px(ctx, d.x + 80, d.y + 70, 4, 6, WOOD.leg);
  }
  // The work it was given (a delegation in progress): a folder each, up to three.
  for (let i = 0; i < Math.min(3, look.work); i++) { px(ctx, d.x + 20 - i, d.y + 45 - i * 2, 12, 3, pal.fx.task); px(ctx, d.x + 20 - i, d.y + 44 - i * 2, 5, 1, pal.fx.task); }
  if (look.sign === "closed") {
    px(ctx, d.x + 30, d.y + 57, 36, 11, pal.surface2);
    ctx.strokeStyle = pal.text3; ctx.lineWidth = 1; ctx.strokeRect(d.x + 30.5, d.y + 57.5, 35, 10);
    ctx.fillStyle = pal.text2; ctx.font = "600 8px system-ui, sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(fitText(ctx, env.labels.closed, 32), d.x + 48, d.y + 63);
  }
  // The name tag (#2554: none when `notag` — a tile too small to read it; the page draws it again on hover).
  if (!look.notag) {
    ctx.fillStyle = pal.surface;
    ctx.fillRect(d.x + 6, d.y + 78, d.w - 12, 16);
    ctx.strokeStyle = look.match ? pal.focus : pal.border;
    ctx.lineWidth = look.match ? 2 : 1;
    ctx.strokeRect(d.x + 6.5, d.y + 78.5, d.w - 13, 15);
    ctx.fillStyle = pal.text; ctx.font = "600 11px system-ui, sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(fitText(ctx, look.label, d.w - 18), d.x + d.w / 2, d.y + 86.5);
  }
  ctx.restore();
  if (!look.notag && look.badge) drawBadge(ctx, d.x + 6, d.y + 78, look.badge, pal);
  if (look.match) { ctx.save(); ctx.strokeStyle = pal.focus; ctx.lineWidth = 2; ctx.strokeRect(d.x + 2, d.y + 2, d.w - 4, d.h - 6); ctx.restore(); }
}

const Q = 2;                                             // a prop's art pixel, before PROP_SCALE
/**
 * #2946: the built-in props are drawn this much larger than their 16 px art (a pack's own `props` keep their size). In
 * the scene's units, so they scale with the room as its people do (zoom, a phone, an All offices tile).
 */
export const PROP_SCALE = 1.75;
function drawProp(ctx, it, ms, env) {
  const c = env.pal.fx[it.hue] || env.pal.fx.send, lift = Math.sin(Math.PI * it.t) * 10;
  const b = (c2, r, w, h, col) => px(ctx, -8 + c2 * Q, -8 + r * Q, w * Q, h * Q, col);
  ctx.save();
  ctx.translate(it.x, it.y);
  ctx.scale(PROP_SCALE, PROP_SCALE);
  ctx.fillStyle = "rgba(0, 0, 0, 0.18)";
  ctx.beginPath(); ctx.ellipse(0, 4, 7, 2.5, 0, 0, Math.PI * 2); ctx.fill();
  ctx.translate(0, -lift);
  if (it.hue === "task") { b(0, 0, 4, 2, c); b(0, 1, 8, 6, c); b(0, 2, 8, 1, "rgba(255, 255, 255, 0.35)"); }
  else if (it.hue === "report") { b(1, 0, 6, 8, "#fbfbfb"); b(1, 0, 6, 1, c); b(2, 4, 1, 1, c); b(3, 5, 1, 1, c); b(4, 4, 1, 1, c); b(5, 3, 1, 1, c); }
  else if (it.hue === "broadcast") { b(0, 3, 2, 2, c); b(2, 2, 2, 4, c); b(4, 1, 2, 6, c); if (frameAt(ms, 2, 6)) { b(7, 1, 1, 2, c); b(7, 5, 1, 2, c); } else b(7, 3, 1, 2, c); }
  else { b(0, 1, 8, 6, c); for (const [cc, r] of [[0, 1], [1, 2], [2, 3], [3, 4], [4, 4], [5, 3], [6, 2], [7, 1]]) b(cc, r, 1, 1, "#ffffff"); }
  ctx.restore();
}

/** Frames per pose and the loop's speed (the built-in strips). */
export const FRAMES = { working: 4, idle: 4, paused: 3, needs: 2, walk: 2 };
export const FPS = 4;

const BUBBLE_FONT = "600 11px system-ui, sans-serif";
/**
 * The box a speech bubble with its tail at (x, y) takes for `text` (its tail excluded): what drawBubble draws, and what
 * the Office places so no two overlap (#2431: two neighbours' bubbles covered each other on a phone).
 */
export function bubbleBox(ctx, x, y, text, lift = 0) {
  ctx.save();
  ctx.font = BUBBLE_FONT;
  const t = fitText(ctx, text, 150), w = Math.ceil((ctx.measureText ? ctx.measureText(t).width : t.length * 6) + 14), h = 19;
  ctx.restore();
  const bx = Math.round(x - 10), by = Math.round(y - h - 6 - lift);
  return { x: bx, y: by, w, h, text: t };
}

/** A speech bubble, its tail at (x, y): short words on light paper in either theme; `lift` raises the box (its tail longer). */
function drawBubble(ctx, x, y, text, env, lift = 0) {
  if (!text) return;
  const { x: bx, y: by, w, h, text: t } = bubbleBox(ctx, x, y, text, lift);
  ctx.save();
  ctx.font = BUBBLE_FONT;
  ctx.fillStyle = "#fffdf6"; ctx.strokeStyle = env.mode === "light" ? "rgba(0, 0, 0, 0.35)" : "rgba(0, 0, 0, 0.6)"; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(bx + 4, by); ctx.lineTo(bx + w - 4, by); ctx.lineTo(bx + w, by + 4); ctx.lineTo(bx + w, by + h - 4); ctx.lineTo(bx + w - 4, by + h);
  ctx.lineTo(x + 6, by + h); ctx.lineTo(x, y); ctx.lineTo(x + 1, by + h); ctx.lineTo(bx + 4, by + h); ctx.lineTo(bx, by + h - 4); ctx.lineTo(bx, by + 4); ctx.closePath();
  ctx.fill(); ctx.stroke();
  ctx.fillStyle = "#1d1d22"; ctx.textBaseline = "middle"; ctx.textAlign = "left";
  ctx.fillText(t, bx + 7, by + h / 2 + 0.5);
  ctx.restore();
}

/** A zones name tag's widest text (logical units): longer names are cut with an ellipsis. */
export const TAG_TEXT_W = 84;
const TAG_FONT = "600 10px system-ui, sans-serif";
/**
 * #2860: the compact tag a crowded area keeps on (it used to show tags on hover only, #2513): a smaller font, a smaller
 * plate, a shorter cut, the same level badge.
 */
const COMPACT = { font: "500 9px system-ui, sans-serif", textW: 48, pad: 6, top: 2, h: 11 };
const NORMAL = { font: TAG_FONT, textW: TAG_TEXT_W, pad: 10, top: 3, h: 14 };
/** The box a name tag under feet at (x, y) takes (what drawTag draws; bubbles keep clear of it, #2513). */
export function tagBox(ctx, x, y, label, compact = false) {
  const k = compact ? COMPACT : NORMAL;
  ctx.save();
  ctx.font = k.font;
  const t = fitText(ctx, label, k.textW), w = Math.ceil((ctx.measureText ? ctx.measureText(t).width : t.length * 6) + k.pad);
  ctx.restore();
  return { x: Math.round(x - w / 2), y: y + k.top, w, h: k.h, text: t };
}
/** #2860: what a tag covers with its level badge: on a full tag's top-left corner (half outside); left of a compact one. */
export function tagFootprint(ctx, box, badge, compact = false) {
  if (!badge) return box;
  if (compact) { const w = badgeWidth(ctx, badge) + 1; return { x: box.x - w, y: box.y, w: box.w + w, h: box.h }; }
  return { x: box.x - 10, y: box.y - 7, w: box.w + 10, h: box.h + 7 };
}
function badgeWidth(ctx, badge) {
  if (badge.mark) return 8;
  ctx.save();
  ctx.font = BADGE_FONT;
  const w = Math.max(12, Math.ceil((ctx.measureText ? ctx.measureText(badge.text).width : badge.text.length * 5) + 6));
  ctx.restore();
  return w;
}
/**
 * #2661: a level badge on a name tag's top-left corner (x, y: the tag's corner), overlapping its edge like an app's
 * badge — it takes none of the tag's width. `badge`: { text, tier } (fleet-office-levels.js badgeOf), or { mark } for a
 * pinned title that hides the number: a small diamond.
 */
export function drawBadge(ctx, x, y, badge, pal, inline = false) {
  if (!badge) return;
  // #2860 inline (a compact tag): (x, y) is the tag's left edge and middle; the badge sits just left of it, whole.
  if (inline) { const w = badgeWidth(ctx, badge); x = x - 1 - w + (badge.mark ? w / 2 : w / 2 - 3); y = y + (badge.mark ? 0 : 1); }
  const c = tierColours(badge.tier, pal);
  ctx.save();
  ctx.globalAlpha = 1;
  if (badge.mark) {
    ctx.translate(x, y); ctx.rotate(Math.PI / 4);
    ctx.fillStyle = pal.surface; ctx.fillRect(-4, -4, 8, 8);
    ctx.fillStyle = c.bg; ctx.fillRect(-4, -4, 8, 8);
    ctx.strokeStyle = c.line; ctx.lineWidth = 1; ctx.strokeRect(-3.5, -3.5, 7, 7);
    ctx.restore();
    return;
  }
  ctx.font = BADGE_FONT;
  const w = Math.max(12, Math.ceil((ctx.measureText ? ctx.measureText(badge.text).width : badge.text.length * 5) + 6)), h = 11;
  const bx = Math.round(x - w / 2 + 3), by = Math.round(y - h / 2 - 1);
  // An opaque surface first, so a tint reads the same over any picture.
  ctx.fillStyle = pal.surface; ctx.fillRect(bx, by, w, h);
  ctx.fillStyle = c.bg; ctx.fillRect(bx, by, w, h);
  ctx.strokeStyle = c.line; ctx.lineWidth = 1; ctx.strokeRect(bx + 0.5, by + 0.5, w - 1, h - 1);
  ctx.fillStyle = c.fg; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText(badge.text, bx + w / 2, by + h / 2 + 0.5);
  ctx.restore();
}
const BADGE_FONT = "700 8px system-ui, sans-serif";

/** Zones: a name tag under someone's feet at (x, y); `compact` (#2860): the smaller one a crowded area keeps on. */
function drawTag(ctx, x, y, look, env, compact = false) {
  const { pal } = env;
  const b = tagBox(ctx, x, y, look.label, compact);
  ctx.save();
  if (look.dim) ctx.globalAlpha = 0.35;
  ctx.font = compact ? COMPACT.font : TAG_FONT;
  ctx.fillStyle = pal.surface; ctx.fillRect(b.x, b.y, b.w, b.h);
  ctx.strokeStyle = look.match ? pal.focus : pal.border; ctx.lineWidth = look.match ? 2 : 1; ctx.strokeRect(b.x + 0.5, b.y + 0.5, b.w - 1, b.h - 1);
  ctx.fillStyle = pal.text; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText(b.text, x, b.y + b.h / 2 + 0.5);
  ctx.restore();
  if (look.badge) compact ? drawBadge(ctx, b.x, b.y + b.h / 2, look.badge, pal, true) : drawBadge(ctx, b.x, b.y, look.badge, pal);
}

/**
 * Zones: how many more want an area than it has room for — a chip in its bottom-right corner, inside its rect, so it
 * never covers the area's name (#2513: "+42" over the nap corner's title).
 */
export function crowdChip(ctx, area, n) {
  ctx.save();
  ctx.font = "700 12px system-ui, sans-serif";
  const text = `+${n}`, w = Math.ceil((ctx.measureText ? ctx.measureText(text).width : text.length * 7) + 12), h = 18, r = area.rect;
  ctx.restore();
  return { x: Math.round(r.x + r.w - w - 6), y: Math.round(r.y + r.h - h - 6), w, h, text };
}
function drawCrowd(ctx, area, n, env) {
  if (!n) return;
  const { pal } = env, b = crowdChip(ctx, area, n);
  ctx.save();
  ctx.fillStyle = pal.surface; ctx.fillRect(b.x, b.y, b.w, b.h);
  ctx.strokeStyle = pal.border; ctx.lineWidth = 1; ctx.strokeRect(b.x + 0.5, b.y + 0.5, b.w - 1, b.h - 1);
  ctx.fillStyle = pal.text; ctx.font = "700 12px system-ui, sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText(b.text, b.x + b.w / 2, b.y + b.h / 2 + 0.5);
  ctx.restore();
}

/** The built-in character in zones covers this box around its feet (as zonesLayout's desk box). */
const charBox = (look, at) => ({ x: at.x - 24, y: at.y - 52, w: 48, h: 66 });
/** #2540: Desks' matte (around the scene): the page's background token, which the desks' floor is too (Studio has its own). */
const matte = (env) => env.pal.bg;
/** @type {OfficeSkin} */
export const pixelSkin = { id: "pixel", drawFloor, drawRoom, drawDeskBack, drawCharacter, drawDeskFront, drawProp, drawBubble, drawTag, drawCrowd, charBox, matte };

// ── The built-in studio: the zones layout, drawn procedurally ──

const grid = (xs, ys) => ys.flatMap((y) => xs.map((x) => ({ x, y })));
const HALL_X = 676;
const STUDIO_AREAS = {
  desks: { name: "desks", rect: { x: 24, y: 64, w: 632, h: 448 }, seats: grid([104, 248, 392, 536], [190, 320, 450]) },
  lounge: { name: "lounge", rect: { x: 696, y: 64, w: 560, h: 304 }, seats: grid([748, 824, 900, 976, 1052, 1128, 1204], [250, 340]) },
  alert: { name: "alert", rect: { x: 696, y: 392, w: 300, h: 304 }, seats: grid([744, 814, 884], [530, 600, 670]) },
  nap: { name: "nap", rect: { x: 1020, y: 392, w: 236, h: 304 }, seats: grid([1084, 1184], [530, 600, 670]) },
};
/** The studio's walkable graph: an aisle under each row of seats, joined to the hall that runs down the middle. */
function studioGraph(areas) {
  const waypoints = [], edges = [], hall = new Set([380, 704]);
  for (const a of Object.values(areas)) {
    for (const y of [...new Set(a.seats.map((s) => s.y))]) {
      const ay = y + 22, xs = [...new Set([...a.seats.filter((s) => s.y === y).map((s) => s.x), HALL_X])].sort((p, q) => p - q);
      hall.add(ay);
      const ids = xs.map((x) => { const id = `${a.name}-${ay}-${x}`; waypoints.push({ id, x, y: ay }); return id; });
      ids.forEach((id, k) => { if (k) edges.push([ids[k - 1], id]); });
      const join = ids[xs.indexOf(HALL_X)];
      edges.push([join, `hall-${ay}`]);
    }
  }
  const ys = [...hall].sort((p, q) => p - q);
  ys.forEach((y, k) => { waypoints.push({ id: `hall-${y}`, x: HALL_X, y }); if (k) edges.push([`hall-${ys[k - 1]}`, `hall-${y}`]); });
  return { waypoints, edges };
}
const STUDIO_FURNITURE = [
  { id: "board", shape: "board", x: 340, y: 100, depth: 5 },
  { id: "rack-work", shape: "rack", tone: "ok", x: 610, y: 160, depth: 6, activeWhen: ["working"] },
  ...STUDIO_AREAS.desks.seats.map((s, i) => ({ id: `desk-${i}`, shape: "desk", x: s.x, y: s.y, depth: 1100 })),
  { id: "sofa", shape: "sofa", x: 900, y: 150, depth: 10 },
  { id: "coffee", shape: "coffee", x: 1210, y: 130, depth: 20, activeWhen: ["idle"] },
  { id: "plant-1", shape: "plant", x: 724, y: 120, depth: 20 }, { id: "plant-2", shape: "plant", x: 40, y: 500, depth: 20 },
  { id: "rack-alert", shape: "rack", tone: "danger", x: 960, y: 460, depth: 900, activeWhen: ["needs", "stuck", "crashed"] },
  { id: "bug", shape: "bug", x: 760, y: 450, depth: 950, activeWhen: ["crashed"] },
  ...STUDIO_AREAS.nap.seats.map((s, i) => ({ id: `bag-${i}`, shape: "beanbag", x: s.x, y: s.y + 4, depth: 990 })),
].sort((a, b) => a.depth - b.depth);
/** The studio's pack: the same shape as a checked one (fleet-office-pack.js), furniture by `shape` instead of sprites. */
export const STUDIO_PACK = {
  format: 1, id: "studio", scale: 1, areas: STUDIO_AREAS, door: { x: HALL_X, y: 704 }, furniture: STUDIO_FURNITURE, ...studioGraph(STUDIO_AREAS), straight: false,
  stateZones: { working: "desks", idle: "lounge", needs: "alert", crashed: "alert", stuck: "alert", paused: "nap", stopped: "nap", default: "lounge" },
  characters: {}, byInstance: {}, props: {}, bubbles: {},
};
const ZONE_FLOOR = {
  dark: { desks: ["#2b313b", "#272c35"], lounge: ["#2c3430", "#28302c"], alert: ["#3a2c2e", "#35282a"], nap: ["#302c3a", "#2c2835"], hall: "#262626" },
  light: { desks: ["#efe7d8", "#e8dfcd"], lounge: ["#e3ecdf", "#dce6d7"], alert: ["#f3e1df", "#eed9d6"], nap: ["#e8e3f1", "#e1dbec"], hall: "#ececec" },
};
function drawBackground(ctx, L, env) {
  const { pal } = env, F = ZONE_FLOOR[env.mode], T = 24;
  px(ctx, 0, 0, LOGICAL.w, LOGICAL.h, F.hall);
  for (const a of Object.values(L.areas)) {
    const [c1, c2] = F[a.name] || F.desks, r = a.rect;
    px(ctx, r.x, r.y, r.w, r.h, c1);
    for (let y = r.y; y < r.y + r.h; y += T) for (let x = r.x + (((y - r.y) / T) % 2) * T; x < r.x + r.w; x += 2 * T) px(ctx, x, y, Math.min(T, r.x + r.w - x), Math.min(T, r.y + r.h - y), c2);
    ctx.save();
    ctx.strokeStyle = pal.border; ctx.lineWidth = 2; ctx.strokeRect(r.x + 1, r.y + 1, r.w - 2, r.h - 2);
    ctx.fillStyle = pal.text; ctx.font = "600 16px system-ui, sans-serif"; ctx.textBaseline = "top"; ctx.textAlign = "left";
    ctx.fillText(fitText(ctx, env.labels.areas[a.name] || a.name, r.w - 60), r.x + 12, r.y + 10);
    ctx.restore();
  }
}
function drawFurniture(ctx, f, active, ms, env) {
  const x = f.x, y = f.y;
  switch (f.shape) {
    case "desk":
      px(ctx, x - 40, y - 24, 80, 6, WOOD.top); px(ctx, x - 38, y - 18, 76, 18, WOOD.front); px(ctx, x - 38, y - 18, 76, 2, WOOD.edge);
      px(ctx, x + 12, y - 44, 24, 18, METAL.frame); px(ctx, x + 14, y - 42, 20, 13, METAL.screenOn); px(ctx, x + 22, y - 26, 4, 2, METAL.frame);
      break;
    case "board":
      px(ctx, x - 90, y - 26, 180, 52, "#f4f4f0"); px(ctx, x - 92, y - 28, 184, 3, "#8a8f98"); px(ctx, x - 92, y + 25, 184, 3, "#8a8f98");
      for (let i = 0; i < 4; i++) px(ctx, x - 78, y - 16 + i * 10, 40 + ((i * 37) % 90), 3, ["#4b8bf4", "#d97757", "#3fa58c", "#9b6bff"][i]);
      break;
    case "rack": {
      px(ctx, x - 22, y - 70, 44, 90, "#2b2f36"); px(ctx, x - 20, y - 68, 40, 86, "#363b44");
      const on = env.pal[f.tone] || env.pal.ok;
      for (let r = 0; r < 6; r++) for (let c = 0; c < 3; c++) {
        const lit = active && (ms <= 0 || frameAt(ms + (r * 3 + c) * 170, 2, 3) === 0);
        px(ctx, x - 14 + c * 10, y - 60 + r * 13, 6, 4, lit ? on : "#4a505a");
      }
      break;
    }
    case "sofa":
      px(ctx, x - 110, y - 30, 220, 26, "#3f7286"); px(ctx, x - 118, y - 14, 236, 34, "#4f8aa1"); px(ctx, x - 118, y - 20, 16, 40, "#3f7286"); px(ctx, x + 102, y - 20, 16, 40, "#3f7286");
      break;
    case "coffee":
      px(ctx, x - 18, y - 34, 36, 50, "#5a5f69"); px(ctx, x - 14, y - 28, 28, 12, "#2b2f36"); px(ctx, x - 6, y + 2, 12, 10, "#ffffff");
      if (active) for (let i = 0; i < 3; i++) { const k = frameAt(ms + i * 300, 4, 4); px(ctx, x - 4 + ((i + k) % 2) * 4, y - 6 - i * 7 - k, 2, 4, "rgba(230, 230, 236, 0.7)"); }
      break;
    case "plant":
      px(ctx, x - 9, y, 18, 16, "#b5653a"); px(ctx, x - 14, y - 18, 10, 18, "#3f8f4f"); px(ctx, x - 4, y - 26, 9, 26, "#4fa65d"); px(ctx, x + 5, y - 16, 10, 16, "#3f8f4f");
      break;
    case "bug": {
      const wob = active && ms > 0 ? Math.round(Math.sin(ms / 160) * 26) : 0, c = active ? env.pal.danger : "#6b6f76";
      const bx = x + wob;
      px(ctx, bx - 9, y - 6, 18, 12, c); px(ctx, bx - 5, y - 11, 10, 6, c); px(ctx, bx - 1, y - 6, 2, 12, "#1d1d22");
      for (const k of [-1, 1]) for (const r of [-4, 0, 4]) px(ctx, bx + k * 11 - (k < 0 ? 3 : 0), y + r, 3, 2, "#1d1d22");
      break;
    }
    case "beanbag":
      px(ctx, x - 26, y - 14, 52, 20, "#7a5a8c"); px(ctx, x - 22, y - 20, 44, 8, "#8d6aa0");
      break;
    default:
      break;
  }
}
/** @type {OfficeSkin} */
/** #2540: the studio's matte is its hall floor (the scene's edge), so the panel around the scene reads as more of it. */
const studioMatte = (env) => (ZONE_FLOOR[env.mode] || ZONE_FLOOR.dark).hall;
export const studioSkin = { ...pixelSkin, id: "studio", pack: STUDIO_PACK, drawBackground, drawFurniture, matte: studioMatte };

// ── Skin packs ──

/**
 * An OfficeSkin from a checked pack (fleet-office-pack.js checkSkinPack) and its loaded pictures (`images`: src → a
 * drawable image). What it lacks, or a picture not loaded, is drawn by the built-in skins.
 */
export function spriteSkin(pack, images, base = pixelSkin) {
  const img = (src) => (src && images.get(src)) || null;
  // A strip's frame at its displayed size (dw × dh, unsmoothed), its anchor on (x, y); mirrored about the anchor.
  const strip = (ctx, st, ms, x, y, frame = null, mirror = false) => {
    const im = img(st && st.src);
    if (!im) return false;
    const f = frame ?? frameAt(ms, st.frames, st.fps), b = stripBox(st, x, y, mirror);
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    if (mirror) { ctx.translate(b.x + b.w, b.y); ctx.scale(-1, 1); ctx.drawImage(im, f * st.w, 0, st.w, st.h, 0, 0, b.w, b.h); }
    else ctx.drawImage(im, f * st.w, 0, st.w, st.h, b.x, b.y, b.w, b.h);
    ctx.restore();
    return true;
  };
  const setOf = (look) => own(pack.characters, own(pack.byInstance, look.name)) || own(pack.characters, "default");
  /** The strip a look shows (its pose; walking, by its heading), when its picture is loaded. */
  const shown = (look, walking = look.pose === "walk") => {
    const ps = poseStrip(setOf(look), walking ? "walk" : look.pose, look.heading);
    return ps && img(ps.strip.src) ? ps : null;
  };
  return {
    ...base,
    id: pack.id,
    pack,
    backdrop: img(pack.background),
    drawRoom(ctx, room, env) {
      const floor = img(pack.room.floor), wall = img(pack.room.wall);
      if (!floor) { base.drawRoom(ctx, room, env); return; }
      ctx.save();
      ctx.imageSmoothingEnabled = false;
      const pat = ctx.createPattern(floor, "repeat");
      if (pat) { ctx.fillStyle = pat; ctx.fillRect(room.x, room.y, room.w, room.h); }
      if (wall) ctx.drawImage(wall, room.x, room.y, room.w, 26);
      ctx.fillStyle = env.pal.text; ctx.font = "600 12px system-ui, sans-serif"; ctx.textBaseline = "middle";
      ctx.fillText(fitText(ctx, room.lobby ? env.labels.lobby : room.name, room.w - 20), room.x + 10, room.y + 13);
      ctx.restore();
    },
    drawDeskBack(ctx, d, look, env) {
      const im = img(look.lamp && pack.desk.lit ? pack.desk.lit : pack.desk.back);
      if (!im) { base.drawDeskBack(ctx, d, look, env); return; }
      ctx.save(); ctx.imageSmoothingEnabled = false; if (look.dim) ctx.globalAlpha = 0.35; ctx.drawImage(im, d.x, d.y, d.w, d.h); ctx.restore();
    },
    drawDeskFront(ctx, d, look, env) {
      const im = img(pack.desk.front);
      if (im) { ctx.save(); ctx.imageSmoothingEnabled = false; if (look.dim) ctx.globalAlpha = 0.35; ctx.drawImage(im, d.x, d.y, d.w, d.h); ctx.restore(); }
      // The name tag, the sign and the folders are words and counts: always drawn here.
      base.drawDeskFront(ctx, d, { ...look, frontless: !!im }, env);
    },
    drawBackground(ctx, L, env) {
      const im = img(pack.background);
      if (!im) { drawBackground(ctx, L, env); return; }
      ctx.save(); ctx.imageSmoothingEnabled = false; ctx.drawImage(im, 0, 0, LOGICAL.w, LOGICAL.h); ctx.restore();
    },
    drawForeground(ctx, L, env) {
      const im = img(pack.foreground);
      if (!im) return;
      ctx.save(); ctx.imageSmoothingEnabled = false; ctx.drawImage(im, 0, 0, LOGICAL.w, LOGICAL.h); ctx.restore();
    },
    drawFurniture(ctx, f, active, ms, env) {
      if (f.shape) { drawFurniture(ctx, f, active, ms, env); return; }
      // An NPC walking (#2596): its walk strip for its heading (walkSide mirrored going left), when its picture is loaded.
      const ws = walkStrip(f);
      if (ws && strip(ctx, ws.strip, ms, f.x, f.y, null, ws.mirror)) return;
      // Active: its activeSprite (or its strip) plays; otherwise its strip loops ("loop", #2570) or its first frame holds.
      if (active) strip(ctx, f.activeSprite || f.sprite, ms, f.x, f.y);
      else if (f.loop) strip(ctx, f.sprite, ms, f.x, f.y);
      else strip(ctx, f.sprite, 0, f.x, f.y, 0);
    },
    drawCharacter(ctx, d, look, ms, env) {
      if (look.pose === "away") return;
      const ps = shown(look);
      ctx.save();
      if (look.dim) ctx.globalAlpha = 0.35;
      const done = !!ps && strip(ctx, ps.strip, ms, d.seat.x, d.seat.y, null, ps.mirror);
      ctx.restore();
      if (!done) base.drawCharacter(ctx, d, look, ms, env);
    },
    charBox(look, at) {
      const ps = shown({ ...look, heading: at.heading }, !!at.walking);
      return ps ? stripBox(ps.strip, at.x, at.y, ps.mirror) : base.charBox(look, at);
    },
    // An item in the air: its sender's own (their set's "prop", #2562), else the pack's for its kind, else the built-in one.
    drawProp(ctx, it, ms, env) {
      const mine = it.from ? own(setOf({ name: it.from }) || {}, "prop") : null;
      if (!strip(ctx, mine || own(pack.props, it.hue), ms, it.x, it.y)) base.drawProp(ctx, it, ms, env);
    },
  };
}

// ── The built-in cozy (#2631): the zones layout on a warm pixel-art office drawn as one picture, the built-in people ──

/** Its picture, shipped with the page (src/ui/shared/office/cozy.png, auth-api.ts ASSETS: public static, as the font). */
export const COZY_BACKGROUND = "/assets/office-cozy.png";
const pts = (...xy) => xy.map(([x, y]) => ({ x, y }));
// The seats are feet points on the picture: chairs in front of the desks, the sofa, the coffee table and machine, the
// beanbags (a sleeper's bottom), in front of the whiteboard. The rects put a crowd's first extra spots (fleet-office-zones.js
// overflowSpots: rows from the rect's top) on the aisles: under the first row of desks, in front of the sofa.
const COZY_AREAS = {
  desks: { name: "desks", rect: { x: 130, y: 196, w: 430, h: 220 }, seats: pts([193, 238], [336, 238], [481, 238], [193, 354], [336, 354], [481, 354]) },
  lounge: { name: "lounge", rect: { x: 700, y: 196, w: 476, h: 184 }, seats: pts([940, 240], [1025, 310], [1120, 305]) },
  alert: { name: "alert", rect: { x: 900, y: 500, w: 220, h: 110 }, seats: pts([965, 570], [1045, 570]) },
  nap: { name: "nap", rect: { x: 110, y: 470, w: 400, h: 150 }, seats: pts([180, 562], [300, 562], [422, 565]) },
};
/** Its walkable graph, on the picture's aisles, every edge across or up/down; each seat's nearest waypoint is in front of it. */
const COZY_WAYPOINTS = [
  ["door", 642, 640], ["hall", 642, 395], ["top", 642, 175],
  // the desks: the aisle under the first row (y 250), the one under the second (y 395), the column beside them (x 560)
  ["d-east", 560, 395], ["d-up", 560, 250], ["d1-3", 481, 250], ["d1-2", 336, 250], ["d1-1", 193, 250],
  ["d2-3", 481, 395], ["d2-2", 336, 395], ["d2-x", 300, 395], ["d2-1", 193, 395],
  // the beanbags: the aisle above them (y 460)
  ["n-x", 300, 460], ["n-1", 180, 460], ["n-3", 422, 460],
  // the lounge: below the coffee table (y 340), up the sofa's west end; the coffee machine's column (x 1140)
  ["l-hall", 946, 395], ["l-mid", 946, 340], ["l-west", 860, 340], ["l-sofa", 860, 250], ["l-table", 1025, 340],
  ["e-hall", 1140, 395], ["e-coffee", 1140, 305],
  // the whiteboard: in front of it (y 570), from the coffee machine's column
  ["a-east", 1140, 570], ["a-mid", 1005, 570],
].map(([id, x, y]) => ({ id, x, y }));
const COZY_EDGES = [
  ["door", "hall"], ["hall", "top"], ["hall", "d-east"], ["d-east", "d2-3"], ["d2-3", "d2-2"], ["d2-2", "d2-x"], ["d2-x", "d2-1"],
  ["d-east", "d-up"], ["d-up", "d1-3"], ["d1-3", "d1-2"], ["d1-2", "d1-1"], ["d2-x", "n-x"], ["n-x", "n-1"], ["n-x", "n-3"],
  ["hall", "l-hall"], ["l-hall", "l-mid"], ["l-mid", "l-west"], ["l-west", "l-sofa"], ["l-mid", "l-table"],
  ["l-hall", "e-hall"], ["e-hall", "e-coffee"], ["e-hall", "a-east"], ["a-east", "a-mid"],
];
/** The cozy's pack: the picture is the room; the one item is the notice board, its tag saying a pack can restyle it. */
export const COZY_PACK = {
  format: 1, id: "cozy", scale: 1, background: COZY_BACKGROUND, areas: COZY_AREAS, door: { x: 642, y: 662 },
  waypoints: COZY_WAYPOINTS, edges: COZY_EDGES, straight: true,
  furniture: [{ id: "notice", x: 1211, y: 628, depth: 5, get label() { return t("orgo.cozyNotice"); } }],
  stateZones: { working: "desks", idle: "lounge", needs: "alert", crashed: "alert", stuck: "alert", paused: "nap", stopped: "nap", default: "lounge" },
  characters: {}, byInstance: {}, props: {}, bubbles: {},
};
// The cozy's zones on every picture-backed built-in: work, lounge, the alert corner, the nap corner.
const PICTURE_ZONES = { working: "desks", idle: "lounge", needs: "alert", crashed: "alert", stuck: "alert", paused: "nap", stopped: "nap", default: "lounge" };
const wps = (list) => list.map(([id, x, y]) => ({ id, x, y }));

// ── #2947: two more on the cozy's arrangement — work top-left, the lounge top-right, the nap corner bottom-left, the
// alert corner bottom-right, one straight aisle up the middle from a bottom-centre door ──

/** The guild: a fantasy adventurers' guild hall (src/ui/shared/office/guild.png). */
export const GUILD_BACKGROUND = "/assets/office-guild.png";
// Seats: the chairs at the six map desks, the tavern bench, the stools round the table, the bar; the inn beds (a sleeper's
// middle); in front of the quest board.
const GUILD_AREAS = {
  desks: { name: "desks", rect: { x: 130, y: 190, w: 400, h: 160 }, seats: pts([180, 200], [320, 200], [450, 200], [180, 315], [320, 315], [450, 315]) },
  lounge: { name: "lounge", rect: { x: 780, y: 190, w: 440, h: 150 }, seats: pts([840, 200], [900, 200], [810, 290], [935, 290], [870, 325], [1040, 300]) },
  alert: { name: "alert", rect: { x: 860, y: 560, w: 260, h: 50 }, seats: pts([900, 590], [1000, 590], [1090, 590]) },
  nap: { name: "nap", rect: { x: 110, y: 540, w: 380, h: 80 }, seats: pts([160, 560], [285, 560], [405, 560]) },
};
const GUILD_WAYPOINTS = wps([
  ["door", 640, 650], ["low", 640, 615], ["hall", 640, 345], ["top", 640, 130],
  // the desks: the aisle under the second row (y 345), the one between the rows (y 225), the column beside them (x 540)
  ["d-east", 540, 345], ["d2-3", 450, 345], ["d2-2", 320, 345], ["d2-1", 180, 345],
  ["d-up", 540, 225], ["d1-3", 450, 225], ["d1-2", 320, 225], ["d1-1", 180, 225],
  // the beds and the quest board: the aisle along the bottom (y 615)
  ["n-x", 500, 615], ["n-3", 405, 615], ["n-2", 285, 615], ["n-1", 160, 615],
  ["a-1", 900, 615], ["a-2", 1000, 615], ["a-3", 1090, 615],
  // the tavern: under the round table (y 345), up the bench's west end (x 770) to in front of it (y 215)
  ["l-hall", 770, 345], ["l-tw", 810, 345], ["l-ts", 870, 345], ["l-te", 935, 345], ["l-bar", 1040, 345],
  ["l-up", 770, 215], ["l-b1", 840, 215], ["l-b2", 900, 215],
]);
const GUILD_EDGES = [
  ["door", "low"], ["low", "hall"], ["hall", "top"],
  ["hall", "d-east"], ["d-east", "d2-3"], ["d2-3", "d2-2"], ["d2-2", "d2-1"], ["d-east", "d-up"], ["d-up", "d1-3"], ["d1-3", "d1-2"], ["d1-2", "d1-1"],
  ["low", "n-x"], ["n-x", "n-3"], ["n-3", "n-2"], ["n-2", "n-1"], ["low", "a-1"], ["a-1", "a-2"], ["a-2", "a-3"],
  ["hall", "l-hall"], ["l-hall", "l-tw"], ["l-tw", "l-ts"], ["l-ts", "l-te"], ["l-te", "l-bar"], ["l-hall", "l-up"], ["l-up", "l-b1"], ["l-b1", "l-b2"],
];
export const GUILD_PACK = {
  format: 1, id: "guild", scale: 1, background: GUILD_BACKGROUND, areas: GUILD_AREAS, door: { x: 640, y: 690 },
  waypoints: GUILD_WAYPOINTS, edges: GUILD_EDGES, straight: true, furniture: [], stateZones: PICTURE_ZONES,
  characters: {}, byInstance: {}, props: {}, bubbles: {},
};

/** The school: a classroom (src/ui/shared/office/school.png). */
export const SCHOOL_BACKGROUND = "/assets/office-school.png";
// Seats: the chairs at the six student desks; the sofa, the two stools, the vending machine; the nurse's beds; in front
// of the chalkboard.
const SCHOOL_AREAS = {
  desks: { name: "desks", rect: { x: 130, y: 205, w: 400, h: 140 }, seats: pts([190, 215], [325, 215], [455, 215], [170, 320], [315, 320], [450, 320]) },
  lounge: { name: "lounge", rect: { x: 770, y: 125, w: 420, h: 110 }, seats: pts([850, 135], [925, 135], [1000, 135], [810, 225], [1035, 225], [1145, 185]) },
  alert: { name: "alert", rect: { x: 840, y: 560, w: 260, h: 50 }, seats: pts([880, 590], [965, 590], [1050, 590]) },
  nap: { name: "nap", rect: { x: 110, y: 540, w: 380, h: 80 }, seats: pts([160, 555], [295, 555], [400, 555]) },
};
const SCHOOL_WAYPOINTS = wps([
  ["door", 640, 660], ["low", 640, 625], ["hall", 640, 335], ["mid", 640, 280], ["top", 640, 100],
  // the desks: the aisle under the second row (y 335), the one between the rows (y 232), the column beside them (x 540)
  ["d-east", 540, 335], ["d2-3", 450, 335], ["d2-2", 315, 335], ["d2-1", 170, 335],
  ["d-up", 540, 232], ["d1-3", 455, 232], ["d1-2", 325, 232], ["d1-1", 190, 232],
  // the beds and the chalkboard: the aisle along the bottom (y 625)
  ["n-x", 520, 625], ["n-3", 400, 625], ["n-2", 295, 625], ["n-1", 160, 625],
  ["a-1", 880, 625], ["a-2", 965, 625], ["a-3", 1050, 625],
  // the lounge: under the rug (y 280) to the stools and the machine, up its west edge (x 760) to in front of the sofa (y 150)
  ["l-hall", 760, 280], ["l-w", 810, 280], ["l-e", 1035, 280], ["l-vend", 1145, 280],
  ["l-up", 760, 150], ["l-s1", 850, 150], ["l-s2", 925, 150], ["l-s3", 1000, 150],
]);
const SCHOOL_EDGES = [
  ["door", "low"], ["low", "hall"], ["hall", "mid"], ["mid", "top"],
  ["hall", "d-east"], ["d-east", "d2-3"], ["d2-3", "d2-2"], ["d2-2", "d2-1"], ["d-east", "d-up"], ["d-up", "d1-3"], ["d1-3", "d1-2"], ["d1-2", "d1-1"],
  ["low", "n-x"], ["n-x", "n-3"], ["n-3", "n-2"], ["n-2", "n-1"], ["low", "a-1"], ["a-1", "a-2"], ["a-2", "a-3"],
  ["mid", "l-hall"], ["l-hall", "l-w"], ["l-w", "l-e"], ["l-e", "l-vend"], ["l-hall", "l-up"], ["l-up", "l-s1"], ["l-s1", "l-s2"], ["l-s2", "l-s3"],
];
export const SCHOOL_PACK = {
  format: 1, id: "school", scale: 1, background: SCHOOL_BACKGROUND, areas: SCHOOL_AREAS, door: { x: 640, y: 700 },
  waypoints: SCHOOL_WAYPOINTS, edges: SCHOOL_EDGES, straight: true, furniture: [], stateZones: PICTURE_ZONES,
  characters: {}, byInstance: {}, props: {}, bubbles: {},
};

/**
 * The built-ins drawn from one picture shipped with the page (#2631 cozy, #2947 guild and school): each one's pack, and
 * until its picture is in, the studio's floors under its areas (the bare skin); `job` is the picture's load in flight.
 */
const PICTURES = new Map([COZY_PACK, GUILD_PACK, SCHOOL_PACK].map((pack) => [pack.id, { pack, bare: spriteSkin(pack, new Map(), studioSkin), job: null }]));
/** Their ids: a style naming one loads its picture (loadBuiltInSkin). */
export const PICTURE_SKINS = [...PICTURES.keys()];

/** The skins built into this page; an uploaded pack is loaded by loadPackSkin. */
export const SKINS = new Map([["pixel", pixelSkin], ["studio", studioSkin], ...[...PICTURES].map(([id, p]) => [id, p.bare])]);
export const BUILT_IN_SKINS = ["pixel", "studio", ...PICTURE_SKINS];
/**
 * #2631/#2947: a picture-backed built-in's picture, loaded once; the skin drawn from it then takes the bare one's place
 * in SKINS (skinFor). The skin, or null while it cannot load (the bare one stays; tried again next time); null for an id
 * that is not one of them.
 */
export function loadBuiltInSkin(id, { image = defaultImage } = {}) {
  const p = PICTURES.get(id);
  if (!p) return Promise.resolve(null);
  if (SKINS.get(id) !== p.bare) return Promise.resolve(SKINS.get(id));
  p.job ??= image(p.pack.background).then((im) => {
    p.job = null;
    if (!im) return null;
    const sk = spriteSkin(p.pack, new Map([[p.pack.background, im]]), studioSkin);
    SKINS.set(id, sk);
    return sk;
  }, () => { p.job = null; return null; });
  return p.job;
}
/** #2631: the cozy's picture (loadBuiltInSkin for "cozy"). */
export const loadCozySkin = (opts = {}) => loadBuiltInSkin("cozy", opts);
/** A skin by id: a built-in one, else a pack loaded here (`packs`: id → skin), else the default (pixel). */
export const skinFor = (id, packs = null) => SKINS.get(id) || (packs && packs.get(id)) || pixelSkin;

const loaded = new Map();                                 // `${id}@${sha}` → Promise<OfficeSkin | null>
// Room for every pack the host keeps (web-office-skins.ts SKIN_LIMITS.packs) and a few replaced ones (each a new sha).
const MAX_LOADED = 24;
const defaultImage = (url) => new Promise((resolve) => {
  if (typeof Image !== "function") { resolve(null); return; }
  const im = new Image();
  im.onload = () => resolve(im);
  im.onerror = () => resolve(null);
  im.src = url;
});
/**
 * An uploaded pack (GET /ui/office-skins/<id>?v=<sha>) as an OfficeSkin: its manifest checked (null when it is not a
 * pack: the page then draws a built-in style and says so), its pictures loaded from their content ids (one that does
 * not load is drawn by the built-in skin). Kept per id and sha, so a pack is fetched once. `url`: where a picture's path
 * is read (a share link's page reads its own address, #2636).
 */
export function loadPackSkin(id, sha, { fetch: get = globalThis.fetch, image = defaultImage, url = (p) => p } = {}) {
  const key = `${id}@${sha}`;
  if (loaded.has(key)) return loaded.get(key);
  const base = `/ui/office-skins/${encodeURIComponent(id)}`;
  const job = (async () => {
    try {
      const r = await get(`${base}?v=${encodeURIComponent(sha)}`, { method: "GET", headers: { "Content-Type": "application/json" } });
      if (!r || !r.ok) return null;
      const d = await r.json();
      const c = checkSkinPack(d && d.manifest, { kept: true });
      if (!c.ok || c.pack.id !== id) return null;
      const files = d.files && typeof d.files === "object" ? d.files : {};
      const images = new Map();
      const fidOf = (src) => { const fid = own(files, src); return typeof fid === "string" && /^[0-9a-f]{32}$/.test(fid) ? fid : null; };
      await Promise.all(packSceneImages(c.pack).map(async (src) => {
        const fid = fidOf(src);
        if (!fid) return;
        const im = await image(url(`${base}/img/${fid}.png`));
        if (im) images.set(src, im);
      }));
      // #2861: the dialogue box's pictures (portraits, its frame) are read the first time it asks for one — never by an
      // Office that does not show the box. `picture(src, done)`: the picture, or null (not read yet: `done` is called
      // once it is in; never there: null for good).
      const portraits = new Set(packPortraitImages(c.pack)), late = new Map();
      const picture = (src, done) => {
        if (!src || !portraits.has(src)) return null;
        const had = late.get(src);
        if (had) { if (had.im === undefined && done) had.waiting.add(done); return had.im || null; }
        const fid = fidOf(src), entry = { im: fid ? undefined : null, waiting: new Set(done ? [done] : []) };
        late.set(src, entry);
        if (fid) Promise.resolve(image(url(`${base}/img/${fid}.png`))).catch(() => null).then((im) => {
          entry.im = im || null;
          for (const fn of entry.waiting) { try { fn(); } catch { /* the page's own */ } }
          entry.waiting.clear();
        });
        return null;
      };
      return { ...spriteSkin(c.pack, images), picture };
    } catch { return null; }
  })();
  loaded.set(key, job);
  if (loaded.size > MAX_LOADED) loaded.delete(loaded.keys().next().value);
  job.then((skin) => { if (!skin) loaded.delete(key); });   // a failed read is tried again next time
  return job;
}
/** The people's depth in zones (fleet-office-pack.js). */
export { CHAR_DEPTH };
