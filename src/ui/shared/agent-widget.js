// #1629 r4-4 (option A): widgets — an agent's in its own chat header and Details page, a person's in their sidebar —
// drawn by the page's own components from a closed declarative spec and its values (src/web-widget.ts). Nothing from a
// mod becomes markup, script, a handler, a URL or a style: text is text nodes, a number fills a <progress> or an SVG
// polyline's points, and tones are fixed class tokens. Colours are the theme's tokens (and a person's own CSS). The box
// always carries the page's own ✦ chip, so a widget never reads as AgEnD's chrome, and nothing in it can be clicked.
//
// What the host sends is checked again here with the same rules; a widget that fails is not drawn, and a value that
// fails shows "—". A `bind` is a value the page already has (the instance's own state, context and cost; the fleet's
// counts in the person's sidebar only) — nothing new is fetched for it.
import { html } from "./app-html.js";
import { register, t } from "./app-i18n.js";
import { statusFacet } from "./instance-nav.js";
import { themesShown, themesStore } from "./app-themes.js";
import { onPrefsChanged, prefInForce, savePref } from "./app-prefs.js";
import { createStore } from "./app-store.js";
import { safeMode } from "./owner-css.js";

register("widget", {
  en: {
    label: "Widget: {0}",
    chip: "A widget — drawn by AgEnD from its owner's data",
    byHuman: "placed by a person",
    none: "—",
  },
  "zh-TW": {
    label: "小工具：{0}",
    chip: "小工具——由 AgEnD 依擁有者的資料繪製",
    byHuman: "由人放置",
    none: "—",
  },
});

export const WIDGET_ITEM_TYPES = ["stat", "progress", "text", "list", "badge", "spark"];
export const WIDGET_TONES = ["ok", "warn", "bad", "info", "muted"];
const INSTANCE_BINDS = ["state", "context_pct", "cost_usd"];
const FLEET_BINDS = ["fleet.idle", "fleet.working", "fleet.needs_you", "fleet.stopped"];
export const SLOT_RULES = {
  chat_header: { maxItems: 4, types: ["stat", "progress", "text", "badge"], binds: INSTANCE_BINDS },
  details: { maxItems: 8, types: WIDGET_ITEM_TYPES, binds: INSTANCE_BINDS },
  sidebar: { maxItems: 8, types: WIDGET_ITEM_TYPES, binds: FLEET_BINDS },
};
const BINDS_FOR = {
  stat: ["context_pct", "cost_usd", ...FLEET_BINDS], progress: ["context_pct"], text: ["state"], badge: ["state"], list: [], spark: [],
};
const ITEM_KEYS = {
  stat: ["type", "label", "key", "bind", "unit"], progress: ["type", "label", "key", "bind", "max"], text: ["type", "label", "key", "bind"],
  list: ["type", "label", "key"], badge: ["type", "label", "key", "bind", "tone", "tones"], spark: ["type", "label", "key"],
};
const LABEL_REQUIRED = ["stat", "progress", "spark"];
const KEY = /^[a-z][a-z0-9_]{0,31}$/;
const NUMBER_MAX = 1e15;
const own = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);
const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);

