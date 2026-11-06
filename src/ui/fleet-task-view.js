// #2246 follow-up, after Linear's Display and Filter (as Circle, ln-dev7/circle, draws them): a project's main tasks as
// a list beside the board, and filters (Fleet › Tasks). The board keeps its status columns (a drop there moves the
// card); the list shows the same main tasks a row each, grouped by status, assignee or priority, in the board's order,
// by priority, by last change, newest first or by title — and their sub tasks as rows of their own when asked.
// Filters stack (each "is" or "is not" some values; a main task stays when it or one of its sub tasks matches them all)
// and ride in the address with the project (`?tp=`, `?tf=`), so a filtered board can be sent as a link; the last ones
// and the display choices are remembered on this device. No style attribute anywhere (the CSP).
import { html } from "/assets/app-html.js";
import { t, register, lang } from "/assets/app-i18n.js";
import { Icon } from "/assets/ui-icons.js";
import { Menu } from "/assets/ui-menu.js";
import { COLUMNS, ProgressBar, UNASSIGNED, Who, readStored, recentlyDone, relTime, reviewLabel, waitsForYou, wrapUpText, writeStored } from "./fleet-task-common.js";

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
  },
  "zh-TW": {
    display: "顯示", displayTip: "看板或清單、分組、排序、已完成的卡", filter: "篩選", filterTip: "只看部分卡片",
    view: "檢視", board: "看板", list: "清單", groupBy: "分組", orderBy: "排序", finished: "已完成的卡", doneHide: "隱藏",
    "group.status": "狀態", "group.assignee": "負責人", "group.priority": "優先度", "group.none": "不分組",
    "order.manual": "看板順序", "order.priority": "優先度", "order.updated": "最近變動", "order.created": "最新建立", "order.title": "標題",
    subsRows: "子任務也各列一行",
    fieldstatus: "狀態", fieldassignee: "負責人", fieldpriority: "優先度", fieldsize: "大小",
    filters: "篩選條件", is: "是", isNot: "不是", opTip: "切換「是」與「不是」", values: "{0}：選擇項目",
    nValues: "{0} 項", remove: "移除這個條件", clear: "清除篩選", changed: "{0}變動", inMain: "{0} {1} 的子任務",
  },
});

// ── What is shown (pure: tests import these) ─────────────────

export const VIEWS = ["board", "list"];
export const GROUPS = ["status", "assignee", "priority", "none"];
export const ORDERS = ["manual", "priority", "updated", "created", "title"];
export const DONE_SHOWN = ["recent", "all", "hide"];
export const DEFAULT_DISPLAY = Object.freeze({ view: "board", group: "status", order: "manual", done: "recent", subs: false });
const DISPLAY_KEY = "agend_tasks_display";

/** Display choices from anything (a stored value, an older page's): each one known, else its default. */
export function cleanDisplay(raw) {
  const d = raw && typeof raw === "object" ? raw : {};
  const pick = (k, list) => (list.includes(d[k]) ? d[k] : DEFAULT_DISPLAY[k]);
  return { view: pick("view", VIEWS), group: pick("group", GROUPS), order: pick("order", ORDERS), done: pick("done", DONE_SHOWN), subs: d.subs === true };
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

export const FILTER_FIELDS = ["status", "assignee", "priority", "size"];
/** A filter's value for "nobody" (assignee) and "not sized" (size). */
export const NONE = "~";
const PRIORITIES = ["urgent", "high", "normal", "low"];
const KNOWN = { status: COLUMNS, priority: PRIORITIES, size: ["S", "M", "L", NONE] };
const FILTERS_KEY = "agend_tasks_filters";
const LEGACY_ASSIGNEE = "agend_tasks_assignee";   // the board's one assignee filter before these

/** A card's value for a filter's field. */
export function valueOf(card, field) {
  if (field === "assignee") return card.assignee || NONE;
  if (field === "size") return card.size || NONE;
  return card[field];
}

/** Whether a card matches every filter. */
export const cardMatches = (card, filters) => filters.every((f) => f.values.includes(valueOf(card, f.field)) !== f.not);

/** A main task stays when it, or one of its sub tasks, matches every filter. */
export const mainMatches = (main, subs, filters) => cardMatches(main, filters) || (subs || []).some((s) => cardMatches(s, filters));

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
export function listRows(mains, subsOf, display, filters, now = Date.now()) {
  if (!display.subs) return mains;
  const out = [];
  for (const m of mains) {
    if (cardMatches(m, filters)) out.push(m);
    for (const s of subsOf.get(m.id) || []) if (doneShown(s, display.done, now) && cardMatches(s, filters)) out.push(s);
  }
  return out;
}

const PRIORITY_RANK = { urgent: 0, high: 1, normal: 2, low: 3 };
/** Rows in an order: the board's (a sub task right after its main task), by priority, last change, newest, or title. */
export function orderRows(rows, order, byId = new Map()) {
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
  }[order] || manual;
  return [...rows].sort(by);
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
  return html`<${Menu} cls="tb-filter-menu" icon="filter" text=${t("taskview.filter")} label=${t("taskview.filterTip")} active=${filters.length > 0} items=${items} />`;
}

