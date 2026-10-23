/**
 * #1620: a PUT /api/settings/fleet/web body, read the same way by the confirmation gate's projection
 * (settings-effect.ts) and by the handler (settings-api.ts) — so the gate never proposes what the handler would refuse,
 * a read-only web field included (#1627 review). `null` puts a value back to its default (the key leaves fleet.yaml);
 * null overall = nothing to change. The session hours' bounds are the validator's, run on the whole result; the
 * terminal's minutes are checked here (the loader clamps an out-of-range value to 1..20, so the validator never sees
 * one — Settings must not write one).
 */
import { publicLinkPatchShape } from "./public-web-link.js";
import type { WebConfig, WebGuestsConfig, WebVerifiedAuthorityConfig } from "./types.js";

export const WEB_TERMINAL_TTL_MINUTES = { min: 1, max: 20 } as const;
/** What Settings → Web may write; everything else under web: / web_terminal: is fleet.yaml's. */
export const WEB_SETTINGS_BODY_KEYS = ["experimental", "echo_to_channel", "log_tab", "usage_report_on_public_link", "public_link", "session", "web_terminal", "guests", "verified_authority"] as const;

export type WebSettingsBody = {
  canvasWorker?: boolean;
  echo?: boolean;
  /** #1218: the Log tab on (true) or off (false). */
  logTab?: boolean;
  /** #2122: the usage report over the temporary public link (web.usage_report_on_public_link). */
  usageOnPublicLink?: boolean;
  publicLink?: NonNullable<WebConfig["public_link"]>;
  session: Record<string, number | null> | null;
  terminal: Record<string, boolean | number | null> | null;
  /** #1920 phase 3: guest sign-in (Settings → Web sign-ins → Guests). */
  guests?: GuestsPatch;
  /** #1939 S2a: web authority (Settings → Web → Web authority). */
  verifiedAuthority?: VerifiedAuthorityPatch;
};
/** The whole body, or what is wrong with it (the handler's 400 message). */
export function parseWebSettingsBody(body: unknown): WebSettingsBody | { error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)
    || Object.keys(body).some(key => !(WEB_SETTINGS_BODY_KEYS as readonly string[]).includes(key))) return { error: "unknown web field" };
  const patch = body as Record<string, unknown>;
  if (patch.echo_to_channel !== undefined && typeof patch.echo_to_channel !== "boolean") return { error: "echo_to_channel must be a boolean" };
  if (patch.log_tab !== undefined && typeof patch.log_tab !== "boolean") return { error: "log_tab must be a boolean" };
  if (patch.usage_report_on_public_link !== undefined && typeof patch.usage_report_on_public_link !== "boolean") return { error: "usage_report_on_public_link must be a boolean" };
  // Its shape only: whether the merged result fits its mode (a quick tunnel's 1..480, auto_open only with a hostname) is
  // the validator's, run on the whole result by the gate's projection and by the handler.
  if (patch.public_link !== undefined && !publicLinkPatchShape(patch.public_link)) return { error: "invalid public_link settings" };
  if (patch.experimental !== undefined && (!patch.experimental || typeof patch.experimental !== "object" || Array.isArray(patch.experimental)
    || Object.keys(patch.experimental).some(k => k !== "canvas_worker") || typeof (patch.experimental as Record<string, unknown>).canvas_worker !== "boolean")) return { error: "experimental must be { canvas_worker: boolean }" };
  const session = webSessionPatch(patch.session);
  if (session === "invalid") return { error: "session must be { local: { absolute_hours?, idle_hours? } } with numbers or null" };
  const terminal = webTerminalPatch(patch.web_terminal);
  if (terminal === "invalid") return { error: "web_terminal must be { enabled?: boolean|null, ttl_minutes?: 1..20|null }" };
  const guests = guestsPatch(patch.guests);
  if (guests === "invalid") return { error: "guests must be { enabled?, chat?: boolean|null, open_instances?: { <connection>: [instance…]|null }, narrow?: { \"<connection>:<user>\": [instance…]|null } }" };
  const verifiedAuthority = verifiedAuthorityPatch(patch.verified_authority);
  if (verifiedAuthority === "invalid") return { error: "verified_authority must be { enabled?, loopback_only?: boolean|null, max_session_hours?: number|null }" };
  return {
    ...(patch.echo_to_channel !== undefined ? { echo: patch.echo_to_channel as boolean } : {}),
    ...(patch.log_tab !== undefined ? { logTab: patch.log_tab as boolean } : {}),
    ...(patch.usage_report_on_public_link !== undefined ? { usageOnPublicLink: patch.usage_report_on_public_link as boolean } : {}),
    ...(patch.public_link !== undefined ? { publicLink: patch.public_link as NonNullable<WebConfig["public_link"]> } : {}),
    ...(guests ? { guests } : {}),
    ...(verifiedAuthority ? { verifiedAuthority } : {}),
    ...(patch.experimental !== undefined ? { canvasWorker: (patch.experimental as { canvas_worker: boolean }).canvas_worker } : {}),
    session, terminal,
  };
}

