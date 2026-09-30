/** Product guard that reserves room for routing metadata and protects recipient context. */
export const MAX_ASSEMBLED_CROSS_INSTANCE_MESSAGE_BYTES = 16_000;

/** Render metadata carried in a cross-instance handoff. */
export function renderCrossInstanceHandoffMetadata(meta: Record<string, string>): string {
  const rows: string[] = [];
  const add = (label: string, value: string | undefined) => {
    if (value && value.trim()) rows.push(`${label}: ${value.trim()}`);
  };
  add("message_id", meta.message_id);
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

/** Exact cross-instance block pasted by the receiving daemon. */
export function formatCrossInstanceInboundMessage(content: string, meta: Record<string, string>): string {
  const fromInstance = meta.from_instance || "unknown";
  const fromLabel = meta.from_display ? `${meta.from_display} (${fromInstance})` : fromInstance;
  let formatted = `[from:${fromLabel}] ${content}`;
  // Dedup only the injected block — logs and Telegram labels keep the raw
  // task_summary exactly as the sender provided it.
  const renderMeta = isRedundantTaskSummary(content, meta.task_summary)
    ? { ...meta, task_summary: "" }
    : meta;
  formatted += renderCrossInstanceHandoffMetadata(renderMeta);
  formatted += meta.requires_reply === "true"
    ? "\n(A reply IS required: use report_result with the correlation_id above — or send_to_instance. Not direct text.)"
    : "\n(If you need to reply, use send_to_instance tool, NOT direct text. If there is nothing to add, you may stay silent.)";
  return formatted;
}
