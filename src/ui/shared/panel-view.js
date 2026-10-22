// #1408 step 2: the View panel (/view, /view/<name>) — every agent's live terminal, its identity card, the AI usage
// panel, in the app shell. Public (/assets/): under `web.view_access: open` an anonymous reader opens it in the
// View-only shell, so nothing here needs a session to show, and the one write (Edit profile) asks for one.
//
// Its roster read also feeds the sidebar's list for an anonymous reader (instance-nav.js is the list on every page).
// Everything recurring is a passive read (#1374) taken through the navigation's lease: the pane every 800 ms and the
// roster every 5 s while the panel is mounted and the tab is visible, usage every 60 s while its dialog is open. They
// stop when the panel goes.
import { html, useEffect, useRef, useState } from "./app-html.js";
import { t } from "./app-i18n.js";
import { appStore, createStore, useStore } from "./app-store.js";
import { useLease } from "./app-ctx.js";
import { PanelHeader, setTitle, onPanelKey, signInHref } from "./app-shell.js";
import { InstanceSwitch } from "./instance-switch.js";
import { HeaderTools, VIEW_SCALE, textSizeStore } from "./header-tools.js";
import { readStream } from "./read-stream.js";
// The usage dialog's metric row lives with the dialog now (usage-dialog.js); re-exported for what imported it here.
export { UsageMetric } from "./usage-dialog.js";
import { STATUS_KEYS } from "./instance-nav.js";
import { viewStore } from "./view-roster-store.js";

/** #1580: the app's stream says the fleet is not answering (a restart): the View's polls skip their turn until it is. */
const fleetUnreachable = () => appStore.get().connection === "reconnecting";
import { navigate } from "./app-nav.js";
import { viewPath } from "./app-route.js";
import { Dialog } from "./ui-dialog.js";
import { Empty, ErrorState, Skeleton } from "./ui-states.js";
import { Icon } from "./ui-icons.js";
import "./view-strings.js";
import { BannerFocusPreview, checkCard, fitPicture, IdentityCard, useBannerPreview, useCard } from "./identity-card.js";
import { confirmDialog } from "./ui-confirm.js";
import { openColorDialog } from "./identity-color.js";

/** view.* text with named values: tn("paneFailed", { name, status }). */
function tn(key, values = {}) {
  let s = t(`view.${key}`);
  for (const [k, v] of Object.entries(values)) s = s.split(`{${k}}`).join(String(v));
  return s;
}
const stored = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const store = (k, v) => { try { localStorage.setItem(k, v); } catch { /* this page only */ } };

