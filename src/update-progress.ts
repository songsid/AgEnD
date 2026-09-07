import { t } from "./locale.js";
import { updateProgressOperation, type UpdateMarker, type UpdateProgressStage } from "./update-marker.js";

export function updateElapsedSeconds(startedAt: number, now = Date.now()): number {
  return Math.max(0, Math.floor((now - startedAt) / 1000));
}

function stageLabel(stage: UpdateProgressStage | undefined): string {
  return t(`update.stage.${stage ?? "preparing"}`);
}

/** Render the persisted CLI-side stage while the old fleet is still alive. */
export function formatUpdateProgress(marker: UpdateMarker & { progress: NonNullable<UpdateMarker["progress"]> }, now = Date.now()): string {
  const elapsed = updateElapsedSeconds(marker.startedAt, now);
  const progress = marker.progress;
  if (updateProgressOperation(progress) === "full-restart") {
    if (progress.stage === "failed") {
      return t("restart.progress.failed", progress.error ?? "unknown error", elapsed);
    }
    if (progress.stage === "complete") {
      return t("restart.progress.complete", progress.version ?? "?", elapsed);
    }
    return progress.stage === "starting"
      ? t("restart.progress.starting", elapsed)
      : t("restart.progress.stopping", elapsed);
  }
  switch (progress.stage) {
    case "preparing":
      return t("update.progress.preparing", elapsed);
    case "downloading":
      return t("update.progress.downloading", elapsed);
    case "installed":
      return t("update.progress.installed", progress.version ?? "?", elapsed);
    case "stopping":
      return t("update.progress.stopping", elapsed);
    case "starting":
      return t("update.progress.starting", elapsed);
    case "complete":
      return t("update.progress.already_current", progress.version ?? "?", elapsed);
    case "failed":
      return t("update.progress.failed", stageLabel(progress.failedStage), progress.error ?? "unknown error", elapsed);
  }
}
