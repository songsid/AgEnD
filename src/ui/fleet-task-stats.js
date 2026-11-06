// #2246 follow-up, after Linear's Insights (as Circle, ln-dev7/circle, draws them): a project's cards counted — per
// assignee (each instance's load), status, priority or size — each row a bar split by status, priority or size, with
// its numbers. Main tasks alone, or every card with the sub tasks (the steps instances work on). It counts what the
// board shows: its filter, and finished cards as its Done column has them (the last 7 days', or all). No style
// attribute anywhere (the CSP): the bars are SVG rects coloured by class.
import { html, useState } from "/assets/app-html.js";
import { t, register } from "/assets/app-i18n.js";
import { Dialog } from "/assets/ui-dialog.js";
import { COLUMNS, Who, readStored, writeStored } from "./fleet-task-common.js";

register("taskstats", {
  en: {
    button: "Insights", buttonTip: "Count this project's cards: per assignee, status, priority or size",
    title: "Insights: {0}", count: "Count", countAll: "All cards", countMain: "Main tasks only",
    rows: "Rows", split: "Split by", splitNone: "Nothing",
    "field.assignee": "Assignee", "field.status": "Status", "field.priority": "Priority", "field.size": "Size",
    total: "Total", cards: "{0} cards", empty: "No cards to count here", chart: "{0} by {1}",
    note: "It counts the cards the board shows: with its filter, and finished cards as the Done column has them (the last 7 days, or all).",
  },
  "zh-TW": {
    button: "統計", buttonTip: "統計這個專案的卡：依負責人、狀態、優先度或大小",
    title: "統計：{0}", count: "計算", countAll: "所有卡", countMain: "只算主任務",
    rows: "每一列", split: "細分", splitNone: "不細分",
    "field.assignee": "負責人", "field.status": "狀態", "field.priority": "優先度", "field.size": "大小",
    total: "合計", cards: "{0} 張卡", empty: "這裡沒有可以統計的卡", chart: "{0}，依{1}",
    note: "統計的是看板上顯示的卡：套用看板的篩選；已完成的卡照完成欄顯示的算（近 7 天或全部）。",
  },
});

// ── The numbers (pure: tests import these) ────────────────

export const FIELDS = ["assignee", "status", "priority", "size"];
const NONE = "~";
const ORDER = { status: COLUMNS, priority: ["urgent", "high", "normal", "low"], size: ["S", "M", "L", NONE] };
export const DEFAULT_INSIGHT = Object.freeze({ count: "all", rows: "assignee", split: "status" });
const KEY = "agend_tasks_insights";

/** A card's value for a field: nobody's and not sized are NONE. */
const valueOf = (card, field) => (field === "assignee" ? card.assignee || NONE : field === "size" ? card.size || NONE : card[field]);

/** Choices from anything stored: each one known, else its default; a split on the rows' own field is no split. */
export function cleanInsight(raw) {
  const d = raw && typeof raw === "object" ? raw : {};
  const rows = FIELDS.includes(d.rows) ? d.rows : DEFAULT_INSIGHT.rows;
  const split = d.split === "none" || (FIELDS.includes(d.split) && d.split !== "assignee") ? d.split : DEFAULT_INSIGHT.split;
  return { count: d.count === "main" ? "main" : "all", rows, split: split === rows ? "none" : split };
}
export function readInsight() {
  try { return cleanInsight(JSON.parse(readStored(KEY, "{}"))); } catch { return { ...DEFAULT_INSIGHT }; }
}

/**
 * The project's cards counted: a row per value of `rows` (assignees by most cards first, nobody last; statuses as the
 * columns; priorities from urgent; sizes S, M, L, not sized), each with its parts per value of `split` and its total.
 */
export function insight(cards, choice) {
  const counted = choice.count === "main" ? cards.filter((c) => c.kind === "main") : cards;
  const parts = choice.split === "none" ? ["all"] : ORDER[choice.split];
  const by = new Map();
  for (const c of counted) {
    const k = valueOf(c, choice.rows);
    const row = by.get(k) || { key: k, total: 0, parts: Object.fromEntries(parts.map((p) => [p, 0])) };
    row.total++;
    const p = choice.split === "none" ? "all" : valueOf(c, choice.split);
    if (p in row.parts) row.parts[p]++;
    by.set(k, row);
  }
  let rows = [...by.values()];
  if (choice.rows === "assignee") rows.sort((a, b) => (a.key === NONE) - (b.key === NONE) || b.total - a.total || a.key.localeCompare(b.key));
  else rows = ORDER[choice.rows].filter((k) => by.has(k)).map((k) => by.get(k));
  return { rows, parts, max: Math.max(0, ...rows.map((r) => r.total)), total: counted.length };
}

