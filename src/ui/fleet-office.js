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
//   first, then work), no bubble covers a name tag, and the tags are compact (#2860; one that would touch another shows
//   on hover or focus only). "Hide paused and stopped" (per browser) leaves the sleepers out.
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
// - Carousel (#4010; offered with two or more stored offices, on the signed-in dashboard only): chosen offices, each
//   the full-size office in turn (not All offices' tiles), for a TV. One n/m button opens a scrollable checklist
//   (inline ticks wrapped the bar at ~10). The offices and the interval are kept per browser; playing starts on enter
//   and on reload. Space pauses, ← / → (and N / P, media keys) step; Pause and Next on the bar and in fullscreen.
//   Edit offices and Edit layout wait. A share link does not offer it.
import { assetUrl } from "/assets/asset-url.js";
import { html, useEffect, useLayoutEffect, useMemo, useRef, useState } from "/assets/app-html.js";
import { appStore } from "/assets/app-store.js";
import { t, lang, register } from "/assets/app-i18n.js";
import { identityOf } from "/assets/identity-color.js";
import { avatarOf, firstCharacter } from "/assets/instance-nav.js";
import { Icon } from "/assets/ui-icons.js";
import { nodeText, stateWords } from "./fleet-org.js";
import { hits, needle } from "./fleet-canvas-layout.js";
import { AUTO_ID, LOBBY, autoLayout, backingScale, coatOf, createFlights, customLayout, deskAt, desksOf, filterOk, lampOf, layoutOk, lightOf, membersOf,
  officePose, officeRooms, signOf, workOn } from "./fleet-office-model.js";
import { BUILT_IN_SKINS, CHAR_DEPTH, DEFAULT_PAL, PICTURE_SKINS, bubbleBox, pixelSkin, loadBuiltInSkin, loadPackSkin, modeOf, skinFor, tagBox, tagFootprint, withCharacters } from "./fleet-office-skin.js";
import { createRiders, facing, seatAt, vehicleAt } from "./fleet-office-vehicles.js";
import { CALLING, activeFurniture, bubbleAt, hiddenBy, bubbleRank, NIGHT, WANDER, createMail, createWalkers, isNight, linesFor, npcKey, personAt, placeBubbles, routeStaysInArea, thinBubbles, walkTargets, zonesLayout } from "./fleet-office-zones.js";
import { actsOk, createOfficeStore } from "./fleet-office-store.js";
import { badgeOf, fixedOf, mergeLevels } from "./fleet-office-levels.js";
import { OfficeCard, cardModel } from "./fleet-office-card.js";
import { PLAY, applySeatDrop, patLook, clampDropForArea, createHold, createSnackDrag, createSnacks, findSeatDropTarget, playAllowed, playOffForMotion, pruneReactions, reactionAt, scatterWords, seatDropTargets } from "./fleet-office-play.js";
import { POLL_MS } from "./fleet-traffic.js";
import { OfficeEditor, officeForSave } from "./fleet-office-editor.js";
import { LayoutEditor, handlesOf } from "./fleet-office-layout.js";
import { ShareButton } from "./office-share-dialog.js";
import { Dialog } from "/assets/ui-dialog.js";
import { DLG, boxColours, boxLayout, createDialogue, createFaces, drawBox, fitBox, messageOf, onBox, pickFront, portraitSrc, stageOf, talkOf, wrap } from "./fleet-office-dialogue.js";
import { applyOverrides, createClipClocks, fitNight, fitSeatFor, packMaxFps, snackLabel, stripBox, stripDurationMs } from "./fleet-office-pack.js";
import { ALL_ID, LOBBY_TILE, OV, createCrossFlights, cropToRooms, fromTile, inTile, labelAt, lobbyNodes, overviewOk, tileAt, tileBox, tileLayout, visibleTiles } from "./fleet-office-overview.js";
import { CAROUSEL_ID, INTERVALS, carouselHeld, carouselIdsOk, carouselKey, carouselOk, intervalOk, nextIndex, prevIndex } from "./fleet-office-carousel.js";
import { centreOn, gestureState, gestures, miniPoint, toScreen, toWorld, wheelFactor, zoomKey, zoomTo } from "./fleet-canvas-view.js";
import { OK_MAX, cardSpot, clampPan, desksK, minK, edgeMatte, edgeStrips, fitScene, layerScale, miniBox, miniFrame, openingView, pinchOffice, savedOf, stepK, viewFromSaved,
  wholeInView, zoomLabel, zoomOffice } from "./fleet-office-view.js";

register("orgo", {
  en: {
    display: "Display options", playMotionOff: "Off: your system asks for reduced motion",
    label: "Office: each team is a room and each instance a desk; General and the instances in no team are in the lobby. Drag to pan; the wheel, a pinch, + and − zoom, 0 fits, F is fullscreen.",
    office: "Office", allOffice: "Whole fleet", show: "Show", allTeams: "All teams", lobby: "Lobby (General, no team)", lobbyRoom: "Lobby",
    people: "People", peopleN: "People ({0})", findPerson: "Find a person", everyone: "Show everyone", nobody: "No one here matches this filter.",
    unseated: "{0} without a seat", skinUnknown: "Its style “{0}” is not available here: drawn as Desks.", closed: "Closed", desks: "Desks", tapAgain: "Tap again to open the chat",
    capWorking: "Typing away", capIdle: "Tea break", capPaused: "Asleep", capNeeds: "Calling for you", capAway: "Desk empty", capStarting: "Just arriving", capQueued: "Waiting to start",
    styleLabel: "Style", style_pixel: "Desks", style_studio: "Studio", style_cozy: "Cozy", style_guild: "Guild", style_school: "School", cozyNotice: "Add your skin", area_desks: "Work", area_lounge: "Lounge", area_alert: "Help desk", area_nap: "Nap corner",
    b_working: "On it.|Typing…|Almost there|In the zone|One more test", b_idle: "Tea time|Ready when you are|Stretching|Anything for me?",
    b_paused: "Zzz…|Back later", b_stopped: "Off duty|Zzz…", b_needs: "Need you!|A question for you|Over here!",
    b_crashed: "Ouch, crashed|Help!", b_stuck: "Hmm, stuck?|Still thinking…",
    options: "Office options", hideAsleep: "Hide paused and stopped", hideNames: "Hide names and levels", hideMini: "Hide the minimap", nightOn: "Bedtime (0–6): idle agents sleep", playOn: "Drag and pat", playStill: "Off while reduced motion is on", layoutIgnored: "Its saved layout does not fit this style: drawn as the style's own.",
    styleForAll: "The whole fleet's style, for everyone: every device and share link", styleHere: "The whole fleet's style in this browser",
    styleFailed: "The style was not saved for everyone ({0}).", styleBusy: "Too many changes. Try again in a minute.",
    fit: "Fit the office", overview: "Overview: click to move there", fullscreen: "Fullscreen", exitFullscreen: "Exit fullscreen",
    fill: "Fill", fillTitle: "Fill the panel (the scene's overflow is cropped; drag to see it)", zoomLevel: "Zoom {0}", view: "View", zoomIn: "Zoom in", zoomOut: "Zoom out", live: "Live",
    allOffices: "All offices", labelAll: "All offices: each office is a tile, drawn in its own style. Drag to pan; the wheel, a pinch, + and − zoom, 0 fits, F is fullscreen. Click a tile to open that office.",
    backAll: "← All offices",
    key: "Key", keyTitle: "What the items carried between desks are", keyLabel: "Carried between desks",
    keyTask: "Folder: a task", keySend: "Envelope: a message", keyReport: "Paper: a report", keyBroadcast: "Horn: a broadcast",
    tileLabel: "{0} ({1})", openOffice: "Open the office {0}", lobbyTile: "Lobby tile (in no office)", lobbyEveryone: "Everyone is in an office", overviewNoEdit: "Pick one office to edit offices or a layout",
    carousel: "Carousel…", labelCarousel: "Carousel: each chosen office fills the screen in turn. Space pauses; ← and → step; F is fullscreen.",
    carouselNoEdit: "Leave the carousel to edit offices or a layout", pause: "Pause", resume: "Play", next: "Next",
    playing: "Playing", paused: "Paused", interval: "Interval", intervalSec: "{0} s", intervalMin: "{0} min",
    officesInCarousel: "Offices in the carousel",
    officesCount: "Carousel {0}/{1} offices ▾", selectAll: "Select all", selectNone: "Select none",
    dialogue: "Dialogue", dialogueTitle: "When a person messages someone here, show their words and the reply in a box at the bottom (this browser only)",
    dlgOpenChat: "Open the agent’s chat in a new window", dlgWorking: "Working…", dlgSomeone: "Someone", dlgHeardShare: "Sent {0} a message.", dlgAnsweredShare: "Replied.", dlgFile: "(sent a file)", dlgSays: "{0}: {1}",
    dlgBox: "Dialogue: {0}. Click for their card, double-click for their chat.",
    zones: "Go to an area", zoneAll: "Whole office", zoneN: "{0} {1}",
    snacks: "Snacks", snackFeed: "Feed {0}", snackPlace: "Place here",
    snackArm: "{0}: drag onto someone to feed, or onto the floor to place; click to select",
  },
  "zh-TW": {
    display: "顯示選項", playMotionOff: "已關閉：系統開了「減少動態效果」",
    label: "辦公室：每個團隊是一間房間，每個 Agent 一張桌子；General 和未加入團隊的 Agent 在大廳。拖曳平移；滾輪、雙指、+ 和 − 縮放，0 顯示整個場景，F 切換全螢幕。",
    office: "辦公室", allOffice: "整個 fleet", show: "顯示", allTeams: "所有團隊", lobby: "大廳（General、未加入團隊）", lobbyRoom: "大廳",
    people: "成員", peopleN: "成員（{0}）", findPerson: "尋找成員", everyone: "顯示全部", nobody: "沒有符合這個篩選的成員。",
    unseated: "{0} 位沒有座位", skinUnknown: "這裡沒有它的風格「{0}」：以辦公桌顯示。", closed: "休息中", desks: "桌子", tapAgain: "再點一下開啟聊天",
    capWorking: "埋頭打字中", capIdle: "喝茶休息", capPaused: "睡著了", capNeeds: "在呼叫你", capAway: "空位", capStarting: "剛到座位", capQueued: "等待啟動",
    styleLabel: "風格", style_pixel: "辦公桌", style_studio: "工作室", style_cozy: "溫馨", style_guild: "冒險者公會", style_school: "學校", cozyNotice: "換上你的外觀包", area_desks: "工作區", area_lounge: "休息區", area_alert: "求救區", area_nap: "午睡角",
    b_working: "處理中|打字中…|快好了|專心中|再測一次", b_idle: "喝茶中|隨時可以開工|伸個懶腰|有事找我嗎？",
    b_paused: "Zzz…|晚點回來", b_stopped: "下班了|Zzz…", b_needs: "需要你！|有個問題|在這裡！",
    b_crashed: "糟糕，當掉了|救命！", b_stuck: "嗯，卡住了？|還在想…",
    options: "辦公室選項", hideAsleep: "隱藏暫停與停止的成員", hideNames: "隱藏名字和等級", hideMini: "隱藏小地圖", nightOn: "0–6 點就寢：閒著的人去睡", playOn: "拖曳與摸頭", playStill: "開啟「減少動態效果」時關閉", layoutIgnored: "它儲存的配置不適用這個風格：以風格本身的配置顯示。",
    styleForAll: "整個 fleet 的風格，所有人共用：每台裝置與分享連結都一樣", styleHere: "這個瀏覽器裡整個 fleet 的風格",
    styleFailed: "風格沒有替所有人儲存（{0}）。", styleBusy: "變更太頻繁，請一分鐘後再試。",
    fit: "顯示整個辦公室", overview: "總覽：點一下移到那裡", fullscreen: "全螢幕", exitFullscreen: "結束全螢幕",
    fill: "填滿", fillTitle: "填滿整個面板（超出的部分會被裁切，拖曳即可看到）", zoomLevel: "縮放 {0}", view: "檢視", zoomIn: "放大", zoomOut: "縮小", live: "即時",
    allOffices: "所有辦公室", labelAll: "所有辦公室：每間辦公室是一格，以它自己的風格顯示。拖曳平移；滾輪、雙指、+ 和 − 縮放，0 顯示全部，F 切換全螢幕。點一格即可開啟那間辦公室。",
    backAll: "← 返回全域",
    key: "圖例", keyTitle: "桌子之間傳遞的物品代表什麼", keyLabel: "桌子之間傳遞的物品",
    keyTask: "資料夾：任務", keySend: "信封：訊息", keyReport: "紙張：回報", keyBroadcast: "喇叭：廣播",
    tileLabel: "{0}（{1}）", openOffice: "開啟辦公室「{0}」", lobbyTile: "大廳格（不在任何辦公室）", lobbyEveryone: "每個成員都已在某間辦公室", overviewNoEdit: "請先選一間辦公室，再編輯辦公室或配置",
    carousel: "輪播…", labelCarousel: "輪播：每間勾選的辦公室輪流佔滿畫面。空白鍵暫停；← 與 → 切換；F 切換全螢幕。",
    carouselNoEdit: "請先離開輪播，再編輯辦公室或配置", pause: "暫停", resume: "播放", next: "下一間",
    playing: "播放中", paused: "已暫停", interval: "間隔", intervalSec: "{0} 秒", intervalMin: "{0} 分鐘",
    officesInCarousel: "輪播的辦公室",
    officesCount: "輪播 {0}/{1} 間 ▾", selectAll: "全選", selectNone: "全不選",
    dialogue: "對話框", dialogueTitle: "有人傳訊息給這裡的成員時，在下方的對話框顯示訊息與回覆（只限這個瀏覽器）",
    dlgOpenChat: "在新視窗開啟這個 Agent 的聊天", dlgWorking: "處理中…", dlgSomeone: "有人", dlgHeardShare: "傳了一則訊息給 {0}。", dlgAnsweredShare: "已回覆。", dlgFile: "（傳了一個檔案）", dlgSays: "{0}：{1}",
    dlgBox: "對話框：{0}。點一下看資料卡，點兩下開啟聊天。",
    zones: "移到區域", zoneAll: "總覽", zoneN: "{0} {1}",
    snacks: "零食", snackFeed: "餵給 {0}", snackPlace: "放在這裡",
    snackArm: "{0}：拖到成員身上餵食，或放到空地讓閒置成員過來搶；點一下可選取",
  },
});
const to = (k, ...v) => t(`orgo.${k}`, ...v);
/**
 * #4010 follow-up: the carousel's offices as one n/m button, not inline checkboxes (those wrap the bar at ~10).
 * Esc and a click outside close it; Select all / Select none sit above the scrollable list.
 */
function CarouselOffices({ stored, carIds, open, onOpen, onToggle, onAll, onNone }) {
  const wrap = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const doc = globalThis.document;
    const key = (e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onOpen(false); } };
    const press = (e) => { if (wrap.current && !wrap.current.contains(e.target)) onOpen(false); };
    doc?.addEventListener?.("keydown", key, true);
    doc?.addEventListener?.("pointerdown", press, true);
    return () => { doc?.removeEventListener?.("keydown", key, true); doc?.removeEventListener?.("pointerdown", press, true); };
  }, [open]);
  const n = carIds.length, m = stored.length;
  return html`<div class="oo-car-pick" ref=${wrap}>
    <button type="button" class="btn btn-sm oo-car-offices" aria-haspopup="true" aria-expanded=${open ? "true" : "false"}
      aria-label=${to("officesInCarousel")} onClick=${() => onOpen(!open)}>${to("officesCount", n, m)}</button>
    ${open ? html`<div class="oo-car-menu" role="group" aria-label=${to("officesInCarousel")}>
      <div class="oo-car-menu-acts">
        <button type="button" class="btn btn-sm oo-car-all" onClick=${onAll}>${to("selectAll")}</button>
        <button type="button" class="btn btn-sm oo-car-none" onClick=${onNone}>${to("selectNone")}</button>
      </div>
      <div class="oo-carousel-offices">${stored.map((o) => html`<label key=${o.id} class="check"><input type="checkbox" checked=${carIds.includes(o.id)}
        onChange=${() => onToggle(o.id)} /><span>${o.name}</span></label>`)}</div>
    </div>` : null}
  </div>`;
}
const CAPTION = { working: "capWorking", idle: "capIdle", paused: "capPaused", needs: "capNeeds", walk: "capIdle", away: "capAway" };
/** States whose pose is shared but whose words are their own (a queued instance is not asleep). */
const CAPTION_OF_STATE = { starting: "capStarting", queued: "capQueued" };
/** What a pose says in words (the tooltip, the desk list); `state`, when its words differ from its pose's. */
export const caption = (pose, state) => to(CAPTION_OF_STATE[state] || CAPTION[pose] || "capIdle");

/** M-3556: the most a dropdown starting at `top` may be tall to end `margin` px above `bottom` (never under `min`). */
export const popMaxHeight = (bottom, top, margin = 8, min = 96) => Math.max(min, Math.floor(bottom - top - margin));
const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
/** The device's ratio (CSS px → device px), kept sane. */
const deviceRatio = () => Math.max(0.5, Math.min(4, Number(globalThis.devicePixelRatio) || 1));
/** The stage's size before it is measured (a test's page has none). */
const SIZE0 = { w: 960, h: 600 };
/** #2554: All offices' Fit keeps this many CSS px clear round the tiles (the zoom controls' column and a margin). */
const FIT_PAD = 60;
/** #2860: how far below its place a crowded area's compact tag drops when a neighbour's is in the way (a tag's height + 1). */
const COMPACT_ROW = 12;
/** M-3539: how far below its place a full name tag drops when another tag or an area's name is in the way (a tag's height + 2). */
const TAG_ROW = 16;
/** M-3539: the controls drawn over the scene that name tags keep clear of: the zoom stack, the minimap, and the phone's zone chips where they float over it. */
const KEEP_CLEAR = ".oo-zoom, .oo-mini, .oo-stage > .oo-zone-pills";
/** M-3539: those controls' boxes in the scene's logical units at the view `v` ({ k, x, y }: CSS px a unit, the origin), 4 CSS px round each. */
export function keepClearOf(cv, v) {
  const root = cv && typeof cv.closest === "function" ? cv.closest(".oo") : null;
  if (!root || typeof cv.getBoundingClientRect !== "function" || !(v.k > 0)) return [];
  const c = cv.getBoundingClientRect(), out = [];
  for (const el of root.querySelectorAll(KEEP_CLEAR)) {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height || r.right <= c.left || r.left >= c.right || r.bottom <= c.top || r.top >= c.bottom) continue;
    out.push({ x: (r.left - c.left - 4 - v.x) / v.k, y: (r.top - c.top - 4 - v.y) / v.k, w: (r.width + 8) / v.k, h: (r.height + 8) / v.k });
  }
  return out;
}
/** Whether two boxes ({ x, y, w, h }) overlap. */
const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
/** M-3539: the box a person's figure covers where they are now (the skin's own, else the built-in figure's). */
const figureBox = (sk, q) => (sk.charBox ? sk.charBox(q.look, q.at) : { x: q.at.x - 24, y: q.at.y - 52, w: 48, h: 66 });
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
/** M-3633: the corner of an area its name takes (logical units, from the area's top left): a floating card keeps off it. */
const AREA_LABEL = { w: 320, h: 44 };
/**
 * M-3253 (Argon's phone review): the Office's phone layout — a phone's width (the shell's), or a phone turned sideways (a
 * coarse pointer in a short window: an iPhone's 956 × 440 is wider than 899 px). There the Office's tools are one ⋯ sheet,
 * zone pills jump to a readable zoom, a tap near a person picks them, and their card is a bottom sheet.
 */
