// #1481: an agent's HTML preview (#1306) in a panel beside the conversation — a split with a draggable divider on a
// wide screen, a full-screen sheet on a narrow one. Nothing about the preview itself changes here: the frame is the one
// preview.js makes (mountPreview: the preview origin, sandbox allow-scripts only), started by AgendPreview.start like a
// card's, only told to fill the panel. It runs on a person's click, as a card's does — and "Open in panel" is that click:
// - on an idle card it opens the panel and starts the preview there, as if Preview were clicked in the panel (#1704);
//   a device that has not allowed previews gets the "Allow previews" offer instead, and allowing it starts the run;
//   where previews cannot run (web.preview: false, a public link), the panel opens with nothing running;
// - on a card whose preview is running, the same button moves that run to the panel (stopped in the card, started in
//   the panel: a moved frame reloads anyway);
// - nothing runs by itself: not when the page loads, not when the panel is shown again, and a newer version of the
//   block in a later reply is offered, never swapped in, and shown with Preview to click.
// Closing the panel or leaving the chat stops its frame; one preview per page still holds (start() stops any other).
import { html, useEffect, useRef, useState } from "/assets/app-html.js";
import { t } from "/assets/app-i18n.js";
import { Icon } from "/assets/ui-icons.js";
import "./chat-render.js";
import "./preview.js";
import { loadHtmlAttachment } from "./html-attachment.js";
import { chatTime, onDayChange } from "./chat-time.js";
import { PanelActions } from "./preview-panel-actions.js";
import { htmlTitle, versionsOf, lineDiff, diffHunks, DIFF_LIMITS } from "./preview-versions.js";

export { htmlTitle };

const R = () => globalThis.AgendChatRender;
const P = () => globalThis.AgendPreview;

// ── The panel's state, one per page (the chat shows one instance at a time) ──

/**
 * open: { key, instance, msgKey, n | att, code, sender, ts } | null (`att`: an attached .html file, #1306 Q4);
 * run: start it on mount — the card's click, as a token no later open ever reuses (0: nothing to run).
 */
let state = { open: null, run: 0 };
let runs = 0, version = 0, claims = 0;
const subs = new Set();
function set(next) { state = next; version++; for (const fn of [...subs]) { try { fn(state); } catch { /* one listener's error stops no other */ } } }
export const panelStore = { get: () => state, subscribe(fn) { subs.add(fn); return () => { subs.delete(fn); }; } };
/** Moves on every open and close, and on every claim: what a card's click compares when its HTML arrives late. */
export const panelVersion = () => version;
/** A click that will show something in the panel (an attachment's HTML still to read): from now on it is the newest —
 *  any earlier click still reading is dropped when its answer comes. Returns the version the click owns. */
export function claimPanel() { claims++; return ++version; }
/** How many clicks have claimed: an inline Preview still reading asks only whether a newer click came (not a close). */
export const panelClaims = () => claims;

/** The frame's key in preview.js: its own, so the card that opened it keeps its own state. */
export const frameKey = (key) => `panel:${key}`;
/** Show `spec` in the panel; `run`: start it there (the card's "Open in panel" click). The block shown before stops. */
function retire(open) {
  if (!open) return;
  if (P()) P().stop(frameKey(open.key), "stopped", "");
}
export function openPanel(spec, { run = false } = {}) {
  const old = state.open;
  set({ open: { ...spec, kind: "html" }, run: run ? ++runs : 0 });
  retire(old); // State changes first: cleanup reentry cannot close a newer panel.
}
/** Close publishes the empty slot before old-owner callbacks can reenter. */
export function closePanel() {
  const old = state.open; if (!old) return;
  set({ open: null, run: 0 }); retire(old);
}
/** The card key the panel shows, or null. */
export const shownKey = () => (state.open ? state.open.key : null);

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

// ── #2911 (2): the page's width in the panel (a phone, a tablet, or the panel's own), this device's choice ──

