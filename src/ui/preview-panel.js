// #1481: an agent's HTML preview (#1306) in a panel beside the conversation — a split with a draggable divider on a
// wide screen, a full-screen sheet on a narrow one. Nothing about the preview itself changes here: the frame is the one
// preview.js makes (mountPreview: the preview origin, sandbox allow-scripts only), started by AgendPreview.start like a
// card's, only told to fill the panel. It runs on a click, as a card's does:
// - "Open in panel" on an idle card opens the panel with its Preview button — the panel runs nothing by itself;
// - on a card whose preview is running, the same button moves that run to the panel (stopped in the card, started in
//   the panel: a moved frame reloads anyway);
// - a newer version of the block in a later reply is offered, never swapped in, and offered with Preview to click.
// Closing the panel or leaving the chat stops its frame; one preview per page still holds (start() stops any other).
import { html, useEffect, useRef, useState } from "/assets/app-html.js";
import { t } from "/assets/app-i18n.js";
import { Icon } from "/assets/ui-icons.js";
import "./chat-render.js";
import "./preview.js";
import { loadHtmlAttachment } from "./html-attachment.js";

const R = () => globalThis.AgendChatRender;
const P = () => globalThis.AgendPreview;

// ── The panel's state, one per page (the chat shows one instance at a time) ──

/** open: { key, instance, msgKey, n | att, code, sender, ts } | null (`att`: an attached .html file, #1306 Q4); run: start it on mount (a moved run). */
let state = { open: null, run: 0 };
const subs = new Set();
function set(next) { state = next; for (const fn of [...subs]) { try { fn(state); } catch { /* one listener's error stops no other */ } } }
export const panelStore = { get: () => state, subscribe(fn) { subs.add(fn); return () => { subs.delete(fn); }; } };

/** The frame's key in preview.js: its own, so the card that opened it keeps its own state. */
export const frameKey = (key) => `panel:${key}`;
/** Show `spec` in the panel; `run`: start it there (a click that moves a running preview). The block shown before stops. */
export function openPanel(spec, { run = false } = {}) {
  if (state.open && P()) P().stop(frameKey(state.open.key), "stopped", "");
  set({ open: { ...spec }, run: run ? state.run + 1 : 0 });
}
/** Close the panel: its frame stops first. */
export function closePanel() {
  if (state.open && P()) P().stop(frameKey(state.open.key), "stopped", "");
  if (state.open) set({ open: null, run: 0 });
}
/** The card key the panel shows, or null. */
export const shownKey = () => (state.open ? state.open.key : null);

/** The text of a block's <title>, or "" — what says two blocks are versions of one thing. */
export function htmlTitle(code) {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(String(code || ""));
  return m ? m[1].replace(/\s+/g, " ").trim() : "";
}

/**
 * A newer version of the shown block: the last complete ```html block in an agent reply after the one it came from.
 * When the shown block has a <title>, only a block with the same title counts (another page is not a new version);
 * without one, the newest block does. `msgs` in order; `keyOf` makes a message's key.
 */
export function newerVersion(open, msgs, keyOf) {
  if (!open || !Array.isArray(msgs)) return null;
  const at = msgs.findIndex(x => keyOf(x) === open.msgKey);
  if (at < 0) return null;
  // An attached file: a later agent reply attaching a file of the same name is its newer version. Its HTML is read
  // when the person picks it (code: null here), as on a card.
  if (open.att) {
    const name = String(open.att.name || "").trim().toLowerCase();
    for (let i = msgs.length - 1; i > at; i--) {
      const x = msgs[i];
      if (x.role !== "agent" || !Array.isArray(x.attachments)) continue;
      for (let k = x.attachments.length - 1; k >= 0; k--) {
        const a = x.attachments[k];
        if (!R().isHtmlAttachment(a) || a.name.trim().toLowerCase() !== name) continue;
        const msgKey = keyOf(x);
        return { key: `${msgKey}:a${a.id}`, instance: open.instance, msgKey, att: { id: a.id, name: a.name, size: a.size }, code: null, sender: x.sender, ts: x.ts };
      }
    }
    return null;
  }
  const title = htmlTitle(open.code);
  for (let i = msgs.length - 1; i > at; i--) {
    const x = msgs[i];
    if (x.role !== "agent") continue;
    const fences = R().htmlFences(x.text);
    for (let n = fences.length - 1; n >= 0; n--) {
      const f = fences[n];
      if (!f.terminated || (title && htmlTitle(f.code) !== title)) continue;
      const msgKey = keyOf(x);
      return { key: `${msgKey}:f${n}`, instance: open.instance, msgKey, n, code: f.code, sender: x.sender, ts: x.ts };
    }
  }
  return null;
}

// ── The panel's width: this device's choice (a convenience — the panel works without storage) ──

