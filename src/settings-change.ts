import { createHash } from "node:crypto";
import { SettingsConfirmationError, type SettingsChangeSection } from "./settings-confirmation.js";
import { settingsFingerprint } from "./settings-transaction.js";
import { STATUS_EMOJI_CONFIG_KEYS } from "./status-emojis.js";
import type { SettingsChangeAuthority } from "./settings-authority.js";

export const SETTINGS_DIFF_RECORDS = 32;
export const SETTINGS_DIFF_UNITS = 4096;
const immediate = new Set([
  "backend", "model", "effort", "thinking", "thinking_level", "display_name", "name", "description", "locale",
  "tips", "tips_enabled", "auto_pause_after", "context_lines", "tool_progress", "reply_completion_guard", "web_echo",
  "echo_to_channel", "status_emojis", "persona", "emoji", "hang_detector", "guardian", "watchdog", "timeout_minutes",
  "enabled", "startup_concurrency", "spawn_concurrency", "spawn_stagger_ms", "warm_cap", "idle_timeout",
]);
/** A config key whose value is a credential: confirmed by fingerprint, never shown (and redacted on read, #1490). */
export const SETTINGS_SECRET_KEY = /^(?:token|secret|password|api_key|bot_token|web_token)$/i;
const publicKeys = new Set(["id", "type", "group_id", "general_channel_id", "bot_token_env", "token_env", "mode",
  "working_directory", "project_roots", "adapter_id", "adapterId", "channelId", "instanceName", "createdBy", "createdAt",
  "allowed_hosts", "protocol", "name", "directory", "topic_name", "topic_id", "channel_id", "systemPrompt", "workflow", "primary", "pre_task_command", "instructions", "tool_permissions", "mcp_tools", "skip_permissions"]);
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
};
const SENSITIVE_SEGMENT = /access|permission|admin|credential|secret|public_link|mcp|auth|pre_task|instruction|project_roots/i;
const scalar = (value: unknown): boolean => value === undefined || value === null || typeof value !== "object";
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
    if (same(old, next) || ordinary(path, old, next)) return;
    if (path.some(key => /access|permission|admin/i.test(key)) && section !== "secret") section = "access";
    const key = path.at(-1) ?? "configuration", label = settingsDisplay(path.join("."));
    // Under an immediate key, only its known children are settings; a secret or an id list is still confirmed below.
    if (unknownImmediateChild(path) && !SETTINGS_SECRET_KEY.test(key) && !idLists.has(key)) throw new SettingsConfirmationError(400, "unsupported_sensitive_effect");
    if (SETTINGS_SECRET_KEY.test(key)) { section = "secret"; add(`${label}: fingerprint ${fingerprint(old)} → ${fingerprint(next)}`); return; }
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
  if (options.secret) add(`${settingsDisplay(options.secret.key)}: fingerprint ${fingerprint(options.secret.before)} → ${fingerprint(options.secret.after)}`);
  walk(before, after, []);
  if (!summary.length && options.force) add(`${settingsDisplay(options.operation)}: confirmed operation`);
  if (!summary.length) return null;
  summary.unshift(settingsDisplay(options.operation));
  if (summary.length > SETTINGS_DIFF_RECORDS || summary.join("\n").length > SETTINGS_DIFF_UNITS) throw new SettingsConfirmationError(413, "confirmation_diff_too_large");
  return { section, summary, fingerprint: settingsFingerprint([options.operation, before, after, options.secret]), affectedConnections: [...affected] };
}
