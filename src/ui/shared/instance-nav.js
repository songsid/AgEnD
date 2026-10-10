// alpha.2 (docs/design/web-unified-instance-nav.md, N1): the one instance list of the sidebar, on every page — Chat,
// View, Fleet, Settings, Needs — and for View's anonymous reader. It was two lists: the shell's (live dots, server
// order, no filter, every row to Chat) and View's roster (tag groups, drag order, a filter, rows to View). Now one:
// - live state (the status frames the app already receives; no new poll): dots, "needs you", context %, backend;
// - View's tag groups, folding and drag order, kept by this browser;
// - the filter — text plus status and CLI chips — kept by this browser and the same on every page;
// - a row opens the view you are in (View → View, everywhere else → Chat);
// - the list is never remounted on navigation, and only its own scrollTop follows the active row (#1515).
// Public (/assets/): an anonymous View reader gets the same list, fed by View's roster read instead of status frames.
import { html, useLayoutEffect, useRef } from "./app-html.js";
import { t } from "./app-i18n.js";
import { appStore, createStore, useStore } from "./app-store.js";
import { chatPath, detailsPath, viewPath } from "./app-route.js";
import { Icon } from "./ui-icons.js";
import { Skeleton } from "./ui-states.js";
import { viewStore } from "./view-roster-store.js";
import "./view-strings.js";

/** view.* text with named values. */
function tn(key, values = {}) {
  let s = t(`view.${key}`);
  for (const [k, v] of Object.entries(values)) s = s.split(`{${k}}`).join(String(v));
  return s;
}
const stored = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const store = (k, v) => { try { localStorage.setItem(k, v); } catch { /* this page only */ } };
/** A row's instance name: `name` (status frames) or `instance_name` (View's roster). */
const nameOf = (it) => (it && (it.name != null ? it.name : it.instance_name)) || "";

// ── Groups, labels, the filter ──
export function groupOf(it) {
  const tags = Array.isArray(it.tags) ? it.tags : [];
  if (tags.includes("classic")) return "Classic";
  if (tags.length) return tags[0];
  return "Other";
}
const BACKEND_LABELS = { "claude-code": "Claude Code", "kiro-cli": "Kiro CLI", codex: "Codex", grok: "Grok Build", antigravity: "Antigravity", opencode: "OpenCode" };
export function backendLabel(backend) { return BACKEND_LABELS[backend] || backend || "Unknown"; }
export const KNOWN_BACKENDS = new Set(Object.keys(BACKEND_LABELS));
export const STATUS_KEYS = { running: "statusRunning", paused: "statusPaused", stopped: "statusStopped", crashed: "statusCrashed" };

/** The status chips, in order (design Q5): what the row's dot says, in five words. */
export const STATUS_FACETS = ["working", "needs", "idle", "stopped", "crashed"];
/** Which status chip a row falls under: needs you first, then crashed, not running, working (or stuck), idle. */
export function statusFacet(it, exec, awaiting) {
  if (awaiting != null) return "needs";
  if (!it || it.status === "crashed") return "crashed";
  if (it.status !== "running") return "stopped";
  return exec === "working" || exec === "stuck" ? "working" : "idle";
}

export function normalizeFilter(query) { return String(query == null ? "" : query).trim().toLowerCase(); }
/** Case-insensitive substring on name (incl. display name), model and backend. */
export function instanceMatchesFilter(it, needle, labelOf) {
  if (!needle) return true;
  const fields = [nameOf(it), it.display_name, it.model, it.backend, labelOf ? labelOf(it.backend) : null];
  return fields.some((value) => typeof value === "string" && value.toLowerCase().includes(needle));
}
/**
 * Visible groups in display order, and the "N / M" counts. `facets` (optional): { status: [...], cli: [...],
 * statusOf(name) } — an empty list does not filter; a non-empty one keeps the rows whose status / backend is in it.
 */
