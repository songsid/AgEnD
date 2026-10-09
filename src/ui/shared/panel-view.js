// #1408 step 2: the View panel (/view, /view/<name>) — every agent's live terminal, its profile card, the AI usage
// panel, in the app shell. Public (/assets/): under `web.view_access: open` an anonymous reader opens it in the
// View-only shell, so nothing here needs a session to show, and the one write (Edit profile) asks for one.
//
// Its roster is the sidebar's section while it is mounted: groups by tag, the #999 filter, this browser's order (drag).
// Everything recurring is a passive read (#1374) taken through the navigation's lease: the pane every 800 ms and the
// roster every 5 s while the panel is mounted and the tab is visible, usage every 60 s while its dialog is open. They
// stop when the panel goes.
import { html, useEffect, useLayoutEffect, useMemo, useRef, useState } from "./app-html.js";
import { t } from "./app-i18n.js";
import { appStore, createStore, useStore } from "./app-store.js";
import { useLease } from "./app-ctx.js";
import { PanelHeader, setTitle, setSideSection, closeDrawer, onPanelKey, signInHref } from "./app-shell.js";
import { navigate } from "./app-nav.js";
import { viewPath } from "./app-route.js";
import { Dialog } from "./ui-dialog.js";
import { Empty, ErrorState, Skeleton } from "./ui-states.js";
import { Icon } from "./ui-icons.js";
import "./view-strings.js";

/** view.* text with named values: tn("paneFailed", { name, status }). */
function tn(key, values = {}) {
  let s = t(`view.${key}`);
  for (const [k, v] of Object.entries(values)) s = s.split(`{${k}}`).join(String(v));
  return s;
}
const stored = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const store = (k, v) => { try { localStorage.setItem(k, v); } catch { /* this page only */ } };

