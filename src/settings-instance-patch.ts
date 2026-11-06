import { officeInputPatch } from "./dashboard-permissions.js";
import { SettingsConfirmationError } from "./settings-confirmation.js";
export const NULLABLE_INSTANCE_OVERRIDES = new Set(["model", "auto_pause_after", "hang_detector", "agent_mode", "tool_set", "tool_progress", "reply_completion_guard", "log_level", "lightweight", "model_failover", "display_name", "status_emojis", "cross_instance_visibility", "dashboard", "office_access", "office_pack_access"]);
export function removesInstanceOverride(key: string, value: unknown): boolean {
  return NULLABLE_INSTANCE_OVERRIDES.has(key) && (value === null || key === "model" && typeof value === "string" && value.trim() === "");
}
const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
/** Projection and persistence share exactly the same null/inheritance rules. */
export function normalizeSettingsInstancePatch(base: Record<string, any>, patch: Record<string, any>): Record<string, any> {
  base = officeInputPatch(base);
  patch = officeInputPatch(patch);
  for (const [key, value] of Object.entries(patch)) if (value === null && !NULLABLE_INSTANCE_OVERRIDES.has(key)) throw new SettingsConfirmationError(400, "unsupported_instance_null");
  const next = { ...base, ...patch };
  if (patch.hang_detector && typeof patch.hang_detector === "object" && !Array.isArray(patch.hang_detector)) {
    const hang = { ...base.hang_detector, ...patch.hang_detector };
    if (patch.hang_detector.timeout_minutes === null) delete hang.timeout_minutes;
    if (Object.keys(hang).length) next.hang_detector = hang; else delete next.hang_detector;
  }
  // The dashboard switches (dashboard-permissions.ts) change one feature at a time: a feature set to null follows the
  // fleet default again; none left, the key goes.
  if (patch.dashboard && typeof patch.dashboard === "object" && !Array.isArray(patch.dashboard)) {
    const own: Record<string, unknown> = { ...(base.dashboard && typeof base.dashboard === "object" ? base.dashboard : {}), ...patch.dashboard };
    for (const [k, v] of Object.entries(patch.dashboard)) if (v === null) delete own[k];
    if (Object.keys(own).length) next.dashboard = own; else delete next.dashboard;
  }
  // M-2446: backend_options merge per backend namespace (as update_instance_config does), so a Settings change to one
  // key (codex.speed) never drops another (credential_profile, provider); a key set to null goes; an empty namespace goes.
  if (patch.backend_options !== undefined) {
    if (!isPlainObject(patch.backend_options) || !Object.values(patch.backend_options).every(isPlainObject)) {
      throw new SettingsConfirmationError(400, "unsupported_backend_options");
    }
    const merged: Record<string, Record<string, unknown>> = Object.create(null);
    if (isPlainObject(base.backend_options)) for (const [b, o] of Object.entries(base.backend_options)) if (isPlainObject(o)) merged[b] = { ...o };
    for (const [b, o] of Object.entries(patch.backend_options as Record<string, Record<string, unknown>>)) {
      const ns: Record<string, unknown> = { ...(merged[b] ?? {}), ...o };
      for (const [k, v] of Object.entries(o)) if (v === null) delete ns[k];
      if (Object.keys(ns).length) merged[b] = ns; else delete merged[b];
    }
    if (Object.keys(merged).length) next.backend_options = { ...merged }; else delete next.backend_options;
  }
  for (const key of NULLABLE_INSTANCE_OVERRIDES) if (removesInstanceOverride(key, patch[key])) delete next[key];
  return next;
}
