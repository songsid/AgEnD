// #2246 follow-up, after Linear's Display and Filter (as Circle, ln-dev7/circle, draws them): a project's main tasks as
// a list beside the board, and filters (Fleet › Tasks). The board keeps its status columns (a drop there moves the
// card); the list shows the same main tasks a row each, grouped by status, assignee or priority, in the board's order,
// by priority, by last change, newest first or by title — and their sub tasks as rows of their own when asked.
// Filters stack (each "is" or "is not" some values; a main task stays when it or one of its sub tasks matches them all)
// and ride in the address with the project (`?tp=`, `?tf=`), so a filtered board can be sent as a link; the last ones
// and the display choices are remembered on this device. No style attribute anywhere (the CSP).
import { html, useEffect, useRef, useState } from "/assets/app-html.js";
import { t, register, lang } from "/assets/app-i18n.js";
import { Icon } from "/assets/ui-icons.js";
import { Menu } from "/assets/ui-menu.js";
import { RunMark, runOf } from "./fleet-task-run.js";
import "./fleet-task-files.js";
import { OwnerChip } from "./fleet-task-owner.js";
import { UnreadMark, markFor } from "./fleet-task-unread.js";
import { COLUMNS, ProgressBar, UNASSIGNED, Who, readStored, recentlyDone, relTime, reviewLabel, waitsForYou, waitsList, waitsOn, wrapUpText, writeStored } from "./fleet-task-common.js";
import { assetUrl } from "/assets/asset-url.js";
import { dateTimeText } from "/assets/clock-text.js";

/** The task board's stylesheet, linked once (a tab opened before an upgrade has an app.css without these rules). */
export function linkTaskBoardCss(doc = typeof document !== "undefined" ? document : null) {
  try {
    if (!doc || !doc.head || doc.querySelector('link[data-tb-css="1"]')) return;
    const link = doc.createElement("link");
    link.setAttribute("rel", "stylesheet"); link.setAttribute("href", assetUrl("/assets/task-board.css")); link.setAttribute("data-tb-css", "1");
    doc.head.appendChild(link);
  } catch { /* the board still works without it */ }
}
linkTaskBoardCss();

// The Filter icon, drawn here: a tab opened before an upgrade has a ui-icons.js without it.
const FilterIcon = () => html`<svg class="icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
  stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M3 5h18l-7 8.5V19l-4 2v-7.5z"/></svg>`;
/** A labelled menu button, with only the Menu props an older cached ui-menu.js has (`trigger`, `triggerClass`). */
function TextMenu({ cls, icon, text, tip, active = false, items }) {
  const glyph = icon === "filter" ? html`<${FilterIcon} />` : icon ? html`<${Icon} name=${icon} size=${16} />` : null;
  return html`<${Menu} cls=${cls} label=${tip ? `${text}, ${tip}` : text} active=${active} items=${items}
    triggerClass="btn btn-sm menu-text" trigger=${html`${glyph}<span>${text}</span>`} />`;
}

register("taskview", {
  en: {
    display: "Display", displayTip: "Board or list, grouping, order, finished cards", filter: "Filter", filterTip: "Show only some cards",
    view: "View", board: "Board", list: "List", groupBy: "Group by", orderBy: "Order by", finished: "Finished cards", doneHide: "Hidden",
    "group.status": "Status", "group.assignee": "Assignee", "group.priority": "Priority", "group.none": "No grouping",
    "order.manual": "Board order", "order.priority": "Priority", "order.updated": "Last change", "order.created": "Newest first", "order.title": "Title",
    subsRows: "Sub tasks as rows of their own",
    fieldstatus: "Status", fieldassignee: "Assignee", fieldpriority: "Priority", fieldsize: "Size",
    filters: "Filters", is: "is", isNot: "is not", opTip: "Switch between is and is not", values: "{0}: choose values",
    nValues: "{0} values", remove: "Remove this filter", clear: "Clear filters", changed: "Changed {0}", inMain: "Sub task of {0} {1}",
    fieldwaits: "Needs you", waitsYou: "Waiting for me", viewLabel: "Board or list", scrollColumns: "Scroll the columns", columnsLeft: "Columns to the left", columnsRight: "Columns to the right", search: "Search", searchLabel: "Search this project's cards (numbers, titles, fields, checklists)",
    "order.assignee": "Assignee", "order.code": "Number", sortBy: "Sort by {0}", sortedBy: "{0}, sorted {1}", asc: "ascending", desc: "descending",
    colId: "ID", colTitle: "Title", colPriority: "Priority", colAssignee: "Assignee", colUpdated: "Updated",
    collapse: "Collapse {0}", expand: "Expand {0}", more: "Card actions", statusTabs: "Show one status", noMatch: "No cards match “{0}”", clearSearch: "Clear search",
  },
  "zh-TW": {
    display: "顯示", displayTip: "看板或清單、分組、排序、已完成的卡", filter: "篩選", filterTip: "只看部分卡片",
    view: "檢視", board: "看板", list: "清單", groupBy: "分組", orderBy: "排序", finished: "已完成的卡", doneHide: "隱藏",
    "group.status": "狀態", "group.assignee": "負責人", "group.priority": "優先級", "group.none": "不分組",
    "order.manual": "看板順序", "order.priority": "優先級", "order.updated": "最近變動", "order.created": "最新建立", "order.title": "標題",
    subsRows: "子任務也各列一行",
    fieldstatus: "狀態", fieldassignee: "負責人", fieldpriority: "優先級", fieldsize: "大小",
    filters: "篩選條件", is: "是", isNot: "不是", opTip: "切換「是」與「不是」", values: "{0}：選擇項目",
    nValues: "{0} 項", remove: "移除這個條件", clear: "清除篩選", changed: "{0}變動", inMain: "{0} {1} 的子任務",
    fieldwaits: "等我處理", waitsYou: "等我確認", viewLabel: "看板或清單", scrollColumns: "捲動欄位", columnsLeft: "左邊的欄位", columnsRight: "右邊的欄位", search: "搜尋", searchLabel: "搜尋這個專案的卡片（卡號、標題、欄位、完成定義）",
    "order.assignee": "負責人", "order.code": "卡號", sortBy: "依{0}排序", sortedBy: "{0}，{1}排序", asc: "由小到大", desc: "由大到小",
    colId: "卡號", colTitle: "標題", colPriority: "優先級", colAssignee: "負責人", colUpdated: "更新",
    collapse: "收合 {0}", expand: "展開 {0}", more: "卡片動作", statusTabs: "一次看一個狀態", noMatch: "沒有符合「{0}」的卡片", clearSearch: "清除搜尋",
  },
});

