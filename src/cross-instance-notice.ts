/**
 * #1302: how much of a bot-to-bot (cross-instance) message is posted in the instance topics.
 *
 *   full    — today's behaviour: the whole message in the sender's topic, and in the target's for task/query.
 *   summary — the same posts, each one line: the label plus the task summary or a short preview.
 *   hidden  — nothing in either topic.
 *
 * Only the topic notices change. Delivery, the Mirror Topic and the activity log never read this, and General
 * topics are skipped in every mode. Each topic follows its own instance: `instances.<name>.cross_instance_visibility`,
 * else `defaults.cross_instance_visibility`, else `full`.
 */
import type { FleetConfig } from "./types.js";
import { truncatePreview } from "./channel/markdown-chunk.js";
import { t } from "./locale.js";

export const CROSS_INSTANCE_VISIBILITY_MODES = ["full", "summary", "hidden"] as const;
export type CrossInstanceVisibility = typeof CROSS_INSTANCE_VISIBILITY_MODES[number];
export const DEFAULT_CROSS_INSTANCE_VISIBILITY: CrossInstanceVisibility = "full";

export function isCrossInstanceVisibility(value: unknown): value is CrossInstanceVisibility {
  return typeof value === "string" && (CROSS_INSTANCE_VISIBILITY_MODES as readonly string[]).includes(value);
}

/** The mode for one instance's topic. A value the validator would reject counts as unset, never as hidden. */
export function crossInstanceVisibility(fleet: Pick<FleetConfig, "defaults" | "instances"> | null | undefined, instanceName: string): CrossInstanceVisibility {
  const own = fleet?.instances?.[instanceName]?.cross_instance_visibility;
  if (isCrossInstanceVisibility(own)) return own;
  const fleetDefault = fleet?.defaults?.cross_instance_visibility;
  return isCrossInstanceVisibility(fleetDefault) ? fleetDefault : DEFAULT_CROSS_INSTANCE_VISIBILITY;
}

const SUMMARY_PREVIEW_CHARS = 100;

/** One line: the label, then the sender's task summary or the start of the message. */
function summaryLine(label: string, message: string, taskSummary: string | undefined): string {
  const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();
  const summary = taskSummary && oneLine(taskSummary) ? oneLine(taskSummary) : oneLine(message);
  return `${label}: ${truncatePreview(summary, SUMMARY_PREVIEW_CHARS)}`;
}

export interface CrossInstanceNoticeInput {
  /** "sender → target", built by the caller (#1301 owns its wording). */
  label: string;
  message: string;
  requestKind?: string;
  taskSummary?: string;
}

/**
 * The text to post in the target's topic, or null for none. In `full`, task/query carry the whole message, any other
 * kind a short summary; report/update are silent in every mode.
 */
export function targetTopicNotice(mode: CrossInstanceVisibility, input: CrossInstanceNoticeInput): string | null {
  if (mode === "hidden") return null;
  if (input.requestKind === "report" || input.requestKind === "update") return null;
  if (mode === "summary") return summaryLine(input.label, input.message, input.taskSummary);
  return input.requestKind === "task" || input.requestKind === "query"
    ? `${input.label}:\n${input.message}`
    : `${input.label}: ${input.taskSummary ?? truncatePreview(input.message, SUMMARY_PREVIEW_CHARS)}`;
}

/** The text to post in the sender's topic, or null for none. `full` shows everything the agent sent. */
export function senderTopicNotice(mode: CrossInstanceVisibility, input: CrossInstanceNoticeInput): string | null {
  if (mode === "hidden") return null;
  if (mode === "summary") return summaryLine(input.label, input.message, input.taskSummary);
  return `${input.label}:\n${input.message}`;
}

/**
 * `/visibility [full|summary|hidden]` on Telegram and Discord, after the caller passed the fleet-admin gate: with a
 * mode, set the fleet default and save it to fleet.yaml; without one, say what it is. Instances with their own setting
 * keep it either way, so the reply names them. A save that fails is undone in memory and reported, never left
 * half-applied.
 */
export function runVisibilityCommand(fleet: Pick<FleetConfig, "defaults" | "instances">, arg: string, save: () => void): string {
  const wanted = arg.trim().toLowerCase();
  if (wanted && !isCrossInstanceVisibility(wanted)) return t("visibility.usage");
  if (isCrossInstanceVisibility(wanted)) {
    const had = Object.prototype.hasOwnProperty.call(fleet.defaults, "cross_instance_visibility");
    const previous = fleet.defaults.cross_instance_visibility;
    fleet.defaults.cross_instance_visibility = wanted;
    try {
      save();
    } catch (err) {
      if (had) fleet.defaults.cross_instance_visibility = previous;
      else delete fleet.defaults.cross_instance_visibility;
      return t("visibility.save_failed", err instanceof Error ? err.message : String(err));
    }
  }
  const fleetDefault = isCrossInstanceVisibility(fleet.defaults.cross_instance_visibility)
    ? fleet.defaults.cross_instance_visibility
    : DEFAULT_CROSS_INSTANCE_VISIBILITY;
  const lines = [t(wanted ? "visibility.set" : "visibility.current", fleetDefault), t(`visibility.mode.${fleetDefault}`)];
  const overrides = Object.entries(fleet.instances ?? {})
    .filter(([, config]) => isCrossInstanceVisibility(config?.cross_instance_visibility))
    .map(([name, config]) => `${name} (${config.cross_instance_visibility})`);
  if (overrides.length > 0) lines.push(t("visibility.overrides", overrides.join(", ")));
  if (!wanted) lines.push(t("visibility.usage"));
  return lines.join("\n");
}
