// Fleet → Org chart → Office: the fleet as a small pixel office, the third view beside Canvas and List
// (fleet-canvas.js). The same data as theirs: the structure from /ui/org (buildOrgView), the live state from the app
// store, the traffic from fleet-traffic.js's store — nothing new is read but the offices people made (/ui/offices).
//
// - Two layouts, by skin. Desks (the built-in "pixel" skin, the default): each team is a room, each member a desk with a
//   name tag; General and the instances in no team share the lobby; a grid that wraps at the stage's width
//   (fleet-office-model.js autoLayout). Zones (a skin whose pack maps states to areas — the built-in "studio"): a
//   1280×720 scene scaled to fit; each instance takes a seat in the area for its state and walks there along the
//   pack's waypoints when its state changes (fleet-office-zones.js).
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
//   goes. Reduced motion: still poses, nothing in the air. Colours are the dashboard's tokens (dark and light).
// - Drawing is the skin's (fleet-office-skin.js); a skin pack (fleet-office-pack.js) can replace any part later.
import { html, useEffect, useLayoutEffect, useMemo, useRef, useState } from "/assets/app-html.js";
import { appStore } from "/assets/app-store.js";
import { t, lang, register } from "/assets/app-i18n.js";
import { identityOf } from "/assets/identity-color.js";
import { nodeText } from "./fleet-org.js";
import { hits, needle } from "./fleet-canvas-layout.js";
import { AUTO_ID, LOBBY, autoLayout, backingScale, coatOf, createFlights, customLayout, deskAt, desksOf, filterOk, lampOf, layoutOk, lightOf, membersOf,
  officePose, officeRooms, signOf, workOn } from "./fleet-office-model.js";
import { CHAR_DEPTH, DEFAULT_PAL, modeOf, skinFor } from "./fleet-office-skin.js";
import { activeFurniture, bubbleAt, createWalkers, linesFor, personAt, zonesLayout } from "./fleet-office-zones.js";
import { createOfficeStore } from "./fleet-office-store.js";
import { OfficeEditor } from "./fleet-office-editor.js";

register("orgo", {
  en: {
    label: "Office: each team is a room and each instance a desk; General and the instances in no team are in the lobby.",
    office: "Office", allOffice: "Whole fleet", show: "Show", allTeams: "All teams", lobby: "Lobby (General, no team)", lobbyRoom: "Lobby",
    people: "People", peopleN: "People ({0})", findPerson: "Find a person", everyone: "Show everyone", nobody: "No one here matches this filter.",
    unseated: "{0} without a seat", closed: "Closed", desks: "Desks", tapAgain: "Tap again to open the chat",
    capWorking: "Typing away", capIdle: "Tea break", capPaused: "Asleep", capNeeds: "Calling for you", capAway: "Desk empty", capStarting: "Just arriving", capQueued: "Waiting to start",
    styleLabel: "Style", style_pixel: "Desks", style_studio: "Studio", area_desks: "Work", area_lounge: "Lounge", area_alert: "Help desk", area_nap: "Nap corner",
    b_working: "On it.|Typing…|Almost there|In the zone|One more test", b_idle: "Tea time|Ready when you are|Stretching|Anything for me?",
    b_paused: "Zzz…|Back later", b_stopped: "Off duty|Zzz…", b_needs: "Need you!|A question for you|Over here!",
    b_crashed: "Ouch, crashed|Help!", b_stuck: "Hmm, stuck?|Still thinking…",
  },
  "zh-TW": {
    label: "辦公室：每個 team 是一間房間，每個 instance 一張桌子；General 和未加入 team 的 instance 在大廳。",
    office: "辦公室", allOffice: "整個 fleet", show: "顯示", allTeams: "所有 team", lobby: "大廳（General、未加入 team）", lobbyRoom: "大廳",
    people: "成員", peopleN: "成員（{0}）", findPerson: "尋找成員", everyone: "顯示全部", nobody: "沒有符合這個篩選的成員。",
    unseated: "{0} 位沒有座位", closed: "休息中", desks: "桌子", tapAgain: "再點一下開啟聊天",
    capWorking: "埋頭打字中", capIdle: "喝茶休息", capPaused: "睡著了", capNeeds: "在呼叫你", capAway: "空位", capStarting: "剛到座位", capQueued: "等待啟動",
    styleLabel: "風格", style_pixel: "辦公桌", style_studio: "工作室", area_desks: "工作區", area_lounge: "休息區", area_alert: "求救區", area_nap: "午睡角",
    b_working: "處理中|打字中…|快好了|專心中|再測一次", b_idle: "喝茶中|隨時可以開工|伸個懶腰|有事找我嗎？",
    b_paused: "Zzz…|晚點回來", b_stopped: "下班了|Zzz…", b_needs: "需要你！|有個問題|在這裡！",
    b_crashed: "糟糕，當掉了|救命！", b_stuck: "嗯，卡住了？|還在想…",
  },
});
const to = (k, ...v) => t(`orgo.${k}`, ...v);
const CAPTION = { working: "capWorking", idle: "capIdle", paused: "capPaused", needs: "capNeeds", walk: "capIdle", away: "capAway" };
/** States whose pose is shared but whose words are their own (a queued instance is not asleep). */
const CAPTION_OF_STATE = { starting: "capStarting", queued: "capQueued" };
/** What a pose says in words (the tooltip, the desk list); `state`, when its words differ from its pose's. */
export const caption = (pose, state) => to(CAPTION_OF_STATE[state] || CAPTION[pose] || "capIdle");

