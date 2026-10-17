import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { DeliveryStatusItem, DeliveryStatusSelector, DeliveryStatusPage } from "./delivery-outbox.js";
import { t } from "./locale.js";
import { renderCrossInstanceHandoffMetadata, type AgentMode } from "./cross-instance-envelope.js";

/** Server-owned ingress facts. Labels and Web session identity are not platform authority. */
export interface HumanOrigin {
  platform: "discord" | "telegram" | "web";
  adapter_id: string | null;
  user_id: string | null;
  username: string | null;
  platform_message_id: string | null;
  ingress: "message" | "action" | "web";
  anchor_message_id?: string;
  event_id?: string;
}

/** Called only by trusted SDK event producers, never on text/agent metadata. */
export function nativeHumanOrigin(platform: "telegram" | "discord", adapterId: string, userId: string,
  username: string | undefined, isBot: boolean | undefined, messageId: string | null,
  action?: { anchor: string; event: string }): HumanOrigin | undefined {
  if (isBot !== false || !adapterId || !userId) return undefined;
  return {
    platform, adapter_id: adapterId, user_id: userId, username: username ?? null,
    platform_message_id: action ? null : messageId, ingress: action ? "action" : "message",
    ...(action ? { anchor_message_id: action.anchor, event_id: action.event } : {}),
  };
}

export function webHumanOrigin(action = false): HumanOrigin {
  return { platform: "web", adapter_id: null, user_id: null, username: null,
    platform_message_id: null, ingress: action ? "action" : "web" };
}

export type HumanWriteMode = "idle_submit" | "native_queue_handoff" | "steer" | "raw_paste";
export type HumanPositiveTag = "unique-id-pane" | "composer-empty-steer" | "composer-empty-queue" | "composer-empty-idle";
export interface HumanReceiptProof {
  receipt_id: string;
  verification_id: string;
  wire_sha256: string;
  owner_key: string;
  mode: HumanWriteMode;
  tag: HumanPositiveTag;
}
export interface HumanReceiptAttempt {
  receiptId: string;
  verificationId: string;
  expectedWireHash: string;
  ownerKey: string;
  current: () => boolean;
  proof?: HumanReceiptProof;
}

