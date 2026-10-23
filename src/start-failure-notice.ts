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
