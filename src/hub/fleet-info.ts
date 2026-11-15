/** Pure wire reporting model; no identity, persistence or connection dependencies. */
import { z } from "zod";
import { isExactVersion } from "../update-check.js";
/** Hub-only offer: members do not add another name to their 16-name hello. */
export const HUB_FLEET_INFO_CAPABILITY = "fleet-info-v1";
export const fleetInfoSchema = z.strictObject({ version: z.string().min(1).max(128).refine(v => v === v.trim() && isExactVersion(v)), runsAsService: z.boolean(), recommendations: z.literal(true).optional() });

/** Logging diagnostics must not become a second reason to break the member link. */
export function warnFleetDiagnostics(log: ((level: "info" | "warn", message: string, meta?: Record<string, unknown>) => void) | undefined,
  fleetId: string, phase: "connect" | "report"): void {
  try { log?.("warn", "Hub Fleet diagnostics were not recorded", { fleetId, phase }); } catch { /* best effort */ }
}