// ── ANSI (SGR) → markup ── A coloured run is <span class="ansi" data-fg data-bg data-b data-dim>, never a style attribute
// (#1300); paintAnsi() sets the colours through the style object once it is on the page. The colours are the palette's or
// rgb() of numbers — nothing from the pane's text. Dim (SGR 2) is kept because a CLI paints text that is not input dim:
// Claude Code's prompt suggestion and empty-box placeholder sit in the composer exactly like typed text but faint (#1582,
// suzuke/agend-terminal#3744). Reverse video (7) swaps the run's colours, the terminal's own standing in for unset ones.
const BASE = ["#000000", "#cd3131", "#0dbc79", "#e5e510", "#2472c8", "#bc3fbc", "#11a8cd", "#e5e5e5"];
const BRIGHT = ["#666666", "#f14c4c", "#23d18b", "#f5f543", "#3b8eea", "#d670d6", "#29b8db", "#ffffff"];
export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
function xterm256(n) {
  if (n < 8) return BASE[n];
  if (n < 16) return BRIGHT[n - 8];
  if (n < 232) { n -= 16; const r = Math.floor(n / 36), g = Math.floor((n % 36) / 6), b = n % 6; const v = (x) => (x ? x * 40 + 55 : 0); return `rgb(${v(r)},${v(g)},${v(b)})`; }
  const l = (n - 232) * 10 + 8; return `rgb(${l},${l},${l})`;
}
/** The `.v-pre` terminal's own colours (app.css), for a reversed run whose colours were not set. */
const TERM_FG = "#d0d0d0", TERM_BG = "#000000";
export function ansiToHtml(text) {
  let out = "", fg = null, bg = null, bold = false, dim = false, reverse = false, open = false;
  const attrs = () => {
    let f = fg;
    if (bold && typeof f === "number" && f < 8) f = BRIGHT[f];
    else if (typeof f === "number") f = BASE[f];
    let b = bg == null ? null : typeof bg === "number" ? BASE[bg] : bg;
    if (reverse) [f, b] = [b ?? TERM_BG, f ?? TERM_FG];
    return (f ? ` data-fg="${esc(f)}"` : "") + (b ? ` data-bg="${esc(b)}"` : "") + (bold ? " data-b" : "") + (dim ? " data-dim" : "");
  };
  const flush = () => { if (open) { out += "</span>"; open = false; } };
  const openSpan = () => { const a = attrs(); if (a) { out += `<span class="ansi"${a}>`; open = true; } };
  const re = /\x1b\[([0-9;]*)m/g;
  let last = 0, m;
  const emit = (chunk) => { if (!chunk) return; if (!open) openSpan(); out += esc(chunk); };
  while ((m = re.exec(text)) !== null) {
    emit(text.slice(last, m.index));
    last = re.lastIndex;
    flush();
    const codes = m[1].split(";").filter((x) => x !== "").map(Number);
    if (codes.length === 0) codes.push(0);
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i];
      if (c === 0) { fg = bg = null; bold = dim = reverse = false; }
      else if (c === 1) bold = true;
      else if (c === 2) dim = true;
      else if (c === 22) bold = dim = false;   // "normal intensity": neither bold nor faint
      else if (c === 7) reverse = true;
      else if (c === 27) reverse = false;
      else if (c === 39) fg = null;
      else if (c === 49) bg = null;
      else if (c >= 30 && c <= 37) fg = c - 30;
      else if (c >= 90 && c <= 97) fg = BRIGHT[c - 90];
      else if (c >= 40 && c <= 47) bg = c - 40;
      else if (c >= 100 && c <= 107) bg = BRIGHT[c - 100];
      else if (c === 38 || c === 48) {
        const target = c === 38 ? "fg" : "bg";
        if (codes[i + 1] === 5) { const col = xterm256(codes[i + 2]); if (target === "fg") fg = col; else bg = col; i += 2; }
        else if (codes[i + 1] === 2) { const col = `rgb(${codes[i + 2] || 0},${codes[i + 3] || 0},${codes[i + 4] || 0})`; if (target === "fg") fg = col; else bg = col; i += 4; }
      }
    }
  }
  emit(text.slice(last));
  flush();
  return out;
}
function paintAnsi(root) {
  for (const el of root.querySelectorAll(".ansi[data-fg], .ansi[data-bg]")) {
    if (el.dataset.fg) el.style.color = el.dataset.fg;
    if (el.dataset.bg) el.style.background = el.dataset.bg;
  }
}

// ── The roster ── The sidebar's list is instance-nav.js on every page (alpha.2, N1); its helpers are re-exported here
// for the View code and tests that used them from this module.
export { groupOf, backendLabel, normalizeFilter, instanceMatchesFilter, filterSidebar, instanceTooltip, computeOrder } from "./instance-nav.js";
export { viewStore };

// ── The panel ──

// readStream: one stream of reads under a lease (read-stream.js; View's pane and roster use it).
// S / M / L: the fitted size kept within 12–22 px, then scaled. Fit (#1869): never larger than what fits — only a 6 px
// floor for legibility (a grid too wide for the box even at 6 px, e.g. 200 columns on a phone, still scrolls).
const MIN_PX = 12, MAX_PX = 22, FIT_FLOOR_PX = 6;