export function humanBodyHash(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

const objectIds = new WeakMap<object, string>();
/** Process-local object identity; a new process cannot settle an old binding. */
export function humanOwnerObjectId(owner: object): string {
  let id = objectIds.get(owner);
  if (!id) { id = randomUUID(); objectIds.set(owner, id); }
  return id;
}

export function isHumanPositiveProof(proof: unknown): proof is HumanReceiptProof {
  if (!proof || typeof proof !== "object") return false;
  const p = proof as Record<string, unknown>;
  if (!["receipt_id", "verification_id", "wire_sha256", "owner_key", "mode", "tag"].every(key => Object.hasOwn(p, key))) return false;
  if (typeof p.receipt_id !== "string" || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(p.receipt_id)
    || p.verification_id !== "hmsg-" + p.receipt_id
    || typeof p.wire_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(p.wire_sha256)
    || typeof p.owner_key !== "string" || !p.owner_key) return false;
  if (p.tag === "unique-id-pane") return p.mode === "idle_submit" || p.mode === "native_queue_handoff" || p.mode === "steer";
  return p.mode === "steer"
    && (p.tag === "composer-empty-steer" || p.tag === "composer-empty-queue" || p.tag === "composer-empty-idle");
}

export interface HumanReceiptRow {
  receipt_id: string;
  message_id: string;
  target_instance: string;
  manager_boot_id: string;
  original_body: string;
  original_sha256: string;
  origin_json: string;
  wire_body: string | null;
  wire_sha256: string | null;
  owner_key: string | null;
  input_kind: string;
  state: "queued" | "delivered" | "uncertain";
  proof_tag: HumanPositiveTag | null;
  proof_mode: HumanWriteMode | null;
  created_at: string;
  updated_at: string;
  delivered_at: string | null;
}

export function initializeHumanReceipts(db: Database.Database): void {
  db.exec([
    "CREATE TABLE IF NOT EXISTS human_delivery_receipts (",
    "receipt_id TEXT PRIMARY KEY,message_id TEXT NOT NULL UNIQUE,target_instance TEXT NOT NULL,manager_boot_id TEXT NOT NULL,",
    "original_body TEXT NOT NULL,original_sha256 TEXT NOT NULL,origin_json TEXT NOT NULL,",
    "wire_body TEXT,wire_sha256 TEXT,owner_key TEXT,input_kind TEXT NOT NULL,",
    "state TEXT NOT NULL CHECK (state IN ('queued','delivered','uncertain')),",
    "proof_tag TEXT,proof_mode TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,delivered_at TEXT);",
    "CREATE INDEX IF NOT EXISTS idx_human_receipt_retention ON human_delivery_receipts(updated_at);",
  ].join("\n"));
}

/** Server-only admission; no origin is read from an agent payload or tool argument. */
export function createHumanReceipt(db: Database.Database, input: {
  targetInstance: string; originalBody: string; origin: HumanOrigin; inputKind: string; managerBootId: string;
}): HumanReceiptRow {
  if (!input.targetInstance || Buffer.byteLength(input.originalBody, "utf8") > 64 * 1024
    || !["discord", "telegram", "web"].includes(input.origin.platform)
    || !["fleet_inbound", "steer", "btw", "raw_paste"].includes(input.inputKind)
    || !["message", "action", "web"].includes(input.origin.ingress)
    || (input.origin.platform !== "web" && (!input.origin.adapter_id || !input.origin.user_id || input.origin.ingress === "web"))
    || (input.origin.platform === "web" && (input.origin.adapter_id !== null || input.origin.user_id !== null || input.origin.username !== null || input.origin.platform_message_id !== null))
    || (input.origin.ingress === "action" && input.origin.platform_message_id !== null)) throw new Error("Human verification evidence is unavailable");
  const origin = JSON.stringify(input.origin);
  if (Buffer.byteLength(origin, "utf8") > 4096) throw new Error("Human verification origin exceeds its bound");
  const id = randomUUID(), now = new Date().toISOString();
  db.prepare("INSERT INTO human_delivery_receipts " +
    "(receipt_id,message_id,target_instance,manager_boot_id,original_body,original_sha256,origin_json,input_kind,state,created_at,updated_at) " +
    "VALUES (?,?,?,?,?,?,?,?,'queued',?,?)")
    .run(id, "hmsg-" + id, input.targetInstance, input.managerBootId, input.originalBody, humanBodyHash(input.originalBody), origin, input.inputKind, now, now);
  return getHumanReceipt(db, id)!;
}

export function getHumanReceipt(db: Database.Database, id: string): HumanReceiptRow | undefined {
  return db.prepare("SELECT * FROM human_delivery_receipts WHERE receipt_id=?").get(id) as HumanReceiptRow | undefined;
}

/** Bind once at the actual IPC handoff, after wake/reconnect waits. */
export function bindHumanReceipt(db: Database.Database, id: string, target: string, ownerKey: string, wire: string, managerBootId: string): HumanReceiptRow {
  if (!ownerKey || Buffer.byteLength(wire, "utf8") > 256 * 1024) throw new Error("Human verification wire evidence is unavailable");
  return db.transaction(() => {
    const row = getHumanReceipt(db, id);
    if (!row || row.target_instance !== target || row.manager_boot_id !== managerBootId) throw new Error("Human verification owner is unavailable");
    const hash = humanBodyHash(wire);
    if (row.owner_key !== null) {
      if (row.owner_key !== ownerKey || row.wire_sha256 !== hash) throw new Error("Human verification binding changed");
      return row;
    }
    db.prepare("UPDATE human_delivery_receipts SET owner_key=?,wire_body=?,wire_sha256=?,updated_at=? WHERE receipt_id=? AND owner_key IS NULL")
      .run(ownerKey, wire, hash, new Date().toISOString(), id);
    return getHumanReceipt(db, id)!;
  })();
}

/** An owned unknown result may close pending evidence; it never grants or overwrites a positive proof. */
export function settleHumanReceipt(db: Database.Database, id: string, target: string, ownerKey: string,
  proof: unknown, currentOwnerKey: string | null): boolean {
  return db.transaction(() => {
    const row = getHumanReceipt(db, id);
    if (!row || row.target_instance !== target || row.owner_key !== ownerKey || row.state === "delivered") return false;
    let positive: HumanReceiptProof | null = null;
    if (isHumanPositiveProof(proof)) {
      const modeMatches = row.input_kind === "steer" || row.input_kind === "btw"
        ? proof.mode === "steer" : row.input_kind === "fleet_inbound" && (proof.mode === "idle_submit" || proof.mode === "native_queue_handoff");
      if (modeMatches && proof.receipt_id === id && proof.verification_id === row.message_id
        && proof.owner_key === ownerKey && currentOwnerKey === ownerKey
        && proof.wire_sha256 === row.wire_sha256 && row.wire_body !== null
        && humanBodyHash(row.wire_body) === row.wire_sha256 && humanBodyHash(row.original_body) === row.original_sha256) positive = proof;
    }
    const now = new Date().toISOString();
    db.prepare("UPDATE human_delivery_receipts SET state=?,proof_tag=?,proof_mode=?,updated_at=?,delivered_at=? WHERE receipt_id=? AND state!='delivered'")
      .run(positive ? "delivered" : "uncertain", positive?.tag ?? null, positive?.mode ?? null, now, positive ? now : null, id);
    return positive !== null;
  })();
}

/** Read-only operator compatibility: an older database simply has no human receipts. */
export function queryHumanReceipt(db: Database.Database, caller: string | null, selector: DeliveryStatusSelector): DeliveryStatusPage | null {
  const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='human_delivery_receipts'").get();
  if (!table || selector.correlationId) return null;
  const field = selector.messageId ? "message_id" : "receipt_id";
  const id = selector.messageId ?? selector.deliveryId ?? selector.operationId;
  if (!id || (selector.cursor && selector.cursor !== id)) return null;
  const row = db.prepare("SELECT * FROM human_delivery_receipts WHERE " + field + "=?").get(id) as HumanReceiptRow | undefined;
  if (!row) return null;
  if (selector.cursor) return { items: [], next_cursor: null };
  if (caller !== null && row.target_instance !== caller
    && !db.prepare("SELECT 1 FROM delivery_forward_edges WHERE reference_kind='human' AND reference_id=? AND receiver_instance=? LIMIT 1")
      .get(row.receipt_id, caller)) return { items: [], next_cursor: null };
  const origin = JSON.parse(row.origin_json) as HumanOrigin;
  const item: DeliveryStatusItem = {
    delivery_id: row.receipt_id, operation_id: row.receipt_id, correlation_id: null,
    source_instance: "human:" + origin.platform + ":" + (origin.user_id ?? "unknown"),
    target_instance: row.target_instance, kind: "human_inbound", state: row.state, attempt_no: 0,
    created_at: row.created_at, updated_at: row.updated_at,
    status_summary: t("delivery.status_" + row.state),
    error_summary: null, safe_to_retry: false, message_id: row.message_id, content_sha256: row.original_sha256,
    delivery_mode: row.proof_mode === "steer" ? "steer" : "idle_queue", submission_mode: row.proof_mode, consumed_at: null, consumed_via: null,
    origin, wire_content_sha256: row.wire_sha256, delivered_at: row.delivered_at,
    proof_kind: row.proof_tag,
    ...(caller !== null && selector.messageId ? { content: row.original_body } : {}),
  };
  if (caller !== null && selector.messageId) {
    const edges = db.prepare("SELECT sender_instance AS source_instance,forwarding_message_id AS message_id,created_at AS forwarded_at " +
      "FROM delivery_forward_edges WHERE reference_kind='human' AND reference_id=? AND receiver_instance=? " +
      "ORDER BY created_at DESC,forwarding_delivery_id DESC LIMIT 1").all(row.receipt_id, caller) as DeliveryStatusItem["forwarded_by"];
    if (edges?.length) item.forwarded_by = edges;
  }
  return { items: [item], next_cursor: null };
}

/** Preserve the existing sanitizer in one place; receipts hash these actual prepared bytes. */
export function prepareDeliveryWire(body: string, preserveExactBytes = false): string {
  const fence = String.fromCharCode(96).repeat(3);
  const parts = body.split(fence);
  return !preserveExactBytes && (parts.length - 1) % 2 !== 0 ? parts.join("") : body;
}

export function steerInboundEnvelope(inbound: string): string {
  const banner = "[STEERING — mid-task course correction. Fold this into the CURRENT work if one is active.]\n";
  const marker = inbound.match(/^\[agend-(?:delivery|human)-id:[^\]\r\n]+\]\r?\n/);
  return marker ? marker[0] + banner + inbound.slice(marker[0].length) : banner + inbound;
}

