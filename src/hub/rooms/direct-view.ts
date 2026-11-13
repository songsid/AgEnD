/** Seam-1 projections keep the direct service's grant, execution and receipt machinery intact. */
import type { HubRoomEntryView, HubRoomListItem } from "../rooms.js";
import type { RoomMessage } from "./types.js";
import { personKeyString } from "../identity.js";
import type { HubCore } from "../http/core.js";
import { HubProtocolError } from "../validation.js";

export function directRoomView(room: HubRoomListItem, presence: "idle" | "paused" | "offline" = "offline", unread = 0) {
  return { ...room, kind: "direct" as const, name: room.exposureName, people: 1, agents: 1, online: presence === "idle" ? 1 : 0, unread,
    lastText: "", lastAuthor: "", archived: room.state === "closed",
    agent: { exposureId: room.exposureId, owner: { name: room.ownerName }, presence } };
}
export function directMessages(room: HubRoomListItem, entries: readonly HubRoomEntryView[], askerName: string): RoomMessage[] {
  return entries.flatMap(entry => {
    const base = { roomId: room.id, mentions: [] as string[] };
    const question: RoomMessage = { ...base, id: entry.messageId, at: entry.askedAt ?? entry.receipt.at,
      author: { kind: "person", id: personKeyString(room.asker), name: askerName }, text: entry.question ?? "",
      stage: entry.receipt.stage === "answered" ? "answered" : ["queued", "delivered", "consumed"].includes(entry.receipt.stage) ? "working" : "not-answered",
      ...(entry.idempotencyKey ? { idempotencyKey: entry.idempotencyKey } : {}), ...(entry.questionFiles?.length ? { files: entry.questionFiles } : {}) };
    return [question, ...(entry.answer === undefined ? [] : [{ ...base, id: `${entry.messageId}:answer`, at: entry.receipt.at,
      author: { kind: "agent" as const, id: room.exposureId, name: room.exposureName, owner: { name: room.ownerName } }, text: entry.answer,
      replyTo: entry.messageId, ...(entry.answerFiles?.length ? { files: entry.answerFiles } : {}) }])];
  });
}

/** A late answer is unread even when its question predates the last read action. */
export function directUnread(core: HubCore, room: HubRoomListItem): number {
  if (room.state !== "active") return 0;
  return core.atomic(db => (db.prepare(`SELECT COUNT(*) AS n FROM hub_messages m WHERE m.room_id=? AND m.answer_id IS NOT NULL AND NOT EXISTS
    (SELECT 1 FROM hub_direct_room_reads r WHERE r.room_id=m.room_id AND r.message_id=m.id AND r.answer_id=m.answer_id)`).get(room.id) as { n: number }).n);
}
export function markDirectRead(core: HubCore, roomId: string, upTo: string): void {
  core.atomic(db => {
    const answer = upTo.endsWith(":answer"), id = upTo.replace(/:answer$/, "");
    const target = db.prepare("SELECT sequence,answer_id FROM hub_messages WHERE room_id=? AND id=?").get(roomId, id) as { sequence: number; answer_id: string | null } | undefined;
    if (!target || answer && !target.answer_id) throw new HubProtocolError("not-found");
    db.prepare(`INSERT INTO hub_direct_room_reads(room_id,message_id,answer_id)
      SELECT room_id,id,answer_id FROM hub_messages WHERE room_id=? AND sequence${answer ? "<=" : "<"}? AND answer_id IS NOT NULL
      ON CONFLICT(room_id,message_id) DO UPDATE SET answer_id=excluded.answer_id`).run(roomId, target.sequence);
  });
}
