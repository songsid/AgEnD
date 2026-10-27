// Fleet → Org chart → Office: the fleet as a small pixel office, the third view beside Canvas and List
// (fleet-canvas.js). The same data as theirs: the structure from /ui/org (buildOrgView), the live state from the app
// store, the traffic from fleet-traffic.js's store — nothing new is read but the offices people made (/ui/offices) and what agents do in them (/ui/office-acts, #2578).
//
// - Two layouts, by skin. Desks (the built-in "pixel" skin; an unknown style, and a saved office with none): each team
//   is a room, each member a desk with a name tag; General and the instances in no team share the lobby; a grid that
//   wraps at the stage's width (fleet-office-model.js autoLayout). Zones (a skin whose pack maps states to areas — the
//   built-in "studio", and "cozy" drawn from one picture, the default, #2631): a 1280×720 scene; each instance takes a
//   seat in the area for its state and walks there along the pack's waypoints when its state changes (fleet-office-zones.js).
// - #2540: the canvas fills the Fleet panel (no frame: the whole width of the Fleet area, down to the window's foot);
//   the scene is panned and zoomed as the org chart's canvas is (fleet-canvas-view.js: drag, wheel, pinch, + / − / Fit
//   and the `+ - 0` keys, an overview), Fit filling the panel (contain; Fill: cover), + and − in pixel levels, the zoom
//   shown as a percentage, around it a matte (fleet-office-view.js). The view (zoom and centre) and the fit mode are
//   kept per device per office and style. Everything on the scene — hit-testing, tooltips, Edit layout's handles —
//   goes through the same view transform.
// - Speech bubbles: now and then a short line for its state (typed out; at once with reduced motion) — the page's own
//   lines or the skin's, never anything an agent said. Furniture can react: an item with `activeWhen` animates while
//   anyone shown is in that state — or (#2698, "activeOn": "seated") once its person sits down; one that "hides" its
//   people carries their name tags and bubbles while it is active, and hovering it hits them (furnitureAt).
// - Each occupant is a little pixel person in a pose that loops a few frames: working (typing, the lamp on), idle (tea),
//   paused or stopped (asleep, a closed sign), needs you / crashed / looks stuck (a hand up, a blinking light).
// - Traffic: each new message, delegation or report is an item carried from the sender's desk to the receiver's along
//   the corridors (the layout's waypoint graph), in its kind's colour and shape; a delegation in progress is a folder on
//   the worker's desk.
// - Hover (or a first tap) shows what the canvas's card says; a click (or a second tap) opens the chat, as a card does.
//   The desks are a list for a screen reader and the keyboard too (shown while it has focus).
// - Who is shown: an office switcher (the whole fleet, or an office from the host), and for the whole fleet a team (or
//   the lobby) and pinned people — kept per browser (fleet-office-store.js).
// - One requestAnimationFrame loop, drawing only when a frame changes; it stops while the tab is hidden and when the view
//   goes. Reduced motion: still poses, nothing in the air (zoom and pan are never animated). Colours are the dashboard's
//   tokens (dark and light).
// - Drawing is the skin's (fleet-office-skin.js); a skin pack an admin uploaded (fleet-office-pack.js, #2513) replaces
//   any part — an office names it as its style; one this page cannot load is drawn as Desks, and says so.
// - Crowds (#2513): an area with more people than seats packs the rest into a tighter grid, then counts who is left
//   ("+N", in its corner, never over its name); there idle and asleep people say nothing, at most a few speak (calls
//   first, then work), no bubble covers a name tag, and the tags show on hover or focus only. "Hide paused and stopped"
//   (per browser) leaves the sleepers out.
// - Share… (#2636; an admin, on the dashboard reached directly or over the public link): a link anyone can open to watch an office live, read-only,
//   until it ends (office-share-dialog.js; the page it opens is office-share-page.js).
// - Edit layout (an admin, a stored office on a zones skin): fleet-office-layout.js, saved as the office's overrides.
//   An editing session (#2513 review) is bound to the office it opened on, that office's style (the pack's id and sha)
//   and the list and rev read then: a re-read of the offices meanwhile (the stream) changes the view, never the session,
//   so Save sends that rev and a change made meanwhile is a 409 (the session then takes the list read again, and Save
//   again is the person's decision). While it is open the office picker and Edit offices wait; if the office goes or its
//   style changes underneath it, the editor says so and only Cancel is left.
// - Fullscreen (#2540): a button by the zoom controls, or `f`; Esc leaves. The Fullscreen API on the view's container
//   (webkit's prefix too); where a page cannot take an element fullscreen (an iPhone) or the browser refuses, "immersive":
//   the container covers the window (CSS). Either way only the stage shows, with its floating controls (zoom, Fit, the
//   overview, a compact office switcher, Exit); the stage's resize handling re-fits it. Nothing about it is kept.
// - All offices (#2554; offered with two or more stored offices): every stored office as a tile on one canvas, each
//   drawn as its own view would be — its style (a pack loaded once and shared), its members, seats, poses, bubbles,
//   walking and in-office traffic — scaled into its tile (fleet-office-overview.js: the tiles, the lobby tile of whoever
//   is in no office, hit-testing, culling, the flights between tiles). The same canvas, controls and loop; tiles off
//   screen are not drawn. A tile's label (a button, a readable size whatever the zoom) or a double-click on it opens
//   that office; a person opens their chat. A tile too small to read (under TAG_MIN_K) shows name tags on hover only;
//   bubbles are drawn after every tile (never cut at a tile's edge). Fit keeps the tiles clear of the controls
//   (FIT_PAD). Edit offices and Edit layout wait for a single office.
import { html, useEffect, useLayoutEffect, useMemo, useRef, useState } from "/assets/app-html.js";
import { appStore } from "/assets/app-store.js";
import { t, lang, register } from "/assets/app-i18n.js";
import { identityOf } from "/assets/identity-color.js";
import { Icon } from "/assets/ui-icons.js";
import { nodeText, stateWords } from "./fleet-org.js";
import { hits, needle } from "./fleet-canvas-layout.js";
import { AUTO_ID, LOBBY, autoLayout, backingScale, coatOf, createFlights, customLayout, deskAt, desksOf, filterOk, lampOf, layoutOk, lightOf, membersOf,
  officePose, officeRooms, signOf, workOn } from "./fleet-office-model.js";
import { BUILT_IN_SKINS, CHAR_DEPTH, DEFAULT_PAL, bubbleBox, loadCozySkin, loadPackSkin, modeOf, skinFor, tagBox } from "./fleet-office-skin.js";
import { CALLING, activeFurniture, bubbleAt, hiddenBy, bubbleRank, NIGHT, WANDER, createMail, createWalkers, isNight, linesFor, npcKey, personAt, placeBubbles, thinBubbles, walkTargets, zonesLayout } from "./fleet-office-zones.js";
import { actsOk, createOfficeStore } from "./fleet-office-store.js";
import { badgeOf, fixedOf } from "./fleet-office-levels.js";
import { OfficeCard, cardModel } from "./fleet-office-card.js";
import { POLL_MS } from "./fleet-traffic.js";
import { OfficeEditor, officeForSave } from "./fleet-office-editor.js";
import { LayoutEditor, handlesOf } from "./fleet-office-layout.js";
import { ShareButton } from "./office-share-dialog.js";
import { applyOverrides, fitNight, fitSeatFor, stripBox } from "./fleet-office-pack.js";
import { ALL_ID, LOBBY_TILE, OV, createCrossFlights, cropToRooms, fromTile, inTile, labelAt, lobbyNodes, overviewOk, tileAt, tileBox, tileLayout, visibleTiles } from "./fleet-office-overview.js";
import { centreOn, gestureState, gestures, miniPoint, toScreen, toWorld, wheelFactor, zoomKey, zoomTo } from "./fleet-canvas-view.js";
import { OK_MAX, OK_MIN, clampPan, desksK, edgeMatte, edgeStrips, fitScene, layerScale, miniBox, miniFrame, openingView, pinchOffice, savedOf, stepK, viewFromSaved,
  wholeInView, zoomLabel, zoomOffice } from "./fleet-office-view.js";

register("orgo", {
  en: {
    label: "Office: each team is a room and each instance a desk; General and the instances in no team are in the lobby. Drag to pan; the wheel, a pinch, + and − zoom, 0 fits, F is fullscreen.",
    office: "Office", allOffice: "Whole fleet", show: "Show", allTeams: "All teams", lobby: "Lobby (General, no team)", lobbyRoom: "Lobby",
    people: "People", peopleN: "People ({0})", findPerson: "Find a person", everyone: "Show everyone", nobody: "No one here matches this filter.",
    unseated: "{0} without a seat", skinUnknown: "Its style “{0}” is not available here: drawn as Desks.", closed: "Closed", desks: "Desks", tapAgain: "Tap again to open the chat",
    capWorking: "Typing away", capIdle: "Tea break", capPaused: "Asleep", capNeeds: "Calling for you", capAway: "Desk empty", capStarting: "Just arriving", capQueued: "Waiting to start",
    styleLabel: "Style", style_pixel: "Desks", style_studio: "Studio", style_cozy: "Cozy", cozyNotice: "Add your skin", area_desks: "Work", area_lounge: "Lounge", area_alert: "Help desk", area_nap: "Nap corner",
    b_working: "On it.|Typing…|Almost there|In the zone|One more test", b_idle: "Tea time|Ready when you are|Stretching|Anything for me?",
    b_paused: "Zzz…|Back later", b_stopped: "Off duty|Zzz…", b_needs: "Need you!|A question for you|Over here!",
    b_crashed: "Ouch, crashed|Help!", b_stuck: "Hmm, stuck?|Still thinking…",
    hideAsleep: "Hide paused and stopped", nightOn: "Bedtime 0–6: the idle sleep", layoutIgnored: "Its saved layout does not fit this style: drawn as the style's own.",
    styleForAll: "The whole fleet's style, for everyone: every device and share link", styleHere: "The whole fleet's style in this browser",
    styleFailed: "The style was not saved for everyone ({0}).", styleBusy: "Too many changes. Try again in a minute.",
    fit: "Fit the office", overview: "Overview: click to move there", fullscreen: "Fullscreen", exitFullscreen: "Exit fullscreen",
    fill: "Fill", fillTitle: "Fill the panel (the scene's overflow is cropped; drag to see it)", zoomLevel: "Zoom {0}",
    allOffices: "All offices", labelAll: "All offices: each office is a tile, drawn in its own style. Drag to pan; the wheel, a pinch, + and − zoom, 0 fits, F is fullscreen. Double-click a tile to open that office.",
    tileLabel: "{0} ({1})", openOffice: "Open the office {0}", lobbyTile: "Lobby tile (in no office)", lobbyEveryone: "Everyone is in an office", overviewNoEdit: "Pick one office to edit offices or a layout",
  },
  "zh-TW": {
    label: "辦公室：每個 team 是一間房間，每個 instance 一張桌子；General 和未加入 team 的 instance 在大廳。拖曳平移；滾輪、雙指、+ 和 − 縮放，0 顯示整個場景，F 切換全螢幕。",
    office: "辦公室", allOffice: "整個 fleet", show: "顯示", allTeams: "所有 team", lobby: "大廳（General、未加入 team）", lobbyRoom: "大廳",
    people: "成員", peopleN: "成員（{0}）", findPerson: "尋找成員", everyone: "顯示全部", nobody: "沒有符合這個篩選的成員。",
    unseated: "{0} 位沒有座位", skinUnknown: "這裡沒有它的風格「{0}」：以辦公桌顯示。", closed: "休息中", desks: "桌子", tapAgain: "再點一下開啟聊天",
    capWorking: "埋頭打字中", capIdle: "喝茶休息", capPaused: "睡著了", capNeeds: "在呼叫你", capAway: "空位", capStarting: "剛到座位", capQueued: "等待啟動",
    styleLabel: "風格", style_pixel: "辦公桌", style_studio: "工作室", style_cozy: "溫馨", cozyNotice: "換上你的外觀包", area_desks: "工作區", area_lounge: "休息區", area_alert: "求救區", area_nap: "午睡角",
    b_working: "處理中|打字中…|快好了|專心中|再測一次", b_idle: "喝茶中|隨時可以開工|伸個懶腰|有事找我嗎？",
    b_paused: "Zzz…|晚點回來", b_stopped: "下班了|Zzz…", b_needs: "需要你！|有個問題|在這裡！",
    b_crashed: "糟糕，當掉了|救命！", b_stuck: "嗯，卡住了？|還在想…",
    hideAsleep: "隱藏暫停與停止的成員", nightOn: "0–6 點就寢：閒著的人去睡", layoutIgnored: "它儲存的配置不適用這個風格：以風格本身的配置顯示。",
    styleForAll: "整個 fleet 的風格，所有人共用：每台裝置與分享連結都一樣", styleHere: "這個瀏覽器裡整個 fleet 的風格",
    styleFailed: "風格沒有替所有人儲存（{0}）。", styleBusy: "變更太頻繁，請一分鐘後再試。",
    fit: "顯示整個辦公室", overview: "總覽：點一下移到那裡", fullscreen: "全螢幕", exitFullscreen: "結束全螢幕",
    fill: "填滿", fillTitle: "填滿整個面板（超出的部分會被裁切，拖曳即可看到）", zoomLevel: "縮放 {0}",
    allOffices: "所有辦公室", labelAll: "所有辦公室：每間辦公室是一格，以它自己的風格顯示。拖曳平移；滾輪、雙指、+ 和 − 縮放，0 顯示全部，F 切換全螢幕。雙擊一格即可開啟那間辦公室。",
    tileLabel: "{0}（{1}）", openOffice: "開啟辦公室「{0}」", lobbyTile: "大廳格（不在任何辦公室）", lobbyEveryone: "每個成員都已在某間辦公室", overviewNoEdit: "請先選一間辦公室，再編輯辦公室或配置",
  },
});
const to = (k, ...v) => t(`orgo.${k}`, ...v);
const CAPTION = { working: "capWorking", idle: "capIdle", paused: "capPaused", needs: "capNeeds", walk: "capIdle", away: "capAway" };
/** States whose pose is shared but whose words are their own (a queued instance is not asleep). */
const CAPTION_OF_STATE = { starting: "capStarting", queued: "capQueued" };
/** What a pose says in words (the tooltip, the desk list); `state`, when its words differ from its pose's. */
export const caption = (pose, state) => to(CAPTION_OF_STATE[state] || CAPTION[pose] || "capIdle");