// One line of text, as the host's canonicalText: NFC, no control, format or separator character but the zero-width
// joiner, at least one character that draws something, 1..max graphemes.
const FORBIDDEN = /(?!‍)[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const VISIBLE = /[^\p{M}\p{C}\p{Z}ᅟᅠㅤﾠ⠀]/u;
let graphemes = null;
export function lineOk(s, max) {
  if (typeof s !== "string" || s.normalize("NFC") !== s || FORBIDDEN.test(s) || s.trim() !== s || !VISIBLE.test(s)) return false;
  try { graphemes ??= new Intl.Segmenter(undefined, { granularity: "grapheme" }); } catch { return false; }
  const n = [...graphemes.segment(s)].length;
  return n >= 1 && n <= max;
}
const isNumber = (v) => typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= NUMBER_MAX;

/** Whether `v` is a value an item of `type` can show (web-widget.ts valueFits). */
export function valueFits(type, v) {
  switch (type) {
    case "stat": return isNumber(v) || lineOk(v, 24);
    case "progress": return isNumber(v);
    case "text": return lineOk(v, 120);
    case "badge": return lineOk(v, 24);
    case "list": return Array.isArray(v) && v.length >= 1 && v.length <= 6 && v.every((s) => lineOk(s, 60));
    case "spark": return Array.isArray(v) && v.length >= 2 && v.length <= 48 && v.every(isNumber);
    default: return false;
  }
}

/**
 * A widget `{ spec, data, by? }` for `slot`, checked again: `{ widget }`, or `{ problem }` (where, and what) when its
 * spec fails — then the whole widget is not drawn. A data value that fails is left out (shown as "—").
 */
export function explainWidget(slot, w) {
  const no = (problem) => ({ problem });
  const rules = own(SLOT_RULES, slot) ? SLOT_RULES[slot] : null;
  if (!rules) return no("slot");
  if (!isObj(w) || !isObj(w.spec)) return no("spec: an object { v: 1, title, items }");
  const s = w.spec;
  const extra = Object.keys(s).find((k) => !["v", "title", "items"].includes(k));
  if (extra) return no(`spec.${extra}: unknown key`);
  if (s.v !== 1) return no("spec.v: must be 1");
  if (!lineOk(s.title, 24)) return no("spec.title: 1..24 characters on one line");
  if (!Array.isArray(s.items) || s.items.length < 1 || s.items.length > rules.maxItems) return no(`spec.items: 1..${rules.maxItems} items`);
  const items = [];
  for (const [i, it] of s.items.entries()) {
    const at = `spec.items.${i}`;
    if (!isObj(it) || !rules.types.includes(it.type)) return no(`${at}.type: ${rules.types.join(", ")}`);
    const unknown = Object.keys(it).find((k) => !ITEM_KEYS[it.type].includes(k));
    if (unknown) return no(`${at}.${unknown}: unknown key`);
    if ((it.label !== undefined || LABEL_REQUIRED.includes(it.type)) && !lineOk(it.label, 24)) return no(`${at}.label: 1..24 characters`);
    if ((it.key === undefined) === (it.bind === undefined)) return no(`${at}: exactly one of key or bind`);
    if (it.key !== undefined && !(typeof it.key === "string" && KEY.test(it.key))) return no(`${at}.key: a-z, 0-9 and _`);
    if (it.bind !== undefined && !(BINDS_FOR[it.type].includes(it.bind) && rules.binds.includes(it.bind))) return no(`${at}.bind: ${BINDS_FOR[it.type].filter((b) => rules.binds.includes(b)).join(", ") || "none here"}`);
    if (it.unit !== undefined && !lineOk(it.unit, 8)) return no(`${at}.unit: 1..8 characters`);
    if (it.max !== undefined && !(isNumber(it.max) && it.max > 0)) return no(`${at}.max: a number > 0`);
    if (it.tone !== undefined && !WIDGET_TONES.includes(it.tone)) return no(`${at}.tone: ${WIDGET_TONES.join(", ")}`);
    let tones;
    if (it.tones !== undefined) {
      if (!isObj(it.tones)) return no(`${at}.tones: { value: tone }`);
      tones = new Map();
      for (const [k, v] of Object.entries(it.tones)) { if (!lineOk(k, 24) || !WIDGET_TONES.includes(v)) return no(`${at}.tones: { value: ${WIDGET_TONES.join(" | ")} }`); tones.set(k, v); }
      if (tones.size < 1 || tones.size > 8) return no(`${at}.tones: 1..8 entries`);
    }
    items.push({ type: it.type, label: it.label, key: it.key, bind: it.bind, unit: it.unit, max: it.max, tone: it.tone, tones });
  }
  const data = new Map();
  if (isObj(w.data)) items.forEach((it, i) => { if (it.key && own(w.data, it.key) && valueFits(it.type, w.data[it.key])) data.set(`${i}`, w.data[it.key]); });
  return { widget: { title: s.title, items, data, by: w.by === "human" ? "human" : "agent" } };
}
/** explainWidget's widget, or null. */
export function checkWidget(slot, w) { return explainWidget(slot, w).widget || null; }

/**
 * What the host would refuse in a person's `{ spec, data }` for `slot` (its whole check, web-widget.ts and web-prefs.ts),
 * or null — so the editor can say why before anything is saved.
 */
export function widgetProblem(slot, v) {
  if (!isObj(v) || Object.keys(v).length !== 2 || !own(v, "spec") || !own(v, "data")) return "{ \"spec\": …, \"data\": … }";
  const r = explainWidget(slot, v);
  if (r.problem) return r.problem;
  if (!isObj(v.data)) return "data: an object { key: value }";
  for (const [k, val] of Object.entries(v.data)) {
    const users = r.widget.items.filter((it) => it.key === k);
    if (!users.length) return `data.${k}: no item shows this key`;
    const bad = users.find((it) => !valueFits(it.type, val));
    if (bad) return `data.${k}: not a value a ${bad.type} shows`;
  }
  const bytes = (x) => new TextEncoder().encode(JSON.stringify(x)).length;
  if (bytes(v.spec) > 2048) return "spec: at most 2048 bytes";
  if (bytes(v.data) > 4096) return "data: at most 4096 bytes";
  return null;
}

/** The values the page has for one instance: its state word (a sidebar facet), context % and cost. */
export function instanceBinds(inst, exec, awaiting) {
  if (!inst) return {};
  return {
    state: statusFacet(inst, exec, awaiting),
    context_pct: isNumber(inst.context_pct) ? Math.round(Math.max(0, Math.min(100, inst.context_pct))) : undefined,
    cost_usd: isNumber(inst.cost) ? inst.cost : undefined,
  };
}
/** The fleet's counts, for the person's sidebar widget only: how many instances are idle, working, need you, stopped. */
export function fleetBinds(instances, exec, awaiting) {
  const n = { "fleet.idle": 0, "fleet.working": 0, "fleet.needs_you": 0, "fleet.stopped": 0 };
  for (const it of Array.isArray(instances) ? instances : []) {
    const f = statusFacet(it, exec && exec[it.name], awaiting && own(awaiting, it.name) ? awaiting[it.name] : null);
    n[f === "needs" ? "fleet.needs_you" : f === "working" ? "fleet.working" : f === "idle" ? "fleet.idle" : "fleet.stopped"] += 1;
  }
  return n;
}

let numbers = null;
function fmt(v) {
  try { numbers ??= new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }); return numbers.format(v); } catch { return String(v); }
}
/** An item's value: its data, or its bind; undefined when there is none (shown as "—"). */
function valueOf(item, i, w, binds) {
  if (item.key) return w.data.get(`${i}`);
  const v = binds && own(binds, item.bind) ? binds[item.bind] : undefined;
  return item.bind === "state" ? (lineOk(v, 24) ? v : undefined) : isNumber(v) ? v : undefined;
}
function shown(item, v) {
  if (v === undefined) return t("widget.none");
  if (item.bind === "cost_usd") return `$${v.toFixed(2)}`;
  if (item.bind === "context_pct") return `${v}%`;
  return typeof v === "number" ? fmt(v) : v;
}
/** The sparkline's points in a 100×24 box (numbers only; nothing else reaches the SVG). */
export function sparkPoints(values) {
  const lo = Math.min(...values), hi = Math.max(...values), span = hi - lo || 1;
  return values.map((v, i) => `${((i / (values.length - 1)) * 100).toFixed(2)},${(22 - ((v - lo) / span) * 20).toFixed(2)}`).join(" ");
}