const DEVICE_KEY = "agend_preview_panel_device";
/** The widths a preview can be shown at: CSS px, or null for the panel's full width. */
export const DEVICE_WIDTHS = { full: null, tablet: 768, phone: 390 };
export function storedDevice() { try { const v = localStorage.getItem(DEVICE_KEY); return Object.hasOwn(DEVICE_WIDTHS, v) ? v : "full"; } catch { return "full"; } }
function storeDevice(v) { try { localStorage.setItem(DEVICE_KEY, v); } catch { /* this page only */ } }
/** The element the page has fullscreen (standard, else webkit's), or null. */
const fullscreenEl = () => { const d = globalThis.document; return (d && (d.fullscreenElement || d.webkitFullscreenElement)) || null; };

/** #1770: as the thread shows it — the fleet's zone, with the day when it is not today. */
const timeOf = (ts) => (ts ? chatTime(ts, { yesterday: (hm) => t("chat.yesterdayAt", hm) }) : "");

/**
 * The panel, inside the chat's split (`split`: that element — the divider sets its width there, through CSSOM).
 * props: name (the instance), msgs() → its messages, subscribe(fn) → unsubscribe (the chat store's), keyOf(x),
 * reveal(msgKey) (the thread shows that message), download(code).
 */
/** allow(commit): this device's opt-in through the chat's one path (setPreviewOptIn: the confirm, then commit(setOptIn)) → the choice. */
export function PreviewPanel({ name, split, msgs, subscribe, keyOf, reveal, download, allow }) {
  const [st, setSt] = useState(state);
  const [view, setView] = useState("preview");
  const [run, setRun] = useState({ state: "idle", reason: "" });
  const [newer, setNewer] = useState(null);
  const [newerNote, setNewerNote] = useState("");
  const [vers, setVers] = useState({ list: [], index: -1 });   // #2911 (1): the shown block's versions in the thread
  const [changes, setChanges] = useState(null);                // the Changes view: { state, from, hunks, shown, total }
  const keepView = useRef(false);                               // a version step keeps Code / Changes on screen
  const loaded = useRef(new Map());                             // an attached version's HTML, read once (key → code)
  const reading = useRef(null);   // the newer version whose file is being read (one at a time)
  const pending = useRef(0);      // #1704: the card's click, waiting for this device's Allow (the st.run it came with)
  const ownAllow = useRef(0);     // while this panel's own Allow commits its choice: the click it answers (not cancelled by it)
  const holder = useRef(null), divider = useRef(null), panel = useRef(null);
  const [device, setDeviceState] = useState(storedDevice);   // #2911 (2): the page's width
  const setDevice = (v) => { setDeviceState(v); storeDevice(v); };
  // Full screen: the Fullscreen API on the panel (the dashboard's document — the frame's own policy still denies it),
  // or, where the page may not, the panel over the whole window ("immersive"). Esc leaves it before it closes the panel.
  const [fs, setFs] = useState("");
  const fsTarget = useRef(null);   // the element asked to go full screen (the panel may be gone when it is left)
  const enterFs = () => {
    const el = panel.current, d = globalThis.document; if (!el || fs) return;
    const req = el.requestFullscreen || el.webkitRequestFullscreen;
    const enabled = d ? (d.fullscreenEnabled ?? d.webkitFullscreenEnabled) : false;
    if (typeof req !== "function" || enabled === false) { setFs("immersive"); return; }
    let r;
    fsTarget.current = el;
    try { r = req.call(el); } catch { setFs("immersive"); return; }
    if (r && typeof r.then === "function") r.then(() => { if (fullscreenEl() === el) setFs("native"); }, () => setFs("immersive"));
    else setFs("native");
  };
  function leaveFs() {
    const d = globalThis.document;
    const el = fsTarget.current; fsTarget.current = null;
    if (d && el && fullscreenEl() === el) {
      const ex = d.exitFullscreen || d.webkitExitFullscreen;
      try { const r = typeof ex === "function" ? ex.call(d) : null; if (r && typeof r.catch === "function") r.catch(() => {}); } catch { /* already out */ }
    }
    setFs("");
  }
  const open = st.open?.instance === name ? st.open : null;

  useEffect(() => panelStore.subscribe(setSt), []);
  // This device's choice (here or in another tab) decides whether Preview is offered: re-read it when it changes.
  // A click waiting for Allow is cancelled by any other change of that choice (Never, a card's menu, another tab):
  // after it, running needs a new click — only this panel's own Allow runs the click it was offered for.
  const [, choice] = useState(0);
  useEffect(() => (P() ? P().onChange(() => { if (pending.current && ownAllow.current !== pending.current) pending.current = 0; choice(n => n + 1); }) : undefined), []);
  // Leaving the chat (another instance, another panel) closes the panel: its frame stops with the thread's.
  useEffect(() => () => closePanel(), []);
  // Full screen ends with the browser's own Esc or its exit control too: follow it.
  useEffect(() => {
    const d = globalThis.document; if (!d || !d.addEventListener) return undefined;
    const sync = () => setFs(f => (f === "native" && fullscreenEl() !== fsTarget.current ? "" : f));
    d.addEventListener("fullscreenchange", sync); d.addEventListener("webkitfullscreenchange", sync);
    return () => { d.removeEventListener("fullscreenchange", sync); d.removeEventListener("webkitfullscreenchange", sync); };
  }, []);
  // #1770: the source and newer-version labels say the day as the thread does — drawn again when the fleet's day
  // changes, while a block is open. A render: the frame and the run are left as they are.
  const [, dayTick] = useState(0);
  useEffect(() => (open ? onDayChange(() => dayTick(n => n + 1)) : undefined), [!!open]);

  // #2863: "large" — over 8 MB, nothing runs until "Preview anyway" (or the card's, which opened it with `anyway`).
  const ui = { state: (s, reason) => setRun({ state: s === "starting" || s === "running" || s === "large" ? s : "idle", reason: reason || "" }) };
  const start = (anyway) => {
    if (!open || !holder.current) return;
    setView("preview");
    P().start(frameKey(open.key), holder.current, open.code, ui, anyway === true || open.anyway ? { fill: true, anyway: true } : { fill: true });
  };
  const stop = () => { if (open) P().stop(frameKey(open.key), "stopped", ""); };
  // A new block in the panel: what ran before is gone (openPanel stopped it); the card's click starts it here — or,
  // where it cannot run, waits as `pending`: only the Allow below can use it (offered to a device that has not opted
  // in), only while the panel shows what that click opened (st.run is a token no later open reuses), and any other
  // change of this device's choice cancels it.
  useEffect(() => {
    setRun({ state: "idle", reason: "" });
    if (!keepView.current) setView("preview");
    keepView.current = false;
    if (open && st.run) {
      if (P().availability().ok) start();
      else pending.current = st.run;
    }
    // Focus goes to the panel's close control that is on screen (Back on a phone, × beside the thread).
    if (panel.current) { const f = [...panel.current.querySelectorAll(".pv-panel-close")].find(b => b.offsetParent !== null); if (f) f.focus(); }
  }, [open && open.key, st.run]);
  // The panel closing, or showing another instance's block: out of full screen.
  useEffect(() => { if (!open) leaveFs(); }, [!!open]);
  // A later reply with a newer version of this block: offered, not swapped in.
  useEffect(() => {
    setNewerNote(""); reading.current = null;
    if (!open) { setNewer(null); return undefined; }
    const check = () => { const all = msgs() || []; setNewer(newerVersion(open, all, keyOf)); setVers(versionsOf(open, all, keyOf)); };
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
  // Show another version (the newer one offered, or a step of ‹ ›): an attached file's HTML is read first. A read the
  // panel moved on from is dropped. It is shown as Show it shows one — waiting for Preview, never started by the step.
  const attReason = (r) => t(r.reason === "over" ? "chat.pvAttOver" : r.reason === "gone" ? "chat.pvAttGone" : "chat.pvAttFailed");
  const show = async (spec, { keep = false } = {}) => {
    if (!spec || reading.current) return;
    const cached = spec.code == null ? loaded.current.get(spec.key) : undefined;
    if (spec.code != null || cached != null) { keepView.current = keep; openPanel(cached != null ? { ...spec, code: cached } : spec); return; }
    // #2915 review: the panel's generation, not just the key — a close and reopen of the same block while this read
    // waits moves it, and the read is then dropped (claimPanel also drops any earlier click still reading).
    const gen = claimPanel(), mine = reading.current = spec;
    setNewerNote(t("chat.pvLoading"));
    // A click on a version reads it whatever its size (up to the 50 MB ceiling); over 8 MB the panel then asks.
    const r = await loadHtmlAttachment(spec.att, undefined, { anyway: true });
    if (reading.current === mine) reading.current = null;
    if (panelVersion() !== gen) return;
    if (!r.ok) { setNewerNote(attReason(r)); return; }
    setNewerNote("");
    loaded.current.set(spec.key, r.code);
    keepView.current = keep;
    openPanel({ ...spec, code: r.code });
  };
  const showNewer = () => show(newer);
  const step = (by) => { const v = vers.list[vers.index + by]; if (vers.index >= 0 && v) show(v, { keep: true }); };
  // Changes: the previous version against this one, a line diff (bounded: DIFF_LIMITS). An attached previous version
  // is read for it, once.
  const prev = vers.index > 0 ? vers.list[vers.index - 1] : null;
  // A step to the first version from Changes: nothing to compare it with, so the page is shown (Changes is kept as the
  // choice, and comes back with the next step that has a previous version).
  const shown = view === "changes" && !prev ? "preview" : view;
  useEffect(() => {
    if (shown !== "changes" || !open) { setChanges(null); return undefined; }
    let live = true;
    const from = vers.index;   // "Changes from v{from}" (1-based: the previous one)
    const diff = (before) => {
      const ops = lineDiff(before, open.code);
      if (!ops) return { state: "big", from };
      const hunks = diffHunks(ops);
      let total = 0; for (const h of hunks) total += h.lines.length + 1;
      return { state: "ready", from, hunks, total };
    };
    const known = prev.code != null ? prev.code : loaded.current.get(prev.key);
    if (known != null) setChanges(diff(known));
    else {
      setChanges({ state: "loading", from });
      loadHtmlAttachment(prev.att, undefined, { anyway: true }).then((r) => {
        if (!live) return;
        if (!r.ok) { setChanges({ state: "failed", from, reason: attReason(r) }); return; }
        loaded.current.set(prev.key, r.code);
        setChanges(diff(r.code));
      });
    }
    return () => { live = false; };
  }, [shown, open && open.key, prev && prev.key]);
  const fileName = open && open.att ? open.att.name : undefined;
  // Esc in the panel closes it (and is not the chat's "stop the reply").
  const onPanelKey = (e) => {
    if (e.key !== "Escape" || e.isComposing) return;
    e.preventDefault();
    if (fs) leaveFs(); else closePanel();
  };

  if (!open) return null;
  const going = run.state === "starting" || run.state === "running";
  const a = P().availability();
  // #1554: a device that has not allowed previews is offered the same "Allow previews" here (the same confirm). Allowing
  // runs the block the card's click opened (#1704); otherwise Preview is then enabled — still a click. Why a run stopped
  // (e.g. switched off in another tab) is still said first.
  const askOptIn = !going && !a.ok && a.why === "optin" && typeof allow === "function";
  const note = run.reason || (going ? (run.state === "starting" ? t("chat.pvStarting") : "") : a.ok ? t("chat.pvPanelIdle") : askOptIn ? t("chat.pvWhyOptinPanel") : a.reason);
  // Allowed here: the click that opened the panel runs now — if it is still waiting (no other change of the choice
  // cancelled it, even while the confirm was open: only the change this Allow commits is its own) and the panel still
  // shows what it opened (the confirm is a wait: the panel may have moved on meanwhile).
  const allowHere = async () => {
    const want = pending.current;
    const yes = await allow((apply) => { ownAllow.current = want; try { apply(); } finally { ownAllow.current = 0; } });
    if (!yes) return;
    setRun({ state: "idle", reason: "" });
    if (want && pending.current === want && panelStore.get().run === want) start();
  };
  const source = t("chat.pvSource", open.sender || name, timeOf(open.ts));
  return html`<div data-trust="preview" class="pv-divider" ref=${divider} role="separator" aria-orientation="vertical" tabindex="0" aria-label=${t("chat.pvResize")}
      aria-valuemin=${String(MIN_PANEL)} onKeyDown=${onKey} onPointerDown=${onDown}></div>
    <aside data-trust="preview" class=${`pv-panel${fs ? ` pv-fs pv-fs-${fs}` : ""}`} ref=${panel} aria-label=${t("chat.pvPanel")} onKeyDown=${onPanelKey}>
      <div class="pv-panel-head">
        <button type="button" class="icon-btn only-narrow pv-panel-close" title=${t("chat.pvBack")} aria-label=${t("chat.pvBack")} onClick=${closePanel}><${Icon} name="back" size=${18} /></button>
        <div class="pv-panel-title"><strong>${t("chat.pvPanel")}</strong>
          <button type="button" class="pv-source" title=${source} onClick=${() => { if (window.matchMedia && window.matchMedia("(max-width: 899px)").matches) closePanel(); reveal(open.msgKey); }}>${source}</button></div>
        <button type="button" class="icon-btn only-wide pv-panel-close" title=${t("chat.pvClose")} aria-label=${t("chat.pvClose")} onClick=${closePanel}><${Icon} name="close" size=${18} /></button>
      </div>
      <div class="pv-panel-bar">
        ${vers.list.length > 1 && vers.index >= 0 ? html`<div class="pv-ver" role="group" aria-label=${t("chat.pvVersions")}>
          <button type="button" class="icon-btn pv-ver-prev" title=${t("chat.pvVerPrev")} aria-label=${t("chat.pvVerPrev")} disabled=${vers.index === 0} onClick=${() => step(-1)}><${Icon} name="prev" size=${16} /></button>
          <span class="pv-ver-at" aria-live="polite" title=${t("chat.pvVerLong", vers.index + 1, vers.list.length)} aria-label=${t("chat.pvVerLong", vers.index + 1, vers.list.length)}>${t("chat.pvVer", vers.index + 1, vers.list.length)}</span>
          <button type="button" class="icon-btn pv-ver-next" title=${t("chat.pvVerNext")} aria-label=${t("chat.pvVerNext")} disabled=${vers.index === vers.list.length - 1} onClick=${() => step(1)}><${Icon} name="next" size=${16} /></button>
        </div>` : null}
        <div class="seg-inline" role="group" aria-label=${t("chat.pvPanel")}>
          <button type="button" class=${`btn btn-sm${shown === "preview" ? " on" : ""}`} aria-pressed=${shown === "preview" ? "true" : "false"} title=${t("chat.pvPage")} onClick=${() => setView("preview")}><${Icon} name="eye" size=${14} /><span class="lbl">${t("chat.pvPage")}</span></button>
          <button type="button" class=${`btn btn-sm${shown === "code" ? " on" : ""}`} aria-pressed=${shown === "code" ? "true" : "false"} title=${t("chat.pvCode")} onClick=${() => setView("code")}><${Icon} name="code" size=${14} /><span class="lbl">${t("chat.pvCode")}</span></button>
          ${prev ? html`<button type="button" class=${`btn btn-sm pv-changes${shown === "changes" ? " on" : ""}`} aria-pressed=${shown === "changes" ? "true" : "false"} title=${t("chat.pvChanges")} onClick=${() => setView("changes")}><${Icon} name="diff" size=${14} /><span class="lbl">${t("chat.pvChanges")}</span></button>` : null}
        </div>
        <span class="grow"></span>
        ${shown === "preview" ? html`<select class="pv-width" aria-label=${t("chat.pvWidth")} title=${t("chat.pvWidth")} value=${device} onChange=${(e) => setDevice(e.currentTarget.value)}>
          <option value="full">${t("chat.pvWidthFull")}</option><option value="tablet">${t("chat.pvWidthTablet")}</option><option value="phone">${t("chat.pvWidthPhone")}</option></select>` : null}
        ${going ? html`<button type="button" class="btn btn-sm pv-panel-reload" title=${t("chat.pvReload")} onClick=${() => { stop(); start(true); }}><${Icon} name="restart" size=${14} /><span class="lbl">${t("chat.pvReload")}</span></button>
          <button type="button" class="btn btn-sm pv-panel-stop" title=${t("chat.pvStop")} onClick=${stop}><${Icon} name="stop" size=${14} /><span class="lbl">${t("chat.pvStop")}</span></button>`
          : run.state === "large" ? html`<button type="button" class="btn btn-sm btn-primary pv-panel-anyway" title=${t("chat.pvAnyway")} disabled=${!a.ok} onClick=${() => start(true)}><${Icon} name="play" size=${14} /><span class="lbl">${t("chat.pvAnyway")}</span></button>`
          : html`<button type="button" class="btn btn-sm btn-primary pv-panel-run" title=${t("chat.pvPreview")} disabled=${!a.ok} onClick=${() => start()}><${Icon} name="play" size=${14} /><span class="lbl">${t("chat.pvPreview")}</span></button>`}
        <button type="button" class=${`btn btn-sm only-wide pv-panel-fs${fs ? " on" : ""}`} aria-pressed=${fs ? "true" : "false"} title=${t(fs ? "chat.pvFsExit" : "chat.pvFs")} aria-label=${t(fs ? "chat.pvFsExit" : "chat.pvFs")}
          onClick=${() => (fs ? leaveFs() : enterFs())}><${Icon} name=${fs ? "fullscreenexit" : "fullscreen"} size=${14} /></button>
        <${PanelActions} open=${open} name=${name} run=${run} view=${view} />
        <button type="button" class="btn btn-sm pv-panel-dl" title=${t("chat.pvDownload")} onClick=${() => download(open.code, fileName)}><${Icon} name="download" size=${14} /><span class="lbl">${t("chat.pvDownload")}</span></button>
      </div>
      ${newer && newer.key !== open.key ? html`<div class="pv-newer" role="status"><span>${t("chat.pvNewer", timeOf(newer.ts))}</span>
        <button type="button" class="btn btn-sm pv-newer-show" onClick=${showNewer}>${t("chat.pvNewerShow")}</button>${newerNote ? html`<span class="pv-newer-note">${newerNote}</span>` : null}</div>` : null}
      ${newerNote && !(newer && newer.key !== open.key) ? html`<div class="pv-note pv-ver-note" role="status">${newerNote}</div>` : null}
      ${going && !P().bannerAcked() ? html`<div class="pv-banner"><span class="pv-banner-text">${P().banner()}</span>
        <button type="button" class="btn btn-sm btn-ghost pv-ack" title=${P().bannerAckTitle()} onClick=${() => P().ackBanner()}>${P().bannerAckLabel()}</button></div>` : null}
      ${note && shown === "preview" ? html`<div class="pv-note">${note}${askOptIn ? html` <button type="button" class="btn btn-sm pv-panel-allow" onClick=${allowHere}>${t("chat.pvAllowButton")}</button>` : null}</div>` : null}
      <div class=${`pv-panel-body${shown !== "preview" ? " show-code" : ` w-${device}`}`}>
        <div class="pv-holder" ref=${holder}></div>
        ${shown === "code" ? html`<pre class="pv-code"><code>${open.code}</code></pre>` : null}
        ${shown === "changes" ? html`<${Changes} changes=${changes} />` : null}
      </div>
    </aside>`;
}

/** The Changes view: hunks of the line diff as a unified diff shows them, drawn as text (never as HTML). */
function Changes({ changes }) {
  if (!changes || changes.state === "loading") return html`<div class="pv-note pv-diff-note">${t("chat.pvLoading")}</div>`;
  if (changes.state === "failed") return html`<div class="pv-note pv-diff-note">${changes.reason}</div>`;
  if (changes.state === "big") return html`<div class="pv-note pv-diff-note">${t("chat.pvChangesBig")}</div>`;
  if (!changes.hunks.length) return html`<div class="pv-note pv-diff-note">${t("chat.pvChangesNone", changes.from)}</div>`;
  const rows = [];
  let left = DIFF_LIMITS.maxLines;
  for (const h of changes.hunks) {
    if (left <= 0) break;
    rows.push(html`<span class="d-hunk">${`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@\n`}</span>`);
    left--;
    for (const l of h.lines) {
      if (left-- <= 0) break;
      rows.push(html`<span class=${l.t === "+" ? "d-add" : l.t === "-" ? "d-del" : "d-ctx"}>${`${l.t} ${l.text}\n`}</span>`);
    }
  }
  return html`<div class="pv-diff-wrap"><div class="pv-diff-head">${t("chat.pvChangesFrom", changes.from)}${changes.total > DIFF_LIMITS.maxLines ? html` · <span class="pv-diff-cut">${t("chat.pvChangesCut", DIFF_LIMITS.maxLines)}</span>` : null}</div>
    <pre class="pv-code pv-diff"><code>${rows}</code></pre></div>`;
}