export function filterSidebar(groupNames, instByGroup, rosterByName, query, labelOf, facets) {
  const needle = normalizeFilter(query);
  const status = new Set(facets && Array.isArray(facets.status) ? facets.status : []);
  const cli = new Set(facets && Array.isArray(facets.cli) ? facets.cli : []);
  const keep = (name) => {
    const it = rosterByName.get(name);
    if (!instanceMatchesFilter(it, needle, labelOf)) return false;
    if (status.size && !status.has(facets.statusOf ? facets.statusOf(name) : statusFacet(it))) return false;
    if (cli.size && !cli.has(it.backend || "")) return false;
    return true;
  };
  const groups = [];
  let shown = 0, total = 0;
  for (const g of groupNames) {
    const names = (instByGroup.get(g) || []).filter((name) => rosterByName.has(name));
    total += names.length;
    const visible = names.filter(keep);
    shown += visible.length;
    if (visible.length) groups.push({ group: g, names: visible });
  }
  return { groups, shown, total, active: needle.length > 0 || status.size > 0 || cli.size > 0 };
}
export function instanceTooltip(it) {
  const context = it.context_pct != null && Number.isFinite(it.context_pct) ? `${Math.round(Math.min(100, Math.max(0, it.context_pct)))}%` : tn("tooltipUnavailable");
  const status = STATUS_KEYS[it.status] ? tn(STATUS_KEYS[it.status]) : it.status || tn("statusUnknown");
  const line = (key, value) => tn(key, { value });
  const lines = [];
  const name = nameOf(it);
  if (it.display_name && it.display_name !== name) lines.push(it.display_name, `(${name})`);
  else lines.push(name);
  lines.push(line("tooltipBackend", backendLabel(it.backend)));
  const src = (s) => (s === "instance" || s === "classic" ? " (configured)" : s === "fleet-default" ? " (fleet default)" : "");
  lines.push(line("tooltipModel", (it.model || tn("tooltipUnavailable")) + src(it.model_source)));
  lines.push(line("tooltipStatus", status));
  lines.push(line("tooltipContext", context));
  if (it.effort) lines.push(line("tooltipEffort", it.effort + src(it.effort_source)));
  if (typeof it.cost === "number" && it.cost > 0) lines.push(line("tooltipCost", `$${it.cost.toFixed(2)}`));
  if (typeof it.description === "string" && it.description.trim()) lines.push("", it.description.trim());
  return lines.join("\n");
}

