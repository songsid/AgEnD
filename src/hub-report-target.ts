/**
 * The reserved report_result target for Hub representative answers (docs/design/hub-representative-agent.md). Kept
 * on the shared reply models so outbound handlers never need to load the Hub runtime to validate a report.
 */
import { parseReplyButtons } from "./reply-buttons.js";
import { parsePoll } from "./reply-polls.js";

export const HUB_REPORT_TARGET = "agend-hub";
export type HubReportOutcome = { ok: true; message: string } | { ok: false; message: string };
/** M-3637: what an agent is told when it answers a Hub question that no longer takes an answer. */
export const HUB_ANSWER_USED = "Not sent: this Hub question already has its answer. Each Hub question takes exactly one answer, and the asker sees more from you only after they write again. Put everything in your one answer.";
export const HUB_ANSWER_SENDING = "Not sent: your answer to this Hub question is already being sent. Each Hub question takes exactly one answer.";
export const HUB_ANSWER_HELD = "Not sent: this Hub question is on hold in this Fleet (its owner sees it under Needs you), so it takes no answer now. The asker can write again.";
/** M-3637: a hub-… correlation id that is not a live Hub question for this agent (or no Hub connection runs here). */
export const HUB_ANSWER_UNKNOWN = "Not sent: this correlation_id is not a live Hub question for you. Answer a Hub question with the correlation_id it gave you; each takes exactly one answer, and the asker sees more only after they write again.";

/**
 * report_result's Hub-only fields (#3226 seams §3; D owns the schema, F fills buttons/poll). `files` are the agent's
 * paths, checked again when the answer is released (state-dir rule, size, type). Other targets must not carry any.
 */
export interface HubReportExtras {
  files?: readonly string[];
  /** F: the parsed reply buttons and poll, in the fleet's reply-buttons / reply-polls shapes. */
  buttons?: readonly import("./reply-buttons.js").ReplyButton[];
  poll?: import("./reply-polls.js").PollConfig;
}
export type HubReportExtrasResult = { ok: true; extras: HubReportExtras } | { ok: false; message: string };
const HUB_ONLY = ["files", "buttons", "poll"] as const;
/** Validate report_result's Hub-only fields for `target`. Another target carrying any of them is refused, never ignored. */
export function parseHubReportExtras(target: string, args: { summary?: unknown; files?: unknown; buttons?: unknown; poll?: unknown }): HubReportExtrasResult {
  const present = HUB_ONLY.filter(key => args[key] !== undefined);
  if (target !== HUB_REPORT_TARGET) {
    return present.length ? { ok: false, message: `report_result ${present.join("/")} are only for target_instance "${HUB_REPORT_TARGET}" (a Hub answer). Use the reply tool for files or buttons in a chat.` } : { ok: true, extras: {} };
  }
  const extras: HubReportExtras = {};
  if (args.files !== undefined) {
    if (!Array.isArray(args.files) || args.files.length < 1 || args.files.length > 10 || args.files.some(f => typeof f !== "string" || !f)) return { ok: false, message: "files: 1–10 file paths" };
    extras.files = [...args.files as string[]];
  }
  const buttons = parseReplyButtons(args.buttons, { text: args.summary });
  if (buttons && "error" in buttons) return { ok: false, message: buttons.error };
  const poll = parsePoll(args.poll, buttons?.buttons ?? null, args.summary);
  if (poll && "error" in poll) return { ok: false, message: poll.error };
  if (buttons) extras.buttons = buttons.buttons;
  if (poll) extras.poll = poll.poll;
  return { ok: true, extras };
}
