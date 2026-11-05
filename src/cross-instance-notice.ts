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
import type { XmsgVisibility } from "./search/search-docs.js";

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

/**
 * #2293: whose cross-instance messages the dashboard's search leaves out (fleet-traffic's rule: none to or from a hidden
 * name). Per instance; or, the fleet's default being hidden, every name but the instances set to show theirs — another
 * instance or an external session with no setting of its own follows the default.
 */
export function xmsgVisibility(fleet: Pick<FleetConfig, "defaults" | "instances"> | null | undefined): XmsgVisibility {
  const names = Object.keys(fleet?.instances ?? {});
  const off = (name: string) => crossInstanceVisibility(fleet, name) === "hidden";
  return fleet?.defaults?.cross_instance_visibility === "hidden" ? { among: names.filter(n => !off(n)) } : { hidden: names.filter(off) };
}

const SUMMARY_PREVIEW_CHARS = 100;
const URL_SPLIT = /(https?:\/\/[^\s]+)/gi;
const FORWARDS_LIST = /\bforwards:\s*\[[^\]]*\]/gi;
const VERIFICATION_PAREN = /\(\s*verification_id\b[^)]*\)|（\s*verification_id\b[^）]*）/gi;
const LABELED_MSG_ID = /\b(?:verification_id|message_id)\s*:?\s*(?:hmsg|xmsg)-[A-Za-z0-9-]+/gi;
const BARE_MSG_ID = /\b(?:hmsg|xmsg)-[A-Za-z0-9-]+/g;
/** Marks a removed reference. Never appears in a URL part; those are split out first. */
const GAP = "\uE000";
const GAP_ONLY_LINE = /^[ \t]*\uE000+[ \t]*$/;

/**
 * Strip internal message-reference ids from a human-facing notice. Agent payloads must not go through this:
 * hmsg-/xmsg- ids and forwards lists are how agents verify receipts.
 *
 * Cleanup only touches gaps left by a removed reference. Ordinary text, indentation, `decide()`-style
 * empty parens, doubled spaces in code, and URL bytes (including `,,`) stay as they were.
 */
export function hideInternalMessageIds(text: string): string {
  return text.split(URL_SPLIT).map((part, i) => (i % 2 === 1 ? part : hideIdsInText(part))).join("");
}

function hideIdsInText(text: string): string {
  const gapped = text
    .replace(FORWARDS_LIST, GAP)
    .replace(VERIFICATION_PAREN, GAP)
    .replace(LABELED_MSG_ID, GAP)
    .replace(BARE_MSG_ID, GAP);
  return gapped.includes(GAP) ? tidyRemovedGaps(gapped) : text;
}

function tidyRemovedGaps(text: string): string {
  let s = text;
  for (let i = 0; i < 8; i++) {
    const next = s
      .replace(/\((?=[^()]*\uE000)[\s\uE000]*\)|（(?=[^（）]*\uE000)[\s\uE000]*）/g, GAP)
      .replace(/[，,][ \t]*\uE000+[ \t]*(?=[，,。．.!?！？)\]]|$)/g, GAP);
    if (next === s) break;
    s = next;
  }
  s = s.split("\n").filter(line => !GAP_ONLY_LINE.test(line)).join("\n");
  return s.replace(/[ \t]*\uE000+(?:[ \t]*\uE000+)*[ \t]*/g, (match, offset, whole: string) => {
    const left = offset > 0 ? whole[offset - 1]! : "";
    const right = whole[offset + match.length] ?? "";
    if (!left || !right) return "";
    if (/[。．.!?！？，,;；)\]]/.test(right) || /[。．.!?！？]/.test(left)) return "";
    if (/[ \t]/.test(match)) return " ";
    if (/[A-Za-z0-9]/.test(left) && /[A-Za-z0-9]/.test(right)) return " ";
    return "";
  });
}

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
  const message = hideInternalMessageIds(input.message);
  const taskSummary = input.taskSummary === undefined ? undefined : hideInternalMessageIds(input.taskSummary);
  if (mode === "summary") return summaryLine(input.label, message, taskSummary);
  return input.requestKind === "task" || input.requestKind === "query"
    ? `${input.label}:\n${message}`
    : `${input.label}: ${taskSummary ?? truncatePreview(message, SUMMARY_PREVIEW_CHARS)}`;
}

/** The text to post in the sender's topic, or null for none. `full` shows everything the agent sent. */
export function senderTopicNotice(mode: CrossInstanceVisibility, input: CrossInstanceNoticeInput): string | null {
  if (mode === "hidden") return null;
  const message = hideInternalMessageIds(input.message);
  const taskSummary = input.taskSummary === undefined ? undefined : hideInternalMessageIds(input.taskSummary);
  if (mode === "summary") return summaryLine(input.label, message, taskSummary);
  return `${input.label}:\n${message}`;
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
