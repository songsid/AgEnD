// #1408 step 2: the View panel (/view, /view/<name>) — every agent's live terminal, its identity card, the AI usage
// panel, in the app shell. Public (/assets/): under `web.view_access: open` an anonymous reader opens it in the
// View-only shell, so nothing here needs a session to show, and the one write (Edit profile) asks for one.
//
// Its roster read also feeds the sidebar's list for an anonymous reader (instance-nav.js is the list on every page).
// Everything recurring is a passive read (#1374) taken through the navigation's lease: the pane every 800 ms and the
// roster every 5 s while the panel is mounted and the tab is visible, usage every 60 s while its dialog is open. They
// stop when the panel goes.
//
// #2855: a trusted guest's View — read-only: its own agents (the status frame's list, never /api/profiles), the pane
// every second under a "watching only" line, no identity card, Edit profile or Help. A chat-level guest is told it needs
// Trusted access; nothing is read.
import { html, useEffect, useRef, useState } from "./app-html.js";
import { t } from "./app-i18n.js";
import { appStore, createStore, guestPage, guestTrusted, useStore } from "./app-store.js";
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
import { logPath, sectionPath, viewPath } from "./app-route.js";
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
/**
 * v2.3.4-beta.4 P1 (hmsg-985db235, hmsg-5ab1997d): this module is loaded on first use, so a tab opened before an upgrade
 * runs the new View with the stylesheet and the View's words it loaded at its start. Without the View's layout rules
 * (.v-term-box) the terminal box grew with its text: the text shrank every second (fit() measured the box its own text
 * sized), a normal-buffer CLI's View showed its whole history from the top, and new words showed as raw keys. Each is
 * found by a mark the current files carry — VIEW_REV in app.css (the --v-term-rev property) and view-strings.js (the
 * view.rev word) — and a stale one is read again, once per page: the stylesheet re-linked after the one in force, the
 * words imported again (register() replaces them). The query only makes it a new request: /assets/ serves the file.
 */
