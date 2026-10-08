import { SettingsConfirmationError } from "./settings-confirmation.js";
export const NULLABLE_INSTANCE_OVERRIDES = new Set(["model", "auto_pause_after", "hang_detector", "agent_mode", "tool_set", "tool_progress", "reply_completion_guard", "log_level", "lightweight", "model_failover", "display_name", "status_emojis", "cross_instance_visibility"]);
export function removesInstanceOverride(key: string, value: unknown): boolean {
  return NULLABLE_INSTANCE_OVERRIDES.has(key) && (value === null || key === "model" && typeof value === "string" && value.trim() === "");
}
/** Projection and persistence share exactly the same null/inheritance rules. */
export function normalizeSettingsInstancePatch(base: Record<string, any>, patch: Record<string, any>): Record<string, any> {
  for (const [key, value] of Object.entries(patch)) if (value === null && !NULLABLE_INSTANCE_OVERRIDES.has(key)) throw new SettingsConfirmationError(400, "unsupported_instance_null");
  const next = { ...base, ...patch };
  if (patch.hang_detector && typeof patch.hang_detector === "object" && !Array.isArray(patch.hang_detector)) {
    const hang = { ...base.hang_detector, ...patch.hang_detector };
    if (patch.hang_detector.timeout_minutes === null) delete hang.timeout_minutes;
    if (Object.keys(hang).length) next.hang_detector = hang; else delete next.hang_detector;
  }
  for (const key of NULLABLE_INSTANCE_OVERRIDES) if (removesInstanceOverride(key, patch[key])) delete next[key];
  return next;
}