export function ViewPanel({ route, navKey }) {
  const lease = useLease(navKey);
  const v = useStore(viewStore);
  const { viewOnly } = useStore(appStore);
  // { kind: "edit" | "usage" | "help", key }: a dialog belongs to the navigation that opened it. The profile editor's
  // draft names one agent; on another navigation it is gone, never retargeted (#1448 review).
  const [dialog, setDialogState] = useState(null);
  const setDialog = (kind) => setDialogState(kind ? { kind, key: navKey } : null);
  const open = dialog && dialog.key === navKey ? dialog.kind : null;
  // #1523 N3: the text size is the page's one setting (header-tools.js); View's own extra choice is Fit.
  const ts = useStore(textSizeStore);
  const density = ts.viewFit ? "fit" : ts.size;
  const name = route.instance;
  const it = name ? v.roster.find((r) => r.instance_name === name) : null;

  useEffect(() => { viewStore.set({ current: name }); }, [name]);
  useEffect(() => { setTitle(it ? (it.display_name || it.instance_name) : tn("title")); }, [name, it && it.display_name, navKey]);
  if (name && it) store("agend_last_view", name);

  // The roster: now, then every 5 s while this panel is mounted and the tab is visible (a passive read).
  useEffect(() => {
    const reads = readStream(lease);
    const load = async () => {
      if (typeof document !== "undefined" && document.hidden) return;
      if (fleetUnreachable()) return;                      // #1580: the app's stream is reconnecting — no read storm
      const token = reads.begin();
      if (!token) return;
      try {
        const r = await lease.fetch("/api/profiles");
        if (!reads.live(token)) return;
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const roster = await r.json();
        if (!reads.live(token)) return;
        viewStore.set({ loaded: true, error: null, roster: Array.isArray(roster) ? roster : [] });
      } catch (e) { if (reads.live(token)) viewStore.set({ loaded: true, error: e && e.message ? e.message : "error" }); }
      finally { reads.end(token); }
    };
    load();
    lease.interval(load, 5000);
    lease.on(document, "visibilitychange", () => { if (!document.hidden) load(); });
  }, [lease]);
  // /view on its own: the instance this browser looked at last, else the first one.
  useEffect(() => {
    if (name || !v.loaded || !v.roster.length) return;
    const last = stored("agend_last_view");
    const pick = last && v.roster.some((r) => r.instance_name === last) ? last : v.roster[0].instance_name;
    navigate(viewPath(pick), { replace: true });
  }, [name, v.loaded, v.roster.length]);
  // "/" focuses the filter (never while typing elsewhere).
  useEffect(() => lease.hold(onPanelKey((e) => {
    if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey) return;
    const target = e.target;
    if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
    const f = document.getElementById("filterInput");
    if (f) { e.preventDefault(); f.focus(); }
  })), [lease]);

  // Aa and ◔ are every page's (HeaderTools); Help is View's own.
  const actions = html`<${HeaderTools} view=${true} navKey=${navKey} />
    <button type="button" class="icon-btn" onClick=${() => setDialog("help")} aria-label=${tn("helpButton")} title=${tn("helpButton")}><${Icon} name="info" /></button>`;

  let body;
  if (v.error && !v.roster.length) body = html`<div data-trust="panel-content" class="panel-body center"><${ErrorState} message=${tn("rosterFailedShort")} onRetry=${() => navigate(location.pathname, { replace: true })} /></div>`;
  else if (!v.loaded) body = html`<div data-trust="panel-content" class="panel-body"><${Skeleton} lines=${6} /></div>`;
  else if (!v.roster.length) body = html`<div data-trust="panel-content" class="panel-body center"><${Empty} icon="view" title=${tn("noInstances")} /></div>`;
  else if (!name) body = html`<div data-trust="panel-content" class="panel-body"><${Skeleton} lines=${6} /></div>`;
  else if (!it) body = html`<div data-trust="panel-content" class="panel-body center"><${Empty} icon="alert" title=${tn("notFound", { name })} hint=${tn("notFoundHint")} /></div>`;
  else body = html`<${Terminal} key=${name} name=${name} lease=${lease} density=${density} />
    <${ViewIdentity} it=${it} viewOnly=${viewOnly} onEdit=${() => setDialog("edit")} />`;

  return html`<div data-effect-panel="view" class="panel p-view">
    <${PanelHeader} title=${it ? (it.display_name || it.instance_name) : tn("title")}
      sub=${it ? html`<span class="status"><span class=${`dot ${it.status === "running" ? "ok" : it.status === "crashed" ? "bad" : "off"}`} aria-hidden="true"></span>${tn(STATUS_KEYS[it.status] || "statusUnknown")}</span>` : null}
      nav=${it && !viewOnly ? html`<${InstanceSwitch} name=${name} current="view" />` : null}>${actions}</${PanelHeader}>
    ${body}
    ${open === "edit" && it ? html`<${EditProfile} key=${navKey} it=${it} onClose=${() => setDialog(null)} />` : null}
    ${open === "help" ? html`<${HelpDialog} onClose=${() => setDialog(null)} />` : null}
  </div>`;
}

