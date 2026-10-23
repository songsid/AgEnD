import { createHash } from "node:crypto";
import { t } from "./locale.js";
import { SettingsConfirmationError, type SettingsChangeSection } from "./settings-confirmation.js";
import { settingsFingerprint } from "./settings-transaction.js";
import { STATUS_EMOJI_CONFIG_KEYS } from "./status-emojis.js";
import { quickLinkEffective } from "./authority/web-authority.js";
import type { SettingsChangeAuthority } from "./settings-authority.js";
import { LOCAL_SESSION_HOURS, localSessionPolicy } from "./web-session.js";
import { APPEARANCE_BOUNDS, APPEARANCE_DEFAULTS } from "./web-appearance-limits.js";
import { DASHBOARD_FEATURES } from "./dashboard-permissions.js";

export const SETTINGS_DIFF_RECORDS = 32;
export const SETTINGS_DIFF_UNITS = 4096;
const immediate = new Set([
  "backend", "model", "effort", "thinking", "thinking_level", "display_name", "name", "description", "locale",
  "tips", "tips_enabled", "auto_pause_after", "context_lines", "tool_progress", "reply_completion_guard", "web_echo",
  "echo_to_channel", "status_emojis", "persona", "emoji", "hang_detector", "guardian", "watchdog", "timeout_minutes",
  "enabled", "startup_concurrency", "spawn_concurrency", "spawn_stagger_ms", "warm_cap", "idle_timeout",
  // #2346: offered by Settings (General → Defaults / Advanced, the agent dialog) and refused here before — a small set of
  // values that changes how an agent logs or talks to its tools, not who may reach it. (Bot-to-bot visibility is judged by
  // direction below, #2346 review: it decides what the public link's board and search show.)
  "log_level", "agent_mode",
  // #2346: defaults.startup.{concurrency, stagger_delay_ms} (its children, below), read at each spawn.
  "startup",
]);
/** A config key whose value is a credential: confirmed by fingerprint, never shown (and redacted on read, #1490). */
export const SETTINGS_SECRET_KEY = /^(?:token|secret|password|api_key|bot_token|web_token|tunnel_token)$/i;
const publicKeys = new Set(["id", "type", "group_id", "general_channel_id", "bot_token_env", "token_env", "mode",
  "working_directory", "project_roots", "adapter_id", "adapterId", "channelId", "instanceName", "createdBy", "createdAt",
  "hostname", "tunnel_token_env", "origin_port", "allowed_hosts", "protocol", "name", "directory", "topic_name", "topic_id", "channel_id", "systemPrompt", "workflow", "primary", "pre_task_command", "instructions", "tool_permissions", "mcp_tools", "skip_permissions",
  // #2346: which tools an agent gets (full: the fleet's own) — shown and confirmed, never applied quietly.
  "tool_set"]);