/**
 * #1920 phase 3: `guests` — `{ enabled?, chat?: boolean | null, open_instances?: { <connection id>: [instance…] | null },
 * narrow?: { "<connection id>:<user id>": [instance…] | null } }`; null = back to the default (the key leaves fleet.yaml).
 * The session limits stay fleet.yaml's. Names are checked for shape here; the validator judges the whole result.
 */
export type GuestsPatch = {
  enabled?: boolean | null;
  chat?: boolean | null;
  open_instances?: Record<string, string[] | null>;
  narrow?: Record<string, string[] | null>;
};
const GUEST_LIST_MAX = 200;
function guestList(v: unknown): string[] | null | "invalid" {
  if (v === null) return null;
  if (!Array.isArray(v) || v.length > GUEST_LIST_MAX || v.some((n) => typeof n !== "string" || !n || n.length > 128) || new Set(v).size !== v.length) return "invalid";
  return [...v] as string[];
}
function guestMap(v: unknown, key: RegExp): Record<string, string[] | null> | null | "invalid" {
  if (v === undefined) return null;
  if (!v || typeof v !== "object" || Array.isArray(v)) return "invalid";
  const out: Record<string, string[] | null> = Object.create(null);
  for (const [k, raw] of Object.entries(v)) {
    if (!key.test(k)) return "invalid";
    const list = guestList(raw);
    if (list === "invalid") return "invalid";
    out[k] = list;
  }
  return Object.keys(out).length ? out : null;
}
export function guestsPatch(raw: unknown): GuestsPatch | null | "invalid" {
  if (raw === undefined) return null;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "invalid";
  const out: GuestsPatch = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k === "enabled" || k === "chat") { if (v !== null && typeof v !== "boolean") return "invalid"; out[k] = v as boolean | null; continue; }
    if (k === "open_instances" || k === "narrow") {
      const map = guestMap(v, k === "narrow" ? /^[A-Za-z0-9_.-]{1,64}:[0-9A-Za-z_-]{1,64}$/ : /^[A-Za-z0-9_.-]{1,64}$/);
      if (map === "invalid") return "invalid";
      if (map) out[k] = map;
      continue;
    }
    return "invalid";
  }
  return Object.keys(out).length ? out : null;
}
/** `web.guests` after a patch (a copy; null removes; an emptied map leaves; nothing left: undefined), and the file edits. */
export function applyGuestsPatch(current: WebGuestsConfig | undefined, patch: GuestsPatch):
  { next: WebGuestsConfig | undefined; changes: Array<{ path: string[]; value: unknown; remove?: true }> } {
  const next: WebGuestsConfig = { ...current };
  const changes: Array<{ path: string[]; value: unknown; remove?: true }> = [];
  for (const key of ["enabled", "chat"] as const) {
    if (!(key in patch)) continue;
    const v = patch[key];
    if (v === null || v === undefined) { delete next[key]; changes.push({ path: ["web", "guests", key], value: undefined, remove: true }); }
    else { next[key] = v; changes.push({ path: ["web", "guests", key], value: v }); }
  }
  for (const key of ["open_instances", "narrow"] as const) {
    const map = patch[key];
    if (!map) continue;
    // Keyed by name (a connection, an account): own keys only, never a prototype's.
    const merged: Record<string, string[]> = Object.create(null);
    for (const [k, list] of Object.entries(current?.[key] ?? {})) merged[k] = list;
    for (const [k, list] of Object.entries(map)) {
      if (list === null) { delete merged[k]; changes.push({ path: ["web", "guests", key, k], value: undefined, remove: true }); }
      else { merged[k] = list; changes.push({ path: ["web", "guests", key, k], value: list }); }
    }
    if (Object.keys(merged).length) next[key] = { ...merged }; else delete next[key];
  }
  return { next: Object.keys(next).length ? next : undefined, changes };
}

/**
 * #1939 S2a: `verified_authority` — `{ enabled?, loopback_only?: boolean | null, max_session_hours?: number | null }`; null
 * = back to the default (the key leaves fleet.yaml). The validator judges the hours' bounds; settings-change.ts which
 * change loosens it.
 */
export type VerifiedAuthorityPatch = {
  enabled?: boolean | null;
  loopback_only?: boolean | null;
  max_session_hours?: number | null;
  named_link?: boolean | null;
  quick_link?: boolean | null;
};
export function verifiedAuthorityPatch(raw: unknown): VerifiedAuthorityPatch | null | "invalid" {
  if (raw === undefined) return null;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "invalid";
  const out: VerifiedAuthorityPatch = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k === "enabled" || k === "loopback_only" || k === "named_link" || k === "quick_link") { if (v !== null && typeof v !== "boolean") return "invalid"; out[k] = v as boolean | null; continue; }
    if (k === "max_session_hours") { if (v !== null && !(typeof v === "number" && Number.isFinite(v))) return "invalid"; out[k] = v as number | null; continue; }
    return "invalid";
  }
  return Object.keys(out).length ? out : null;
}
/** `web.verified_authority` after a patch (a copy; null removes; nothing left: undefined), and the file edits. */
export function applyVerifiedAuthorityPatch(current: WebVerifiedAuthorityConfig | undefined, patch: VerifiedAuthorityPatch):
  { next: WebVerifiedAuthorityConfig | undefined; changes: Array<{ path: string[]; value: unknown; remove?: true }> } {
  const next: WebVerifiedAuthorityConfig = { ...current };
  const changes: Array<{ path: string[]; value: unknown; remove?: true }> = [];
  for (const key of ["enabled", "loopback_only", "max_session_hours", "named_link", "quick_link"] as const) {
    if (!(key in patch)) continue;
    const v = patch[key];
    if (v === null || v === undefined) { delete next[key]; changes.push({ path: ["web", "verified_authority", key], value: undefined, remove: true }); }
    else { (next as Record<string, unknown>)[key] = v; changes.push({ path: ["web", "verified_authority", key], value: v }); }
  }
  return { next: Object.keys(next).length ? next : undefined, changes };
}

