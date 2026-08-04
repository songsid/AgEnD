import type { FleetConfig } from "./types.js";

/** Stable user-facing error shared by every manual pause entry point. */
export const GENERAL_PAUSE_ERROR = "General cannot be paused";

/**
 * General is a coordinator, not an expendable worker. The literal-name fallback
 * preserves the same legacy protection already used by Daemon auto-pause while
 * general_topic covers renamed and per-world General instances.
 */
export function isGeneralInstance(config: FleetConfig | null | undefined, name: string): boolean {
  return name === "general" || config?.instances[name]?.general_topic === true;
}