function Item({ item, v }) {
  const label = item.label ? html`<span class="aw-label">${item.label}</span>` : null;
  switch (item.type) {
    case "stat":
      return html`<div class="aw-item aw-stat">${label}<span class="aw-value">${shown(item, v)}${v !== undefined && item.unit ? html`<span class="aw-unit">${item.unit}</span>` : null}</span></div>`;
    case "progress": {
      const max = item.max ?? 100;
      const pct = v === undefined ? null : Math.round((Math.max(0, Math.min(max, v)) / max) * 100);
      // No value: no bar at all (a <progress> without one is the browser's animated "busy" bar), only "—".
      return html`<div class="aw-item aw-progress">${label}${pct === null ? null : html`<progress class="aw-bar" max=${max} value=${Math.max(0, Math.min(max, v))} aria-label=${item.label}></progress>`}<span class="aw-value">${pct === null ? t("widget.none") : `${pct}%`}</span></div>`;
    }
    case "text":
      return html`<div class="aw-item aw-text">${label}<span class="aw-value">${shown(item, v)}</span></div>`;
    case "badge": {
      const tone = v !== undefined && item.tones && item.tones.has(v) ? item.tones.get(v) : item.tone || "muted";
      return html`<div class="aw-item aw-badge-item">${label}<span class=${`aw-badge aw-tone-${WIDGET_TONES.includes(tone) ? tone : "muted"}`}>${shown(item, v)}</span></div>`;
    }
    case "list":
      return html`<div class="aw-item aw-list">${label}${v === undefined ? html`<span class="aw-value">${t("widget.none")}</span>` : html`<ul>${v.map((line, i) => html`<li key=${i}>${line}</li>`)}</ul>`}</div>`;
    case "spark":
      return html`<div class="aw-item aw-spark-item">${label}${v === undefined ? html`<span class="aw-value">${t("widget.none")}</span>`
        : html`<svg class="aw-spark" viewBox="0 0 100 24" preserveAspectRatio="none" aria-hidden="true"><polyline points=${sparkPoints(v)} /></svg><span class="aw-value">${fmt(v[v.length - 1])}</span>`}</div>`;
    default: return null;
  }
}

