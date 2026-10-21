/**
 * #2293: what each source puts in the search index (search-store.ts SearchDoc) — the fields it may show and nothing else.
 * - chat: a person's or an agent's message of an instance's chat (never a status line or an effect offer); its text (a
 *   click: its label) and its files' names; who wrote it; the row it opens (boot, id).
 * - xmsg: a cross-instance message — its content and task summary, the kind, sender → target, the correlation id. Never
 *   `forwards` (capability-like verification ids), the working directory, the branch, delivery ids.
 * - task: a Task Board task — title, description, result; its status, assignee, who created it.
 */
import type { WebChatMessage } from "../web-chat-history.js";
import type { SearchDoc } from "./search-store.js";

const time = (iso: unknown, fallback = Date.now()): number => { const t = typeof iso === "string" ? Date.parse(iso) : NaN; return Number.isFinite(t) ? t : fallback; };

/** A chat row's doc, or null when it is not searched (a status line, an effect offer, nothing to find). */
export function chatDoc(m: WebChatMessage): SearchDoc | null {
  if ((m.role !== "user" && m.role !== "agent") || m.effectTrial) return null;
  const words = m.click?.label ?? m.text ?? "";
  const files = (m.attachments ?? []).map(a => a.name).filter(Boolean).join(" ");
  const text = [words, files].filter(Boolean).join("\n");
  if (!text.trim()) return null;
  // "Only mine": the account that wrote it (`<connection>:<user id>`, as web-api's WebPerson.voterKey); a web message
  // with none is the operator's (an `agend web` session: a guest is always signed in as an account).
  const mine = m.role !== "user" ? undefined : m.from ?? (m.messageId ? "web:operator" : undefined);
  return { key: `chat:${m.instance}:${m.boot}-${m.id}`, source: "chat", instance: m.instance, sender: m.sender, role: m.role,
    ...(mine ? { mine } : {}), ts: time(m.ts), ref: { boot: m.boot, id: m.id }, text };
}

export interface CrossInstanceRecord {
  messageId: string; from: string; to: string; kind?: string; correlationId?: string; taskSummary?: string; content: string; ts?: string;
}
/** A cross-instance message's doc (sender → target); null with nothing to find or no id. */
export function xmsgDoc(r: CrossInstanceRecord): SearchDoc | null {
  if (!r.messageId || !r.from || !r.to) return null;
  const text = [r.taskSummary, r.content].filter(s => typeof s === "string" && s.trim()).join("\n");
  if (!text) return null;
  return { key: `xmsg:${r.messageId}:${r.to}`, source: "xmsg", instance: r.from, peer: r.to, sender: r.from, role: r.kind || "message",
    ts: time(r.ts), ref: { messageId: r.messageId, kind: r.kind || "message", ...(r.correlationId ? { correlationId: r.correlationId } : {}) }, text };
}

/**
 * A cross-instance message as the outbox keeps it (deliveries.payload_json), for the backfill: only what an agent sent
 * another (meta.from_instance); a person's message or a schedule is not one.
 */
export function xmsgFromOutbox(target: string, createdAt: string, payloadJson: string, rowKind?: string): CrossInstanceRecord | null {
  let p: { content?: unknown; meta?: Record<string, unknown> };
  try { p = JSON.parse(payloadJson); } catch { return null; }
  const meta = p?.meta;
  if (!meta || typeof meta.from_instance !== "string" || typeof meta.message_id !== "string" || typeof p.content !== "string") return null;
  const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
  // A broadcast without a request kind is indexed as one, as outbound-handlers records it live.
  const kind = str(meta.request_kind) ?? (rowKind === "broadcast" ? "broadcast" : undefined);
  return { messageId: meta.message_id, from: meta.from_instance, to: target, kind, correlationId: str(meta.correlation_id),
    taskSummary: str(meta.task_summary), content: p.content, ts: str(meta.ts) ?? createdAt };
}

/**
 * Whose cross-instance messages are found (cross_instance_visibility "hidden", fleet-traffic's rule): none to or from a
 * `hidden` name; or — the fleet's default is hidden — only those with both sides `among` the instances set to show theirs.
 * cross-instance-notice.ts xmsgVisibility makes it from the config.
 */
export type XmsgVisibility = { hidden: string[] } | { among: string[] };
/** The same rule for one doc (the search's SQL applies it to many: SearchFilters.hidden / xmsgAmong). */
export function xmsgShown(doc: { source: string; instance: string; peer?: string | null }, v: XmsgVisibility): boolean {
  if (doc.source !== "xmsg") return true;
  const sides = [doc.instance, doc.peer ?? ""];
  return "hidden" in v ? !sides.some(s => v.hidden.includes(s)) : sides.every(s => v.among.includes(s));
}

export interface TaskRecord { id: string; title: string; description?: string | null; result?: string | null; status: string; assignee?: string | null; created_by?: string | null; updated_at?: string; created_at?: string }
/** A task's doc (replaced on every update: same key). */
export function taskDoc(t: TaskRecord): SearchDoc | null {
  if (!t?.id || typeof t.title !== "string") return null;
  const text = [t.title, t.description, t.result].filter(s => typeof s === "string" && s.trim()).join("\n");
  return { key: `task:${t.id}`, source: "task", instance: t.assignee || t.created_by || "tasks", sender: t.created_by || "", role: t.status,
    ts: time(t.updated_at ?? t.created_at), ref: { taskId: t.id }, text };
}
