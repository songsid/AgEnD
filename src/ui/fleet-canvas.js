// #1918: Fleet → Org chart as a canvas — the same structure as the list (fleet-org.js: General, the teams fleet.yaml
// defines, their members, the instances in no team), drawn as cards in team boxes you can pan, zoom and pinch. No
// library: SVG with attributes and classes (never a style attribute, #1300); the view's transform is an SVG attribute
// set on one group, so panning re-renders nothing.
//
// - Layout: fixed slots, no layout engine. General on top; teams in fleet.yaml's order, packed into rows that wrap at
//   a width; members in a two- or three-column grid in their box. Each team's slot is sized as if expanded, so folding
//   a team or searching never moves another one. Tree lines: a stem from General, a bus over each row, a trunk at the
//   left joining the rows, one drop per team — never a line per member (the box says who is in it). A phone packs
//   narrower (one team a row, at most two columns), so General and the first team open readable.
// - Per device (localStorage; blocked storage: this page only): Canvas or List, and which teams are folded. The view
//   itself is not kept: it opens on General and the first row (#1918's user decision 2) — on a desktop as wide as the
//   panel allows (no larger than life), on a phone no smaller than readable. 0 / Fit shows the whole fleet.
// - Presentation only, like the list: a card opens that instance's chat; nothing is edited here (#1689 is how teams
//   change). The live state is the app store's (fleet-org.js buildOrgView), so the canvas moves with the stream.
// - Live traffic (fleet-traffic.js): the messages between instances, drawn between the team boxes and the cards (never
//   hidden under a box, never across a name). Live on or off per device; the list says it in words ("Sending: …").
import { html, useEffect, useLayoutEffect, useMemo, useRef, useState } from "/assets/app-html.js";
import { appStore } from "/assets/app-store.js";
import { t, register } from "/assets/app-i18n.js";
import { chatPath } from "/assets/app-route.js";
import { navigate } from "/assets/app-nav.js";
import { Empty, Skeleton } from "/assets/ui-states.js";
import { Icon } from "/assets/ui-icons.js";
import { avatarOf, backendLabel, firstCharacter, namesOf } from "/assets/instance-nav.js";
import { identityClasses, identityOf, paintIdentity, useIdentityColors } from "/assets/identity-color.js";
import { buildOrgView, OrgChart, OrgSummary } from "./fleet-org.js";
import { OC, REST_KEY, SUM_LINE, canvasLayout, openingRegion, summaryRows } from "./fleet-canvas-layout.js";
import { createTrafficStore, FAR_K, POLL_MS, sendingBy, trafficEdges } from "./fleet-traffic.js";

register("orgc", {
  en: {
    view: "View", canvas: "Canvas", list: "List", find: "Find an instance", findShort: "Find", found: "{0} found", foundOne: "1 found", noMatch: "No match",
    zoomIn: "Zoom in", zoomOut: "Zoom out", fit: "Fit to screen",
    label: "Org chart canvas. Tab or the arrow keys move between instances, Enter opens a chat, + and − zoom, 0 fits the fleet.",
    expand: "Expand", collapse: "Collapse", members: "{0} members", member: "1 member", inFolded: "{0} found · expand", noMembers: "No members",
    openChat: "Open chat", minimap: "Overview: click to move there",
    live: "Live", liveOn: "Hide live traffic", liveOff: "Show live traffic", lgTask: "delegate_task", lgSend: "send_to_instance",
    lgReport: "report_result", lgBroadcast: "broadcast", lgQueued: "queued", lgFading: "delivered", lgTeam: "between teams", legend: "Key",
  },
  "zh-TW": {
    view: "檢視", canvas: "畫布", list: "清單", find: "尋找 instance", findShort: "尋找", found: "找到 {0} 個", foundOne: "找到 1 個", noMatch: "沒有符合的",
    zoomIn: "放大", zoomOut: "縮小", fit: "符合畫面",
    label: "組織圖畫布。用 Tab 或方向鍵在 instance 之間移動，Enter 開啟聊天，+ 和 − 縮放，0 顯示整個 fleet。",
    expand: "展開", collapse: "收合", members: "{0} 名成員", member: "1 名成員", inFolded: "找到 {0} 個 · 展開", noMembers: "沒有成員",
    openChat: "開啟聊天", minimap: "總覽：點一下移到那裡",
    live: "即時", liveOn: "隱藏即時往來", liveOff: "顯示即時往來", lgTask: "delegate_task", lgSend: "send_to_instance",
    lgReport: "report_result", lgBroadcast: "broadcast", lgQueued: "排隊中", lgFading: "已送達", lgTeam: "team 之間", legend: "圖例",
  },
});
const tc = (k, ...v) => t(`orgc.${k}`, ...v);

