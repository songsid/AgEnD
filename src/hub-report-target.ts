/**
 * The reserved report_result target for Hub representative answers (docs/design/hub-representative-agent.md). Kept
 * dependency-free so the outbound handlers can name it without loading any Hub code.
 */
export const HUB_REPORT_TARGET = "agend-hub";
export type HubReportOutcome = { ok: true; message: string } | { ok: false; message: string };

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
export function parseHubReportExtras(target: string, args: { files?: unknown; buttons?: unknown; poll?: unknown }): HubReportExtrasResult {
  const present = HUB_ONLY.filter(key => args[key] !== undefined);
  if (target !== HUB_REPORT_TARGET) {
    return present.length ? { ok: false, message: `report_result ${present.join("/")} are only for target_instance "${HUB_REPORT_TARGET}" (a Hub answer). Use the reply tool for files or buttons in a chat.` } : { ok: true, extras: {} };
  }
  const extras: HubReportExtras = {};
  if (args.files !== undefined) {
    if (!Array.isArray(args.files) || args.files.length < 1 || args.files.length > 10 || args.files.some(f => typeof f !== "string" || !f)) return { ok: false, message: "files: 1–10 file paths" };
    extras.files = [...args.files as string[]];
  }
  // Until F (#3226) lands: buttons and polls on a Hub answer are not supported yet.
  if (args.buttons !== undefined || args.poll !== undefined) return { ok: false, message: "Buttons and polls on a Hub answer are not supported yet. Send the answer as text." };
  return { ok: true, extras };
}