// ── What is shown (pure: tests import these) ─────────────────

export const VIEWS = ["board", "list"];
export const GROUPS = ["status", "assignee", "priority", "none"];
export const ORDERS = ["manual", "priority", "updated", "created", "title", "assignee", "code"];
export const DIRS = ["asc", "desc"];
export const DONE_SHOWN = ["recent", "all", "hide"];
export const DEFAULT_DISPLAY = Object.freeze({ view: "board", group: "status", order: "manual", dir: "asc", done: "recent", subs: false });
const DISPLAY_KEY = "agend_tasks_display";

/** Display choices from anything (a stored value, an older page's): each one known, else its default. */
export function cleanDisplay(raw) {
  const d = raw && typeof raw === "object" ? raw : {};
  const pick = (k, list) => (list.includes(d[k]) ? d[k] : DEFAULT_DISPLAY[k]);
  return { view: pick("view", VIEWS), group: pick("group", GROUPS), order: pick("order", ORDERS), dir: pick("dir", DIRS), done: pick("done", DONE_SHOWN), subs: d.subs === true };
}
export function readDisplay() {
  try { return cleanDisplay(JSON.parse(readStored(DISPLAY_KEY, "{}"))); } catch { return { ...DEFAULT_DISPLAY }; }
}
export const writeDisplay = (d) => writeStored(DISPLAY_KEY, JSON.stringify(cleanDisplay(d)));

/** Whether a card is shown for its finish: unfinished always; finished ones of the last 7 days (the default), all, or none. */
export function doneShown(card, done, now = Date.now()) {
  if (card.status !== "done") return true;
  return done === "all" || (done === "recent" && recentlyDone(card, now));
}

export const FILTER_FIELDS = ["status", "assignee", "priority", "size", "waits"];
/** A filter's value for "nobody" (assignee) and "not sized" (size). */
export const NONE = "~";
const PRIORITIES = ["urgent", "high", "normal", "low"];
/** "waits": whether the card waits for the person (Needs you's rule) — one value, "you". */
const KNOWN = { status: COLUMNS, priority: PRIORITIES, size: ["S", "M", "L", NONE], waits: ["you"] };
const FILTERS_KEY = "agend_tasks_filters";
const LEGACY_ASSIGNEE = "agend_tasks_assignee";   // the board's one assignee filter before these

/** A card's value for a filter's field. */
export function valueOf(card, field) {
  if (field === "assignee") return card.assignee || NONE;
  if (field === "size") return card.size || NONE;
  if (field === "waits") return waitsForYou(card) ? "you" : "other";
  return card[field];
}

/** Whether a card matches every filter. */
export const cardMatches = (card, filters) => filters.every((f) => f.values.includes(valueOf(card, f.field)) !== f.not);

/**
 * Whether a card has every word of a search (case does not matter): its number, title, goal, scope, context, state,
 * result, blocked reason, assignee and checklist. No words: every card.
 */
export function searchMatches(card, query) {
  const words = String(query || "").toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const text = [card.id, card.title, card.goal, card.scope, card.context, card.state, card.result, card.blockedReason, card.assignee, ...(card.acceptance || []).map((a) => a.text)]
    .filter(Boolean).join("\n").toLocaleLowerCase();
  return words.every((w) => text.includes(w));
}
const passes = (card, filters, query) => cardMatches(card, filters) && searchMatches(card, query);

