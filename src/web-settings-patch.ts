/**
 * #1620: a PUT /api/settings/fleet/web body, read the same way by the confirmation gate's projection
 * (settings-effect.ts) and by the handler (settings-api.ts) — so the gate never proposes what the handler would refuse,
 * a read-only web field included (#1627 review). `null` puts a value back to its default (the key leaves fleet.yaml);
 * null overall = nothing to change. The session hours' bounds are the validator's, run on the whole result; the
 * terminal's minutes are checked here (the loader clamps an out-of-range value to 1..20, so the validator never sees
 * one — Settings must not write one).
 */
import { validPublicLinkPatch } from "./public-web-link.js";
import type { WebConfig } from "./types.js";

export const WEB_TERMINAL_TTL_MINUTES = { min: 1, max: 20 } as const;
/** What Settings → Web may write; everything else under web: / web_terminal: is fleet.yaml's. */
export const WEB_SETTINGS_BODY_KEYS = ["echo_to_channel", "log_tab", "public_link", "session", "web_terminal"] as const;

export type WebSettingsBody = {
  echo?: boolean;
  /** #1218: the Log tab on (true) or off (false). */
  logTab?: boolean;
  publicLink?: NonNullable<WebConfig["public_link"]>;
  session: Record<string, number | null> | null;
  terminal: Record<string, boolean | number | null> | null;
};
/** The whole body, or what is wrong with it (the handler's 400 message). */
export function parseWebSettingsBody(body: unknown): WebSettingsBody | { error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)
    || Object.keys(body).some(key => !(WEB_SETTINGS_BODY_KEYS as readonly string[]).includes(key))) return { error: "unknown web field" };
  const patch = body as Record<string, unknown>;
  if (patch.echo_to_channel !== undefined && typeof patch.echo_to_channel !== "boolean") return { error: "echo_to_channel must be a boolean" };
  if (patch.log_tab !== undefined && typeof patch.log_tab !== "boolean") return { error: "log_tab must be a boolean" };
  if (patch.public_link !== undefined && !validPublicLinkPatch(patch.public_link)) return { error: "invalid public_link settings" };
  const session = webSessionPatch(patch.session);
  if (session === "invalid") return { error: "session must be { local: { absolute_hours?, idle_hours? } } with numbers or null" };
  const terminal = webTerminalPatch(patch.web_terminal);
  if (terminal === "invalid") return { error: "web_terminal must be { enabled?: boolean|null, ttl_minutes?: 1..20|null }" };
  return {
    ...(patch.echo_to_channel !== undefined ? { echo: patch.echo_to_channel as boolean } : {}),
    ...(patch.log_tab !== undefined ? { logTab: patch.log_tab as boolean } : {}),
    ...(patch.public_link !== undefined ? { publicLink: patch.public_link as NonNullable<WebConfig["public_link"]> } : {}),
    session, terminal,
  };
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
