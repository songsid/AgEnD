import type { HumanAuthority } from "../../authority/web-authority.js";
import type { HumanReceiptRow } from "../../human-delivery-receipts.js";
import { humanBodyHash, isHumanPositiveProof } from "../../human-delivery-receipts.js";

export const ROOM_HUMAN_RECEIPT = /^hmsg-[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
export interface RoomReceiptEvidence { row: HumanReceiptRow; authority: HumanAuthority }
export interface RoomReceiptProof { receiptId: string; current(): boolean }
export interface RoomReceiptOptions {
  /** Returns nothing unless the invoking agent received the receipt or an explicit forward. */
  lookup(agent: string, receiptId: string): RoomReceiptEvidence | null;
  /** Current Fleet administrator in the invoking agent's adapter namespace, or the current web-only host operator. */
  admin(agent: string, actor: NonNullable<HumanAuthority["actor"]>): boolean;
}
export function verifyRoomReceipt(options: RoomReceiptOptions, agent: string, receiptId: string): RoomReceiptProof | null {
  if (!ROOM_HUMAN_RECEIPT.test(receiptId)) return null;
  const observe = (): string | null => {
    try {
      const evidence = options.lookup(agent, receiptId);
      if (!evidence) return null;
      const { row, authority } = evidence;
      if (row.message_id !== receiptId || row.receipt_id !== receiptId.slice(5) || row.state !== "delivered" || !row.delivered_at
        || !isHumanPositiveProof({ receipt_id: row.receipt_id, verification_id: row.message_id, wire_sha256: row.wire_sha256,
          owner_key: row.owner_key, mode: row.proof_mode, tag: row.proof_tag })
        || !["fleet_inbound", "steer", "btw"].includes(row.input_kind)
        || ((row.input_kind === "steer" || row.input_kind === "btw") ? row.proof_mode !== "steer"
          : row.proof_mode !== "idle_submit" && row.proof_mode !== "native_queue_handoff")
        || humanBodyHash(row.original_body) !== row.original_sha256 || row.wire_body === null
        || humanBodyHash(row.wire_body) !== row.wire_sha256 || !authority.actor
        || !options.admin(agent, authority.actor)) return null;
      const origin = JSON.parse(row.origin_json);
      if (authority.kind === "platform") {
        if (!["discord", "telegram"].includes(origin.platform) || origin.adapter_id !== authority.actor.adapter_id
          || origin.user_id !== authority.actor.user_id) return null;
      } else if (authority.kind !== "web-verified" || origin.platform !== "web") return null;
      // No prompt, explanation or caller-supplied identity leaves this verifier.
      return JSON.stringify([row, authority]);
    } catch { return null; }
  };
  const image = observe();
  return image ? { receiptId, current: () => observe() === image } : null;
}