// ── Layout: fleet-canvas-layout.js (pure; the traffic overlay routes through the same lanes) ──

export { OC, REST_KEY, SUM_LINE, canvasLayout, openingRegion, summaryRows };

// ── The view: pan, zoom, fit (pure helpers; the component applies them) ──

export const K_MIN = 0.2, K_MAX = 2.5;
const clampK = (k) => Math.min(K_MAX, Math.max(K_MIN, k));
/**
 * The view that shows region `r` in a `size` viewport: as large as fits (at most `maxK`), centred across, from the top.
 * `minK`: never smaller than this (a phone's opening); a region that is then wider than the viewport starts at its left.
 * `widthOnly`: fit the width, let the height run on (the opening: the rest is below).
 */
export function fitView(r, size, { margin = 24, minK = K_MIN, maxK = 1.25, widthOnly = false } = {}) {
  const across = (size.w - 2 * margin) / r.w, down = widthOnly ? Infinity : (size.h - 2 * margin) / r.h;
  const k = clampK(Math.max(minK, Math.min(across, down, maxK)));
  const x = r.w * k > size.w - 2 * margin ? margin - r.x * k : size.w / 2 - (r.x + r.w / 2) * k;
  return { k, x, y: margin - r.y * k };
}
/** A pinch step: the canvas point under the old midpoint goes to the new midpoint, the zoom scaled by the spans' ratio. */
export function pinchView(v, from, to) {
  const k = clampK(v.k * (to.dist / from.dist));
  const wx = (from.mid.x - v.x) / v.k, wy = (from.mid.y - v.y) / v.k;
  return { k, x: to.mid.x - wx * k, y: to.mid.y - wy * k };
}
/** Zoom by `f` about the viewport point (cx, cy): the canvas point under it stays under it. */
export function zoomAt(v, f, cx, cy) {
  const k = clampK(v.k * f);
  return { k, x: cx - (cx - v.x) * (k / v.k), y: cy - (cy - v.y) * (k / v.k) };
}

// ── Per device ──

const MODE_KEY = "agend_org_mode", FOLD_KEY = "agend_org_folded", LIVE_KEY = "agend_org_live", KEY_KEY = "agend_org_key";
function readMode() { try { return localStorage.getItem(MODE_KEY) === "list" ? "list" : "canvas"; } catch { return "canvas"; } }
function readLive() { try { return localStorage.getItem(LIVE_KEY) !== "0"; } catch { return true; } }
function readFolded() {
  try { const a = JSON.parse(localStorage.getItem(FOLD_KEY) || "[]"); return new Set(Array.isArray(a) ? a.filter((x) => typeof x === "string").slice(0, 500) : []); } catch { return new Set(); }
}
function save(key, value) { try { localStorage.setItem(key, value); } catch { /* this page only */ } }

// ── Drawing ──

const STATE_LABEL = (s) => t(`org.${s}`);
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const needle = (q) => String(q || "").trim().toLowerCase();
const hits = (node, q) => !!q && (node.name.toLowerCase().includes(q) || (!!node.i && typeof node.i.display_name === "string" && node.i.display_name.toLowerCase().includes(q)));

function Face({ it, name, cx, cy, r }) {
  const a = it ? avatarOf(it) : { kind: "initial", text: firstCharacter(name) };
  const [broken, setBroken] = useState("");
  const src = a.kind !== "initial" && a.src && broken !== a.src ? a.src : "";
  const text = a.kind === "emoji" && a.text ? a.text : a.kind === "initial" ? a.text : firstCharacter(it ? namesOf(it).primary : name);
  return html`<g class=${`oc-face${a.kind === "emoji" ? " emoji" : ""}`} aria-hidden="true">
    <circle class="oc-av" cx=${cx} cy=${cy} r=${r} />
    ${src ? html`<image href=${src} x=${cx - r} y=${cy - r} width=${r * 2} height=${r * 2} preserveAspectRatio="xMidYMid slice"
      clip-path=${a.kind === "image" ? "url(#oc-clip-av)" : undefined} onError=${() => setBroken(src)} />`
      : html`<text class="oc-av-t" x=${cx} y=${cy + 4} text-anchor="middle">${text}</text>`}
  </g>`;
}