const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
/** The device's ratio (CSS px → device px), kept sane. */
const deviceRatio = () => Math.max(0.5, Math.min(4, Number(globalThis.devicePixelRatio) || 1));
/** The stage's size before it is measured (a test's page has none). */
const SIZE0 = { w: 960, h: 600 };
/** #2554: All offices' Fit keeps this many CSS px clear round the tiles (the zoom controls' column and a margin). */
const FIT_PAD = 60;
/** #2554: in All offices a tile's name tags show (always) from this many CSS px a unit up; below it on hover only. */
export const TAG_MIN_K = 0.75;
const PAN_KEYS = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
/** Typing: no single-key shortcut (the `f` of fullscreen) there. */
const typing = (el) => !!el && (el.tagName === "INPUT" || el.tagName === "SELECT" || el.tagName === "TEXTAREA" || el.isContentEditable === true);
/** The element the page has fullscreen (standard, else webkit's), or null. */
const fullscreenEl = () => { const d = globalThis.document; return (d && (d.fullscreenElement || d.webkitFullscreenElement)) || null; };
/** A pack's background, sampled once for its matte (fleet-office-view.js edgeMatte): picture → #rrggbb or null. */
const MATTES = new WeakMap();
function sampledMatte(img) {
  if (!img || typeof img !== "object") return null;
  if (MATTES.has(img)) return MATTES.get(img);
  let m = null;
  try {
    const c = document.createElement("canvas");
    c.width = 64; c.height = 36;
    const g = c.getContext && c.getContext("2d");
    if (g) { g.imageSmoothingEnabled = false; g.drawImage(img, 0, 0, 64, 36); const st = edgeStrips(c); m = st ? edgeMatte(st) : null; }
  } catch { m = null; }
  MATTES.set(img, m);
  return m;
}
const now = () => (typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now());
/** #2661: how often the levels are read again while the Office is shown (the host reuses them for a minute). */
const LEVELS_MS = 60_000;
/** #2661: how long a level-up's ring shows. */
const UP_MS = 1800;
/** #2661: Find in office zooms in to at least this (CSS px a logical unit). */
const FIND_K = 2;
/** #2661: below this stage width (CSS px) the card is a bottom sheet. */
const SHEET_W = 560;
/** How often the picture can change when nothing is in the air (the poses loop at 4 fps; a bubble types faster). */
const FPS = 12;
const STYLES = BUILT_IN_SKINS;
/** Paused and stopped: left out when "Hide paused and stopped" is on. */
const ASLEEP = new Set(["paused", "stopped"]);
const BUBBLE_STATES = ["working", "idle", "paused", "stopped", "needs", "crashed", "stuck"];
/** The page's own bubble lines, by state, in its language (short, never message content). */
export const bubbleDefaults = () => Object.fromEntries(BUBBLE_STATES.map((s) => [s, to(`b_${s}`).split("|")]));

/** The dashboard's tokens on `el`, for the canvas (the defaults are the dark theme's). */
function readPal(el) {
  let cs = null;
  try { cs = el && typeof getComputedStyle === "function" ? getComputedStyle(el) : null; } catch { cs = null; }
  const v = (k, d) => { const s = cs && typeof cs.getPropertyValue === "function" ? cs.getPropertyValue(k).trim() : ""; return s || d; };
  const D = DEFAULT_PAL;
  return {
    bg: v("--bg", D.bg), surface: v("--surface", D.surface), surface2: v("--surface-2", D.surface2), border: v("--border", D.border),
    text: v("--text", D.text), text2: v("--text-2", D.text2), text3: v("--text-3", D.text3), ok: v("--ok", D.ok), warn: v("--warn", D.warn),
    danger: v("--danger", D.danger), focus: v("--focus", D.focus),
    accent: v("--accent", D.accent), accentDim: v("--accent-dim", D.accentDim), okBg: v("--ok-bg", D.okBg), warnBg: v("--warn-bg", D.warnBg), dangerBg: v("--danger-bg", D.dangerBg),
    fx: { task: v("--fx-task", D.fx.task), send: v("--fx-send", D.fx.send), report: v("--fx-report", D.fx.report), broadcast: v("--fx-broadcast", D.fx.broadcast) },
  };
}

/** The team picker's choices: option values are indexes (a team's name can be anything). */
function teamOptions(view) {
  return [{ value: "all", team: "", label: to("allTeams") }, { value: "lobby", team: LOBBY, label: to("lobby") },
    ...view.teams.map((tm, i) => ({ value: `t${i}`, team: tm.name, label: tm.name }))];
}

// ── A scene: one office's layout, looks and skin, drawn by itself (the single view) or as a tile (All offices, #2554) ──

/**
 * What each desk shows: the pose, the light, the coat; dimmed when the Find box matches someone else; #2661: its level
 * badge (`badge(name)`: fleet-office-levels.js badgeOf, or nothing).
 */
function looksOf(L, work, q, mode, zones, badge = () => null) {
  return new Map(L.rooms.flatMap((r) => r.desks).map((d) => {
    const n = d.node;
    if (!n) return [d.key, { name: "", label: "", state: "missing", pose: "away", light: null, lamp: false, sign: null, coat: "", work: 0, dim: !!q, match: false, free: zones }];
    const match = !!q && hits(n, q);
    // At night (#2568) the idle are drawn asleep (their state stays idle: the tooltip and the list say so).
    return [d.key, { name: n.name, label: nodeText(n).primary, state: n.state, pose: officePose(d.night ? "paused" : n.state), night: !!d.night, light: lightOf(n.state), lamp: lampOf(n.state),
      sign: zones ? null : signOf(n.state), coat: coatOf(n.i, n.i ? identityOf(n.i) : null, mode), work: work.get(n.name) || 0, dim: !!q && !match, match, free: zones,
      badge: badge(n.name) }];
  }));
}
/** A stored office's own layout on a zones style (its overrides); `ignored`: they do not fit this style. */
function withOverrides(baseSkin, zones, office) {
  const ov = zones && office ? office.overrides : null;
  if (!ov || ov.pack !== baseSkin.id) return { skin: baseSkin, ignored: false };
  const a = applyOverrides(baseSkin.pack, fitSeatFor(baseSkin.pack, fitNight(baseSkin.pack, ov)));    // #2665/#2691: a night place or seat the pack lost: left out
  return a.ok ? { skin: { ...baseSkin, pack: a.pack }, ignored: false } : { skin: baseSkin, ignored: true };
}
/** A stored office's scene (or the lobby tile's): seats in its style's areas, its own seats, or one room wrapping at `deskW`. */
function officeScene(office, nodes, skin, zones, deskW, prevSeats, night = false) {
  if (zones) return zonesLayout(skin.pack, nodes, prevSeats, { night });
  const lay = office.layout || layoutOk(skin.layout);
  return lay ? customLayout({ ...office, layout: lay }, nodes) : autoLayout([{ key: office.id, name: office.name, lobby: !!office.lobby, nodes }], { width: deskW });
}
/** What drawPart needs of a scene; its layers are painted on first draw (and again at another resolution). */
export function partOf(L, looks, skin, zones, walkers, flights) {
  const all = L.rooms.flatMap((r) => r.desks);
  const shown = new Set([...looks.values()].map((l) => l.state)), byName = new Map([...looks.values()].filter((l) => l.name).map((l) => [l.name, l.state]));
  // #2661: each desk's room (Desks: who is in the same area as a level-up, drawPart).
  const roomOf = new Map(L.rooms.flatMap((r) => r.desks.map((d) => [d.key, r.key])));
  return { L, looks, skin, zones, walkers, flights, all, desks: all.filter((d) => d.node), layers: null, roomOf,
    active: zones ? activeFurniture(skin.pack, shown, byName) : new Set(), lines: bubbleDefaults(), lang: lang() };
}
/**
 * At bedtime (#2568): each item with a `night` drawn as it — its strip playing, at its night place: the office's
 * (Edit layout, #2665: applyOverrides puts it on `night`), else the pack's night x/y, else its (moved) day place.
 */
export const nightFurniture = (list) => list.map((f) => (f.night ? { ...f, sprite: f.night.sprite, activeSprite: null, x: f.night.x ?? f.x, y: f.night.y ?? f.y, asleep: true } : f));
/** #2698: where someone is at `t` against their seat: "walking"; "seated" (still, at the seat zones gave them — or no
 * walker yet: drawn there); "standing" (still elsewhere: a stroll's spot, an act's point, the seat left before a walk). */
const postureAt = (p, t) => {
  const seats = new Map(p.all.filter((d) => d.node).map((d) => [d.node.name, d.seat]));
  return (name) => {
    const at = p.walkers && p.walkers.at(name, t), s = seats.get(name);
    if (!at) return "seated";
    if (at.walking) return "walking";
    return s && Math.abs(at.x - s.x) < 1 && Math.abs(at.y - s.y) < 1 ? "seated" : "standing";
  };
};
/**
 * The furniture active at `t` and who is drawn on an item instead of themselves (`hidden`: name → item id). A pack
 * with no "activeOn": "seated" nor "hides" (#2698): the scene's `active`, as before, and nobody hidden; else worked out
 * from where everyone is at `t` (their walkers). An item asleep at bedtime (a `night`) hides nobody.
 */
export function furnitureAt(p, t) {
  const pk = p.zones && p.skin && p.skin.pack, list = (pk && pk.furniture) || [];
  if (!list.some((f) => f.activeOn === "seated" || f.hides)) return { active: p.active || new Set(), hidden: new Map() };
  const looks = [...p.looks.values()], byName = new Map(looks.filter((l) => l.name).map((l) => [l.name, l.state]));
  const posture = postureAt(p, t), active = activeFurniture(pk, new Set(looks.map((l) => l.state)), byName, posture);
  const hidden = hiddenBy(pk, active, byName, posture);
  if (p.night) for (const [n, id] of [...hidden]) if (list.some((f) => f.id === id && f.night)) hidden.delete(n);
  return { active, hidden };
}
/** #2698: the box an item hiding its people is hit in — its active picture, down to its name tags' row. */
const hidingBox = (f) => {
  const b = stripBox(f.activeSprite || f.sprite, f.x, f.y);
  return { ...b, h: Math.max(b.h, f.y + 17 - b.y) };
};
/** #2698: name tags in one row centred on (x, y) — each { look, x } (its centre), TAG_GAP apart. */
const TAG_GAP = 4;
export function tagRow(ctx, x, y, looks) {
  const ws = looks.map((l) => tagBox(ctx, x, y, l.label).w), total = ws.reduce((a, w) => a + w, 0) + TAG_GAP * Math.max(0, ws.length - 1);
  let left = x - total / 2;
  return looks.map((look, i) => { const cx = Math.round(left + ws[i] / 2); left += ws[i] + TAG_GAP; return { look, x: cx }; });
}
/** #2596: each NPC with a `walk` where its walker is now (`at(key)`): moved there — its tag and depth with it — and, while
 * it walks, `walking` and its `heading` (its walk strip: walkStrip); asleep, or with no walker (not strolling), where it is. */
export const strollFurniture = (list, at) => list.map((f) => {
  const w = f.walk && !f.asleep ? at(npcKey(f)) : null;
  return w ? { ...f, x: w.x, y: w.y, walking: !!w.walking, heading: w.heading || null } : f;
});
/** Where a seated person's bubble points: over the head of the picture drawn — a pack's figure can be taller than the
 * built-in one (#2558: a 134 px figure had its face under the bubble); never lower than the built-in spot. */
export function speakerAt(sk, look, at) {
  const top = sk.charBox ? sk.charBox(look, at).y + 2 : Infinity;
  return { x: at.x + 10, y: Math.min(at.y - 50, top) };
}
/** The pose an area's seats are for: the first state (asleep, working, calling, idle) the pack sends there. */
const GHOST_POSE = [["paused", "paused"], ["stopped", "paused"], ["working", "working"], ["needs", "needs"], ["crashed", "needs"], ["stuck", "needs"], ["idle", "idle"]];
/** How faint Edit layout's figures are: seen through, yet readable over a busy picture (a dimmed person is 0.35). */
const GHOST_ALPHA = 0.6;
/** Edit layout's faint figures: one on each seat no one is on, { x, y, look } (the pack's default set; drawn at GHOST_ALPHA). */
export function ghostsOf(pack, people = []) {
  const taken = (s) => people.some((q) => Math.abs(q.at.x - s.x) < 2 && Math.abs(q.at.y - s.y) < 2);
  const out = [];
  for (const [name, a] of Object.entries(pack.areas)) {
    const hit = GHOST_POSE.find(([st]) => pack.stateZones && pack.stateZones[st] === name);
    const pose = hit ? hit[1] : "idle";
    for (const s of a.seats) if (!taken(s)) out.push({ x: s.x, y: s.y, look: { key: `ghost:${name}`, name: "", label: "", state: pose, pose, coat: "#8a8f99", free: true } });
  }
  return out;
}
/** #2665: Edit layout's faint night places by day — each item with a `night` as it is drawn at bedtime (nightFurniture). */
export const nightGhostsOf = (pack) => nightFurniture(pack.furniture.filter((f) => f.night));
/** All offices: the tile `name` is drawn in ({ tile, skin }), or null. */
const senderTile = (parts, name) => (name ? parts.find((p) => desksOf(p.L).some((d) => d.node.name === name)) || null : null);
/**
 * Whether an agent's act (office_set, #2578) holds now: not past its end; its person not called (a call wins) nor
 * asleep; and no new work begun since — `seen` (kept by the page) remembers each act whose person was seen not working,
 * so working again after that (or after acting while idle) is new work, and the act gives way. The turn it acted in
 * (working at the time) keeps it.
 */
export function actLive(a, state, at = Date.now(), seen = null) {
  if (!a || at >= a.until || CALLING.has(state) || ASLEEP.has(state)) return false;
  if (!seen) return true;
  const k = `${a.instance}@${a.since ?? a.until}`;
  if (state !== "working") { seen.add(k); return true; }
  return !seen.has(k) && (!a.state || a.state === "working");
}
/** How far beside the person an agent going to them stands. */
const ACT_BESIDE = 48;
/** Where an agent's act sends it at `t`: its point, beside the person it goes to (where they are now), or null. */
export function actTarget(a, L, walkers, t) {
  if (a.x !== undefined) return { x: a.x, y: a.y };
  if (!a.person) return null;
  const d = desksOf(L).find((x) => x.node.name === a.person), there = (walkers && walkers.at(a.person, t)) || (d && d.seat);
  return there ? { x: Math.round(Math.min(L.width, there.x + ACT_BESIDE)), y: Math.round(there.y) } : null;
}
/**
 * A look in its agent's own pose (office_set, #2578) while its act holds, else as it is. In bed for the night (#2568,
 * `look.night`) it is asleep, as for mail (#2569): bedtime wins over an act.
 */