// ── ANSI (SGR) → markup ── A coloured run is <span class="ansi" data-fg data-bg data-b>, never a style attribute (#1300);
// paintAnsi() sets the colours through the style object once it is on the page. The colours are the palette's or rgb()
// of numbers — nothing from the pane's text.
const BASE = ["#000000", "#cd3131", "#0dbc79", "#e5e510", "#2472c8", "#bc3fbc", "#11a8cd", "#e5e5e5"];
const BRIGHT = ["#666666", "#f14c4c", "#23d18b", "#f5f543", "#3b8eea", "#d670d6", "#29b8db", "#ffffff"];
export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
function xterm256(n) {
  if (n < 8) return BASE[n];
  if (n < 16) return BRIGHT[n - 8];
  if (n < 232) { n -= 16; const r = Math.floor(n / 36), g = Math.floor((n % 36) / 6), b = n % 6; const v = (x) => (x ? x * 40 + 55 : 0); return `rgb(${v(r)},${v(g)},${v(b)})`; }
  const l = (n - 232) * 10 + 8; return `rgb(${l},${l},${l})`;
}
export function ansiToHtml(text) {
  let out = "", fg = null, bg = null, bold = false, open = false;
  const attrs = () => {
    let f = fg;
    if (bold && typeof f === "number" && f < 8) f = BRIGHT[f];
    else if (typeof f === "number") f = BASE[f];
    const b = bg == null ? null : typeof bg === "number" ? BASE[bg] : bg;
    return (f ? ` data-fg="${esc(f)}"` : "") + (b ? ` data-bg="${esc(b)}"` : "") + (bold ? " data-b" : "");
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
      if (c === 0) { fg = bg = null; bold = false; }
      else if (c === 1) bold = true;
      else if (c === 22) bold = false;
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

// ── The roster: groups, the #999 filter, this browser's order ──
export function groupOf(it) {
  const tags = it.tags || [];
  if (tags.includes("classic")) return "Classic";
  if (tags.length) return tags[0];
  return "Other";
}
const BACKEND_LABELS = { "claude-code": "Claude Code", "kiro-cli": "Kiro CLI", codex: "Codex", grok: "Grok Build", antigravity: "Antigravity", opencode: "OpenCode" };
export function backendLabel(backend) { return BACKEND_LABELS[backend] || backend || "Unknown"; }
const KNOWN_BACKENDS = new Set(Object.keys(BACKEND_LABELS));
const STATUS_KEYS = { running: "statusRunning", paused: "statusPaused", stopped: "statusStopped", crashed: "statusCrashed" };

export function normalizeFilter(query) { return String(query == null ? "" : query).trim().toLowerCase(); }
/** Case-insensitive substring on name (incl. display name), model and backend. */
export function instanceMatchesFilter(it, needle, labelOf) {
  if (!needle) return true;
  const fields = [it.instance_name, it.display_name, it.model, it.backend, labelOf ? labelOf(it.backend) : null];
  return fields.some((value) => typeof value === "string" && value.toLowerCase().includes(needle));
}
/** Visible groups in display order, and the "N / M" counts. */
export function filterSidebar(groupNames, instByGroup, rosterByName, query, labelOf) {
  const needle = normalizeFilter(query);
  const groups = [];
  let shown = 0, total = 0;
  for (const g of groupNames) {
    const names = (instByGroup.get(g) || []).filter((name) => rosterByName.has(name));
    total += names.length;
    const visible = names.filter((name) => instanceMatchesFilter(rosterByName.get(name), needle, labelOf));
    shown += visible.length;
    if (visible.length) groups.push({ group: g, names: visible });
  }
  return { groups, shown, total, active: needle.length > 0 };
}
export function instanceTooltip(it) {
  const context = it.context_pct != null && Number.isFinite(it.context_pct) ? `${Math.round(Math.min(100, Math.max(0, it.context_pct)))}%` : tn("tooltipUnavailable");
  const status = STATUS_KEYS[it.status] ? tn(STATUS_KEYS[it.status]) : it.status || tn("statusUnknown");
  const line = (key, value) => tn(key, { value });
  const lines = [];
  if (it.display_name && it.display_name !== it.instance_name) lines.push(it.display_name, `(${it.instance_name})`);
  else lines.push(it.instance_name);
  lines.push(line("tooltipBackend", backendLabel(it.backend)));
  const src = (s) => (s === "instance" || s === "classic" ? " (configured)" : s === "fleet-default" ? " (fleet default)" : "");
  lines.push(line("tooltipModel", (it.model || tn("tooltipUnavailable")) + src(it.model_source)));
  lines.push(line("tooltipStatus", status));
  lines.push(line("tooltipContext", context));
  if (it.effort) lines.push(line("tooltipEffort", it.effort + src(it.effort_source)));
  if (typeof it.description === "string" && it.description.trim()) lines.push("", it.description.trim());
  return lines.join("\n");
}

const SIDEBAR_ORDER_KEY = "agend_view_sidebar_order";
function readOrder() {
  const groups = new Map(), insts = new Map();
  try {
    const rows = JSON.parse(stored(SIDEBAR_ORDER_KEY) || "[]");
    if (Array.isArray(rows)) for (const row of rows) {
      if (row && row.item_type === "group" && typeof row.item_name === "string") groups.set(row.item_name, Number(row.sort_index) || 0);
      else if (row && row.item_type === "instance" && typeof row.item_name === "string") insts.set(row.item_name, Number(row.sort_index) || 0);
    }
  } catch { /* ignore invalid browser-local state */ }
  return { groups, insts };
}
/** Display order: this browser's saved order first, then new groups/instances by tag and name. */
export function computeOrder(roster, order) {
  const groups = new Map();
  for (const it of roster) { const g = groupOf(it); if (!groups.has(g)) groups.set(g, []); groups.get(g).push(it); }
  const gidx = (g) => (order.groups.has(g) ? order.groups.get(g) : Infinity);
  const groupNames = [...groups.keys()].sort((a, b) => {
    const ia = gidx(a), ib = gidx(b);
    if (ia !== ib) return ia - ib;
    if (a === "Other") return 1;
    if (b === "Other") return -1;
    return a.localeCompare(b);
  });
  const instByGroup = new Map();
  for (const [g, items] of groups) {
    instByGroup.set(g, items.map((it) => it.instance_name).sort((a, b) => {
      const ia = order.insts.has(a) ? order.insts.get(a) : Infinity, ib = order.insts.has(b) ? order.insts.get(b) : Infinity;
      return ia - ib;
    }));
  }
  return { groupNames, instByGroup };
}
function moveIn(arr, moving, target, before) {
  if (!arr) return;
  const from = arr.indexOf(moving);
  if (from === -1) return;
  arr.splice(from, 1);
  let to = arr.indexOf(target);
  if (to === -1) { arr.push(moving); return; }
  if (!before) to += 1;
  arr.splice(to, 0, moving);
}

/** The roster shared by the panel and its sidebar section, for as long as the page lives. */
export const viewStore = createStore({ loaded: false, error: null, roster: [], filter: "", collapsed: new Set(), current: null, order: readOrder() });
const byName = (roster) => new Map(roster.map((r) => [r.instance_name, r]));

function persistOrder(groupNames, instByGroup) {
  const rows = [];
  groupNames.forEach((g, i) => rows.push({ item_type: "group", item_name: g, sort_index: i, group_name: null }));
  for (const g of groupNames) (instByGroup.get(g) || []).forEach((n, j) => rows.push({ item_type: "instance", item_name: n, sort_index: j, group_name: g }));
  store(SIDEBAR_ORDER_KEY, JSON.stringify(rows));
  viewStore.set({ order: { groups: new Map(groupNames.map((g, i) => [g, i])), insts: new Map(rows.filter((r) => r.item_type === "instance").map((r) => [r.item_name, r.sort_index])) } });
}

/** The sidebar section while View is mounted: the filter, then the groups and their instances (links to /view/<name>). */
function ViewRoster() {
  const v = useStore(viewStore);
  const filterRef = useRef(null);
  const drag = useRef(null);
  const rosterByName = byName(v.roster);
  const { groupNames, instByGroup } = computeOrder(v.roster, v.order);
  const shown = filterSidebar(groupNames, instByGroup, rosterByName, v.filter, backendLabel);
  const setFilter = (value) => viewStore.set({ filter: value });
  const toggle = (g) => { const c = new Set(v.collapsed); if (c.has(g)) c.delete(g); else c.add(g); viewStore.set({ collapsed: c }); };
  // Drag to reorder: only the full list (a filtered subset would be ambiguous), groups among groups, instances within
  // their group.
  const dragProps = (item) => shown.active ? {} : {
    draggable: "true",
    onDragStart: (e) => { drag.current = item; e.currentTarget.classList.add("dragging"); try { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", item.name); } catch { /* Firefox needs data */ } },
    onDragEnd: (e) => { e.currentTarget.classList.remove("dragging"); drag.current = null; },
    onDragOver: (e) => {
      const d = drag.current;
      if (!d || d.type !== item.type || d.name === item.name || (item.type === "instance" && d.group !== item.group)) return;
      e.preventDefault();
      const r = e.currentTarget.getBoundingClientRect();
      const before = e.clientY < r.top + r.height / 2;
      e.currentTarget.classList.toggle("drop-before", before);
      e.currentTarget.classList.toggle("drop-after", !before);
    },
    onDragLeave: (e) => e.currentTarget.classList.remove("drop-before", "drop-after"),
    onDrop: (e) => {
      e.preventDefault();
      const before = e.currentTarget.classList.contains("drop-before");
      e.currentTarget.classList.remove("drop-before", "drop-after");
      const d = drag.current;
      if (!d || d.type !== item.type) return;
      const names = [...groupNames], insts = new Map([...instByGroup].map(([g, n]) => [g, [...n]]));
      if (item.type === "group") moveIn(names, d.name, item.name, before);
      else if (d.group === item.group) moveIn(insts.get(item.group), d.name, item.name, before);
      else return;
      persistOrder(names, insts);
    },
  };
  // The list scrolls; the filter under it stays in view (#999), so it sits outside the scrolling section.
  return html`<div class="view-roster">
    <div class="side-section" id="instanceList">
    <h2 class="side-label">${tn("instancesLabel")}</h2>
    ${!v.loaded ? html`<${Skeleton} lines=${4} />` : !v.roster.length ? html`<p class="side-empty">${tn("noInstances")}</p>` : null}
    ${shown.groups.map(({ group: g, names }) => {
      const folded = v.collapsed.has(g);
      return html`<div key=${g} class="v-group">
        <button type="button" class="v-group-head" aria-expanded=${folded ? "false" : "true"} onClick=${() => toggle(g)}
          title=${tn(folded ? "expandGroup" : "collapseGroup", { group: g })} ...${dragProps({ type: "group", name: g })}>
          <${Icon} name="chevron" size=${14} cls=${folded ? "caret folded" : "caret"} /><span class="grow">${g}</span><span class="count">${names.length}</span></button>
        ${folded ? null : html`<ul class="inst-list">${names.map((name) => {
          const it = rosterByName.get(name);
          const alias = typeof it.display_name === "string" && it.display_name.trim() && it.display_name.trim() !== name ? it.display_name.trim() : "";
          const active = name === v.current;
          return html`<li key=${name}><a class=${`inst v-inst${active ? " active" : ""}`} href=${viewPath(name)} title=${instanceTooltip(it)}
              aria-current=${active ? "page" : undefined} onClick=${closeDrawer} ...${dragProps({ type: "instance", name, group: g })}>
            <span class=${`dot ${it.status === "running" ? "ok" : it.status === "crashed" ? "bad" : "off"}`} aria-hidden="true"></span>
            <span class="inst-text"><span class="inst-name">${name}</span>${alias ? html`<span class="inst-sub"><span class="inst-alias">${alias}</span></span>` : null}</span>
            <span class="v-meta">${it.context_pct != null ? `${Math.round(it.context_pct)}%` : ""}</span>
            <span class=${`cli-icon cli-${KNOWN_BACKENDS.has(it.backend) ? it.backend : "other"}`} title=${backendLabel(it.backend)} aria-label=${tn("tooltipBackend", { value: backendLabel(it.backend) })}></span>
          </a></li>`;
        })}</ul>`}
      </div>`;
    })}
    ${v.loaded && shown.active && !shown.groups.length ? html`<p class="side-empty">${tn("filterNone")}</p>` : null}
    </div>
    <div class="v-filter">
      <label class="v-filter-box"><${Icon} name="search" size=${14} /><span class="sr-only">${tn("filterPh")}</span>
        <input ref=${filterRef} id="filterInput" type="text" autocomplete="off" spellcheck="false" placeholder=${tn("filterPh")} value=${v.filter}
          onInput=${(e) => setFilter(e.target.value)}
          onKeyDown=${(e) => { if (e.key === "Escape" && v.filter) { e.preventDefault(); e.stopPropagation(); setFilter(""); } }} />
        ${v.filter ? html`<button type="button" class="icon-btn v-filter-clear" aria-label=${tn("filterClear")} title=${tn("filterClear")}
          onClick=${() => { setFilter(""); filterRef.current && filterRef.current.focus(); }}><${Icon} name="close" size=${14} /></button>` : null}
      </label>
      <p class="note" aria-live="polite">${shown.shown} / ${shown.total}${shown.active ? ` ${tn("filterShown")}` : ""}</p>
    </div>
  </div>`;
}

// ── The panel ──

/**
 * One stream of reads under a lease (the pane, the roster, usage): one at a time, and only the newest may land. A tick
 * while a read is on its way is skipped; a forced read (Refresh), or one started after the last has hung STUCK_MS,
 * supersedes it — and a superseded read's answer is dropped at every step: its response, its body, its commit
 * (#1448 review: an interval alone starts overlapping reads, and lease.current() only tells navigations apart).
 */
const STUCK_MS = 10_000;
const clock = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
export function readStream(lease) {
  let gen = 0, busy = false, since = 0;
  return {
    /** A token for a new read, or 0 when this one should not start. */
    begin(force = false) {
      const at = clock();
      if (busy && !force && at - since < STUCK_MS) return 0;
      busy = true; since = at;
      return ++gen;
    },
    /** May this read still land? */
    live: (token) => token === gen && lease.current(),
    end(token) { if (token === gen) busy = false; },
  };
}

const DENSITY = { fit: 1, comfortable: 1.25, compact: 0.8 };
const DENSITY_ORDER = ["fit", "comfortable", "compact"];
const MIN_PX = 12, MAX_PX = 22;

export function ViewPanel({ route, navKey }) {
  const lease = useLease(navKey);
  const v = useStore(viewStore);
  const { viewOnly } = useStore(appStore);
  // { kind: "edit" | "usage" | "help", key }: a dialog belongs to the navigation that opened it. The profile editor's
  // draft names one agent; on another navigation it is gone, never retargeted (#1448 review).
  const [dialog, setDialogState] = useState(null);
  const setDialog = (kind) => setDialogState(kind ? { kind, key: navKey } : null);
  const open = dialog && dialog.key === navKey ? dialog.kind : null;
  const [usageAvailable, setUsageAvailable] = useState(false);
  const [density, setDensity] = useState(DENSITY[stored("agend_view_density")] ? stored("agend_view_density") : "fit");
  const name = route.instance;
  const it = name ? v.roster.find((r) => r.instance_name === name) : null;

  // The roster is the sidebar's section while View is mounted.
  useEffect(() => lease.hold(setSideSection(ViewRoster)), [lease]);
  useEffect(() => { viewStore.set({ current: name }); }, [name]);
  useEffect(() => { setTitle(it ? (it.display_name || it.instance_name) : tn("title")); }, [name, it && it.display_name, navKey]);
  if (name && it) store("agend_last_view", name);

  // The roster: now, then every 5 s while this panel is mounted and the tab is visible (a passive read).
  useEffect(() => {
    const reads = readStream(lease);
    const load = async () => {
      if (typeof document !== "undefined" && document.hidden) return;
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
  // Usage: whether the fleet offers it (a 404 means off). The read also warms the server's 5-minute cache.
  useEffect(() => {
    (async () => {
      try { const r = await lease.fetch("/api/ai-usage"); if (lease.current()) setUsageAvailable(r.status !== 404); }
      catch { /* stays hidden */ }
    })();
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

  const cycleDensity = () => {
    const next = DENSITY_ORDER[(DENSITY_ORDER.indexOf(density) + 1) % DENSITY_ORDER.length];
    store("agend_view_density", next);
    setDensity(next);
  };
  const densityName = tn(`density${density.charAt(0).toUpperCase()}${density.slice(1)}`);
  const actions = html`
    <button type="button" class="btn btn-ghost btn-sm" onClick=${cycleDensity} title=${tn("textSize", { size: densityName })} aria-label=${tn("textSize", { size: densityName })}><${Icon} name="type" size=${16} /><span class="hide-narrow" aria-hidden="true">${densityName}</span></button>
    ${usageAvailable ? html`<button type="button" class="btn btn-ghost btn-sm" onClick=${() => setDialog("usage")} aria-label=${tn("usageButton")} title=${tn("usageButton")}><${Icon} name="chart" size=${16} /><span class="hide-narrow" aria-hidden="true">${tn("usageButton")}</span></button>` : null}
    <button type="button" class="icon-btn" onClick=${() => setDialog("help")} aria-label=${tn("helpButton")} title=${tn("helpButton")}><${Icon} name="info" /></button>`;

  let body;
  if (v.error && !v.roster.length) body = html`<div class="panel-body center"><${ErrorState} message=${tn("rosterFailedShort")} onRetry=${() => navigate(location.pathname, { replace: true })} /></div>`;
  else if (!v.loaded) body = html`<div class="panel-body"><${Skeleton} lines=${6} /></div>`;
  else if (!v.roster.length) body = html`<div class="panel-body center"><${Empty} icon="view" title=${tn("noInstances")} /></div>`;
  else if (!name) body = html`<div class="panel-body"><${Skeleton} lines=${6} /></div>`;
  else if (!it) body = html`<div class="panel-body center"><${Empty} icon="alert" title=${tn("notFound", { name })} hint=${tn("notFoundHint")} /></div>`;
  else body = html`<${Terminal} key=${name} name=${name} lease=${lease} density=${density} />
    <${Card} it=${it} viewOnly=${viewOnly} onEdit=${() => setDialog("edit")} />`;

  return html`<div class="panel p-view">
    <${PanelHeader} title=${it ? (it.display_name || it.instance_name) : tn("title")}
      sub=${it ? html`<span class="status"><span class=${`dot ${it.status === "running" ? "ok" : it.status === "crashed" ? "bad" : "off"}`} aria-hidden="true"></span>${tn(STATUS_KEYS[it.status] || "statusUnknown")}</span>` : null}>${actions}</${PanelHeader}>
    ${body}
    ${open === "edit" && it ? html`<${EditProfile} key=${navKey} it=${it} onClose=${() => setDialog(null)} />` : null}
    ${open === "usage" ? html`<${UsageDialog} onClose=${() => setDialog(null)} />` : null}
    ${open === "help" ? html`<${HelpDialog} onClose=${() => setDialog(null)} />` : null}
  </div>`;
}

/** The live terminal: the pane every 800 ms (passive), drawn as escaped markup, its font fitted to the pane's grid. */
function Terminal({ name, lease, density }) {
  const term = useRef(null), pre = useRef(null);
  const grid = useRef({ cols: 0, rows: 0, applied: 0, key: "" });
  const [problem, setProblem] = useState(null);
  const fit = () => {
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
    size = Math.max(MIN_PX, Math.min(size, MAX_PX)) * (DENSITY[density] || 1);
    size = Math.max(8, Math.min(size, 32));
    g.key = key;
    if (Math.abs(size - g.applied) < 0.75) return;
    g.applied = size;
    p.style.fontSize = `${size.toFixed(2)}px`;          // CSSOM, never a style attribute (#1300)
  };
  useEffect(() => { grid.current.key = ""; fit(); }, [density]);
  useEffect(() => {
    const reads = readStream(lease);
    const refresh = async () => {
      if (document.hidden) return;
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
  return html`<div class="v-term" ref=${term}>${problem ? html`<p class="v-term-note" role="status">${problem}</p>` : null}<pre ref=${pre} class="v-pre"></pre></div>`;
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

/** The profile card under the terminal: one line by default, the whole profile when opened. */
function Card({ it, viewOnly, onEdit }) {
  const [open, setOpen] = useState(stored("agend_view_card_expanded") === "1");
  const avatar = useRef(null);
  // The avatar is fetched once per instance (cache-busted then), not on every 5-second roster refresh.
  useLayoutEffect(() => {
    if (!avatar.current || !it.has_avatar) return;
    avatar.current.src = `/api/avatar/${encodeURIComponent(it.instance_name)}?t=${Date.now()}`;
  }, [it.instance_name, it.has_avatar]);
  const initial = (it.display_name || it.instance_name || "?").trim().charAt(0) || "?";
  const ctx = it.context_pct != null ? ` · ctx ${Math.round(it.context_pct)}%` : "";
  const toggle = () => { const next = !open; setOpen(next); store("agend_view_card_expanded", next ? "1" : "0"); };
  return html`<section class=${`v-card${open ? " open" : ""}`} aria-label=${it.display_name || it.instance_name}>
    <div class="v-avatar">${it.has_avatar ? html`<img ref=${avatar} alt="" />` : html`<span class="v-initial" aria-hidden="true">${initial}</span>`}</div>
    <div class="v-card-body">
      <div class="v-card-line"><strong>${it.display_name || it.instance_name}</strong>${it.role ? html`<span class="v-role">${it.role}</span>` : null}</div>
      <div class="v-card-meta">${it.instance_name} · ${backendLabel(it.backend)}${it.model ? ` · ${it.model}` : ""}${ctx}</div>
      ${open && it.description ? html`<p class="v-card-desc">${it.description}</p>` : null}
    </div>
    <button type="button" class="icon-btn" onClick=${toggle} aria-expanded=${open ? "true" : "false"} aria-label=${tn(open ? "collapseProfile" : "expandProfile")} title=${tn(open ? "collapseProfile" : "expandProfile")}>
      <${Icon} name="chevron" size=${16} cls=${open ? "caret" : "caret flipped"} /></button>
    ${viewOnly
      ? html`<a class="btn btn-sm" href=${signInHref()}><${Icon} name="edit" size=${14} />${tn("signInToEdit")}</a>`
      : html`<button type="button" class="btn btn-sm" onClick=${onEdit}><${Icon} name="edit" size=${14} />${tn("editProfile")}</button>`}
  </section>`;
}

/** Edit profile: display name, role, description, avatar. A write: it needs a session (CSRF via agend-auth.js). */
function EditProfile({ it, onClose }) {
  const lease = useLease(`edit:${it.instance_name}`);
  const [f, setF] = useState({ display: it.display_name || "", role: it.role || "", desc: it.description || "" });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const file = useRef(null);
  async function save() {
    if (busy) return;
    setBusy(true); setMsg(null);
    // The whole transaction is decided now, before the first await: its target, the draft and the picked file. Every
    // later step checks this dialog's lease first — a navigation ends it, and its second write never goes out.
    const name = encodeURIComponent(it.instance_name);
    const draft = { display_name: f.display, role: f.role, description: f.desc };
    const picked = file.current && file.current.files && file.current.files[0];
    try {
      const r = await fetch(`/api/profile/${name}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(draft) });
      if (!lease.current()) return;
      if (r.status === 401) throw new Error(tn("signInToSave"));
      if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(tn("saveFailed", { error: e.error || `HTTP ${r.status}` })); }
      if (picked) {
        const ar = await fetch(`/api/avatar/${name}`, { method: "POST", headers: { "Content-Type": picked.type }, body: picked });
        if (!ar.ok) { const e = await ar.json().catch(() => ({})); throw new Error(tn("avatarFailed", { error: e.error || ar.status })); }
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
    </fieldset></form>
    ${msg ? html`<p class="err" role="alert">${msg}${msg === tn("signInToSave") ? html` <a class="link" href=${signInHref()}>${t("app.signIn")}</a>` : null}</p>` : null}
  </${Dialog}>`;
}

function HelpDialog({ onClose }) {
  return html`<${Dialog} title=${tn("helpButton")} onClose=${onClose}>
    <ul class="help-list">${["help1", "help2", "help3", "help4", "help5", "help6"].map((k) => html`<li key=${k}>${tn(k)}</li>`)}</ul>
  </${Dialog}>`;
}

// ── AI usage ── Every provider the fleet's logins report; refreshed every 60 s while this dialog is open (passive).
const USAGE_ORDER_KEY = "agend_view_usage_order";
function usageText(fallback, ref) {
  if (!ref || typeof ref.key !== "string") return fallback == null ? "" : String(fallback);
  return (Array.isArray(ref.args) ? ref.args : []).reduce((text, value, i) => text.split(`{${i}}`).join(String(value)), t(`view.${ref.key}`));
}
function usageDuration(ms) {
  const total = Math.max(1, Math.ceil(ms / 60000));
  const d = Math.floor(total / 1440), h = Math.floor((total % 1440) / 60), m = total % 60;
  if (total >= 2880) return usageText("", { key: "usage.duration.days_hours", args: [d, h] });
  if (total >= 60) return usageText("", { key: "usage.duration.hours_minutes", args: [Math.floor(total / 60), m] });
  return usageText("", { key: "usage.duration.minutes", args: [total] });
}
function resetText(iso) {
  if (!iso) return "";
  const ms = new Date(iso).getTime() - Date.now();
  if (Number.isNaN(ms)) return "";
  if (ms <= 0) return tn("usage.reset.soon");
  return usageText("", { key: "usage.reset.in", args: [usageDuration(ms)] });
}
function expiryText(iso) {
  if (!iso) return "";
  const at = new Date(iso), ms = at.getTime() - Date.now();
  if (!(ms > 0)) return "";
  return usageText("", { key: "usage.ticket_expiry", args: [`${at.getMonth() + 1}/${at.getDate()}`, usageDuration(ms)] });
}
export function UsageMetric({ m }) {
  const bar = useRef(null);
  const label = usageText(m.label, m.labelI18n);
  const note = m.note ? usageText(m.note, m.noteI18n) : "";
  const pct = m.type === "percent" ? Math.min(100, Math.max(0, m.used ?? 0)) : 0;
  useLayoutEffect(() => { if (bar.current) bar.current.style.width = `${pct}%`; }, [pct]);   // CSSOM (#1300)
  if (m.type === "percent") {
    const cls = pct >= 90 ? "crit" : pct >= 70 ? "warn" : "";
    const word = pct >= 90 ? tn("usageNear") : pct >= 70 ? tn("usageHigh") : "";
    const sub = [note, resetText(m.resetsAt)].filter(Boolean).join(" · ");
    return html`<div class="u-metric"><div class="u-row"><span class="u-label">${label}</span>${word ? html`<span class=${`u-status ${cls}`}>${word}</span>` : null}
      <span class=${`u-pct ${cls}`}>${pct.toFixed(0)}<span class="u-unit">%</span></span></div>
      <div class="u-meter"><div ref=${bar} class=${`u-fill ${cls}`}></div></div>${sub ? html`<div class="u-sub">${sub}</div>` : null}</div>`;
  }
  if (m.type === "dollars") {
    const val = m.limit ? `$${(m.used ?? 0).toFixed(2)} / $${m.limit.toFixed(2)}` : `$${(m.used ?? 0).toFixed(2)}`;
    return html`<div class="u-metric"><div class="u-row"><span class="u-label">${label}</span><span class="u-val">${val}</span></div>${note ? html`<div class="u-sub">${note}</div>` : null}</div>`;
  }
  const val = `${usageText(m.value ?? "", m.valueI18n)} ${usageText(m.unit ?? "", m.unitI18n)}`.trim();
  const sub = [note, expiryText(m.expiresAt)].filter(Boolean).join(" · ");
  return html`<div class="u-metric"><div class="u-row"><span class="u-label">${label}</span><span class="u-val">${val}</span></div>${sub ? html`<div class="u-sub">${sub}</div>` : null}</div>`;
}
function UsageDialog({ onClose }) {
  const lease = useLease("usage-dialog");
  const [data, setData] = useState(undefined);       // undefined: loading; null: failed
  const [order, setOrder] = useState(() => { try { const a = JSON.parse(stored(USAGE_ORDER_KEY) || "[]"); return Array.isArray(a) ? a.filter((x) => typeof x === "string") : []; } catch { return []; } });
  const reads = useMemo(() => readStream(lease), [lease]);
  // Refresh (force) supersedes a read on its way; the minute's tick waits for it.
  const load = async (force) => {
    const token = reads.begin(force);
    if (!token) return;
    try {
      const r = await lease.fetch(`/api/ai-usage${force ? "?force=1" : ""}`);
      if (!reads.live(token)) return;
      const d = await r.json();
      if (reads.live(token)) setData(d);
    } catch { if (reads.live(token)) setData(null); }
    finally { reads.end(token); }
  };
  useEffect(() => { load(false); lease.interval(() => load(false), 60_000); }, [lease]);
  const key = (p) => String(p.id || p.name || "");
  const ordered = (providers) => {
    const rank = new Map(order.map((id, i) => [id, i]));
    return providers.map((p, i) => ({ p, i })).sort((a, b) => {
      const ar = rank.has(key(a.p)) ? rank.get(key(a.p)) : Infinity, br = rank.has(key(b.p)) ? rank.get(key(b.p)) : Infinity;
      return ar === br ? a.i - b.i : ar - br;
    }).map((e) => e.p);
  };
  const move = (id, delta, providers) => {
    const ids = ordered(providers).map(key);
    const from = ids.indexOf(id), to = from + delta;
    if (from < 0 || to < 0 || to >= ids.length) return;
    [ids[from], ids[to]] = [ids[to], ids[from]];
    setOrder(ids); store(USAGE_ORDER_KEY, JSON.stringify(ids));
  };
  let content;
  if (data === undefined) content = html`<${Skeleton} lines=${4} />`;
  else if (!data || !Array.isArray(data.providers)) content = html`<${ErrorState} message=${tn("usageFail")} onRetry=${() => load(true)} />`;
  else {
    const providers = ordered(data.providers);
    content = html`${!providers.length ? html`<p class="note">${tn("usage.empty_active")}</p>` : null}
      ${providers.map((p, i) => html`<section key=${key(p)} class="u-provider">
        <div class="u-head"><strong>${p.name}</strong>${p.plan ? html`<span class="pill">${p.plan}</span>` : null}
          <span class="u-order">
            <button type="button" class="icon-btn" disabled=${i === 0} aria-label=${tn("usageMoveUp")} title=${tn("usageMoveUp")} onClick=${() => move(key(p), -1, data.providers)}><${Icon} name="up" size=${14} /></button>
            <button type="button" class="icon-btn" disabled=${i === providers.length - 1} aria-label=${tn("usageMoveDown")} title=${tn("usageMoveDown")} onClick=${() => move(key(p), 1, data.providers)}><${Icon} name="down" size=${14} /></button>
          </span></div>
        ${p.status === "error" ? html`<p class="u-err">${usageText(p.error || tn("usage.error_fallback"), p.errorI18n)}</p>`
          : p.status === "no-credentials" ? html`<p class="note">${tn("usage.not_logged_in")}</p>${p.hint ? html`<p class="note">${usageText(p.hint, p.hintI18n)}</p>` : null}`
          : html`${(p.metrics || []).map((m, j) => html`<${UsageMetric} key=${j} m=${m} />`)}
            ${p.hint ? html`<p class="note">${usageText(p.hint, p.hintI18n)}</p>` : !(p.metrics || []).length ? html`<p class="note">${tn("usage.no_data")}</p>` : null}`}
      </section>`)}
      <div class="u-foot"><span class="note">${tn("usageUpdated")} ${new Date(data.fetchedAt).toLocaleTimeString()}</span>
        <button type="button" class="btn btn-sm" onClick=${() => load(true)}>${tn("usageRefresh")}</button></div>`;
  }
  return html`<${Dialog} title=${tn("usage.title")} onClose=${onClose} wide=${true}>${content}</${Dialog}>`;
}
