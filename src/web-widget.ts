/**
 * #1629 r4-4 (option A, the user's choice 2026-10-16): a widget is **declarative**. A mod supplies a small closed spec
 * (which host components, in which order, with which labels) and data (the values they show); the page draws them
 * with its own components (src/ui/shared/agent-widget.js). Nothing from a mod is HTML, script, an event handler, a
 * URL or CSS: styling comes only from the agent's theme tokens and a person's own stylesheet, as everywhere else.
 *
 * Slots (r4 §2): `chat_header` and `details` are the agent's own areas (it, or a person, places a widget there);
 * `sidebar` is the person's (their synced preference, never an agent's). A value is either the mod's (`key` → data)
 * or one the page already shows (`bind`): the instance's own state, context and cost, and — in the person's sidebar
 * only — the fleet's counts. The page resolves a bind from what it already has; nothing new is sent for it.
 *
 * One module validates and canonicalises both; the store keeps only what this returns, and the page checks again.
 */
import { createHash } from "node:crypto";
import { canonicalText } from "./web-theme.js";

export const WIDGET_SLOTS = ["chat_header", "details", "sidebar"] as const;
export type WidgetSlot = typeof WIDGET_SLOTS[number];
/** The agent's own slots. `sidebar` is a person's (owner_slot for an agent). */
export const AGENT_WIDGET_SLOTS = ["chat_header", "details"] as const;
export type AgentWidgetSlot = typeof AGENT_WIDGET_SLOTS[number];

export const WIDGET_ITEM_TYPES = ["stat", "progress", "text", "list", "badge", "spark"] as const;
export type WidgetItemType = typeof WIDGET_ITEM_TYPES[number];
export const WIDGET_TONES = ["ok", "warn", "bad", "info", "muted"] as const;
export type WidgetTone = typeof WIDGET_TONES[number];
/** Values the page already has for the instance itself (its status frame entry). */
export const INSTANCE_BINDS = ["state", "context_pct", "cost_usd"] as const;
/** The fleet's counts: the person's sidebar only (an agent's widget never sees another instance). */
export const FLEET_BINDS = ["fleet.idle", "fleet.working", "fleet.needs_you", "fleet.stopped"] as const;
export type WidgetBind = typeof INSTANCE_BINDS[number] | typeof FLEET_BINDS[number];

/** The chat header is one short strip: at most 4 compact items, and no list or sparkline. */
export const SLOT_RULES: Record<WidgetSlot, { maxItems: number; types: readonly WidgetItemType[]; binds: readonly WidgetBind[] }> = {
  chat_header: { maxItems: 4, types: ["stat", "progress", "text", "badge"], binds: INSTANCE_BINDS },
  details: { maxItems: 8, types: WIDGET_ITEM_TYPES, binds: INSTANCE_BINDS },
  sidebar: { maxItems: 8, types: WIDGET_ITEM_TYPES, binds: FLEET_BINDS },
};
/** Which binds each component can show (a bind is a number or a state word). */
const BINDS_FOR: Record<WidgetItemType, readonly WidgetBind[]> = {
  stat: ["context_pct", "cost_usd", ...FLEET_BINDS],
  progress: ["context_pct"],
  text: ["state"],
  badge: ["state"],
  list: [],
  spark: [],
};
/** Every key an item of that type may carry (closed). */
const ITEM_KEYS: Record<WidgetItemType, readonly string[]> = {
  stat: ["type", "label", "key", "bind", "unit"],
  progress: ["type", "label", "key", "bind", "max"],
  text: ["type", "label", "key", "bind"],
  list: ["type", "label", "key"],
  badge: ["type", "label", "key", "bind", "tone", "tones"],
  spark: ["type", "label", "key"],
};
/** A label is required where the value alone would mean nothing. */
const LABEL_REQUIRED: ReadonlySet<WidgetItemType> = new Set(["stat", "progress", "spark"]);

export const WIDGET_TITLE_MAX = 24;
export const WIDGET_LABEL_MAX = 24;
export const WIDGET_UNIT_MAX = 8;
export const WIDGET_TEXT_MAX = 120;
export const WIDGET_LIST_ITEMS = 6;
export const WIDGET_LIST_TEXT_MAX = 60;
export const WIDGET_SPARK_POINTS = 48;
export const WIDGET_TONES_MAX = 8;
export const WIDGET_NUMBER_MAX = 1e15;
/** Canonical JSON bytes: the spec, and the data. */
export const WIDGET_SPEC_MAX_BYTES = 2048;
export const WIDGET_DATA_MAX_BYTES = 4096;
const KEY = /^[a-z][a-z0-9_]{0,31}$/;

