// Fleet → Org chart → Office → Edit layout (#2513): an admin moves things on a stored office's zones skin — its seats,
// furniture, the door and the walkable graph's waypoints — and adds or removes waypoints and the corridors between
// them. The pack stays as it was uploaded: what differs from it is kept as the office's `overrides` (fleet-office-pack.js
// overridesBetween), saved with the whole list and the rev read (PUT /ui/offices; a change made meanwhile is a 409).
// Reset goes back to the pack's own positions. A "show coordinates" overlay draws the 1280×720 logical grid.
//
// Every handle is a button for the keyboard too: Tab to it, the arrow keys move it (Shift: by 10), Delete removes a
// waypoint; the selected waypoint's corridors are listed with a way to join or unjoin each. Never offered to a guest,
// the public link or a read-only session (the host refuses their saves too).
//
// The pure part (handles, moving, adding and removing) is exported for tests; LayoutEditor is the overlay.
import { html, useEffect, useLayoutEffect, useRef, useState } from "/assets/app-html.js";
import { t, register } from "/assets/app-i18n.js";
import { LOGICAL, overridesBetween, own } from "./fleet-office-pack.js";

register("orgl", {
  en: {
    edit: "Edit layout", title: "Edit layout", coords: "Show coordinates", addWaypoint: "Add waypoint", removeWaypoint: "Remove waypoint",
    joinTo: "Join to", join: "Join", unjoin: "Unjoin {0}", corridors: "Corridors", none: "Nothing selected: pick a seat, an item, the door or a waypoint.",
    reset: "Reset to the pack's layout", save: "Save layout", cancel: "Cancel", saved: "Layout saved.", hint: "Drag, or use the arrow keys (Shift: by 10).",
    seat: "Seat {0} in {1}", furniture: "Item {0}", door: "Door", waypoint: "Waypoint {0}", at: "{0} at {1}, {2}",
    changed: "Someone changed the offices meanwhile. Your layout is kept: Save again puts it on the current list.",
    failed: "The layout was not saved ({0}).", rateLimited: "Too many saves. Try again in a minute.",
    stale: "This office was removed or its style changed meanwhile: this layout can no longer be saved. Cancel closes it.",
  },
  "zh-TW": {
    edit: "編輯配置", title: "編輯配置", coords: "顯示座標", addWaypoint: "新增路徑點", removeWaypoint: "移除路徑點",
    joinTo: "連到", join: "連接", unjoin: "取消連接 {0}", corridors: "走道", none: "尚未選取：請選座位、家具、門或路徑點。",
    reset: "還原成 pack 的配置", save: "儲存配置", cancel: "取消", saved: "配置已儲存。", hint: "拖曳，或用方向鍵移動（Shift：一次 10）。",
    seat: "{1} 的座位 {0}", furniture: "家具 {0}", door: "門", waypoint: "路徑點 {0}", at: "{0}，位置 {1}, {2}",
    changed: "有人在這期間修改了辦公室。你的配置已保留：再按一次儲存，會套用到目前的清單。",
    failed: "配置沒有儲存（{0}）。", rateLimited: "儲存太頻繁，請一分鐘後再試。",
    stale: "這個辦公室在這期間被移除，或它的風格已改變：這份配置無法再儲存。按取消關閉。",
  },
});
const tl = (k, ...v) => t(`orgl.${k}`, ...v);