function actPosed(p, look) {
  const act = look && p.acts && p.acts.get(look.name);
  return act && act.pose && actLive(act, look.night ? "paused" : look.state, Date.now(), p.actSeen) ? { ...look, pose: officePose(act.pose) } : look;
}
/** The back and front layers: pictures of the scene at `ls` layer px per logical unit (`tagsOff`: no name tags but the Find box's matches). */
function paintLayers(p, env, ls, tagsOff = false) {
  const { L, skin, zones, looks, all } = p;
  const lw = Math.max(1, Math.ceil(L.width * ls)), lh = Math.max(1, Math.ceil(L.height * ls));
  const layer = (fn) => {
    const c = document.createElement("canvas");
    c.width = lw; c.height = lh;
    const g = c.getContext && c.getContext("2d");
    if (!g) return null;
    g.setTransform(ls, 0, 0, ls, 0, 0);
    g.imageSmoothingEnabled = false;
    fn(g);
    return c;
  };
  const back = layer((g) => {
    g.fillStyle = env.pal.bg; g.fillRect(0, 0, L.width, L.height);
    if (zones) {
      skin.drawBackground(g, L, env);
      return;
    }
    skin.drawFloor(g, L, env);
    for (const r of L.rooms) skin.drawRoom(g, r, env);
    for (const d of all) skin.drawDeskBack(g, d, looks.get(d.key), env);
  });
  const front = zones ? null : layer((g) => {
    for (const d of all) { const lk = looks.get(d.key); skin.drawDeskFront(g, d, tagsOff && lk && !lk.match ? { ...lk, notag: true } : lk, env); }
  });
  return { ls, tagsOff, back, front };
}
/**
 * One frame of a scene at `ms` (0: still), a logical unit `a` bitmap px, its origin at (ox, oy); `hot`: the desk key
 * hovered (its name tag shows even in a crowd); `tagsOff` (#2554: a tile too small to read them): the name tags show
 * only for the one hovered and the Find box's matches. Whether anything in it is moving (in the air, or someone walking).
 */
export function drawPart(ctx, p, a, ox, oy, ms, still, hot, env, tagsOff = false, defer = null) {
  const sk = p.skin;
  const ls = layerScale(a, p.L.width, p.L.height);
  if (!p.layers || p.layers.ls !== ls || p.layers.tagsOff !== tagsOff) p.layers = paintLayers(p, env, ls, tagsOff);
  const T = () => ctx.setTransform(a, 0, 0, a, ox, oy);
  const blit = (c) => { if (!c) return; ctx.setTransform(a / ls, 0, 0, a / ls, ox, oy); ctx.drawImage(c, 0, 0); T(); };
  blit(p.layers.back);
  T();
  const speakers = [], tags = [];
  const up = still ? [] : p.flights.frame(ms, p.L);
  // Mail from another office (#2564): flying in at the door, or on the floor until its person picks it up.
  const post = still || !p.mail || !p.zones ? [] : p.mail.frame(ms > 0 ? ms : now(), p.L, p.walkers);
  let walking = false;
  if (p.zones) {
    // Furniture under the people; the people (nearest last) with the furniture whose depth is "y" among them, by base
    // y (a tie: the item first, the person in front); furniture over them; things in the air; the pack's foreground
    // (door frames, pillars, table fronts); then what must stay readable: crowd counts and name tags (bubbles below).
    const t = ms > 0 ? ms : now(), live = furnitureAt(p, t);
    const people = p.desks.map((d) => {
      const at = p.walkers.at(d.node.name, t) || { ...d.seat, walking: false };
      if (at.walking) walking = true;
      return { d, at, look: p.looks.get(d.key) };
    }).sort((x, y) => x.at.y - y.at.y);
    const furniture = strollFurniture(p.night ? nightFurniture(sk.pack.furniture) : sk.pack.furniture, (k) => p.walkers.at(k, t));
    if (furniture.some((f) => f.walking)) walking = true;
    const band = [...furniture.filter((f) => f.depth === "y").map((f) => ({ y: f.y, k: 0, f })), ...people.map((q) => ({ y: q.at.y, k: 1, p: q })),
      ...(p.ghosts ? ghostsOf(sk.pack, people).map((g) => ({ y: g.y, k: 1, g })) : []),
      // #2665: by day, each item's night place too (at night the items are there already).
      ...(p.ghosts && !p.night ? nightGhostsOf(sk.pack).map((n) => ({ y: n.y, k: 1, n })) : [])]
      .sort((x, y) => x.y - y.y || x.k - y.k);
    for (const f of furniture) if (f.depth !== "y" && f.depth < CHAR_DEPTH) sk.drawFurniture(ctx, f, f.asleep || live.active.has(f.id), ms, env);
    for (const it of post) if (it.t === 0) sk.drawProp(ctx, it, ms, env);        // a letter on the floor: under the people
    for (const { f, p: q, g, n } of band) {
      if (f) { sk.drawFurniture(ctx, f, f.asleep || live.active.has(f.id), ms, env); continue; }
      if (n) { ctx.save(); ctx.globalAlpha = GHOST_ALPHA; sk.drawFurniture(ctx, n, true, 0, env); ctx.restore(); continue; }
      if (g) { ctx.save(); ctx.globalAlpha = GHOST_ALPHA; sk.drawCharacter(ctx, { x: g.x - 44, y: g.y - 53, w: 88, h: 53, seat: g }, g.look, 0, env); ctx.restore(); continue; }
      if (live.hidden.has(q.look.name)) continue;                          // #2698: drawn as the item (never while walking)
      const box = { ...q.d, x: q.at.x - 44, y: q.at.y - 53, w: 88, h: 53, seat: { x: q.at.x, y: q.at.y } };
      // An agent's own pose (office_set, #2578) while its act lasts and nothing calls it; walking is walking.
      const posed = actPosed(p, q.look);
      const look = q.at.walking ? { ...q.look, pose: "walk", heading: q.at.heading } : posed;
      sk.drawCharacter(ctx, box, look, ms, env);
      if (!q.at.walking) speakers.push({ look: q.look, ...speakerAt(sk, look, q.at), area: q.d.area });
    }
    for (const f of furniture) if (f.depth !== "y" && f.depth >= CHAR_DEPTH) sk.drawFurniture(ctx, f, f.asleep || live.active.has(f.id), ms, env);
    for (const it of up) sk.drawProp(ctx, it, ms, env);
    for (const it of post) if (it.t > 0) sk.drawProp(ctx, it, ms, env);
    if (sk.drawForeground) sk.drawForeground(ctx, p.L, env);
    // Who found no spot in an area: a count in its corner (never over its name).
    for (const [ar, n] of p.L.crowd || []) if (p.L.areas[ar] && sk.drawCrowd) sk.drawCrowd(ctx, p.L.areas[ar], n, env);
    // In an area over capacity the name tags show on hover or focus only (#2513: a crowd's tags covered each other).
    const over = p.L.over || new Set();
    const tagged = (q) => !((tagsOff || over.has(q.d.area)) && q.d.key !== hot && !q.look.match);
    for (const q of people) {
      if (live.hidden.has(q.look.name) || !tagged(q)) continue;
      sk.drawTag(ctx, q.at.x, q.at.y, q.look, env);
      tags.push(tagBox(ctx, q.at.x, q.at.y, q.look.label));
    }
    // A furniture item's own name (#2574: an NPC drawn as furniture), tagged like a person; none on a tile too small to read.
    // #2698: an item hiding its people carries their tags too, in one row at its tag point (its own first; each keeps
    // its place in the row while another's tag is left out), and their bubbles, over its picture. The tags drawn are
    // kept on the scene (`heldTags`): hitPart hits each person on theirs, past the picture's edge too (#2699 review).
    const held = [];
    for (const f of furniture) {
      const on = people.filter((q) => live.hidden.get(q.look.name) === f.id);
      if (!on.length) {
        if (!tagsOff && f.label) { const nl = npcLook(p, f); sk.drawTag(ctx, f.x, f.y, nl, env); tags.push(tagBox(ctx, f.x, f.y, nl.label)); }
        continue;
      }
      const order = new Map((f.activeFor || []).map((n, i) => [n, i]));
      on.sort((x, y) => (order.get(x.look.name) ?? 0) - (order.get(y.look.name) ?? 0));
      const row = tagRow(ctx, f.x, f.y, [...(f.label ? [npcLook(p, f)] : []), ...on.map((q) => q.look)]);
      const top = f.sprite ? Math.min(f.y - 50, stripBox(f.activeSprite || f.sprite, f.x, f.y).y + 2) : f.y - 50;
      for (const [i, r] of row.entries()) {
        const q = f.label ? on[i - 1] : on[i];
        if (q) speakers.push({ look: q.look, x: r.x + 10, y: top, area: q.d.area });
        if (q ? !tagged(q) : tagsOff) continue;
        sk.drawTag(ctx, r.x, f.y, r.look, env);
        const box = tagBox(ctx, r.x, f.y, r.look.label);
        tags.push(box);
        if (q) held.push({ name: q.look.name, id: f.id, box });
      }
    }
    p.heldTags = held;
  } else {
    for (const d of p.desks) { const look = p.looks.get(d.key); sk.drawCharacter(ctx, d, actPosed(p, look), ms, env); speakers.push({ look, x: d.x + 58, y: d.y + 12, area: p.roomOf.get(d.key) ?? null }); }
    blit(p.layers.front);
    // Tags left out of the layer: the hovered desk's front again, with its tag.
    const hd = tagsOff && hot ? p.desks.find((d) => d.key === hot) : null;
    if (hd) sk.drawDeskFront(ctx, hd, p.looks.get(hd.key), env);
    for (const it of up) sk.drawProp(ctx, it, ms, env);
  }
  // #2661: a level up — a short ring over the head (UP_MS), and the people in the same area (a room's on Desks) glance
  // over: a small "!" over theirs. Never with reduced motion (no loop: ms 0).
  const rising = ms && p.ups && p.ups.size ? speakers.filter((sp) => { const t0 = p.ups.get(sp.look.name); return t0 !== undefined && now() - t0 < UP_MS; }) : [];
  for (const sp of rising) {
    const f = (now() - p.ups.get(sp.look.name)) / UP_MS;
    ctx.save();
    ctx.globalAlpha = 1 - f;
    ctx.strokeStyle = env.pal.warn; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(sp.x, sp.y - 8, 6 + f * 14, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = env.pal.text; ctx.font = "700 9px system-ui, sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "bottom";
    for (const o of speakers) {
      if (o === sp || o.look.dim || o.look.pose === "away" || (o.area ?? null) !== (sp.area ?? null)) continue;
      ctx.fillText("!", o.x, o.y - 4);
    }
    ctx.restore();
  }
  // Speech bubbles: a short line for the state, now and then (typed out; whole at once when still), placed so no two
  // overlap (placeBubbles; #2431).
  const bubbles = [];
  for (const sp of speakers) {
    if (sp.look.dim || sp.look.pose === "away") continue;
    const says = sp.look.night ? "paused" : sp.look.state;                // asleep at night: its "Zzz…" lines
    // What an agent says itself (office_set, #2578): whole, kept over the area's thinning like a call.
    const act = p.acts && p.acts.get(sp.look.name), own = actLive(act, says, Date.now(), p.actSeen) && act.say ? act.say : null;
    const b = own ? { text: own, shown: [...own].length } : bubbleAt(sp.look.name, says, ms, linesFor(says, p.lang, sk.pack, p.lines));
    if (b) bubbles.push({ key: sp.look.name, area: sp.area, state: sp.look.state, calling: CALLING.has(sp.look.state), rank: own ? 0 : bubbleRank(sp.look.state), shown: b.shown,
      box: bubbleBox(ctx, sp.x, sp.y, b.text), tail: { x: sp.x, y: sp.y }, sp, b });
  }
  // A crowded area speaks less (thinBubbles: calls, then work, a few at most); no bubble covers a name tag. `defer`
  // (All offices): drawn after every tile, unclipped, so a bubble at a tile's edge is whole.
  const placed = placeBubbles(thinBubbles(bubbles, p.zones ? p.L.over : null), 22, tags);
  const say = () => { T(); for (const { sp, b, dy } of placed) sk.drawBubble(ctx, sp.x, sp.y, [...b.text].slice(0, b.shown).join(""), env, -dy); };
  if (defer) defer.push(say); else say();
  return walking || up.length > 0 || p.flights.size() > 0 || post.some((it) => it.t > 0) || rising.length > 0;
}
/**
 * #2661: an NPC's name tag (a furniture item's label) — with the title a pack pins on it (`levels.fixed` by its id),
 * while levels are on: "label · title", and a mark for a badge (an NPC has no level).
 */
function npcLook(p, f) {
  const fx = p.levelsOn ? fixedOf(f.id, p.skin.pack && p.skin.pack.levels) : null;
  return fx ? { label: `${f.label} · ${fx.title}`, badge: { mark: true, tier: 0 } } : { label: f.label };
}
/**
 * The person at (x, y) in a scene's units, as it draws them: on zones where they walk, in the box the skin draws them
 * in (an uploaded character's strip, anchor and size: #2513 review), nearest first; on desks, the desk.
 */
export function hitPart(p, x, y, t) {
  if (!p.zones) return deskAt(p.L, x, y);
  // #2698: someone an item hides is hit on it, after everyone drawn as themselves: on their tag as drawPart last drew
  // it (the row can run past the picture: a long label, long names), else on its picture and the tag row under it
  // (several share its width, left to right in the row's order).
  const { hidden } = furnitureAt(p, t);
  const d = personAt(hidden.size ? p.all.filter((dk) => !dk.node || !hidden.has(dk.node.name)) : p.all, x, y, (dk) => p.walkers.at(dk.node.name, t),
    (dk, at) => (p.skin.charBox && p.looks.get(dk.key) ? p.skin.charBox(p.looks.get(dk.key), at) : null));
  if (d || !hidden.size) return d;
  for (const h of [...(p.heldTags || [])].reverse()) {
    const b = h.box;
    if (hidden.get(h.name) !== h.id || x < b.x || x >= b.x + b.w || y < b.y || y >= b.y + b.h) continue;
    return p.all.find((dk) => dk.node && dk.node.name === h.name) || null;
  }
  const sk = p.skin.pack, drawn = strollFurniture(p.night ? nightFurniture(sk.furniture) : sk.furniture, (k) => p.walkers.at(k, t));
  for (const f of [...drawn].reverse()) {
    if (!f.sprite || ![...hidden.values()].includes(f.id)) continue;
    const b = hidingBox(f);
    if (x < b.x || x >= b.x + b.w || y < b.y || y >= b.y + b.h) continue;
    const order = new Map((f.activeFor || []).map((n, i) => [n, i]));
    const on = p.all.filter((dk) => dk.node && hidden.get(dk.node.name) === f.id).sort((m, n) => (order.get(m.node.name) ?? 0) - (order.get(n.node.name) ?? 0));
    return on[Math.min(on.length - 1, Math.floor(((x - b.x) / b.w) * on.length))] || null;
  }
  return null;
}

function People({ nodes, pinned, onChange }) {
  const [open, setOpen] = useState(false);
  const [find, setFind] = useState("");
  const box = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const away = (e) => { if (box.current && !box.current.contains(e.target)) setOpen(false); };
    const esc = (e) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("pointerdown", away); document.removeEventListener("keydown", esc); };
  }, [open]);
  const q = needle(find), shown = q ? nodes.filter((n) => hits(n, q)) : nodes;
  const toggle = (name) => onChange(pinned.includes(name) ? pinned.filter((x) => x !== name) : [...pinned, name]);
  return html`<div class="oo-people" ref=${box}>
    <button type="button" class=${`btn btn-sm${pinned.length ? " on" : ""}`} aria-expanded=${open ? "true" : "false"} onClick=${() => setOpen((v) => !v)}>
      ${pinned.length ? to("peopleN", pinned.length) : to("people")}</button>
    ${open ? html`<div class="oo-people-pop" role="group" aria-label=${to("people")}>
      <label class="s-search"><span class="sr-only">${to("findPerson")}</span>
        <input type="search" value=${find} placeholder=${to("findPerson")} autocomplete="off" onInput=${(e) => setFind(e.target.value)} /></label>
      <ul class="oo-people-list">${shown.map((n) => html`<li key=${n.name}><label>
        <input type="checkbox" checked=${pinned.includes(n.name)} onChange=${() => toggle(n.name)} /><span>${nodeText(n).primary}</span></label></li>`)}</ul>
      ${pinned.length ? html`<button type="button" class="btn btn-sm" onClick=${() => onChange([])}>${to("everyone")}</button>` : null}
    </div>` : null}
  </div>`;
}

