/** Product guard that reserves room for routing metadata and protects recipient context. */
export const MAX_ASSEMBLED_CROSS_INSTANCE_MESSAGE_BYTES = 16_000;

/** Render metadata carried in a cross-instance handoff. */
export function renderCrossInstanceHandoffMetadata(meta: Record<string, string>): string {
  const rows: string[] = [];
  const add = (label: string, value: string | undefined) => {
    if (value && value.trim()) rows.push(`${label}: ${value.trim()}`);
  };
  add("message_id", meta.message_id);
  add("verification_id", meta.verification_id);
  add("forwards", meta.forwards);
  add("correlation_id", meta.correlation_id);
  add("request_kind", meta.request_kind);
  add("task_summary", meta.task_summary);
  add("working_directory", meta.working_directory);
  add("branch", meta.branch);
  add("attachment_file_id", meta.attachment_file_id);
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
 * #1650: how to answer, in the receiver's own terms — MCP tool names, or the agend-agent commands of
 * agent-cli-instructions.md (a CLI-mode agent has no MCP server; naming tools it lacks told it nothing).
 */
export function crossInstanceReplyFooter(meta: Record<string, string>, mode: AgentMode = "mcp"): string {
  const required = meta.requires_reply === "true";
  if (mode === "cli") {
    const from = shellArg(meta.from_instance || "SENDER");
    return required
      ? `\n(A reply IS required: agend-agent report ${from} "…" ${shellArg(meta.correlation_id || "CORRELATION_ID")} — or agend-agent send ${from} "…". Not direct text.)`
      : `\n(If you need to reply, use agend-agent send ${from} "…", NOT direct text. If there is nothing to add, you may stay silent.)`;
  }
  return required
    ? "\n(A reply IS required: use report_result with the correlation_id above — or send_to_instance. Not direct text.)"
    : "\n(If you need to reply, use send_to_instance tool, NOT direct text. If there is nothing to add, you may stay silent.)";
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
  formatted += renderCrossInstanceHandoffMetadata(renderMeta);
  formatted += crossInstanceReplyFooter(meta, mode);
  return formatted;
}