const WIDTH_KEY = "agend_preview_panel_w";
export const MIN_PANEL = 320, MIN_THREAD = 360, STEP = 32;
function storedWidth() { try { const v = Number(localStorage.getItem(WIDTH_KEY)); return Number.isFinite(v) && v > 0 ? v : null; } catch { return null; } }
function storeWidth(w) { try { localStorage.setItem(WIDTH_KEY, String(Math.round(w))); } catch { /* this page only */ } }
/** The width a panel may have in a split `total` px wide: at least MIN_PANEL, leaving the thread MIN_THREAD. */
export function clampWidth(w, total) {
  const max = Math.max(MIN_PANEL, total - MIN_THREAD - 8);
  return Math.round(Math.min(max, Math.max(MIN_PANEL, w)));
}

const timeOf = (ts) => (ts ? new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "");

/**
 * The panel, inside the chat's split (`split`: that element — the divider sets its width there, through CSSOM).
 * props: name (the instance), msgs() → its messages, subscribe(fn) → unsubscribe (the chat store's), keyOf(x),
 * reveal(msgKey) (the thread shows that message), download(code).
 */
export function PreviewPanel({ name, split, msgs, subscribe, keyOf, reveal, download }) {
  const [st, setSt] = useState(state);
  const [view, setView] = useState("preview");
  const [run, setRun] = useState({ state: "idle", reason: "" });
  const [newer, setNewer] = useState(null);
  const [newerNote, setNewerNote] = useState("");
  const reading = useRef(null);   // the newer version whose file is being read (one at a time)
  const holder = useRef(null), divider = useRef(null), panel = useRef(null);
  const open = st.open && st.open.instance === name ? st.open : null;

  useEffect(() => panelStore.subscribe(setSt), []);
  // This device's choice (here or in another tab) decides whether Preview is offered: re-read it when it changes.
  const [, choice] = useState(0);
  useEffect(() => (P() ? P().onChange(() => choice(n => n + 1)) : undefined), []);
  // Leaving the chat (another instance, another panel) closes the panel: its frame stops with the thread's.
  useEffect(() => () => closePanel(), []);

  const ui = { state: (s, reason) => setRun({ state: s === "starting" || s === "running" ? s : "idle", reason: reason || "" }) };
  const start = () => {
    if (!open || !holder.current) return;
    setView("preview");
    P().start(frameKey(open.key), holder.current, open.code, ui, { fill: true });
  };
  const stop = () => { if (open) P().stop(frameKey(open.key), "stopped", ""); };
  // A new block in the panel: what ran before is gone (openPanel stopped it); a moved run starts here.
  useEffect(() => {
    setRun({ state: "idle", reason: "" });
    setView("preview");
    if (open && st.run) start();
    // Focus goes to the panel's close control that is on screen (Back on a phone, × beside the thread).
    if (panel.current) { const f = [...panel.current.querySelectorAll(".pv-panel-close")].find(b => b.offsetParent !== null); if (f) f.focus(); }
  }, [open && open.key, st.run]);
  // A later reply with a newer version of this block: offered, not swapped in.
  useEffect(() => {
    setNewerNote(""); reading.current = null;
    if (!open) { setNewer(null); return undefined; }
    const check = () => setNewer(newerVersion(open, msgs() || [], keyOf));
    check();
    return subscribe((instance, kind) => { if (instance === name && kind === "msgs") check(); });
  }, [open && open.key, name]);

  // The divider: drag, or the arrow keys, Home and End; the width is this device's.
  const widthNow = useRef(MIN_PANEL);
  const applyWidth = (w, save) => {
    const sp = split.current; if (!sp) return;
    const total = sp.clientWidth || 0;
    const v = clampWidth(w, total);
    widthNow.current = v;
    sp.style.setProperty("--pv-w", `${v}px`);           // CSSOM: the page's CSP allows no style attribute
    if (divider.current) { divider.current.setAttribute("aria-valuenow", String(v)); divider.current.setAttribute("aria-valuemax", String(clampWidth(Infinity, total))); }
    if (save) storeWidth(v);
  };
  useEffect(() => { if (open) applyWidth(storedWidth() ?? (split.current && split.current.clientWidth || 0) / 2, false); }, [!!open]);
  const width = () => widthNow.current;
  const setWidth = (w) => applyWidth(w, true);
  const onKey = (e) => {
    const k = e.key;
    if (k === "ArrowLeft") setWidth(width() + STEP);
    else if (k === "ArrowRight") setWidth(width() - STEP);
    else if (k === "Home") setWidth(Infinity);
    else if (k === "End") setWidth(0);
    else return;
    e.preventDefault();
  };
  const onDown = (e) => {
    const sp = split.current; if (!sp || e.button !== 0) return;
    e.preventDefault();
    const el = e.currentTarget;
    try { el.setPointerCapture(e.pointerId); } catch { /* the move still works while over the divider */ }
    sp.classList.add("resizing");         // frames take no pointer events meanwhile, or the drag would stop over one
    const right = sp.getBoundingClientRect().right;
    const move = (ev) => applyWidth(right - ev.clientX - 4, false);
    const up = () => { sp.classList.remove("resizing"); storeWidth(widthNow.current); el.removeEventListener("pointermove", move); el.removeEventListener("pointerup", up); el.removeEventListener("pointercancel", up); };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };
  // Show the newer version: an attached file's HTML is read first. A read the panel moved on from is dropped.
  const showNewer = async () => {
    if (!newer || reading.current) return;
    if (newer.code != null) { openPanel(newer); return; }
    const was = open && open.key, mine = reading.current = newer;
    setNewerNote(t("chat.pvLoading"));
    const r = await loadHtmlAttachment(newer.att);
    if (reading.current !== mine) return;
    reading.current = null;
    const now = panelStore.get().open;
    if (!now || now.key !== was) return;
    if (!r.ok) { setNewerNote(t(r.reason === "over" ? "chat.pvAttOver" : r.reason === "gone" ? "chat.pvAttGone" : "chat.pvAttFailed")); return; }
    openPanel({ ...newer, code: r.code });
  };
  const fileName = open && open.att ? open.att.name : undefined;
  // Esc in the panel closes it (and is not the chat's "stop the reply").
  const onPanelKey = (e) => { if (e.key === "Escape" && !e.isComposing) { e.preventDefault(); closePanel(); } };

  if (!open) return null;
  const going = run.state === "starting" || run.state === "running";
  const a = P().availability();
  const note = run.reason || (going ? (run.state === "starting" ? t("chat.pvStarting") : "") : a.ok ? t("chat.pvPanelIdle") : a.reason);
  const source = t("chat.pvSource", open.sender || name, timeOf(open.ts));
  return html`<div class="pv-divider" ref=${divider} role="separator" aria-orientation="vertical" tabindex="0" aria-label=${t("chat.pvResize")}
      aria-valuemin=${String(MIN_PANEL)} onKeyDown=${onKey} onPointerDown=${onDown}></div>
    <aside class="pv-panel" ref=${panel} aria-label=${t("chat.pvPanel")} onKeyDown=${onPanelKey}>
      <div class="pv-panel-head">
        <button type="button" class="icon-btn only-narrow pv-panel-close" title=${t("chat.pvBack")} aria-label=${t("chat.pvBack")} onClick=${closePanel}><${Icon} name="back" size=${18} /></button>
        <div class="pv-panel-title"><strong>${t("chat.pvPanel")}</strong>
          <button type="button" class="pv-source" title=${source} onClick=${() => { if (window.matchMedia && window.matchMedia("(max-width: 899px)").matches) closePanel(); reveal(open.msgKey); }}>${source}</button></div>
        <button type="button" class="icon-btn only-wide pv-panel-close" title=${t("chat.pvClose")} aria-label=${t("chat.pvClose")} onClick=${closePanel}><${Icon} name="close" size=${18} /></button>
      </div>
      <div class="pv-panel-bar">
        <div class="seg-inline" role="group" aria-label=${t("chat.pvPanel")}>
          <button type="button" class=${`btn btn-sm${view === "preview" ? " on" : ""}`} aria-pressed=${view === "preview" ? "true" : "false"} onClick=${() => setView("preview")}><${Icon} name="eye" size=${14} />${t("chat.pvPage")}</button>
          <button type="button" class=${`btn btn-sm${view === "code" ? " on" : ""}`} aria-pressed=${view === "code" ? "true" : "false"} onClick=${() => setView("code")}><${Icon} name="code" size=${14} />${t("chat.pvCode")}</button>
        </div>
        <span class="grow"></span>
        ${going ? html`<button type="button" class="btn btn-sm pv-panel-reload" title=${t("chat.pvReload")} onClick=${() => { stop(); start(); }}><${Icon} name="restart" size=${14} /><span class="lbl">${t("chat.pvReload")}</span></button>
          <button type="button" class="btn btn-sm pv-panel-stop" title=${t("chat.pvStop")} onClick=${stop}><${Icon} name="stop" size=${14} /><span class="lbl">${t("chat.pvStop")}</span></button>`
          : html`<button type="button" class="btn btn-sm btn-primary pv-panel-run" title=${t("chat.pvPreview")} disabled=${!a.ok} onClick=${start}><${Icon} name="play" size=${14} /><span class="lbl">${t("chat.pvPreview")}</span></button>`}
        <button type="button" class="btn btn-sm pv-panel-dl" title=${t("chat.pvDownload")} onClick=${() => download(open.code, fileName)}><${Icon} name="download" size=${14} /><span class="lbl">${t("chat.pvDownload")}</span></button>
      </div>
      ${newer && newer.key !== open.key ? html`<div class="pv-newer" role="status"><span>${t("chat.pvNewer", timeOf(newer.ts))}</span>
        <button type="button" class="btn btn-sm pv-newer-show" onClick=${showNewer}>${t("chat.pvNewerShow")}</button>${newerNote ? html`<span class="pv-newer-note">${newerNote}</span>` : null}</div>` : null}
      ${going ? html`<div class="pv-banner">${P().BANNER}</div>` : null}
      ${note && view === "preview" ? html`<div class="pv-note">${note}</div>` : null}
      <div class=${`pv-panel-body${view === "code" ? " show-code" : ""}`}>
        <div class="pv-holder" ref=${holder}></div>
        ${view === "code" ? html`<pre class="pv-code"><code>${open.code}</code></pre>` : null}
      </div>
    </aside>`;
}