const idLists = new Set(["allowed_users", "admin_users", "allowed_groups", "allowed_guilds"]);
/** Literal text, never an ANSI/control sequence or a clickable mention. */
export function settingsDisplay(value: unknown): string {
  return (typeof value === "string" ? value : JSON.stringify(value) ?? "absent")
    .replace(/[\p{Cc}\p{Cf}]/gu, char => `\\u{${char.codePointAt(0)!.toString(16)}}`)
    .replace(/@/g, "[at]").replace(/[\\`*_~[\]()<>|]/g, char => `\\${char}`);
}
function fingerprint(value: unknown): string {
  if (value === undefined || value === null || value === "") return "absent";
  return createHash("sha256").update(String(value)).digest("hex").slice(0, 12);
}
function same(a: unknown, b: unknown): boolean { return settingsFingerprint(a) === settingsFingerprint(b); }
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
/**
 * #1490 (Fable's 2.2 audit): an immediate key that holds an object is not an immediate subtree. Only these children
 * of one are immediate — anything else under it (`persona: { bot_token, allowed_users }`) is judged on its own path:
 * a secret or an id list is confirmed, anything else is refused, never skipped with its parent.
 */
const IMMEDIATE_CHILDREN: Readonly<Record<string, ReadonlySet<string>>> = {
  status_emojis: new Set<string>(STATUS_EMOJI_CONFIG_KEYS),
  hang_detector: new Set(["enabled", "timeout_minutes"]),
  startup: new Set(["concurrency", "stagger_delay_ms"]),
};
/**
 * #2346: lists of plain labels the agent dialog edits (tags, fallback models) apply directly, like the immediate scalars
 * — never under an access, credential or control key, and only while every item is a string.
 */
const PLAIN_LISTS = new Set(["tags", "model_failover"]);
const SENSITIVE_SEGMENT = /access|permission|admin|credential|secret|public_link|mcp|auth|pre_task|instruction|project_roots/i;
const scalar = (value: unknown): boolean => value === undefined || value === null || typeof value !== "object";
/**
 * #1620: web exposure settings that are judged by DIRECTION. Tightening (a shorter session, the browser terminal off,
 * a shorter terminal session) applies directly; loosening goes to the #1423 confirmation — whatever the key's name says
 * elsewhere (`enabled` is an immediate key everywhere else). `undefined` (the key removed) is its default.
 * The terminal's minutes are compared as stored: the loader's clamp to 1..20 never reverses an order, so a stored
 * decrease is never an effective increase.
 */
const DIRECTIONAL: ReadonlyArray<{ path: readonly string[]; def: number | boolean; looser(old: any, next: any): boolean }> = [
  { path: ["fleet", "web", "experimental", "canvas_worker"], def: false, looser: (a, b) => b === true && a !== true },
  { path: ["fleet", "web_terminal", "enabled"], def: true, looser: (a, b) => b === true && a !== true },
  { path: ["fleet", "web_terminal", "ttl_minutes"], def: 10, looser: (a, b) => b > a },
  // #1218: the Log tab shows each agent's steps on the web (the public link included): turning it on is confirmed.
  { path: ["fleet", "web", "log_tab"], def: false, looser: (a, b) => b === true && a !== true },
  // #2122: the usage report over the public link applies at once either way. The default (off) is the gate — a link may
  // be shared with people who should not see 400 days of usage; the switch is reached only from a signed-in session on
  // the dashboard reached directly, and it shows counts and amounts, not content: a second confirmation stops nothing more.
  { path: ["fleet", "web", "usage_report_on_public_link"], def: false, looser: () => false },
  // #1629 r4.1 Q3 (b): the card's upload limits and the picture quota — a lower one applies directly, a higher one is
  // confirmed. Judged as the limit they GIVE (clamped to the bounds, as the loader does): 9999 → 5000 changes nothing.
  ...Object.entries(APPEARANCE_BOUNDS).flatMap(([group, keys]) => Object.entries(keys as Record<string, readonly [number, number]>).map(([key, [floor, ceiling]]) => {
    const def = (APPEARANCE_DEFAULTS as Record<string, Record<string, number>>)[group]![key]!;
    const given = (v: number) => (Number.isInteger(v) ? Math.min(ceiling, Math.max(floor, v)) : def);
    return { path: ["fleet", "web", "appearance", group, key], def, looser: (a: number, b: number) => given(b) > given(a) };
  })),
];
/** null: not a directional key (judged as before); true/false: whether this change loosens it. */
function loosens(path: readonly string[], old: unknown, next: unknown): boolean | null {
  const rule = DIRECTIONAL.find(r => r.path.length === path.length && r.path.every((k, i) => k === path[i]));
  if (!rule) return null;
  const a = old === undefined || old === null ? rule.def : old, b = next === undefined || next === null ? rule.def : next;
  if (typeof a !== typeof rule.def || typeof b !== typeof rule.def) return true;   // not a value of its kind: never quietly
  return rule.looser(a, b);
}
const SESSION_LOCAL = ["fleet", "web", "session", "local"] as const;
const SESSION_KEYS: readonly string[] = ["absolute_hours", "idle_hours"];
/**
 * #1620 (#1627 review): the local session limits are judged as the policy they GIVE — what the store enforces
 * (localSessionPolicy), not the stored numbers: a hand-written `absolute_hours: 1000` is enforced as the 48 h default,
 * so 1000 → 72 lengthens sessions and is confirmed (and 1000 → 24 only shortens them). Returns the changed keys to name (empty: it only tightens), or
 * null when the change is not just these two limits (it is then walked key by key, as before).
 */
function sessionChange(old: unknown, next: unknown): Array<[string, unknown, unknown]> | null {
  if ((old !== undefined && old !== null && !object(old)) || (next !== undefined && next !== null && !object(next))) return null;
  const a: Record<string, unknown> = object(old) ? old : {}, b: Record<string, unknown> = object(next) ? next : {};
  const changed = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(k => !same(a[k], b[k]));
  if (changed.some(k => !SESSION_KEYS.includes(k))) return null;
  const before = localSessionPolicy(a), after = localSessionPolicy(b);
  const looser: Record<string, boolean> = { absolute_hours: after.absoluteMs > before.absoluteMs, idle_hours: after.idleMs > before.idleMs };
  // A new value the store would not take as written (out of bounds, not a number) is never applied quietly.
  const taken = (v: unknown) => v === undefined || v === null
    || (typeof v === "number" && Number.isFinite(v) && v >= LOCAL_SESSION_HOURS.min && v <= LOCAL_SESSION_HOURS.max);
  const odd = changed.filter(k => !taken(b[k]));
  if (!odd.length && !looser.absolute_hours && !looser.idle_hours) return [];
  // Each key names its own loosening: the absolute limit never depends on idle_hours, and the idle window a longer
  // absolute limit lifts (it was cut to it) is named by absolute_hours, which grew.
  return changed.filter(k => looser[k] || odd.includes(k)).map(k => [k, a[k], b[k]]);
}
const GUESTS = ["fleet", "web", "guests"] as const;
/** At the gate's root (fleet.web.guests) and at the fleet's (web.guests — settings-authority.ts walks a fleet alone). */
const atGuests = (path: readonly string[]): boolean => (path.length === 3 && GUESTS.every((k, i) => path[i] === k))
  || (path.length === 2 && path[0] === "web" && path[1] === "guests");
const GUEST_JUDGED: readonly string[] = ["enabled", "chat", "open_instances", "narrow", "grants"];
/**
 * #1920 phase 3: guest sign-in is judged by what it lets guests reach. Confirmed: turning it on, letting guests chat,
 * naming more agents for an open connection, and widening or lifting one guest's narrowing. Applied directly: the
 * reverse of each (it only takes away). A value not of its kind is never applied quietly. Returns the loosening entries
 * to name (empty: it only tightens), or null when the change touches something else (then walked key by key).
 */
function guestsChange(old: unknown, next: unknown): Array<[string, unknown, unknown]> | null {
  if ((old !== undefined && old !== null && !object(old)) || (next !== undefined && next !== null && !object(next))) return null;
  const a: Record<string, unknown> = object(old) ? old : {}, b: Record<string, unknown> = object(next) ? next : {};
  const changed = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(k => !same(a[k], b[k]));
  if (changed.some(k => !GUEST_JUDGED.includes(k))) return null;
  const out: Array<[string, unknown, unknown]> = [];
  const flag = (key: "enabled" | "chat", def: boolean) => {
    if (!changed.includes(key)) return;
    const x = a[key] ?? def, y = b[key] ?? def;
    if (typeof x !== "boolean" || typeof y !== "boolean" || (y === true && x !== true)) out.push([key, a[key], b[key]]);
  };
  flag("enabled", false); flag("chat", true);
  const lists = (v: unknown): Record<string, unknown> => (object(v) ? v : {});
  const names = (v: unknown): string[] | null => (Array.isArray(v) && v.every(n => typeof n === "string") ? v as string[] : null);
  for (const key of ["open_instances", "narrow"] as const) {
    if (!changed.includes(key)) continue;
    const x = lists(a[key]), y = lists(b[key]);
    if ((a[key] !== undefined && !object(a[key])) || (b[key] !== undefined && !object(b[key]))) { out.push([key, a[key], b[key]]); continue; }
    for (const entry of new Set([...Object.keys(x), ...Object.keys(y)])) {
      const before = Object.hasOwn(x, entry) ? x[entry] : undefined, after = Object.hasOwn(y, entry) ? y[entry] : undefined;
      if (same(before, after)) continue;
      const bn = before === undefined ? null : names(before), an = after === undefined ? null : names(after);
      if ((before !== undefined && !bn) || (after !== undefined && !an)) { out.push([`${key}.${entry}`, before, after]); continue; }
      // open_instances: more names reach more. narrow: lifting it (gone) or adding names widens; setting one narrows.
      const added = (an ?? []).some(n => !(bn ?? []).includes(n));
      const looser = key === "open_instances" ? added : (after === undefined && before !== undefined) || (before !== undefined && added);
      if (looser) out.push([`${key}.${entry}`, before, after]);
    }
  }
  // #2348: grants. Adding one, or an agent to one, widens; removing one, an agent from one, or renaming applies at once.
  // Taking the key away altogether brings the derived scope back: a widening. Adding the key (even empty) is default
  // deny for everyone it does not name.
  if (changed.includes("grants")) {
    const ga = a.grants, gb = b.grants;
    if ((ga !== undefined && !object(ga)) || (gb !== undefined && !object(gb))) out.push(["grants", ga, gb]);
    else if (ga !== undefined && gb === undefined) out.push(["grants", ga, gb]);
    else {
      const x = lists(ga), y = lists(gb);
      const grantNames = (v: unknown): string[] | null => (object(v) ? names(v.instances) : null);
      for (const entry of new Set([...Object.keys(x), ...Object.keys(y)])) {
        const before = Object.hasOwn(x, entry) ? x[entry] : undefined, after = Object.hasOwn(y, entry) ? y[entry] : undefined;
        if (same(before, after) || after === undefined) continue;                     // unchanged, or removed: narrows
        const bn = before === undefined ? [] : grantNames(before), an = grantNames(after);
        if (bn === null || an === null) { out.push([`grants.${entry}`, before, after]); continue; }   // not of its kind: never quietly
        if (an.some(n => !bn.includes(n))) out.push([`grants.${entry}`, before, after]);
      }
    }
  }
  return out;
}
const VERIFIED = ["fleet", "web", "verified_authority"] as const;
/** At the gate's root (fleet.web.verified_authority) and at the fleet's (web.verified_authority), as atGuests. */
const atVerified = (path: readonly string[]): boolean => (path.length === 3 && VERIFIED.every((k, i) => path[i] === k))
  || (path.length === 2 && path[0] === "web" && path[1] === "verified_authority");
/**
 * #1939 §0.1: web authority's keys apply at once, either way — the switch, "Only this computer can authorize" and the
 * hours grant nothing by themselves (a session still needs its account's Confirm in Discord or Telegram), so no change
 * to them waits for a confirmation. Returns [] (nothing to confirm), or null when the change touches another key (then
 * walked key by key, as everything else).
 * #2453 (§0.2): except `named_link` turned on — the one switch that lets a session reached from the internet qualify. It
 * is confirmed (a stolen session must not open the internet path by itself); off applies at once, as every narrowing.
 * §0.3: likewise `quick_link`, judged on its value as in force (explicit, else the release default): a key removed to
 * inherit is a change of value too.
 */
function verifiedAuthorityChange(old: unknown, next: unknown): Array<[string, unknown, unknown]> | null {
  if ((old !== undefined && old !== null && !object(old)) || (next !== undefined && next !== null && !object(next))) return null;
  const a: Record<string, any> = object(old) ? old : {}, b: Record<string, any> = object(next) ? next : {};
  const changed = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(k => !same(a[k], b[k]));
  if (changed.some(k => !["enabled", "loopback_only", "max_session_hours", "named_link", "quick_link"].includes(k))) return null;
  const held: Array<[string, unknown, unknown]> = [];
  if (a.named_link !== true && b.named_link === true) held.push(["named_link", a.named_link, b.named_link]);
  if (!quickLinkEffective(a) && quickLinkEffective(b)) held.push(["quick_link", a.quick_link, b.quick_link]);
  return held;
}
/** A key under a named map (an instance or connection name), not a field: its name says nothing about its kind. */
const namedEntry = (path: readonly string[], at: number): boolean => ["channels", "instances"].includes(path.at(at - 1) ?? "");
function ordinary(path: readonly string[], old: unknown, next: unknown): boolean {
  // An immediate value only exists under settings/configuration, never under access/credential/control.
  if (path.some(key => SENSITIVE_SEGMENT.test(key))) return false;
  if (namedEntry(path, -1)) return false;
  if (!scalar(old) || !scalar(next)) return false;              // an object or a list is walked, child by child
  const key = path.at(-1) ?? "", parent = path.at(-2);
  if (parent !== undefined && !namedEntry(path, -2) && immediate.has(parent)) return IMMEDIATE_CHILDREN[parent]?.has(key) ?? false;
  return immediate.has(key);
}
function plainList(path: readonly string[], old: unknown, next: unknown): boolean {
  if (!PLAIN_LISTS.has(path.at(-1) ?? "") || namedEntry(path, -1) || path.some(key => SENSITIVE_SEGMENT.test(key))) return false;
  // Only an agent's own list or the defaults' (#2346 review: never a child of an immediate key, e.g. startup.tags).
  if (!(path.at(-2) === "defaults" || path.at(-3) === "instances")) return false;
  const strings = (v: unknown): boolean => v === undefined || v === null || (Array.isArray(v) && v.every(item => typeof item === "string"));
  return strings(old) && strings(next);
}
const VISIBILITY_RANK: Readonly<Record<string, number>> = { hidden: 0, summary: 1, full: 2 };
const VISIBILITY = "cross_instance_visibility";
/** The defaults' or an agent's bot-to-bot visibility: judged by visibilityWidening, not key by key. */
const visibilityPath = (path: readonly string[]): boolean => path.at(-1) === VISIBILITY && (path.at(-2) === "defaults" || path.at(-3) === "instances");
/** The fleet in a diff's root: `{ fleet }`, or a fleet (or the part of one a caller compares) itself. */
function fleetIn(root: unknown): Record<string, any> | null {
  if (!object(root)) return null;
  return object(root.fleet) ? root.fleet : root;
}
/** What a change to bot-to-bot visibility widens, as summary lines (none: it only narrows, or leaves it). */
function visibilityWidening(before: unknown, after: unknown): string[] {
  const b = fleetIn(before), a = fleetIn(after), out: string[] = [];
  if (!a) return out;
  const valid = (v: unknown): v is string => typeof v === "string" && Object.hasOwn(VISIBILITY_RANK, v);
  const fallback = (f: Record<string, any> | null): string => (valid(f?.defaults?.[VISIBILITY]) ? f!.defaults[VISIBILITY] : "full");
  const own = (f: Record<string, any> | null, name: string): unknown => (object(f?.instances) && object(f!.instances[name]) ? f!.instances[name][VISIBILITY] : undefined);
  const effective = (f: Record<string, any> | null, name: string): string => { const v = own(f, name); return valid(v) ? v : fallback(f); };
  const line = (label: string, from: string, to: string) => out.push(`${settingsDisplay(label)}: ${settingsDisplay(from)} → ${settingsDisplay(to)}`);
  // A value the validator would refuse is never applied quietly (the resolver would read it as unset).
  // An agent whose own setting changed is named on its own line; the agents a wider default opens up only through
  // inheritance are counted on the default's line (#2346 review: one line each would pass SETTINGS_DIFF_RECORDS).
  const inheritors: string[] = [];
  for (const name of Object.keys(object(a.instances) ? a.instances : {})) {
    if (!b || !object(b.instances) || !object(b.instances[name])) continue;          // a new agent is confirmed whole
    const raw = own(a, name), ownChanged = !same(raw, own(b, name));
    if (raw !== undefined && raw !== null && !valid(raw) && ownChanged) { line(`instances.${name}.${VISIBILITY}`, String(own(b, name) ?? t("settings_confirm.summary.default")), String(raw)); continue; }
    if (VISIBILITY_RANK[effective(a, name)]! <= VISIBILITY_RANK[effective(b, name)]!) continue;
    if (ownChanged) line(t("settings_confirm.summary.in_effect", `instances.${name}.${VISIBILITY}`), effective(b, name), effective(a, name));
    else inheritors.push(name);
  }
  const rawDefault = object(a.defaults) ? a.defaults[VISIBILITY] : undefined, wasDefault = object(b?.defaults) ? b!.defaults[VISIBILITY] : undefined;
  const shown = 5, more = inheritors.length > shown ? t("settings_confirm.summary.more", inheritors.length - shown) : "";
  const who = inheritors.length ? `${t("settings_confirm.summary.inherit", inheritors.length, settingsDisplay(inheritors.slice(0, shown).join(", ")))}${more}` : "";
  if (rawDefault !== undefined && rawDefault !== null && !valid(rawDefault) && !same(rawDefault, wasDefault)) out.unshift(`${settingsDisplay(`defaults.${VISIBILITY}`)}: ${settingsDisplay(String(wasDefault ?? t("settings_confirm.summary.default")))} → ${settingsDisplay(String(rawDefault))}${who}`);
  else if (VISIBILITY_RANK[fallback(a)]! > VISIBILITY_RANK[fallback(b)]! || inheritors.length) {
    out.unshift(`${settingsDisplay(t("settings_confirm.summary.in_effect", `defaults.${VISIBILITY}`))}: ${settingsDisplay(fallback(b))} → ${settingsDisplay(fallback(a))}${who}`);
  }
  return out;
}
const DASHBOARD = "dashboard";
/** The defaults' or an agent's dashboard switches, whole or one feature: judged by dashboardWidening, not key by key. */
const dashboardPath = (path: readonly string[]): boolean =>
  (path.at(-1) === DASHBOARD && (path.at(-2) === "defaults" || path.at(-3) === "instances"))
  || (path.at(-2) === DASHBOARD && (path.at(-3) === "defaults" || path.at(-4) === "instances"));
/**
 * What a change to the dashboard switches (dashboard-permissions.ts) opens up, as summary lines (none: it only switches
 * features off, or leaves them). Judged as what each agent gets per feature — its own value, else the default's, else
 * allowed — as bot-to-bot visibility is: switching off applies directly; switching on (or a value the validator would
 * refuse) waits for the confirmation.
 */
function dashboardWidening(before: unknown, after: unknown): string[] {
  const b = fleetIn(before), a = fleetIn(after), out: string[] = [];
  if (!a) return out;
  const switches = (v: unknown): Record<string, unknown> => (object(v) ? v : {});
  const features = new Set<string>(DASHBOARD_FEATURES);
  for (const f of [a, b]) {
    for (const k of Object.keys(switches(f?.defaults?.[DASHBOARD]))) features.add(k);
    for (const inst of Object.values(object(f?.instances) ? f!.instances : {})) for (const k of Object.keys(switches(object(inst) ? inst[DASHBOARD] : undefined))) features.add(k);
  }
  const fallback = (f: Record<string, any> | null, feature: string): unknown => switches(f?.defaults?.[DASHBOARD])[feature];
  const own = (f: Record<string, any> | null, name: string, feature: string): unknown => (object(f?.instances) && object(f!.instances[name]) ? switches(f!.instances[name][DASHBOARD])[feature] : undefined);
  const on = (v: unknown, inherited: boolean): boolean => (typeof v === "boolean" ? v : inherited);
  const line = (label: string, from: unknown, to: unknown) => out.push(`${settingsDisplay(label)}: ${settingsDisplay(from)} → ${settingsDisplay(to)}`);
  // A value the validator would refuse (not a boolean, or no such feature) is never applied quietly.
  const odd = (v: unknown, feature: string) => v !== undefined && v !== null && (typeof v !== "boolean" || !(DASHBOARD_FEATURES as readonly string[]).includes(feature));
  for (const feature of features) {
    const defA = fallback(a, feature), defB = fallback(b, feature);
    const inheritors: string[] = [];
    for (const name of Object.keys(object(a.instances) ? a.instances : {})) {
      if (!b || !object(b.instances) || !object(b.instances[name])) continue;          // a new agent is confirmed whole
      const raw = own(a, name, feature), ownChanged = !same(raw, own(b, name, feature));
      if (ownChanged && odd(raw, feature)) { line(`instances.${name}.${DASHBOARD}.${feature}`, own(b, name, feature) ?? "default", raw); continue; }
      const was = on(own(b, name, feature), on(defB, true)), now = on(raw, on(defA, true));
      if (was || !now) continue;
      if (ownChanged) line(`instances.${name}.${DASHBOARD}.${feature} (in effect)`, false, true);
      else inheritors.push(name);
    }
    const shown = 5, more = inheritors.length > shown ? ` +${inheritors.length - shown} more` : "";
    const who = inheritors.length ? ` — ${inheritors.length} agent(s) inherit it: ${settingsDisplay(inheritors.slice(0, shown).join(", "))}${more}` : "";
    if (odd(defA, feature) && !same(defA, defB)) out.unshift(`${settingsDisplay(`defaults.${DASHBOARD}.${feature}`)}: ${settingsDisplay(defB ?? "default")} → ${settingsDisplay(defA)}${who}`);
    else if ((on(defA, true) && !on(defB, true)) || inheritors.length) out.unshift(`${settingsDisplay(`defaults.${DASHBOARD}.${feature} (in effect)`)}: ${settingsDisplay(on(defB, true))} → ${settingsDisplay(on(defA, true))}${who}`);
  }
  return out;
}
/** A child of an immediate key that is not one of its known children (see IMMEDIATE_CHILDREN). */
function unknownImmediateChild(path: readonly string[]): boolean {
  const key = path.at(-1), parent = path.at(-2);
  if (key === undefined || parent === undefined || namedEntry(path, -2) || !immediate.has(parent)) return false;
  return !(IMMEDIATE_CHILDREN[parent]?.has(key) ?? false);
}
export interface SettingsChangeDiff {
  section: SettingsChangeSection;
  summary: readonly string[];
  fingerprint: string;
  affectedConnections: readonly string[];
  /** Private normalized effect scope, populated by prepareSettingsEffect. */
  authority?: SettingsChangeAuthority;
  /**
   * #2453 (§0.2): the effect turns `web.verified_authority.named_link` on — never confirmed by the asking session itself
   * (#2170), whatever else the change holds. Judged from the config before and after (prepareSettingsEffect), never the body.
   */
  noSelfConfirm?: true;
}
/** Compare the entire normalized effect, including removals and primary/order. */
export function settingsChangeDiff(before: unknown, after: unknown, options: {
  operation: string; force?: boolean; secret?: { key: string; before?: string; after: string };
}): SettingsChangeDiff | null {
  const summary: string[] = []; const affected = new Set<string>();
  let section: SettingsChangeSection = options.secret ? "secret" : "channel";
  const add = (line: string): void => {
    summary.push(line);
    if (summary.length > SETTINGS_DIFF_RECORDS || summary.join("\n").length > SETTINGS_DIFF_UNITS)
      throw new SettingsConfirmationError(413, "confirmation_diff_too_large");
  };
  const walk = (old: unknown, next: unknown, path: string[]): void => {
    if (same(old, next)) return;
    // An agent deleted whole is one line: its fields go with it — nothing in it is set or shown — so none of them is
    // classified. Walking them refused every agent with a free-text or unknown field (a description, a display name),
    // and an agent could not be deleted from Settings at all.
    if (path.at(-2) === "instances" && old !== undefined && next === undefined) { add(`${settingsDisplay(path.join("."))}: deleted`); return; }
    if (path.length === SESSION_LOCAL.length && SESSION_LOCAL.every((k, i) => path[i] === k)) {
      const looser = sessionChange(old, next);
      if (looser) {
        if (looser.length && section !== "secret") section = "access";
        for (const [key, a, b] of looser) add(`${settingsDisplay([...path, key].join("."))}: ${settingsDisplay(a ?? "default")} → ${settingsDisplay(b ?? "default")}`);
        return;
      }
    }
    if (atVerified(path)) {
      const looser = verifiedAuthorityChange(old, next);
      if (looser) {
        if (looser.length && section !== "secret") section = "access";
        for (const [key, a, b] of looser) add(`${settingsDisplay([...path, key].join("."))}: ${settingsDisplay(a ?? "default")} → ${settingsDisplay(b ?? "default")}`);
        return;
      }
    }
    if (atGuests(path)) {
      const looser = guestsChange(old, next);
      if (looser) {
        if (looser.length && section !== "secret") section = "access";
        for (const [key, a, b] of looser) add(`${settingsDisplay([...path, key].join("."))}: ${settingsDisplay(a ?? "default")} → ${settingsDisplay(b ?? "default")}`);
        return;
      }
    }
    const direction = loosens(path, old, next);
    if (direction === false) return;                             // #1620: tightening applies directly
    if (direction === true) { section = section === "secret" ? section : "access"; add(`${settingsDisplay(path.join("."))}: ${settingsDisplay(old ?? "default")} → ${settingsDisplay(next ?? "default")}`); return; }
    if (visibilityPath(path)) return;                                // judged as a whole, by direction (below)
    if (dashboardPath(path)) return;                                 // likewise: the dashboard switches, by direction
    if (ordinary(path, old, next) || plainList(path, old, next)) return;
    if (path.some(key => /access|permission|admin/i.test(key)) && section !== "secret") section = "access";
    const key = path.at(-1) ?? "configuration", label = settingsDisplay(path.join("."));
    // Under an immediate key, only its known children are settings; a secret or an id list is still confirmed below.
    if (unknownImmediateChild(path) && !SETTINGS_SECRET_KEY.test(key) && !idLists.has(key)) throw new SettingsConfirmationError(400, "unsupported_sensitive_effect");
    if (SETTINGS_SECRET_KEY.test(key)) { section = "secret"; add(`${label}: ${t("settings_confirm.summary.fingerprint")} ${fingerprint(old)} → ${fingerprint(next)}`); return; }
    if (idLists.has(key)) {
      section = "access";
      if ((old !== undefined && !Array.isArray(old)) || (next !== undefined && !Array.isArray(next))) {
        add(`${label}: ${settingsDisplay(old)} → ${settingsDisplay(next)}`); return;
      }
      const a = (old ?? []) as unknown[], b = (next ?? []) as unknown[];
      if ([...a, ...b].some(id => typeof id !== "string" && (typeof id !== "number" || !Number.isSafeInteger(id))))
        throw new SettingsConfirmationError(400, "unsupported_sensitive_identity");
      const role = key === "admin_users" ? path.includes("classic") ? "Classic admin (C)" : "fleet admin (F)" : key === "allowed_users" ? path.includes("access") && !path.includes("classic") ? "fleet admin (F)" : "user" : key === "allowed_groups" ? "group" : "guild";
      for (const id of a) if (!b.some(candidate => same(candidate, id))) add(`${label}: remove ${role} ID ${settingsDisplay(id)}`);
      for (const id of b) if (!a.some(candidate => same(candidate, id))) add(`${label}: add ${role} ID ${settingsDisplay(id)}`);
      if (!same(a, b) && a.length === b.length && a.every(id => b.some(candidate => same(candidate, id)))) add(`${label}: order ${settingsDisplay(a)} → ${settingsDisplay(b)}`);
      if (next === undefined) add(`${label}: field removed (inherit/omitted policy)`);
      return;
    }
    if (path.at(-1) === "channels" && (Array.isArray(old) || Array.isArray(next))) {
      const a = Array.isArray(old) ? old : [], b = Array.isArray(next) ? next : [];
      const identity = (item: any, index: number): string => String(item?.id ?? item?.type ?? `channel-${index}`);
      const aIds = a.map(identity), bIds = b.map(identity);
      if (!same(aIds, bIds)) add(`${label}: ordered connections / primary ${settingsDisplay(aIds)} → ${settingsDisplay(bIds)}`);
      for (const id of new Set([...aIds, ...bIds])) {
        const previous = a[aIds.indexOf(id)], candidate = b[bIds.indexOf(id)];
        const start = summary.length;
        if (!previous || !candidate) add(`${label}: ${candidate ? "add" : "remove"} connection ${settingsDisplay(id)}`);
        walk(previous, candidate, [...path, id]);
        if (summary.length !== start) affected.add(id);
      }
      return;
    }
    if (object(old) || object(next)) {
      if (old !== undefined && old !== null && !object(old) || next !== undefined && next !== null && !object(next)) {
        throw new SettingsConfirmationError(400, "unsupported_sensitive_effect");
      }
      const a = object(old) ? old : {}, b = object(next) ? next : {};
      for (const child of new Set([...Object.keys(a), ...Object.keys(b)])) walk(Object.hasOwn(a, child) ? a[child] : undefined, Object.hasOwn(b, child) ? b[child] : undefined, [...path, child]);
      return;
    }
    // Unknown nested structures cannot disappear into an ordinary PATCH or opaque count.
    if (Array.isArray(old) || Array.isArray(next)) {
      if ([...(Array.isArray(old) ? old : []), ...(Array.isArray(next) ? next : [])].some(object))
        throw new SettingsConfirmationError(400, "unsupported_sensitive_effect");
      // An unknown string array can contain credentials just like an unknown
      // scalar. Only schema-owned public fields may reveal its actual values.
      if (!publicKeys.has(key)) throw new SettingsConfirmationError(400, "unsupported_sensitive_effect");
    }
    if ((typeof old === "string" || typeof next === "string") && !publicKeys.has(key))
      throw new SettingsConfirmationError(400, "unsupported_sensitive_effect");
    add(`${label}: ${settingsDisplay(old)} → ${settingsDisplay(next)}`);
  };
  if (options.secret) add(`${settingsDisplay(options.secret.key)}: ${t("settings_confirm.summary.fingerprint")} ${fingerprint(options.secret.before)} → ${fingerprint(options.secret.after)}`);
  walk(before, after, []);
  // #2346 review: bot-to-bot visibility decides what an agent's topic, the dashboard's search and the public link's board
  // show of it. Judged as the mode each agent gets (its own, else the default, else full) and the default's own (it covers
  // every name with no setting): narrowing applies directly; widening — or a value the validator would refuse — waits.
  const widened = visibilityWidening(before, after);
  if (widened.length && section !== "secret") section = "access";
  for (const line of widened) add(line);
  // The dashboard switches the same way: switching a feature off applies directly; switching one on waits.
  const opened = dashboardWidening(before, after);
  if (opened.length && section !== "secret") section = "access";
  for (const line of opened) add(line);
  if (!summary.length && options.force) add(`${settingsDisplay(options.operation)}: confirmed operation`);
  if (!summary.length) return null;
  summary.unshift(settingsDisplay(options.operation));
  if (summary.length > SETTINGS_DIFF_RECORDS || summary.join("\n").length > SETTINGS_DIFF_UNITS) throw new SettingsConfirmationError(413, "confirmation_diff_too_large");
  return { section, summary, fingerprint: settingsFingerprint([options.operation, before, after, options.secret]), affectedConnections: [...affected] };
}