// ── This browser's order (drag), folded groups and filter ──
const SIDEBAR_ORDER_KEY = "agend_view_sidebar_order";   // View's key since #999: everyone's arrangement carries over
const COLLAPSED_KEY = "agend_instance_collapsed";
const FILTER_KEY = "agend_instance_filter";
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
function readCollapsed() {
  try { const a = JSON.parse(stored(COLLAPSED_KEY) || "[]"); return new Set(Array.isArray(a) ? a.filter((x) => typeof x === "string") : []); } catch { return new Set(); }
}
const strings = (a) => (Array.isArray(a) ? a.filter((x) => typeof x === "string") : []);
function readFilter() {
  try {
    const f = JSON.parse(stored(FILTER_KEY) || "{}");
    return { q: f && typeof f.q === "string" ? f.q : "", status: strings(f && f.status).filter((s) => STATUS_FACETS.includes(s)), cli: strings(f && f.cli) };
  } catch { return { q: "", status: [], cli: [] }; }
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
    instByGroup.set(g, items.map(nameOf).sort((a, b) => {
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

/** The list's state for the page's life: this browser's order, folded groups and filter (each also kept in storage). */
export const navStore = createStore({ order: readOrder(), collapsed: readCollapsed(), filter: readFilter() });
/** Read them again from this browser's storage — what a page load does (the store above is made that way). */
export function loadNavPrefs() { navStore.set({ order: readOrder(), collapsed: readCollapsed(), filter: readFilter() }); }
/** Change the filter ({ q?, status?, cli? }): the same on every page, and kept by this browser. */
export function setNavFilter(patch) {
  const filter = { ...navStore.get().filter, ...patch };
  navStore.set({ filter });
  store(FILTER_KEY, JSON.stringify(filter));
}
function setCollapsed(collapsed) { navStore.set({ collapsed }); store(COLLAPSED_KEY, JSON.stringify([...collapsed])); }
function persistOrder(groupNames, instByGroup) {
  const rows = [];
  groupNames.forEach((g, i) => rows.push({ item_type: "group", item_name: g, sort_index: i, group_name: null }));
  for (const g of groupNames) (instByGroup.get(g) || []).forEach((n, j) => rows.push({ item_type: "instance", item_name: n, sort_index: j, group_name: g }));
  store(SIDEBAR_ORDER_KEY, JSON.stringify(rows));
  navStore.set({ order: { groups: new Map(groupNames.map((g, i) => [g, i])), insts: new Map(rows.filter((r) => r.item_type === "instance").map((r) => [r.item_name, r.sort_index])) } });
}

// ── The list ──

const statusText = (facet) => (facet === "needs" ? t("app.needsYou") : facet === "working" ? t("app.statusWorking") : facet === "idle" ? t("app.statusIdle")
  : facet === "crashed" ? t("app.statusCrashed") : t("app.statusStopped"));
const dotClass = (facet, exec) => (facet === "needs" ? "warn" : facet === "crashed" ? "bad" : facet === "stopped" ? "off" : exec === "stuck" ? "warn" : facet === "working" ? "busy" : "ok");

/**
 * The sidebar's instance list. `route`: the page's (which instance is open, and which view a row opens). `items`: the
 * rows (status frames' instances, or View's roster for an anonymous reader); `loaded` false shows a skeleton.
 * `exec` / `awaiting`: live state by name (empty for the anonymous reader). `onPick`: a row was clicked (the drawer
 * closes).
 */
export function InstanceNav({ route, items, loaded = true, exec = {}, awaiting = {}, viewOnly = false, onPick }) {
  const nav = useStore(navStore);
  const filterRef = useRef(null);
  const list = useRef(null);
  const drag = useRef(null);
  // Where a row goes: the view the page is in (#1523 §3.1). View → View; Details, or a Fleet tab (Q4 = A), → Details;
  // everywhere else → Chat. The anonymous reader only ever has View.
  const rowPath = viewOnly || (route && route.panel === "view") ? viewPath
    : route && (route.panel === "details" || route.panel === "fleet") ? detailsPath : chatPath;
  const active = route && (route.panel === "chat" || route.panel === "view" || route.panel === "details") ? route.instance : null;
  useLayoutEffect(() => { keepActiveInView(list.current); }, [active, items.length, loaded]);
  const own = (map, name) => Object.prototype.hasOwnProperty.call(map, name);
  const byName = new Map(items.map((it) => [nameOf(it), it]));
  const facetOf = (name) => statusFacet(byName.get(name), own(exec, name) ? exec[name] : null, own(awaiting, name) ? awaiting[name] : null);
  const { groupNames, instByGroup } = computeOrder(items, nav.order);
  const f = nav.filter;
  const shown = filterSidebar(groupNames, instByGroup, byName, f.q, backendLabel, { status: f.status, cli: f.cli, statusOf: facetOf });
  const backends = [...new Set(items.map((it) => it.backend).filter((b) => typeof b === "string" && b))].sort((a, b) => backendLabel(a).localeCompare(backendLabel(b)));
  const toggle = (g) => { const c = new Set(navStore.get().collapsed); if (c.has(g)) c.delete(g); else c.add(g); setCollapsed(c); };
  // From the store, not this render's copy: two clicks before the next render must both count.
  const flip = (key, value) => { const cur = new Set(navStore.get().filter[key]); if (cur.has(value)) cur.delete(value); else cur.add(value); setNavFilter({ [key]: [...cur] }); };
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
  const chips = (key, values, label, text) => html`<details class="nav-facet">
    <summary>${label}${f[key].length ? html` <span class="nav-facet-n">${f[key].length}</span>` : null}</summary>
    <div class="nav-facet-list" role="group" aria-label=${label}>${values.map((value) => html`<label key=${value} class="nav-chip">
      <input type="checkbox" checked=${f[key].includes(value)} onChange=${() => flip(key, value)} /><span>${text(value)}</span></label>`)}</div>
  </details>`;
  // The list scrolls; the filter under it stays in view (#999), so it sits outside the scrolling section.
  return html`<div class="view-roster inst-nav">
    <div class="side-section" id="instanceList" ref=${list}>
    <h2 class="side-label">${tn("instancesLabel")}</h2>
    ${!loaded ? html`<${Skeleton} lines=${4} />` : !items.length ? html`<p class="side-empty">${t("app.noInstances")}</p>` : null}
    ${shown.groups.map(({ group: g, names }) => {
      const folded = nav.collapsed.has(g);
      return html`<div key=${g} class="v-group">
        <button type="button" class="v-group-head" aria-expanded=${folded ? "false" : "true"} onClick=${() => toggle(g)}
          title=${tn(folded ? "expandGroup" : "collapseGroup", { group: g })} ...${dragProps({ type: "group", name: g })}>
          <${Icon} name="chevron" size=${14} cls=${folded ? "caret folded" : "caret"} /><span class="grow">${g}</span><span class="count">${names.length}</span></button>
        ${folded ? null : html`<ul class="inst-list">${names.map((name) => {
          const it = byName.get(name);
          const alias = typeof it.display_name === "string" && it.display_name.trim() && it.display_name.trim() !== name ? it.display_name.trim() : "";
          const facet = facetOf(name);
          const waiting = own(awaiting, name) ? awaiting[name] : null;
          const on = name === active;
          return html`<li key=${name}><a class=${`inst v-inst${on ? " active" : ""}`} href=${rowPath(name)} title=${instanceTooltip(it)}
              aria-current=${on ? "page" : undefined} onClick=${onPick} ...${dragProps({ type: "instance", name, group: g })}>
            <span class=${`dot ${dotClass(facet, own(exec, name) ? exec[name] : null)}`} aria-hidden="true"></span>
            <span class="inst-text"><span class="inst-name">${name}</span>
              ${alias || facet === "needs" ? html`<span class="inst-sub">${alias ? html`<span class="inst-alias">${alias}</span>` : null}
                ${facet === "needs" ? html`<span class="badge-await" title=${waiting || t("app.approxNote")}>${t("app.needsYou")}</span>` : null}</span>` : null}
              <span class="sr-only">${statusText(facet)}</span></span>
            <span class="v-meta">${it.context_pct != null ? `${Math.round(it.context_pct)}%` : ""}</span>
            <span class=${`cli-icon cli-${KNOWN_BACKENDS.has(it.backend) ? it.backend : "other"}`} title=${backendLabel(it.backend)} aria-label=${tn("tooltipBackend", { value: backendLabel(it.backend) })}></span>
          </a></li>`;
        })}</ul>`}
      </div>`;
    })}
    ${loaded && shown.active && !shown.groups.length ? html`<p class="side-empty">${tn("filterNone")}</p>` : null}
    </div>
    <div class="v-filter">
      <label class="v-filter-box"><${Icon} name="search" size=${14} /><span class="sr-only">${tn("filterPh")}</span>
        <input ref=${filterRef} id="filterInput" type="text" autocomplete="off" spellcheck="false" placeholder=${tn("filterPh")} value=${f.q}
          onInput=${(e) => setNavFilter({ q: e.target.value })}
          onKeyDown=${(e) => { if (e.key === "Escape" && f.q) { e.preventDefault(); e.stopPropagation(); setNavFilter({ q: "" }); } }} />
        ${f.q ? html`<button type="button" class="icon-btn v-filter-clear" aria-label=${tn("filterClear")} title=${tn("filterClear")}
          onClick=${() => { setNavFilter({ q: "" }); filterRef.current && filterRef.current.focus(); }}><${Icon} name="close" size=${14} /></button>` : null}
      </label>
      <div class="nav-facets">
        ${viewOnly ? null : chips("status", STATUS_FACETS, tn("filterStatus"), statusText)}
        ${backends.length > 1 || f.cli.length ? chips("cli", backends, tn("filterCli"), backendLabel) : null}
        ${f.status.length || f.cli.length ? html`<button type="button" class="chip-btn nav-facet-reset" onClick=${() => setNavFilter({ status: [], cli: [] })}>${tn("filterFacetsReset")}</button>` : null}
      </div>
      <p class="note" aria-live="polite">${shown.shown} / ${shown.total}${shown.active ? ` ${tn("filterShown")}` : ""}</p>
    </div>
  </div>`;
}

/**
 * Keep a sidebar list's current item in view by scrolling that list only (alpha.2): never scrollIntoView, which would
 * also scroll every scrollable ancestor, the page included. A list the reader scrolled stays where it is otherwise.
 */
export function keepActiveInView(container) {
  const a = container && container.querySelector('[aria-current="page"]');
  if (!a) return;
  const c = container.getBoundingClientRect(), r = a.getBoundingClientRect();
  if (r.top < c.top) container.scrollTop -= c.top - r.top;
  else if (r.bottom > c.bottom) container.scrollTop += r.bottom - c.bottom;
}

/** The list fed by View's roster read (/api/profiles): the anonymous View reader's, who has no status frames. */
export function RosterNav({ route, viewOnly = false, onPick }) {
  const v = useStore(viewStore);
  return html`<${InstanceNav} route=${route || { panel: "view", instance: v.current }} items=${v.roster} loaded=${v.loaded} viewOnly=${viewOnly} onPick=${onPick} />`;
}