// ── The dialog ────────────────────────────────────────────

const word = (field, v) => {
  if (v === NONE) return field === "size" ? t("tasks.sizeNone") : t("tasks.nobody");
  return field === "size" ? t(`tasks.size${v}`) : t(`tasks.${v}`);
};

/** One row's bar: its parts side by side, the longest row's total the full width. */
function Bar({ row, parts, split, max }) {
  let x = 0;
  return html`<svg class="ts-bar" viewBox="0 0 100 10" preserveAspectRatio="none" aria-hidden="true" focusable="false">
    <rect class="ts-track" width="100" height="10" />
    ${parts.map((p) => {
      const w = max ? (row.parts[p] / max) * 100 : 0;
      const seg = w > 0 ? html`<rect key=${p} class=${`ts-seg ${split}-${p === NONE ? "none" : p}`} x=${x} width=${w} height="10" />` : null;
      x += w;
      return seg;
    })}</svg>`;
}

/** Insights on a project's cards (those the board has): the choices, a bar per row, the numbers, a legend. */
export function InsightsDialog({ name, cards, onClose }) {
  const [choice, setRaw] = useState(readInsight);
  const set = (patch) => { const next = cleanInsight({ ...choice, ...patch }); setRaw(next); writeStored(KEY, JSON.stringify(next)); };
  const data = insight(cards, choice);
  const split = choice.split;
  const select = (label, value, options, onChange) => html`<label class="field ts-pick"><span>${label}</span>
    <select class="tb-select" value=${value} onChange=${(e) => onChange(e.target.value)}>${options.map(([v, l]) => html`<option key=${v} value=${v}>${l}</option>`)}</select></label>`;
  return html`<${Dialog} title=${t("taskstats.title", name)} onClose=${onClose} wide drawer>
    <div class="ts">
      <div class="ts-choices">
        ${select(t("taskstats.count"), choice.count, [["all", t("taskstats.countAll")], ["main", t("taskstats.countMain")]], (v) => set({ count: v }))}
        ${select(t("taskstats.rows"), choice.rows, FIELDS.map((f) => [f, t(`taskstats.field.${f}`)]), (v) => set({ rows: v }))}
        ${select(t("taskstats.split"), split, [["none", t("taskstats.splitNone")], ...FIELDS.filter((f) => f !== "assignee" && f !== choice.rows).map((f) => [f, t(`taskstats.field.${f}`)])], (v) => set({ split: v }))}
      </div>
      ${data.rows.length === 0 ? html`<p class="muted">${t("taskstats.empty")}</p>` : html`
      <p class="ts-sum"><b>${t("taskstats.cards", data.total)}</b></p>
      ${split === "none" ? null : html`<ul class="ts-legend" aria-hidden="true">${data.parts.map((p) => html`<li key=${p}><span class=${`ts-key ${split}-${p === NONE ? "none" : p}`}></span>${word(split, p)}</li>`)}</ul>`}
      <div class="ts-scroll"><table class="ts-table">
        <caption class="sr-only">${t("taskstats.chart", t(`taskstats.field.${choice.rows}`), split === "none" ? t("taskstats.total") : t(`taskstats.field.${split}`))}</caption>
        <thead><tr><th scope="col">${t(`taskstats.field.${choice.rows}`)}</th><th scope="col" class="ts-n">${t("taskstats.total")}</th><th scope="col" class="ts-bar-col"></th>
          ${split === "none" ? null : data.parts.map((p) => html`<th key=${p} scope="col" class="ts-n ts-part">${word(split, p)}</th>`)}</tr></thead>
        <tbody>${data.rows.map((r) => html`<tr key=${r.key}>
          <th scope="row">${choice.rows === "assignee" ? html`<${Who} name=${r.key === NONE ? null : r.key} empty=${t("tasks.nobody")} />` : word(choice.rows, r.key)}</th>
          <td class="ts-n ts-total">${r.total}</td>
          <td class="ts-bar-col"><${Bar} row=${r} parts=${data.parts} split=${split} max=${data.max} /></td>
          ${split === "none" ? null : data.parts.map((p) => html`<td key=${p} class=${`ts-n ts-part${r.parts[p] ? "" : " zero"}`}>${r.parts[p]}</td>`)}</tr>`)}</tbody>
      </table></div>`}
      <p class="muted ts-note">${t("taskstats.note")}</p>
    </div></${Dialog}>`;
}
