/**
 * M-2446: a per-agent Codex speed (`backend_options.codex.speed`), as launch flags. Unset launches as before.
 *  - "fast"     → `-c service_tier="fast" -c features.fast_mode=true`, only when the catalog entry of the model that
 *                 will run advertises the "priority" tier (Codex's Fast). Codex sends `service_tier: "priority"` then
 *                 (verified on 0.165.0 against a mock Responses API). Otherwise no flag and a quiet note: codex would
 *                 drop the tier itself with a warning row, and an unproven model may not take it.
 *  - "standard" → `-c service_tier="default"`: no tier on the wire, overriding a Fast default saved by `/fast`.
 * Codex accepts any string here and silently omits an unknown one, so the value is allow-listed (here and in
 * config-validator.ts). Fast uses ChatGPT plan limits at 2.5× the Standard rate (OpenAI's Codex Speed page).
 */
import { t } from "../locale.js";
import { shellQuote } from "./types.js";

export const CODEX_SPEEDS = ["fast", "standard"] as const;
export type CodexSpeed = typeof CODEX_SPEEDS[number];
/** The catalog's id for Codex's Fast tier. */
export const CODEX_FAST_TIER = "priority";

export function isCodexSpeed(value: unknown): value is CodexSpeed {
  return typeof value === "string" && (CODEX_SPEEDS as readonly string[]).includes(value);
}

/** The flags to append (with a leading space) for the configured speed, or why none (a quiet launch note). */
export function codexSpeed(
  speed: unknown, catalog: { model: string | null; tiers: string[] | null; unproven?: boolean },
): { arg: string | null; note: string | null } {
  if (speed === undefined || speed === null || speed === "") return { arg: null, note: null };
  if (!isCodexSpeed(speed)) return { arg: null, note: t("codex.speed_skipped", String(speed), t("codex.speed_not_a_speed", CODEX_SPEEDS.join(", "))) };
  if (speed === "standard") return { arg: ` -c ${shellQuote(`service_tier="default"`)}`, note: null };
  if (catalog.unproven) return { arg: null, note: t("codex.speed_skipped", speed, t("effort.launch_codex_model_unproven")) };
  if (!catalog.tiers) return { arg: null, note: t("codex.speed_skipped", speed, t("codex.speed_unknown_model", catalog.model ?? "—")) };
  if (!catalog.tiers.includes(CODEX_FAST_TIER)) return { arg: null, note: t("codex.speed_skipped", speed, t("codex.speed_not_offered", catalog.model ?? "—")) };
  return { arg: ` -c ${shellQuote(`service_tier="fast"`)} -c features.fast_mode=true`, note: null };
}