export const BTW_INBOUND_PREFIX = "[BTW — side question from the user. Answer it separately without changing or interrupting the CURRENT work.]\n";

/** One formatter for human wire bytes and their immutable evidence snapshot. */
export function formatHumanInboundMessage(content: string, meta: Record<string, string>, mode: AgentMode): string {
  // #1920: a guest's web message says so — recognition only, like every web message (authority none).
  const via = meta.source ? " via " + meta.source + (meta.source === "web" && meta.web_guest === "1" ? " (guest)" : "") : "";
  const idTag = meta.user_id ? ", id:" + meta.user_id : "";
  let body = "[user:" + (meta.user || "unknown") + via + idTag + "] " + content;
  if (meta.pending_reactions) body = "[Recent reactions: " + meta.pending_reactions + "]\n" + body;
  // Reaction/reply addressing keeps the actual platform ID. Only verification uses hmsg.
  body += renderCrossInstanceHandoffMetadata(meta);
  body += mode === "cli"
    ? '\n(Reply with agend-agent reply "…" — do NOT respond with direct text)'
    : "\n(Reply using the reply tool — do NOT respond with direct text)";
  if (meta.reply_to_text) body += '\n(reply_to: "' + meta.reply_to_text + '")';
  if (meta.verification_id) body = "[agend-human-id:" + meta.verification_id + "]\n" + body;
  if (meta.delivery_id) body = "[agend-delivery-id:" + meta.delivery_id + "]\n" + body;
  return body;
}