export const OFFICE_PHONE_Q = "(max-width: 899px), (pointer: coarse) and (max-height: 500px) and (max-width: 1023px)";
export function useOfficePhone() {
  const read = () => { try { return typeof matchMedia === "function" && matchMedia(OFFICE_PHONE_Q).matches; } catch { return false; } };
  const [on, setOn] = useState(read);
  useEffect(() => {
    if (typeof matchMedia !== "function") return undefined;
    const mq = matchMedia(OFFICE_PHONE_Q), changed = () => setOn(!!mq.matches);
    changed(); mq.addEventListener?.("change", changed);
    return () => mq.removeEventListener?.("change", changed);
  }, []);
  return on;
}
/** M-3253: a tap this many CSS px from a person (a fingertip's 44 px across) picks them when nobody is right under it. */
export const TAP_R = 22;
/** M-3253: a zone pill's zoom (CSS px a logical unit): the name tags at their own size. */
export const ZONE_K = 1;
/** M-3253: of `list` ({ x, y } in logical units), the one nearest (x, y) within `r` logical units, or null. */
export function nearestPerson(list, x, y, r) {
  let best = null, bestD = r * r;
  for (const it of list) { const d = (it.x - x) ** 2 + (it.y - y) ** 2; if (d <= bestD) { bestD = d; best = it; } }
  return best;
}
/** How often the picture can change when nothing is in the air (the poses loop at 4 fps; a bubble types faster). */
const FPS = 12;
/** At most this many frames a second while anyone walks or anything moves. */
const AIR_FPS = 30;
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
      badge: badge(n.name), fit: n.i && n.i.tag_fit && typeof n.i.tag_fit === "object" ? n.i.tag_fit : null }];
  }));
}
/**
 * #4466: whoever's card is open (`carded`, the page's cardDesk) stands where they are now: `to` gets their place. Not
 * while carried (the hold sets that), and not while calling (#4467 review: a caller walks to the Help desk as usual).
 */
export function cardStay(to, carded, held, walkers, t) {
  if (!carded || !carded.walks || CALLING.has(carded.state) || (held && held.name === carded.name)) return;
  const at = walkers.at(carded.name, t);
  if (at) to.set(carded.name, { x: at.x, y: at.y });
}
/** `view` (buildOrgView's) with each renamed person's nickname set to the name this browser gives them. */
export function renamedView(view, renames) {
  if (!view || !renames || !Object.keys(renames).length) return view;
  const one = (n) => (n && n.i && Object.prototype.hasOwnProperty.call(renames, n.name) ? { ...n, i: { ...n.i, display_name: renames[n.name] } } : n);
  return { ...view, top: (view.top || []).map(one), teams: (view.teams || []).map((t) => ({ ...t, nodes: (t.nodes || []).map(one) })),
    rest: view.rest ? { ...view.rest, nodes: (view.rest.nodes || []).map(one) } : view.rest };
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
  const ws = looks.map((l) => tagBox(ctx, x, y, l.label, false, l.fit).w), total = ws.reduce((a, w) => a + w, 0) + TAG_GAP * Math.max(0, ws.length - 1);
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
/** M-3533 R2c: how far inside its area's top edge a room character's speech bubble stays (scene units). */
const BUBBLE_IN_AREA = 8;
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
/**
 * Whether an agent's ride (office_set `ride`) holds now: set and not past its end, the person neither asleep nor calling
 * (#4415: nothing keeps a caller from the Help desk; the ride resumes when the call is over). Working or a new turn do
 * not end it (it is where they choose to be); clearing it, a new office_set or its end do.
 */
export const rideLive = (a, state, at = Date.now()) => !!a && !!a.ride && at < a.until && !ASLEEP.has(state) && !CALLING.has(state);
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
  // Zones: the pack's foreground, painted once at the layer's scale (it was drawn from the full picture every frame).
  const front = zones ? (skin.pack && skin.pack.foreground && skin.drawForeground ? layer((g) => skin.drawForeground(g, L, env)) : null) : layer((g) => {
    for (const d of all) { const lk = looks.get(d.key); skin.drawDeskFront(g, d, !tagsOff || !lk || lk.match ? lk : tagsOff === "names" && CALLING.has(lk.state) ? { ...lk, badge: null } : { ...lk, notag: true }, env); }
  });
  return { ls, tagsOff, back, front };
}
/** Final painted bubbles, topmost first; touch adds a 44 CSS-pixel target without changing the drawing. */
export function officeBubbleAt(hits, x, y, minSize = 0) {
  const reversed = [...hits].reverse();
  const exact = reversed.find(({ box: b }) => x >= b.x && y >= b.y && x <= b.x + b.w && y <= b.y + b.h);
  if (exact || !minSize) return exact || null;
  let nearest = null, distance = Infinity;
  for (const hit of reversed) {
    const b = hit.box, dx = x - b.x - b.w / 2, dy = y - b.y - b.h / 2;
    if (Math.abs(dx) <= Math.max(minSize, b.w) / 2 && Math.abs(dy) <= Math.max(minSize, b.h) / 2 && dx * dx + dy * dy < distance) {
      nearest = hit; distance = dx * dx + dy * dy;
    }
  }
  return nearest;
}
/**
 * One frame of a scene at `ms` (0: still), a logical unit `a` bitmap px, its origin at (ox, oy); `hot`: the desk key
 * hovered (its name tag shows even in a crowd); `tagsOff` (#2554: a tile too small to read them): the name tags show
 * only for the one hovered and the Find box's matches. Whether anything in it is moving (in the air, or someone walking).
 */