/** The live terminal: the pane every 800 ms (passive), drawn as escaped markup, its font fitted to the pane's grid. */
function Terminal({ name, lease, density }) {
  const term = useRef(null), pre = useRef(null);
  const grid = useRef({ cols: 0, rows: 0, applied: 0, key: "" });
  const [problem, setProblem] = useState(null);
  // #1674: the text size as of this render. The pane refresh and the resize handlers below are set up once per mount
  // and keep the fit() of that render; reading the size here, not from that render's props, keeps them on the current
  // choice (they used to put the mount-time size back within one 800 ms refresh).
  const dens = useRef(density);
  dens.current = density;
  const fit = () => {
    const density = dens.current;
    const g = grid.current, box = term.current, p = pre.current;
    if (!box || !p || g.cols < 1 || g.rows < 1) return;
    const cs = getComputedStyle(box);
    const innerW = Math.max(1, box.clientWidth - (parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight) || 0));
    const innerH = Math.max(1, box.clientHeight - (parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) || 0));
    const key = `${g.cols}x${g.rows}@${Math.round(innerW)}x${Math.round(innerH)}/${density}`;
    if (key === g.key) return;
    const pcs = getComputedStyle(p);
    const lh = parseFloat(pcs.lineHeight) / parseFloat(pcs.fontSize);
    const lineH = Number.isFinite(lh) && lh > 0 ? lh : 1.2;
    let size = Math.min(innerW / (g.cols * glyphRatio(p)), innerH / (g.rows * lineH)) * 0.995;
    if (density === "fit") size = Math.max(FIT_FLOOR_PX, Math.min(size, MAX_PX));
    else size = Math.max(8, Math.min(Math.max(MIN_PX, Math.min(size, MAX_PX)) * (VIEW_SCALE[density] || 1), 32));
    g.key = key;
    // A small change is skipped only when growing (the size applied still fits); a smaller box always shrinks it.
    if (size >= g.applied && size - g.applied < 0.75) return;
    g.applied = size;
    p.style.fontSize = `${size.toFixed(2)}px`;          // CSSOM, never a style attribute (#1300)
  };
  useEffect(() => { grid.current.key = ""; fit(); }, [density]);
  useEffect(() => {
    const reads = readStream(lease);
    const refresh = async () => {
      if (document.hidden) return;
      if (fleetUnreachable()) return;                      // #1580: every 0.8 s would be a connection storm through a relay
      // A selection inside the pane is being copied: keep this frame until it is released.
      const sel = typeof window.getSelection === "function" ? window.getSelection() : null;
      if (sel && sel.toString().length > 0 && sel.anchorNode && pre.current && pre.current.contains(sel.anchorNode)) return;
      const token = reads.begin();
      if (!token) return;
      try {
        const r = await lease.fetch(`/api/pane/${encodeURIComponent(name)}`);
        if (!reads.live(token)) return;
        if (!r.ok) { setProblem(r.status === 404 ? tn("paneUnavailable") : tn("paneFailed", { name, status: r.status })); return; }
        const text = await r.text();
        if (!reads.live(token) || !pre.current) return;
        const c = Number(r.headers.get("X-Pane-Cols")), rw = Number(r.headers.get("X-Pane-Rows"));
        if (c >= 1 && rw >= 1 && (c !== grid.current.cols || rw !== grid.current.rows)) { grid.current.cols = c; grid.current.rows = rw; grid.current.key = ""; }
        setProblem(null);
        pre.current.innerHTML = ansiToHtml(text);         // escaped by construction: markup only from ansiToHtml's own spans
        paintAnsi(pre.current);
        fit();
      } catch { /* a transient error keeps the last frame */ }
      finally { reads.end(token); }
    };
    refresh();
    lease.interval(refresh, 800);
    let timer = null;
    const schedule = () => { lease.clear(timer); timer = lease.timeout(() => { grid.current.key = ""; fit(); }, 80); };
    lease.on(window, "resize", schedule);
    if (typeof ResizeObserver === "function" && term.current) {
      const ro = new ResizeObserver(schedule);
      ro.observe(term.current);
      lease.hold(() => ro.disconnect());
    }
  }, [lease, name]);
  return html`<div data-trust="panel-content" class="v-term" ref=${term}>${problem ? html`<p class="v-term-note" role="status">${problem}</p>` : null}<pre ref=${pre} class="v-pre"></pre></div>`;
}