export interface WidgetItem {
  type: WidgetItemType;
  label?: string;
  key?: string;
  bind?: WidgetBind;
  unit?: string;
  max?: number;
  tone?: WidgetTone;
  tones?: Record<string, WidgetTone>;
}
export interface WidgetSpec { v: 1; title: string; items: WidgetItem[] }
export type WidgetValue = number | string | string[] | number[];
export type WidgetData = Record<string, WidgetValue>;
export interface WidgetProblem { path: string; problem: string }
export type Checked<T> = { ok: true; value: T } | { ok: false; errors: WidgetProblem[] };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
const bytesOf = (v: unknown): number => Buffer.byteLength(JSON.stringify(v), "utf8");
const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= WIDGET_NUMBER_MAX;
/** A null-prototype map, so "__proto__" is an ordinary key. */
function ownMap<T>(): Record<string, T> { return Object.create(null) as Record<string, T>; }
function put<T>(o: Record<string, T>, k: string, v: T): void { Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true }); }

/** A spec for `slot`, closed and canonical: unknown keys, types, binds or a component the slot can't hold are refused. */
export function checkWidgetSpec(raw: unknown, slot: WidgetSlot): Checked<WidgetSpec> {
  const errors: WidgetProblem[] = [];
  const bad = (path: string, problem: string) => { errors.push({ path, problem }); };
  if (!isObj(raw)) return { ok: false, errors: [{ path: "spec", problem: "an object { v: 1, title, items }" }] };
  for (const k of Object.keys(raw)) if (!["v", "title", "items"].includes(k)) bad(k, "unknown key");
  if (raw.v !== 1) bad("v", "must be 1");
  const title = canonicalText(raw.title, 1, WIDGET_TITLE_MAX);
  if (title === null) bad("title", `1..${WIDGET_TITLE_MAX} characters on one line`);
  const rules = SLOT_RULES[slot];
  const items: WidgetItem[] = [];
  if (!Array.isArray(raw.items) || raw.items.length < 1 || raw.items.length > rules.maxItems) bad("items", `1..${rules.maxItems} items in ${slot}`);
  else raw.items.forEach((it, i) => {
    const at = `items.${i}`;
    if (!isObj(it)) { bad(at, "an object"); return; }
    const type = it.type as WidgetItemType;
    if (!WIDGET_ITEM_TYPES.includes(type)) { bad(`${at}.type`, WIDGET_ITEM_TYPES.join(" | ")); return; }
    if (!rules.types.includes(type)) { bad(`${at}.type`, `not in ${slot} (${rules.types.join(", ")})`); return; }
    for (const k of Object.keys(it)) if (!ITEM_KEYS[type].includes(k)) bad(`${at}.${k}`, "unknown key");
    const out: WidgetItem = { type };
    if (it.label !== undefined || LABEL_REQUIRED.has(type)) {
      const label = canonicalText(it.label, 1, WIDGET_LABEL_MAX);
      if (label === null) bad(`${at}.label`, `1..${WIDGET_LABEL_MAX} characters on one line`); else out.label = label;
    }
    const hasKey = it.key !== undefined, hasBind = it.bind !== undefined;
    if (hasKey === hasBind) bad(at, "exactly one of key (your data) or bind (a value the page has)");
    if (hasKey) { if (typeof it.key === "string" && KEY.test(it.key)) out.key = it.key; else bad(`${at}.key`, "a-z, 0-9 and _ (1..32, starting with a letter)"); }
    if (hasBind) {
      const b = it.bind as WidgetBind;
      if (!BINDS_FOR[type].includes(b)) bad(`${at}.bind`, BINDS_FOR[type].length ? `${type} shows ${BINDS_FOR[type].join(", ")}` : `${type} has no bind`);
      else if (!rules.binds.includes(b)) bad(`${at}.bind`, `not in ${slot}`);
      else out.bind = b;
    }
    if (it.unit !== undefined) { const u = canonicalText(it.unit, 1, WIDGET_UNIT_MAX); if (u === null) bad(`${at}.unit`, `1..${WIDGET_UNIT_MAX} characters`); else out.unit = u; }
    if (it.max !== undefined) { if (isNumber(it.max) && it.max > 0) out.max = it.max; else bad(`${at}.max`, "a number > 0"); }
    if (it.tone !== undefined) { if (WIDGET_TONES.includes(it.tone as WidgetTone)) out.tone = it.tone as WidgetTone; else bad(`${at}.tone`, WIDGET_TONES.join(" | ")); }
    if (it.tones !== undefined) {
      if (!isObj(it.tones) || Object.keys(it.tones).length < 1 || Object.keys(it.tones).length > WIDGET_TONES_MAX) bad(`${at}.tones`, `1..${WIDGET_TONES_MAX} entries { value: tone }`);
      else {
        const tones = ownMap<WidgetTone>();
        for (const [k, v] of Object.entries(it.tones)) {
          const word = canonicalText(k, 1, WIDGET_LABEL_MAX);
          if (word === null || !WIDGET_TONES.includes(v as WidgetTone)) { bad(`${at}.tones`, `each value 1..${WIDGET_LABEL_MAX} characters → ${WIDGET_TONES.join(" | ")}`); break; }
          put(tones, word, v as WidgetTone);
        }
        out.tones = tones;
      }
    }
    items.push(out);
  });
  if (errors.length) return { ok: false, errors };
  const spec: WidgetSpec = { v: 1, title: title!, items };
  if (bytesOf(spec) > WIDGET_SPEC_MAX_BYTES) return { ok: false, errors: [{ path: "spec", problem: `at most ${WIDGET_SPEC_MAX_BYTES} bytes` }] };
  return { ok: true, value: spec };
}