export function drawPart(ctx, p, a, ox, oy, ms, still, hot, env, tagsOff = false, defer = null, bubbleHits = null) {
  const sk = p.skin;
  const ls = layerScale(a, p.L.width, p.L.height);
  // Zones zoomed in past the layers' budget (a big pack): the layer would be coarser than the screen and the picture,
  // so the background and foreground are drawn from their pictures instead (only the part on screen is rasterised).
  const direct = !!p.zones && ls < a - 1e-6;
  if (!direct && (!p.layers || p.layers.ls !== ls || p.layers.tagsOff !== tagsOff)) p.layers = paintLayers(p, env, ls, tagsOff);
  const T = () => ctx.setTransform(a, 0, 0, a, ox, oy);
  const blit = (c) => { if (!c) return; ctx.setTransform(a / ls, 0, 0, a / ls, ox, oy); ctx.drawImage(c, 0, 0); T(); };
  if (direct) { T(); ctx.fillStyle = env.pal.bg; ctx.fillRect(0, 0, p.L.width, p.L.height); sk.drawBackground(ctx, p.L, env); }
  else blit(p.layers.back);
  T();
  const speakers = [], tags = [], titleBoxes = [];             // M-3539: the area names bubbles keep off too
  const titleDraws = [];                                         // M-3722: and redrawn over a bubble's tail that crosses one
  const up = still ? [] : p.flights.frame(ms, p.L);
  // Mail from another office (#2564): flying in at the door, or on the floor until its person picks it up.
  const post = still || !p.mail || !p.zones ? [] : p.mail.frame(ms > 0 ? ms : now(), p.L, p.walkers);
  let walking = false, carsOn = false;
  if (p.zones) {
    // Furniture under the people; the people (nearest last) with the furniture whose depth is "y" among them, by base
    // y (a tie: the item first, the person in front); furniture over them; things in the air; the pack's foreground
    // (door frames, pillars, table fronts); then what must stay readable: crowd counts and name tags (bubbles below).
    const t = ms > 0 ? ms : now(), live = furnitureAt(p, t);
    const draggedHeld = p.hold ? p.hold.held() : null;
    const heldName = draggedHeld ? draggedHeld.name : null;
    if (!still && ms > 0 && p.snacks) {
      const snackHidden = heldName ? new Map(live.hidden).set(heldName, "__held__") : live.hidden;
      const changed = p.snacks.step(t, {
        desks: p.desks, walkers: p.walkers, hidden: snackHidden, ownArea: !!p.ownArea,
        areas: p.L.areas, graph: p.L, snacksById: p.snacksById,
        charEatOf: (n) => (sk.eatStrip ? sk.eatStrip(n) : null),
        onClaim: p.onSnackClaim,
      });
      if (changed && typeof p.onSnacksChanged === "function") p.onSnacksChanged();
    }
    // Off screen (the canvas in logical units, with room for the tallest sprite and its bubble): not drawn.
    const cw = ctx.canvas && ctx.canvas.width, chh = ctx.canvas && ctx.canvas.height, M = 320;
    const offView = cw ? (at) => at.x < -ox / a - M || at.x > (cw - ox) / a + M || at.y < -oy / a - M / 4 || at.y > (chh - oy) / a + M : () => false;
    const people = p.desks.map((d) => {
      const at = p.walkers.at(d.node.name, t) || { ...d.seat, walking: false };
      if (at.walking) walking = true;
      return { d, at, look: p.looks.get(d.key) };
    }).sort((x, y) => x.at.y - y.at.y);
    const furniture = strollFurniture(p.night ? nightFurniture(sk.pack.furniture) : sk.pack.furniture, (k) => p.walkers.at(k, t));
    if (furniture.some((f) => f.walking)) walking = true;
    const placedSnacks = p.snacks ? p.snacks.placedList() : [];
    const wall = Date.now(), cars = (sk.pack.vehicles || []).map((v) => ({ v, at: vehicleAt(v, wall) }));
    carsOn = cars.length > 0;
    const band = [...furniture.filter((f) => f.depth === "y").map((f) => ({ y: f.y, k: 0, f })),
      ...cars.map((c) => ({ y: c.at.y, k: 0.8, car: c })),
      ...cars.map((c) => ({ y: Math.max(c.at.y, ...people.filter((q) => q.at.riding && p.riding && (p.riding(q.look.name) || {}).vehicle === c.v.id).map((q) => q.at.y)), k: 1.5, front: c })),
      ...placedSnacks.map((sn) => ({ y: sn.y, k: 0.5, sn })),
      ...people.map((q) => ({ y: q.at.y, k: 1, p: q })),
      ...(p.ghosts ? ghostsOf(sk.pack, people).map((g) => ({ y: g.y, k: 1, g })) : []),
      // #2665: by day, each item's night place too (at night the items are there already).
      ...(p.ghosts && !p.night ? nightGhostsOf(sk.pack).map((n) => ({ y: n.y, k: 1, n })) : [])]
      .sort((x, y) => x.y - y.y || x.k - y.k);
    // M-3432 (#4255) & M-3445 (#4266): draw drop-target rings above the floor layer only, never over furniture or characters.
    const drop = p.snackDrop && p.snackDrop.current;
    if (drop && drop.kind === "place") {
      ctx.save();
      ctx.fillStyle = "rgba(0, 0, 0, 0.16)";
      ctx.beginPath(); ctx.ellipse(drop.x, drop.y, 16, 7, 0, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = env.pal.accent; ctx.lineWidth = 1.5; ctx.setLineDash([4, 3]);
      ctx.beginPath(); ctx.ellipse(drop.x, drop.y, 16, 7, 0, 0, Math.PI * 2); ctx.stroke();
      ctx.restore();
    } else if (drop && drop.kind === "feed") {
      const target = people.find((q) => q.look.name === drop.name && !live.hidden.has(q.look.name));
      if (target) {
        ctx.save();
        ctx.fillStyle = env.pal.accentDim;
        ctx.beginPath(); ctx.ellipse(target.at.x, target.at.y, 24, 10, 0, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = env.pal.accent; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.ellipse(target.at.x, target.at.y, 24, 10, 0, 0, Math.PI * 2); ctx.stroke();
        ctx.restore();
      }
    }
    const seatDrop = heldName && p.seatDrop ? p.seatDrop.current : null;
    if (seatDrop && seatDrop.name === heldName && Array.isArray(seatDrop.targets)) {
      for (const st of seatDrop.targets) {
        if (st.current) continue;
        const isHover = !!seatDrop.hover && seatDrop.hover.area === st.area && seatDrop.hover.slot === st.slot;
        ctx.save();
        if (isHover) {
          ctx.fillStyle = env.pal.accentDim;
          ctx.beginPath(); ctx.ellipse(st.x, st.y, 26, 11, 0, 0, Math.PI * 2); ctx.fill();
          ctx.strokeStyle = "rgba(0, 0, 0, 0.38)"; ctx.lineWidth = 4.5;
          ctx.beginPath(); ctx.ellipse(st.x, st.y, 26, 11, 0, 0, Math.PI * 2); ctx.stroke();
          ctx.strokeStyle = env.pal.accent; ctx.lineWidth = 2.5;
          ctx.beginPath(); ctx.ellipse(st.x, st.y, 26, 11, 0, 0, Math.PI * 2); ctx.stroke();
        } else {
          ctx.globalAlpha = 0.9;
          ctx.fillStyle = env.pal.accentDim;
          ctx.beginPath(); ctx.ellipse(st.x, st.y, 22, 10, 0, 0, Math.PI * 2); ctx.fill();
          ctx.strokeStyle = "rgba(0, 0, 0, 0.35)"; ctx.lineWidth = 3.5;
          ctx.beginPath(); ctx.ellipse(st.x, st.y, 22, 10, 0, 0, Math.PI * 2); ctx.stroke();
          ctx.strokeStyle = env.pal.accent; ctx.lineWidth = 2; ctx.setLineDash([5, 3]);
          ctx.beginPath(); ctx.ellipse(st.x, st.y, 22, 10, 0, 0, Math.PI * 2); ctx.stroke();
        }
        ctx.restore();
      }
    }
    for (const f of furniture) if (f.depth !== "y" && f.depth < CHAR_DEPTH) sk.drawFurniture(ctx, f, f.asleep || live.active.has(f.id), ms, env);
    for (const it of post) if (it.t === 0) sk.drawProp(ctx, it, ms, env);        // a letter on the floor: under the people
    let heldPerson = null;
    for (const { f, p: q, g, n, sn, car, front } of band) {
      if (car) { if (sk.drawVehicle) sk.drawVehicle(ctx, car.v, car.at, ms, env); continue; }
      if (front) { if (sk.drawVehicleFront) sk.drawVehicleFront(ctx, front.v, front.at, ms, env); continue; }
      if (f) { sk.drawFurniture(ctx, f, f.asleep || live.active.has(f.id), ms, env); continue; }
      if (sn) {
        const sdef = p.snacksById && p.snacksById.get(sn.snackId);
        if (sdef && sk.drawSnack) {
          ctx.save();
          ctx.fillStyle = "rgba(0, 0, 0, 0.22)";
          ctx.beginPath(); ctx.ellipse(sn.x, sn.y + 1, Math.max(8, Math.round(sdef.sprite.dw * 0.38)), 4, 0, 0, Math.PI * 2); ctx.fill();
          ctx.restore();
          sk.drawSnack(ctx, sdef.sprite, ms, sn.x, sn.y, env, `sn:${sn.id}`);
        }
        continue;
      }
      if (n) { ctx.save(); ctx.globalAlpha = GHOST_ALPHA; sk.drawFurniture(ctx, n, true, 0, env); ctx.restore(); continue; }
      if (g) { ctx.save(); ctx.globalAlpha = GHOST_ALPHA; sk.drawCharacter(ctx, { x: g.x - 44, y: g.y - 53, w: 88, h: 53, seat: g }, g.look, 0, env); ctx.restore(); continue; }
      if (heldName && q.look.name === heldName) { heldPerson = q; continue; }  // M-3445 (#4267): drawn lifted on top below
      if (live.hidden.has(q.look.name)) continue;                          // #2698: drawn as the item (never while walking)
      if (offView(q.at)) continue;
      const box = { ...q.d, x: q.at.x - 44, y: q.at.y - 53, w: 88, h: 53, seat: { x: q.at.x, y: q.at.y } };
      // An agent's own pose (office_set, #2578) while its act lasts and nothing calls it; walking is walking; M-3432: eating when fed.
      const posed = actPosed(p, q.look);
      const eating = !q.at.walking && p.snacks && ms > 0 ? p.snacks.eatingOf(q.look.name, t) : null;
      const canEat = !!eating && !CALLING.has(q.look.state) && !ASLEEP.has(q.look.state) && !q.look.night;
      // A pat shows the set's `pat` strip for one full pass of it (pat.until), each pat from frame 0; a set without one keeps its pose.
      const canPat = !q.at.walking && !canEat && ms > 0 && !!p.reacts && !CALLING.has(q.look.state) && !ASLEEP.has(q.look.state) && !q.look.night;
      const patted = canPat ? patLook(posed, p.reacts.get(q.look.name), t) : null;
      const look = q.at.walking ? { ...q.look, pose: "walk", heading: q.at.heading }
        : canEat ? { ...posed, pose: "eat", basePose: posed.pose }
        : patted || posed;
      sk.drawCharacter(ctx, box, look, ms, env);
      if (canEat && eating.snackId && p.snacksById && sk.drawSnack) {
        const sdef = p.snacksById.get(eating.snackId);
        if (sdef && sdef.eat) sk.drawSnack(ctx, sdef.eat, Math.max(0, t - eating.t0), q.at.x, q.at.y, env);
      }
      if (!q.at.walking || (p.snacks && ms > 0 && p.snacks.scatterOf(q.look.name, t))) {
        speakers.push({ look: q.look, ...speakerAt(sk, look, q.at), area: q.d.area });
      }
    }
    for (const f of furniture) if (f.depth !== "y" && f.depth >= CHAR_DEPTH) sk.drawFurniture(ctx, f, f.asleep || live.active.has(f.id), ms, env);
    // M-3445 (#4267): the character currently being dragged renders lifted above furniture and other characters in its `dragged` pose.
    if (heldPerson) {
      const box = { ...heldPerson.d, x: heldPerson.at.x - 44, y: heldPerson.at.y - 53, w: 88, h: 53, seat: { x: heldPerson.at.x, y: heldPerson.at.y } };
      const posed = actPosed(p, heldPerson.look);
      sk.drawCharacter(ctx, box, { ...posed, pose: "dragged", basePose: posed.pose }, ms, env);
    }
    for (const it of up) sk.drawProp(ctx, it, ms, env);
    for (const it of post) if (it.t > 0) sk.drawProp(ctx, it, ms, env);
    if (direct) { if (sk.pack && sk.pack.foreground && sk.drawForeground) sk.drawForeground(ctx, p.L, env); }
    else if (p.layers.front) blit(p.layers.front);
    // Who found no spot in an area: a count in its corner (never over its name).
    for (const [ar, n] of p.L.crowd || []) if (p.L.areas[ar] && sk.drawCrowd) sk.drawCrowd(ctx, p.L.areas[ar], n, env);
    // M-3539: an area's name a figure stands on is written again over the people (休息區 under a crowd's heads).
    const titles = sk.areaTitleBox ? Object.values(p.L.areas || {}).map((ar) => ({ ar, box: sk.areaTitleBox(ctx, ar, env) })) : [];
    if (sk.drawAreaTitle) for (const { ar, box } of titles) {
      if (people.some((q) => !live.hidden.has(q.look.name) && overlaps(figureBox(sk, q), box))) sk.drawAreaTitle(ctx, ar, env);
    }
    // Name tags never cover each other, an area's name or what the page keeps clear over the scene (`env.keepClear`:
    // the zoom control, M-3539). In an area over capacity (#2513: a crowd's full tags covered each other) everyone keeps
    // a compact tag (#2860: in Cozy, the default, most of a fleet is in a crowd, and hover-only hid names and levels).
    // The full tags go first: the one hovered or found, then the people at their place, then those walking (a stroll
    // passes others' tags, M-3539); each where it is, else a row lower, else compact (there, then a row lower); one
    // that fits nowhere is left to hover or focus. Then an item's own name and the row it carries; then the crowd's.
    const over = p.L.over || new Set();
    const pinned = (q) => q.d.key === hot || !!q.look.match;
    const crowded = (q) => over.has(q.d.area) && !pinned(q);
    // A caller keeps their tag with names hidden (#4467 review): the Help desk always says who needs you.
    const tagged = (q) => pinned(q) || (tagsOff === "names" && CALLING.has(q.look.state)) || !(tagsOff || over.has(q.d.area));
    // Names hidden: a caller's tag is their name only; the level stays hidden (the one hovered or found keeps it).
    const tagLook = (q) => (tagsOff === "names" && !pinned(q) && q.look.badge ? { ...q.look, badge: null } : q.look);
    const keep = [...titles.map((x) => x.box), ...(env.keepClear || [])];
    titleBoxes.push(...titles.map((x) => x.box)); titleDraws.push(...titles);
    const taken = [];
    const touches = (b) => taken.some((o) => overlaps(b, o)) || keep.some((o) => overlaps(b, o));
    // Under an open card (`p.cover`, bitmap px; #4379 review): no tag, its level badge included, rather than a piece of one
    // past the card's edge — a forced one (hovered, found) too.
    const cv = p.cover ? { x: (p.cover.x - ox) / a, y: (p.cover.y - oy) / a, w: p.cover.w / a, h: p.cover.h / a } : null;
    const covered = (b) => !!cv && overlaps(b, cv);
    /**
     * Draws `look`'s tag at (x, y) at the first of `tries` ([dy, compact]) clear of the others; `force`: at the first.
     * None clear: slid sideways just past what it would touch of `keep` (an area's name, the minimap: never another
     * tag), at most its own width, at its place — so a name beside the minimap reads instead of going (leader's check).
     */
    const place = (x0, y, look, tries, force = false) => {
      // M-3539: a tag stays within the sides of the area its person stands in (a wide name at a lounge's first column
      // poked past its edge): moved in by what it would stick out.
      const ar = Object.values(p.L.areas || {}).find((a) => a.rect && x0 >= a.rect.x && x0 <= a.rect.x + a.rect.w && y >= a.rect.y && y <= a.rect.y + a.rect.h);
      const w0 = tagBox(ctx, x0, y, look.label, false, look.fit).w, x = !ar ? x0 : Math.min(Math.max(x0, ar.rect.x + 2 + w0 / 2), ar.rect.x + ar.rect.w - 2 - w0 / 2);
      const at = (dx, dy, compact) => {
        const box = tagBox(ctx, x + dx, y + dy, look.label, compact, look.fit), foot = tagFootprint(ctx, box, look.badge, compact);
        if (covered(foot)) return null;
        if (!force && touches(foot)) return null;
        // Every place tried keeps within the area's sides, a slide's too (#4376 review): none there, hover or focus.
        if (!force && ar && (box.x < ar.rect.x || box.x + box.w > ar.rect.x + ar.rect.w)) return null;
        sk.drawTag(ctx, x + dx, y + dy, look, env, compact);
        tags.push(box); taken.push(foot);
        return box;
      };
      for (const [dy, compact] of tries) { const b = at(0, dy, compact); if (b) return b; }
      const [dy0, c0] = tries[0], b0 = tagFootprint(ctx, tagBox(ctx, x, y + dy0, look.label, c0, look.fit), look.badge, c0);
      for (const o of keep.filter((k) => overlaps(b0, k))) {
        for (const dx of [o.x - (b0.x + b0.w) - 2, o.x + o.w - b0.x + 2]) if (Math.abs(dx) <= b0.w) { const b = at(dx, dy0, c0); if (b) return b; }
      }
      return null;
    };
    const FULL_TRIES = [[0, false], [TAG_ROW, false], [0, true], [COMPACT_ROW, true]];
    const tagOrder = people.filter((q) => !(live.hidden.has(q.look.name) && q.look.name !== heldName) && tagged(q))
      .map((q, i) => ({ q, i, rank: pinned(q) ? 0 : q.at.walking ? 2 : 1 })).sort((x, y) => x.rank - y.rank || x.i - y.i);
    for (const { q, rank } of tagOrder) place(q.at.x, q.at.y, tagLook(q), FULL_TRIES, rank === 0);
    // A furniture item's own name (#2574: an NPC drawn as furniture), tagged like a person; none on a tile too small to read.
    // #2698: an item hiding its people carries their tags too, in one row at its tag point (its own first; each keeps
    // its place in the row while another's tag is left out), and their bubbles, over its picture. The tags drawn are
    // kept on the scene (`heldTags`): hitPart hits each person on theirs, past the picture's edge too (#2699 review).
    const held = [];
    for (const f of furniture) {
      const on = people.filter((q) => live.hidden.get(q.look.name) === f.id && q.look.name !== heldName);
      if (!on.length) {
        if (!tagsOff && f.label) place(f.x, f.y, npcLook(p, f), [[0, false], [TAG_ROW, false]]);
        continue;
      }
      const order = new Map((f.activeFor || []).map((n, i) => [n, i]));
      on.sort((x, y) => (order.get(x.look.name) ?? 0) - (order.get(y.look.name) ?? 0));
      const row = tagRow(ctx, f.x, f.y, [...(f.label ? [npcLook(p, f)] : []), ...on.map(tagLook)]);
      const top = f.sprite ? Math.min(f.y - 50, stripBox(f.activeSprite || f.sprite, f.x, f.y).y + 2) : f.y - 50;
      for (const [i, r] of row.entries()) {
        const q = f.label ? on[i - 1] : on[i];
        if (q) speakers.push({ look: q.look, x: r.x + 10, y: top, area: q.d.area });
        if (q ? !tagged(q) : tagsOff) continue;
        // The row stays one row (each keeps its place): drawn there, covering nothing else's, or left to hover.
        const box = place(r.x, f.y, r.look, [[0, false]], !!q && pinned(q));
        if (q && box) held.push({ name: q.look.name, id: f.id, box });
      }
    }
    p.heldTags = held;
    // The crowd's compact tags go last, clear of every full tag above: people's, an item's own name and the row it
    // carries (#2862 review). A crowd's grid is tighter than a compact tag is wide (OVERFLOW.STEPS down to 32): a
    // neighbour's tag goes a row lower (COMPACT_ROW) rather than out, so a row of people reads as two staggered rows.
    if (!tagsOff) for (const q of people) {
      if (live.hidden.has(q.look.name) || !crowded(q)) continue;
      place(q.at.x, q.at.y, q.look, [[0, true], [COMPACT_ROW, true]]);
    }
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
  // M-3293: a pat or a feed — a few hearts rising over the head (the palette's danger red, the text font: no new art)
  // and their words in a bubble, while it lasts.
  const t0 = now(), reacting = ms && p.reacts && p.reacts.size && pruneReactions(p.reacts, t0) ? p.reacts : null;
  if (reacting) {
    ctx.save();
    ctx.fillStyle = env.pal.danger; ctx.font = "700 11px system-ui, sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "bottom";
    for (const sp of speakers) {
      const ra = reacting.has(sp.look.name) ? reactionAt(reacting.get(sp.look.name), t0, p.lang) : null;
      if (ra) for (const h of ra.hearts) { ctx.globalAlpha = h.alpha; ctx.fillText("♥", sp.x + h.dx, sp.y + h.dy); }
    }
    ctx.restore();
  }
  // Speech bubbles: a short line for the state, now and then (typed out; whole at once when still), placed so no two
  // overlap (placeBubbles; #2431).
  const bubbles = [], rp = p.reply, tSaid = Date.now(), replies = [];
  // M-3743: the part of the scene on screen (the canvas, in this part's units, 8 bitmap px in): a bubble stays inside it,
  // its tail still at the speaker (bubbleBox's `fit`; a speaker near an edge — a rider along the map's rim — had its
  // bubble cut off). All offices: the whole canvas too (the bubbles are drawn after every tile, unclipped).
  const cw = ctx.canvas && ctx.canvas.width, chh = ctx.canvas && ctx.canvas.height, edge = 8 / a;
  const fit = cw > 0 && chh > 0 ? { l: -ox / a + edge, r: (cw - ox) / a - edge, t: -oy / a + edge, b: (chh - oy) / a - edge } : null;
  for (let sp of speakers) {
    if (sp.look.dim || sp.look.pose === "away") continue;
    // Talk "Over their head": a live reply, in full (wrapped), in place of the state's line.
    const said = rp ? rp.chat.recent(sp.look.name, tSaid) : null;
    if (said) { replies.push({ sp, said }); continue; }
    const says = sp.look.night ? "paused" : sp.look.state;                // asleep at night: its "Zzz…" lines
    // What an agent says itself (office_set, #2578): whole, kept over the area's thinning like a call.
    const act = p.acts && p.acts.get(sp.look.name), ra = reacting && reacting.has(sp.look.name) ? reactionAt(reacting.get(sp.look.name), t0, p.lang) : null;
    // M-3293: a pat's or a feed's words first — the pack's own for it ("pat" / "feed" in its bubbles: theirs, their
    // set's, the pack's), one picked by when it happened, else the page's.
    const packSays = ra ? linesFor(reacting.get(sp.look.name).kind, p.lang, sk.pack, null, sp.look.name) : [];
    const raSays = ra ? (packSays.length ? packSays[Math.floor(reacting.get(sp.look.name).t0) % packSays.length] : ra.say) : null;
    const own = raSays ? raSays : actLive(act, says, Date.now(), p.actSeen) && act.say ? act.say : null;
    const sc = !own && p.snacks && ms > 0 ? p.snacks.scatterOf(sp.look.name, t0) : null;
    const scText = sc ? scatterWords(p.lang) : null;
    const b = own ? { text: own, shown: [...own].length }
      : scText ? { text: scText, shown: [...scText].length }
      : bubbleAt(sp.look.name, says, ms, linesFor(says, p.lang, sk.pack, p.lines, sp.look.name));   // #3681: theirs, their set's, the pack's
    // M-3533 R2c (Lumen): a room's own characters stand taller than the style's figures; their bubble stays inside the
    // area's box, as a figure's does (the Fleet's own office is unchanged).
    const ar = b && sk.ownCharacters && p.zones && sp.area != null ? p.L.areas && p.L.areas[sp.area] : null;
    if (ar && ar.rect) { const bx = bubbleBox(ctx, sp.x, sp.y, b.text, 0, false, fit), min = ar.rect.y + BUBBLE_IN_AREA; if (bx.y < min) sp = { ...sp, y: sp.y + (min - bx.y) }; }
    if (b) bubbles.push({ key: sp.look.name, area: sp.area, state: sp.look.state, calling: CALLING.has(sp.look.state), rank: own ? 0 : scText ? 1 : bubbleRank(sp.look.state), shown: b.shown, ...(raSays ? { keep: true } : {}),
      box: bubbleBox(ctx, sp.x, sp.y, b.text, 0, false, fit), ...(CALLING.has(sp.look.state) ? { flipBox: bubbleBox(ctx, sp.x, sp.y, b.text, 0, true, fit) } : {}), tail: { x: sp.x, y: sp.y }, sp, b,
      boxAt: ((at) => (dy, flip) => bubbleBox(ctx, at.x, at.y, b.text, -dy, flip, fit))(sp) });
  }
  // A crowded area speaks less (thinBubbles: calls, then work, a few at most); no bubble covers a name tag. `defer`
  // (All offices): drawn after every tile, unclipped, so a bubble at a tile's edge is whole.
  // M-3648: an area's name blocks chatter; a call may cover it (placeBubbles' `soft`): a name never keeps a call out.
  // M-3722: and 3 px of air off a name, not just its plate (a call beside 求救區 touched its corner). A number here, not an
  // import: a page still holding the older fleet-office-zones.js keeps linking (it just ignores it).
  const placed = placeBubbles(thinBubbles(bubbles, p.zones ? p.L.over : null), 22, tags, titleBoxes, 3);
  // M-3533 R2c: and after placing (which lifts a bubble clear of another), a room character's bubble still stays in its area.
  const inArea = (sp, text, dy, flip) => {
    const ar = sk.ownCharacters && p.zones && sp.area != null ? p.L.areas && p.L.areas[sp.area] : null;
    if (!ar || !ar.rect || !dy) return dy;
    const over = ar.rect.y + BUBBLE_IN_AREA - bubbleBox(ctx, sp.x, sp.y, text, -dy, flip, fit).y;
    return over > 0 ? Math.max(0, dy - over) : dy;
  };
  // The box a tail covers: the skin's own (from its foot to the speaker, M-3743), else the strip under the speaker (an older skin).
  const tailOf = (sp, box) => box.tail || (box.below ? { x: sp.x - 1, y: sp.y, w: 9, h: Math.max(0, box.y - sp.y) } : { x: sp.x - 1, y: box.y + box.h, w: 9, h: Math.max(0, sp.y - (box.y + box.h)) });
  // M-3743 (#4474 review): checked again where each is drawn (kept on screen, and in its area), in placing order: none over
  // another's box or tail, or a name tag. A page still holding an older fleet-office-zones.js places `box` moved by dy (it
  // knows no boxAt), and two boxes kept on screen could meet; with the current one this keeps every bubble it placed.
  const shown = [], held = [...tags];
  for (const it of placed) {
    const flip = it.flip || false, dy = inArea(it.sp, it.b.text, it.dy, flip), box = bubbleBox(ctx, it.sp.x, it.sp.y, it.b.text, -dy, flip, fit), tl = tailOf(it.sp, box);
    if (held.some((o) => overlaps(o, box) || overlaps(o, tl))) continue;
    held.push(box, tl); shown.push({ ...it, dy, flip });
  }
  const say = () => { T(); const tails = []; for (const { sp, b, dy, flip } of shown) {
    const text = [...b.text].slice(0, b.shown).join("");
    sk.drawBubble(ctx, sp.x, sp.y, text, env, -dy, flip, fit);
    if (text) tails.push(tailOf(sp, bubbleBox(ctx, sp.x, sp.y, text, -dy, flip, fit)));
    if (bubbleHits && text) {
      const box = bubbleBox(ctx, sp.x, sp.y, text, -dy, flip, fit);
      bubbleHits.push({ name: sp.look.name, box: { x: ox + box.x * a, y: oy + box.y * a, w: box.w * a, h: box.h * a } });
    }
  }
  // M-3722: a bubble keeps its box off an area's name (placeBubbles); a tail that still crosses one has the name written
  // again over it (as over a figure standing on it, M-3539), so the name always reads whole.
  if (sk.drawAreaTitle) for (const { ar, box } of titleDraws) if (tails.some((t) => overlaps(t, box))) sk.drawAreaTitle(ctx, ar, env);
  const bl = sk.pack && sk.pack.dialogBox ? sk.pack.dialogBox.bubble : null;
  const im = bl && bl.frame && typeof sk.picture === "function" ? sk.picture(bl.frame, () => {}) : null;
  for (const { sp, said } of replies) {
    // Typed out from its page's start, at the reading mode's pace; ▼ once whole; Auto / Fast: it goes on by itself.
    const cps = rp.pace(rp.read).cps, n = ms > 0 ? Math.floor(((tSaid - (said.pageAt ?? said.at)) * cps) / 1000) : Infinity;
    // #4406: never smaller than its own size on the page — zoomed out (a phone's whole office at 30 %), it is drawn at
    // 1 CSS px a unit about its tail, so the words stay readable; zoomed in, as the map.
    const u = Math.max(1, (rp.ratio || 1) / a);
    // And kept on screen: the canvas's visible width in this part's units, into the bubble's own (scaled about its tail).
    const vl = -ox / a, vr = ((ctx.canvas && ctx.canvas.width) || Infinity) / a - ox / a, m = 6 / u;
    const vt = -oy / a, vb = ((ctx.canvas && ctx.canvas.height) || Infinity) / a - oy / a;
    const fit = Number.isFinite(vr) ? { l: sp.x + (vl - sp.x) / u + m, r: sp.x + (vr - sp.x) / u - m,
      ...(Number.isFinite(vb) ? { t: sp.y + (vt - sp.y) / u + m, b: sp.y + (vb - sp.y) / u - m } : {}) } : null;
    ctx.save(); ctx.translate(sp.x, sp.y); ctx.scale(u, u); ctx.translate(-sp.x, -sp.y);
    const b0 = rp.draw(ctx, sp.x, sp.y, sp.look.label || sp.look.name, said.text, ms > 0 ? tSaid - said.at : 0, rp.style(bl, env), im ? { im, slice: bl.slice || 6, k: sk.pack.scale || 2 } : null,
      { page: said.page, n }, fit);
    ctx.restore();
    const box = { ...b0, x: sp.x + (b0.x - sp.x) * u, y: sp.y + (b0.y - sp.y) * u, w: b0.w * u, h: b0.h * u };
    said.pages = box.pages;
    if (n >= box.len && !said.whole) { said.whole = true; said.wholeAt = tSaid; }
    if (said.whole && tSaid - said.wholeAt >= rp.pace(rp.read, box.len).wait) rp.chat.advance(sp.look.name);
    if (bubbleHits) bubbleHits.push({ name: sp.look.name, reply: true, box: { x: ox + box.x * a, y: oy + box.y * a, w: box.w * a, h: box.h * a } });
  } };
  if (defer) defer.push(say); else say();
  return replies.length > 0 || carsOn || walking || up.length > 0 || p.flights.size() > 0 || post.some((it) => it.t > 0) || rising.length > 0 || !!reacting || (!!p.snacks && p.snacks.active(t0)) || !!(p.snackDrop && p.snackDrop.current) || !!(p.hold && p.hold.held());
}
/**
 * #2661: an NPC's name tag (a furniture item's label) — with the title a pack pins on it (`levels.fixed` by its id),
 * while levels are on: "label · title", and a mark for a badge (an NPC has no level). #3679: `p.levels` is the part's
 * words, the fleet's under its pack's (mergeLevels).
 */
function npcLook(p, f) {
  const fx = p.levelsOn ? fixedOf(f.id, p.levels !== undefined ? p.levels : p.skin.pack && p.skin.pack.levels) : null;
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

/** #2946: the key's rows — each kind's item as the scene draws it (the built-in prop, in the theme's colour), and its words. */
export const KEY_KINDS = [["task", "keyTask"], ["send", "keySend"], ["report", "keyReport"], ["broadcast", "keyBroadcast"]];
const KEY_PX = 32;
/**
 * #2946 (hxhsandy): the key to the items carried between desks — a strip under the Office's bar (never over the scene),
 * opened by its Key toggle. The shapes are drawn by the built-in skin, so they are the ones in the air, at their size.
 */
export function OfficeKey({ pal }) {
  const paint = (hue) => (cv) => {
    const g = cv && typeof cv.getContext === "function" ? cv.getContext("2d") : null;
    if (!g) return;
    const r = Math.max(1, Math.round(globalThis.devicePixelRatio || 1));
    if (cv.width !== KEY_PX * r) { cv.width = KEY_PX * r; cv.height = KEY_PX * r; }
    g.setTransform(r, 0, 0, r, 0, 0); g.clearRect(0, 0, KEY_PX, KEY_PX);
    try { pixelSkin.drawProp(g, { hue, kind: hue, x: KEY_PX / 2, y: KEY_PX / 2 + 4, t: 0 }, 0, { pal }); } catch { /* left blank */ }
  };
  return html`<div class="oo-key" role="region" aria-label=${to("keyLabel")}>
    <ul class="oo-key-rows">${KEY_KINDS.map(([hue, k]) => html`<li key=${hue} class="oo-key-row" data-kind=${hue}>
      <canvas class="oo-key-icon" width=${KEY_PX} height=${KEY_PX} aria-hidden="true" ref=${paint(hue)}></canvas><span>${to(k)}</span></li>`)}</ul>
  </div>`;
}

/**
 * The view: `view` buildOrgView's answer; `traffic` the live items (null: Live is off); `q` the Find box's needle;
 * `lease` the tab's (its reads); `onOpen(name)` what a desk opens (the canvas's: the chat; none: a desk opens nothing,
 * as on a share link's page, #2636); `assetUrl(path)` where a skin pack's picture is read (the share's address), and
 * `assetImage(url)` how (the share's, which waits out a 429, #2662; none: the loader's own);
 * `opening` the office it opens on (the share's), instead of the one this browser chose last; #2861: `talk` the share's
 * conversations (its /state's: who heard or answered a person, when — never what was said), instead of the stream's.
 * M-3533 R1, a Hub room's office (hub-room-office.js), on the Fleet dashboard's own origin too: `oneOffice` its one office
 * (no office picker or carousel); `readOnly` no editing or sharing whatever the session; `stream` false: never this
 * page's own stream (the fleet's offices, acts and skins); `storage` where this browser's choices are kept (not the
 * Fleet office's); `cardRows(name)` a card's rows instead of the office's (the room's: owner, introduction); `words(node)`
 * a person's state and activity in the page's own words ({ state, now }: the room's member list's), instead of the Fleet's;
 * `foldBar` (with `onMore`): no options row over the scene on a desk either — the options open in the sheet from a button
 * in the zoom stack (a Hub room's office: the scene right under the room's header, M-3533 #4370);
 * `cardAction(name)` a card's main action ({ label, title, run }: the room's "@ it"), or null; `cardName(name)` a card's
 * title instead of the person's name (the room's: the agent's own, without the owner its scene label carries); `officesKey` read the offices
 * again when it changes (a page with no stream: the room's office when an agent joins, leaves or is renamed); M-3533 R2b:
 * `cardPhoto(name)` the src of a card's identity-card picture (the room's), or null: the figure.
 */
function ensureDialogueStyle() {
  const doc = globalThis.document;
  if (!doc?.head || doc.querySelector('link[data-office-dialogue-css="1"]')) return;
  const link = doc.createElement("link"); link.rel = "stylesheet";
  link.href = assetUrl("/assets/office-dialogue.css");
  link.setAttribute("data-office-dialogue-css", "1"); doc.head.appendChild(link);
}
export function Office({ view: given, traffic, q = "", lease, onOpen, assetUrl, assetImage, opening, talk, chatUi = null, more = false, onMore = null, live = null, onLive = null,
  oneOffice = false, readOnly = false, stream = true, storage = undefined, cardRows = null, words = null, cardAction = null, cardName = null, officesKey = undefined, foldBar = false, cardPhoto = null, characters = null }) {
  // M-3253: on a phone the page above (fleet-canvas.js) puts a ⋯ in its bar: `more` is that sheet open, `onMore(open)`;
  // `live` / `onLive` its Live toggle, which moves into the sheet. Without one (a share link's page) the bar stays.
  useLayoutEffect(ensureDialogueStyle, []);
  const phone = useOfficePhone(), compact = phone && typeof onMore === "function", folded = compact || (foldBar && typeof onMore === "function");
  const store = useMemo(() => createOfficeStore({ ...(lease ? { fetch: (path, o) => lease.fetch(path, o) } : {}), ...(storage ? { storage } : {}) }), [lease, storage]);
  const streamOn = () => (stream === false ? null : appStore.get().streamOn);
  const stateOf = (node) => (words ? words(node).state : stateWords(node));
  const nowOf = (node) => (words ? words(node).now : caption(officePose(node.state), node.state));
  const [stored, setStored] = useState([]);
  const [storedRev, setStoredRev] = useState(null);                  // the rev the list was read at (a save sends it)
  const [canEdit, setCanEdit] = useState(false);                      // an admin session (never a guest or the public link)
  const [canShare, setCanShare] = useState(false);                    // #2636: an admin session, here or over the public link
  const [editing, setEditing] = useState(false);
  // Never picked here: All offices, the map of every office (one click enters one, unremembered; Back returns) — the
  // whole fleet while fewer than two are stored. A pick from the switcher is kept per device, as before.
  const [choice, setChoice] = useState(() => opening ?? store.choice(ALL_ID));
  const [filter, setFilter] = useState(() => store.filter());
  // #4010: the carousel's offices and interval (per browser); the slide index and playing are this visit only.
  const [carSaved, setCarSaved] = useState(() => store.carousel());
  const [carIndex, setCarIndex] = useState(0);
  const [carPlaying, setCarPlaying] = useState(true);
  const [carMenu, setCarMenu] = useState(false);
  // #2716: the whole-fleet office's style — the host's (for everyone) and this browser's own pick. An admin sees the
  // host's (their own pick only while the host keeps none) and picks for everyone; anyone else's own pick, else the host's.
  const [hostStyle, setHostStyle] = useState(undefined);            // undefined: not read yet; null: none kept
  // #3679: the fleet's own level titles (every office), or null; a style's pack `levels` win over them (wordsOf).
  const [fleetWords, setFleetWords] = useState(null);
  const wordsOf = useMemo(() => {
    const memo = new WeakMap(), none = mergeLevels(fleetWords, null);
    return (sk) => {
      const own = sk && sk.pack ? sk.pack.levels || null : null;
      if (!own) return none;
      if (!memo.has(own)) memo.set(own, mergeLevels(fleetWords, own));
      return memo.get(own);
    };
  }, [fleetWords]);
  const [ownStyle, setOwnStyle] = useState(() => store.skinChosen());
  const [styleErr, setStyleErr] = useState("");
  const style = canEdit ? hostStyle ?? ownStyle ?? "cozy" : ownStyle ?? hostStyle ?? "cozy";
  const [hideAsleep, setHideAsleep] = useState(() => store.hideAsleep());
  const [namesOff, setNamesOff] = useState(() => store.namesOff());
  const [miniOff, setMiniOff] = useState(() => store.miniOff());
  // The names this browser gives people: each node's nickname replaced here, so the tags, the card and the dialogue follow.
  const [renames, setRenames] = useState(() => store.renames());
  const view = useMemo(() => renamedView(given, renames), [given, renames]);
  // Bedtime (#2568), when it is on here: the idle sleep from NIGHT.FROM to NIGHT.TO on this device's clock (read every NIGHT.TICK).
  const [nightOn, setNightOn] = useState(() => store.nightOn());
  const [keyOpen, setKeyOpen] = useState(() => store.keyOpen());
  // #2861: the dialogue box, when it is on here (off by default: until then nothing below listens or draws). The
  // conversations; the avatars read for it; what it last said for a screen reader. `dlgRef`: what draw() reads (it runs
  // from the loop, outside a render); `dlgShown`: the box as last drawn (its clicks).
  const [dialogueOn, setDialogueOn] = useState(() => store.dialogueOn());
  // Talking from here (fleet-office-talk.js, `chatUi`: the dashboard's only, never a share link): how (per browser) and
  // to whom; `chat` the conversations every way shows.
  const [talkMode, setTalkMode] = useState(() => store.talkMode());
  const [talkTo, setTalkTo] = useState(null);
  const [readMode, setReadMode] = useState(() => (chatUi ? chatUi.readModeOf(store.talkRead()) : "click"));
  const chat = useMemo(() => (chatUi ? chatUi.createTalk() : null), [chatUi]);
  // #4406: the Dialogue-box talk shows the dialogue's conversations, so they run while it is picked — without ticking
  // Dialogue for the person (their own choice, kept as they left it when they pick another way to talk).
  const boxTalk = !!chat && talk === undefined && typeof onOpen === "function" && chatUi.talkModeOf(talkMode) === "box";
  const dlgOn = dialogueOn || boxTalk;
  const replyRef = useRef(null);
  const dlg = useMemo(createDialogue, []);
  const faces = useMemo(() => createFaces(), []);
  const [dlgSay, setDlgSay] = useState("");
  const [dlgVisible, setDlgVisible] = useState(false);
  const dlgVisibleRef = useRef(false);
  const showDialogueDock = (visible) => {
    if (dlgVisibleRef.current !== visible) { dlgVisibleRef.current = visible; setDlgVisible(visible); }
  };
  const dialogueCanvasRef = useRef(null);
  const [dlgHot, setDlgHot] = useState(false);
  const dlgRef = useRef(null), dlgShown = useRef(null), dlgLines = useRef(new Map()), talkSeen = useRef(new Set());
  const [nightNow, setNightNow] = useState(() => isNight());
  useEffect(() => { if (!nightOn) return undefined; setNightNow(isNight()); const h = setInterval(() => setNightNow(isNight()), NIGHT.TICK); return () => clearInterval(h); }, [nightOn]);
  const night = nightOn && nightNow;
  // M-3293: "Drag and pat" here (per device, on by default); in force only where playAllowed says (below).
  const [playOn, setPlayOn] = useState(() => store.playOn());
  const [, setTellRev] = useState(0);                                 // M-3293: the card's Tell box redrawn when ticked
  const [lobbyOn, setLobbyOn] = useState(() => store.lobbyTile());       // #2554: All offices' lobby tile
  const [packs, setPacks] = useState([]);                             // the skin packs the host keeps: [{ id, name, sha }]
  const [packSkins, setPackSkins] = useState(() => new Map());        // id@sha → a loaded skin, or null (not a pack)
  const [cozyRev, setCozyRev] = useState(0);                          // #2631/#2947: a built-in's picture came in (skinFor has it)
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
  // M-3633: how much of the stage a bottom-sheet card covers (px from its foot); the scene is kept in the rest.
  const sheetCover = useRef(0);
  const stageRef = useRef(null), canvasRef = useRef(null), tipRef = useRef(null), lastType = useRef("mouse");
  // Fullscreen: null, "native" (the Fullscreen API) or "immersive" (the CSS cover); per visit, never kept.
  const ooRef = useRef(null), [fs, setFs] = useState(null), fsRef = useRef(null), fsAsked = useRef(false), fsTarget = useRef(null);
  fsRef.current = fs;
  const flights = useMemo(() => createFlights(), []);
  const walkers = useMemo(() => createWalkers(), []);
  const riders = useMemo(() => createRiders(), []);
  const seatsRef = useRef(new Map());                                 // the zones layout's last seats: kept where they can be
  const seatPrefsRef = useRef({}), seatKeyRef = useRef(""), seatDropRef = useRef(null);
  const placedRef = useRef(null);                                    // M-3539: the office and style the walkers were last placed for
  // M-3539: the phone's zone chips scroll sideways when they do not fit (English); a fade at the side there is more
  // (data-more-left / data-more-right) says so.
  const pillsRef = useRef(null);
  const pillsCue = () => {
    const e = pillsRef.current;
    if (!e || typeof e.toggleAttribute !== "function") return;
    const more = e.scrollWidth - e.clientWidth;
    e.toggleAttribute("data-more-left", more > 1 && e.scrollLeft > 1);
    e.toggleAttribute("data-more-right", more > 1 && e.scrollLeft < more - 1);
  };
  useLayoutEffect(pillsCue);
  const [seatRev, setSeatRev] = useState(0);
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
    setFleetWords((was) => (JSON.stringify(was) === JSON.stringify(d.levels || null) ? was : d.levels || null));
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
    const sub = streamOn();
    const off = sub ? lease.hold(sub("offices", () => { void read(); })) : null;
    return () => { if (off) off(); };
  }, [lease, store, officesKey]);
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
    const sub = streamOn();
    const polled = () => globalThis.document?.body?.dataset?.webTransport === "poll" || appStore.get().connection === "polling";
    const offs = sub ? [lease.hold(sub("office_acts", (d) => { heard++; if (d && Array.isArray(d.acts)) setActs(actsOk(d.acts, d.now)); else void read(); })),
      lease.hold(sub("connection", (c) => { if (c === "live") void read(); }))] : [];
    const h = lease.interval(() => { if (polled() && !globalThis.document?.hidden) void read(); }, POLL_MS);
    return () => { for (const off of offs) off(); lease.clear(h); };
  }, [lease, store]);
  // #2861: the dialogue box's news. On the dashboard: the stream's `message` events (SSE, or the public link's poll) —
  // the same ones the chat gets, so only words this viewer can already read; a person's (role "user") opens a
  // conversation, the agent's reply (role "agent") answers it; a replay or a catch-up is not news (messageOf: FRESH_MS
  // on the server's clock, which the stream's `clock` events give). On a share: its `talk` (no words, no one named).
  const dlgWake = () => {
    const sc = scene.current;
    if (sc) sc.dirty = true;
    if (still) { if (sc && !globalThis.document?.hidden) draw(0); } else loop.current?.wake();
  };
  const sayFor = (instance, words) => {
    const who = dlgRef.current && dlgRef.current.who.get(instance);
    if (who) setDlgSay(to("dlgSays", ...words(who)));
  };
  useEffect(() => {
    if (!dlgOn || talk !== undefined) return undefined;
    const sub = streamOn();
    if (!sub) return undefined;
    let skew = 0;
    const seen = new Set();
    const take = (m) => {
      const x = messageOf(m, Date.now() + skew);
      if (!x) return;
      const k = `${x.instance}|${x.kind}|${m.ts}|${String(m.text ?? "").slice(0, 80)}`;
      if (seen.has(k)) return;
      seen.add(k);
      if (seen.size > 400) seen.delete(seen.values().next().value);
      const words = x.files ? to("dlgFile") : x.text;
      if (x.kind === "heard") { const c = dlg.heard(x.instance, x.person, words, now()); if (c) sayFor(x.instance, () => [x.person.name || to("dlgSomeone"), c.text]); }
      else { const c = dlg.answered(x.instance, words, now()); if (c) sayFor(x.instance, (who) => [nodeText(who.node).primary, c.reply]); }
      dlgWake();
    };
    const hold = (off) => (lease ? lease.hold(off) : off);
    const offs = [hold(sub("clock", (d) => { if (d && typeof d.now === "number") skew = d.now - Date.now(); })), hold(sub("message", take))];
    return () => { for (const off of offs) if (typeof off === "function") off(); };
  }, [dlgOn, lease, talk === undefined]);
  useEffect(() => {
    if (!dlgOn || !talk) return;
    let changed = false;
    for (const x of talkOf(talk)) {
      const k = `${x.instance}|${x.kind}|${x.at}`;
      if (talkSeen.current.has(k)) continue;
      talkSeen.current.add(k);
      if (talkSeen.current.size > 400) talkSeen.current.delete(talkSeen.current.values().next().value);
      const c = x.kind === "heard" ? dlg.heard(x.instance, null, null, now()) : dlg.answered(x.instance, null, now());
      if (!c) continue;
      changed = true;
      sayFor(x.instance, (who) => (x.kind === "heard" ? [to("dlgSomeone"), to("dlgHeardShare", nodeText(who.node).primary)] : [nodeText(who.node).primary, to("dlgAnsweredShare")]));
    }
    if (changed) dlgWake();
  }, [dlgOn, talk]);
  // What is over goes (an answer after its fade, a conversation never answered); the box is drawn again meanwhile.
  useEffect(() => {
    if (!dlgOn) return undefined;
    const h = setInterval(() => { if (dlg.sweep(now(), still, !!(dlgRef.current && dlgRef.current.vn)) || dlg.size()) dlgWake(); }, 1000);
    return () => clearInterval(h);
  }, [dlgOn]);
  const toggleDialogue = () => {
    const v = !dialogueOn;
    store.saveDialogueOn(v); setDialogueOn(v);
    if (!v) { dlg.clear(); setDlgSay(""); setDlgHot(false); }
    dlgWake();
  };
  // The skin packs: on opening, and again whenever the stream says one was uploaded or deleted.
  useEffect(() => {
    if (!lease) return undefined;
    const read = async () => { const d = await store.skins(); if (lease.current() && d) setPacks(d.packs); };
    void read();
    const sub = streamOn();
    const off = sub ? lease.hold(sub("office_skins", () => { void read(); })) : null;
    return () => { if (off) off(); };
  }, [lease, store]);
  // Whether this page may edit the offices: an admin session (the host asks again on every save), never a guest page or
  // the public link (whose sessions the host refuses outright). #2636 follow-up (the user's choice): Share… is an admin
  // session's here or over the public link (the host asks again too); never a guest's or a read-only one's.
  useEffect(() => {
    const body = globalThis.document?.body;
    if (readOnly || !body || body.dataset.tier === "guest") return undefined;
    let live = true;
    const auth = globalThis.AgendAuth;
    if (auth && typeof auth.canWrite === "function") Promise.resolve(auth.canWrite()).then((v) => { if (live) { setCanEdit(v === true); setCanShare(v === true); } }, () => {});
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
  // At most 2 px per CSS px: a 3x phone screen would paint 2.25x the pixels every frame for little visible gain.
  const ratio = backingScale(size.w, size.h, Math.min(2, dpr));

  // #2554: All offices — chosen, and at least two offices stored (else the whole fleet, as an office gone is).
  const overview = choice === ALL_ID && overviewOk(stored);
  // #4010: Carousel — chosen on the signed-in dashboard, at least two stored; the ticked list may be shorter (then
  // the one left is shown still, or the whole fleet with none). Playing starts on enter; the timer is a timeout so a
  // Next or an interval change resets it.
  const carouselPick = opening == null && choice === CAROUSEL_ID && carouselOk(stored);
  const carIds = carouselPick ? carouselIdsOk(carSaved ? carSaved.ids : null, stored) : [];
  const carousel = carouselPick && carIds.length >= 2;
  useEffect(() => { if (!carouselPick) setCarMenu(false); }, [carouselPick]);
  const slideId = carouselPick && carIds.length ? carIds[((carIndex % carIds.length) + carIds.length) % carIds.length] : null;
  const custom = slideId ? stored.find((o) => o.id === slideId) || null
    : (choice !== AUTO_ID && !overview ? stored.find((o) => o.id === choice) || null : null);
  const carouselAct = useRef({ on: false, act: () => {} });
  const stepCar = (dir) => { if (!carIds.length) return; setCarIndex((i) => (dir > 0 ? nextIndex(i, carIds.length) : prevIndex(i, carIds.length))); };
  carouselAct.current = { on: carousel, act: (kind) => { if (kind === "pause") setCarPlaying((p) => !p); else if (kind === "next") stepCar(1); else if (kind === "prev") stepCar(-1); } };
  useEffect(() => {
    if (!carousel || !carPlaying) return undefined;
    const ms = intervalOk(carSaved && carSaved.interval) * 1000;
    const t = setTimeout(() => stepCar(1), ms);
    return () => clearTimeout(t);
  }, [carousel, carPlaying, carSaved && carSaved.interval, carIndex, carIds.join("|")]);
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
  // #2631/#2947: a picture-backed built-in's picture (cozy, guild, school), once, when this office (or a tile, or the lobby
  // tile) is drawn in it and no kept pack has its id; until then its bare floors.
  const picturesWanted = [...new Set((overview ? [...stored.map((o) => o.skin), ...(lobbyOn ? [style] : [])] : [wanted])
    .filter((id) => PICTURE_SKINS.includes(id) && !packOf(id)))].sort().join(",");
  useEffect(() => {
    if (!picturesWanted) return undefined;
    let live = true;
    for (const id of picturesWanted.split(",")) loadBuiltInSkin(id).then((sk) => { if (live && sk) setCozyRev((n) => n + 1); });
    return () => { live = false; };
  }, [picturesWanted]);
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
  // M-3533 R2c: a Hub room office's agents in their own characters (`characters`: { sets, images }), over its style.
  const skin = useMemo(() => (characters ? withCharacters(placed.skin, characters.sets, characters.images) : placed.skin), [placed.skin, characters]);
  // While Edit layout is open: a faint figure on every seat, in the pose its area is for (#2558), so a seat is placed by
  // what will stand, sit or lie there, not by a dot.
  const ghosts = zones && !!layout && !layoutStale;
  const shared = talk !== undefined || typeof onOpen !== "function";
  const tmode = chat && !shared ? chatUi.talkModeOf(talkMode) : "window";
  useEffect(() => {
    if (!chat || tmode === "window") return undefined;
    const sub = appStore.get().streamOn, hold = (off) => (lease ? lease.hold(off) : off);
    const off = sub ? hold(sub("message", chat.take)) : null;
    const quiet = chat.subscribe(() => { if (still && scene.current) draw(0); else loop.current?.wake(); });
    return () => { if (typeof off === "function") off(); quiet(); };
  }, [chat, tmode, lease]);
  const pickTalkMode = (v) => {
    store.saveTalkMode(v); setTalkMode(v);
    if (v === "window") setTalkTo(null);
  };
  // What a view and per-device seat choices are kept for: the office and its style (All offices: its own key).
  const officeKey = overview ? `${ALL_ID}@tiles` : `${custom ? custom.id : AUTO_ID}@${baseSkin.id}`;
  const keep = (n) => !(hideAsleep && ASLEEP.has(n.state));
  const single = useMemo(() => {
    if (overview) return { rooms: [], width: 1, height: 1 };            // All offices: the tiles below
    const all = custom ? membersOf(custom, view) : [...new Map(officeRooms(view, filter).flatMap((r) => r.nodes).map((n) => [n.name, n])).values()];
    const nodes = all.filter(keep);
    if (zones) {
      const skKey = shared ? "" : officeKey;
      // M-3533 (#4370): the seats given restart when the office or its style changes — on a shared page too (a room's
      // office, a share link), whose per-device seat choices are not kept (skKey ""), so a style with more seats is not
      // drawn with the old one's overflow spots.
      if (seatKeyRef.current !== officeKey) {
        seatKeyRef.current = officeKey;
        seatsRef.current = new Map();
        seatPrefsRef.current = skKey ? store.seats(skKey) : {};
      }
      const z = zonesLayout(skin.pack, nodes, seatsRef.current, { night, seatPrefs: skKey ? seatPrefsRef.current : null });
      seatsRef.current = z.seats;
      return z;
    }
    // The desks wrap at the stage's width at the scale they open on (desksK: a pixel level near one CSS px a unit).
    const deskW = Math.max(240, Math.floor(width / desksK(ratio)));
    if (!custom) return autoLayout(officeRooms(view, filter).map((r) => (hideAsleep ? { ...r, nodes: r.nodes.filter(keep) } : r)), { width: deskW });
    return officeScene(custom, nodes, skin, false, deskW);
  }, [overview, view, filter, custom, width, ratio, skin, hideAsleep, night, seatRev, officeKey, shared]);
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
  const tileLooks = useMemo(() => { const work = workOn(traffic); return tiles.map((tl) => looksOf(tl.L, work, q, mode, tl.zones, (n) => badgeOf(n, lv, wordsOf(tl.skin)))); }, [tiles, traffic, q, mode, themeRev, lv, wordsOf]);
  // The scene the view pans and zooms: the office's, or the overview of every tile.
  const L = useMemo(() => (overview ? { mode: "overview", rooms: [], width: arranged.width, height: arranged.height } : single), [overview, single, arranged]);
  const looks = useMemo(() => looksOf(L, workOn(traffic), q, mode, zones, (n) => badgeOf(n, lv, wordsOf(skin))), [L, traffic, q, mode, themeRev, lv, skin, wordsOf]);
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
  // office walks to it first (#2564). An NPC drawn as furniture with a `walk` strolls near its spot alike (#2596). A
  // pack's `idleVisits` (#3685) now and then sends an idle person to a free seat in another area instead, for a while.
  const wander = zones && !overview && !still && !layout;
  // #3685: who sits where on a visit, kept between ticks (the layout is rebuilt on every state change; the style's
  // seats are not): someone who turns idle later never moves a visitor already there. A new style starts afresh.
  // M-3286: the office's "Idle people stay in their own area" (Edit offices): strolls stay in the area, no visits.
  const ownArea = !!custom && custom.stayInArea === true;
  const visitMemo = useMemo(() => ({ claims: new Map(), idle: null }), [skin]);
  // M-3293: play — never on a share link's page (no onOpen there, or its own `talk`), with reduced motion, in All
  // offices, the carousel or Edit layout. `hold`: the person picked up (carried where the pointer is, walked back from
  // where they are dropped, or seated on another seat in their area: M-3445 #4266/#4267); `reacts`: pats and feeds showing.
  const play = playAllowed({ on: playOn, still, zones, overview, layout: !!layout, shared }) && !carouselPick;
  // M-3547 / M-3556: off only for reduced motion — one line under Drag and pat in Display options says so (no override).
  const playStillOff = playOffForMotion({ on: playOn, still, zones, overview, layout: !!layout, shared }) && !carouselPick;
  const hold = useMemo(() => createHold(), []), reacts = useRef(new Map()), walkNow = useRef(null), holdTimer = useRef(null);
  // M-3432 (#4255): custom snacks from the active skin pack (client-local, only when play is enabled).
  const snacks = useMemo(() => createSnacks(), []);
  const snackDragCtrl = useMemo(() => createSnackDrag(), []);
  const packSnacks = useMemo(() => (skin && skin.pack && Array.isArray(skin.pack.snacks) ? skin.pack.snacks : []), [skin]);
  const snacksById = useMemo(() => new Map(packSnacks.map((s) => [s.id, s])), [packSnacks]);
  const showSnacks = play && packSnacks.length > 0;
  const [armedSnack, setArmedSnack] = useState(null);
  const [snackDrag, setSnackDrag] = useState(null);
  const snackDropRef = useRef(null), snackGhostRef = useRef(null), snackGhostPosRef = useRef(null), snackTrayRef = useRef(null), snackSwallowRef = useRef(false);
  const snackCtxRef = useRef({ showSnacks: false, officeKey: "", styleKey: "" });
  const onSnackClaim = (winner) => {
    reacts.current.set(winner, { kind: "feed", t0: now() });
    if (store.tellOn(winner)) void store.tell(winner, "feed");
    loop.current?.wake();
  };
  useEffect(() => { if (!play) { const wasHeld = !!hold.held(); snackDragCtrl.retire(); hold.cancel(); seatDropRef.current = null; reacts.current.clear(); snacks.clear(); snackDropRef.current = null; setArmedSnack(null); setSnackDrag(null); if (wasHeld) walkNow.current?.(); } }, [play]);
  useEffect(() => { if (!showSnacks) { snackDragCtrl.retire(); snackDropRef.current = null; setArmedSnack(null); setSnackDrag(null); } }, [showSnacks]);
  useEffect(() => () => { snackDragCtrl.retire(); }, []);
  useEffect(() => {
    if (!zones || overview) return undefined;
    const go = () => {
      const t = now(), to = walkTargets(desksOf(L), L, t, wander, skin.pack.furniture, night, visitMemo, ownArea);
      // An act's walk; not someone in bed for the night (#2568: bedtime wins, as for mail).
      for (const d of desksOf(L)) { const a = actsHere.get(d.node.name), at = !d.night && actLive(a, d.node.state, Date.now(), actSeen.current) ? actTarget(a, L, walkers, t) : null; if (at) to.set(d.node.name, at); }
      for (const [name, at] of mail.targets(L, t)) to.set(name, at);
      // M-3539: a new office or style (a room's office reads its style after it opens) puts everyone at their place at
      // once: walking there from the old one's seats drew the asleep standing in the help desk for seconds.
      const placed = `${officeKey}\n${skin.id}`, fresh = placedRef.current !== placed;
      placedRef.current = placed;
      // A pack's vehicles: who wants to ride walks to the platform, boards when it stops there, gets off at a stop; a
      // caller gets off at once. Riders are set down where they are when their vehicle goes (fresh: the sync does).
      const vehicles = skin.pack.vehicles || [];
      let boarding = [];
      if (fresh) riders.clear();
      if (vehicles.length) {
        const byId = new Map(vehicles.map((v) => [v.id, v])), wall = Date.now(), here = desksOf(L);
        const wants = new Map(here.map((d) => { const a = actsHere.get(d.node.name); return [d.node.name, !d.night && rideLive(a, d.node.state, wall) ? a.ride : null]; }));
        const r = riders.step({ wants, vehicles: byId, wall, posOf: (n) => walkers.at(n, t), homeOf: (n) => (here.find((d) => d.node.name === n) || {}).seat || null,
          sinceOf: (n) => { const a = actsHere.get(n); return a && a.ride && typeof a.since === "number" ? a.since : null; },
          urgent: (n) => { const d = here.find((x) => x.node.name === n); return !!d && CALLING.has(d.node.state); } });
        for (const [name, at] of r.targets) to.set(name, at);
        boarding = r.board.map((b) => { const v = byId.get(b.vehicle); return [b.name, () => seatAt(v, vehicleAt(v, Date.now()), b.seat)]; });
        for (const a of r.alight) walkers.place(a.name, a.at);
      } else for (const n of riders.clear()) { const p = walkers.at(n, t); if (p) walkers.place(n, p); }
      for (const [name, at] of snacks.targets(t)) to.set(name, at);
      const held = hold.held();                                     // M-3293: carried: where the pointer is, no walk
      if (held) to.set(held.name, held.at);
      cardStay(to, cardDesk.current, held, walkers, t);             // their card is open: no walk, unless calling
      walkers.sync(to, t, L, still, fresh);
      for (const [name, seat] of boarding) walkers.ride(name, seat);
      // Reduced motion has no loop: drawn again here, or an act's walk (set after the scene was drawn) never shows.
      if (still) { if (scene.current && !globalThis.document?.hidden) draw(0); } else loop.current?.wake();
    };
    go();
    walkNow.current = go;
    if (still) return undefined;
    const h = setInterval(go, WANDER.TICK);
    return () => clearInterval(h);
  }, [L, wander, mail, skin, night, actsHere, visitMemo, ownArea, riders]);
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
  snackCtxRef.current = { showSnacks, officeKey, styleKey };
  useEffect(() => { snackDragCtrl.retire(); hold.cancel(); seatDropRef.current = null; snacks.clear(); snackDropRef.current = null; setArmedSnack(null); setSnackDrag(null); }, [officeKey, styleKey]);
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
    if (!el || !c || !el.style) return;
    if (el.classList?.contains("sheet")) { el.style.removeProperty("max-height"); liftOverSheet(el, c); return; }
    const v = view0(), sz = sizeRef.current;
    const w = c.walks ? walkers.at(c.name, now()) : null;
    const pt = w ? { x: w.x, y: w.y - 52, r: 16 } : { x: c.box.x + c.box.w / 2, y: c.box.y, r: (c.box.w / 2) * v.k };
    // Its whole height (a card held shorter below an area's name scrolls: its content's height, not the box's).
    const sc = (typeof el.querySelector === "function" && el.querySelector(".oo-card-body")) || el;
    const natural = sc.scrollHeight ? sc.scrollHeight + ((el.offsetHeight || 0) - (sc.clientHeight || 0)) : 0;
    const p = toScreen(v, pt.x, pt.y), cw = el.offsetWidth || 320, ch = natural || el.offsetHeight || 260, gap = (c.skin?.pack?.card?.layout?.gap ?? 12) + pt.r;
    // M-3633: clear of the areas' names — where the Office writes each one (areaTitleBox, a few px around it), else, on a
    // pack's own picture, the corner a name painted there takes.
    // The scene's own layout and skin (the draw loop's: this runs in it, where the render's may be an older one).
    const sc0 = scene.current, part = sc0 && !sc0.overview ? sc0.part : null, sk0 = part && part.skin;
    const titled = !!(sk0 && sk0.areaTitleBox && sc0.ctx && sc0.env);
    const avoid = part && part.zones && part.L ? Object.values(part.L.areas || {}).map((ar) => {
      const b = titled ? sk0.areaTitleBox(sc0.ctx, ar, sc0.env) : null;
      const r = b ? { x: b.x - 4, y: b.y - 4, w: b.w + 8, h: b.h + 8 } : { x: ar.rect.x, y: ar.rect.y, w: Math.min(ar.rect.w, AREA_LABEL.w), h: Math.min(ar.rect.h, AREA_LABEL.h) };
      const q = toScreen(v, r.x, r.y);
      return { x: q.x, y: q.y, w: r.w * v.k, h: r.h * v.k };
    }) : [];
    const { x, y, maxH } = cardSpot({ px: p.x, py: p.y, gap, cw, ch, w: sz.w, h: sz.h, avoid });
    if (maxH) el.style.setProperty("max-height", `${Math.round(maxH)}px`); else el.style.removeProperty("max-height");
    el.style.setProperty("transform", `translate(${Math.round(x)}px, ${Math.round(y)}px)`);
  };
  /**
   * M-3633: a phone's bottom-sheet card covers the stage's foot. The scene is kept in the rest (setView's clampPan is
   * given the uncovered height: a scene smaller than it is centred there), and the person is brought above the sheet —
   * once each time the sheet's height changes, so a pan of their own is left alone. It closes: the whole stage again.
   */
  const visSize = () => { const z = sizeRef.current || size; return { w: z.w, h: Math.max(1, z.h - sheetCover.current) }; };
  const liftOverSheet = (el, c) => {
    const st = stageRef.current;
    if (!st || typeof st.getBoundingClientRect !== "function" || typeof el.getBoundingClientRect !== "function") return;
    const cover = Math.max(0, Math.round(st.getBoundingClientRect().bottom - el.getBoundingClientRect().top));
    if (cover === sheetCover.current) return;
    sheetCover.current = cover;
    // The scene's current layout (this runs in the draw loop, where the render's `L` may be an older one).
    const LL = (scene.current && !scene.current.overview && scene.current.part && scene.current.part.L) || L;
    const v = view0(), w = c.walks ? walkers.at(c.name, now()) : null;
    const p = toScreen(v, w ? w.x : c.box.x + c.box.w / 2, w ? w.y : c.box.y + c.box.h), room = (sizeRef.current || size).h - cover - 16;
    vp.current = clampPan({ ...v, y: v.y - Math.max(0, p.y - room) }, LL.width, LL.height, visSize());
    apply();
  };
  const unliftSheet = () => {
    if (!sheetCover.current) return;
    sheetCover.current = 0;
    vp.current = clampPan(view0(), L.width, L.height, size);
    apply();
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
    vp.current = clampPan(v, L.width, L.height, visSize());
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
  /** #4405: this scene's zoom floor — lower than OK_MIN for a pack's big canvas (or All offices), so − reaches its Fit. */
  const kLo = minK(L.width, L.height);
  /** The view an office opens on: its kept one (a kept fit: fitted to this size), else its opening; and whether a fit. */
  const openView = () => {
    const kept = store.view(officeKey);
    if (kept && kept.fit) return { v: fitL(fitMode), fit: true };
    if (kept) return { v: viewFromSaved(kept, size, kLo), fit: false };
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
    vp.current = clampPan(view0(), L.width, L.height, visSize());
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
  useEffect(() => { if (!miniOff) mark(); }, [miniOff]);           // shown again: placed on the view at once
  /** + / −: the next pixel level about the stage's middle. */
  const zoomStep = (dir) => { const v = view0(), k = stepK(v.k, dir, ratio, kLo); raw.current = k; setView(zoomTo(v, k, size.w / 2, size.h / 2)); };
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
      const tg = e.target;
      // #4010: carousel keys at document level so a TV remote works without the canvas focused. Not while a field,
      // button or link is focused (Space/arrows stay with that control) or over Edit offices / Edit layout.
      const ck = carouselAct.current;
      if (ck.on && !carouselHeld(tg) && !editingRef.current && !layoutRef.current) {
        const a = carouselKey(e);
        if (a) { e.preventDefault(); ck.act(a); return; }
      }
      if (e.key !== "f" && e.key !== "F") return;
      const el = ooRef.current;
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
  const open = (name) => {
    if (!onOpen) return;
    if (tmode !== "window") { setTalkTo(name); return; }
    if (fsRef.current) exitFs();
    onOpen(name);
  };
  /** The whole chat (the pop-up), from a talk in the Office. */
  const openFull = () => { if (!onOpen || !talkTo) return; if (fsRef.current) exitFs(); onOpen(talkTo); };

  // ── Drawing: the back and front layers are pictures of the scene at the view's resolution (remade when the office
  // or the zoom changes, never on a pan); each frame draws the matte, the layers, the people and the items in the air ──
  const scene = useRef(null);
  const loop = useRef(null);
  const clipClocks = useRef(null);
  if (!clipClocks.current) clipClocks.current = createClipClocks();
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
    const maxPackFps = overview
      ? Math.max(0, ...tiles.map((tl) => packMaxFps(tl.skin && tl.skin.pack)))
      : packMaxFps(skin && skin.pack);
    const fps = Math.max(FPS, Math.min(30, Math.ceil(maxPackFps)));
    const base = { ctx, ratio, BW, BH, matte, env, fps, dirty: true, namesOff };
    if (overview) {
      // Each tile a scene of its own, where the overview puts it (arranged.tiles, in the same order).
      const parts = tiles.map((tl, i) => ({ ...partOf(tl.L, tileLooks[i], tl.skin, tl.zones, tl.walkers, tl.flights), night, key: tl.key, prefix: tl.prefix, tile: arranged.tiles[i], ups: ups.current, levelsOn: !!(lv && lv.enabled), levels: wordsOf(tl.skin) }));
      scene.current = { ...base, overview: true, parts, lay: arranged };
    } else {
      scene.current = { ...base, overview: false, part: { ...partOf(L, looks, skin, zones, walkers, flights), ghosts, night, mail, acts: actsHere, actSeen: actSeen.current, ups: ups.current, levelsOn: !!(lv && lv.enabled), levels: wordsOf(skin), reacts: reacts.current, riding: riders.riding,
        hold: play ? hold : null, seatDrop: seatDropRef,
        snacks: play ? snacks : null, snacksById, ownArea, snackDrop: snackDropRef, onSnackClaim, onSnacksChanged: () => walkNow.current?.() } };
    }
    if (still) draw(0); else loop.current?.wake();
  }, [L, looks, skin, pal, size.w, size.h, ratio, matte, overview, tiles, tileLooks, arranged, ghosts, night, mail, actsHere, lv, wordsOf, play, snacksById, ownArea, namesOff]);

  /** One frame at `ms` (0: still); whether anything is moving (in the air, or someone walking). */
  function draw(ms) {
    const s = scene.current;
    if (!s) return false;
    placeCard();
    const { ctx, BW, BH, env } = s;
    s.bubbleHits = [];
    const seenClips = ms > 0 ? new Set() : null;
    const clocked = (prefix) => (seenClips
      ? { ...env, clock: (k, st, t) => { const fk = `${prefix}${k}`; seenClips.add(fk); return clipClocks.current.elapsed(fk, st, t); } }
      : env);
    // The view in bitmap px: a logical unit is `a` px (a whole number at a pixel level), the origin on a whole px.
    const v = view0(), a = v.k * s.ratio, ox = Math.round(v.x * s.ratio), oy = Math.round(v.y * s.ratio);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, BW, BH);
    ctx.fillStyle = s.matte; ctx.fillRect(0, 0, BW, BH);
    ctx.imageSmoothingEnabled = false;
    for (const p of s.overview ? s.parts : [s.part]) p.reply = replyRef.current ? { ...replyRef.current, ratio: s.ratio } : null;
    if (!s.overview) {
      // #4379 review: an open card (beside its person, or a bottom sheet) covers part of the scene: a name tag under it is
      // left out whole, never a fragment showing past its edge. Its box in bitmap px, as the canvas lies on the page.
      const cardNow = cardEl.current, cvNow = canvasRef.current;
      if (cardNow && cvNow && typeof cardNow.getBoundingClientRect === "function" && typeof cvNow.getBoundingClientRect === "function") {
        const r = cardNow.getBoundingClientRect(), c = cvNow.getBoundingClientRect();
        s.part.cover = r.width > 0 && r.height > 0 ? { x: (r.left - c.left) * s.ratio, y: (r.top - c.top) * s.ratio, w: r.width * s.ratio, h: r.height * s.ratio } : null;
      } else s.part.cover = null;
      const e0 = clocked(""), kc = keepClearOf(canvasRef.current, v);
      const moved = drawPart(ctx, s.part, a, ox, oy, ms, still, tipNow.current, kc.length ? { ...e0, keepClear: kc } : e0, s.namesOff ? "names" : false, null, s.bubbleHits);
      if (seenClips) clipClocks.current.prune(seenClips);
      return drawDialogue(ctx, s, ms) || moved;
    }
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
      if (drawPart(ctx, p, a * tt.s, tx, ty, ms, still, hot && hot.startsWith(p.prefix) ? hot.slice(p.prefix.length) : null, clocked(p.prefix), v.k * tt.s < TAG_MIN_K || (s.namesOff ? "names" : false), said, s.bubbleHits)) moving = true;
      ctx.restore();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.strokeStyle = env.pal.border; ctx.lineWidth = 1;
      ctx.strokeRect(tx - 0.5, ty - 0.5, tw + 1, th + 1);
    }
    for (const say of said) say();
    const up = still ? [] : cross.frame(ms, s.parts);
    // Each drawn by its sender's tile's skin (#2562: their own prop, else that pack's for its kind), at that tile's scale;
    // a sender in no tile drawn: the built-in item, in overview units.
    const crossEnv = clocked("x:");
    for (const it of up) {
      const from = senderTile(s.parts, it.from);
      if (from) { ctx.setTransform(a * from.tile.s, 0, 0, a * from.tile.s, ox, oy); from.skin.drawProp(ctx, { ...it, x: it.x / from.tile.s, y: it.y / from.tile.s }, ms, crossEnv); }
      else { ctx.setTransform(a, 0, 0, a, ox, oy); skinFor("pixel").drawProp(ctx, it, ms, crossEnv); }
    }
    if (seenClips) clipClocks.current.prune(seenClips);
    return drawDialogue(ctx, s, ms) || moving || up.length > 0 || cross.size() > 0;
  }
  /**
   * #2861: the dialogue box over the scene, in the stage's CSS px — its newest conversation whose agent is drawn here and
   * awake (pickFront), with their faces (the pack's portraits; else the agent's avatar, else initials), the speaker's
   * words typed out, the agent's line while it works and "+N". Nothing at all while it is off. Whether it moves.
   */
  function drawDialogue(_mapCtx, s, ms) {
    const d = dlgRef.current;
    if (!d) { dlgShown.current = null; showDialogueDock(false); return false; }
    const t = ms > 0 ? ms : now();
    const { front, more } = pickFront(dlg.list(), (n) => d.who.has(n), (n) => d.who.get(n).look?.pose === "paused");
    if (!front) { dlgShown.current = null; showDialogueDock(false); return false; }
    const who = d.who.get(front.instance), node = who.node;
    const stage = stageOf(front, t, node.state === "working", still);
    // Talk "Dialogue box" (d.vn) keeps an answer until it is clicked away in its own box (TalkStage); the dock is not drawn then.
    if (stage.done && !d.vn) { dlgShown.current = null; showDialogueDock(false); return false; }
    showDialogueDock(true);
    const cv = dialogueCanvasRef.current;
    if (!cv) return false; // layout commit mounts the dock, then its effect paints even with reduced motion
    const dw = cv.clientWidth || sizeRef.current.w, dh = cv.clientHeight || (phone ? 160 : 180), L0 = boxLayout(dw, dh);
    const BW = Math.max(1, Math.floor(dw * s.ratio)), BH = Math.max(1, Math.floor(dh * s.ratio));
    if (cv.width !== BW) cv.width = BW;
    if (cv.height !== BH) cv.height = BH;
    const ctx = cv.getContext("2d");
    if (!ctx) return false;
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, BW, BH);
    const skinOf = who.skin, pack = skinOf && skinOf.pack;
    const pic = (src) => (src && skinOf && typeof skinOf.picture === "function" ? skinOf.picture(src, dlgWake) : null);
    const agentName = nodeText(node).primary;
    const idColour = (it) => { try { const id = identityOf(it); return id.off ? null : s.env.mode === "light" ? id.light : id.dark; } catch { return null; } };
    const agentFace = () => {
      const im = pic(portraitSrc(pack, { agent: front.instance, state: node.state }));
      if (im) return { kind: "portrait", im };
      if (!d.share && node.i) {
        const av = avatarOf(node.i);
        if (av.src) { const fim = faces(av.src, dlgWake); if (fim) return { kind: "image", im: fim }; }
        if (av.kind === "emoji" && av.text) return { kind: "emoji", text: av.text };
        if (av.kind === "initial" && av.text) return { kind: "initial", text: av.text, color: idColour(node.i) };
      }
      return { kind: "initial", text: firstCharacter(agentName), color: node.i ? idColour(node.i) : null };
    };
    const personFace = () => {
      if (!front.person) return { kind: "initial", text: "?" };
      const im = pic(portraitSrc(pack, { account: front.person.account }));
      return im ? { kind: "portrait", im } : { kind: "initial", text: firstCharacter(front.person.name || to("dlgSomeone")) };
    };
    const answered = stage.phase === "answered";
    const words = answered ? front.reply ?? to("dlgAnsweredShare") : front.person ? front.text ?? "" : to("dlgHeardShare", agentName);
    ctx.setTransform(s.ratio, 0, 0, s.ratio, 0, 0);
    ctx.font = `400 ${L0.font}px system-ui, sans-serif`;
    const lk = `${front.id}|${answered ? 1 : 0}|${L0.text.w}|${L0.font}`;
    let lines = dlgLines.current.get(lk);
    if (!lines) {
      lines = wrap((x) => ctx.measureText(x).width, words, L0.text.w, L0.text.lines);
      if (dlgLines.current.size > 32) dlgLines.current.clear();
      dlgLines.current.set(lk, lines);
    }
    const act = d.acts && d.acts.get(front.instance);
    const status = stage.phase === "working" ? (actLive(act, node.state, Date.now(), null) && act.say ? act.say : to("dlgWorking")) : null;
    const L = fitBox(L0, lines.length, !!status);
    dlgShown.current = { L, stage, key: who.key, name: front.instance };
    const frameSrc = pack && pack.dialogBox && pack.dialogBox.frame, frameIm = frameSrc ? pic(frameSrc) : null;
    return drawBox(ctx, {
      // A short landscape dock keeps the name and words; decorative faces need headroom above the box.
      L, stage, left: dh >= 144 ? personFace() : null, right: dh < 144 || stage.phase === "heard" ? null : agentFace(),
      name: answered ? agentName : front.person ? front.person.name || to("dlgSomeone") : to("dlgSomeone"),
      lines, status: status ? `${agentName} · ${status}` : null, more,
      colours: boxColours(pack && pack.dialogBox, s.env.pal), frame: frameIm ? { im: frameIm, slice: pack.dialogBox.slice || 8, k: pack.scale || 2 } : null,
    }, t, { ...s.env, still });
  }
  // A newly mounted dock must paint even when reduced motion leaves the map loop asleep.
  useLayoutEffect(() => {
    if (!dlgOn || !dlgVisible) return;
    if (scene.current) drawDialogue(scene.current.ctx, scene.current, still ? 0 : now());
    if (!still) loop.current?.wake();
  }, [dlgOn, dlgVisible, dlgSay, width, phone, ratio]);

  // The loop: drawing only when the frame (FPS) changed or something is in the air; stopped while the tab is hidden,
  // gone with the view. Office review: while something walks or flies, a frame every display frame up to AIR_FPS (the
  // motion is smooth); when nothing moves, the poses change at most FPS times a second, so the loop sleeps (a timer)
  // until the next frame's start instead of waking at the display's rate only to find nothing to draw.
  useEffect(() => {
    if (still || typeof requestAnimationFrame !== "function") return undefined;
    let raf = 0, timer = 0, last = -1, lastFps = FPS, air = true, gone = false, drawnAt = -Infinity;
    const tick = () => {
      raf = 0;
      if (gone || globalThis.document?.hidden || !scene.current) return;
      const fps = scene.current.fps || FPS;
      const ms = now(), frame = Math.floor((ms / 1000) * fps);         // the clock the trips started on
      const due = air && ms - drawnAt >= 1000 / AIR_FPS - 4;            // a 60/120 Hz screen: every 2nd/4th frame
      if (scene.current.dirty || frame !== last || fps !== lastFps || due) { scene.current.dirty = false; last = frame; lastFps = fps; drawnAt = ms; air = draw(ms); }
      if (air) { raf = requestAnimationFrame(tick); return; }
      const wait = Math.max(1, Math.ceil(((frame + 1) * 1000) / fps - ms));   // until the next frame starts
      if (fps > FPS && wait <= 16) { raf = requestAnimationFrame(tick); return; }
      const sleep = fps > FPS ? Math.max(1, wait - 14) : wait;
      timer = setTimeout(() => { timer = 0; if (!gone && !raf) raf = requestAnimationFrame(tick); }, sleep);
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
  // #2861: who the dialogue box may speak for — everyone drawn here (All offices: the first tile they are in), with what
  // draws them; null while it is off (draw() then draws nothing of it).
  replyRef.current = tmode === "bubble" ? { chat, draw: chatUi.drawReply, style: chatUi.replyStyle, pace: chatUi.readPace, read: readMode } : null;
  const talkWho = talkTo ? people.find((d) => d.node && d.node.name === talkTo) || null : null;
  const talkLabel = talkWho ? nodeText(talkWho.node).primary : talkTo;
  const sidePanel = tmode === "panel" && !!talkTo;
  /** Talk "Dialogue box": what the box on the scene shows now (fleet-office-talk.js TalkStage), or null. */
  const stagePeek = () => {
    const d = dlgRef.current;
    const pf = d ? pickFront(dlg.list(), (n) => d.who.has(n), (n) => d.who.get(n).look?.pose === "paused") : { front: null, more: 0 };
    const conv = pf.front, name = conv ? conv.instance : talkTo;
    if (!name) return null;
    const who = d ? d.who.get(name) : null, node = who ? who.node : (people.find((x) => x.node && x.node.name === name) || {}).node;
    if (!node) return null;
    const sk = (who && who.skin) || skin, pack = sk && sk.pack, act = actsHere && actsHere.get(name);
    const pic = (src) => { const im = src && sk && typeof sk.picture === "function" ? sk.picture(src, () => {}) : null; return im && im.src ? im.src : null; };
    return {
      name, label: nodeText(node).primary, conv, more: pf.more,
      status: node.state === "working" ? (actLive(act, node.state, Date.now(), null) && act.say ? act.say : to("dlgWorking")) : null,
      portrait: pack ? pic(portraitSrc(pack, { agent: name, state: node.state })) : null,
      colours: (pack && pack.dialogBox) || null,
    };
  };
  const stageOps = {
    now, skip: () => skipTalk(), target: (n) => { if (talkTo !== n) setTalkTo(n); },
    drop: (instance) => { dlg.drop(instance); dlgWake(); },
  };
  // The dialogue box is the talk only as itself (or beside the pop-up): never under the side panel or the head bubble.
  const dockShown = dlgOn && dlgVisible && tmode === "window";
  dlgRef.current = dlgOn ? {
    vn: tmode === "box", read: readMode,
    who: new Map(people.filter((d) => d.node && d.node.name).reverse().map((d) => [d.node.name, { key: d.key, node: d.node, look: d.look, skin: d.skin || skin }])),
    acts: actsHere, share: talk !== undefined,
  } : null;
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
    pinch: (from, to) => { raw.current = Math.min(OK_MAX, Math.max(kLo, raw.current * (to.dist / from.dist))); setView(pinchOffice(view0(), from, to, raw.current, kLo)); } });
  /** Where a drag pans: the canvas, and Edit layout's overlay off its handles (the controls, the bar and the list: never). */
  const onScene = (el) => !!el && (el === canvasRef.current || (typeof el.closest === "function" && !!el.closest(".ol-svg") && !el.closest(".ol-handle")));
  /** M-3293 / M-3445: update the floor-level seat drop targets while carrying `h` ({ name, at }). */
  const updateSeatDrop = (h) => {
    if (!h || !zones || !skin || !skin.pack) { seatDropRef.current = null; return; }
    const ds = desksOf(L);
    seatDropRef.current = {
      name: h.name,
      targets: seatDropTargets(skin.pack, ds, h.name),
      hover: findSeatDropTarget(skin.pack, ds, h.name, h.at),
    };
  };
  /** M-3293 / M-3445: someone picked up — enters `dragged` pose under the pointer, highlights valid seats in their area. */
  const pickedUp = (pointerId) => {
    const h = hold.held();
    if (!h) return;
    // Captured only now: a press that stays a click must reach the canvas (its card), which a capture would take away.
    try { stageRef.current.setPointerCapture(pointerId); } catch { /* gone */ }
    snacks.cancel(h.name);
    updateSeatDrop(h);
    walkers.place(h.name, h.at); drag.current.swallow = true;
    setTip(null); setCard(null); loop.current?.wake();
  };
  const onDown = (e) => {
    lastType.current = e.pointerType || "mouse";
    if (!onScene(e.target)) return;
    // M-3293: a press on a person may pick them up — a mouse once it moves (no pan then), a touch once held still
    // (LONG_MS; a finger that moves first pans, as before).
    if (play && e.isPrimary !== false && !(e.pointerType === "mouse" && e.button !== 0)) {
      const d = deskOf(e), w = pointOf(e);
      const st = d && d.node && d.node.i && w ? hold.down(e.pointerId, e.pointerType || "mouse", w.x, w.y, now(), d.node.name, e.clientX, e.clientY) : hold.down(e.pointerId, "mouse", 0, 0, 0, null);
      if (st === "maybe") return;                                   // no pan: a click (their card), or a pick-up once it moves
      if (st === "press") { const id = e.pointerId; clearTimeout(holdTimer.current); holdTimer.current = setTimeout(() => { if (hold.tick(now()) === "held") pickedUp(id); }, PLAY.LONG_MS); }
    }
    g.down(e);
    if (drag.current.pts.size === 2) raw.current = view0().k;      // a pinch starts from the zoom shown
  };
  /** M-3293 / M-3445: while a press may pick someone up it is theirs (no pan); once held it carries them; a finger that moved first pans. */
  const onStageMove = (e) => {
    if (hold.state()) {
      const w = pointOf(e), was = hold.state();
      const st = w ? hold.move(e.pointerId, w.x, w.y, now(), e.clientX, e.clientY) : hold.state();
      if (st === "held") {
        if (was !== "held") pickedUp(e.pointerId);
        else { const h = hold.held(); updateSeatDrop(h); walkers.place(h.name, h.at); loop.current?.wake(); }
        return;
      }
      if (st === "maybe" || st === "press") return;
      if (st === "pan") { clearTimeout(holdTimer.current); hold.cancel(); seatDropRef.current = null; }
    }
    g.move(e);
  };
  /** M-3445 (#4266): settle a dragged character onto a valid seat in their area (or clamp/walk back to their seat). */
  const finishHoldDrop = (r, commitSeat) => {
    seatDropRef.current = null;
    if (!r) return;
    const ds = desksOf(L);
    const target = commitSeat && zones && skin && skin.pack ? findSeatDropTarget(skin.pack, ds, r.name, r.at) : null;
    if (target) {
      if (!target.current) {
        const res = applySeatDrop({ pack: skin.pack, desks: ds, seats: seatsRef.current, prefs: seatPrefsRef.current, name: r.name, target });
        seatsRef.current = res.seats;
        seatPrefsRef.current = res.prefs;
        if (!shared) store.saveSeats(officeKey, res.prefs);
        if (res.swapped) {
          const occPos = walkers.at(res.swapped.name, now()) || { x: target.x, y: target.y };
          if (ownArea && !routeStaysInArea(occPos, res.swapped.seat, L, target.area, null)) {
            walkers.place(res.swapped.name, res.swapped.seat);
          }
        }
        walkers.place(r.name, { x: target.x, y: target.y });
        setSeatRev((n) => n + 1);
      } else {
        walkers.place(r.name, { x: target.x, y: target.y });
        walkNow.current?.();
      }
    } else {
      const d = ds.find((x) => x && x.node && x.node.name === r.name);
      const landAt = ownArea && d ? clampDropForArea(r.at, d.seat, L, d.area) : r.at;
      walkers.place(r.name, landAt);
      walkNow.current?.();
    }
    loop.current?.wake();
  };
  const onStageUp = (e) => {
    clearTimeout(holdTimer.current);
    const r = hold.up(e.pointerId);
    if (r) { finishHoldDrop(r, true); drag.current.swallow = true; setTimeout(() => { if (!drag.current.pts.size) drag.current.swallow = false; }, 0); }
    g.up(e);
  };
  const onStageCancel = (e) => { clearTimeout(holdTimer.current); const r = hold.up(e.pointerId); finishHoldDrop(r, false); g.up(e); };
  const onWheel = (e) => {
    if (!onScene(e.target) && !(typeof e.target?.closest === "function" && e.target.closest(".ol-handle, .oo-tile-label"))) return;
    e.preventDefault();
    const r = stageRef.current.getBoundingClientRect(), v = view0();
    raw.current = Math.min(OK_MAX, Math.max(kLo, raw.current * wheelFactor(e)));
    if (raw.current !== v.k) setView(zoomOffice(v, raw.current, e.clientX - r.left, e.clientY - r.top, kLo));
  };
  const onKeyDown = (e) => {
    if (e.defaultPrevented) return;                                  // Edit layout's handles move with the arrows
    if (e.key === "Escape" && hold.held()) {
      e.preventDefault();
      clearTimeout(holdTimer.current);
      const h = hold.held();
      hold.cancel();
      finishHoldDrop(h, false);
      return;
    }
    const tag = e.target && e.target.tagName;
    if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
    const z = zoomKey(e);
    if (z) { e.preventDefault(); if (z === "fit") fit(); else zoomStep(z === "in" ? 1 : -1); return; }
    const dir = PAN_KEYS[e.key];
    if (dir && e.target === canvasRef.current && !carousel && !e.altKey && !e.ctrlKey && !e.metaKey) { e.preventDefault(); const v = view0(); setView({ ...v, x: v.x - dir[0] * 80, y: v.y - dir[1] * 80 }); }
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
  /** #2861: the dialogue box under a pointer event ({ key, name }: its agent), or null. */
  const dlgAt = (e) => {
    const b = dlgShown.current, r = dialogueCanvasRef.current ? dialogueCanvasRef.current.getBoundingClientRect() : null;
    return b && r && onBox(b.L, b.stage, e.clientX - r.left, e.clientY - r.top) ? b : null;
  };
  // Use the painted prefix and final displaced position, including bubbles outside an overview tile.
  const bubbleAtEvent = (e) => {
    // An armed snack owns map taps until the existing placement/feed action consumes it.
    if (shared || !onOpen || showSnacks && armedSnack) return null;
    const s = scene.current, r = canvasRef.current?.getBoundingClientRect();
    if (!s || !r) return null;
    const hit = officeBubbleAt(s.bubbleHits || [], (e.clientX - r.left) * s.ratio, (e.clientY - r.top) * s.ratio, lastType.current === "touch" ? 44 * s.ratio : 0);
    return hit && people.some(d => d.node.i && d.node.name === hit.name) ? hit : null;
  };
  const openDialogue = (e) => {
    if (shared || !onOpen || !dlgShown.current || e.detail > 1) return;
    if (e.type === "keydown") {
      if (e.repeat || e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
    }
    setCard(null); open(dlgShown.current.name);
  };
  /** Skip (the reading controls): every reply in the box, or over the heads, goes now. */
  const skipTalk = () => { if (tmode === "box") dlg.skip(); else if (chat) chat.skipAll(); dlgWake(); };
  const pickRead = (v) => { store.saveTalkRead(v); setReadMode(v); dlgWake(); };
  const onMove = (e) => {
    if (e.pointerType === "touch" || g.busy() || snackDrag || snackDropRef.current) return;
    const onDlg = !!dlgAt(e) || !!bubbleAtEvent(e);
    if (onDlg !== dlgHot) setDlgHot(onDlg);
    const d = onDlg ? null : deskOf(e); const key = d ? d.key : null; if (key !== tip) setTip(key);
  };
  /** #2861: the box clicked is its agent clicked — their card, and the view brought to them. */
  const focusPerson = (key) => {
    const d = people.find((x) => x.key === key);
    if (!d) return;
    cardFrom.current = null; setTip(null); setCard(key);
    const w = zones && !overview ? walkers.at(d.node.name, now()) : null;
    show(w ? { x: w.x - 24, y: w.y - 64, w: 48, h: 64 } : d.box);
  };
  // #2661: a click (or a tap) on a person opens their card; on the same person again, or off everyone, closes it; on
  // someone else, switches to theirs. A double-click skips the card and opens the chat.
  /** M-3253: a tap that hits nobody: the person within TAP_R CSS px of it (one office; All offices' tiles keep the exact hit). */
  const nearOf = (e) => {
    const w = pointOf(e);
    if (!w || overview) return null;
    const at = now();
    const list = people.filter((d) => d.node && d.node.i).map((d) => {
      const wk = zones ? walkers.at(d.node.name, at) : null;
      return { key: d.key, node: d.node, x: wk ? wk.x : d.box.x + d.box.w / 2, y: wk ? wk.y - 32 : d.box.y + d.box.h / 2 };
    });
    return nearestPerson(list, w.x, w.y, TAP_R / Math.max(kLo, view0().k));
  };
  /** M-3432 (#4255): feed an awake person a snack (plays eat animation + hearts + feed bubble + optional Tell). */
  const feedPerson = (name, snack, at) => {
    const t = now();
    snacks.feed(name, snack, { x: at.x, y: at.y, t, charEatStrip: skin.eatStrip ? skin.eatStrip(name) : null });
    reacts.current.set(name, { kind: "feed", t0: t });
    if (store.tellOn(name)) void store.tell(name, "feed");
    walkNow.current?.();
    loop.current?.wake();
  };
  /** M-3432 (#4255): drop a snack on the floor so nearby idle characters race to it. */
  const placeSnackAt = (snack, at) => {
    const t = now();
    const hidden = scene.current && scene.current.part ? furnitureAt(scene.current.part, t).hidden : null;
    snacks.place(snack, at, t, { desks: desksOf(L), walkers, hidden, ownArea, areas: L.areas, graph: L });
    walkNow.current?.();
    loop.current?.wake();
  };
  /** M-3432 (#4255): classify a pointer position while dragging a snack (awake person → feed, floor → place, tray/asleep/outside → cancel). */
  const snackTargetOf = (e) => {
    const tray = snackTrayRef.current;
    if (tray && typeof tray.getBoundingClientRect === "function") {
      const tr = tray.getBoundingClientRect();
      if (e.clientX >= tr.left && e.clientX <= tr.right && e.clientY >= tr.top && e.clientY <= tr.bottom) return null;
    }
    const st = stageRef.current;
    if (st && typeof st.getBoundingClientRect === "function") {
      const sr = st.getBoundingClientRect();
      if (e.clientX < sr.left || e.clientX > sr.right || e.clientY < sr.top || e.clientY > sr.bottom) return null;
    }
    const d = deskOf(e) || (e.pointerType === "touch" ? nearOf(e) : null);
    if (d && d.node && d.node.i) {
      if (ASLEEP.has(d.node.state) || d.night) return null;
      const at = (zones && walkers.at(d.node.name, now())) || d.seat || { x: d.x + d.w / 2, y: d.y + d.h };
      return { kind: "feed", name: d.node.name, label: nodeText(d.node).primary, x: at.x, y: at.y };
    }
    const w = pointOf(e);
    if (!w || w.x < 0 || w.x > L.width || w.y < 0 || w.y > L.height) return null;
    return { kind: "place", x: w.x, y: w.y };
  };
  /** M-3432 (#4255): drag a snack from the tray onto a character or empty floor; a short tap is left to onClick (tap-to-arm). */
  const onSnackDown = (snack, e) => {
    if (!showSnacks || e.isPrimary === false || (e.pointerType === "mouse" && e.button !== 0)) return;
    e.stopPropagation();
    const startOffice = officeKey, startStyle = styleKey;
    let lastKey = "";
    const moveGhost = (cx, cy) => {
      const sr = stageRef.current ? stageRef.current.getBoundingClientRect() : null;
      if (!sr) return;
      const gx = Math.round(cx - sr.left + 12), gy = Math.round(cy - sr.top - 40);
      snackGhostPosRef.current = { x: gx, y: gy };
      const gh = snackGhostRef.current;
      if (gh && gh.style) gh.style.setProperty("transform", `translate(${gx}px, ${gy}px)`);
    };
    const swallowClick = () => {
      snackSwallowRef.current = true;
      setTimeout(() => { snackSwallowRef.current = false; }, 0);
    };
    snackDragCtrl.start({
      pid: e.pointerId,
      sx: e.clientX,
      sy: e.clientY,
      slop: PLAY.SLOP,
      onMove: (ev, { starting }) => {
        if (starting) { setCard(null); setTip(null); }
        ev.preventDefault();
        if (tipNow.current) setTip(null);
        moveGhost(ev.clientX, ev.clientY);
        const drop = snackTargetOf(ev);
        snackDropRef.current = drop;
        const k = drop ? `${drop.kind}:${drop.name || ""}` : "";
        if (starting || k !== lastKey) {
          lastKey = k;
          setSnackDrag({ snack, kind: drop ? drop.kind : null, label: drop && drop.kind === "feed" ? drop.label : "" });
        }
        loop.current?.wake();
        return drop;
      },
      onCommit: (drop) => {
        snackDropRef.current = null;
        setSnackDrag(null);
        swallowClick();
        const cur = snackCtxRef.current;
        if (cur.showSnacks && cur.officeKey === startOffice && cur.styleKey === startStyle) {
          if (drop.kind === "feed") feedPerson(drop.name, snack, { x: drop.x, y: drop.y });
          else if (drop.kind === "place") placeSnackAt(snack, { x: drop.x, y: drop.y });
          setArmedSnack(null);
        }
        loop.current?.wake();
      },
      onCancel: ({ dragging }) => {
        snackDropRef.current = null;
        setSnackDrag(null);
        if (dragging) swallowClick();
        loop.current?.wake();
      },
    });
  };
  useEffect(() => {
    if (!armedSnack) return undefined;
    const onEsc = (e) => { if (e.key === "Escape" && !e.defaultPrevented) { e.preventDefault(); setArmedSnack(null); } };
    globalThis.document?.addEventListener?.("keydown", onEsc, true);
    return () => globalThis.document?.removeEventListener?.("keydown", onEsc, true);
  }, [armedSnack]);
  const paintSnackIcon = (st, pxSize = 28) => (cv) => {
    const g = cv && typeof cv.getContext === "function" ? cv.getContext("2d") : null;
    if (!g || !st || !skin || typeof skin.drawSnackIcon !== "function") return;
    const r = deviceRatio(), S = pxSize;
    if (cv.width !== Math.round(S * r) || cv.height !== Math.round(S * r)) { cv.width = Math.round(S * r); cv.height = Math.round(S * r); }
    g.setTransform(r, 0, 0, r, 0, 0); g.clearRect(0, 0, S, S);
    skin.drawSnackIcon(g, st, S);
  };
  const onClick = (e) => {
    const box = dlgAt(e);
    const bubble = bubbleAtEvent(e);
    if (bubble && bubble.reply && chat) { if (talkTo !== bubble.name) setTalkTo(bubble.name); chat.advance(bubble.name); return; }
    if ((box || bubble) && !shared && onOpen) {
      if (!(e.detail > 1)) { setCard(null); open((box || bubble).name); }
      return;
    }
    if (box) { focusPerson(box.key); return; }
    if (showSnacks && armedSnack) {
      const snack = snacksById.get(armedSnack);
      if (snack) {
        const hit = deskOf(e) || (lastType.current === "touch" ? nearOf(e) : null);
        if (hit && hit.node && hit.node.i) {
          if (!ASLEEP.has(hit.node.state) && !hit.night) {
            const at = (zones && walkers.at(hit.node.name, now())) || hit.seat || { x: hit.x + hit.w / 2, y: hit.y + hit.h };
            feedPerson(hit.node.name, snack, at);
          }
          setArmedSnack(null);
          return;
        }
        const w = pointOf(e);
        if (w && w.x >= 0 && w.x <= L.width && w.y >= 0 && w.y <= L.height) {
          placeSnackAt(snack, w);
          setArmedSnack(null);
          return;
        }
      }
    }
    const d = deskOf(e) || (lastType.current === "touch" ? nearOf(e) : null);
    if (!d || !d.node.i) { if (enterTile(e)) return; setTip(null); setCard(null); return; }
    if (lastType.current === "touch") setTip(null);
    cardFrom.current = null;
    setCard((cur) => (cur === d.key ? null : d.key));
  };
  /** All offices: a click on a tile (off its people) enters that office for this visit; the lobby is no office. */
  const enterTile = (e) => {
    const s = scene.current, w = pointOf(e);
    if (!overview || !s || !s.overview || !w || deskOf(e)) return false;
    const tt = tileAt(s.lay, w.x, w.y) || labelAt(s.lay, w.x, w.y), tl = tt ? tiles.find((x) => x.key === tt.key) : null;
    if (!tl || tl.lobby) return false;
    setCard(null); pick(tl.key, false);
    return true;
  };
  // All offices: a double-click on a tile (off its people) opens that office, as one click does.
  const onDblClick = (e) => {
    const box = dlgAt(e);
    if (box || bubbleAtEvent(e)) return; // the first click already opened it
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
  // editor is open, nor a second session (nor in All offices: custom is null there; nor in the carousel: the slide is
  // a stored office but Edit waits).
  const canLayout = canEdit && storedRev !== null && !!custom && zones && !loading && baseSkin.id === custom.skin && !editing && !layout && !carouselPick;
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
  /** The switcher's pick (kept per device); `keep` false: a tile entered from All offices, for this visit only. */
  const pick = (id, keep = true) => {
    if (layoutRef.current) return;
    if (id === CAROUSEL_ID) {
      const cur = store.carousel();
      const ids = carouselIdsOk(cur ? cur.ids : null, stored);
      const next = { ids: ids.length ? ids : stored.map((o) => o.id), interval: intervalOk(cur && cur.interval) };
      store.saveCarousel(next); setCarSaved(next); setCarIndex(0); setCarPlaying(true);
    }
    if (keep) store.saveChoice(id);
    setChoice(id); setTip(null);
  };
  const setCarIds = (ids) => {
    const next = { ids, interval: intervalOk(carSaved && carSaved.interval) };
    store.saveCarousel(next); setCarSaved(next);
  };
  const toggleCarId = (id) => {
    const have = new Set(carIds);
    if (have.has(id)) have.delete(id); else have.add(id);
    setCarIds(stored.map((o) => o.id).filter((x) => have.has(x)));
  };
  const setCarInterval = (n) => {
    const next = { ids: carSaved && Array.isArray(carSaved.ids) ? carSaved.ids : carIds, interval: intervalOk(n) };
    store.saveCarousel(next); setCarSaved(next);
  };
  const everyone = useMemo(() => { const m = new Map(); for (const n of [...view.top, ...view.teams.flatMap((tm) => tm.nodes), ...view.rest.nodes]) if (!m.has(n.name)) m.set(n.name, n); return [...m.values()]; }, [view]);
  const tipText = tipDesk ? nodeText(tipDesk.node) : null;
  // #2661: the card's person (gone from the office, filtered out or the office changed: it closes).
  const cardOf = card ? people.find((d) => d.key === card && d.node.i) || null : null;
  cardDesk.current = cardOf ? { name: cardOf.node.name, state: cardOf.node.state, box: cardOf.box, walks: zones && !overview, skin: cardOf.skin } : null;
  useEffect(() => { if (card && !cardOf) setCard(null); }, [card, !!cardOf]);
  useEffect(() => { walkNow.current?.(); }, [cardOf ? cardOf.node.name : null]);   // stop there now; walk again once it closes
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
  const drawAvatar = (cv, sizePx = 56) => {
    const s = scene.current, c = cardOf;
    const g = cv && cv.getContext ? cv.getContext("2d") : null;
    if (!g || !c || !s || !c.skin || !c.look) return;
    const r = deviceRatio(), W = Number(sizePx) || 56;
    if (cv.width !== Math.round(W * r) || cv.height !== Math.round(W * r)) { cv.width = Math.round(W * r); cv.height = Math.round(W * r); }
    g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, cv.width, cv.height); g.imageSmoothingEnabled = false;
    // The card's avatar: the set's still `stand` when it has one (poseStrip falls back to idle).
    const look = { ...c.look, pose: "stand", dim: false, match: false, badge: null, notag: true, free: true, work: 0, sign: null };
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
  // The switcher: the whole fleet, All offices (two or more stored), Carousel (two or more, signed-in), each stored office.
  const officeSelect = (cls) => html`<select class=${`tb-select ${cls}`} value=${layout ? layout.officeId : overview ? ALL_ID : carouselPick ? CAROUSEL_ID : custom ? custom.id : AUTO_ID} disabled=${!!layout}
    aria-label=${to("office")} onChange=${(e) => pick(e.target.value)}>
      <option value=${AUTO_ID}>${to("allOffice")}</option>
      ${overviewOk(stored) ? html`<option value=${ALL_ID}>${to("allOffices")}</option>` : null}
      ${opening == null && carouselOk(stored) ? html`<option value=${CAROUSEL_ID}>${to("carousel")}</option>` : null}
      ${stored.map((o) => html`<option key=${o.id} value=${o.id}>${o.name}</option>`)}
    </select>`;
  const carChrome = () => !carousel ? null : html`<button type="button" class="btn btn-sm oo-car-pause" onClick=${() => setCarPlaying((p) => !p)}>${to(carPlaying ? "pause" : "resume")}</button>
    <button type="button" class="btn btn-sm oo-car-next" onClick=${() => stepCar(1)}>${to("next")}</button>
    <span class="muted oo-car-now">${custom ? custom.name : ""} · ${to(carPlaying ? "playing" : "paused")}</span>`;
  // M-3253: the zone pills (a phone, one office on a zones style): the whole office, or an area at ZONE_K, centred.
  const zoneList = compact && zones && !overview && !layout ? Object.entries(L.areas || {}).map(([key, a]) => ({ key, rect: a.rect,
    n: people.filter((d) => d.area === areaName(key)).length })).filter((z) => z.rect && z.n > 0) : [];
  const toZone = (z) => { const v = view0(); raw.current = ZONE_K; setView(centreOn({ ...v, k: ZONE_K }, size, z.rect.x + z.rect.w / 2, z.rect.y + z.rect.h / 2)); };
  const closeMore = () => onMore && onMore(false);
  // M-3556: Display options (style, the toggles, the key) in a dropdown on a desk — non-modal, like Members: the office
  // stays in view, so a tick shows at once; a click elsewhere or Esc closes it. The Fleet office opens it from ⚙ in its
  // bar (open here); a Hub room's office (foldBar) from the gear in the zoom stack, open as its page says (`more`).
  const roomGear = folded && !compact;
  const [displayOpen, setDisplayOpen] = useState(false);
  const dispOpen = roomGear ? !!more : displayOpen;
  const setDisp = (v) => (roomGear ? onMore(v) : setDisplayOpen(v));
  const displayRef = useRef(null);
  useEffect(() => {
    if (!dispOpen) return undefined;
    const away = (e) => { if (displayRef.current && !displayRef.current.contains(e.target)) setDisp(false); };
    // Esc from inside it hands focus back to its button (as the sheet did), so the keyboard is not left on nothing.
    const esc = (e) => {
      if (e.key !== "Escape") return;
      const box = displayRef.current, back = !!box && typeof box.contains === "function" && box.contains(globalThis.document?.activeElement);
      setDisp(false);
      if (back) box.querySelector("button")?.focus?.();
    };
    document.addEventListener("pointerdown", away); document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("pointerdown", away); document.removeEventListener("keydown", esc); };
  }, [dispOpen]);
  // M-3556: the phone sheet is taller than a phone: while more is below its fold, its foot fades (data-more on the body).
  useEffect(() => {
    if (!compact || !more) return undefined;
    const el = globalThis.document?.querySelector?.(".oo-sheet .dlg-body");
    if (!el || typeof el.addEventListener !== "function") return undefined;
    const upd = () => { const below = el.scrollTop + el.clientHeight < el.scrollHeight - 2; if (below) el.setAttribute("data-more", ""); else el.removeAttribute("data-more"); };
    const raf = globalThis.requestAnimationFrame ? globalThis.requestAnimationFrame(upd) : (upd(), 0);
    el.addEventListener("scroll", upd, { passive: true }); globalThis.addEventListener?.("resize", upd);
    // Its content can change while it is open (another office, All offices' lobby tile, a note): re-measure then too
    // (Prism #3556 r3 P3).
    const RO = globalThis.ResizeObserver, ro = typeof RO === "function" ? new RO(upd) : null;
    if (ro) { ro.observe(el); for (const c of el.children || []) ro.observe(c); }
    return () => { globalThis.cancelAnimationFrame?.(raf); el.removeEventListener("scroll", upd); globalThis.removeEventListener?.("resize", upd); ro?.disconnect(); };
  }, [compact, more]);
  // In the sheet: Edit offices and Edit layout open their own editors (outside it): the sheet closes after their click.
  const sheetClick = (e) => { if (typeof e.target?.closest === "function" && e.target.closest(".oo-edit, .oo-layout")) closeMore(); };
  const tile = (icon, label, fn, cls, pressed) => html`<button type="button" class=${`oo-sheet-tile ${cls}`} aria-pressed=${pressed === undefined ? undefined : pressed ? "true" : "false"}
    onClick=${fn}><${Icon} name=${icon} size=${20} /><span>${label}</span></button>`;
  // M-3556: the bar in three groups — scope (which office, whom: left of the desk's one row), the display options (behind
  // ⚙) and the actions (right). A phone's ⋯ sheet lists all three in that order.
  const scopeItems = html`
      ${custom && !carouselPick && opening == null && !layout && overviewOk(stored) ? html`<button type="button" class="btn btn-sm oo-back-all" onClick=${() => pick(ALL_ID)}>${to("backAll")}</button>` : null}
      ${oneOffice ? null : html`<label class="oo-pick"><span class="oo-pick-label">${to("office")}</span>${officeSelect("oo-office")}</label>`}
      ${auto ? html`<label class="oo-pick"><span class="oo-pick-label">${to("show")}</span>
        <select class="tb-select oo-team" value=${teamValue} onChange=${(e) => { const o = opts.find((x) => x.value === e.target.value); setF({ ...f, team: o ? o.team : "" }); }}>
          ${opts.map((o) => html`<option key=${o.value} value=${o.value}>${o.label}</option>`)}
        </select></label>
        <${People} nodes=${everyone} pinned=${f.pinned} onChange=${(pinned) => setF({ ...f, pinned })} />` : null}
      ${carouselPick ? html`<div class="oo-carousel">
        <${CarouselOffices} stored=${stored} carIds=${carIds} open=${carMenu} onOpen=${setCarMenu} onToggle=${toggleCarId}
          onAll=${() => setCarIds(stored.map((o) => o.id))} onNone=${() => setCarIds([])} />
        <label class="oo-pick"><span class="oo-pick-label">${to("interval")}</span>
          <select class="tb-select oo-car-interval" value=${String(intervalOk(carSaved && carSaved.interval))} onChange=${(e) => setCarInterval(Number(e.target.value))}>
            ${INTERVALS.map((n) => html`<option key=${n} value=${n}>${n < 60 ? to("intervalSec", n) : to("intervalMin", n / 60)}</option>`)}
          </select></label>
        ${carChrome()}
      </div>` : null}
      ${custom && baseSkin.id !== custom.skin && !loading ? html`<span class="muted oo-note">${to("skinUnknown", styleName(custom.skin))}</span>` : null}
      ${placed.ignored ? html`<span class="muted oo-note">${to("layoutIgnored")}</span>` : null}
      ${L.unseated ? html`<span class="muted oo-note">${to("unseated", L.unseated)}</span>` : null}
`;
  const optionItems = html`
      ${auto ? html`<label class="oo-pick"><span class="oo-pick-label">${to("styleLabel")}</span>
        <select class="tb-select oo-style" value=${STYLES.includes(style) || packs.some((pk) => pk.id === style) ? style : skin.id} title=${to(canEdit ? "styleForAll" : "styleHere")} onChange=${(e) => pickStyle(e.target.value)}>
          ${styles.map((id) => html`<option key=${id} value=${id}>${to(`style_${id}`)}</option>`)}
          ${packs.map((pk) => html`<option key=${`pack:${pk.id}`} value=${pk.id}>${pk.name}</option>`)}
        </select></label>` : null}
      <label class="check oo-hide-asleep"><input type="checkbox" checked=${hideAsleep} onChange=${() => { const v = !hideAsleep; store.saveHideAsleep(v); setHideAsleep(v); setTip(null); }} /><span>${to("hideAsleep")}</span></label>
      <label class="check oo-hide-names"><input type="checkbox" checked=${namesOff} onChange=${() => { const v = !namesOff; store.saveNamesOff(v); setNamesOff(v); }} /><span>${to("hideNames")}</span></label>
      <label class="check oo-hide-mini"><input type="checkbox" checked=${miniOff} onChange=${() => { const v = !miniOff; store.saveMiniOff(v); setMiniOff(v); }} /><span>${to("hideMini")}</span></label>
      ${zones && !overview && !shared ? html`<label class="check oo-play"><input type="checkbox" checked=${playOn && !still} disabled=${still}
        onChange=${() => { const v = !playOn; store.savePlayOn(v); setPlayOn(v); }} /><span>${to("playOn")}</span>${playStillOff ? html`<span class="muted oo-note oo-play-still">${to("playMotionOff")}</span>` : null}</label>` : null}
      ${zones || overview ? html`<label class="check oo-night"><input type="checkbox" checked=${nightOn} onChange=${() => { const v = !nightOn; store.saveNightOn(v); setNightOn(v); }} /><span>${to("nightOn")}</span></label>` : null}
      <label class="check oo-dialogue" title=${to("dialogueTitle")}><input type="checkbox" checked=${dialogueOn} onChange=${toggleDialogue} /><span>${to("dialogue")}</span></label>
      ${chat && !shared ? html`<label class="oo-pick oo-talk-pick" title=${chatUi.talkWord("modeTitle")}><span class="oo-pick-label">${chatUi.talkWord("mode")}</span>
        <select class="tb-select oo-talk-mode" value=${tmode} onChange=${(e) => pickTalkMode(e.target.value)}>
          ${chatUi.TALK_MODES.map((m) => html`<option key=${m} value=${m}>${chatUi.talkWord(m)}</option>`)}
        </select></label>` : null}
      ${overview ? html`<label class="check oo-lobby-tile" title=${lobbyAll.length ? undefined : to("lobbyEveryone")}><input type="checkbox" checked=${lobbyOn && lobbyAll.length > 0}
        disabled=${!lobbyAll.length} onChange=${() => { const v = !lobbyOn; store.saveLobbyTile(v); setLobbyOn(v); setTip(null); }} /><span>${to("lobbyTile")}</span></label>
        ${lobbyAll.length ? null : html`<span class="muted oo-note oo-lobby-none">${to("lobbyEveryone")}</span>`}` : null}
      ${traffic ? html`<label class="check oo-key-tick" title=${to("keyTitle")}><input type="checkbox" checked=${keyOpen}
        onChange=${() => { const v = !keyOpen; store.saveKeyOpen(v); setKeyOpen(v); }} /><span>${to("key")}</span></label>` : null}
      ${styleErr && auto ? html`<span class="note oo-note oo-style-err" role="status">${styleErr}</span>` : null}
`;
  const actionItems = html`
      ${canEdit && storedRev !== null ? html`<button type="button" class="btn btn-sm oo-edit" onClick=${() => { if (!overview && !carouselPick) setEditing(true); }} disabled=${!!layout || overview || carouselPick}
        title=${overview || carouselPick ? to(carouselPick ? "carouselNoEdit" : "overviewNoEdit") : undefined}>${t("orge.edit")}</button>` : null}
      ${canLayout ? html`<button type="button" class="btn btn-sm oo-layout" onClick=${openLayout}>${t("orgl.edit")}</button>` : null}
      ${canShare ? html`<${ShareButton} offices=${stored} current=${overview ? "all" : custom ? custom.id : null} disabled=${!!layout}
        get=${lease ? (path, o) => lease.fetch(path, o) : undefined} />` : null}
`;
  // The sheet: a "Display options" heading over the options (a Hub room's too), a rule before the actions (a room has none).
  const hasActions = (canEdit && storedRev !== null) || canLayout || canShare;
  const barItems = html`${scopeItems}<h3 class="oo-sheet-h">${to("display")}</h3>${optionItems}
    ${hasActions ? html`<hr class="oo-sheet-rule" />` : null}${actionItems}`;
  // A room's dropdown hangs from the zoom stack's top, inside the stage (which clips): it is never taller than the
  // stage's room below its top (Prism #3556 P2: a 340 px stage); a longer list scrolls.
  // The bar's dropdown hangs below the bar: never past the window's bottom either (#4466: a longer list, a short window).
  const fitPop = (el) => {
    if (!el || typeof el.getBoundingClientRect !== "function") return;
    if (!roomGear) {
      const vh = globalThis.innerHeight;
      if (vh > 0) el.style.maxHeight = `${Math.min(popMaxHeight(vh, el.getBoundingClientRect().top), Math.floor(vh * 0.7), 480)}px`;
      return;
    }
    if (!stageRef.current) return;
    const st = stageRef.current.getBoundingClientRect(), top = el.getBoundingClientRect().top;
    if (st && st.height > 0) el.style.maxHeight = `${popMaxHeight(st.bottom, top)}px`;
  };
  const displayMenu = (opener) => html`<div class=${`oo-display${roomGear ? " oo-display-zoom" : ""}`} ref=${displayRef}>${opener}
    ${dispOpen ? html`<div class="oo-display-pop" role="group" aria-label=${to("display")} ref=${fitPop}><h3 class="oo-display-h">${to("display")}</h3>
      <div class="oo-bar oo-display-list">${optionItems}</div></div>` : null}</div>`;
  return html`<div class=${`oo${fs ? ` fs ${fs}` : ""}${compact ? " phone" : ""}${dockShown ? " has-dialogue" : ""}${sidePanel && !phone ? " ot-side" : ""}`} ref=${ooRef}>
    ${folded ? null : html`<div class="oo-bar oo-bar-row">
      <div class="oo-bar-scope">${scopeItems}</div>
      <div class="oo-bar-actions">${actionItems}
        ${displayMenu(html`<button type="button" class=${`btn btn-sm oo-display-btn${dispOpen ? " on" : ""}`} aria-expanded=${dispOpen ? "true" : "false"}
          onClick=${() => setDisp(!dispOpen)}><${Icon} name="settings" size=${14} /><span>${to("display")}</span></button>`)}
      </div>
    </div>`}
    ${compact && more ? html`<${Dialog} title=${to("office")} cls="oo-sheet" onClose=${closeMore}>
      ${compact ? html`<div class="oo-sheet-tiles">
        ${tile("fitwidth", to("fit"), () => { closeMore(); fit(); }, "oo-sheet-fit")}
        ${tile("fitwidth", to("fill"), toggleFill, "oo-sheet-fill", fitMode === "cover")}
        ${tile("fullscreen", to("fullscreen"), () => { closeMore(); enterFs(); }, "oo-sheet-fs")}
      </div>` : null}
      ${typeof onLive === "function" ? html`<label class="check oo-sheet-live"><input type="checkbox" checked=${!!live} onChange=${() => onLive(!live)} /><span>${to("live")}</span></label>` : null}
      <div class="oo-bar oo-sheet-bar" onClick=${sheetClick}>${barItems}</div>
    </${Dialog}>` : null}
    ${traffic && keyOpen ? html`<${OfficeKey} pal=${pal} />` : null}
    ${editing && !overview && !carouselPick ? html`<${OfficeEditor} offices=${stored} rev=${storedRev} view=${view} store=${store} packs=${packs}
      ask=${ask} current=${() => shown.current} onSaved=${adopt} onClose=${() => setEditing(false)} />` : null}
    ${overview || people.length || L.rooms.length ? null : html`<p class="note oo-empty">${to("nobody")} ${auto && (f.team || f.pinned.length) ? html`<button type="button" class="btn btn-sm" onClick=${() => setF({ team: "", pinned: [] })}>${to("everyone")}</button>` : null}</p>`}
    <div class=${`oo-stage${layout ? " editing" : ""}`} ref=${stageRef} onPointerDown=${onDown} onPointerMove=${onStageMove} onPointerUp=${onStageUp} onPointerCancel=${onStageCancel}
      onWheel=${onWheel} onKeyDown=${onKeyDown} onFocusIn=${onFocusIn} onClickCapture=${g.clickCapture}>
      ${dlgOn ? html`<div class="sr-only oo-dialogue-live" aria-live="polite">${dlgSay}</div>` : null}
      <canvas ref=${canvasRef} class=${`oo-canvas${(tipDesk && tipDesk.node.i) || dlgHot ? " hot" : ""}`} role="application" tabindex="0" aria-label=${to(carouselPick ? "labelCarousel" : overview ? "labelAll" : "label")}
        onPointerMove=${onMove} onPointerLeave=${() => setTip(null)} onClick=${onClick} ondblclick=${onDblClick}></canvas>
      ${tmode === "box" ? html`<${chatUi.TalkStage} peek=${stagePeek} ops=${stageOps} talk=${chat} read=${readMode} onRead=${pickRead} phone=${phone} still=${still}
        onFull=${openFull} onClose=${() => { dlg.skip(); setTalkTo(null); dlgWake(); }} />` : null}
      ${overview ? tiles.map((tl) => {
        const text = to("tileLabel", tl.name, tl.count), at = (el) => { if (el) labelEls.current.set(tl.key, el); else labelEls.current.delete(tl.key); };
        return tl.lobby ? html`<span key=${tl.key} ref=${at} class="oo-tile-label lobby">${text}</span>`
          : html`<button key=${tl.key} ref=${at} type="button" class="oo-tile-label" data-office=${tl.key} title=${to("openOffice", tl.name)} aria-label=${to("openOffice", tl.name)}
              onClick=${() => pick(tl.key, false)}>${text}</button>`;
      }) : null}
      ${layout ? html`<${LayoutEditor} key=${layout.id} base=${layout.base} start=${layout.start} place=${placeOverlay} dock=${!fs} members=${layoutMembers}
        stale=${layoutStale ? t("orgl.stale") : ""} onChange=${onDraft} onSave=${saveLayout} onClose=${closeLayout} />` : null}
      ${tipText && tip !== card ? html`<div ref=${tipRef} class="oo-tip" role="tooltip">
        <strong>${tipText.primary}</strong>${tipText.secondary ? html` <span class="muted mono">${tipText.secondary}</span>` : null}
        <div>${words ? stateOf(tipDesk.node) : tipText.sub}</div>${nowOf(tipDesk.node) ? html`<div class="muted">${nowOf(tipDesk.node)}</div>` : null}
        ${tipDesk.office ? html`<div class="muted oo-tip-office">${tipDesk.office}</div>` : null}
      </div>` : null}
      ${cardOf ? html`<${OfficeCard} key=${cardOf.key}
        model=${cardModel({ node: cardOf.node, lv, levels: wordsOf(cardOf.skin), share: !onOpen, rows: cardRows ? cardRows(cardOf.node.name) : null, display: cardName ? cardName(cardOf.node.name) : "",
          state: stateOf(cardOf.node), now: nowOf(cardOf.node),
          where: [cardOf.office || (custom ? custom.name : to("allOffice")), cardOf.area].filter(Boolean).join(" · ") })}
        avatar=${drawAvatar} sheet=${phone || size.w < SHEET_W} place=${(el) => { const was = cardEl.current; cardEl.current = el; if (!el || !el.classList?.contains("sheet")) unliftSheet(); placeCard();
          // #4379 review: the tags it covers (or uncovers) are judged at the next frame; a still scene draws one now.
          if (was !== el && scene.current) { scene.current.dirty = true; const go = () => (still ? draw(0) : loop.current?.wake()); if (typeof requestAnimationFrame === "function") requestAnimationFrame(go); else go(); } }}
        onChat=${onOpen ? () => { const n = cardOf.node.name; setCard(null); open(n); } : null} onFind=${findCard} onClose=${closeCard}
        rename=${onOpen && !readOnly ? { value: renames[cardOf.node.name] || "", save: (v) => setRenames(store.saveRename(cardOf.node.name, v)) } : null}
        onReact=${play ? (kind) => {
          const n = cardOf.node.name;
          if (kind === "feed" && !ASLEEP.has(cardOf.node.state) && !cardOf.box.night) {
            const sn = (armedSnack && snacksById.get(armedSnack)) || packSnacks[0] || null;
            if (sn || (skin.eatStrip && skin.eatStrip(n))) {
              const at = (zones && walkers.at(n, now())) || cardOf.box.seat || { x: cardOf.box.x + cardOf.box.w / 2, y: cardOf.box.y + cardOf.box.h };
              snacks.feed(n, sn, { x: at.x, y: at.y, t: now(), charEatStrip: skin.eatStrip ? skin.eatStrip(n) : null });
              walkNow.current?.();
            }
          }
          // A pat with the set's `pat` strip lasts one full pass of it (never shorter than the hearts).
          const t0 = now(), patSt = kind === "pat" && skin.patStrip ? skin.patStrip(n) : null;
          reacts.current.set(n, { kind, t0, ...(patSt ? { until: t0 + Math.max(PLAY.REACT_MS, stripDurationMs(patSt)) } : {}) });
          loop.current?.wake(); if (store.tellOn(n)) void store.tell(n, kind);
        } : null}
        tell=${play ? { on: store.tellOn(cardOf.node.name), set: (v) => { store.saveTell(cardOf.node.name, v); setTellRev((x) => x + 1); } } : null}
        packCard=${cardOf.skin?.pack?.card || null}
        picture=${typeof cardOf.skin?.picture === "function" ? cardOf.skin.picture : null}
        portrait=${cardOf.skin?.pack ? portraitSrc(cardOf.skin.pack, { agent: cardOf.node.name, state: cardOf.node.state }) : null}
        packScale=${cardOf.skin?.pack?.scale || 2} action=${cardAction ? cardAction(cardOf.node.name) : null}
        photo=${cardPhoto ? cardPhoto(cardOf.node.name) : null} />` : null}
      <ul class="oo-desks" aria-label=${to("desks")}>${people.map((d) => {
        const nt = nodeText(d.node), cap = nowOf(d.node), where = d.office ? ` · ${d.office}` : "";
        const full = words ? `${nt.primary} — ${stateOf(d.node)}` : nt.full;
        return html`<li key=${d.key}>${d.node.i
          ? html`<button type="button" class="oo-desk" data-name=${d.node.name} data-key=${d.key} data-slot=${Number.isInteger(d.box?.slot) ? d.box.slot : undefined} aria-label=${`${full}${where}${cap ? ` · ${cap}` : ""}.`} aria-haspopup="dialog"
              onFocus=${() => setTip(d.key)} onBlur=${() => setTip(null)} onClick=${() => { cardFrom.current = d.key; setCard((cur) => (cur === d.key ? null : d.key)); }}>${nt.primary}</button>`
          : html`<span class="oo-desk" data-name=${d.node.name} data-key=${d.key}>${full}</span>`}</li>`;
      })}</ul>
      <div class="oc-zoom oo-zoom" role="group" aria-label=${to("view")}>
        <output ref=${pctRef} class="oo-zoom-pct"></output>
        <button type="button" class="icon-btn oo-zoom-in" aria-label=${to("zoomIn")} title=${to("zoomIn")} onClick=${() => zoomStep(1)}><${Icon} name="plus" size=${16} /></button>
        <button type="button" class="icon-btn oo-zoom-out" aria-label=${to("zoomOut")} title=${to("zoomOut")} onClick=${() => zoomStep(-1)}><${Icon} name="minus" size=${16} /></button>
        <button type="button" class="icon-btn oo-fit" aria-label=${to("fit")} title=${to("fit")} onClick=${() => fit()}><${Icon} name="fitwidth" size=${16} /></button>
        <button type="button" class=${`icon-btn oo-fill${fitMode === "cover" ? " on" : ""}`} aria-pressed=${fitMode === "cover" ? "true" : "false"} aria-label=${to("fillTitle")}
          title=${to("fillTitle")} onClick=${toggleFill}>${to("fill")}</button>
        <button type="button" class="icon-btn oo-fs" aria-label=${to(fs ? "exitFullscreen" : "fullscreen")} title=${to(fs ? "exitFullscreen" : "fullscreen")} onClick=${toggleFs}><${Icon} name=${fs ? "fullscreenexit" : "fullscreen"} size=${16} /></button>
        ${roomGear ? displayMenu(html`<button type="button" class=${`icon-btn oo-options${dispOpen ? " on" : ""}`} aria-expanded=${dispOpen ? "true" : "false"} aria-label=${to("display")} title=${to("display")} onClick=${() => setDisp(!dispOpen)}><${Icon} name="settings" size=${16} /></button>`) : null}
      </div>
      ${showSnacks ? html`<div ref=${snackTrayRef} class="oo-snacks" role="toolbar" aria-label=${to("snacks")}>
        ${packSnacks.map((sn) => {
          const lb = snackLabel(sn, lang());
          return html`<button key=${sn.id} type="button" class="icon-btn oo-snack" data-snack=${sn.id}
            aria-label=${to("snackArm", lb)} title=${lb} aria-pressed=${armedSnack === sn.id ? "true" : "false"}
            onPointerDown=${(e) => onSnackDown(sn, e)}
            onClick=${(e) => { e.stopPropagation(); if (snackSwallowRef.current) return; setArmedSnack((cur) => (cur === sn.id ? null : sn.id)); }}>
            <canvas class="oo-snack-icon" width="28" height="28" aria-hidden="true" ref=${paintSnackIcon(sn.sprite, 28)}></canvas>
          </button>`;
        })}
      </div>` : null}
      ${snackDrag ? html`<div class="oo-snack-ghost" aria-hidden="true" ref=${(el) => {
        snackGhostRef.current = el;
        if (el && el.style && snackGhostPosRef.current) el.style.setProperty("transform", `translate(${snackGhostPosRef.current.x}px, ${snackGhostPosRef.current.y}px)`);
      }}>
        <canvas class="oo-snack-icon" width="28" height="28" ref=${paintSnackIcon(snackDrag.snack.sprite, 28)}></canvas>
        ${snackDrag.kind === "feed" ? html`<span class="oo-snack-hint">${to("snackFeed", snackDrag.label)}</span>`
          : snackDrag.kind === "place" ? html`<span class="oo-snack-hint">${to("snackPlace")}</span>` : null}
      </div>` : null}
      ${fs ? html`<div class="oo-fs-bar">${oneOffice ? null : officeSelect("oo-fs-office")}${carChrome()}</div>` : null}
      ${miniOff ? null : html`<svg ref=${miniRef} class="oc-mini oo-mini" viewBox=${`0 0 ${Math.max(1, L.width)} ${Math.max(1, L.height)}`} aria-hidden="true" onClick=${onMini}>
        <title>${to("overview")}</title>
        <rect class="oo-mini-matte" x=${-L.width} y=${-L.height} width=${L.width * 3} height=${L.height * 3} fill=${matte} />
        <rect class="oo-mini-scene" x="0" y="0" width=${L.width} height=${L.height} />
        ${miniRects.map((r) => html`<rect key=${r.key} class="oo-mini-room" x=${r.x} y=${r.y} width=${r.w} height=${r.h} />`)}
        ${people.map((d) => html`<circle key=${d.key} class=${`oo-mini-dot st-${d.node.state}${q && hits(d.node, q) ? " match" : ""}`} cx=${d.dot.x} cy=${d.dot.y} r=${dotR} />`)}
        <rect ref=${miniViewRef} class="oc-mini-view oo-mini-view" />
      </svg>`}
    </div>
    ${zoneList.length ? html`<div class="oo-zone-pills" role="group" aria-label=${to("zones")} ref=${pillsRef} onScroll=${pillsCue}>
        <button type="button" class="btn btn-sm oo-zone-all" onClick=${() => fit()}>${to("zoneAll")}</button>
        ${zoneList.map((z) => html`<button key=${z.key} type="button" class="btn btn-sm oo-zone" data-area=${z.key} onClick=${() => toZone(z)}>${to("zoneN", areaName(z.key), z.n)}</button>`)}
      </div>` : null}
    ${dockShown ? html`<canvas class="oo-dialogue-canvas" ref=${dialogueCanvasRef}
      role=${onOpen && !shared ? "button" : "img"} tabindex=${onOpen && !shared ? "0" : null}
      aria-label=${onOpen && !shared ? to("dlgOpenChat") : dlgSay} title=${onOpen && !shared ? to("dlgOpenChat") : null}
      onClick=${openDialogue} onKeyDown=${openDialogue}></canvas>` : null}
    ${tmode === "bubble" ? html`<${chatUi.TalkBar} talk=${chat} name=${talkTo} label=${talkLabel} onFull=${openFull}
      read=${readMode} onRead=${pickRead} onSkip=${skipTalk} />` : null}
    ${sidePanel ? html`<${chatUi.TalkPanel} talk=${chat} name=${talkTo} label=${talkLabel} state=${talkWho ? talkWho.node.state : null} stateLabel=${talkWho ? stateOf(talkWho.node) : null} sheet=${phone}
      onClose=${() => setTalkTo(null)} onFull=${openFull} top=${stageRef.current ? stageRef.current.offsetTop : null} />` : null}
  </div>`;
}
