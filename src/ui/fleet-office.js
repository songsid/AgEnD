// Fleet → Org chart → Office: the fleet as a small pixel office, the third view beside Canvas and List
// (fleet-canvas.js). The same data as theirs: the structure from /ui/org (buildOrgView), the live state from the app
// store, the traffic from fleet-traffic.js's store — nothing new is read but the offices people made (/ui/offices).
//
// - Two layouts, by skin. Desks (the built-in "pixel" skin, the default): each team is a room, each member a desk with a
//   name tag; General and the instances in no team share the lobby; a grid that wraps at the stage's width
//   (fleet-office-model.js autoLayout). Zones (a skin whose pack maps states to areas — the built-in "studio"): a
//   1280×720 scene; each instance takes a seat in the area for its state and walks there along the pack's waypoints
//   when its state changes (fleet-office-zones.js).
// - #2540: the canvas fills the Fleet panel (no frame: the whole width of the Fleet area, down to the window's foot);
//   the scene is panned and zoomed as the org chart's canvas is (fleet-canvas-view.js: drag, wheel, pinch, + / − / Fit
//   and the `+ - 0` keys, an overview), Fit filling the panel (contain; Fill: cover), + and − in pixel levels, the zoom
//   shown as a percentage, around it a matte (fleet-office-view.js). The view (zoom and centre) and the fit mode are
//   kept per device per office and style. Everything on the scene — hit-testing, tooltips, Edit layout's handles —
//   goes through the same view transform.
// - Speech bubbles: now and then a short line for its state (typed out; at once with reduced motion) — the page's own
//   lines or the skin's, never anything an agent said. Furniture can react: an item with `activeWhen` animates while
//   anyone shown is in that state.
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
import { html, useEffect, useLayoutEffect, useMemo, useRef, useState } from "/assets/app-html.js";
import { appStore } from "/assets/app-store.js";
import { t, lang, register } from "/assets/app-i18n.js";
import { identityOf } from "/assets/identity-color.js";
import { Icon } from "/assets/ui-icons.js";
import { nodeText } from "./fleet-org.js";
import { hits, needle } from "./fleet-canvas-layout.js";
import { AUTO_ID, LOBBY, autoLayout, backingScale, coatOf, createFlights, customLayout, deskAt, desksOf, filterOk, lampOf, layoutOk, lightOf, membersOf,
  officePose, officeRooms, signOf, workOn } from "./fleet-office-model.js";
import { BUILT_IN_SKINS, CHAR_DEPTH, DEFAULT_PAL, bubbleBox, loadPackSkin, modeOf, skinFor, tagBox } from "./fleet-office-skin.js";
import { CALLING, activeFurniture, bubbleAt, bubbleRank, createWalkers, linesFor, personAt, placeBubbles, thinBubbles, zonesLayout } from "./fleet-office-zones.js";
import { createOfficeStore } from "./fleet-office-store.js";
import { OfficeEditor, officeForSave } from "./fleet-office-editor.js";
import { LayoutEditor, handlesOf } from "./fleet-office-layout.js";
import { applyOverrides } from "./fleet-office-pack.js";
import { centreOn, gestureState, gestures, miniPoint, toScreen, toWorld, wheelFactor, zoomKey, zoomTo } from "./fleet-canvas-view.js";
import { OK_MAX, OK_MIN, clampPan, desksK, edgeMatte, edgeStrips, fitScene, layerScale, miniBox, miniFrame, openingView, pinchOffice, savedOf, stepK, viewFromSaved,
  zoomLabel, zoomOffice } from "./fleet-office-view.js";