const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
const now = () => (typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now());
/** How often the picture can change when nothing is in the air (the poses loop at 4 fps; a bubble types faster). */
const FPS = 12;
const STYLES = ["pixel", "studio"];
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
  const [width, setWidth] = useState(960);
  const [stageH, setStageH] = useState(0);                            // the stage's height (0: not known — fit the width only)
  const [themeRev, setThemeRev] = useState(0);
  const [pal, setPal] = useState(DEFAULT_PAL);                      // the tokens in force (read once the stage is there)
  const [tip, setTip] = useState(null);                               // the desk key the tooltip is for
  const stageRef = useRef(null), canvasRef = useRef(null), tipRef = useRef(null), lastType = useRef("mouse");
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

  const custom = choice !== AUTO_ID ? stored.find((o) => o.id === choice) || null : null;
  const skin = skinFor(custom ? custom.skin : STYLES.includes(style) ? style : "pixel");
  const zones = !!(skin.pack && skin.pack.stateZones);
  const L = useMemo(() => {
    const nodes = custom ? membersOf(custom, view) : [...new Map(officeRooms(view, filter).flatMap((r) => r.nodes).map((n) => [n.name, n])).values()];
    if (zones) { const z = zonesLayout(skin.pack, nodes, seatsRef.current); seatsRef.current = z.seats; return z; }
    if (!custom) return autoLayout(officeRooms(view, filter), { width });
    const lay = custom.layout || layoutOk(skin.layout);
    return lay ? customLayout({ ...custom, layout: lay }, nodes) : autoLayout([{ key: custom.id, name: custom.name, lobby: false, nodes }], { width });
  }, [view, filter, custom, width, skin]);
  /** Layout units → CSS px: the zones scene fits the stage (16:9, whole); the desks are drawn at their size. */
  const k = zones ? Math.max(0.2, Math.min(1.25, (width - 2) / L.width, stageH > 0 ? (stageH - 2) / L.height : Infinity)) : 1;
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

  // ── Drawing: the back and front layers are pictures, remade when the office changes; each frame draws the people
  // and the items in the air between them ──
  const scene = useRef(null);
  const loop = useRef(null);
  useLayoutEffect(() => {
    const cv = canvasRef.current;
    const ctx = cv && typeof cv.getContext === "function" ? cv.getContext("2d") : null;
    if (!ctx) { scene.current = null; return; }
    const W = Math.ceil(L.width * k), H = Math.max(1, Math.ceil(L.height * k));
    // The device's ratio, unless the bitmap would be too big to paint (backingScale): then fewer px per CSS px.
    const dpr = backingScale(W, H, Math.max(1, Math.min(3, globalThis.devicePixelRatio || 1)));
    const BW = Math.max(1, Math.floor(W * dpr)), BH = Math.max(1, Math.floor(H * dpr));
    if (cv.width !== BW || cv.height !== BH) { cv.width = BW; cv.height = BH; }
    cv.style.setProperty("width", `${W}px`);
    cv.style.setProperty("height", `${H}px`);
    const env = { pal, mode, labels: { lobby: to("lobbyRoom"), closed: to("closed"), areas: { desks: to("area_desks"), lounge: to("area_lounge"), alert: to("area_alert"), nap: to("area_nap") } } };
    const scale = dpr * k;
    const layer = (paint) => {
      const c = document.createElement("canvas");
      c.width = BW; c.height = BH;
      const g = c.getContext && c.getContext("2d");
      if (!g) return null;
      g.setTransform(scale, 0, 0, scale, 0, 0);
      g.imageSmoothingEnabled = false;
      paint(g);
      return c;
    };
    const all = L.rooms.flatMap((r) => r.desks);
    const back = layer((g) => {
      g.fillStyle = env.pal.bg; g.fillRect(0, 0, L.width, L.height);
      if (zones) { skin.drawBackground(g, L, env); return; }
      skin.drawFloor(g, L, env);
      for (const r of L.rooms) skin.drawRoom(g, r, env);
      for (const d of all) skin.drawDeskBack(g, d, looks.get(d.key), env);
    });
    const front = zones ? null : layer((g) => { for (const d of all) skin.drawDeskFront(g, d, looks.get(d.key), env); });
    const shown = new Set([...looks.values()].map((l) => l.state));
    scene.current = { ctx, scale, BW, BH, back, front, env, desks: all.filter((d) => d.node), looks, L, skin, zones, dirty: true,
      active: zones ? activeFurniture(skin.pack, shown) : new Set(), lines: bubbleDefaults(), lang: lang() };
    if (still) draw(0); else loop.current?.wake();
  }, [L, looks, skin, pal, k]);

  /** One frame at `ms` (0: still); whether anything is moving (in the air, or someone walking). */
  function draw(ms) {
    const s = scene.current;
    if (!s) return false;
    const { ctx, scale, BW, BH, env, skin: sk } = s;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, BW, BH);
    if (s.back) ctx.drawImage(s.back, 0, 0);
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.imageSmoothingEnabled = false;
    const speakers = [];
    let walking = false;
    if (s.zones) {
      // Furniture under the people, the people (nearest last), furniture over them, then their name tags.
      const t = ms > 0 ? ms : now();
      const people = s.desks.map((d) => {
        const at = walkers.at(d.node.name, t) || { ...d.seat, walking: false };
        if (at.walking) walking = true;
        return { d, at, look: s.looks.get(d.key) };
      }).sort((a, b) => a.at.y - b.at.y);
      const furniture = s.skin.pack.furniture;
      for (const f of furniture) if (f.depth < CHAR_DEPTH) sk.drawFurniture(ctx, f, s.active.has(f.id), ms, env);
      for (const p of people) {
        const box = { ...p.d, x: p.at.x - 44, y: p.at.y - 53, w: 88, h: 53, seat: { x: p.at.x, y: p.at.y } };
        sk.drawCharacter(ctx, box, p.at.walking ? { ...p.look, pose: "walk" } : p.look, ms, env);
        if (!p.at.walking) speakers.push({ look: p.look, x: p.at.x + 10, y: p.at.y - 50 });
      }
      for (const f of furniture) if (f.depth >= CHAR_DEPTH) sk.drawFurniture(ctx, f, s.active.has(f.id), ms, env);
      for (const p of people) sk.drawTag(ctx, p.at.x, p.at.y, p.look, env);
    } else {
      for (const d of s.desks) { const look = s.looks.get(d.key); sk.drawCharacter(ctx, d, look, ms, env); speakers.push({ look, x: d.x + 58, y: d.y + 12 }); }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      if (s.front) ctx.drawImage(s.front, 0, 0);
      ctx.setTransform(scale, 0, 0, scale, 0, 0);
    }
    const up = still ? [] : flights.frame(ms, s.L);
    for (const it of up) sk.drawProp(ctx, it, ms, env);
    // Speech bubbles: a short line for the state, now and then (typed out; whole at once when still).
    for (const sp of speakers) {
      if (sp.look.dim || sp.look.pose === "away") continue;
      const b = bubbleAt(sp.look.name, sp.look.state, ms, linesFor(sp.look.state, s.lang, sk.pack, s.lines));
      if (b) sk.drawBubble(ctx, sp.x, sp.y, [...b.text].slice(0, b.shown).join(""), env);
    }
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

  // ── The tooltip: what the canvas's card says, above the desk (below it at the top edge) ──
  const tipDesk = tip ? desksOf(L).find((d) => d.key === tip) || null : null;
  useLayoutEffect(() => {
    const el = tipRef.current;
    if (!el || !tipDesk || !el.style) return;
    const dx = tipDesk.x * k, dy = tipDesk.y * k, x = Math.max(4, Math.min(dx, L.width * k - 244)), above = dy > 90;
    el.style.setProperty("transform", above ? `translate(${x}px, ${dy + 6}px) translateY(-100%)` : `translate(${x}px, ${dy + tipDesk.h * k}px)`);
  });
  const deskOf = (e) => {
    const r = canvasRef.current ? canvasRef.current.getBoundingClientRect() : null;
    if (!r) return null;
    const x = (e.clientX - r.left) / k, y = (e.clientY - r.top) / k;
    // The zones scene draws people where they walk: they are hit there, not at the seat they are heading for.
    return zones ? personAt(L.rooms.flatMap((rm) => rm.desks), x, y, (d) => walkers.at(d.node.name, now())) : deskAt(L, x, y);
  };
  const onMove = (e) => { if (e.pointerType === "touch") return; const d = deskOf(e); const k = d ? d.key : null; if (k !== tip) setTip(k); };
  const onClick = (e) => {
    const d = deskOf(e);
    if (!d || !d.node.i) { setTip(null); return; }
    if (lastType.current === "touch" && tip !== d.key) { setTip(d.key); return; }   // a first tap shows; a second opens
    onOpen(d.node.name);
  };

  const auto = !custom;
  const f = filterOk(filter);
  const opts = teamOptions(view);
  const teamValue = (opts.find((o) => o.team === f.team) || opts[0]).value;
  const setF = (next) => { const v = filterOk(next); store.saveFilter(v); setFilter(v); };
  const pick = (id) => { store.saveChoice(id); setChoice(id); setTip(null); };
  const everyone = useMemo(() => { const m = new Map(); for (const n of [...view.top, ...view.teams.flatMap((tm) => tm.nodes), ...view.rest.nodes]) if (!m.has(n.name)) m.set(n.name, n); return [...m.values()]; }, [view]);
  const desks = desksOf(L);
  const tipText = tipDesk ? nodeText(tipDesk.node) : null;
  return html`<div class="oo">
    <div class="oo-bar">
      <label class="oo-pick"><span class="oo-pick-label">${to("office")}</span>
        <select class="tb-select" value=${custom ? custom.id : AUTO_ID} onChange=${(e) => pick(e.target.value)}>
          <option value=${AUTO_ID}>${to("allOffice")}</option>
          ${stored.map((o) => html`<option key=${o.id} value=${o.id}>${o.name}</option>`)}
        </select></label>
      ${auto ? html`<label class="oo-pick"><span class="oo-pick-label">${to("styleLabel")}</span>
        <select class="tb-select" value=${skin.id} onChange=${(e) => { store.saveSkin(e.target.value); setStyle(e.target.value); setTip(null); }}>
          ${STYLES.map((id) => html`<option key=${id} value=${id}>${to(`style_${id}`)}</option>`)}
        </select></label>` : null}
      ${auto ? html`<label class="oo-pick"><span class="oo-pick-label">${to("show")}</span>
        <select class="tb-select" value=${teamValue} onChange=${(e) => { const o = opts.find((x) => x.value === e.target.value); setF({ ...f, team: o ? o.team : "" }); }}>
          ${opts.map((o) => html`<option key=${o.value} value=${o.value}>${o.label}</option>`)}
        </select></label>
        <${People} nodes=${everyone} pinned=${f.pinned} onChange=${(pinned) => setF({ ...f, pinned })} />` : null}
      ${L.unseated ? html`<span class="muted oo-note">${to("unseated", L.unseated)}</span>` : null}
      ${canEdit && storedRev !== null ? html`<button type="button" class="btn btn-sm oo-edit" onClick=${() => setEditing(true)}>${t("orge.edit")}</button>` : null}
    </div>
    ${editing ? html`<${OfficeEditor} offices=${stored} rev=${storedRev} view=${view} store=${store}
      ask=${ask} onSaved=${adopt} onClose=${() => setEditing(false)} />` : null}
    ${desks.length || L.rooms.length ? null : html`<p class="note oo-empty">${to("nobody")} ${auto && (f.team || f.pinned.length) ? html`<button type="button" class="btn btn-sm" onClick=${() => setF({ team: "", pinned: [] })}>${to("everyone")}</button>` : null}</p>`}
    <div class="oo-stage" ref=${stageRef}>
      <canvas ref=${canvasRef} class=${`oo-canvas${tipDesk && tipDesk.node.i ? " hot" : ""}`} role="img" aria-label=${to("label")}
        onPointerMove=${onMove} onPointerLeave=${() => setTip(null)} onPointerDown=${(e) => { lastType.current = e.pointerType || "mouse"; }} onClick=${onClick}></canvas>
      ${tipText ? html`<div ref=${tipRef} class="oo-tip" role="tooltip">
        <strong>${tipText.primary}</strong>${tipText.secondary ? html` <span class="muted mono">${tipText.secondary}</span>` : null}
        <div>${tipText.sub}</div><div class="muted">${caption(officePose(tipDesk.node.state), tipDesk.node.state)}</div>
        ${tipDesk.node.i && lastType.current === "touch" ? html`<div class="muted">${to("tapAgain")}</div>` : null}
      </div>` : null}
      <ul class="oo-desks" aria-label=${to("desks")}>${desks.map((d) => {
        const nt = nodeText(d.node), cap = caption(officePose(d.node.state), d.node.state);
        return html`<li key=${d.key}>${d.node.i
          ? html`<button type="button" class="oo-desk" data-name=${d.node.name} aria-label=${`${nt.full} · ${cap}. ${t("orgc.openChat")}`}
              onFocus=${() => setTip(d.key)} onBlur=${() => setTip(null)} onClick=${() => onOpen(d.node.name)}>${nt.primary}</button>`
          : html`<span class="oo-desk" data-name=${d.node.name}>${nt.full}</span>`}</li>`;
      })}</ul>
    </div>
  </div>`;
}