/**
 * The view: `view` buildOrgView's answer; `traffic` the live items (null: Live is off); `q` the Find box's needle;
 * `lease` the tab's (its reads); `onOpen(name)` what a desk opens (the canvas's: the chat; none: a desk opens nothing,
 * as on a share link's page, #2636); `assetUrl(path)` where a skin pack's picture is read (the share's address), and
 * `assetImage(url)` how (the share's, which waits out a 429, #2662; none: the loader's own);
 * `opening` the office it opens on (the share's), instead of the one this browser chose last.
 */
export function Office({ view, traffic, q = "", lease, onOpen, assetUrl, assetImage, opening }) {
  const store = useMemo(() => createOfficeStore(lease ? { fetch: (path, o) => lease.fetch(path, o) } : {}), [lease]);
  const [stored, setStored] = useState([]);
  const [storedRev, setStoredRev] = useState(null);                  // the rev the list was read at (a save sends it)
  const [canEdit, setCanEdit] = useState(false);                      // an admin session (never a guest or the public link)
  const [canShare, setCanShare] = useState(false);                    // #2636: an admin session, here or over the public link
  const [editing, setEditing] = useState(false);
  const [choice, setChoice] = useState(() => opening ?? store.choice());
  const [filter, setFilter] = useState(() => store.filter());
  // #2716: the whole-fleet office's style — the host's (for everyone) and this browser's own pick. An admin sees the
  // host's (their own pick only while the host keeps none) and picks for everyone; anyone else's own pick, else the host's.
  const [hostStyle, setHostStyle] = useState(undefined);            // undefined: not read yet; null: none kept
  const [ownStyle, setOwnStyle] = useState(() => store.skinChosen());
  const [styleErr, setStyleErr] = useState("");
  const style = canEdit ? hostStyle ?? ownStyle ?? "cozy" : ownStyle ?? hostStyle ?? "cozy";
  const [hideAsleep, setHideAsleep] = useState(() => store.hideAsleep());
  // Bedtime (#2568), when it is on here: the idle sleep from NIGHT.FROM to NIGHT.TO on this device's clock (read every NIGHT.TICK).
  const [nightOn, setNightOn] = useState(() => store.nightOn());
  const [nightNow, setNightNow] = useState(() => isNight());
  useEffect(() => { if (!nightOn) return undefined; setNightNow(isNight()); const h = setInterval(() => setNightNow(isNight()), NIGHT.TICK); return () => clearInterval(h); }, [nightOn]);
  const night = nightOn && nightNow;
  const [lobbyOn, setLobbyOn] = useState(() => store.lobbyTile());       // #2554: All offices' lobby tile
  const [packs, setPacks] = useState([]);                             // the skin packs the host keeps: [{ id, name, sha }]
  const [packSkins, setPackSkins] = useState(() => new Map());        // id@sha → a loaded skin, or null (not a pack)
  const [cozyRev, setCozyRev] = useState(0);                          // #2631: the cozy's picture came in (skinFor has it)
  // Edit layout's session while it is open: { id, officeId, skin, pack (the style's identity), base (the pack as kept),
  // start, draft, rev, list (the offices and rev read when it opened — what Save sends) }; null when closed.
  const [layout, setLayout] = useState(null);
  const layoutRef = useRef(null), layoutSeq = useRef(0);
  layoutRef.current = layout;
  const [width, setWidth] = useState(SIZE0.w);                        // the stage's size (CSS px; the canvas fills it)
  const [stageH, setStageH] = useState(0);                            // (0: not known yet)
  const [dpr, setDpr] = useState(deviceRatio);
  const [themeRev, setThemeRev] = useState(0);
  const [pal, setPal] = useState(DEFAULT_PAL);                      // the tokens in force (read once the stage is there)
  const [tip, setTip] = useState(null);                               // the desk key the tooltip is for
  // #2661: the person whose card is open (their key, as `tip`), and the desk-list entry it was opened from (focus goes
  // back there when it closes); the card's element and where it points (placed every frame: it follows them).
  const [card, setCard] = useState(null);
  const cardFrom = useRef(null), cardEl = useRef(null), cardDesk = useRef(null);
  const stageRef = useRef(null), canvasRef = useRef(null), tipRef = useRef(null), lastType = useRef("mouse");
  // Fullscreen: null, "native" (the Fullscreen API) or "immersive" (the CSS cover); per visit, never kept.
  const ooRef = useRef(null), [fs, setFs] = useState(null), fsRef = useRef(null), fsAsked = useRef(false), fsTarget = useRef(null);
  fsRef.current = fs;
  const flights = useMemo(() => createFlights(), []);
  const walkers = useMemo(() => createWalkers(), []);
  const seatsRef = useRef(new Map());                                 // the zones layout's last seats: kept where they can be
  // #2554: All offices' tiles keep their own: seats (by tile and style), walkers and flights (by tile); and the items
  // flying between tiles.
  const tileSeats = useRef(new Map()), tileWalkers = useRef(new Map()), tileFlights = useRef(new Map());
  const cross = useMemo(() => createCrossFlights(), []);
  const still = useMemo(reducedMotion, []);

  // The host's offices: on opening, and again whenever the stream says they changed. Answers can arrive out of order
  // (#2431 review): one with an older rev than the list shown is dropped when it was asked for before that list
  // arrived; one asked for after it is newer whatever its rev (a host whose store was reset starts again at 0).
  // The editor's save and its 409 re-read are stamped when sent (`ask`), never when answered; `adopt` returns the
  // snapshot in force, so a re-read the stream overtook leaves the editor's draft on the newer one.
  const asked = useRef(0), shown = useRef(null);                      // a counter; shown: { rev, offices, arrived }
  const migrated = useRef(false);                                     // #2716: this page's own style sent up
  const ask = () => ++asked.current;
  const adopt = (d, askedAt) => {
    const cur = shown.current;
    if (!d) return cur;
    if (cur && d.rev < cur.rev && askedAt <= cur.arrived) return cur;
    shown.current = { rev: d.rev, offices: d.offices, arrived: ++asked.current };
    setStored(d.offices); setStoredRev(d.rev); setHostStyle(d.autoSkin || null);
    return shown.current;
  };
  // #2716: an admin's own pick from before the host kept one (or since an older host's save dropped it) goes up once.
  useEffect(() => {
    if (!canEdit || hostStyle !== null || !ownStyle || migrated.current || !lease) return;
    migrated.current = true;
    void store.saveAutoSkin(ownStyle).then((r) => { if (r.ok && lease.current()) setHostStyle(r.autoSkin); });
  }, [canEdit, hostStyle]);
  /** #2716: a style picked here — this browser's own; an admin's, for everyone (on failure: said, and read again). */
  const pickStyle = (id) => {
    store.saveSkin(id); setOwnStyle(id); setTip(null); setStyleErr("");
    if (!canEdit || !lease) return;
    const was = hostStyle;
    setHostStyle(id);
    void store.saveAutoSkin(id).then((r) => {
      if (!lease.current() || r.ok) return;
      setHostStyle(was);
      setStyleErr(to(r.status === 429 ? "styleBusy" : "styleFailed", r.error));
    });
  };
  useEffect(() => {
    if (!lease) return undefined;
    const read = async () => { const at = ask(); const d = await store.offices(); if (lease.current()) adopt(d, at); };
    void read();
    const sub = appStore.get().streamOn;
    const off = sub ? lease.hold(sub("offices", () => { void read(); })) : null;
    return () => { if (off) off(); };
  }, [lease, store]);
  // #2578: what agents do here by their own hand (office_set) — on opening, then as the stream brings it.
  // A read a newer one or the stream overtook is dropped (it is older: review — an opening read answered after the one
  // the stream's return began brought a cleared act back); read again when the stream comes back, and — with no live
  // stream (the public link, or a stream polling) — every POLL_MS while the page is shown.
  // #2661: everyone's level (fleet-office-levels.js levelsOk): read on opening and every LEVELS_MS while shown — the
  // host works them out at most once a minute, so nothing here asks more often.
  const [lv, setLv] = useState(null);
  // Who went up a level since the last read (name → when it was seen): a ring over them for UP_MS (drawPart).
  const ups = useRef(new Map()), lastLevels = useRef(null);
  useEffect(() => {
    if (!lease) return undefined;
    const read = async () => {
      const d = await store.levels();
      if (!lease.current() || !d) return;
      const before = lastLevels.current, t = now();
      if (before) for (const [name, e] of d.levels) { const b = before.get(name); if (b && e.level > b.level) ups.current.set(name, t); }
      for (const [name, t0] of ups.current) if (t - t0 >= UP_MS) ups.current.delete(name);
      lastLevels.current = d.levels;
      setLv(d);
      loop.current?.wake();
    };
    void read();
    const h = lease.interval(() => { if (!globalThis.document?.hidden) void read(); }, LEVELS_MS);
    return () => lease.clear(h);
  }, [lease, store]);
  const [acts, setActs] = useState([]);
  const actSeen = useRef(new Set());
  useEffect(() => {
    if (!lease) return undefined;
    let heard = 0;                                                   // reads begun and events heard: the newest wins
    const read = async () => { const at = ++heard, d = await store.acts(); if (lease.current() && d && at === heard) setActs(d); };
    void read();
    const sub = appStore.get().streamOn;
    const polled = () => globalThis.document?.body?.dataset?.webTransport === "poll" || appStore.get().connection === "polling";
    const offs = sub ? [lease.hold(sub("office_acts", (d) => { heard++; if (d && Array.isArray(d.acts)) setActs(actsOk(d.acts, d.now)); else void read(); })),
      lease.hold(sub("connection", (c) => { if (c === "live") void read(); }))] : [];
    const h = lease.interval(() => { if (polled() && !globalThis.document?.hidden) void read(); }, POLL_MS);
    return () => { for (const off of offs) off(); lease.clear(h); };
  }, [lease, store]);
  // The skin packs: on opening, and again whenever the stream says one was uploaded or deleted.
  useEffect(() => {
    if (!lease) return undefined;
    const read = async () => { const d = await store.skins(); if (lease.current() && d) setPacks(d.packs); };
    void read();
    const sub = appStore.get().streamOn;
    const off = sub ? lease.hold(sub("office_skins", () => { void read(); })) : null;
    return () => { if (off) off(); };
  }, [lease, store]);
  // Whether this page may edit the offices: an admin session (the host asks again on every save), never a guest page or
  // the public link (whose sessions the host refuses outright). #2636 follow-up (the user's choice): Share… is an admin
  // session's here or over the public link (the host asks again too); never a guest's or a read-only one's.
  useEffect(() => {
    const body = globalThis.document?.body;
    if (!body || body.dataset.tier === "guest") return undefined;
    const overLink = body.dataset.publicLink === "1";
    let live = true;
    const auth = globalThis.AgendAuth;
    if (auth && typeof auth.canWrite === "function") Promise.resolve(auth.canWrite()).then((v) => { if (live) { setCanEdit(v === true && !overLink); setCanShare(v === true); } }, () => {});
    return () => { live = false; };
  }, []);
  // The stage's width (the grid wraps at it), and the theme (the tokens the canvas reads).
  useEffect(() => {
    const el = stageRef.current;
    const measure = () => {
      const w = el && el.clientWidth, h = el && el.clientHeight;
      if (w > 0) setWidth((cur) => (Math.abs(cur - w) >= 1 ? Math.floor(w) : cur));
      if (h > 0) setStageH((cur) => (Math.abs(cur - h) >= 1 ? Math.floor(h) : cur));
      setDpr(deviceRatio());                                           // the browser's zoom changes it
    };
    measure();
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    if (ro && el) ro.observe(el); else globalThis.addEventListener?.("resize", measure);
    const bump = () => setThemeRev((n) => n + 1);
    let mq = null;
    try { mq = typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: light)") : null; } catch { mq = null; }
    mq?.addEventListener?.("change", bump);
    const mo = typeof MutationObserver === "function" ? new MutationObserver(bump) : null;
    if (mo && globalThis.document?.documentElement) mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class"] });
    return () => { if (ro) ro.disconnect(); else globalThis.removeEventListener?.("resize", measure); mq?.removeEventListener?.("change", bump); mo?.disconnect(); };
  }, []);

  useLayoutEffect(() => {
    const next = readPal(stageRef.current);
    setPal((cur) => (JSON.stringify(cur) === JSON.stringify(next) ? cur : next));
  }, [themeRev]);
  const mode = modeOf(pal);
  const size = { w: width, h: stageH > 0 ? stageH : SIZE0.h };
  // The canvas bitmap's px per CSS px: the device's, unless the bitmap would be too big to paint (backingScale). Zoom
  // snaps to whole numbers of these (fleet-office-view.js), so a pixel-level view maps a logical unit onto whole pixels.
  const ratio = backingScale(size.w, size.h, dpr);

  // #2554: All offices — chosen, and at least two offices stored (else the whole fleet, as an office gone is).
  const overview = choice === ALL_ID && overviewOk(stored);
  const custom = choice !== AUTO_ID && !overview ? stored.find((o) => o.id === choice) || null : null;
  // The style: a built-in one, or an uploaded pack once it is loaded (until then, and when it is not one, Desks).
  const wanted = custom ? custom.skin : style;
  // A kept pack wins its id: one kept as "cozy" before it was built in (#2631) is still the style of the offices naming it.
  const packOf = (id) => packs.find((pk) => pk.id === id) || null;
  const styles = STYLES.filter((id) => !packOf(id));
  const packInfo = packOf(wanted);
  const packKey = packInfo ? `${packInfo.id}@${packInfo.sha}` : null;
  // The packs to load: this office's style; in All offices every tile's (each loaded once, shared by the tiles using it).
  const needed = [...new Map((overview ? [...stored.map((o) => o.skin), ...(lobbyOn ? [style] : [])] : [wanted]).map(packOf).filter(Boolean)
    .map((pk) => [`${pk.id}@${pk.sha}`, pk])).entries()];
  const neededKey = needed.map(([k]) => k).join(",");
  useEffect(() => {
    const want = needed.filter(([k]) => !packSkins.has(k));
    if (!want.length) return undefined;
    let live = true;
    const get = lease ? (path, o) => lease.fetch(path, o) : undefined;
    for (const [k, pk] of want) loadPackSkin(pk.id, pk.sha, { ...(get ? { fetch: get } : {}), ...(assetUrl ? { url: assetUrl } : {}), ...(assetImage ? { image: assetImage } : {}) }).then((sk) => { if (live) setPackSkins((m) => new Map(m).set(k, sk)); });
    return () => { live = false; };
  }, [neededKey]);
  const loading = !!packInfo && !packSkins.has(packKey);
  const baseSkin = packInfo ? packSkins.get(packKey) || skinFor("pixel") : skinFor(STYLES.includes(wanted) ? wanted : custom ? wanted : "pixel");
  // #2631: the cozy's picture, once, when this office (or a tile, or the lobby tile) is drawn in it; until then its bare floors.
  const cozyWanted = (overview ? [...stored.map((o) => o.skin), ...(lobbyOn ? [style] : [])] : [wanted]).includes("cozy");
  useEffect(() => {
    if (!cozyWanted) return undefined;
    let live = true;
    loadCozySkin().then((sk) => { if (live && sk && sk !== baseSkin) setCozyRev((n) => n + 1); });
    return () => { live = false; };
  }, [cozyWanted]);
  const zones = !!(baseSkin.pack && baseSkin.pack.stateZones);
  /** The style's identity: a pack's id and sha (a pack replaced is another), or the built-in skin's id. */
  const styleKey = packKey || baseSkin.id;
  // An open session no longer on its office and style (the office went, or its style changed meanwhile): only Cancel.
  const layoutStale = !!layout && (!custom || custom.id !== layout.officeId || custom.skin !== layout.skin || styleKey !== layout.pack || !zones || loading);
  // A stored office's own layout on a zones style (its overrides; while Edit layout is open, the draft).
  const placed = useMemo(() => {
    if (zones && layout && !layoutStale) return { skin: { ...baseSkin, pack: layout.draft }, ignored: false };
    return withOverrides(baseSkin, zones, custom);
  }, [baseSkin, zones, custom, layout, layoutStale]);
  const skin = placed.skin;
  // While Edit layout is open: a faint figure on every seat, in the pose its area is for (#2558), so a seat is placed by
  // what will stand, sit or lie there, not by a dot.
  const ghosts = zones && !!layout && !layoutStale;
  const keep = (n) => !(hideAsleep && ASLEEP.has(n.state));
  const single = useMemo(() => {
    if (overview) return { rooms: [], width: 1, height: 1 };            // All offices: the tiles below
    const all = custom ? membersOf(custom, view) : [...new Map(officeRooms(view, filter).flatMap((r) => r.nodes).map((n) => [n.name, n])).values()];
    const nodes = all.filter(keep);
    if (zones) { const z = zonesLayout(skin.pack, nodes, seatsRef.current, { night }); seatsRef.current = z.seats; return z; }
    // The desks wrap at the stage's width at the scale they open on (desksK: a pixel level near one CSS px a unit).
    const deskW = Math.max(240, Math.floor(width / desksK(ratio)));
    if (!custom) return autoLayout(officeRooms(view, filter).map((r) => (hideAsleep ? { ...r, nodes: r.nodes.filter(keep) } : r)), { width: deskW });
    return officeScene(custom, nodes, skin, false, deskW);
  }, [overview, view, filter, custom, width, ratio, skin, hideAsleep, night]);
  // ── #2554: All offices' tiles — each stored office (then the lobby: whoever is in no office) laid out as its own view
  // lays it out, in its own style (desks wrap at a cell's width), with its own seats, walkers and flights ──
  const lobbyAll = useMemo(() => (overview ? lobbyNodes(stored, view) : []), [overview, stored, view]);
  const lobbyList = lobbyOn ? lobbyAll : [];
  const tiles = useMemo(() => {
    if (!overview) return [];
    const mine = (m, k, make) => { if (!m.current.has(k)) m.current.set(k, make()); return m.current.get(k); };
    const specs = stored.map((o) => ({ key: o.id, office: o, name: o.name, lobby: false, wanted: o.skin, nodes: membersOf(o, view) }));
    if (lobbyList.length) specs.push({ key: LOBBY_TILE, office: { id: LOBBY_TILE, name: null, lobby: true, layout: null }, name: to("lobbyRoom"), lobby: true, wanted: style, nodes: lobbyList });
    return specs.map((sp) => {
      const info = packOf(sp.wanted), pk = info ? `${info.id}@${info.sha}` : null;
      const base = info ? packSkins.get(pk) || skinFor("pixel") : skinFor(sp.wanted);
      const z = !!(base.pack && base.pack.stateZones);
      const sk = withOverrides(base, z, sp.lobby ? null : sp.office).skin;
      const seatKey = `${sp.key}@${pk || base.id}`;
      // A desks office is as large as its rooms (cropped: no margins, no corridors outside them).
      const TL0 = officeScene(sp.office, sp.nodes.filter(keep), sk, z, OV.CELL_W, tileSeats.current.get(seatKey), night), TL = z ? TL0 : cropToRooms(TL0);
      if (z) tileSeats.current.set(seatKey, TL0.seats);
      return { key: sp.key, name: sp.name, lobby: sp.lobby, count: sp.nodes.length, skin: sk, zones: z, L: TL, prefix: `${sp.key}\u0001`,
        walkers: mine(tileWalkers, sp.key, createWalkers), flights: mine(tileFlights, sp.key, createFlights) };
    });
  }, [overview, stored, view, packs, packSkins, cozyRev, hideAsleep, lobbyOn, lobbyAll, style, night]);
  const arranged = useMemo(() => tileLayout(tiles.map((tl) => ({ key: tl.key, w: tl.L.width, h: tl.L.height })), size), [tiles, size.w, size.h]);
  const tileLooks = useMemo(() => { const work = workOn(traffic); return tiles.map((tl) => looksOf(tl.L, work, q, mode, tl.zones, (n) => badgeOf(n, lv, tl.skin.pack && tl.skin.pack.levels))); }, [tiles, traffic, q, mode, themeRev, lv]);
  // The scene the view pans and zooms: the office's, or the overview of every tile.
  const L = useMemo(() => (overview ? { mode: "overview", rooms: [], width: arranged.width, height: arranged.height } : single), [overview, single, arranged]);
  const looks = useMemo(() => looksOf(L, workOn(traffic), q, mode, zones, (n) => badgeOf(n, lv, skin.pack && skin.pack.levels)), [L, traffic, q, mode, themeRev, lv, skin]);
  // #2564: what comes in from other offices — one office's and style's own: a letter's door and drop are that layout's,
  // so another office (or style) starts with none (one shown meanwhile is not carried over to a different room).
  // #2578: the acts of the people in this stored office (by name); none elsewhere. On a desks style (review: accepted
  // acts drew nothing there) the line and the pose show; nobody walks (the host refuses go there).
  const actsHere = useMemo(() => new Map(custom && !overview ? acts.filter((a) => a.office === custom.id).map((a) => [a.instance, a]) : []), [acts, custom, overview]);
  const mailKey = `${custom ? custom.id : AUTO_ID}@${baseSkin.id}`;
  const mail = useMemo(() => { const m = createMail(); m.prime(traffic || []); return m; }, [mailKey]);
  useEffect(() => { flights.sync(traffic || [], now(), still); if (zones && !overview && mail.sync(traffic || [], now(), L, still)) loop.current?.wake(); }, [traffic, mail]);
  // Zones: everyone's seat is where they walk to — an idle person now and then strolls near it and back (#2560; not
  // with reduced motion, nor while Edit layout is open: the seats are being placed); someone with mail from another
  // office walks to it first (#2564). An NPC drawn as furniture with a `walk` strolls near its spot alike (#2596).
  const wander = zones && !overview && !still && !layout;
  useEffect(() => {
    if (!zones || overview) return undefined;
    const go = () => {
      const t = now(), to = walkTargets(desksOf(L), L, t, wander, skin.pack.furniture, night);
      // An act's walk; not someone in bed for the night (#2568: bedtime wins, as for mail).
      for (const d of desksOf(L)) { const a = actsHere.get(d.node.name), at = !d.night && actLive(a, d.node.state, Date.now(), actSeen.current) ? actTarget(a, L, walkers, t) : null; if (at) to.set(d.node.name, at); }
      for (const [name, at] of mail.targets(L, t)) to.set(name, at);
      walkers.sync(to, t, L, still);
      // Reduced motion has no loop: drawn again here, or an act's walk (set after the scene was drawn) never shows.
      if (still) { if (scene.current && !globalThis.document?.hidden) draw(0); } else loop.current?.wake();
    };
    go();
    if (still) return undefined;
    const h = setInterval(go, WANDER.TICK);
    return () => clearInterval(h);
  }, [L, wander, mail, skin, night, actsHere]);
  // …and in each tile on a zones style; the traffic within a tile is its own, between tiles the overview's.
  useEffect(() => {
    for (const tl of tiles) if (tl.zones) tl.walkers.sync(new Map(desksOf(tl.L).map((d) => [d.node.name, d.seat])), now(), tl.L, still);
    loop.current?.wake();
  }, [tiles]);
  useEffect(() => {
    if (!overview) return;
    for (const tl of tiles) tl.flights.sync(traffic || [], now(), still);
    cross.sync(traffic || [], now(), still);
    loop.current?.wake();
  }, [traffic, tiles]);

  // ── The view (#2540): { k, x, y } as the org chart canvas's (fleet-canvas-view.js) — logical units → the stage's CSS
  // px. Set without a render (a ref): the canvas redraws, the overview, the tooltip and Edit layout's overlay follow ──
  const vp = useRef(null), raw = useRef(1);                          // raw: the wheel's and a pinch's zoom (before the range)
  // touched: a person moved the view (it is kept); fitted: the view is a fit (a resize fits it again, to the new size).
  const touched = useRef(false), fitted = useRef(false), drag = useRef(gestureState());
  const miniViewRef = useRef(null), miniRef = useRef(null), overlayEl = useRef(null), tipDeskRef = useRef(null), pctRef = useRef(null);
  const labelEls = useRef(new Map());                                 // #2554: the tiles' labels (tile key → element)
  // What a view is kept for: the office and its style (All offices: its own key).
  const officeKey = overview ? `${ALL_ID}@tiles` : `${custom ? custom.id : AUTO_ID}@${baseSkin.id}`;
  const keyRef = useRef(officeKey), saveTimer = useRef(0);
  // The fit mode (Fit: contain; Fill: cover), kept per office and style like the view.
  const [fitRev, setFitRev] = useState(0);
  const fitMode = useMemo(() => store.fitMode(officeKey), [store, officeKey, fitRev]);
  const view0 = () => vp.current || { k: 1, x: 0, y: 0 };
  const flushSave = () => {
    if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = 0; }
    if (touched.current && vp.current) store.saveView(keyRef.current, savedOf(vp.current, sizeRef.current, fitted.current));
  };
  const sizeRef = useRef(size);
  sizeRef.current = size;
  /** Edit layout's overlay over the scene (placed through the CSSOM, never a style attribute: #1300). */
  const placeOverlay = (el) => {
    overlayEl.current = el || null;
    if (!el || !el.style) return;
    const v = view0();
    el.style.setProperty("left", `${v.x}px`); el.style.setProperty("top", `${v.y}px`);
    el.style.setProperty("width", `${L.width * v.k}px`); el.style.setProperty("height", `${L.height * v.k}px`);
  };
  /** The tooltip: what the canvas's card says, above the desk (below it at the top edge), wherever the view puts it. */
  const placeTip = () => {
    const el = tipRef.current, d = tipDeskRef.current;
    if (!el || !d || !el.style) return;
    const v = view0(), p = toScreen(v, d.x, d.y), x = Math.max(4, Math.min(p.x, size.w - 244)), above = p.y > 90;
    el.style.setProperty("transform", above ? `translate(${x}px, ${p.y + 6}px) translateY(-100%)` : `translate(${x}px, ${p.y + d.h * v.k}px)`);
  };
  /**
   * #2661: the card beside its person — to their right (left where it would not fit), level with their head, inside the
   * stage — following them as they walk (a walker's position now, else their seat or desk). A bottom sheet is not placed.
   */
  const placeCard = () => {
    const el = cardEl.current, c = cardDesk.current;
    if (!el || !c || !el.style || el.classList?.contains("sheet")) return;
    const v = view0(), sz = sizeRef.current;
    const w = c.walks ? walkers.at(c.name, now()) : null;
    const pt = w ? { x: w.x, y: w.y - 52, r: 16 } : { x: c.box.x + c.box.w / 2, y: c.box.y, r: (c.box.w / 2) * v.k };
    const p = toScreen(v, pt.x, pt.y), cw = 320, ch = el.offsetHeight || 260, gap = 12 + (w ? pt.r : pt.r);
    let x = p.x + gap;
    if (x + cw > sz.w - 8) x = p.x - gap - cw;
    x = Math.max(8, Math.min(x, sz.w - cw - 8));
    const y = Math.max(8, Math.min(p.y - 24, sz.h - ch - 8));
    el.style.setProperty("transform", `translate(${Math.round(x)}px, ${Math.round(y)}px)`);
  };
  /**
   * Put the view on everything that shows it beside the canvas: the overview's frame (the part of the scene in view;
   * the whole view on its data-k/x/y), the zoom's percentage, the overlay, the tooltip.
   */
  const mark = () => {
    const v = view0(), m = miniViewRef.current;
    if (m) {
      const f = miniFrame(v, size, L.width, L.height);
      for (const [a, val] of [["x", f.x], ["y", f.y], ["width", f.width], ["height", f.height], ["data-k", v.k], ["data-x", v.x], ["data-y", v.y]]) m.setAttribute(a, String(val));
    }
    const mb = miniRef.current;
    if (mb && mb.style) {                                              // the overview: inside the stage, scaled to it
      const b = miniBox(size, L.width, L.height);
      for (const [a, val] of [["left", b.x], ["top", b.y], ["width", b.w], ["height", b.h]]) mb.style.setProperty(a, `${val}px`);
      // #2737: hidden while a single office is all in view (it would show what the panel shows); All offices keeps it.
      if (!overview && wholeInView(v, size, L.width, L.height)) mb.setAttribute("data-whole", "");
      else mb.removeAttribute("data-whole");
    }
    const pc = pctRef.current;
    if (pc) { const lb = zoomLabel(v.k); if (pc.textContent !== lb) pc.textContent = lb; pc.setAttribute("aria-label", to("zoomLevel", lb)); }
    if (overlayEl.current) placeOverlay(overlayEl.current);
    // All offices: each tile's label just above it, as wide as the room up to the next label in its row (or the stage's
    // edge); hidden while its tile is off screen (nothing past the stage's edge for a focus to scroll it to: the
    // controls stay where they are).
    const shownTiles = overview ? new Set(visibleTiles(arranged, v, size).map((tt) => tt.key)) : null;
    for (const [i, tt] of (overview ? arranged.tiles : []).entries()) {
      const el = labelEls.current.get(tt.key);
      if (!el || !el.style) continue;
      const lp = toScreen(v, tt.x, tt.y), next = arranged.tiles[i + 1];
      const room = next && next.label.y === tt.label.y ? (next.x - tt.x) * v.k - 6 : size.w - lp.x - 8;
      el.style.setProperty("left", `${lp.x}px`); el.style.setProperty("top", `${lp.y}px`);
      el.style.setProperty("max-width", `${Math.max(40, room)}px`);
      el.style.setProperty("visibility", shownTiles.has(tt.key) ? "visible" : "hidden");
    }
    const st = stageRef.current;
    if (st && (st.scrollLeft || st.scrollTop)) { st.scrollLeft = 0; st.scrollTop = 0; }
    placeTip();
  };
  /** …and redraw. */
  const apply = () => {
    mark();
    if (scene.current) { scene.current.dirty = true; if (still) { if (!globalThis.document?.hidden) draw(0); } else loop.current?.wake(); }
  };
  /**
   * A new view (kept on the scene: clampPan); `user`: a person moved it (it is kept, a moment later); `fit`: it is a
   * fit (a resize fits it again).
   */
  const setView = (v, user = true, fit = false) => {
    vp.current = clampPan(v, L.width, L.height, size);
    fitted.current = fit;
    apply();
    if (!user) return;
    touched.current = true;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(flushSave, 400);
  };
  /**
   * The scene fitted (`mode`: contain or cover). All offices' contain keeps FIT_PAD px clear all round, so no tile sits
   * under the zoom controls at the side.
   */
  const fitL = (mode) => fitScene(L.width, L.height, size, mode, overview && mode !== "cover" ? FIT_PAD : 0);
  /** The view an office opens on: its kept one (a kept fit: fitted to this size), else its opening; and whether a fit. */
  const openView = () => {
    const kept = store.view(officeKey);
    if (kept && kept.fit) return { v: fitL(fitMode), fit: true };
    if (kept) return { v: viewFromSaved(kept, size), fit: false };
    const fitted0 = zones || overview;                                 // All offices opens whole, as a zones scene
    return { v: overview ? fitL(fitMode) : openingView(L.width, L.height, size, ratio, fitted0, fitMode), fit: fitted0 };
  };
  // An office (or style) opened: its kept view, else its opening (zones fitted; desks from the top left, or centred where smaller). A resize fits
  // a fitted view again (and opens an untouched one again); a view a person moved keeps the same point in the middle.
  // Either way it is then kept on the scene (clampPan): a kept view from a bigger panel cannot leave it off-screen.
  const opened = useRef(null), sized = useRef(null);
  useLayoutEffect(() => {
    const was = sized.current;
    sized.current = { w: size.w, h: size.h, ratio };
    const reopen = () => { const o = openView(); vp.current = o.v; fitted.current = o.fit; };
    if (opened.current !== officeKey) {
      if (opened.current !== null) flushSave();
      opened.current = officeKey; keyRef.current = officeKey; touched.current = false;
      reopen();
    } else if (was && (was.w !== size.w || was.h !== size.h || was.ratio !== ratio)) {
      if (fitted.current) vp.current = fitL(fitMode);
      else if (!touched.current) reopen();
      else { const v = vp.current, cx = (was.w / 2 - v.x) / v.k, cy = (was.h / 2 - v.y) / v.k; vp.current = { k: v.k, x: size.w / 2 - cx * v.k, y: size.h / 2 - cy * v.k }; }
    } else if (fitted.current) vp.current = fitL(fitMode);   // the scene's size changed
    vp.current = clampPan(view0(), L.width, L.height, size);
    raw.current = vp.current.k;
  }, [officeKey, size.w, size.h, ratio, L.width, L.height]);
  useEffect(() => () => flushSave(), []);
  /** Fit (the button, `0`): the office's mode — `mode` when it was just switched. */
  const fit = (mode = fitMode) => { const v = fitL(mode); raw.current = v.k; setView(v, true, true); };
  /** Fill on or off: kept for this office, and fitted at once. */
  const toggleFill = () => {
    const next = fitMode === "cover" ? "contain" : "cover";
    store.saveFitMode(officeKey, next); setFitRev((n) => n + 1);
    fit(next);
  };
  /** + / −: the next pixel level about the stage's middle. */
  const zoomStep = (dir) => { const v = view0(), k = stepK(v.k, dir, ratio); raw.current = k; setView(zoomTo(v, k, size.w / 2, size.h / 2)); };
  /** Bring a box (logical units) into view, unchanged when it already is. */
  const show = (b) => {
    const v = view0(), p = toScreen(v, b.x, b.y);
    if (p.x >= 8 && p.y >= 8 && p.x + b.w * v.k <= size.w - 8 && p.y + b.h * v.k <= size.h - 8) return;
    setView(centreOn(v, size, b.x + b.w / 2, b.y + b.h / 2));
  };

  // ── Fullscreen: the API on the container where the page may (its promise, or webkit's events, say how it went), else
  // immersive; leaving undoes whichever it was ──
  const enterFs = () => {
    const el = ooRef.current, d = globalThis.document;
    if (!el || fsRef.current) return;
    const req = el.requestFullscreen || el.webkitRequestFullscreen;
    const enabled = d ? (d.fullscreenEnabled ?? d.webkitFullscreenEnabled) : false;
    if (typeof req !== "function" || enabled === false) { setFs("immersive"); return; }
    fsAsked.current = true; fsTarget.current = el;
    let r;
    try { r = req.call(el); } catch { fsAsked.current = false; setFs("immersive"); return; }
    if (r && typeof r.then === "function") {
      r.then(() => { if (ooRef.current === el && fullscreenEl() === el) setFs("native"); },
        () => { if (fsAsked.current && ooRef.current === el) { fsAsked.current = false; setFs("immersive"); } });
    }
  };
  const exitFs = () => {
    fsAsked.current = false;
    const el = ooRef.current, d = globalThis.document;
    if (el && d && fullscreenEl() === el) {
      const ex = d.exitFullscreen || d.webkitExitFullscreen;
      try { const r = typeof ex === "function" ? ex.call(d) : null; if (r && typeof r.catch === "function") r.catch(() => {}); } catch { /* already out */ }
    }
    setFs(null);
  };
  const toggleFs = () => { if (fsRef.current) exitFs(); else enterFs(); };
  const editingRef = useRef(false);
  editingRef.current = editing;
  // The browser's own way out (its Esc, its UI) and its refusals; `f` and Esc; leaving the page leaves fullscreen.
  useEffect(() => {
    const d = globalThis.document;
    if (!d || typeof d.addEventListener !== "function") return undefined;
    const change = () => {
      const on = !!ooRef.current && fullscreenEl() === ooRef.current;
      if (on) fsAsked.current = false;
      setFs((cur) => (on ? "native" : cur === "native" ? null : cur));
    };
    const refused = () => { if (!fsAsked.current) return; fsAsked.current = false; setFs("immersive"); };
    const key = (e) => {
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.key === "Escape") { if (fsRef.current === "immersive") { e.preventDefault(); exitFs(); } return; }
      if (e.key !== "f" && e.key !== "F") return;
      const el = ooRef.current, tg = e.target;
      // Only here: from inside the view, or with nothing focused (never while typing, nor over Edit offices' dialog).
      if (!el || typing(tg) || editingRef.current || !(tg === d.body || tg === d.documentElement || tg === d || (tg && el.contains(tg)))) return;
      e.preventDefault();
      toggleFs();
    };
    const evs = [["fullscreenchange", change], ["webkitfullscreenchange", change], ["fullscreenerror", refused], ["webkitfullscreenerror", refused], ["keydown", key]];
    for (const [n, fn] of evs) d.addEventListener(n, fn);
    return () => {
      for (const [n, fn] of evs) d.removeEventListener(n, fn);
      fsAsked.current = false;
      const el = fullscreenEl(), ex = d.exitFullscreen || d.webkitExitFullscreen;
      if (el && (el === ooRef.current || el === fsTarget.current) && typeof ex === "function") {
        try { const r = ex.call(d); if (r && typeof r.catch === "function") r.catch(() => {}); } catch { /* already out */ }
      }
    };
  }, []);
  // Immersive: the dashboard's band the view sits in is lifted over the header, the tabs and the nav (app.css).
  useEffect(() => {
    const root = fs === "immersive" ? globalThis.document?.documentElement : null;
    if (!root || !root.classList) return undefined;
    root.classList.add("oo-immersive");
    return () => root.classList.remove("oo-immersive");
  }, [fs]);
  /** A desk opens its chat: out of fullscreen first (the chat is beside the view, or instead of it). */
  const open = (name) => { if (!onOpen) return; if (fsRef.current) exitFs(); onOpen(name); };

  // ── Drawing: the back and front layers are pictures of the scene at the view's resolution (remade when the office
  // or the zoom changes, never on a pan); each frame draws the matte, the layers, the people and the items in the air ──
  const scene = useRef(null);
  const loop = useRef(null);
  // The matte around the scene: the pack's own, else its background's edge (sampled once), else the skin's (tokens);
  // All offices: the dashboard's background (each tile is its own scene).
  const matte = overview ? pal.bg : (skin.pack && skin.pack.matte) || sampledMatte(skin.backdrop) || (skin.matte ? skin.matte({ pal, mode }) : pal.bg);
  // …and behind the canvas too (the stage), so no page grey shows while it is (re)sized.
  useLayoutEffect(() => { const el = stageRef.current; if (el && el.style) el.style.setProperty("background-color", matte); }, [matte]);
  useLayoutEffect(() => {
    const cv = canvasRef.current;
    const ctx = cv && typeof cv.getContext === "function" ? cv.getContext("2d") : null;
    if (!ctx) { scene.current = null; return; }
    // The canvas is the stage: its bitmap at `ratio` px per CSS px (never larger than a browser paints).
    const BW = Math.max(1, Math.floor(size.w * ratio)), BH = Math.max(1, Math.floor(size.h * ratio));
    if (cv.width !== BW || cv.height !== BH) { cv.width = BW; cv.height = BH; }
    cv.style.setProperty("width", `${BW / ratio}px`);
    cv.style.setProperty("height", `${BH / ratio}px`);
    const env = { pal, mode, labels: { lobby: to("lobbyRoom"), closed: to("closed"), areas: { desks: to("area_desks"), lounge: to("area_lounge"), alert: to("area_alert"), nap: to("area_nap") } } };
    const base = { ctx, ratio, BW, BH, matte, env, dirty: true };
    if (overview) {
      // Each tile a scene of its own, where the overview puts it (arranged.tiles, in the same order).
      const parts = tiles.map((tl, i) => ({ ...partOf(tl.L, tileLooks[i], tl.skin, tl.zones, tl.walkers, tl.flights), night, key: tl.key, prefix: tl.prefix, tile: arranged.tiles[i], ups: ups.current, levelsOn: !!(lv && lv.enabled) }));
      scene.current = { ...base, overview: true, parts, lay: arranged };
    } else {
      scene.current = { ...base, overview: false, part: { ...partOf(L, looks, skin, zones, walkers, flights), ghosts, night, mail, acts: actsHere, actSeen: actSeen.current, ups: ups.current, levelsOn: !!(lv && lv.enabled) } };
    }
    if (still) draw(0); else loop.current?.wake();
  }, [L, looks, skin, pal, size.w, size.h, ratio, matte, overview, tiles, tileLooks, arranged, ghosts, night, mail, actsHere, lv]);

  /** One frame at `ms` (0: still); whether anything is moving (in the air, or someone walking). */
  function draw(ms) {
    const s = scene.current;
    if (!s) return false;
    placeCard();
    const { ctx, BW, BH, env } = s;
    // The view in bitmap px: a logical unit is `a` px (a whole number at a pixel level), the origin on a whole px.
    const v = view0(), a = v.k * s.ratio, ox = Math.round(v.x * s.ratio), oy = Math.round(v.y * s.ratio);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, BW, BH);
    ctx.fillStyle = s.matte; ctx.fillRect(0, 0, BW, BH);
    ctx.imageSmoothingEnabled = false;
    if (!s.overview) return drawPart(ctx, s.part, a, ox, oy, ms, still, tipNow.current, env);
    // All offices: each tile on screen drawn as its own view, scaled into it and clipped to it; one off screen is not
    // drawn (its flights still land). Then a frame round each tile, and the items flying between tiles.
    const hot = tipNow.current, on = new Set(visibleTiles(s.lay, v, sizeRef.current).map((tt) => tt.key)), said = [];
    let moving = false;
    for (const p of s.parts) {
      const tt = p.tile;
      if (!on.has(tt.key)) { if (!still) p.flights.frame(ms, p.L); continue; }
      const tx = Math.round((v.x + tt.x * v.k) * s.ratio), ty = Math.round((v.y + tt.y * v.k) * s.ratio), tw = tt.w * v.k * s.ratio, th = tt.h * v.k * s.ratio;
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.beginPath(); ctx.rect(tx, ty, tw, th); ctx.clip();
      if (drawPart(ctx, p, a * tt.s, tx, ty, ms, still, hot && hot.startsWith(p.prefix) ? hot.slice(p.prefix.length) : null, env, v.k * tt.s < TAG_MIN_K, said)) moving = true;
      ctx.restore();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.strokeStyle = env.pal.border; ctx.lineWidth = 1;
      ctx.strokeRect(tx - 0.5, ty - 0.5, tw + 1, th + 1);
    }
    for (const say of said) say();
    const up = still ? [] : cross.frame(ms, s.parts);
    // Each drawn by its sender's tile's skin (#2562: their own prop, else that pack's for its kind), at that tile's scale;
    // a sender in no tile drawn: the built-in item, in overview units.
    for (const it of up) {
      const from = senderTile(s.parts, it.from);
      if (from) { ctx.setTransform(a * from.tile.s, 0, 0, a * from.tile.s, ox, oy); from.skin.drawProp(ctx, { ...it, x: it.x / from.tile.s, y: it.y / from.tile.s }, ms, env); }
      else { ctx.setTransform(a, 0, 0, a, ox, oy); skinFor("pixel").drawProp(ctx, it, ms, env); }
    }
    return moving || up.length > 0 || cross.size() > 0;
  }
  // The loop: drawing only when the frame (FPS) changed or something is in the air; stopped while the tab is hidden,
  // gone with the view. Office review: while something walks or flies, one requestAnimationFrame per display frame (the
  // motion is smooth); when nothing moves, the poses change at most FPS times a second, so the loop sleeps (a timer)
  // until the next frame's start instead of waking at the display's rate only to find nothing to draw.
  useEffect(() => {
    if (still || typeof requestAnimationFrame !== "function") return undefined;
    let raf = 0, timer = 0, last = -1, air = true, gone = false;
    const tick = () => {
      raf = 0;
      if (gone || globalThis.document?.hidden || !scene.current) return;
      const ms = now(), frame = Math.floor((ms / 1000) * FPS);         // the clock the trips started on
      if (scene.current.dirty || frame !== last || air) { scene.current.dirty = false; last = frame; air = draw(ms); }
      if (air) { raf = requestAnimationFrame(tick); return; }
      const wait = Math.max(1, Math.ceil(((frame + 1) * 1000) / FPS - ms));   // until the next frame starts
      timer = setTimeout(() => { timer = 0; if (!gone && !raf) raf = requestAnimationFrame(tick); }, wait);
    };
    const wake = () => {
      air = true;
      if (timer) { clearTimeout(timer); timer = 0; }
      if (!raf && !gone && !globalThis.document?.hidden) raf = requestAnimationFrame(tick);
    };
    loop.current = { wake };
    const vis = () => { if (!globalThis.document?.hidden) wake(); };
    globalThis.document?.addEventListener?.("visibilitychange", vis);
    wake();
    return () => {
      gone = true; loop.current = null;
      if (raf) cancelAnimationFrame(raf);
      if (timer) clearTimeout(timer);
      globalThis.document?.removeEventListener?.("visibilitychange", vis);
    };
  }, []);
  useEffect(() => { loop.current?.wake(); }, [traffic]);

  // The person hovered or focused: their name tag shows even in a crowd.
  const tipNow = useRef(null);
  tipNow.current = tip;
  useEffect(() => { if (!scene.current) return; scene.current.dirty = true; if (still) draw(0); else loop.current?.wake(); }, [tip]);

  // Everyone drawn: { key, node, box (the desk, in the view's units), dot (where the overview marks them), office (All
  // offices: the tile's name) }. In All offices a key is the tile's prefix and the desk's key: one person in two
  // offices is two people here.
  // #2661: and for the card, where they are (`area`: the zone's or the room's name), the style that draws them, their look.
  const roomOf = (L0, d) => { const r = L0.rooms.find((rm) => rm.desks.includes(d)); return r ? (r.lobby ? to("lobbyRoom") : r.name) : null; };
  const areaName = (a) => (a ? ({ desks: to("area_desks"), lounge: to("area_lounge"), alert: to("area_alert"), nap: to("area_nap") })[a] || a : null);
  const people = overview
    ? tiles.flatMap((tl, i) => { const tt = arranged.tiles[i], lk = tileLooks[i];
      return tt ? desksOf(tl.L).map((d) => ({ key: tl.prefix + d.key, node: d.node, box: tileBox(tt, d), office: tl.name,
        dot: fromTile(tt, tl.zones ? d.seat : { x: d.x + d.w / 2, y: d.y + d.h / 2 }),
        area: tl.zones ? areaName(d.area) : roomOf(tl.L, d), skin: tl.skin, look: lk && lk.get(d.key) })) : []; })
    : desksOf(L).map((d) => ({ key: d.key, node: d.node, box: d, office: null, dot: zones ? d.seat : { x: d.x + d.w / 2, y: d.y + d.h / 2 },
      area: zones ? areaName(d.area) : roomOf(L, d), skin, look: looks.get(d.key) }));
  // Preact owns the markup, not the view: put it back on the overview, the overlay and the tooltip after every render.
  const tipDesk = tip ? people.find((d) => d.key === tip) || null : null;
  tipDeskRef.current = tipDesk ? tipDesk.box : null;
  useLayoutEffect(mark);
  // ── Pointing (#2540: through the view): hover (or a first tap) shows a desk's card, a click (or a second tap) opens
  // its chat; a drag on the scene pans it (never on Edit layout's handles: they move), the wheel and a pinch zoom ──
  /** The view's point under a pointer event (logical units), or null. */
  const pointOf = (e) => {
    const r = canvasRef.current ? canvasRef.current.getBoundingClientRect() : null;
    return r ? toWorld(view0(), e.clientX - r.left, e.clientY - r.top) : null;
  };
  /** The person under a pointer event as drawn ({ key, node }), or null; All offices: in the tile there, in its own units. */
  const deskOf = (e) => {
    const w = pointOf(e), s = scene.current;
    if (!w) return null;
    // The zones scene draws people where they walk: they are hit there, not at the seat they are heading for (hitPart).
    if (!s || !s.overview) {
      if (overview) return null;
      return hitPart(s && s.part ? s.part : { L, zones, walkers, skin, looks, all: L.rooms.flatMap((rm) => rm.desks) }, w.x, w.y, now());
    }
    const tt = tileAt(s.lay, w.x, w.y), p = tt ? s.parts.find((x) => x.tile.key === tt.key) : null;
    if (!p) return null;
    const at = inTile(tt, w.x, w.y), d = hitPart(p, at.x, at.y, now());
    return d ? { key: p.prefix + d.key, node: d.node } : null;
  };
  const g = gestures(drag.current, { el: () => stageRef.current, pan: (dx, dy) => { const v = view0(); setView({ ...v, x: v.x + dx, y: v.y + dy }); },
    pinch: (from, to) => { raw.current = Math.min(OK_MAX, Math.max(OK_MIN, raw.current * (to.dist / from.dist))); setView(pinchOffice(view0(), from, to, raw.current)); } });
  /** Where a drag pans: the canvas, and Edit layout's overlay off its handles (the controls, the bar and the list: never). */
  const onScene = (el) => !!el && (el === canvasRef.current || (typeof el.closest === "function" && !!el.closest(".ol-svg") && !el.closest(".ol-handle")));
  const onDown = (e) => {
    lastType.current = e.pointerType || "mouse";
    if (!onScene(e.target)) return;
    g.down(e);
    if (drag.current.pts.size === 2) raw.current = view0().k;      // a pinch starts from the zoom shown
  };
  const onWheel = (e) => {
    if (!onScene(e.target) && !(typeof e.target?.closest === "function" && e.target.closest(".ol-handle, .oo-tile-label"))) return;
    e.preventDefault();
    const r = stageRef.current.getBoundingClientRect(), v = view0();
    raw.current = Math.min(OK_MAX, Math.max(OK_MIN, raw.current * wheelFactor(e)));
    if (raw.current !== v.k) setView(zoomOffice(v, raw.current, e.clientX - r.left, e.clientY - r.top));
  };
  const onKeyDown = (e) => {
    if (e.defaultPrevented) return;                                  // Edit layout's handles move with the arrows
    const tag = e.target && e.target.tagName;
    if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
    const z = zoomKey(e);
    if (z) { e.preventDefault(); if (z === "fit") fit(); else zoomStep(z === "in" ? 1 : -1); return; }
    const dir = PAN_KEYS[e.key];
    if (dir && e.target === canvasRef.current && !e.altKey && !e.ctrlKey && !e.metaKey) { e.preventDefault(); const v = view0(); setView({ ...v, x: v.x - dir[0] * 80, y: v.y - dir[1] * 80 }); }
  };
  // The keyboard's way through: a desk in the list, or a handle of Edit layout, is brought into view when focused.
  const onFocusIn = (e) => {
    const el = e.target;
    if (!el || typeof el.getAttribute !== "function") return;
    const hk = el.getAttribute("data-handle");
    if (hk && layout) { const hd = handlesOf(layout.draft).find((x) => x.key === hk); if (hd) show({ x: hd.x - 12, y: hd.y - 12, w: 24, h: 24 }); return; }
    const key = el.classList && el.classList.contains("oo-desk") ? el.getAttribute("data-key") : null;
    const d = key ? people.find((x) => x.key === key) : null;
    if (d) show(d.box);
  };
  const onMove = (e) => { if (e.pointerType === "touch" || g.busy()) return; const d = deskOf(e); const key = d ? d.key : null; if (key !== tip) setTip(key); };
  // #2661: a click (or a tap) on a person opens their card; on the same person again, or off everyone, closes it; on
  // someone else, switches to theirs. A double-click skips the card and opens the chat.
  const onClick = (e) => {
    const d = deskOf(e);
    if (!d || !d.node.i) { setTip(null); setCard(null); return; }
    if (lastType.current === "touch") setTip(null);
    cardFrom.current = null;
    setCard((cur) => (cur === d.key ? null : d.key));
  };
  // All offices: a double-click on a tile (off its people) opens that office; the lobby is no office.
  const onDblClick = (e) => {
    const s = scene.current, w = pointOf(e), hit = deskOf(e);
    if (hit && hit.node.i) { setCard(null); open(hit.node.name); return; }   // #2661: a person's chat, past the card
    if (!overview || !s || !s.overview || !w || hit) return;
    const tt = tileAt(s.lay, w.x, w.y) || labelAt(s.lay, w.x, w.y), tl = tt ? tiles.find((x) => x.key === tt.key) : null;
    if (tl && !tl.lobby) pick(tl.key);
  };
  const onMini = (e) => {
    const w = miniPoint(miniRef.current ? miniRef.current.getBoundingClientRect() : null, { x: 0, y: 0, w: L.width, h: L.height }, e.clientX, e.clientY);
    if (w) setView(centreOn(view0(), size, w.x, w.y));
  };

  const auto = !custom && !overview;
  // Edit layout: an admin, a stored office, a zones style (built in, or a pack loaded here); not while the offices'
  // editor is open, nor a second session (nor in All offices: custom is null there).
  const canLayout = canEdit && storedRev !== null && !!custom && zones && !loading && baseSkin.id === custom.skin && !editing && !layout;
  const openLayout = () => {
    setLayout({ id: ++layoutSeq.current, officeId: custom.id, skin: custom.skin, pack: styleKey, base: baseSkin.pack, start: skin.pack, draft: skin.pack, rev: storedRev, list: stored });
    setTip(null);
  };
  const closeLayout = () => setLayout(null);
  // #2691: whom a seat can be reserved for — the office's members (its teams' too).
  const layoutMembers = useMemo(() => (layout && custom ? membersOf(custom, view).map((n) => n.name) : []), [layout && layout.id, custom, view]);
  const onDraft = (draft) => setLayout((cur) => (cur ? { ...cur, draft } : cur));
  // Save: the session's list, this office's overrides replaced (none: back to the style's own), with the session's rev.
  // A change made meanwhile (409) reads the list again: the session takes it (the view too), the draft is kept, and
  // Save again — the person's call, told so — puts it on that list.
  const saveLayout = async (ov) => {
    const s = layoutRef.current;
    const mine = s && s.list.find((o) => o.id === s.officeId);
    if (!s || !mine || mine.skin !== s.skin) return { ok: false, message: t("orgl.stale") };
    const list = s.list.map((o) => (o.id === s.officeId ? (({ overrides: _gone, ...rest }) => (ov ? { ...rest, overrides: ov } : rest))(o) : o)).map(officeForSave);
    const sent = ask();
    const r = await store.saveOffices(list, s.rev);
    if (r.ok) { adopt({ rev: r.rev, offices: r.offices }, sent); return { ok: true }; }
    if (r.status === 409) {
      const at = ask(); const cur = adopt(await store.offices(), at);
      if (cur) setLayout((c) => (c && c.id === s.id ? { ...c, list: cur.offices, rev: cur.rev } : c));
      return { ok: false, message: t("orgl.changed") };
    }
    return { ok: false, message: r.status === 429 ? t("orgl.rateLimited") : t("orgl.failed", r.error || r.status) };
  };
  const styleName = (id) => (styles.includes(id) ? to(`style_${id}`) : (packs.find((pk) => pk.id === id) || { name: id }).name);
  const f = filterOk(filter);
  const opts = teamOptions(view);
  const teamValue = (opts.find((o) => o.team === f.team) || opts[0]).value;
  const setF = (next) => { const v = filterOk(next); store.saveFilter(v); setFilter(v); };
  // While Edit layout is open the office stays (its picker is disabled; this is the guard behind it).
  const pick = (id) => { if (layoutRef.current) return; store.saveChoice(id); setChoice(id); setTip(null); };
  const everyone = useMemo(() => { const m = new Map(); for (const n of [...view.top, ...view.teams.flatMap((tm) => tm.nodes), ...view.rest.nodes]) if (!m.has(n.name)) m.set(n.name, n); return [...m.values()]; }, [view]);
  const tipText = tipDesk ? nodeText(tipDesk.node) : null;
  // #2661: the card's person (gone from the office, filtered out or the office changed: it closes).
  const cardOf = card ? people.find((d) => d.key === card && d.node.i) || null : null;
  cardDesk.current = cardOf ? { name: cardOf.node.name, box: cardOf.box, walks: zones && !overview } : null;
  useEffect(() => { if (card && !cardOf) setCard(null); }, [card, !!cardOf]);
  const closeCard = () => {
    setCard(null);
    const from = cardFrom.current; cardFrom.current = null;
    if (from) [...(ooRef.current?.querySelectorAll?.(".oo-desk") || [])].find((el) => el.getAttribute("data-key") === from)?.focus?.();
  };
  // Esc, or a press anywhere off the card and the scene (the scene's own click decides there), closes it.
  useEffect(() => {
    if (!card) return undefined;
    const doc = globalThis.document;
    const key = (e) => { if (e.key === "Escape" && !e.defaultPrevented) { e.preventDefault(); closeCard(); } };
    // A desk-list entry is the scene's too: its own click decides (the same person again closes, another switches) —
    // closing here first would let that click open it again (#2761 review).
    const press = (e) => {
      const el = e.target;
      if (cardEl.current?.contains?.(el) || el === canvasRef.current) return;
      if (typeof el?.closest === "function" && el.closest(".oo-desk") && ooRef.current?.contains?.(el)) return;
      closeCard();
    };
    doc?.addEventListener?.("keydown", key, true); doc?.addEventListener?.("pointerdown", press, true);
    return () => { doc?.removeEventListener?.("keydown", key, true); doc?.removeEventListener?.("pointerdown", press, true); };
  }, [card]);
  /** Find in office: zoomed in (to at least TWO px a unit) and centred on them. */
  const findCard = () => {
    const c = cardDesk.current;
    if (!c) return;
    const w = c.walks ? walkers.at(c.name, now()) : null, at = w ? { x: w.x, y: w.y - 26 } : { x: c.box.x + c.box.w / 2, y: c.box.y + c.box.h / 2 };
    const v = view0(), k = Math.min(OK_MAX, Math.max(v.k, FIND_K));
    touched.current = true; fitted.current = false;
    setView(centreOn({ ...v, k }, size, at.x, at.y));
  };
  /** The card's picture: the person's idle frame in the office's style (pack strip or built-in figure). */
  const drawAvatar = (cv) => {
    const s = scene.current, c = cardOf;
    const g = cv && cv.getContext ? cv.getContext("2d") : null;
    if (!g || !c || !s || !c.skin || !c.look) return;
    const r = deviceRatio(), W = 56;
    if (cv.width !== W * r) { cv.width = W * r; cv.height = W * r; }
    g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, cv.width, cv.height); g.imageSmoothingEnabled = false;
    const look = { ...c.look, pose: "idle", dim: false, match: false, badge: null, notag: true, free: true, work: 0, sign: null };
    const at = { x: 0, y: 0 }, b = c.skin.charBox ? c.skin.charBox(look, at) : null, box = b || { x: -16, y: -48, w: 32, h: 48 };
    const k = Math.min((W - 8) / box.w, (W - 8) / box.h) * r;
    g.setTransform(k, 0, 0, k, (W * r) / 2 - (box.x + box.w / 2) * k, (W * r) / 2 - (box.y + box.h / 2) * k);
    try { c.skin.drawCharacter(g, { x: at.x - 44, y: at.y - 53, w: 88, h: 53, seat: at }, look, 0, s.env); } catch { /* a picture not loaded yet: blank */ }
  };
  // The overview: the scene's rooms (or areas; All offices: the tiles) and a dot for each person (a call in its colour),
  // the view's frame on it.
  const miniRects = overview ? arranged.tiles.map((tt) => ({ key: tt.key, x: tt.x, y: tt.y, w: tt.w, h: tt.h }))
    : zones ? Object.values(L.areas || {}).map((a) => ({ key: a.name, ...a.rect })) : L.rooms.map((r) => ({ key: r.key, x: r.x, y: r.y, w: r.w, h: r.h }));
  const dotR = Math.max(L.width, L.height) / 90;
  // The switcher: the whole fleet, All offices (two or more stored), each stored office.
  const officeSelect = (cls) => html`<select class=${`tb-select ${cls}`} value=${layout ? layout.officeId : overview ? ALL_ID : custom ? custom.id : AUTO_ID} disabled=${!!layout}
    aria-label=${to("office")} onChange=${(e) => pick(e.target.value)}>
      <option value=${AUTO_ID}>${to("allOffice")}</option>
      ${overviewOk(stored) ? html`<option value=${ALL_ID}>${to("allOffices")}</option>` : null}
      ${stored.map((o) => html`<option key=${o.id} value=${o.id}>${o.name}</option>`)}
    </select>`;
  return html`<div class=${`oo${fs ? ` fs ${fs}` : ""}`} ref=${ooRef}>
    <div class="oo-bar">
      <label class="oo-pick"><span class="oo-pick-label">${to("office")}</span>${officeSelect("oo-office")}</label>
      ${auto ? html`<label class="oo-pick"><span class="oo-pick-label">${to("styleLabel")}</span>
        <select class="tb-select" value=${STYLES.includes(style) || packs.some((pk) => pk.id === style) ? style : skin.id} title=${to(canEdit ? "styleForAll" : "styleHere")} onChange=${(e) => pickStyle(e.target.value)}>
          ${styles.map((id) => html`<option key=${id} value=${id}>${to(`style_${id}`)}</option>`)}
          ${packs.map((pk) => html`<option key=${`pack:${pk.id}`} value=${pk.id}>${pk.name}</option>`)}
        </select></label>` : null}
      ${auto ? html`<label class="oo-pick"><span class="oo-pick-label">${to("show")}</span>
        <select class="tb-select" value=${teamValue} onChange=${(e) => { const o = opts.find((x) => x.value === e.target.value); setF({ ...f, team: o ? o.team : "" }); }}>
          ${opts.map((o) => html`<option key=${o.value} value=${o.value}>${o.label}</option>`)}
        </select></label>
        <${People} nodes=${everyone} pinned=${f.pinned} onChange=${(pinned) => setF({ ...f, pinned })} />` : null}
      <label class="check oo-hide-asleep"><input type="checkbox" checked=${hideAsleep} onChange=${() => { const v = !hideAsleep; store.saveHideAsleep(v); setHideAsleep(v); setTip(null); }} /><span>${to("hideAsleep")}</span></label>
      ${zones || overview ? html`<label class="check oo-night"><input type="checkbox" checked=${nightOn} onChange=${() => { const v = !nightOn; store.saveNightOn(v); setNightOn(v); }} /><span>${to("nightOn")}</span></label>` : null}
      ${overview ? html`<label class="check oo-lobby-tile" title=${lobbyAll.length ? undefined : to("lobbyEveryone")}><input type="checkbox" checked=${lobbyOn && lobbyAll.length > 0}
        disabled=${!lobbyAll.length} onChange=${() => { const v = !lobbyOn; store.saveLobbyTile(v); setLobbyOn(v); setTip(null); }} /><span>${to("lobbyTile")}</span></label>
        ${lobbyAll.length ? null : html`<span class="muted oo-note oo-lobby-none">${to("lobbyEveryone")}</span>`}` : null}
      ${custom && baseSkin.id !== custom.skin && !loading ? html`<span class="muted oo-note">${to("skinUnknown", styleName(custom.skin))}</span>` : null}
      ${placed.ignored ? html`<span class="muted oo-note">${to("layoutIgnored")}</span>` : null}
      ${styleErr && auto ? html`<span class="note oo-note oo-style-err" role="status">${styleErr}</span>` : null}
      ${L.unseated ? html`<span class="muted oo-note">${to("unseated", L.unseated)}</span>` : null}
      ${canEdit && storedRev !== null ? html`<button type="button" class="btn btn-sm oo-edit" onClick=${() => { if (!overview) setEditing(true); }} disabled=${!!layout || overview}
        title=${overview ? to("overviewNoEdit") : undefined}>${t("orge.edit")}</button>` : null}
      ${canLayout ? html`<button type="button" class="btn btn-sm oo-layout" onClick=${openLayout}>${t("orgl.edit")}</button>` : null}
      ${canShare ? html`<${ShareButton} offices=${stored} current=${overview ? "all" : custom ? custom.id : null} disabled=${!!layout}
        get=${lease ? (path, o) => lease.fetch(path, o) : undefined} />` : null}
    </div>
    ${editing && !overview ? html`<${OfficeEditor} offices=${stored} rev=${storedRev} view=${view} store=${store} packs=${packs}
      ask=${ask} current=${() => shown.current} onSaved=${adopt} onClose=${() => setEditing(false)} />` : null}
    ${overview || people.length || L.rooms.length ? null : html`<p class="note oo-empty">${to("nobody")} ${auto && (f.team || f.pinned.length) ? html`<button type="button" class="btn btn-sm" onClick=${() => setF({ team: "", pinned: [] })}>${to("everyone")}</button>` : null}</p>`}
    <div class=${`oo-stage${layout ? " editing" : ""}`} ref=${stageRef} onPointerDown=${onDown} onPointerMove=${g.move} onPointerUp=${g.up} onPointerCancel=${g.up}
      onWheel=${onWheel} onKeyDown=${onKeyDown} onFocusIn=${onFocusIn} onClickCapture=${g.clickCapture}>
      <canvas ref=${canvasRef} class=${`oo-canvas${tipDesk && tipDesk.node.i ? " hot" : ""}`} role="application" tabindex="0" aria-label=${to(overview ? "labelAll" : "label")}
        onPointerMove=${onMove} onPointerLeave=${() => setTip(null)} onClick=${onClick} ondblclick=${onDblClick}></canvas>
      ${overview ? tiles.map((tl) => {
        const text = to("tileLabel", tl.name, tl.count), at = (el) => { if (el) labelEls.current.set(tl.key, el); else labelEls.current.delete(tl.key); };
        return tl.lobby ? html`<span key=${tl.key} ref=${at} class="oo-tile-label lobby">${text}</span>`
          : html`<button key=${tl.key} ref=${at} type="button" class="oo-tile-label" data-office=${tl.key} title=${to("openOffice", tl.name)} aria-label=${to("openOffice", tl.name)}
              onClick=${() => pick(tl.key)}>${text}</button>`;
      }) : null}
      ${layout ? html`<${LayoutEditor} key=${layout.id} base=${layout.base} start=${layout.start} place=${placeOverlay} dock=${!fs} members=${layoutMembers}
        stale=${layoutStale ? t("orgl.stale") : ""} onChange=${onDraft} onSave=${saveLayout} onClose=${closeLayout} />` : null}
      ${tipText && tip !== card ? html`<div ref=${tipRef} class="oo-tip" role="tooltip">
        <strong>${tipText.primary}</strong>${tipText.secondary ? html` <span class="muted mono">${tipText.secondary}</span>` : null}
        <div>${tipText.sub}</div><div class="muted">${caption(officePose(tipDesk.node.state), tipDesk.node.state)}</div>
        ${tipDesk.office ? html`<div class="muted oo-tip-office">${tipDesk.office}</div>` : null}
      </div>` : null}
      ${cardOf ? html`<${OfficeCard} key=${cardOf.key}
        model=${cardModel({ node: cardOf.node, lv, levels: cardOf.skin && cardOf.skin.pack ? cardOf.skin.pack.levels : null, share: !onOpen,
          state: stateWords(cardOf.node), now: caption(officePose(cardOf.node.state), cardOf.node.state),
          where: [cardOf.office || (custom ? custom.name : to("allOffice")), cardOf.area].filter(Boolean).join(" · ") })}
        avatar=${drawAvatar} sheet=${size.w < SHEET_W} place=${(el) => { cardEl.current = el; placeCard(); }}
        onChat=${onOpen ? () => { const n = cardOf.node.name; setCard(null); open(n); } : null} onFind=${findCard} onClose=${closeCard} />` : null}
      <ul class="oo-desks" aria-label=${to("desks")}>${people.map((d) => {
        const nt = nodeText(d.node), cap = caption(officePose(d.node.state), d.node.state), where = d.office ? ` · ${d.office}` : "";
        return html`<li key=${d.key}>${d.node.i
          ? html`<button type="button" class="oo-desk" data-name=${d.node.name} data-key=${d.key} aria-label=${`${nt.full}${where} · ${cap}.`} aria-haspopup="dialog"
              onFocus=${() => setTip(d.key)} onBlur=${() => setTip(null)} onClick=${() => { cardFrom.current = d.key; setCard((cur) => (cur === d.key ? null : d.key)); }}>${nt.primary}</button>`
          : html`<span class="oo-desk" data-name=${d.node.name} data-key=${d.key}>${nt.full}</span>`}</li>`;
      })}</ul>
      <div class="oc-zoom oo-zoom" role="group" aria-label=${t("orgc.view")}>
        <output ref=${pctRef} class="oo-zoom-pct"></output>
        <button type="button" class="icon-btn oo-zoom-in" aria-label=${t("orgc.zoomIn")} title=${t("orgc.zoomIn")} onClick=${() => zoomStep(1)}><${Icon} name="plus" size=${16} /></button>
        <button type="button" class="icon-btn oo-zoom-out" aria-label=${t("orgc.zoomOut")} title=${t("orgc.zoomOut")} onClick=${() => zoomStep(-1)}><${Icon} name="minus" size=${16} /></button>
        <button type="button" class="icon-btn oo-fit" aria-label=${to("fit")} title=${to("fit")} onClick=${() => fit()}><${Icon} name="fitwidth" size=${16} /></button>
        <button type="button" class=${`icon-btn oo-fill${fitMode === "cover" ? " on" : ""}`} aria-pressed=${fitMode === "cover" ? "true" : "false"} aria-label=${to("fillTitle")}
          title=${to("fillTitle")} onClick=${toggleFill}>${to("fill")}</button>
        <button type="button" class="icon-btn oo-fs" aria-label=${to(fs ? "exitFullscreen" : "fullscreen")} title=${to(fs ? "exitFullscreen" : "fullscreen")} onClick=${toggleFs}><${Icon} name=${fs ? "fullscreenexit" : "fullscreen"} size=${16} /></button>
      </div>
      ${fs ? html`<div class="oo-fs-bar">${officeSelect("oo-fs-office")}</div>` : null}
      <svg ref=${miniRef} class="oc-mini oo-mini" viewBox=${`0 0 ${Math.max(1, L.width)} ${Math.max(1, L.height)}`} aria-hidden="true" onClick=${onMini}>
        <title>${to("overview")}</title>
        <rect class="oo-mini-matte" x=${-L.width} y=${-L.height} width=${L.width * 3} height=${L.height * 3} fill=${matte} />
        <rect class="oo-mini-scene" x="0" y="0" width=${L.width} height=${L.height} />
        ${miniRects.map((r) => html`<rect key=${r.key} class="oo-mini-room" x=${r.x} y=${r.y} width=${r.w} height=${r.h} />`)}
        ${people.map((d) => html`<circle key=${d.key} class=${`oo-mini-dot st-${d.node.state}${q && hits(d.node, q) ? " match" : ""}`} cx=${d.dot.x} cy=${d.dot.y} r=${dotR} />`)}
        <rect ref=${miniViewRef} class="oc-mini-view oo-mini-view" />
      </svg>
    </div>
  </div>`;
}