// ── The pure part ──

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(v)));
/** Every handle on a pack: { key, kind, label, x, y } — seats by area, furniture, the door, the waypoints. */
export function handlesOf(pack) {
  const out = [];
  for (const [name, a] of Object.entries(pack.areas)) a.seats.forEach((s, i) => out.push({ key: `seat:${name}:${i}`, kind: "seat", label: tl("seat", i + 1, name), x: s.x, y: s.y }));
  for (const f of pack.furniture) out.push({ key: `furn:${f.id}`, kind: "furniture", label: tl("furniture", f.id), x: f.x, y: f.y });
  out.push({ key: "door", kind: "door", label: tl("door"), x: pack.door.x, y: pack.door.y });
  for (const w of pack.waypoints) out.push({ key: `wp:${w.id}`, kind: "waypoint", label: tl("waypoint", w.id), x: w.x, y: w.y });
  return out;
}
/** The pack with handle `key` at (x, y), rounded and kept in range: a seat inside its area, anything else on the canvas. */
export function moveHandle(pack, key, x, y) {
  const [kind, a, b] = key.split(":");
  const inCanvas = () => ({ x: clamp(x, 0, LOGICAL.w), y: clamp(y, 0, LOGICAL.h) });
  if (kind === "seat") {
    const area = own(pack.areas, a), i = Number(b);
    if (!area || !area.seats[i]) return pack;
    const r = area.rect, p = { x: clamp(x, Math.ceil(r.x), Math.floor(r.x + r.w)), y: clamp(y, Math.ceil(r.y), Math.floor(r.y + r.h)) };
    return { ...pack, areas: { ...pack.areas, [a]: { ...area, seats: area.seats.map((s, j) => (j === i ? p : s)) } } };
  }
  if (kind === "furn") return { ...pack, furniture: pack.furniture.map((f) => (f.id === a ? { ...f, ...inCanvas() } : f)) };
  if (kind === "door") return { ...pack, door: inCanvas() };
  if (kind === "wp") return { ...pack, waypoints: pack.waypoints.map((w) => (w.id === a ? { ...w, ...inCanvas() } : w)) };
  return pack;
}
/** A new waypoint at (x, y), named wp-<n> (a name no other waypoint has); returns { pack, id }. */
export function addWaypoint(pack, x = LOGICAL.w / 2, y = LOGICAL.h / 2) {
  const ids = new Set(pack.waypoints.map((w) => w.id));
  let n = pack.waypoints.length + 1;
  while (ids.has(`wp-${n}`)) n++;
  const id = `wp-${n}`;
  return { pack: { ...pack, waypoints: [...pack.waypoints, { id, x: clamp(x, 0, LOGICAL.w), y: clamp(y, 0, LOGICAL.h) }] }, id };
}
/** The pack without waypoint `id` and its corridors. */
export function removeWaypoint(pack, id) {
  return { ...pack, waypoints: pack.waypoints.filter((w) => w.id !== id), edges: pack.edges.filter((e) => e[0] !== id && e[1] !== id) };
}
/** A corridor between `a` and `b` added, or removed when there is one (either way round). */
export function toggleEdge(pack, a, b) {
  if (a === b || !pack.waypoints.some((w) => w.id === a) || !pack.waypoints.some((w) => w.id === b)) return pack;
  const has = (e) => (e[0] === a && e[1] === b) || (e[0] === b && e[1] === a);
  return { ...pack, edges: pack.edges.some(has) ? pack.edges.filter((e) => !has(e)) : [...pack.edges, [a, b]] };
}
/** What Save keeps: the overrides between the pack and the edited layout (null: the pack's own). */
export const layoutOverrides = (base, edited) => overridesBetween(base, edited);

// ── The overlay ──

const GRID = 80, LABEL = 160;
const KEY_STEP = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };

/**
 * The editor over the canvas: `base` the pack as uploaded; `start` the layout shown when it opens (the base with the
 * office's overrides on it); `place(el)` puts the overlay over the scene wherever the view has it (#2540: panned and
 * zoomed; the page sets its box through the CSSOM, never a style attribute: #1300) — a pointer is read back through
 * the overlay's own box, so a drag lands on the logical point under it at any zoom; `onChange(edited)` as anything
 * moves (the canvas redraws it); `onSave(overrides | null)` → { ok } or { ok: false, message }; `onClose()`. `stale` (a message): the
 * office or its style changed underneath the session — no handles, nothing to save, only Cancel.
 */