function Card({ c, lead, cls, onOpen }) {
  const n = c.node, it = n.i;
  const names = it ? namesOf(it) : { primary: n.name, secondary: "" };
  const id = it ? identityOf(it) : null;
  const sub = it ? `${STATE_LABEL(n.state)} · ${backendLabel(it.backend)}` : STATE_LABEL(n.state);
  const full = `${names.primary}${names.secondary ? ` (${names.secondary})` : ""} — ${sub}`;
  const cy = c.h / 2;
  return html`<g class=${`oc-node st-${n.state}${lead ? " lead" : ""}${cls ? ` ${cls}` : ""} ${identityClasses(id)}`} ref=${(el) => paintIdentity(el, id)}
    transform=${`translate(${c.x} ${c.y})`} data-name=${n.name} data-key=${c.key} tabindex="0" role=${it ? "link" : "img"}
    aria-label=${it ? `${full}. ${tc("openChat")}` : full} onClick=${it ? () => onOpen(n.name) : undefined}>
    <title>${full}</title>
    <rect class="oc-card" width=${c.w} height=${c.h} rx="10" />
    <rect class="oc-idbar" x="0" y="8" width="4" height=${c.h - 16} rx="2" />
    <${Face} it=${it} name=${n.name} cx=${26} cy=${cy} r=${16} />
    <circle class=${`oc-dot st-${n.state}`} cx=${38} cy=${cy + 12} r=${5} />
    <text class="oc-name" x=${50} y=${cy - 4}>${clip(names.primary, lead ? 20 : 15)}</text>
    <text class="oc-sub" x=${50} y=${cy + 13}><tspan class=${`oc-st st-${n.state}`}>${clip(sub, lead ? 27 : 20)}</tspan></text>
  </g>`;
}

function TeamBox({ b, q, onFold }) {
  const name = b.name === null ? t("org.unteamed") : b.name;
  const found = q ? b.nodes.filter((n) => hits(n, q)).length : 0;
  const count = b.nodes.length === 1 ? tc("member") : tc("members", b.nodes.length);
  const toggle = (e) => { if (e.type === "click" || e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); onFold(b.key); } };
  return html`<g class=${`oc-team${b.loose ? " loose" : ""}${q && !found ? " dim" : ""}`} data-team=${b.key}>
    <rect class=${`oc-box${b.folded && found ? " match" : ""}`} x=${b.x} y=${b.y} width=${b.w} height=${b.h} rx="12" />
    <rect class="oc-head" x=${b.x + 1} y=${b.y + 1} width=${b.w - 2} height=${OC.HEAD - 2} rx="11" />
    <g class=${`oc-toggle${b.nodes.length ? "" : " empty"}`} tabindex=${b.nodes.length ? "0" : undefined} role=${b.nodes.length ? "button" : undefined}
      aria-expanded=${b.nodes.length ? String(!b.folded) : undefined} aria-label=${`${name}, ${count}.${b.nodes.length ? ` ${b.folded ? tc("expand") : tc("collapse")}.` : ""}`}
      onClick=${b.nodes.length ? toggle : undefined} onKeyDown=${b.nodes.length ? toggle : undefined}>
      <rect class="oc-hit" x=${b.x} y=${b.y} width=${b.w} height=${OC.HEAD} />
      ${b.nodes.length ? html`<text class="oc-caret" x=${b.x + 12} y=${b.y + 22}>${b.folded ? "▸" : "▾"}</text>` : null}
      <text class="oc-team-name" x=${b.x + (b.nodes.length ? 28 : 14)} y=${b.y + 22}>${clip(name, Math.max(8, Math.floor((b.w - 90) / 7.5)))}</text>
      <text class="oc-team-meta" x=${b.x + b.w - 12} y=${b.y + 22} text-anchor="end">${b.folded && found ? tc("inFolded", found) : String(b.nodes.length)}</text>
    </g>
    ${!b.nodes.length ? html`<text class="oc-team-sum" x=${b.x + 14} y=${b.y + OC.HEAD + 18}>${tc("noMembers")}</text>` : null}
    ${b.folded ? b.summary.flatMap((row, i) => row.map((it) => html`<g key=${it.s}>
      <circle class=${`oc-dot st-${it.s}`} cx=${b.x + it.dx + 5} cy=${b.y + OC.HEAD + 14 + i * SUM_LINE} r="5" />
      <text class="oc-team-sum" x=${b.x + it.dx + 14} y=${b.y + OC.HEAD + 18 + i * SUM_LINE}>${it.label}</text></g>`)) : null}
  </g>`;
}

