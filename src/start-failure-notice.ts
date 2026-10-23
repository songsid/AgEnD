/**
 * #2481: the words for a fleet that fails to start after an upgrade — every `agend` command's banner and `agend doctor`.
 * What to run to go back, and where the error is; never a restore of its own.
 */
import { join } from "node:path";
import { t } from "./locale.js";
import type { StartFailure } from "./start-failure.js";

export function startFailureLines(failure: Extract<StartFailure, { failing: true }>, home: string): string[] {
  const lines = [t("startfail.banner", failure.version, failure.detail)];
  if (failure.previous) {
    lines.push(t("startfail.back", failure.previous.version));
    if (failure.previous.copy) lines.push(t("startfail.copy", failure.previous.version, failure.previous.copy));
  } else {
    lines.push(t("startfail.back_unknown"));
  }
  lines.push(t("startfail.report", join(home, "fleet.log")));
  return lines;
}

/** #2481 auto-restore: the words for a version the fleet is rolling back from by itself (chat notice). */
export function restoredLines(from: string, to: string, detail: string, preimage: string, home: string): string[] {
  return [t("startfail.restored_banner", from, detail, to, preimage), t("startfail.restored_data", from, to), t("startfail.report", join(home, "fleet.log"))];
}

/** #2481 auto-restore that failed: the correction, with the way back by hand. */
export function restoreFailedLines(from: string, to: string, detail: string, reason: string, home: string): string[] {
  return [t("startfail.restore_failed_banner", from, detail, to, reason), t("startfail.back", to), t("startfail.report", join(home, "fleet.log"))];
}