export function LayoutEditor({ base, start, place = null, stale = "", onChange, onSave, onClose }) {
  const [edited, setEdited] = useState(start);
  const [sel, setSel] = useState(null);
  const [coords, setCoords] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [joinTo, setJoinTo] = useState("");
  const svg = useRef(null), drag = useRef(null), overlay = useRef(null);
  useLayoutEffect(() => { if (place) place(overlay.current); });
  const change = (next) => { setEdited(next); onChange(next); };
  useEffect(() => { onChange(start); }, []);
  const handles = handlesOf(edited);
  const selected = sel ? handles.find((h) => h.key === sel) || null : null;
  const toLogical = (e) => {
    const r = svg.current && svg.current.getBoundingClientRect ? svg.current.getBoundingClientRect() : null;
    if (!r || !r.width || !r.height) return null;
    return { x: ((e.clientX - r.left) / r.width) * LOGICAL.w, y: ((e.clientY - r.top) / r.height) * LOGICAL.h };
  };
  const down = (key) => (e) => {
    if (busy) return;
    setSel(key); drag.current = key;
    try { e.currentTarget?.setPointerCapture?.(e.pointerId); } catch { /* not captured: moves still reach the svg */ }
  };
  const move = (e) => { if (!drag.current) return; const p = toLogical(e); if (p) change(moveHandle(edited, drag.current, p.x, p.y)); };
  const up = () => { drag.current = null; };
  const keyOn = (h) => (e) => {
    if (busy) return;
    const d = KEY_STEP[e.key];
    if (d) { e.preventDefault(); const k = e.shiftKey ? 10 : 1; setSel(h.key); change(moveHandle(edited, h.key, h.x + d[0] * k, h.y + d[1] * k)); return; }
    if ((e.key === "Delete" || e.key === "Backspace") && h.kind === "waypoint") { e.preventDefault(); change(removeWaypoint(edited, h.key.slice(3))); setSel(null); }
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSel(h.key); }
  };
  const add = () => { const at = selected ? { x: selected.x + 40, y: selected.y } : { x: LOGICAL.w / 2, y: LOGICAL.h / 2 }; const r = addWaypoint(edited, at.x, at.y); change(r.pack); setSel(`wp:${r.id}`); };
  const wpSel = selected && selected.kind === "waypoint" ? selected.key.slice(3) : null;
  const save = async () => {
    if (busy) return;
    setBusy(true); setMsg("");
    try {
      const r = await onSave(layoutOverrides(base, edited));
      if (r && r.ok) { onClose(); return; }
      setMsg(r && r.message ? r.message : tl("failed", "?"));
    } finally { setBusy(false); }
  };
  const reset = () => { change(base); setSel(null); setMsg(""); };
  const grid = [];
  if (coords) {
    for (let x = GRID; x < LOGICAL.w; x += GRID) grid.push(html`<line key=${`gx${x}`} class="ol-grid" x1=${x} y1="0" x2=${x} y2=${LOGICAL.h} />`);
    for (let y = GRID; y < LOGICAL.h; y += GRID) grid.push(html`<line key=${`gy${y}`} class="ol-grid" x1="0" y1=${y} x2=${LOGICAL.w} y2=${y} />`);
    for (let x = 0; x < LOGICAL.w; x += LABEL) grid.push(html`<text key=${`lx${x}`} class="ol-label" x=${x + 3} y="14">${x}</text>`);
    for (let y = LABEL; y < LOGICAL.h; y += LABEL) grid.push(html`<text key=${`ly${y}`} class="ol-label" x="3" y=${y - 3}>${y}</text>`);
  }
  const at = new Map(edited.waypoints.map((w) => [w.id, w]));
  const edgeKey = (e) => `${e[0]}\u0000${e[1]}`;
  if (stale) {
    return html`<div class="ol" role="group" aria-label=${tl("title")}><div class="ol-bar">
      <p class="note ol-msg ol-stale" role="status">${stale}</p>
      <span class="ol-actions"><button type="button" class="btn btn-sm ol-cancel" onClick=${onClose} disabled=${busy}>${tl("cancel")}</button></span>
    </div></div>`;
  }
  return html`<div class="ol" role="group" aria-label=${tl("title")}>
    <div class="ol-overlay" ref=${overlay}>
      <svg ref=${svg} class="ol-svg" viewBox=${`0 0 ${LOGICAL.w} ${LOGICAL.h}`} width="100%" height="100%"
        onPointerMove=${move} onPointerUp=${up} onPointerCancel=${up} onPointerLeave=${up}>
        ${grid}
        ${Object.values(edited.areas).map((a) => html`<rect key=${`a:${a.name}`} class="ol-area" x=${a.rect.x} y=${a.rect.y} width=${a.rect.w} height=${a.rect.h} />`)}
        ${edited.edges.map((e) => { const p = at.get(e[0]), q = at.get(e[1]); return p && q ? html`<line key=${`e:${edgeKey(e)}`} class="ol-edge" x1=${p.x} y1=${p.y} x2=${q.x} y2=${q.y} />` : null; })}
        ${handles.map((h) => html`<g key=${h.key} class=${`ol-handle ol-${h.kind}${sel === h.key ? " on" : ""}`} data-handle=${h.key} tabindex="0" role="button"
            aria-label=${tl("at", h.label, h.x, h.y)} aria-pressed=${sel === h.key ? "true" : "false"}
            onPointerDown=${down(h.key)} onKeyDown=${keyOn(h)} onFocus=${() => setSel(h.key)}>
          ${h.kind === "door" ? html`<rect x=${h.x - 9} y=${h.y - 9} width="18" height="18" transform=${`rotate(45 ${h.x} ${h.y})`} />`
            : h.kind === "furniture" ? html`<rect x=${h.x - 8} y=${h.y - 8} width="16" height="16" />`
            : html`<circle cx=${h.x} cy=${h.y} r=${h.kind === "seat" ? 9 : 7} />`}
          ${coords && sel === h.key ? html`<text class="ol-coord" x=${h.x + 12} y=${h.y - 10}>${h.x}, ${h.y}</text>` : null}
        </g>`)}
      </svg>
    </div>
    <div class="ol-bar">
      <label class="check"><input type="checkbox" class="ol-coords" checked=${coords} onChange=${() => setCoords((v) => !v)} /><span>${tl("coords")}</span></label>
      <button type="button" class="btn btn-sm ol-add" onClick=${add} disabled=${busy}>${tl("addWaypoint")}</button>
      <span class="muted ol-sel" aria-live="polite">${selected ? tl("at", selected.label, selected.x, selected.y) : tl("none")}</span>
      ${wpSel ? html`<button type="button" class="btn btn-sm btn-danger ol-remove" onClick=${() => { change(removeWaypoint(edited, wpSel)); setSel(null); }} disabled=${busy}>${tl("removeWaypoint")}</button>
        <label class="oo-pick"><span class="oo-pick-label">${tl("joinTo")}</span>
          <select class="tb-select ol-join-to" value=${joinTo} onChange=${(e) => setJoinTo(e.target.value)}>
            <option value="">—</option>
            ${edited.waypoints.filter((w) => w.id !== wpSel).map((w) => html`<option key=${w.id} value=${w.id}>${w.id}</option>`)}
          </select></label>
        <button type="button" class="btn btn-sm ol-join" disabled=${busy || !joinTo || joinTo === wpSel} onClick=${() => { change(toggleEdge(edited, wpSel, joinTo)); setJoinTo(""); }}>${tl("join")}</button>
        <span class="ol-corridors">${edited.edges.filter((e) => e[0] === wpSel || e[1] === wpSel).map((e) => { const other = e[0] === wpSel ? e[1] : e[0];
          return html`<button key=${edgeKey(e)} type="button" class="btn btn-sm ol-unjoin" data-other=${other} disabled=${busy} onClick=${() => change(toggleEdge(edited, wpSel, other))}>${tl("unjoin", other)}</button>`; })}</span>` : null}
      <span class="ol-actions">
        <button type="button" class="btn btn-sm ol-reset" onClick=${reset} disabled=${busy}>${tl("reset")}</button>
        <button type="button" class="btn btn-sm ol-cancel" onClick=${onClose} disabled=${busy}>${tl("cancel")}</button>
        <button type="button" class="btn btn-sm btn-primary ol-save" onClick=${save} disabled=${busy}>${tl("save")}</button>
      </span>
      <span class="muted oo-note">${tl("hint")}</span>
      ${msg ? html`<p class="note ol-msg" role="status">${msg}</p>` : null}
    </div>
  </div>`;
}