// The advance of one monospace cell as a fraction of font-size, measured once on this page.
let cellRatio = 0;
function glyphRatio(pre) {
  if (cellRatio) return cellRatio;
  const probe = document.createElement("span");
  probe.className = "v-probe";
  probe.style.fontFamily = getComputedStyle(pre).fontFamily;
  probe.textContent = "0".repeat(100);
  document.body.appendChild(probe);
  const w = probe.getBoundingClientRect().width;
  probe.remove();
  if (w > 0) cellRatio = w / 100 / 100;
  return cellRatio || 0.6;
}

/** The identity card under the terminal, with Edit profile (or Sign in to edit) below it. Always on: the old one-line
 *  strip is gone, and IdentityCard itself is null when the card is empty, so the button lives here rather than inside it. */
function ViewIdentity({ it, viewOnly, onEdit }) {
  const card = useCard(it.instance_name, it.card_v);
  return html`<div data-trust="panel-content" class="v-id">
    ${card ? html`<${IdentityCard} name=${it.instance_name} card=${card} />` : null}
    <div class="v-id-actions">
      ${viewOnly
        ? html`<a class="btn btn-sm" href=${signInHref()}><${Icon} name="edit" size=${14} />${tn("signInToEdit")}</a>`
        : html`<button type="button" class="btn btn-sm" onClick=${onEdit}><${Icon} name="edit" size=${14} />${tn("editProfile")}</button>`}
    </div>
  </div>`;
}