/** Every card, in the order Tab walks them (General, then each team's members in reading order). */
const cardsOf = (L) => [...L.tops, ...L.boxes.flatMap((b) => b.cells)];

const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** The traffic lines: dotted while queued, a dash and a pulse while delivering, fading once delivered; ×N on shared lines. */
function TrafficLayer({ edges, q }) {
  const still = reducedMotion();
  return html`<g class="oc-flows" aria-hidden="true">${edges.map((e) => {
    const dim = q && !e.names.some((n) => n.toLowerCase().includes(q));
    return html`<g key=${e.key} class=${`oc-fl${dim ? " dim" : ""}`}>
      <path class="oc-flow-halo" d=${e.d} />
      <path class=${`oc-flow h-${e.hue} ph-${e.phase}`} d=${e.d} marker-start=${`url(#oc-src-${e.phase === "fading" ? "fading" : e.hue})`} marker-end=${`url(#oc-ah-${e.phase === "fading" ? "fading" : e.hue})`} />
      ${e.phase === "live" && !still ? html`<circle class=${`oc-pulse h-${e.hue}`} r="4"><animateMotion dur=${`${Math.max(1.6, e.pts.length * 0.3)}s`} repeatCount="indefinite" path=${e.d} /></circle>` : null}
      ${e.badge ? html`<g class="oc-badge" transform=${`translate(${e.badge.x - 14} ${e.badge.y - 10})`}><rect width="28" height="20" rx="10" /><text x="14" y="14" text-anchor="middle">${`×${e.n}`}</text></g>` : null}
    </g>`;
  })}</g>`;
}
const ARROWS = ["task", "send", "report", "broadcast", "team", "fading"];

/** The key to the lines: folded until the person opens it (open, it covers a corner of the canvas); kept per device. */
function Legend() {
  const [open] = useState(() => { try { return localStorage.getItem(KEY_KEY) === "1"; } catch { return false; } });
  const row = (cls, k) => html`<span class="oc-lg"><i class=${`oc-sw ${cls}`} aria-hidden="true"></i>${tc(k)}</span>`;
  return html`<details class="oc-legend" open=${open} onToggle=${(e) => save(KEY_KEY, e.currentTarget.open ? "1" : "0")}><summary>${tc("legend")}</summary>
    <div class="oc-lg-rows">${row("h-task", "lgTask")}${row("h-send", "lgSend")}${row("h-report", "lgReport")}${row("h-broadcast", "lgBroadcast")}
    ${row("ph-queued", "lgQueued")}${row("ph-fading", "lgFading")}</div></details>`;
}

/**
 * The page's traffic while the canvas (or its list) is open and Live is on: the snapshot on opening; then the stream's
 * items — or, with no live stream (the public link, or a stream that fell back to polling), the snapshot every
 * POLL_MS while the page is shown; read again when the stream comes back. Everything is the lease's (#1408 §4).
 */
function useTraffic(lease, on) {
  const store = useMemo(createTrafficStore, []);
  const [rev, setRev] = useState(0);
  useEffect(() => {
    if (!on || !lease) return undefined;
    const bump = () => setRev((n) => n + 1);
    const read = async () => {
      try {
        const r = await lease.fetch("/ui/traffic", { method: "GET", headers: { "Content-Type": "application/json" } });
        if (!lease.current() || !r.ok) return;
        const d = await r.json();
        if (lease.current() && store.load(d)) bump();
      } catch { /* the next poll, or the stream, brings it */ }
    };
    void read();
    const sub = appStore.get().streamOn;
    // No live stream to bring traffic: the public link (poll transport), or a stream that fell back to /ui/poll.
    const polled = () => globalThis.document?.body?.dataset?.webTransport === "poll" || appStore.get().connection === "polling";
    const offs = [];
    if (sub) {
      offs.push(lease.hold(sub("traffic", (item) => { if (store.apply(item)) bump(); })));
      offs.push(lease.hold(sub("connection", (c) => { if (c === "live") void read(); })));
    }
    const hs = [
      lease.interval(() => { if (polled() && !globalThis.document?.hidden) void read(); }, POLL_MS),
      lease.interval(() => { if (store.sweep()) bump(); }, 1000),
    ];
    return () => { for (const off of offs) off(); for (const h of hs) lease.clear(h); };
  }, [lease, on]);
  return useMemo(() => (on ? store.items() : []), [rev, on]);
}