export const VIEW_REV = "2";
const healed = { css: false, words: false };
export function healStalePage(doc = typeof document !== "undefined" ? document : null, load = (u) => import(u), onWords = () => {}) {
  if (!doc) return { css: false, words: false };
  const out = { css: false, words: false };
  try {
    const box = doc.querySelector && doc.querySelector(".v-term-box");
    // Only a page that has the stylesheet linked (the app; never a test's page without one) and an older one in force.
    const linked = [...(doc.querySelectorAll ? doc.querySelectorAll('link[rel="stylesheet"]') : [])]
      .some((l) => String(l.getAttribute("href") || "").split("?")[0] === "/assets/app.css");
    if (box && linked && !healed.css) {
      const cs = typeof getComputedStyle === "function" ? getComputedStyle(box) : null;
      const rev = cs && typeof cs.getPropertyValue === "function" ? String(cs.getPropertyValue("--v-term-rev")).trim().replace(/^"|"$/g, "") : VIEW_REV;
      if (rev !== VIEW_REV) {
        healed.css = true; out.css = true;
        const link = doc.createElement("link");
        link.setAttribute("rel", "stylesheet"); link.setAttribute("href", `/assets/app.css?rev=${VIEW_REV}-${Date.now().toString(36)}`);
        doc.head.appendChild(link);
      }
    }
  } catch { /* never in the View's way */ }
  if (t("view.rev") !== VIEW_REV && !healed.words) {
    healed.words = true; out.words = true;
    Promise.resolve(load(`./view-strings.js?rev=${VIEW_REV}-${Date.now().toString(36)}`)).then(() => onWords(), () => {});
  }
  return out;
}
/** For tests: as on a fresh page. */
export function resetHealed() { healed.css = false; healed.words = false; }
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
  const viewed = useStore(viewStore);
  const { viewOnly, instances, ready } = useStore(appStore);
  const guest = guestPage(), trusted = guest && guestTrusted();
  // #2855: a guest's roster is its own agents, as its status frame lists them.
  const v = guest ? { loaded: ready !== false, error: null, roster: (instances || []).map((i) => ({ instance_name: i.name, display_name: i.display_name, status: i.status })) } : viewed;
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
    if (guest) return;
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
    ${guest ? null : html`<button type="button" class="icon-btn" onClick=${() => setDialog("help")} aria-label=${tn("helpButton")} title=${tn("helpButton")}><${Icon} name="info" /></button>`}`;

  let body;
  if (v.error && !v.roster.length) body = html`<div data-trust="panel-content" class="panel-body center"><${ErrorState} message=${tn("rosterFailedShort")} onRetry=${() => navigate(location.pathname, { replace: true })} /></div>`;
  else if (!v.loaded) body = html`<div data-trust="panel-content" class="panel-body"><${Skeleton} lines=${6} /></div>`;
  else if (!v.roster.length) body = html`<div data-trust="panel-content" class="panel-body center"><${Empty} icon="view" title=${tn("noInstances")} /></div>`;
  else if (!name) body = html`<div data-trust="panel-content" class="panel-body"><${Skeleton} lines=${6} /></div>`;
  else if (!it) body = html`<div data-trust="panel-content" class="panel-body center"><${Empty} icon="alert" title=${tn("notFound", { name })} hint=${tn("notFoundHint")} /></div>`;
  else if (guest && !trusted) body = html`<div data-trust="panel-content" class="panel-body center"><${Empty} icon="view" title=${tn("guestNeedsTrusted")} hint=${tn("guestNeedsTrustedHint")} /></div>`;
  else if (guest) body = html`<p data-trust="panel-content" class="v-watching" role="note">${tn("guestWatching")}</p>
    <${Terminal} key=${name} name=${name} lease=${lease} density=${density} every=${GUEST_PANE_MS} backend=${it.backend || ""} signedIn=${false} />`;
  else body = html`<${Terminal} key=${name} name=${name} lease=${lease} density=${density} backend=${it.backend || ""} signedIn=${!viewOnly} />
    <${ViewIdentity} it=${it} viewOnly=${viewOnly} onEdit=${() => setDialog("edit")} />`;

  return html`<div data-effect-panel="view" class="panel p-view">
    <${PanelHeader} title=${it ? (it.display_name || it.instance_name) : tn("title")}
      sub=${it ? html`<span class="status"><span class=${`dot ${it.status === "running" ? "ok" : it.status === "crashed" ? "bad" : "off"}`} aria-hidden="true"></span>${tn(STATUS_KEYS[it.status] || "statusUnknown")}</span>` : null}
      nav=${it && (guest ? trusted : !viewOnly) ? html`<${InstanceSwitch} name=${name} current="view" guest=${guest} />` : null}>${actions}</${PanelHeader}>
    ${body}
    ${open === "edit" && it ? html`<${EditProfile} key=${navKey} it=${it} onClose=${() => setDialog(null)} />` : null}
    ${open === "help" ? html`<${HelpDialog} onClose=${() => setDialog(null)} />` : null}
  </div>`;
}

/** #2855: how often a guest's View reads the pane (the server allows it two reads a second). */
const GUEST_PANE_MS = 1000;
/**
 * The live terminal: the pane every 800 ms (passive), drawn as escaped markup, its font fitted to the pane's grid.
 *
 * M-2262 (the user, hmsg-435f6df6): scrolling back. Following (the default), it shows the pane's screen as it is now.
 * Scrolling up — the wheel, a touch drag, PageUp/↑/Home, or "Earlier output" — reads the pane's scrollback once
 * (`?history=1`: tmux's history above the screen, bounded) and shows it: reading. While reading, nothing moves the
 * person: the refresh keeps reading the screen only to say "New output below", and never redraws. "Jump to latest"
 * (or End), or scrolling to the bottom, follows again. Everything happens in this page, over text tmux was asked to
 * capture: never copy-mode and never a key to the pane (hmsg-b8a170c0 — scrolling must never affect delivery).
 */
/** How long a scrollback note stays (it covers the terminal's bottom rows). */
const NOTE_MS = 6000;
/** A scroll this soon after the person's own wheel, touch, key or pointer is theirs (not one this page made). */
const GESTURE_MS = 1000;
/**
 * #2969 review (Prism P3): is `live` (a screen read) still what `shown` ends with — the screen as it was when reading
 * began (the scrollback's last lines, or the screen itself)? Trailing blank rows are not content.
 */
export function sameScreen(shown, live) {
  if (shown == null || live == null) return shown === live;
  const trim = (t) => String(t).replace(/\n+$/, "");
  const s = trim(shown).split("\n"), l = trim(live).split("\n");
  return s.length >= l.length && s.slice(s.length - l.length).join("\n") === l.join("\n");
}
/** M-2262 survey: CLIs that redraw their whole window (no tmux scrollback even outside the alternate screen). */
const REDRAWS_IN_PLACE = new Set(["grok"]);
/** M-2262 survey: the full-screen CLIs (the alternate screen, or redrawn in place) — tmux keeps nothing above their screen. */
const FULL_SCREEN = new Set(["claude-code", "opencode", "grok"]);   // agy: its chat UI unverified — found by the read
/** The full-screen CLIs whose earlier output the Log tab shows (it reads their transcript: log-service.ts). */
const LOG_HAS_HISTORY = new Set(["claude-code"]);
/**
 * M-2267 option (2), the leader's safe default: where a full-screen CLI's earlier output is — its Log tab (or that the
 * Log tab is off, and where to turn it on). Only for whom the Log tab is (a signed-in session on the full app; never a
 * guest or a View-only reader: they get the plain words), and only for a CLI the Log tab reads.
 */
function logLinkFor(name, backend, signedIn) {
  if (!signedIn || !LOG_HAS_HISTORY.has(backend)) return null;
  const on = typeof document !== "undefined" && document.body?.dataset?.logTab === "1";
  return on ? { href: logPath(name), text: tn("earlierInLog") } : { href: sectionPath("web-dashboard"), text: tn("logTabOff") };
}
function Terminal({ name, lease, density, every = 800, backend = "", signedIn = false }) {
  const term = useRef(null), pre = useRef(null);
  const grid = useRef({ cols: 0, rows: 0, applied: 0, key: "", follows: false });
  const [problem, setProblem] = useState(null);
  const [, setWordsRev] = useState(0);
  // "follow" | "loading" | "reading"; the screen's text when reading began, the newest read since; a note about history.
  const [mode, setModeState] = useState("follow");
  const modeRef = useRef("follow");
  const setMode = (m) => { modeRef.current = m; setModeState(m); };
  const [newBelow, setNewBelow] = useState(false);
  const [historyNote, setHistoryNoteState] = useState(null);
  // A CLI found to keep no scrollback (full screen): nothing is offered or read again for it; the note says why, briefly.
  const [noScrollback, setNoScrollback] = useState(FULL_SCREEN.has(backend));
  const noScrollbackRef = useRef(FULL_SCREEN.has(backend));
  const logLink = logLinkFor(name, backend, signedIn);
  const noteTimer = useRef(null);
  const setHistoryNote = (note, brief = false) => {
    lease.clear(noteTimer.current); noteTimer.current = null;
    setHistoryNoteState(note);
    if (note && brief) noteTimer.current = lease.timeout(() => setHistoryNoteState(null), NOTE_MS);
  };
  // `reading`: the text shown while reading (the scrollback, or the screen as it was when the person left the bottom);
  // `latest`: the newest screen read; `history`: whether what is shown has the scrollback in it.
  // `drawn` (#2969 review P3): the text actually on the page now — what reading starts from, never a newer read not drawn.
  const screenAt = useRef({ reading: null, latest: null, history: false, drawn: null });
  // #2969 review (Prism P2): when the person last moved the terminal themselves (wheel, touch, key, pointer).
  const gestureAt = useRef(-Infinity);
  const recentGesture = () => performance.now() - gestureAt.current < GESTURE_MS;
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
    const byW = innerW / (g.cols * glyphRatio(p)), byH = innerH / (g.rows * lineH);
    const sizeFor = (limit) => (density === "fit" ? Math.max(FIT_FLOOR_PX, Math.min(limit * 0.995, MAX_PX))
      : Math.max(8, Math.min(Math.max(MIN_PX, Math.min(limit * 0.995, MAX_PX)) * (VIEW_SCALE[density] || 1), 32)));
    const size = sizeFor(g.follows ? byW : Math.min(byW, byH));
    g.key = key;
    // A small change is skipped only when growing (the size applied still fits); a smaller box always shrinks it.
    if (size >= g.applied && size - g.applied < 0.75) return;
    const padH = (parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom)) || 0;
    const was = g.applied || parseFloat(pcs.fontSize) || 0, before = box.clientHeight - padH;
    const apply = (px) => { g.applied = px; p.style.fontSize = `${px.toFixed(2)}px`; };   // CSSOM, never a style attribute (#1300)
    apply(size);
    // v2.3.4-beta.4 P1: the box's height is a limit only while it is the box's own. Read again right after the text took
    // its new size (the read lays the page out), a box whose height moved with it, by the same factor, is following its
    // text — a stale stylesheet, or any container that grows with its content: measured next time it would shrink the
    // text 0.5% each refresh, for ever. Then the width alone decides, at once and from then on (until the choice or the
    // stylesheet changes). Cause and effect within this one call: a resize between calls (#2991 review: the box made
    // shorter step by step, where a height-limited size moves in proportion too) never counts.
    if (!g.follows && was > 0 && before > 0) {
      const after = box.clientHeight - padH, ratio = size / was;
      if (after !== before && Math.abs(after / before - ratio) < 0.05 * ratio) {
        g.follows = true;
        const byWidth = sizeFor(byW);
        if (byWidth !== size) apply(byWidth);
      }
    }
  };
  /** Keep a following view on the newest line (a grid taller than the box at the larger sizes scrolls). */
  const toBottom = () => { const box = term.current; if (box) box.scrollTop = box.scrollHeight; };
  const draw = (text) => {
    pre.current.innerHTML = ansiToHtml(text);           // escaped by construction: markup only from ansiToHtml's own spans
    paintAnsi(pre.current);
    screenAt.current.drawn = text;
  };
  useEffect(() => { grid.current.key = ""; grid.current.follows = false; fit(); }, [density]);
  // A tab opened before an upgrade: its stylesheet and the View's words read again (healStalePage), then fitted anew.
  useEffect(() => {
    const h = healStalePage(document, (u) => import(u), () => { setWordsRev((n) => n + 1); });
    if (h.css) lease.timeout(() => { grid.current.key = ""; grid.current.follows = false; fit(); }, 300);
  }, []);
  const atBottom = () => { const box = term.current; return !box || box.scrollHeight - box.scrollTop - box.clientHeight <= 2; };
  /** Reading what is shown now (`text`, with or without the scrollback): the refresh only says whether there is more. */
  const startReading = (text, history) => {
    screenAt.current.reading = text; screenAt.current.history = history;
    setNewBelow(false); setMode("reading");
  };
  const grid1 = (r) => {
    const c = Number(r.headers.get("X-Pane-Cols")), rw = Number(r.headers.get("X-Pane-Rows"));
    if (c >= 1 && rw >= 1 && (c !== grid.current.cols || rw !== grid.current.rows)) { grid.current.cols = c; grid.current.rows = rw; grid.current.key = ""; }
  };
  // The person asked for what scrolled off: one bounded read, then reading (or why there is nothing to read).
  const loadEarlier = useRef(null);
  const follow = useRef(null);
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
        if (r.status === 429) return;                      // #2855: a guest over its read limit keeps the last frame
        if (!r.ok) { setProblem(r.status === 404 ? tn("paneUnavailable") : r.status === 403 && guestPage() ? tn("guestNeedsTrusted") : tn("paneFailed", { name, status: r.status })); return; }
        const text = await r.text();
        if (!reads.live(token) || !pre.current) return;
        setProblem(null);
        screenAt.current.latest = text;
        // Reading earlier output: nothing is redrawn under the person — the read only says whether there is more.
        if (modeRef.current !== "follow") { if (modeRef.current === "reading") setNewBelow(!sameScreen(screenAt.current.reading, text)); return; }
        // #2969 review (Prism P2): the person is moving a screen taller than its box away from the bottom right now —
        // this is them leaving it, not the latest to follow: read on, nothing redrawn.
        // Reading starts from what is drawn; this newer read (not drawn) is then the new output below.
        if (recentGesture() && !atBottom()) { startReading(screenAt.current.drawn, false); setNewBelow(!sameScreen(screenAt.current.drawn, text)); return; }
        grid1(r);
        draw(text);
        fit();
        toBottom();
      } catch { /* a transient error keeps the last frame */ }
      finally { reads.end(token); }
    };
    loadEarlier.current = async () => {
      // From following, or from reading what was on the screen (the person reached its top): never twice, never over it.
      const from = modeRef.current;
      if (from !== "follow" && !(from === "reading" && !screenAt.current.history)) return;
      if (noScrollbackRef.current) { setHistoryNote(tn("noEarlier"), true); return; }   // known: nothing to read
      const box0 = term.current;
      // Where the person is, measured from the end: the screen's lines stay where they are under the scrollback added.
      const fromEnd = box0 ? box0.scrollHeight - box0.scrollTop : 0;
      const back = () => { setMode(from); if (from === "follow") toBottom(); };
      setMode("loading"); setHistoryNote(tn("loadingEarlier"));
      try {
        const r = await lease.fetch(`/api/pane/${encodeURIComponent(name)}?history=1`);
        if (!lease.current() || modeRef.current !== "loading") return;
        // #2969 review (Prism P2): a scrollback read that failed — or answered without its facts — changes nothing shown.
        if (!r.ok || r.headers.get("X-Pane-History-Lines") == null) { back(); setHistoryNote(r.status === 429 ? null : tn("earlierFailed"), true); return; }
        const text = await r.text();
        if (!lease.current() || modeRef.current !== "loading" || !pre.current) return;
        // A full-screen CLI (the alternate screen, or one that redraws its whole window) leaves nothing above its screen;
        // any other with no history yet has simply not scrolled: say which, keep following.
        if (r.headers.get("X-Pane-Alternate") === "1" || REDRAWS_IN_PLACE.has(backend)) {
          noScrollbackRef.current = true; setNoScrollback(true);
          back(); setHistoryNote(tn("noEarlier"), true); return;
        }
        if (r.headers.get("X-Pane-History-Lines") === "0") { back(); setHistoryNote(tn("nothingEarlier"), true); return; }
        grid1(r);
        const lines = text.split("\n").length, rows = grid.current.rows || 0;
        // #2969 review (Prism P3): new output is judged against what is shown — the scrollback's own last screen — and
        // a screen read while this one was out already counts.
        screenAt.current.reading = text; screenAt.current.history = true;
        setNewBelow(screenAt.current.latest != null && !sameScreen(text, screenAt.current.latest));
        setMode("reading"); setHistoryNote(null);
        draw(text);
        fit();
        const box = term.current;
        if (box) {
          const lineH = lines > 0 ? pre.current.scrollHeight / lines : 16;
          // From following (at the bottom): a few lines up — the earlier output right above. From reading: the same lines.
          box.scrollTop = from === "follow"
            ? Math.max(0, box.scrollHeight - box.clientHeight - lineH * Math.min(3, Math.max(1, lines - rows)))
            : Math.max(0, box.scrollHeight - fromEnd);
        }
      } catch { if (lease.current()) { back(); setHistoryNote(tn("earlierFailed"), true); } }
    };
    follow.current = () => {
      if (modeRef.current === "follow") return;
      setMode("follow"); setNewBelow(false); setHistoryNote(null); screenAt.current.history = false;
      const latest = screenAt.current.latest;
      if (latest != null && pre.current) { draw(latest); fit(); }
      toBottom();
      refresh();
    };
    refresh();
    lease.interval(refresh, every);
    let timer = null;
    const schedule = () => { lease.clear(timer); timer = lease.timeout(() => { grid.current.key = ""; fit(); }, 80); };
    lease.on(window, "resize", schedule);
    if (typeof ResizeObserver === "function" && term.current) {
      const ro = new ResizeObserver(schedule);
      ro.observe(term.current);
      lease.hold(() => ro.disconnect());
    }
    // Scrolling up asks for the earlier output; reaching the bottom while reading follows again.
    const box = term.current;
    if (box) {
      // Asking for the earlier output: from following, or from reading the screen as it was — at the top.
      const mayLoad = () => (modeRef.current === "follow" || (modeRef.current === "reading" && !screenAt.current.history)) && box.scrollTop <= 0;
      const gesture = () => { gestureAt.current = performance.now(); };
      lease.on(box, "wheel", (e) => { gesture(); if (e.deltaY < 0 && mayLoad()) loadEarlier.current(); }, { passive: true });
      let touchY = null;
      lease.on(box, "touchstart", (e) => { gesture(); touchY = e.touches && e.touches[0] ? e.touches[0].clientY : null; }, { passive: true });
      lease.on(box, "touchmove", (e) => {
        gesture();
        const y = e.touches && e.touches[0] ? e.touches[0].clientY : null;
        if (touchY == null || y == null) return;
        if (y - touchY > 24 && mayLoad()) { touchY = null; loadEarlier.current(); }
      }, { passive: true });
      lease.on(box, "pointerdown", gesture, { passive: true });             // the scrollbar, dragged
      lease.on(box, "keydown", (e) => {
        gesture();
        if ((e.key === "PageUp" || e.key === "ArrowUp" || e.key === "Home") && mayLoad()) { e.preventDefault(); loadEarlier.current(); }
        else if (modeRef.current === "reading" && e.key === "End") { e.preventDefault(); follow.current(); }
      });
      lease.on(box, "scroll", () => {
        if (modeRef.current === "reading") { if (atBottom()) follow.current(); return; }
        // #2969 review (Prism P2): a screen taller than its box (a larger Aa), moved up from the bottom by the person:
        // reading what is on it — the refresh no longer pulls them back down.
        if (modeRef.current === "follow" && recentGesture() && !atBottom()) startReading(screenAt.current.drawn, false);
      }, { passive: true });
    }
  }, [lease, name]);
  const reading = mode === "reading";
  // A full-screen CLI's Log link is a bar above the terminal, not over it: its first row is never covered.
  return html`<div class="v-term-box">
    ${noScrollback && logLink ? html`<p class="v-term-logbar"><a class="v-term-log" href=${logLink.href}>${logLink.text}<${Icon} name="forward" size=${14} /></a></p>` : null}
    <div data-trust="panel-content" class=${`v-term${reading ? " is-reading" : ""}`} ref=${term} tabindex="0" aria-label=${tn(reading ? "readingEarlier" : "earlierHint")}>${problem ? html`<p class="v-term-note" role="status">${problem}</p>` : null}<pre ref=${pre} class="v-pre"></pre></div>
    ${historyNote ? html`<p class="v-term-history-note" role="status">${historyNote}</p>` : null}
    ${mode === "follow" && !noScrollback ? html`<button type="button" class="v-term-earlier btn btn-sm" title=${tn("earlierHint")} onClick=${() => loadEarlier.current && loadEarlier.current()}><${Icon} name="up" size=${14} />${tn("earlier")}</button>` : null}
    ${reading ? html`<button type="button" class=${`v-term-latest btn btn-sm${newBelow ? " has-new" : ""}`} onClick=${() => follow.current && follow.current()}>${newBelow ? html`<span class="v-term-new">${tn("newBelow")} · </span>` : null}${tn("jumpLatest")}<${Icon} name="down" size=${14} /></button>` : null}
  </div>`;
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