/** Whether `v` is a value an item of `type` can show (the same rule on the page). */
export function valueFits(type: WidgetItemType, v: unknown): boolean {
  switch (type) {
    case "stat": return isNumber(v) || canonicalText(v, 1, WIDGET_LABEL_MAX) !== null;
    case "progress": return isNumber(v);
    case "text": return canonicalText(v, 1, WIDGET_TEXT_MAX) !== null;
    case "badge": return canonicalText(v, 1, WIDGET_LABEL_MAX) !== null;
    case "list": return Array.isArray(v) && v.length >= 1 && v.length <= WIDGET_LIST_ITEMS && v.every(s => canonicalText(s, 1, WIDGET_LIST_TEXT_MAX) !== null);
    case "spark": return Array.isArray(v) && v.length >= 2 && v.length <= WIDGET_SPARK_POINTS && v.every(isNumber);
  }
}
const normalized = (v: WidgetValue): WidgetValue => typeof v === "string" ? v.normalize("NFC") : Array.isArray(v) ? (v as Array<string | number>).map(x => typeof x === "string" ? x.normalize("NFC") : x) as WidgetValue : v;

/** Data for `spec`: closed to the keys the spec names, each value fitting every item that shows it. */
export function checkWidgetData(raw: unknown, spec: WidgetSpec): Checked<WidgetData> {
  if (!isObj(raw)) return { ok: false, errors: [{ path: "data", problem: "an object { key: value }" }] };
  const users = new Map<string, WidgetItemType[]>();
  for (const it of spec.items) if (it.key) users.set(it.key, [...(users.get(it.key) ?? []), it.type]);
  const errors: WidgetProblem[] = [];
  const out = ownMap<WidgetValue>();
  for (const [k, v] of Object.entries(raw)) {
    const types = users.get(k);
    if (!types) { errors.push({ path: `data.${k.slice(0, 40)}`, problem: "no item shows this key" }); continue; }
    const bad = types.find(t => !valueFits(t, v));
    if (bad) { errors.push({ path: `data.${k}`, problem: `not a value a ${bad} shows` }); continue; }
    put(out, k, normalized(v as WidgetValue));
  }
  if (errors.length) return { ok: false, errors };
  if (bytesOf(out) > WIDGET_DATA_MAX_BYTES) return { ok: false, errors: [{ path: "data", problem: `at most ${WIDGET_DATA_MAX_BYTES} bytes` }] };
  return { ok: true, value: out };
}

/** `patch` over `prev`: a key set to null is removed; the result is checked whole. */
export function mergeWidgetData(prev: WidgetData, patch: unknown, spec: WidgetSpec): Checked<WidgetData> {
  if (!isObj(patch)) return { ok: false, errors: [{ path: "data", problem: "an object { key: value | null }" }] };
  const next = ownMap<unknown>();
  for (const [k, v] of Object.entries(prev)) put(next, k, v);
  for (const [k, v] of Object.entries(patch)) { if (v === null) delete next[k]; else put(next, k, v); }
  return checkWidgetData({ ...next }, spec);
}

/** The data kept when a spec changes: each value that still fits the new spec. */
export function carryWidgetData(prev: WidgetData, spec: WidgetSpec): WidgetData {
  const out = ownMap<WidgetValue>();
  for (const [k, v] of Object.entries(prev)) if (checkWidgetData({ [k]: v }, spec).ok) put(out, k, v);
  return out;
}

/** A spec's id: its content (canonical JSON). The same spec in two bundles is the same widget. */
export function widgetId(spec: WidgetSpec): string {
  return createHash("sha256").update(JSON.stringify(spec)).digest("hex").slice(0, 32);
}