/** The canvas body: `view` buildOrgView's answer; `folded` the folded teams' keys; `q` the search needle; `traffic` the live items (null: Live is off). */
function Canvas({ view, folded, onFold, q, jump, traffic }) {
  const [narrow] = useState(() => typeof matchMedia === "function" && matchMedia("(max-width: 640px)").matches);
  const [far, setFar] = useState(false);
  const L = useMemo(() => canvasLayout(view, folded, { narrow, label: (s, n) => `${n} ${STATE_LABEL(s)}` }), [view, folded, narrow]);
  const svgRef = useRef(null), worldRef = useRef(null), miniRef = useRef(null), miniViewRef = useRef(null);
  const vp = useRef(null);
  const drag = useRef({ pts: new Map(), moved: 0, span: null, swallow: false });
  const size = () => {
    const r = svgRef.current ? svgRef.current.getBoundingClientRect() : null;
    return r && r.width > 0 && r.height > 0 ? { w: r.width, h: r.height } : { w: 960, h: 600 };
  };
  const apply = () => {
    const v = vp.current;
    if (!v || !worldRef.current) return;
    worldRef.current.setAttribute("transform", `translate(${v.x} ${v.y}) scale(${v.k})`);
    const s = size(), m = miniViewRef.current;
    if (m) for (const [k, val] of [["x", -v.x / v.k], ["y", -v.y / v.k], ["width", s.w / v.k], ["height", s.h / v.k]]) m.setAttribute(k, String(val));
  };
  // Zoomed out past FAR_K, traffic is drawn per team pair: a re-render only when that changes.
  const set = (v) => { vp.current = v; apply(); if ((v.k < FAR_K) !== far) setFar(v.k < FAR_K); };
  const whole = () => ({ x: OC.TRUNK - 20, y: 0, w: Math.max(1, L.width - OC.TRUNK + 40), h: Math.max(1, L.height + 10) });
  const fit = () => set(fitView(whole(), size()));
  const zoomBy = (f) => { const s = size(); set(zoomAt(vp.current, f, s.w / 2, s.h / 2)); };
  /** Bring a card into view (keyboard focus, a search's Enter): centred, at a readable size when `zoom`. */
  const show = (c, zoom) => {
    const s = size(), v = vp.current;
    const k = zoom ? Math.max(v.k, 1) : v.k;
    const sx = c.x * k + v.x, sy = c.y * k + v.y;
    if (!zoom && sx >= 8 && sy >= 8 && sx + c.w * k <= s.w - 8 && sy + c.h * k <= s.h - 8) return;
    set({ k, x: s.w / 2 - (c.x + c.w / 2) * k, y: s.h / 2 - (c.y + c.h / 2) * k });
  };

  // The opening view: General and the first row — a desktop as wide as fits, no larger than life; a phone no smaller
  // than readable.
  useLayoutEffect(() => {
    vp.current = narrow ? fitView(openingRegion(L), size(), { margin: 12, minK: 0.75 }) : fitView(whole(), size(), { widthOnly: true, maxK: 1, minK: 0.6 });
    setFar(vp.current.k < FAR_K);
  }, []);
  const edges = useMemo(() => (traffic ? trafficEdges(traffic, L, { far }) : []), [traffic, L, far]);
  // Preact owns the markup, not the transform: put it back after every render.
  useLayoutEffect(apply);
  // A search's Enter: the first match, unfolded (by the panel) and then brought into view — once. It waits for the
  // render that has its card (the unfold); a later render (the stream, a fold, a new search text) keeps the person's view.
  const pendingJump = useRef(null);
  useLayoutEffect(() => { pendingJump.current = jump; }, [jump]);
  useLayoutEffect(() => {
    const j = pendingJump.current;
    if (!j) return;
    const c = cardsOf(L).find((x) => x.node.name === j.name);
    if (c) { pendingJump.current = null; show(c, true); return; }
    if (!L.boxes.some((b) => b.folded && b.nodes.some((n) => n.name === j.name))) pendingJump.current = null;   // gone: nothing to wait for
  });

  const open = (name) => navigate(chatPath(name));
  // The click that ends a drag or a pinch opens nothing and folds nothing.
  const onClickCapture = (e) => { if (drag.current.swallow) { e.preventDefault(); e.stopPropagation(); } };
  const onWheel = (e) => {
    e.preventDefault();
    const r = svgRef.current.getBoundingClientRect();
    set(zoomAt(vp.current, Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top));
  };
  // One pointer pans (after a few pixels, so a tap still opens a card); two pinch: the canvas point under their old
  // midpoint goes to the new one, scaled by how their span changed (so a two-finger move pans too). The pointer is
  // captured only once it drags: a capture at once would send the tap's click to the canvas, not the card.
  const spanOf = () => {
    const [a, b] = [...drag.current.pts.values()], r = svgRef.current.getBoundingClientRect();
    return { mid: { x: (a.x + b.x) / 2 - r.left, y: (a.y + b.y) / 2 - r.top }, dist: Math.hypot(a.x - b.x, a.y - b.y) };
  };
  const onPointerDown = (e) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    const d = drag.current;
    d.pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (d.pts.size === 1) { d.moved = 0; d.swallow = false; d.span = null; }
    else if (d.pts.size === 2) { d.swallow = true; d.span = spanOf(); }
  };
  const onPointerMove = (e) => {
    const d = drag.current, prev = d.pts.get(e.pointerId);
    if (!prev) return;
    d.pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (d.pts.size === 1) {
      d.moved += Math.abs(e.clientX - prev.x) + Math.abs(e.clientY - prev.y);
      if (d.moved < 5) return;
      if (!d.swallow) { d.swallow = true; try { svgRef.current.setPointerCapture(e.pointerId); } catch { /* gone already */ } }
      set({ ...vp.current, x: vp.current.x + e.clientX - prev.x, y: vp.current.y + e.clientY - prev.y });
      return;
    }
    if (d.pts.size !== 2) return;
    d.swallow = true;
    const next = spanOf();
    if (d.span && d.span.dist > 0 && next.dist > 0) set(pinchView(vp.current, d.span, next));
    d.span = next;
  };
  const onPointerUp = (e) => {
    const d = drag.current;
    d.pts.delete(e.pointerId);
    // Back to one finger: it pans on at once (the pinch already swallows the click); two again: a new span.
    d.span = d.pts.size === 2 ? spanOf() : null;
    if (d.pts.size === 1) d.moved = 5;
    // The click that ends a drag comes after this: let it be swallowed, then forget.
    if (d.swallow && !d.pts.size) setTimeout(() => { if (!d.pts.size) d.swallow = false; }, 0);
  };
  const onKeyDown = (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.key === "+" || e.key === "=") { e.preventDefault(); zoomBy(1.25); return; }
    if (e.key === "-" || e.key === "_") { e.preventDefault(); zoomBy(0.8); return; }
    if (e.key === "0") { e.preventDefault(); fit(); return; }
    const dir = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
    const card = e.target && e.target.closest ? e.target.closest(".oc-node") : null;
    if (card && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      const c = cardsOf(L).find((x) => x.key === card.getAttribute("data-key"));
      if (c && c.node.i) open(c.node.name);
      return;
    }
    if (!dir) return;
    e.preventDefault();
    if (!card) { set({ ...vp.current, x: vp.current.x - dir[0] * 80, y: vp.current.y - dir[1] * 80 }); return; }
    const next = nearest(cardsOf(L), card.getAttribute("data-key"), dir);
    if (next) focusCard(svgRef.current, next.key);
  };
  const onFocusIn = (e) => {
    const card = e.target && e.target.closest ? e.target.closest(".oc-node") : null;
    const c = card ? cardsOf(L).find((x) => x.key === card.getAttribute("data-key")) : null;
    if (c) show(c, false);
  };
  const onMini = (e) => {
    const m = miniRef.current, r = m.getBoundingClientRect(), box = miniBox(L);
    if (!r.width || !r.height) return;
    const scale = Math.min(r.width / box.w, r.height / box.h);
    const wx = box.x + (e.clientX - r.left - (r.width - box.w * scale) / 2) / scale, wy = box.y + (e.clientY - r.top - (r.height - box.h * scale) / 2) / scale;
    const s = size(), v = vp.current;
    set({ k: v.k, x: s.w / 2 - wx * v.k, y: s.h / 2 - wy * v.k });
  };

  const box = miniBox(L);
  return html`<div class="oc-stage">
    <svg ref=${svgRef} class="oc-svg" role="application" tabindex="0" aria-label=${tc("label")} onWheel=${onWheel} onPointerDown=${onPointerDown}
      onPointerMove=${onPointerMove} onPointerUp=${onPointerUp} onPointerCancel=${onPointerUp} onKeyDown=${onKeyDown} onFocusIn=${onFocusIn} onClickCapture=${onClickCapture}>
      <defs><clipPath id="oc-clip-av" clipPathUnits="objectBoundingBox"><circle cx="0.5" cy="0.5" r="0.5" /></clipPath>
        ${ARROWS.map((a) => html`<marker key=${a} id=${`oc-ah-${a}`} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto">
          <path d="M0 0 L10 5 L0 10 z" class=${`oc-ah h-${a}`} /></marker>`)}
        ${ARROWS.map((a) => html`<marker key=${`s-${a}`} id=${`oc-src-${a}`} viewBox="0 0 10 10" refX="5" refY="5" markerWidth="5" markerHeight="5">
          <circle cx="5" cy="5" r="4" class=${`oc-ah h-${a}`} /></marker>`)}</defs>
      <g ref=${worldRef} class="oc-world">
        <g class="oc-tree">${L.tree.map((d, i) => html`<path key=${i} d=${d} />`)}</g>
        <g class="oc-teams">${L.boxes.map((b) => html`<${TeamBox} key=${b.key} b=${b} q=${q} onFold=${onFold} />`)}</g>
        <${TrafficLayer} edges=${edges} q=${q} />
        <g class="oc-cards">
          ${L.tops.map((c) => html`<${Card} key=${c.key} c=${c} lead=${true} cls=${q ? (hits(c.node, q) ? "match" : "dim") : ""} onOpen=${open} />`)}
          ${L.boxes.flatMap((b) => b.cells.map((c) => html`<${Card} key=${c.key} c=${c} lead=${false} cls=${q ? (hits(c.node, q) ? "match" : "dim") : ""} onOpen=${open} />`))}
        </g>
      </g>
    </svg>
    ${traffic ? html`<${Legend} />` : null}
    <div class="oc-zoom" role="group" aria-label=${tc("view")}>
      <button type="button" class="icon-btn" aria-label=${tc("zoomIn")} title=${tc("zoomIn")} onClick=${() => zoomBy(1.25)}><${Icon} name="plus" size=${16} /></button>
      <button type="button" class="icon-btn" aria-label=${tc("zoomOut")} title=${tc("zoomOut")} onClick=${() => zoomBy(0.8)}><span aria-hidden="true">−</span></button>
      <button type="button" class="icon-btn" aria-label=${tc("fit")} title=${tc("fit")} onClick=${fit}><${Icon} name="org" size=${16} /></button>
    </div>
    <svg ref=${miniRef} class="oc-mini" viewBox=${`${box.x} ${box.y} ${box.w} ${box.h}`} aria-hidden="true" onClick=${onMini}>
      <title>${tc("minimap")}</title>
      ${L.tops.map((c) => html`<rect key=${c.key} class="oc-mini-top" x=${c.x} y=${c.y} width=${c.w} height=${c.h} rx="10" />`)}
      ${L.boxes.map((b) => html`<rect key=${b.key} class=${`oc-mini-team${b.nodes.some((n) => n.state === "needs") ? " needs" : ""}${q && b.nodes.some((n) => hits(n, q)) ? " match" : ""}`}
        x=${b.x} y=${b.y} width=${b.w} height=${b.h} rx="12" />`)}
      ${q ? cardsOf(L).filter((c) => hits(c.node, q)).map((c) => html`<rect key=${`m:${c.key}`} class="oc-mini-hit" x=${c.x} y=${c.y} width=${c.w} height=${c.h} rx="8" />`) : null}
      <rect ref=${miniViewRef} class="oc-mini-view" />
    </svg>
  </div>`;
}