register("orgo", {
  en: {
    label: "Office: each team is a room and each instance a desk; General and the instances in no team are in the lobby. Drag to pan; the wheel, a pinch, + and − zoom, 0 fits, F is fullscreen.",
    office: "Office", allOffice: "Whole fleet", show: "Show", allTeams: "All teams", lobby: "Lobby (General, no team)", lobbyRoom: "Lobby",
    people: "People", peopleN: "People ({0})", findPerson: "Find a person", everyone: "Show everyone", nobody: "No one here matches this filter.",
    unseated: "{0} without a seat", skinUnknown: "Its style “{0}” is not available here: drawn as Desks.", closed: "Closed", desks: "Desks", tapAgain: "Tap again to open the chat",
    capWorking: "Typing away", capIdle: "Tea break", capPaused: "Asleep", capNeeds: "Calling for you", capAway: "Desk empty", capStarting: "Just arriving", capQueued: "Waiting to start",
    styleLabel: "Style", style_pixel: "Desks", style_studio: "Studio", area_desks: "Work", area_lounge: "Lounge", area_alert: "Help desk", area_nap: "Nap corner",
    b_working: "On it.|Typing…|Almost there|In the zone|One more test", b_idle: "Tea time|Ready when you are|Stretching|Anything for me?",
    b_paused: "Zzz…|Back later", b_stopped: "Off duty|Zzz…", b_needs: "Need you!|A question for you|Over here!",
    b_crashed: "Ouch, crashed|Help!", b_stuck: "Hmm, stuck?|Still thinking…",
    hideAsleep: "Hide paused and stopped", layoutIgnored: "Its saved layout does not fit this style: drawn as the style's own.",
    fit: "Fit the office", overview: "Overview: click to move there", fullscreen: "Fullscreen", exitFullscreen: "Exit fullscreen",
    fill: "Fill", fillTitle: "Fill the panel (the scene's overflow is cropped; drag to see it)", zoomLevel: "Zoom {0}",
  },
  "zh-TW": {
    label: "辦公室：每個 team 是一間房間，每個 instance 一張桌子；General 和未加入 team 的 instance 在大廳。拖曳平移；滾輪、雙指、+ 和 − 縮放，0 顯示整個場景，F 切換全螢幕。",
    office: "辦公室", allOffice: "整個 fleet", show: "顯示", allTeams: "所有 team", lobby: "大廳（General、未加入 team）", lobbyRoom: "大廳",
    people: "成員", peopleN: "成員（{0}）", findPerson: "尋找成員", everyone: "顯示全部", nobody: "沒有符合這個篩選的成員。",
    unseated: "{0} 位沒有座位", skinUnknown: "這裡沒有它的風格「{0}」：以辦公桌顯示。", closed: "休息中", desks: "桌子", tapAgain: "再點一下開啟聊天",
    capWorking: "埋頭打字中", capIdle: "喝茶休息", capPaused: "睡著了", capNeeds: "在呼叫你", capAway: "空位", capStarting: "剛到座位", capQueued: "等待啟動",
    styleLabel: "風格", style_pixel: "辦公桌", style_studio: "工作室", area_desks: "工作區", area_lounge: "休息區", area_alert: "求救區", area_nap: "午睡角",
    b_working: "處理中|打字中…|快好了|專心中|再測一次", b_idle: "喝茶中|隨時可以開工|伸個懶腰|有事找我嗎？",
    b_paused: "Zzz…|晚點回來", b_stopped: "下班了|Zzz…", b_needs: "需要你！|有個問題|在這裡！",
    b_crashed: "糟糕，當掉了|救命！", b_stuck: "嗯，卡住了？|還在想…",
    hideAsleep: "隱藏暫停與停止的成員", layoutIgnored: "它儲存的配置不適用這個風格：以風格本身的配置顯示。",
    fit: "顯示整個辦公室", overview: "總覽：點一下移到那裡", fullscreen: "全螢幕", exitFullscreen: "結束全螢幕",
    fill: "填滿", fillTitle: "填滿整個面板（超出的部分會被裁切，拖曳即可看到）", zoomLevel: "縮放 {0}",
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
    fx: { task: v("--fx-task", D.fx.task), send: v("--fx-send", D.fx.send), report: v("--fx-report", D.fx.report), broadcast: v("--fx-broadcast", D.fx.broadcast) },
  };
}

/** The team picker's choices: option values are indexes (a team's name can be anything). */
function teamOptions(view) {
  return [{ value: "all", team: "", label: to("allTeams") }, { value: "lobby", team: LOBBY, label: to("lobby") },
    ...view.teams.map((tm, i) => ({ value: `t${i}`, team: tm.name, label: tm.name }))];
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
 * `lease` the tab's (its reads); `onOpen(name)` what a desk opens (the canvas's: the chat).
 */
export function Office({ view, traffic, q = "", lease, onOpen }) {
  const store = useMemo(() => createOfficeStore(lease ? { fetch: (path, o) => lease.fetch(path, o) } : {}), [lease]);
  const [stored, setStored] = useState([]);
  const [storedRev, setStoredRev] = useState(null);                  // the rev the list was read at (a save sends it)
  const [canEdit, setCanEdit] = useState(false);                      // an admin session (never a guest or the public link)
  const [editing, setEditing] = useState(false);
  const [choice, setChoice] = useState(() => store.choice());
  const [filter, setFilter] = useState(() => store.filter());
  const [style, setStyle] = useState(() => store.skin());
  const [hideAsleep, setHideAsleep] = useState(() => store.hideAsleep());
  const [packs, setPacks] = useState([]);                             // the skin packs the host keeps: [{ id, name, sha }]
  const [packSkins, setPackSkins] = useState(() => new Map());        // id@sha → a loaded skin, or null (not a pack)
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
  const stageRef = useRef(null), canvasRef = useRef(null), tipRef = useRef(null), lastType = useRef("mouse");
  // Fullscreen: null, "native" (the Fullscreen API) or "immersive" (the CSS cover); per visit, never kept.
  const ooRef = useRef(null), [fs, setFs] = useState(null), fsRef = useRef(null), fsAsked = useRef(false), fsTarget = useRef(null);
  fsRef.current = fs;
  const flights = useMemo(() => createFlights(), []);
  const walkers = useMemo(() => createWalkers(), []);
  const seatsRef = useRef(new Map());                                 // the zones layout's last seats: kept where they can be
  const still = useMemo(reducedMotion, []);

  // The host's offices: on opening, and again whenever the stream says they changed. Answers can arrive out of order
  // (#2431 review): one with an older rev than the list shown is dropped when it was asked for before that list
  // arrived; one asked for after it is newer whatever its rev (a host whose store was reset starts again at 0).
  // The editor's save and its 409 re-read are stamped when sent (`ask`), never when answered; `adopt` returns the
  // snapshot in force, so a re-read the stream overtook leaves the editor's draft on the newer one.
  const asked = useRef(0), shown = useRef(null);                      // a counter; shown: { rev, offices, arrived }
  const ask = () => ++asked.current;
  const adopt = (d, askedAt) => {
    const cur = shown.current;
    if (!d) return cur;
    if (cur && d.rev < cur.rev && askedAt <= cur.arrived) return cur;
    shown.current = { rev: d.rev, offices: d.offices, arrived: ++asked.current };
    setStored(d.offices); setStoredRev(d.rev);
    return shown.current;
  };
  useEffect(() => {
    if (!lease) return undefined;
    const read = async () => { const at = ask(); const d = await store.offices(); if (lease.current()) adopt(d, at); };
    void read();
    const sub = appStore.get().streamOn;
    const off = sub ? lease.hold(sub("offices", () => { void read(); })) : null;
    return () => { if (off) off(); };
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
  // the public link (whose sessions the host refuses outright).
  useEffect(() => {
    const body = globalThis.document?.body;
    if (!body || body.dataset.tier === "guest" || body.dataset.publicLink === "1") return undefined;
    let live = true;
    const auth = globalThis.AgendAuth;
    if (auth && typeof auth.canWrite === "function") Promise.resolve(auth.canWrite()).then((v) => { if (live) setCanEdit(v === true); }, () => {});
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

  const custom = choice !== AUTO_ID ? stored.find((o) => o.id === choice) || null : null;
  // The style: a built-in one, or an uploaded pack once it is loaded (until then, and when it is not one, Desks).
  const wanted = custom ? custom.skin : style;
  const packInfo = STYLES.includes(wanted) ? null : packs.find((pk) => pk.id === wanted) || null;
  const packKey = packInfo ? `${packInfo.id}@${packInfo.sha}` : null;
  useEffect(() => {
    if (!packInfo || packSkins.has(packKey)) return undefined;
    let live = true;
    const get = lease ? (path, o) => lease.fetch(path, o) : undefined;
    loadPackSkin(packInfo.id, packInfo.sha, get ? { fetch: get } : {}).then((sk) => { if (live) setPackSkins((m) => new Map(m).set(packKey, sk)); });
    return () => { live = false; };
  }, [packKey]);
  const loading = !!packInfo && !packSkins.has(packKey);
  const baseSkin = packInfo ? packSkins.get(packKey) || skinFor("pixel") : skinFor(STYLES.includes(wanted) ? wanted : custom ? wanted : "pixel");
  const zones = !!(baseSkin.pack && baseSkin.pack.stateZones);
  /** The style's identity: a pack's id and sha (a pack replaced is another), or the built-in skin's id. */
  const styleKey = packKey || baseSkin.id;
  // An open session no longer on its office and style (the office went, or its style changed meanwhile): only Cancel.
  const layoutStale = !!layout && (!custom || custom.id !== layout.officeId || custom.skin !== layout.skin || styleKey !== layout.pack || !zones || loading);
  // A stored office's own layout on a zones style (its overrides; while Edit layout is open, the draft).
  const placed = useMemo(() => {
    if (!zones) return { skin: baseSkin, ignored: false };
    if (layout && !layoutStale) return { skin: { ...baseSkin, pack: layout.draft }, ignored: false };
    const ov = custom && custom.overrides;
    if (!ov || ov.pack !== baseSkin.id) return { skin: baseSkin, ignored: false };
    const a = applyOverrides(baseSkin.pack, ov);
    return a.ok ? { skin: { ...baseSkin, pack: a.pack }, ignored: false } : { skin: baseSkin, ignored: true };
  }, [baseSkin, zones, custom, layout, layoutStale]);
  const skin = placed.skin;
  const L = useMemo(() => {
    const all = custom ? membersOf(custom, view) : [...new Map(officeRooms(view, filter).flatMap((r) => r.nodes).map((n) => [n.name, n])).values()];
    const keep = (n) => !(hideAsleep && ASLEEP.has(n.state));
    const nodes = all.filter(keep);
    if (zones) { const z = zonesLayout(skin.pack, nodes, seatsRef.current); seatsRef.current = z.seats; return z; }
    // The desks wrap at the stage's width at the scale they open on (desksK: a pixel level near one CSS px a unit).
    const deskW = Math.max(240, Math.floor(width / desksK(ratio)));
    if (!custom) return autoLayout(officeRooms(view, filter).map((r) => (hideAsleep ? { ...r, nodes: r.nodes.filter(keep) } : r)), { width: deskW });
    const lay = custom.layout || layoutOk(skin.layout);
    return lay ? customLayout({ ...custom, layout: lay }, nodes) : autoLayout([{ key: custom.id, name: custom.name, lobby: false, nodes }], { width: deskW });
  }, [view, filter, custom, width, ratio, skin, hideAsleep]);
  const looks = useMemo(() => {
    const work = workOn(traffic);
    return new Map(L.rooms.flatMap((r) => r.desks).map((d) => {
      const n = d.node;
      if (!n) return [d.key, { name: "", label: "", state: "missing", pose: "away", light: null, lamp: false, sign: null, coat: "", work: 0, dim: !!q, match: false, free: zones }];
      const match = !!q && hits(n, q);
      return [d.key, { name: n.name, label: nodeText(n).primary, state: n.state, pose: officePose(n.state), light: lightOf(n.state), lamp: lampOf(n.state),
        sign: zones ? null : signOf(n.state), coat: coatOf(n.i, n.i ? identityOf(n.i) : null, mode), work: work.get(n.name) || 0, dim: !!q && !match, match, free: zones }];
    }));
  }, [L, traffic, q, mode, themeRev]);
  useEffect(() => { flights.sync(traffic || [], now(), still); }, [traffic]);
  // Zones: everyone's seat is where they walk to.
  useEffect(() => {
    if (!zones) return;
    walkers.sync(new Map(desksOf(L).map((d) => [d.node.name, d.seat])), now(), L, still);
    loop.current?.wake();
  }, [L]);

  // ── The view (#2540): { k, x, y } as the org chart canvas's (fleet-canvas-view.js) — logical units → the stage's CSS
  // px. Set without a render (a ref): the canvas redraws, the overview, the tooltip and Edit layout's overlay follow ──
  const vp = useRef(null), raw = useRef(1);                          // raw: the wheel's and a pinch's zoom (before the range)
  // touched: a person moved the view (it is kept); fitted: the view is a fit (a resize fits it again, to the new size).
  const touched = useRef(false), fitted = useRef(false), drag = useRef(gestureState());
  const miniViewRef = useRef(null), miniRef = useRef(null), overlayEl = useRef(null), tipDeskRef = useRef(null), pctRef = useRef(null);
  const officeKey = `${custom ? custom.id : AUTO_ID}@${baseSkin.id}`;   // what a view is kept for: the office and its style
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
    }
    const pc = pctRef.current;
    if (pc) { const lb = zoomLabel(v.k); if (pc.textContent !== lb) pc.textContent = lb; pc.setAttribute("aria-label", to("zoomLevel", lb)); }
    if (overlayEl.current) placeOverlay(overlayEl.current);
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
  /** The view an office opens on: its kept one (a kept fit: fitted to this size), else its opening; and whether a fit. */
  const openView = () => {
    const kept = store.view(officeKey);
    if (kept && kept.fit) return { v: fitScene(L.width, L.height, size, fitMode), fit: true };
    if (kept) return { v: viewFromSaved(kept, size), fit: false };
    return { v: openingView(L.width, L.height, size, ratio, zones, fitMode), fit: zones };
  };
  // An office (or style) opened: its kept view, else its opening (zones fitted; desks from the top left). A resize fits
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
      if (fitted.current) vp.current = fitScene(L.width, L.height, size, fitMode);
      else if (!touched.current) reopen();
      else { const v = vp.current, cx = (was.w / 2 - v.x) / v.k, cy = (was.h / 2 - v.y) / v.k; vp.current = { k: v.k, x: size.w / 2 - cx * v.k, y: size.h / 2 - cy * v.k }; }
    } else if (fitted.current) vp.current = fitScene(L.width, L.height, size, fitMode);   // the scene's size changed
    vp.current = clampPan(view0(), L.width, L.height, size);
    raw.current = vp.current.k;
  }, [officeKey, size.w, size.h, ratio, L.width, L.height]);
  useEffect(() => () => flushSave(), []);
  /** Fit (the button, `0`): the office's mode — `mode` when it was just switched. */
  const fit = (mode = fitMode) => { const v = fitScene(L.width, L.height, size, mode); raw.current = v.k; setView(v, true, true); };
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
  const open = (name) => { if (fsRef.current) exitFs(); onOpen(name); };

  // ── Drawing: the back and front layers are pictures of the scene at the view's resolution (remade when the office
  // or the zoom changes, never on a pan); each frame draws the matte, the layers, the people and the items in the air ──
  const scene = useRef(null);
  const loop = useRef(null);
  // The matte around the scene: the pack's own, else its background's edge (sampled once), else the skin's (tokens).
  const matte = (skin.pack && skin.pack.matte) || sampledMatte(skin.backdrop) || (skin.matte ? skin.matte({ pal, mode }) : pal.bg);
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
    const all = L.rooms.flatMap((r) => r.desks);
    /** The layers at `ls` layer px per logical unit. */
    const paint = (ls) => {
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
      const front = zones ? null : layer((g) => { for (const d of all) skin.drawDeskFront(g, d, looks.get(d.key), env); });
      return { ls, back, front };
    };
    const shown = new Set([...looks.values()].map((l) => l.state));
    scene.current = { ctx, ratio, BW, BH, paint, layers: null, matte, env, desks: all.filter((d) => d.node), looks, L, skin, zones, dirty: true,
      active: zones ? activeFurniture(skin.pack, shown) : new Set(), lines: bubbleDefaults(), lang: lang() };
    if (still) draw(0); else loop.current?.wake();
  }, [L, looks, skin, pal, size.w, size.h, ratio, matte]);

  /** One frame at `ms` (0: still); whether anything is moving (in the air, or someone walking). */
  function draw(ms) {
    const s = scene.current;
    if (!s) return false;
    const { ctx, BW, BH, env, skin: sk } = s;
    // The view in bitmap px: a logical unit is `a` px (a whole number at a pixel level), the origin on a whole px.
    const v = view0(), a = v.k * s.ratio, ox = Math.round(v.x * s.ratio), oy = Math.round(v.y * s.ratio);
    const ls = layerScale(a, s.L.width, s.L.height);
    if (!s.layers || s.layers.ls !== ls) s.layers = s.paint(ls);
    const T = () => ctx.setTransform(a, 0, 0, a, ox, oy);
    const blit = (c) => { if (!c) return; ctx.setTransform(a / ls, 0, 0, a / ls, ox, oy); ctx.drawImage(c, 0, 0); T(); };
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, BW, BH);
    ctx.fillStyle = s.matte; ctx.fillRect(0, 0, BW, BH);
    ctx.imageSmoothingEnabled = false;
    blit(s.layers.back);
    T();
    const speakers = [], tags = [];
    const up = still ? [] : flights.frame(ms, s.L);
    let walking = false;
    if (s.zones) {
      // Furniture under the people; the people (nearest last) with the furniture whose depth is "y" among them, by base
      // y (a tie: the item first, the person in front); furniture over them; things in the air; the pack's foreground
      // (door frames, pillars, table fronts); then what must stay readable: crowd counts and name tags (bubbles below).
      const t = ms > 0 ? ms : now();
      const people = s.desks.map((d) => {
        const at = walkers.at(d.node.name, t) || { ...d.seat, walking: false };
        if (at.walking) walking = true;
        return { d, at, look: s.looks.get(d.key) };
      }).sort((a, b) => a.at.y - b.at.y);
      const furniture = s.skin.pack.furniture;
      const band = [...furniture.filter((f) => f.depth === "y").map((f) => ({ y: f.y, k: 0, f })), ...people.map((p) => ({ y: p.at.y, k: 1, p }))]
        .sort((a, b) => a.y - b.y || a.k - b.k);
      for (const f of furniture) if (f.depth !== "y" && f.depth < CHAR_DEPTH) sk.drawFurniture(ctx, f, s.active.has(f.id), ms, env);
      for (const { f, p } of band) {
        if (f) { sk.drawFurniture(ctx, f, s.active.has(f.id), ms, env); continue; }
        const box = { ...p.d, x: p.at.x - 44, y: p.at.y - 53, w: 88, h: 53, seat: { x: p.at.x, y: p.at.y } };
        sk.drawCharacter(ctx, box, p.at.walking ? { ...p.look, pose: "walk", heading: p.at.heading } : p.look, ms, env);
        if (!p.at.walking) speakers.push({ look: p.look, x: p.at.x + 10, y: p.at.y - 50, area: p.d.area });
      }
      for (const f of furniture) if (f.depth !== "y" && f.depth >= CHAR_DEPTH) sk.drawFurniture(ctx, f, s.active.has(f.id), ms, env);
      for (const it of up) sk.drawProp(ctx, it, ms, env);
      if (sk.drawForeground) sk.drawForeground(ctx, s.L, env);
      // Who found no spot in an area: a count in its corner (never over its name).
      for (const [a, n] of s.L.crowd || []) if (s.L.areas[a] && sk.drawCrowd) sk.drawCrowd(ctx, s.L.areas[a], n, env);
      // In an area over capacity the name tags show on hover or focus only (#2513: a crowd's tags covered each other).
      const over = s.L.over || new Set(), hot = tipNow.current;
      for (const p of people) {
        if (over.has(p.d.area) && p.d.key !== hot && !p.look.match) continue;
        sk.drawTag(ctx, p.at.x, p.at.y, p.look, env);
        tags.push(tagBox(ctx, p.at.x, p.at.y, p.look.label));
      }
    } else {
      for (const d of s.desks) { const look = s.looks.get(d.key); sk.drawCharacter(ctx, d, look, ms, env); speakers.push({ look, x: d.x + 58, y: d.y + 12 }); }
      blit(s.layers.front);
      for (const it of up) sk.drawProp(ctx, it, ms, env);
    }
    // Speech bubbles: a short line for the state, now and then (typed out; whole at once when still), placed so no two
    // overlap (placeBubbles; #2431).
    const bubbles = [];
    for (const sp of speakers) {
      if (sp.look.dim || sp.look.pose === "away") continue;
      const b = bubbleAt(sp.look.name, sp.look.state, ms, linesFor(sp.look.state, s.lang, sk.pack, s.lines));
      if (b) bubbles.push({ key: sp.look.name, area: sp.area, state: sp.look.state, calling: CALLING.has(sp.look.state), rank: bubbleRank(sp.look.state), shown: b.shown,
        box: bubbleBox(ctx, sp.x, sp.y, b.text), tail: { x: sp.x, y: sp.y }, sp, b });
    }
    // A crowded area speaks less (thinBubbles: calls, then work, a few at most); no bubble covers a name tag.
    for (const { sp, b, dy } of placeBubbles(thinBubbles(bubbles, s.zones ? s.L.over : null), 22, tags)) sk.drawBubble(ctx, sp.x, sp.y, [...b.text].slice(0, b.shown).join(""), env, -dy);
    return walking || up.length > 0 || flights.size() > 0;
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

  // Preact owns the markup, not the view: put it back on the overview, the overlay and the tooltip after every render.
  const tipDesk = tip ? desksOf(L).find((d) => d.key === tip) || null : null;
  tipDeskRef.current = tipDesk;
  useLayoutEffect(mark);
  // ── Pointing (#2540: through the view): hover (or a first tap) shows a desk's card, a click (or a second tap) opens
  // its chat; a drag on the scene pans it (never on Edit layout's handles: they move), the wheel and a pinch zoom ──
  const deskOf = (e) => {
    const r = canvasRef.current ? canvasRef.current.getBoundingClientRect() : null;
    if (!r) return null;
    const { x, y } = toWorld(view0(), e.clientX - r.left, e.clientY - r.top);
    // The zones scene draws people where they walk: they are hit there, not at the seat they are heading for, and in
    // the box the skin draws them in (an uploaded character's strip, anchor and size: #2513 review), nearest first.
    if (!zones) return deskAt(L, x, y);
    const t = now(), s = scene.current, sk = (s && s.skin) || skin, lk = s ? s.looks : looks;
    return personAt(L.rooms.flatMap((rm) => rm.desks), x, y, (d) => walkers.at(d.node.name, t),
      (d, at) => (sk.charBox && lk.get(d.key) ? sk.charBox(lk.get(d.key), at) : null));
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
    if (!onScene(e.target) && !(typeof e.target?.closest === "function" && e.target.closest(".ol-handle"))) return;
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
    const name = el.classList && el.classList.contains("oo-desk") ? el.getAttribute("data-name") : null;
    const d = name ? desksOf(L).find((x) => x.node.name === name) : null;
    if (d) show(d);
  };
  const onMove = (e) => { if (e.pointerType === "touch" || g.busy()) return; const d = deskOf(e); const key = d ? d.key : null; if (key !== tip) setTip(key); };
  const onClick = (e) => {
    const d = deskOf(e);
    if (!d || !d.node.i) { setTip(null); return; }
    if (lastType.current === "touch" && tip !== d.key) { setTip(d.key); return; }   // a first tap shows; a second opens
    open(d.node.name);
  };
  const onMini = (e) => {
    const w = miniPoint(miniRef.current ? miniRef.current.getBoundingClientRect() : null, { x: 0, y: 0, w: L.width, h: L.height }, e.clientX, e.clientY);
    if (w) setView(centreOn(view0(), size, w.x, w.y));
  };

  const auto = !custom;
  // Edit layout: an admin, a stored office, a zones style (built in, or a pack loaded here); not while the offices'
  // editor is open, nor a second session.
  const canLayout = canEdit && storedRev !== null && !!custom && zones && !loading && baseSkin.id === custom.skin && !editing && !layout;
  const openLayout = () => {
    setLayout({ id: ++layoutSeq.current, officeId: custom.id, skin: custom.skin, pack: styleKey, base: baseSkin.pack, start: skin.pack, draft: skin.pack, rev: storedRev, list: stored });
    setTip(null);
  };
  const closeLayout = () => setLayout(null);
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
  const styleName = (id) => (STYLES.includes(id) ? to(`style_${id}`) : (packs.find((pk) => pk.id === id) || { name: id }).name);
  const f = filterOk(filter);
  const opts = teamOptions(view);
  const teamValue = (opts.find((o) => o.team === f.team) || opts[0]).value;
  const setF = (next) => { const v = filterOk(next); store.saveFilter(v); setFilter(v); };
  // While Edit layout is open the office stays (its picker is disabled; this is the guard behind it).
  const pick = (id) => { if (layoutRef.current) return; store.saveChoice(id); setChoice(id); setTip(null); };
  const everyone = useMemo(() => { const m = new Map(); for (const n of [...view.top, ...view.teams.flatMap((tm) => tm.nodes), ...view.rest.nodes]) if (!m.has(n.name)) m.set(n.name, n); return [...m.values()]; }, [view]);
  const desks = desksOf(L);
  const tipText = tipDesk ? nodeText(tipDesk.node) : null;
  // The overview: the scene's rooms (or areas) and a dot for each person (a call in its colour), the view's frame on it.
  const miniRects = zones ? Object.values(L.areas || {}).map((a) => ({ key: a.name, ...a.rect })) : L.rooms.map((r) => ({ key: r.key, x: r.x, y: r.y, w: r.w, h: r.h }));
  const dotR = Math.max(L.width, L.height) / 90;
  const officeSelect = (cls) => html`<select class=${`tb-select ${cls}`} value=${layout ? layout.officeId : custom ? custom.id : AUTO_ID} disabled=${!!layout}
    aria-label=${to("office")} onChange=${(e) => pick(e.target.value)}>
      <option value=${AUTO_ID}>${to("allOffice")}</option>
      ${stored.map((o) => html`<option key=${o.id} value=${o.id}>${o.name}</option>`)}
    </select>`;
  return html`<div class=${`oo${fs ? ` fs ${fs}` : ""}`} ref=${ooRef}>
    <div class="oo-bar">
      <label class="oo-pick"><span class="oo-pick-label">${to("office")}</span>${officeSelect("oo-office")}</label>
      ${auto ? html`<label class="oo-pick"><span class="oo-pick-label">${to("styleLabel")}</span>
        <select class="tb-select" value=${STYLES.includes(style) || packs.some((pk) => pk.id === style) ? style : skin.id} onChange=${(e) => { store.saveSkin(e.target.value); setStyle(e.target.value); setTip(null); }}>
          ${STYLES.map((id) => html`<option key=${id} value=${id}>${to(`style_${id}`)}</option>`)}
          ${packs.map((pk) => html`<option key=${`pack:${pk.id}`} value=${pk.id}>${pk.name}</option>`)}
        </select></label>` : null}
      ${auto ? html`<label class="oo-pick"><span class="oo-pick-label">${to("show")}</span>
        <select class="tb-select" value=${teamValue} onChange=${(e) => { const o = opts.find((x) => x.value === e.target.value); setF({ ...f, team: o ? o.team : "" }); }}>
          ${opts.map((o) => html`<option key=${o.value} value=${o.value}>${o.label}</option>`)}
        </select></label>
        <${People} nodes=${everyone} pinned=${f.pinned} onChange=${(pinned) => setF({ ...f, pinned })} />` : null}
      <label class="check oo-hide-asleep"><input type="checkbox" checked=${hideAsleep} onChange=${() => { const v = !hideAsleep; store.saveHideAsleep(v); setHideAsleep(v); setTip(null); }} /><span>${to("hideAsleep")}</span></label>
      ${custom && baseSkin.id !== custom.skin && !loading ? html`<span class="muted oo-note">${to("skinUnknown", styleName(custom.skin))}</span>` : null}
      ${placed.ignored ? html`<span class="muted oo-note">${to("layoutIgnored")}</span>` : null}
      ${L.unseated ? html`<span class="muted oo-note">${to("unseated", L.unseated)}</span>` : null}
      ${canEdit && storedRev !== null ? html`<button type="button" class="btn btn-sm oo-edit" onClick=${() => setEditing(true)} disabled=${!!layout}>${t("orge.edit")}</button>` : null}
      ${canLayout ? html`<button type="button" class="btn btn-sm oo-layout" onClick=${openLayout}>${t("orgl.edit")}</button>` : null}
    </div>
    ${editing ? html`<${OfficeEditor} offices=${stored} rev=${storedRev} view=${view} store=${store} packs=${packs}
      ask=${ask} current=${() => shown.current} onSaved=${adopt} onClose=${() => setEditing(false)} />` : null}
    ${desks.length || L.rooms.length ? null : html`<p class="note oo-empty">${to("nobody")} ${auto && (f.team || f.pinned.length) ? html`<button type="button" class="btn btn-sm" onClick=${() => setF({ team: "", pinned: [] })}>${to("everyone")}</button>` : null}</p>`}
    <div class=${`oo-stage${layout ? " editing" : ""}`} ref=${stageRef} onPointerDown=${onDown} onPointerMove=${g.move} onPointerUp=${g.up} onPointerCancel=${g.up}
      onWheel=${onWheel} onKeyDown=${onKeyDown} onFocusIn=${onFocusIn} onClickCapture=${g.clickCapture}>
      <canvas ref=${canvasRef} class=${`oo-canvas${tipDesk && tipDesk.node.i ? " hot" : ""}`} role="application" tabindex="0" aria-label=${to("label")}
        onPointerMove=${onMove} onPointerLeave=${() => setTip(null)} onClick=${onClick}></canvas>
      ${layout ? html`<${LayoutEditor} key=${layout.id} base=${layout.base} start=${layout.start} place=${placeOverlay}
        stale=${layoutStale ? t("orgl.stale") : ""} onChange=${onDraft} onSave=${saveLayout} onClose=${closeLayout} />` : null}
      ${tipText ? html`<div ref=${tipRef} class="oo-tip" role="tooltip">
        <strong>${tipText.primary}</strong>${tipText.secondary ? html` <span class="muted mono">${tipText.secondary}</span>` : null}
        <div>${tipText.sub}</div><div class="muted">${caption(officePose(tipDesk.node.state), tipDesk.node.state)}</div>
        ${tipDesk.node.i && lastType.current === "touch" ? html`<div class="muted">${to("tapAgain")}</div>` : null}
      </div>` : null}
      <ul class="oo-desks" aria-label=${to("desks")}>${desks.map((d) => {
        const nt = nodeText(d.node), cap = caption(officePose(d.node.state), d.node.state);
        return html`<li key=${d.key}>${d.node.i
          ? html`<button type="button" class="oo-desk" data-name=${d.node.name} aria-label=${`${nt.full} · ${cap}. ${t("orgc.openChat")}`}
              onFocus=${() => setTip(d.key)} onBlur=${() => setTip(null)} onClick=${() => open(d.node.name)}>${nt.primary}</button>`
          : html`<span class="oo-desk" data-name=${d.node.name}>${nt.full}</span>`}</li>`;
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
        ${desks.map((d) => { const at = zones ? d.seat : { x: d.x + d.w / 2, y: d.y + d.h / 2 };
          return html`<circle key=${d.key} class=${`oo-mini-dot st-${d.node.state}${q && hits(d.node, q) ? " match" : ""}`} cx=${at.x} cy=${at.y} r=${dotR} />`; })}
        <rect ref=${miniViewRef} class="oc-mini-view oo-mini-view" />
      </svg>
    </div>
  </div>`;
}