/** One widget, checked (checkWidget's result), in `slot`. `binds`: instanceBinds or fleetBinds. */
export function AgentWidget({ slot, widget, binds, tools = null }) {
  if (!widget) return null;
  return html`<section data-trust="widget" class=${`aw aw-${slot}`} aria-label=${t("widget.label", widget.title)} data-widget-slot=${slot}>
    <div class="aw-head"><span class="aw-chip" title=${t("widget.chip")}>✦ ${widget.title}</span>
      ${widget.by === "human" ? html`<span class="aw-by">${t("widget.byHuman")}</span>` : null}${tools}</div>
    <div class="aw-items">${widget.items.map((item, i) => html`<${Item} key=${i} item=${item} v=${valueOf(item, i, widget, binds)} />`)}</div>
  </section>`;
}

/** An agent's widget in `slot` ("chat_header" | "details"), checked; null when none, or agents' looks are not shown here. */
export function widgetFor(name, slot) {
  const s = themesStore.get();
  if (!s.shown || !themesShown() || !own(s.widgets, name)) return null;
  const slots = s.widgets[name];
  return isObj(slots) && own(slots, slot) ? checkWidget(slot, slots[slot]) : null;
}

const SIDEBAR_KEY = "widget.sidebar";
const publicLink = () => typeof document !== "undefined" && !!document.body && document.body.dataset.publicLink === "1";
/** The person's own sidebar widget (a synced preference), raw; null when none. Never on the public link or in safe mode. */
export function sidebarWidgetRaw() {
  if (publicLink() || safeMode()) return null;
  const f = prefInForce(SIDEBAR_KEY);
  let v = f ? f.value : undefined;
  if (!f) { try { v = JSON.parse(localStorage.getItem("agend_widget_sidebar") || "null"); } catch { v = null; } }
  return isObj(v) ? v : null;
}
/** The person's sidebar widget, checked; null when none. */
export function sidebarWidget() { const v = sidebarWidgetRaw(); return v ? checkWidget("sidebar", v) : null; }
/** Bumped when the person's sidebar widget changes (here, or on another device), so the sidebar redraws. */
export const sidebarWidgetStore = createStore({ n: 0 });
const bump = () => sidebarWidgetStore.set((s) => ({ n: s.n + 1 }));
onPrefsChanged((changed) => { if (changed.has(SIDEBAR_KEY)) bump(); });
/** Set (or with null, remove) the person's sidebar widget on all their devices. */
export function setSidebarWidget(value) { savePref(SIDEBAR_KEY, value); bump(); }