const miniBox = (L) => ({ x: OC.TRUNK - 30, y: 0, w: Math.max(1, L.width - OC.TRUNK + 60), h: Math.max(1, L.height + 20) });

/** The card nearest the one with `key` in direction `dir` ([dx, dy]); null when there is none that way. */
export function nearest(cards, key, dir) {
  const from = cards.find((c) => c.key === key);
  if (!from) return null;
  const fx = from.x + from.w / 2, fy = from.y + from.h / 2;
  let best = null, bestScore = Infinity;
  for (const c of cards) {
    if (c === from) continue;
    const dx = c.x + c.w / 2 - fx, dy = c.y + c.h / 2 - fy;
    const along = dx * dir[0] + dy * dir[1];
    if (along <= 1) continue;
    const across = Math.abs(dx * dir[1]) + Math.abs(dy * dir[0]);
    const score = along + across * 2;
    if (score < bestScore) { best = c; bestScore = score; }
  }
  return best;
}
function focusCard(svg, key) {
  const el = svg && [...svg.querySelectorAll(".oc-node")].find((n) => n.getAttribute("data-key") === key);
  if (el && typeof el.focus === "function") el.focus();
}

/**
 * The tab's body (the Fleet panel's loader passes /ui/org's answer and the app store): Canvas or List, chosen per
 * device; the list is fleet-org.js's chart, which is also what a screen reader is pointed to.
 */