/** Display: board or list; the list's grouping, order and sub-task rows; which finished cards show. */
export function DisplayMenu({ display, onChange }) {
  const d = display;
  const list = d.view === "list";
  const radio = (k, v, label) => ({ key: `${k}-${v}`, label, checked: d[k] === v, onSelect: () => onChange({ ...d, [k]: v }) });
  const items = [
    { key: "h-view", heading: true, label: t("taskview.view") },
    radio("view", "board", t("taskview.board")), radio("view", "list", t("taskview.list")),
    list && { key: "h-group", heading: true, label: t("taskview.groupBy") },
    ...(list ? GROUPS.map((g) => radio("group", g, t(`taskview.group.${g}`))) : []),
    list && { key: "h-order", heading: true, label: t("taskview.orderBy") },
    ...(list ? ORDERS.map((o) => radio("order", o, t(`taskview.order.${o}`))) : []),
    list && { key: "subs", checkbox: true, checked: d.subs, label: t("taskview.subsRows"), onSelect: () => onChange({ ...d, subs: !d.subs }) },
    { key: "h-done", heading: true, label: t("taskview.finished") },
    radio("done", "recent", t("tasks.recent")), radio("done", "all", t("tasks.all")), radio("done", "hide", t("taskview.doneHide")),
  ];
  // Pressed while it shows something other than the defaults (beyond board or list, which is plain to see).
  const changed = ["group", "order", "done", "subs"].some((k) => d[k] !== DEFAULT_DISPLAY[k]);
  return html`<${Menu} cls="tb-view-menu" icon="sliders" text=${t("taskview.display")} label=${t("taskview.displayTip")} active=${changed} items=${items} />`;
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
        <${Menu} cls="tb-chip-menu" icon="" text=${shown} label=${t("taskview.values", field)}
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
const longTime = (iso) => { const d = new Date(iso); return Number.isFinite(d.getTime()) ? d.toLocaleString(lang() === "zh-TW" ? "zh-TW" : "en") : ""; };

/**
 * The list: a row per card in groups, each headed by its status, assignee or priority with its count. A row opens its
 * card; a main task's sub-task progress opens up its sub tasks under it (unless they are rows already).
 */
export function ListView({ rows, display, subsOf, byId, flashed, now, expanded, onToggleSubs, onOpen }) {
  const groups = groupRows(orderRows(rows, display.order, byId), display.group);
  return html`<div class="tb-list">${groups.map((g) => html`<section key=${g.key} class="tb-group" aria-label=${display.group === "none" ? null : groupWord(display.group, g.key)}>
    ${display.group === "none" ? null : html`<h3 class=${`tb-group-head g-${display.group}`}>${groupHead(display.group, g.key)}<span class="tb-count">${g.rows.length}</span></h3>`}
    <ul class="tb-rows">${g.rows.map((c) => {
      const subs = subsOf.get(c.id) || [];
      const lit = Math.max(flashed.get(c.id) || 0, ...(display.subs ? [] : subs.map((s) => flashed.get(s.id) || 0)));
      return html`<${Row} key=${c.id} card=${c} subs=${subs} main=${c.kind === "sub" ? byId.get(c.parentId) : null} flash=${now - lit < 4000} now=${now}
        subsAsRows=${display.subs} who=${display.group !== "assignee"} expanded=${!!expanded[c.id]} onToggleSubs=${() => onToggleSubs(c.id)} onOpen=${onOpen} />`;
    })}</ul>
  </section>`)}</div>`;
}

/** One card's row; its assignee is left out under an assignee's own heading. */
function Row({ card, subs, main, flash, now, subsAsRows, who, expanded, onToggleSubs, onOpen }) {
  const progress = card.progress;
  const hasSubs = card.kind === "main" && !!progress && progress.total > 0;
  const accepted = card.acceptance.filter((a) => a.done).length;
  const gap = card.status === "review" ? wrapUpText(card) : "";
  const replied = card.lastComment && card.lastComment.authorKind !== "person";
  const bar = hasSubs ? html`<${ProgressBar} progress=${progress} /><span>${t("tasks.subProgress", progress.done, progress.total)}</span>` : null;
  return html`<li class=${`tb-row st-${card.status}${card.kind === "sub" ? " is-sub" : ""}${flash ? " flash" : ""}`} data-row=${card.id} onClick=${() => onOpen(card.id)}>
    <div class="tb-row-line">
      <span class=${`tb-dot st-${card.status}`} role="img" aria-label=${t(`tasks.${card.status}`)} title=${t(`tasks.${card.status}`)}></span>
      <span class="tb-code">${card.id}</span>
      ${main ? html`<span class="tb-row-main" title=${t("taskview.inMain", main.id, main.title)}>${main.id} ›</span>` : null}
      <span class="tb-row-text">
        <button type="button" class="tb-row-title" onClick=${(e) => { e.stopPropagation(); onOpen(card.id); }}>${card.title}</button>
        ${card.status === "blocked" && card.blockedReason ? html`<span class="tb-row-note">${card.blockedReason}</span>` : null}
      </span>
      <span class="tb-row-tags">
        ${card.priority === "urgent" || card.priority === "high" ? html`<span class=${`tb-tag p-${card.priority}`}>${t(card.priority === "urgent" ? "tasks.urgentTag" : "tasks.highTag")}</span>` : null}
        ${card.status === "review" ? html`<span class=${`tb-tag st-review${waitsForYou(card) ? " you" : ""}`}>${reviewLabel(card)}</span>` : null}
        ${gap ? html`<span class="tb-tag wrapup" title=${t("tasks.wrapLine", gap)}>${t("tasks.wrapTag")}</span>` : null}
        ${card.size ? html`<span class="tb-size" title=${t("tasks.size")}>${t(`tasks.size${card.size}`)}</span>` : null}
      </span>
      ${!hasSubs ? null : subsAsRows ? html`<span class="tb-row-progress">${bar}</span>`
        : html`<button type="button" class="tb-row-progress" aria-expanded=${expanded ? "true" : "false"} title=${expanded ? t("tasks.hideSubs") : t("tasks.showSubs")}
          onClick=${(e) => { e.stopPropagation(); onToggleSubs(); }}>${bar}<${Icon} name="chevron" size=${14} cls=${expanded ? "tb-chev open" : "tb-chev"} /></button>`}
      <span class="tb-tile-stats">
        ${card.acceptance.length ? html`<span class=${accepted === card.acceptance.length ? "all" : ""} title=${t(card.kind === "main" ? "tasks.definition" : "tasks.acceptance")}><${Icon} name="check" size=${13} />${accepted}/${card.acceptance.length}</span>` : null}
        ${card.unmetDeps.length ? html`<span title=${t("tasks.waitsFor", card.unmetDeps.join(", "))}><${Icon} name="clock" size=${13} /></span>` : null}
        ${card.commentCount ? html`<span class=${replied ? "reply" : ""} title=${replied ? t("tasks.agentReplied") : t("tasks.comments")}><${Icon} name="chat" size=${13} />${card.commentCount}</span>` : null}
      </span>
      ${who ? html`<span class="tb-row-who"><${Who} name=${card.assignee} empty=${t("tasks.nobody")} /></span>` : null}
      <span class="tb-row-time muted" title=${t("taskview.changed", longTime(card.updatedAt))}>${relTime(card.updatedAt, now)}</span>
    </div>
    ${hasSubs && expanded && !subsAsRows ? html`<${SubList} subs=${subs} older=${progress.total - subs.length} onOpen=${onOpen} />` : null}
  </li>`;
}