/** A main task stays when it, or one of its sub tasks, matches every filter (and the search, when there is one). */
export const mainMatches = (main, subs, filters, query = "") => passes(main, filters, query) || (subs || []).some((s) => passes(s, filters, query));

// In the address: `field:a,b;field!:c` — "!" is "is not"; a value's own , ; : ! % ~ are %-escaped, so a bare ~ is NONE.
const esc = (v) => (v === NONE ? NONE : v.replace(/[%,;:!~]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`));

export function formatFilters(filters) {
  return filters.map((f) => `${f.field}${f.not ? "!" : ""}:${f.values.map(esc).join(",")}`).join(";");
}

/** Filters from their address form: unknown fields and values are dropped, and a field counts once (its first). */
export function parseFilters(text) {
  const out = [];
  for (const part of String(text || "").split(";")) {
    const m = /^([a-z]+)(!?):(.*)$/.exec(part);
    if (!m || !FILTER_FIELDS.includes(m[1]) || out.some((f) => f.field === m[1])) continue;
    const values = [];
    for (const raw of m[3].split(",")) {
      let v = raw;
      if (raw !== NONE) { try { v = decodeURIComponent(raw); } catch { continue; } }
      if (!v || values.includes(v) || (KNOWN[m[1]] && !KNOWN[m[1]].includes(v))) continue;
      values.push(v);
    }
    if (values.length) out.push({ field: m[1], not: m[2] === "!", values });
  }
  return out;
}

/** The filters a board starts with: the address's, else the last ones on this device (or the old assignee filter's). */
export function startFilters(search) {
  let q;
  try { q = new URLSearchParams(search || ""); } catch { q = new URLSearchParams(); }
  if (q.has("tf")) return parseFilters(q.get("tf"));
  const kept = readStored(FILTERS_KEY, null);
  if (kept !== null) return parseFilters(kept);
  const legacy = readStored(LEGACY_ASSIGNEE, "");
  return legacy ? [{ field: "assignee", not: false, values: [legacy === UNASSIGNED ? NONE : legacy] }] : [];
}
export function keepFilters(filters) {
  writeStored(FILTERS_KEY, formatFilters(filters));
  writeStored(LEGACY_ASSIGNEE, null);
}

/** Ticking a value: into that field's filter (made when there is none), or out of it (gone with its last value). */
export function toggleValue(filters, field, v) {
  const f = filters.find((x) => x.field === field);
  if (!f) return [...filters, { field, not: false, values: [v] }];
  const values = f.values.includes(v) ? f.values.filter((x) => x !== v) : [...f.values, v];
  return values.length ? filters.map((x) => (x === f ? { ...f, values } : x)) : filters.filter((x) => x !== f);
}

/** The values a field offers: every status, priority and size; the assignees of the project's cards (and the filter's). */
export function fieldValues(field, cards, filter = null) {
  if (field !== "assignee") return KNOWN[field];
  const names = new Set(cards.map((c) => c.assignee).filter(Boolean));
  for (const v of filter ? filter.values : []) if (v !== NONE) names.add(v);
  return [...names].sort((a, b) => a.localeCompare(b)).concat(NONE);
}

/**
 * The list's rows: the main tasks shown — or, with sub tasks as rows, each main task that matches the filters itself
 * and its sub tasks that do (and are shown for their finish), each sub task right after its main task.
 */
export function listRows(mains, subsOf, display, filters, now = Date.now(), query = "") {
  if (!display.subs) return mains;
  const out = [];
  for (const m of mains) {
    if (passes(m, filters, query)) out.push(m);
    for (const s of subsOf.get(m.id) || []) if (doneShown(s, display.done, now) && passes(s, filters, query)) out.push(s);
  }
  return out;
}

const PRIORITY_RANK = { urgent: 0, high: 1, normal: 2, low: 3 };
/** A card's number as a sortable pair: main tasks before sub tasks, then by the number itself. */
const codeKey = (c) => [c.kind === "sub" ? 1 : 0, Number(/\d+/.exec(c.id)?.[0] ?? 0)];
/**
 * Rows in an order: the board's (a sub task right after its main task), by priority (urgent first), last change and
 * newest (newest first), title, assignee or number. `dir` "desc" turns the order round — except that a card nobody has
 * is last by assignee either way (it is not "the biggest name").
 */
export function orderRows(rows, order, byId = new Map(), dir = "asc") {
  const place = (c) => {
    const main = c.kind === "sub" ? byId.get(c.parentId) : null;
    return main ? [main.sort, 1, c.sort] : [c.sort, 0, 0];
  };
  const manual = (a, b) => { const x = place(a), y = place(b); return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]; };
  const by = {
    manual,
    priority: (a, b) => (PRIORITY_RANK[a.priority] ?? 2) - (PRIORITY_RANK[b.priority] ?? 2) || manual(a, b),
    updated: (a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)) || manual(a, b),
    created: (a, b) => String(b.createdAt).localeCompare(String(a.createdAt)) || manual(a, b),
    title: (a, b) => a.title.localeCompare(b.title, lang()) || manual(a, b),
    assignee: (a, b) => (a.assignee ? 0 : 1) - (b.assignee ? 0 : 1) || String(a.assignee || "").localeCompare(String(b.assignee || ""), lang()) || manual(a, b),
    code: (a, b) => { const x = codeKey(a), y = codeKey(b); return x[0] - y[0] || x[1] - y[1]; },
  }[order] || manual;
  if (dir !== "desc") return [...rows].sort(by);
  // Turned round; for assignee the nobody-last rule stays outside the turning.
  return [...rows].sort(order === "assignee" ? (a, b) => (a.assignee ? 0 : 1) - (b.assignee ? 0 : 1) || by(b, a) : (a, b) => by(b, a));
}

/** Rows in groups, in a fixed order: statuses as the board's columns, priorities from urgent, assignees by name (nobody last). */
export function groupRows(rows, group) {
  if (group === "none") return rows.length ? [{ key: "all", rows }] : [];
  const keys = group === "status" ? COLUMNS : group === "priority" ? PRIORITIES
    : [...new Set(rows.map((r) => r.assignee).filter(Boolean))].sort((a, b) => a.localeCompare(b)).concat(NONE);
  return keys.map((key) => ({ key, rows: rows.filter((r) => valueOf(r, group) === key) })).filter((g) => g.rows.length);
}

/** A filter value in words: a status, a priority, a size, an assignee (nobody: "Unassigned"; not sized: "Not sized"). */
export function valueWord(field, v) {
  if (field === "waits") return t("taskview.waitsYou");
  if (v === NONE) return field === "size" ? t("tasks.sizeNone") : t("tasks.nobody");
  if (field === "status" || field === "priority") return t(`tasks.${v}`);
  if (field === "size") return t(`tasks.size${v}`);
  return v;
}
const listJoin = (words) => words.join(lang() === "zh-TW" ? "、" : ", ");

// ── The header's Filter and Display, and the filters' chips ───────

/** Filter: each field's values, ticked when its filter has them; a tick adds the value to (or takes it from) the filter. */
export function FilterMenu({ cards, filters, onChange }) {
  const items = [];
  for (const field of FILTER_FIELDS) {
    const f = filters.find((x) => x.field === field) || null;
    items.push({ key: `h-${field}`, heading: true, label: t(`taskview.field${field}`) });
    for (const v of fieldValues(field, cards, f)) {
      items.push({ key: `${field}:${v}`, checkbox: true, checked: !!f && f.values.includes(v), label: valueWord(field, v), onSelect: () => onChange(toggleValue(filters, field, v)) });
    }
  }
  return html`<${TextMenu} cls="tb-filter-menu" icon="filter" text=${t("taskview.filter")} tip=${t("taskview.filterTip")} active=${filters.length > 0} items=${items} />`;
}

/** Display: the list's grouping, order and sub-task rows; which finished cards show (the board / list switch is the toolbar's). */
export function DisplayMenu({ display, onChange, archiving = false }) {
  const d = display;
  const list = d.view === "list";
  const radio = (k, v, label) => ({ key: `${k}-${v}`, label, checked: d[k] === v, onSelect: () => onChange({ ...d, [k]: v }) });
  const items = [
    list && { key: "h-group", heading: true, label: t("taskview.groupBy") },
    ...(list ? GROUPS.map((g) => radio("group", g, t(`taskview.group.${g}`))) : []),
    list && { key: "h-order", heading: true, label: t("taskview.orderBy") },
    ...(list ? ORDERS.map((o) => ({ key: `order-${o}`, label: t(`taskview.order.${o}`), checked: d.order === o, onSelect: () => onChange({ ...d, order: o, dir: "asc" }) })) : []),
    list && { key: "subs", checkbox: true, checked: d.subs, label: t("taskview.subsRows"), onSelect: () => onChange({ ...d, subs: !d.subs }) },
    { key: "h-done", heading: true, label: t("taskview.finished") },
    // M-3668: with archiving on, finished cards show (their newest, the rest in the Archive) or hide — "All" is the Archive.
    ...(archiving ? [{ key: "done-show", label: t("tasksArchive.doneShow"), checked: d.done !== "hide", onSelect: () => onChange({ ...d, done: "recent" }) }, radio("done", "hide", t("taskview.doneHide"))]
      : [radio("done", "recent", t("tasks.recent")), radio("done", "all", t("tasks.all")), radio("done", "hide", t("taskview.doneHide"))]),
  ];
  // Pressed while it shows something other than the defaults (beyond board or list, which is plain to see).
  const changed = ["group", "order", "dir", "done", "subs"].some((k) => d[k] !== DEFAULT_DISPLAY[k]);
  return html`<${TextMenu} cls="tb-view-menu" icon="sliders" text=${t("taskview.display")} tip=${t("taskview.displayTip")} active=${changed} items=${items} />`;
}

/** Board | List, one click: the choice is remembered on this device (the display's `view`). */
export function ViewToggle({ display, onChange }) {
  return html`<div class="tb-seg tb-view-toggle" role="group" aria-label=${t("taskview.viewLabel")}>${VIEWS.map((v) =>
    html`<button key=${v} type="button" aria-pressed=${display.view === v ? "true" : "false"} class=${`tb-seg-btn${display.view === v ? " active" : ""}`}
      onClick=${() => display.view !== v && onChange({ ...display, view: v })}>${t(`taskview.${v}`)}</button>`)}</div>`;
}

/**
 * How far the board's columns reach past their box: `over` (they do not fit, so they scroll sideways), and whether there is more
 * to the `left` and to the `right` of what shows. Pure on the box's measures (a platform may hide its scrollbar until it is used,
 * so the toolbar says it in buttons).
 */
export function scrollReach({ scrollWidth, clientWidth, scrollLeft }) {
  const over = scrollWidth - clientWidth > 1;
  return { over, left: over && scrollLeft > 1, right: over && scrollLeft + clientWidth < scrollWidth - 1 };
}
export const NO_REACH = { over: false, left: false, right: false };

/**
 * "‹ ›" at the toolbar's end while the board has columns out of sight: a click scrolls the columns by most of a screen. A button
 * with nothing to reach is dimmed and says so (`aria-disabled`), and keeps the focus, so a key press can still land on it.
 */
export function ColumnScroll({ reach, onScroll }) {
  const btn = (dir, icon, can, label) => html`<button type="button" class="tb-seg-btn tb-scroll-btn" aria-label=${label} title=${label}
    aria-disabled=${can ? "false" : "true"} onClick=${() => { if (can) onScroll(dir); }}><${Icon} name=${icon} size=${16} /></button>`;
  return html`<div class="tb-seg tb-scroll-nav" role="group" aria-label=${t("taskview.scrollColumns")}>
    ${btn(-1, "prev", reach.left, t("taskview.columnsLeft"))}${btn(1, "next", reach.right, t("taskview.columnsRight"))}</div>`;
}

/**
 * The project's search: filters what the board and the list show as you type; Esc clears it. On a phone the field is closed
 * (`closed`: the toolbar's 🔍 opens it) unless it holds words; Esc on an empty field asks to close it (`onEmptyEscape`).
 */
export function SearchField({ value, onChange, closed = false, inputRef = null, onEmptyEscape = null }) {
  return html`<div class=${`tb-search tb-find${closed ? " is-closed" : ""}`}>
    <${Icon} name="search" size=${16} cls="tb-search-icon" />
    <input id="tb-find-input" type="search" ref=${inputRef} value=${value} placeholder=${t("taskview.search")} aria-label=${t("taskview.searchLabel")} title=${t("taskview.searchLabel")}
      onInput=${(e) => onChange(e.target.value)}
      onKeyDown=${(e) => {
        if (e.key !== "Escape") return;
        if (value) { e.preventDefault(); e.stopPropagation(); onChange(""); } else if (onEmptyEscape) onEmptyEscape();
      }} />
  </div>`;
}

/**
 * One row of controls under a project's header: the board / list switch, the search, Filter and Display, the buttons that scroll
 * the board's columns while some are out of sight (`scroller`: its `reach` and `by(direction)`), then the filters in force as chips. The filters, the view and the display are kept on this device.
 * On a phone it is one row — the switch at the left; Filter, Display and the 🔍 at the right — and the search field opens from
 * the 🔍 (under the row); a search that holds words keeps its field open, and the 🔍 is marked. The 🔍 is not drawn on a desk,
 * where the field is always there (the page's CSS decides: the same markup serves both).
 */
export function TaskToolbar({ cards, display, onDisplay, filters, onFilters, query, onQuery, scroller = null, archiving = false }) {
  const [asked, setAsked] = useState(false);
  const field = useRef(null);
  const focusNext = useRef(false);
  const hasWords = query !== "";
  const open = asked || hasWords;
  useEffect(() => {
    if (open && focusNext.current) { focusNext.current = false; if (field.current) field.current.focus(); }
  });
  /** The 🔍: opens the field and puts the cursor in it; with words in it, only takes the cursor there; else shuts it. */
  const toggle = () => {
    if (hasWords) { if (field.current) field.current.focus(); return; }
    if (asked) { setAsked(false); return; }
    focusNext.current = true;
    setAsked(true);
  };
  return html`<div class="tb-view-bar">
    <${ViewToggle} display=${display} onChange=${onDisplay} />
    <${SearchField} value=${query} onChange=${onQuery} closed=${!open} inputRef=${field} onEmptyEscape=${() => setAsked(false)} />
    <div class="tb-view-actions">
      <${FilterMenu} cards=${cards} filters=${filters} onChange=${onFilters} />
      <${DisplayMenu} display=${display} onChange=${onDisplay} archiving=${archiving} />
      <button type="button" class=${`btn btn-sm tb-search-toggle${hasWords ? " active" : ""}`} aria-expanded=${open ? "true" : "false"} aria-controls="tb-find-input"
        aria-label=${t("taskview.searchLabel")} title=${t("taskview.searchLabel")} onClick=${toggle}><${Icon} name="search" size=${16} /></button>
    </div>
    ${scroller && scroller.reach.over ? html`<${ColumnScroll} reach=${scroller.reach} onScroll=${scroller.by} />` : null}
    <${FilterBar} cards=${cards} filters=${filters} onChange=${onFilters} />
  </div>`;
}

/** The filters in force, a chip each: its field, is / is not (a click switches), its values (a menu), and remove. */
export function FilterBar({ cards, filters, onChange }) {
  if (!filters.length) return null;
  return html`<div class="tb-filters" role="group" aria-label=${t("taskview.filters")}>
    ${filters.map((f) => {
      const field = t(`taskview.field${f.field}`);
      const shown = f.values.length <= 2 ? listJoin(f.values.map((v) => valueWord(f.field, v))) : t("taskview.nValues", f.values.length);
      return html`<span key=${f.field} class=${`tb-chip${f.not ? " not" : ""}`}>
        <span class="tb-chip-field">${field}</span>
        <button type="button" class="tb-chip-op" title=${t("taskview.opTip")} aria-label=${`${field} ${f.not ? t("taskview.isNot") : t("taskview.is")} — ${t("taskview.opTip")}`}
          onClick=${() => onChange(filters.map((x) => (x === f ? { ...f, not: !f.not } : x)))}>${f.not ? t("taskview.isNot") : t("taskview.is")}</button>
        <${TextMenu} cls="tb-chip-menu" icon="" text=${shown} tip=${t("taskview.values", field)}
          items=${fieldValues(f.field, cards, f).map((v) => ({ key: v, checkbox: true, checked: f.values.includes(v), label: valueWord(f.field, v), onSelect: () => onChange(toggleValue(filters, f.field, v)) }))} />
        <button type="button" class="tb-chip-x" title=${t("taskview.remove")} aria-label=${`${t("taskview.remove")}: ${field}`} onClick=${() => onChange(filters.filter((x) => x !== f))}><${Icon} name="close" size=${14} /></button>
      </span>`;
    })}
    <button type="button" class="tb-link" onClick=${() => onChange([])}>${t("taskview.clear")}</button>
  </div>`;
}

// ── The list ──────────────────────────────────────────────

/** A main task's sub tasks, opened up under it (the board's tile and the list's row). */
export function SubList({ subs, older = 0, onOpen }) {
  return html`<ul class="tb-subs" onClick=${(e) => e.stopPropagation()}>
    ${subs.map((s) => html`<li key=${s.id}><button type="button" onClick=${() => onOpen(s.id)} title=${`${s.id} ${s.title} (${t(`tasks.${s.status}`)})`}>
      <span class=${`tb-dot st-${s.status}`} aria-label=${t(`tasks.${s.status}`)}></span><span class="tb-code">${s.id}</span><span class="tb-sub-title">${s.title}</span>
      ${s.assignee ? html`<span class="tb-who">${s.assignee}</span>` : null}</button>
      ${s.status === "blocked" && s.blockedReason ? html`<div class="tb-sub-blocked">${s.blockedReason}</div>` : null}</li>`)}
    ${older > 0 ? html`<li class="muted tb-sub-more">${t("tasks.olderSubs", older)}</li>` : null}
  </ul>`;
}

function groupHead(group, key) {
  if (group === "status") return html`<span class=${`tb-dot st-${key}`}></span><span>${t(`tasks.${key}`)}</span>`;
  if (group === "assignee") return html`<${Who} name=${key === NONE ? null : key} empty=${t("tasks.nobody")} />`;
  return html`<span class=${`tb-tag p-${key}`}>${t(`tasks.${key}`)}</span>`;
}
const groupWord = (group, key) => (group === "assignee" ? (key === NONE ? t("tasks.nobody") : key) : t(`tasks.${key}`));
const longTime = (iso) => { const d = new Date(iso); return Number.isFinite(d.getTime()) ? dateTimeText(d, undefined, lang() === "zh-TW" ? "zh-TW" : "en") : ""; };

// The groups a person folded away, remembered on this device, per project (by what heads them: "1/status:done",
// "none/assignee:alpha" — the project's id, or "none" for No project).
const COLLAPSED_KEY = "agend_tasks_collapsed";
export const groupId = (group, key, scope = "") => (scope === "" ? `${group}:${key}` : `${scope}/${group}:${key}`);
export function readCollapsed() {
  try { const a = JSON.parse(readStored(COLLAPSED_KEY, "[]")); return new Set(Array.isArray(a) ? a.filter((x) => typeof x === "string") : []); } catch { return new Set(); }
}
export const writeCollapsed = (set) => writeStored(COLLAPSED_KEY, JSON.stringify([...set]));

/** The columns the list's header sorts by, each the order it picks. */
export const SORT_COLUMNS = [["code", "colId", "tb-lh-code"], ["title", "colTitle", "tb-lh-title"], ["priority", "colPriority", "tb-lh-prio"], ["assignee", "colAssignee", "tb-lh-who"], ["updated", "colUpdated", "tb-lh-time"]];

/** A column's order after a click on its header: the same column again turns it round, another starts from its own end. */
export function sortedBy(display, order) {
  return display.order === order ? { ...display, dir: display.dir === "asc" ? "desc" : "asc" } : { ...display, order, dir: "asc" };
}

/** The list's header: its sortable columns (ID, Title, Priority, Assignee, Updated), the current one marked with its direction. */
function ListHead({ display, onDisplay, who }) {
  return html`<div class="tb-list-head" role="group" aria-label=${t("taskview.orderBy")}>
    <span class="tb-lh-dot" aria-hidden="true"></span>
    ${SORT_COLUMNS.filter(([order]) => who || order !== "assignee").map(([order, word, cls]) => {
      const on = display.order === order;
      const label = t(`taskview.${word}`);
      const dirWord = t(`taskview.${display.dir}`);
      return html`<button key=${order} type="button" class=${`tb-lh ${cls}${on ? " active" : ""}`} aria-pressed=${on ? "true" : "false"}
        title=${t("taskview.sortBy", label)} aria-label=${on ? t("taskview.sortedBy", label, dirWord) : t("taskview.sortBy", label)}
        onClick=${() => onDisplay(sortedBy(display, order))}>${label}${on ? html`<${Icon} name=${display.dir === "asc" ? "up" : "down"} size=${12} />` : null}</button>`;
    })}
    <span class="tb-lh-more" aria-hidden="true"></span>
  </div>`;
}

/**
 * The list: a header to sort by, then a row per card in groups, each headed by its status, assignee or priority with its
 * count (a click folds it away). A row shows its number, title, priority, assignee and last change; it opens its card; a
 * main task's sub-task progress opens up its sub tasks under it (unless they are rows already); its ⋯ opens the card's menu.
 */
export function ListView({ rows, display, subsOf, byId, flashed, now, runs, unread = null, expanded, onToggleSubs, onOpen, onMore, onOwner, cards = [], lead = null, writable = false, onDisplay, scope = "" }) {
  const [folded, setFolded] = useState(readCollapsed);
  const toggle = (id) => setFolded((cur) => { const next = new Set(cur); if (next.has(id)) next.delete(id); else next.add(id); writeCollapsed(next); return next; });
  const groups = groupRows(orderRows(rows, display.order, byId, display.dir), display.group);
  const who = display.group !== "assignee";
  return html`<div class="tb-list">
    <${ListHead} display=${display} onDisplay=${onDisplay} who=${who} />
    ${groups.map((g) => {
      const id = groupId(display.group, g.key, scope);
      const shut = display.group !== "none" && folded.has(id);
      return html`<section key=${g.key} class=${`tb-group${shut ? " shut" : ""}`} aria-label=${display.group === "none" ? null : groupWord(display.group, g.key)}>
        ${display.group === "none" ? null : html`<h3 class=${`tb-group-head g-${display.group}`}>
          <button type="button" class="tb-group-toggle" aria-expanded=${shut ? "false" : "true"} title=${t(shut ? "taskview.expand" : "taskview.collapse", groupWord(display.group, g.key))}
            onClick=${() => toggle(id)}><${Icon} name="chevron" size=${14} cls=${shut ? "tb-chev" : "tb-chev open"} />${groupHead(display.group, g.key)}<span class="tb-count">${g.rows.length}</span></button></h3>`}
        ${shut ? null : html`<ul class="tb-rows">${g.rows.map((c) => {
          const subs = subsOf.get(c.id) || [];
          const lit = Math.max(flashed.get(c.id) || 0, ...(display.subs ? [] : subs.map((s) => flashed.get(s.id) || 0)));
          return html`<${Row} key=${c.id} card=${c} subs=${subs} main=${c.kind === "sub" ? byId.get(c.parentId) : null} flash=${now - lit < 4000} now=${now} runs=${runs} unread=${markFor(c, subs, unread)}
            subsAsRows=${display.subs} who=${who} expanded=${!!expanded[c.id]} onToggleSubs=${() => onToggleSubs(c.id)} onOpen=${onOpen} onMore=${onMore}
            onOwner=${onOwner} cards=${cards} lead=${lead} writable=${writable} />`;
        })}</ul>`}
      </section>`;
    })}</div>`;
}

/** One card's row; its assignee is left out under an assignee's own heading. */
function Row({ card, subs, main, flash, now, runs, unread = null, subsAsRows, who, expanded, onToggleSubs, onOpen, onMore, onOwner, cards, lead, writable }) {
  const progress = card.progress;
  const hasSubs = card.kind === "main" && !!progress && progress.total > 0;
  const accepted = card.acceptance.filter((a) => a.done).length;
  const gap = card.status === "review" ? wrapUpText(card) : "";
  const replied = card.lastComment && card.lastComment.authorKind !== "person";
  // Its assignee (or, for a main task, a sub task's) is working on it now.
  const run = runOf(card, runs, subs);
  const bar = hasSubs ? html`<${ProgressBar} progress=${progress} /><span>${t("tasks.subProgress", progress.done, progress.total)}</span>` : null;
  return html`<li class=${`tb-row st-${card.status}${card.kind === "sub" ? " is-sub" : ""}${flash ? " flash" : ""}${run && run.state === "working" && !run.shared ? " running" : ""}${unread ? " has-unread" : ""}`} data-row=${card.id} onClick=${(e) => { if (e.target && e.target.closest && e.target.closest(".tb-owner-pop")) return; onOpen(card.id); }}>
    <div class="tb-row-line">
      <span class=${`tb-dot st-${card.status}`} role="img" aria-label=${t(`tasks.${card.status}`)} title=${t(`tasks.${card.status}`)}></span>
      <span class="tb-code tb-row-code">${card.id}<${UnreadMark} unread=${unread} /></span>
      ${main ? html`<span class="tb-row-main" title=${t("taskview.inMain", main.id, main.title)}>${main.id} ›</span>` : null}
      <span class="tb-row-text">
        <${RunMark} run=${run} />
        <button type="button" class="tb-row-title" onClick=${(e) => { e.stopPropagation(); onOpen(card.id); }}>${card.title}</button>
        ${card.status === "blocked" && card.blockedReason ? html`<span class="tb-row-note">${card.blockedReason}</span>` : null}
      </span>
      <span class="tb-row-tags">
        ${card.status === "review" ? html`<span class=${`tb-tag st-review${waitsForYou(card) ? " you" : ""}`}>${reviewLabel(card)}</span>` : null}
        ${gap ? html`<span class="tb-tag wrapup" title=${t("tasks.wrapLine", gap)}>${t("tasks.wrapTag")}</span>` : null}
        ${card.size ? html`<span class="tb-size" title=${t("tasks.size")}>${t(`tasks.size${card.size}`)}</span>` : null}
      </span>
      ${!hasSubs ? null : subsAsRows ? html`<span class="tb-row-progress">${bar}</span>`
        : html`<button type="button" class="tb-row-progress" aria-expanded=${expanded ? "true" : "false"} title=${expanded ? t("tasks.hideSubs") : t("tasks.showSubs")}
          onClick=${(e) => { e.stopPropagation(); onToggleSubs(); }}>${bar}<${Icon} name="chevron" size=${14} cls=${expanded ? "tb-chev open" : "tb-chev"} /></button>`}
      <span class="tb-tile-stats">
        ${card.acceptance.length ? html`<span class=${accepted === card.acceptance.length ? "all" : ""} title=${t(card.kind === "main" ? "tasks.definition" : "tasks.acceptance")}><${Icon} name="check" size=${13} />${accepted}/${card.acceptance.length}</span>` : null}
        ${waitsOn(card) ? html`<span title=${t("tasks.waitsFor", waitsList(card, ", "))}><${Icon} name="clock" size=${13} /></span>` : null}
        ${card.commentCount ? html`<span class=${replied ? "reply" : ""} title=${replied ? t("tasks.agentReplied") : t("tasks.comments")}><${Icon} name="chat" size=${13} />${card.commentCount}</span>` : null}
        ${card.attachmentCount ? html`<span title=${t("taskfiles.title")}><${Icon} name="attach" size=${13} />${card.attachmentCount}</span>` : null}
      </span>
      <span class=${`tb-row-prio p-${card.priority}`}>${t(`tasks.${card.priority}`)}</span>
      ${who ? html`<span class="tb-row-who"><${OwnerChip} card=${card} cards=${cards} lead=${lead} canAssign=${writable && card.status !== "done" && card.status !== "cancelled"} onPick=${onOwner} /></span>` : null}
      <span class="tb-row-time muted" title=${t("taskview.changed", longTime(card.updatedAt))}>${relTime(card.updatedAt, now)}</span>
      ${onMore ? html`<button type="button" class="icon-btn tb-more" aria-label=${t("taskview.more")} title=${t("taskview.more")}
        onClick=${(e) => { e.stopPropagation(); onMore(card, e.currentTarget); }}><${Icon} name="more" size=${16} /></button>` : null}
    </div>
    ${hasSubs && expanded && !subsAsRows ? html`<${SubList} subs=${subs} older=${progress.total - subs.length} onOpen=${onOpen} />` : null}
  </li>`;
}
