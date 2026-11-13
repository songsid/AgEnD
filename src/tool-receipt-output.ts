/** Render only after the existing ACL and current-authority checks. No store/proof mutation. */
import type { DeliveryStatusPage } from "./delivery-outbox.js";

/** Best-effort display redaction, not a replacement for receipt ACL or exact-content detail access. */
export function receiptExcerpt(text: string): string {
  return text
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, "[redacted]")
    .replace(/\bBearer\s+[^\s"'<>]+/gi, "Bearer [redacted]")
    .replace(/\b(?:4\/[A-Za-z0-9_-]{20,}|(?:gh[pousr]_|github_pat_|sk-(?:proj-)?|xox[baprs]-|glpat-|ya29\.|AIza)[A-Za-z0-9_-]{12,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/g, "[redacted]")
    .replace(/((?:[?&](?:code|state|access_token|refresh_token|id_token)|\b(?:[\w-]*token|api[_ -]?key|password|secret|(?:one[- ]time |authorization |verification |oauth |device |login |sign[- ]in )code))["']?\s*[:=]\s*["']?)[^\s"'&<>]+/gi, "$1[redacted]")
    .replace(/\b\d{6,8}\b/g, "[redacted]")
    .slice(0, 200);
}

export function compactDeliveryStatus(page: DeliveryStatusPage, detail = false, contains?: string) {
  if (detail && contains === undefined) return page;
  return {
    items: page.items.map(item => {
      const check = contains === undefined ? {} : { contains: typeof item.content === "string" ? item.content.includes(contains) : null };
      if (detail) return { ...item, ...check };
      return {
        delivery_id: item.delivery_id, message_id: item.message_id,
        state: item.state, safe_to_retry: item.safe_to_retry,
        source_instance: item.source_instance, target_instance: item.target_instance, kind: item.kind,
        ...(item.correlation_id ? { correlation_id: item.correlation_id } : {}),
        content_sha256: item.content_sha256,
        ...(item.content !== undefined ? { excerpt: item.content === null ? null : receiptExcerpt(item.content) } : {}),
        ...(item.proof_kind !== undefined ? { proof_kind: item.proof_kind } : {}),
        ...(item.authority !== undefined ? { authority: item.authority } : {}),
        ...(item.origin !== undefined ? { origin: item.origin } : {}),
        ...(item.wire_content_sha256 !== undefined ? { wire_content_sha256: item.wire_content_sha256 } : {}),
        ...(item.delivered_at !== undefined ? { delivered_at: item.delivered_at } : {}),
        ...(item.forwarded_by !== undefined ? { forwarded_by: item.forwarded_by } : {}),
        // Accepted delivery is not consumption. Preserve positive consumption evidence only.
        ...(item.consumed_at ? { consumed_at: item.consumed_at, consumed_via: item.consumed_via } : {}),
        ...(item.waiting_reason ? { waiting_reason: item.waiting_reason } : {}),
        ...check,
      };
    }),
    next_cursor: page.next_cursor,
  };
}

interface SendAck { sent: boolean; queued: boolean; delivery_id?: string; correlation_id?: string; warning?: string }
export function compactSendAck<T extends SendAck>(ack: T, detail = false, correlationWasGiven = false): T | SendAck {
  if (detail) return ack;
  return { sent: ack.sent, queued: ack.queued,
    ...(ack.delivery_id ? { delivery_id: ack.delivery_id } : {}),
    ...(correlationWasGiven && ack.correlation_id ? { correlation_id: ack.correlation_id } : {}),
    ...(ack.warning ? { warning: ack.warning } : {}),
  };
}
