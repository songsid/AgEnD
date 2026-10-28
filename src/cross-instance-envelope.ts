/** Product guard that reserves room for routing metadata and protects recipient context. */
export const MAX_ASSEMBLED_CROSS_INSTANCE_MESSAGE_BYTES = 16_000;

/**
 * Render metadata carried in a handoff. #2785 (a): request_kind stays in the stored meta (Fleet traffic, logs) but is
 * not rendered — "a reply is owed" is the only thing it told the receiver, and `replyMarker` says that. The marker
 * replaces the correlation_id row (it carries the id) and goes last, so a long task_summary or branch can't bury it.
 */
export function renderCrossInstanceHandoffMetadata(meta: Record<string, string>, replyMarker = ""): string {
  const rows: string[] = [];
  const add = (label: string, value: string | undefined) => {
    if (value && value.trim()) rows.push(`${label}: ${value.trim()}`);
  };
  add("message_id", meta.message_id);
  add("verification_id", meta.verification_id);
  add("forwards", meta.forwards);
  if (!replyMarker) add("correlation_id", meta.correlation_id);
  add("task_summary", meta.task_summary);
  add("working_directory", meta.working_directory);
  add("branch", meta.branch);
  add("attachment_file_id", meta.attachment_file_id);
  if (replyMarker) rows.push(replyMarker);
  return rows.length ? `\n(${rows.join(" | ")})` : "";
}

/**
 * A task_summary that merely echoes the body is noise in the injected block
 * (#1037): senders auto-derive it from the first 200 chars when none is
 * given. It is redundant iff the body already opens with it — an explicit
 * summary carrying anything beyond the body is still shown.
 */
export function isRedundantTaskSummary(content: string, taskSummary: string | undefined): boolean {
  const summary = (taskSummary ?? "").trim();
  if (!summary) return false;
  const body = (content ?? "").trim();
  return body.length > 0 && body.startsWith(summary);
}

/**
 * #1650 (#1653 review): one shell argument that keeps `value` exactly — POSIX single quotes, a quote inside written as
 * '\'' — so a correlation id like "review batch 7" or "review-$task" reaches agend-agent as it was sent. A plain value
 * (letters, digits, - _ . : / @ % + = ,) stays bare, so the usual `cid-…` reads as before.
 */
export function shellArg(value: string): string {
  return /^[A-Za-z0-9_.:\/@%+=,-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

/** How the receiving agent talks to the fleet: MCP tools, or `agend-agent` commands (agent_mode: cli, no MCP server). */
export type AgentMode = "mcp" | "cli";

/**
 * #1650: how to answer an owed reply, in the receiver's own terms — MCP tool names, or the agend-agent commands of
 * agent-cli-instructions.md (a CLI-mode agent has no MCP server; naming tools it lacks told it nothing). #2785 (a): ""
 * when no reply is owed — the instructions already say to answer only with something to add, via send_to_instance.
 */
export function crossInstanceReplyMarker(meta: Record<string, string>, mode: AgentMode = "mcp"): string {
  if (meta.requires_reply !== "true") return "";
  const cid = meta.correlation_id?.trim();
  if (mode === "cli") {
    return `reply required → agend-agent report ${shellArg(meta.from_instance || "SENDER")} "…" ${shellArg(cid || "CORRELATION_ID")}`;
  }
  return cid ? `reply required → report_result ${cid}` : "reply required → send_to_instance";
}

/** Exact cross-instance block pasted by the receiving daemon (in the receiver's mode, #1650). */
export function formatCrossInstanceInboundMessage(content: string, meta: Record<string, string>, mode: AgentMode = "mcp"): string {
  const fromInstance = meta.from_instance || "unknown";
  const fromLabel = meta.from_display ? `${meta.from_display} (${fromInstance})` : fromInstance;
  let formatted = `[from:${fromLabel}] ${content}`;
  // Dedup only the injected block — logs and Telegram labels keep the raw
  // task_summary exactly as the sender provided it.
  const renderMeta = isRedundantTaskSummary(content, meta.task_summary)
    ? { ...meta, task_summary: "" }
    : meta;
  formatted += renderCrossInstanceHandoffMetadata(renderMeta, crossInstanceReplyMarker(meta, mode));
  return formatted;
}
