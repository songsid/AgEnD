/**
 * The reserved report_result target for Hub representative answers (docs/design/hub-representative-agent.md). Kept
 * dependency-free so the outbound handlers can name it without loading any Hub code.
 */
export const HUB_REPORT_TARGET = "agend-hub";
export type HubReportOutcome = { ok: true; message: string } | { ok: false; message: string };
