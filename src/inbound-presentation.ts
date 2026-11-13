/** Presentation only. None of these strings supplies origin, authority, or a forwarding capability. */
const CONTROLS = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/g;
function visibleControl(c: string): string {
  if (c === "\n") return "\\n";
  if (c === "\r") return "\\r";
  if (c === "\t") return "\\t";
  return "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0");
}
/** Escape exactly once from original metadata; do not use the result as a tool argument. */
export function escapeInboundField(value: string): string {
  return value.replace(/[\\@#\[\]()|]/g, c => "\\" + c).replace(CONTROLS, visibleControl);
}
const RESERVED = /^\s*(?:\[(?:hid:|agend-(?:human|delivery)-id:|user:|from:|system:|STEERING|BTW)|\((?:message_id|verification_id|forwards|correlation_id|reply required)\b)/;
/** Preserve ordinary text/newlines; reserved envelope-like rows remain visibly quoted data. */
export function escapeInboundBody(value: string): string {
  return value.split("\n").map(line => {
    const safe = line.replace(CONTROLS, visibleControl);
    // Backtick normalization must not expose a header hidden behind an unmatched code fence.
    return RESERVED.test(safe.replace(/`/g, "")) ? "> " + safe : safe;
  }).join("\n");
}
export type HumanWireDialect = "legacy" | "compact";
export interface HumanPresentation { dialect?: HumanWireDialect; replyHint?: boolean; compatibilityNotice?: string; escape?: boolean }
export function humanReceiptMarker(id: string, dialect: HumanWireDialect): string {
  return `[${dialect === "compact" ? "hid" : "agend-human-id"}:${id}]`;
}

export interface HumanReminderStamp { readonly epoch: number; readonly id: string; readonly replyHint: boolean }
/** One owned CLI context. Only proven human writes advance the reminder cadence. */
export class HumanReminderState {
  private epoch = 0;
  private completed = 0;
  private firstOwed = true;
  private readonly settled = new Set<string>();
  reset(): void { this.epoch++; this.completed = 0; this.firstOwed = true; this.settled.clear(); }
  prepare(id: string): HumanReminderStamp {
    return Object.freeze({ epoch: this.epoch, id, replyHint: this.firstOwed || this.completed % 10 === 0 });
  }
  current(stamp: HumanReminderStamp): boolean { return stamp.epoch === this.epoch; }
  settle(stamp: HumanReminderStamp, positive: boolean): void {
    if (!positive || !this.current(stamp) || this.settled.has(stamp.id)) return;
    this.settled.add(stamp.id);
    this.completed++;
    if (stamp.replyHint) this.firstOwed = false;
  }
}