/** Edit profile: display name, role, description, avatar. A write: it needs a session (CSRF via agend-auth.js). */
function EditProfile({ it, onClose }) {
  const lease = useLease(`edit:${it.instance_name}`);
  const [f, setF] = useState({ display: it.display_name || "", role: it.role || "", desc: it.description || "" });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  // #1630 follow-up: the uploaded picture is removed on Save (Cancel keeps it); a newly picked file wins over removing.
  const [removePic, setRemovePic] = useState(false);
  const file = useRef(null);
  // #1629 r4 §1 / r4.1: the identity card's own fields — this person's (theirs win over the agent's, field by field).
  // Read when the dialog opens: what is drawn now, whose each field is, and the upload limits in force.
  const [card, setCard] = useState(null);
  const [cardText, setCardText] = useState({ tagline: "", bio: "" });
  const [removeCard, setRemoveCard] = useState({ portrait: false, banner: false });
  const [clearCard, setClearCard] = useState(false);
  const pics = { portrait: useRef(null), banner: useRef(null) };
  // #2086: the banner's focus — this person's (null: follow the agent's, else the centre), and the picture to preview:
  // a newly chosen file, else the banner drawn now.
  // `agent`: the agent's own focus (what "Follow the agent's" shows; else the centre).
  const [focus, setFocus] = useState({ value: 50, mine: null, start: null, agent: null });
  const [bannerPreview, preview] = useBannerPreview();
  useEffect(() => {
    let live = true;
    // The card's fields stay disabled until this read is in (#1889 review: a draft typed meanwhile was overwritten);
    // a failed read lets them be edited, starting empty.
    const none = { mine: { tagline: null, bio: null, portrait: null, banner: null }, limits: null };
    lease.fetch(`/api/card/${encodeURIComponent(it.instance_name)}`).then((r) => (r.ok ? r.json() : null)).then((body) => {
      if (!live || !lease.current()) return;
      if (!body) { setCard(none); return; }
      const resolved = checkCard(it.instance_name, body);
      const mine = (k) => (resolved && resolved[k] && resolved[k].by === "human" ? resolved[k] : null);
      setCard({ mine: { tagline: mine("tagline"), bio: mine("bio"), portrait: mine("portrait"), banner: mine("banner") }, limits: body.limits || null });
      const bf = resolved && resolved.banner_focus;
      const agent = Number.isInteger(body.banner_focus_agent) && body.banner_focus_agent >= 0 && body.banner_focus_agent <= 100 ? body.banner_focus_agent : null;
      const mineFocus = bf && bf.by === "human" ? bf.value : null;
      setFocus({ value: mineFocus ?? agent ?? 50, mine: mineFocus, start: mineFocus, agent });
      if (resolved && resolved.banner) preview.fromSrc(resolved.banner.src);
      setCardText({ tagline: mine("tagline") ? mine("tagline").text : "", bio: mine("bio") ? mine("bio").text : "" });
    }).catch(() => { if (live && lease.current()) setCard(none); });
    return () => { live = false; };
  }, []);
  async function save() {
    if (busy) return;
    setBusy(true); setMsg(null);
    // The whole transaction is decided now, before the first await: its target, the draft and the picked file. Every
    // later step checks this dialog's lease first — a navigation ends it, and its second write never goes out.
    const name = encodeURIComponent(it.instance_name);
    const draft = { display_name: f.display, role: f.role, description: f.desc };
    const picked = file.current && file.current.files && file.current.files[0];
    const removing = removePic;
    // The card: Clear card wins over everything else in it; otherwise only the fields that changed are sent.
    const clearing = clearCard;
    const before = card && card.mine ? { tagline: card.mine.tagline ? card.mine.tagline.text : "", bio: card.mine.bio ? card.mine.bio.text : "" } : { tagline: "", bio: "" };
    if (!clearing) for (const k of ["tagline", "bio"]) if (cardText[k] !== before[k]) draft[`card_${k}`] = cardText[k];
    if (!clearing && focus.mine !== focus.start) draft.card_banner_focus = focus.mine;          // #2086
    const cardPics = {};
    try {
      // A picture too large is fitted first (after asking) — before anything is written, so declining writes nothing.
      if (!clearing) for (const slot of ["portrait", "banner"]) {
        const chosen = pics[slot].current && pics[slot].current.files && pics[slot].current.files[0];
        if (chosen) {
          const limit = card && card.limits && card.limits[slot];
          let blob = chosen;
          if (limit) {
            try { blob = await fitPicture(chosen, limit, (w, h, nw, nh) => confirmDialog({ message: tn("resizeAsk", { w, h, nw, nh }), confirmLabel: tn("resizeGo") })); }
            catch { throw new Error(tn("pictureTooLarge")); }
          }
          if (!lease.current()) return;
          if (!blob) { setBusy(false); return; }
          cardPics[slot] = blob;
        } else if (removeCard[slot]) cardPics[slot] = "remove";
      }
      const r = await fetch(`/api/profile/${name}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(draft) });
      if (!lease.current()) return;
      if (r.status === 401) throw new Error(tn("signInToSave"));
      if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(tn("saveFailed", { error: e.error || `HTTP ${r.status}` })); }
      if (picked) {
        const ar = await fetch(`/api/avatar/${name}`, { method: "POST", headers: { "Content-Type": picked.type }, body: picked });
        if (!ar.ok) { const e = await ar.json().catch(() => ({})); throw new Error(tn("avatarFailed", { error: e.error || ar.status })); }
      } else if (removing) {                              // a newly picked file replaces it instead
        const dr = await fetch(`/api/avatar/${name}`, { method: "DELETE" });
        if (!dr.ok) { const e = await dr.json().catch(() => ({})); throw new Error(tn("avatarRemoveFailed", { error: e.error || dr.status })); }
      }
      if (!lease.current()) return;
      if (clearing) {
        const cr = await fetch(`/api/card/${name}`, { method: "DELETE" });
        if (!cr.ok) { const e = await cr.json().catch(() => ({})); throw new Error(tn("cardFailed", { error: e.error || cr.status })); }
      }
      for (const [slot, what] of Object.entries(cardPics)) {
        if (!lease.current()) return;
        const pr = what === "remove"
          ? await fetch(`/api/card/${name}/${slot}`, { method: "DELETE" })
          : await fetch(`/api/card/${name}/${slot}`, { method: "POST", headers: { "Content-Type": what.type || "application/octet-stream" }, body: what });
        if (!pr.ok) { const e = await pr.json().catch(() => ({})); throw new Error(tn("cardFailed", { error: e.detail || e.error || pr.status })); }
      }
      if (!lease.current()) return;
      setBusy(false);
      onClose();
    } catch (e) { if (lease.current()) { setBusy(false); setMsg(e.message); } }
  }
  return html`<${Dialog} title=${tn("profileTitle", { name: it.instance_name })} onClose=${onClose} busy=${busy}
    actions=${html`<button type="button" class="btn" onClick=${onClose} disabled=${busy}>${tn("cancel")}</button>
      <button type="button" class="btn btn-primary" onClick=${save} disabled=${busy}>${tn("save")}</button>`}>
    <form class="form" onSubmit=${(e) => { e.preventDefault(); save(); }}><fieldset class="form" disabled=${busy}>
      <label class="field"><span>${tn("displayName")}</span><input value=${f.display} onInput=${(e) => setF({ ...f, display: e.target.value })} /></label>
      <label class="field"><span>${tn("role")}</span><input value=${f.role} onInput=${(e) => setF({ ...f, role: e.target.value })} /></label>
      <label class="field"><span>${tn("description")}</span><textarea rows="3" value=${f.desc} onInput=${(e) => setF({ ...f, desc: e.target.value })}></textarea></label>
      <label class="field"><span>${tn("avatar")}</span><input ref=${file} type="file" accept="image/png,image/jpeg,image/gif,image/webp" /></label>
      ${it.has_avatar ? html`<div class="field-row"><button type="button" class="btn btn-sm" aria-pressed=${removePic ? "true" : "false"}
        onClick=${() => setRemovePic(!removePic)}>${tn(removePic ? "keepPicture" : "removePicture")}</button>${removePic ? html`<span class="muted">${tn("removePictureNote")}</span>` : null}</div>` : null}
      <div class="field-row"><button type="button" class="btn btn-sm" onClick=${() => openColorDialog(it.instance_name, (appStore.get().instances || []).find((i) => i.name === it.instance_name))}>${t("color.menu")}</button></div>
      <h3 class="form-sub">${tn("cardSection")}</h3>
      <p class="note">${tn("cardLead")}</p>
      <fieldset class="form" disabled=${clearCard || !card} aria-busy=${card ? "false" : "true"}>
        <label class="field"><span>${tn("cardTagline")}</span><input value=${cardText.tagline} onInput=${(e) => setCardText({ ...cardText, tagline: e.target.value })} /></label>
        <label class="field"><span>${tn("cardBio")}</span><textarea rows="4" value=${cardText.bio} onInput=${(e) => setCardText({ ...cardText, bio: e.target.value })}></textarea></label>
        ${["portrait", "banner"].map((slot) => html`<div key=${slot} class="form">
          <label class="field"><span>${tn(slot === "portrait" ? "cardPortrait" : "cardBanner")}</span><input ref=${pics[slot]} type="file" accept="image/png,image/jpeg,image/webp"
            onChange=${slot === "banner" ? (e) => { const fl = e.currentTarget.files && e.currentTarget.files[0]; if (fl) preview.fromFile(fl); } : undefined} /></label>
          ${card && card.mine && card.mine[slot] ? html`<div class="field-row"><button type="button" class="btn btn-sm" aria-pressed=${removeCard[slot] ? "true" : "false"}
            onClick=${() => setRemoveCard({ ...removeCard, [slot]: !removeCard[slot] })}>${tn(removeCard[slot] ? "cardKeep" : "cardRemove")}</button></div>` : null}
        </div>`)}
        ${bannerPreview ? html`<div class="field bf-field">
          <span>${tn("cardBannerFocus")}</span>
          <${BannerFocusPreview} src=${bannerPreview.src} focus=${focus.value} />
          <input type="range" min="0" max="100" step="1" value=${focus.value} aria-label=${tn("cardBannerFocus")}
            onInput=${(e) => { const v = Number(e.currentTarget.value); setFocus({ ...focus, value: v, mine: v }); }} />
          <span class="note">${tn("cardBannerFocusNote")}</span>
          ${focus.mine !== null ? html`<div class="field-row"><button type="button" class="btn btn-sm" onClick=${() => setFocus({ ...focus, value: focus.agent ?? 50, mine: null })}>${tn("cardFocusFollow")}</button></div>` : null}
        </div>` : null}
      </fieldset>
      <div class="field-row"><button type="button" class="btn btn-sm" aria-pressed=${clearCard ? "true" : "false"} onClick=${() => setClearCard(!clearCard)}>${tn(clearCard ? "keepCard" : "clearCard")}</button>
        ${clearCard ? html`<span class="muted">${tn("clearCardNote")}</span>` : null}</div>
    </fieldset></form>
    ${msg ? html`<p class="err" role="alert">${msg}${msg === tn("signInToSave") ? html` <a class="link" href=${signInHref()}>${t("app.signIn")}</a>` : null}</p>` : null}
  </${Dialog}>`;
}

function HelpDialog({ onClose }) {
  return html`<${Dialog} title=${tn("helpButton")} onClose=${onClose}>
    <ul class="help-list">${["help1", "help2", "help3", "help4", "help5", "help6"].map((k) => html`<li key=${k}>${tn(k)}</li>`)}</ul>
  </${Dialog}>`;
}