/** `session`: `{ local: { absolute_hours?, idle_hours? } }` with numbers or null — the local limits only. */
export function webSessionPatch(raw: unknown): Record<string, number | null> | null | "invalid" {
  if (raw === undefined) return null;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "invalid";
  if (Object.keys(raw).some(k => k !== "local")) return "invalid";
  const local = (raw as { local?: unknown }).local;
  if (local === undefined) return null;
  if (!local || typeof local !== "object" || Array.isArray(local)) return "invalid";
  const out: Record<string, number | null> = {};
  for (const [k, v] of Object.entries(local)) {
    if ((k !== "absolute_hours" && k !== "idle_hours") || !(v === null || (typeof v === "number" && Number.isFinite(v)))) return "invalid";
    out[k] = v as number | null;
  }
  return Object.keys(out).length ? out : null;
}

/** `web_terminal`: `{ enabled?: boolean | null, ttl_minutes?: 1..20 | null }` — nothing else (bind, tunnel: fleet.yaml). */
export function webTerminalPatch(raw: unknown): Record<string, boolean | number | null> | null | "invalid" {
  if (raw === undefined) return null;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "invalid";
  const out: Record<string, boolean | number | null> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k === "enabled" && (v === null || typeof v === "boolean")) out[k] = v;
    else if (k === "ttl_minutes" && (v === null || (typeof v === "number" && Number.isInteger(v)
      && v >= WEB_TERMINAL_TTL_MINUTES.min && v <= WEB_TERMINAL_TTL_MINUTES.max))) out[k] = v;
    else return "invalid";
  }
  return Object.keys(out).length ? out : null;
}

/**
 * #1629 r4.1 Q3 (b): a PUT /api/settings/fleet/appearance body — the identity card's upload limits and the picture
 * quota, `{ portrait?: { max_width?, max_height?, max_kib? }, banner?: {…}, instance_quota?: { files?, mib? } }`, each a
 * whole number or null (back to the default). Read the same way by the confirmation gate and the handler. Bounds are
 * not checked here: the loader clamps (web-appearance-limits.ts), and a value beyond a bound is stored as written and
 * said so — Settings shows the effective value next to it.
 */
export const APPEARANCE_SETTINGS_FIELDS: Readonly<Record<string, readonly string[]>> = {
  portrait: ["max_width", "max_height", "max_kib"],
  banner: ["max_width", "max_height", "max_kib"],
  instance_quota: ["files", "mib"],
};
export type AppearanceSettingsChange = { group: string; key: string; value: number | null };
export function parseAppearanceSettingsBody(body: unknown): AppearanceSettingsChange[] | { error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "expected an object" };
  const changes: AppearanceSettingsChange[] = [];
  for (const [group, raw] of Object.entries(body)) {
    const fields = Object.hasOwn(APPEARANCE_SETTINGS_FIELDS, group) ? APPEARANCE_SETTINGS_FIELDS[group]! : null;
    if (!fields) return { error: `unknown appearance field: ${group}` };
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: `${group} must be an object` };
    for (const [key, value] of Object.entries(raw)) {
      if (!fields.includes(key)) return { error: `unknown appearance field: ${group}.${key}` };
      if (value !== null && !(typeof value === "number" && Number.isSafeInteger(value) && value > 0)) return { error: `${group}.${key} must be a whole number or null` };
      changes.push({ group, key, value: value as number | null });
    }
  }
  return changes;
}

/** `web.appearance` after `changes` (a copy; a key set to null leaves, an emptied group leaves; nothing left: undefined). */
export function applyAppearanceChanges(current: unknown, changes: readonly AppearanceSettingsChange[]): Record<string, Record<string, number>> | undefined {
  const out: Record<string, Record<string, number>> = {};
  if (current && typeof current === "object" && !Array.isArray(current)) {
    for (const [g, v] of Object.entries(current)) if (v && typeof v === "object" && !Array.isArray(v)) out[g] = { ...(v as Record<string, number>) };
  }
  for (const c of changes) {
    const group = (out[c.group] ??= {});
    if (c.value === null) delete group[c.key]; else group[c.key] = c.value;
    if (!Object.keys(group).length) delete out[c.group];
  }
  return Object.keys(out).length ? out : undefined;
}