export function OrgCanvas({ org, app, lease }) {
  useIdentityColors();
  const [mode, setMode] = useState(readMode);
  const [live, setLive] = useState(readLive);
  const traffic = useTraffic(lease, live);
  const sending = useMemo(() => sendingBy(traffic), [traffic]);
  const [folded, setFolded] = useState(readFolded);
  const [query, setQuery] = useState("");
  const [jump, setJump] = useState(null);
  const view = useMemo(() => buildOrgView(org, app), [org, app]);
  useEffect(() => { save(MODE_KEY, mode); }, [mode]);
  useEffect(() => { save(LIVE_KEY, live ? "1" : "0"); }, [live]);
  if (!app.ready) return html`<${Skeleton} lines=${4} />`;
  if (!view.total) return html`<${Empty} icon="team" title=${t("org.empty")} hint=${t("org.emptyHint")} />`;
  const q = needle(query);
  const all = [...view.top, ...view.teams.flatMap((tm) => tm.nodes), ...view.rest.nodes];
  const found = q ? new Set(all.filter((n) => hits(n, q)).map((n) => n.name)).size : 0;
  const onFold = (key) => setFolded((cur) => {
    const next = new Set(cur);
    if (next.has(key)) next.delete(key); else next.add(key);
    save(FOLD_KEY, JSON.stringify([...next]));
    return next;
  });
  const onFind = (e) => {
    if (e.key !== "Enter" || !q) return;
    e.preventDefault();
    const first = all.find((n) => hits(n, q));
    if (!first) return;
    const groups = [...view.teams.map((tm) => [tm.name, tm.nodes]), [REST_KEY, view.rest.nodes]];
    const holder = view.top.includes(first) ? null : groups.find(([, nodes]) => nodes.includes(first));
    if (holder && folded.has(holder[0])) onFold(holder[0]);
    setJump({ name: first.name, at: Date.now() });
  };
  const modeBtn = (m) => html`<button type="button" class=${`btn btn-sm${mode === m ? " btn-primary" : ""}`} aria-pressed=${mode === m ? "true" : "false"}
    onClick=${() => setMode(m)}>${tc(m)}</button>`;
  return html`<div class=${`org oc oc-${mode}`}>
    <div class="list-head org-head oc-bar">
      <span>${view.total === 1 ? t("org.instance") : t("org.instances", view.total)}</span><${OrgSummary} counts=${view.counts} />
      <div class="oc-tools">
        ${mode === "canvas" ? html`<label class="s-search oc-find"><${Icon} name="search" size=${14} /><span class="sr-only">${tc("find")}</span>
          <input type="search" value=${query} placeholder=${tc("findShort")} autocomplete="off" onInput=${(e) => setQuery(e.target.value)} onKeyDown=${onFind} />
          ${q ? html`<span class="oc-found" role="status">${found ? (found === 1 ? tc("foundOne") : tc("found", found)) : tc("noMatch")}</span>` : null}</label>` : null}
        <button type="button" class=${`btn btn-sm oc-live${live ? " on" : ""}`} aria-pressed=${live ? "true" : "false"} title=${live ? tc("liveOn") : tc("liveOff")}
          onClick=${() => setLive((v) => !v)}><span class="oc-live-dot" aria-hidden="true"></span>${tc("live")}</button>
        <div class="seg-inline" role="group" aria-label=${tc("view")}>${modeBtn("canvas")}${modeBtn("list")}</div>
      </div>
    </div>
    ${mode === "list" ? html`<${OrgChart} org=${org} app=${app} bare=${true} sending=${sending} />`
      : html`<${Canvas} view=${view} folded=${folded} onFold=${onFold} q=${q} jump=${jump} traffic=${live ? traffic : null} />`}
  </div>`;
}
