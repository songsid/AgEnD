/** Seam-1 projections keep the direct service's grant, execution and receipt machinery intact. */
import { directPostsAvailable } from "../direct-posts.js";
import type { HubRoomEntryView, HubRoomListItem } from "../rooms.js";
import type { RoomMessage } from "./types.js";
import { personKeyString } from "../identity.js";
import type { HubCore } from "../http/core.js";
import { HubProtocolError } from "../validation.js";

export function directRoomView(room: HubRoomListItem, presence: "idle" | "working" | "paused" | "offline" | "later" = "offline", unread = 0, intro: {intro?:string} = {}, reported = false) {
  return { ...room, kind: "direct" as const, name: room.exposureName, people: 1, agents: 1, online: presence === "idle" || presence === "working" ? 1 : 0, unread,
    lastText: "", lastAuthor: "", archived: room.state === "closed",
    agent: { ...intro, ...(room.answerOnly?{answerOnly:true}:{}), ...(room.agentKind?{agentKind:room.agentKind}:{}), exposureId: room.exposureId, owner: { name: room.ownerName }, presence, ...(reported ? { reported: true } : {}) } };
}
export function directMessages(room: HubRoomListItem, entries: readonly HubRoomEntryView[], askerName: string): RoomMessage[] {
  return entries.flatMap(entry => {
    const base = { roomId: room.id, mentions: [] as string[] };
    if(entry.ownPost)return [{...base,id:entry.messageId,at:entry.receipt.at,author:{kind:"agent" as const,id:room.exposureId,name:room.exposureName,owner:{name:room.ownerName}},text:entry.answer??"",...(entry.answerFiles?.length?{files:entry.answerFiles}:{})}];
    const question: RoomMessage = { ...base, id: entry.messageId, at: entry.askedAt ?? entry.receipt.at,
      author: { kind: "person", id: personKeyString(room.asker), name: askerName,...(entry.via?{via:{...entry.via,kind:"app" as const}}:{}) }, text: entry.question ?? "",
      stage: entry.receipt.stage === "answered" ? "answered" : ["queued", "delivered", "consumed"].includes(entry.receipt.stage) ? "working" : "not-answered",
      ...(entry.receipt.reasonCode === "owner-declined" ? { reasonCode: "owner-declined" as const } : {}),
      ...(entry.receipt.reasonCode === "share-needs-reshare" ? { reasonCode: "share-needs-reshare" as const } : {}),
      ...(entry.idempotencyKey ? { idempotencyKey: entry.idempotencyKey } : {}), ...(entry.questionFiles?.length ? { files: entry.questionFiles } : {}) };
    const agent = { kind: "agent" as const, id: room.exposureId, name: room.exposureName, owner: { name: room.ownerName } };
    // M-3596: an open question's answer row before it has text, as a group room's (the thread's work bar reads it): working
    // once the agent was handed it, else queued (with how many open questions to it came first). The answer replaces it.
    const pending: RoomMessage[] = entry.answer === undefined && question.stage === "working" && (entry.startedAt !== undefined || entry.ahead !== undefined)
      ? [{ ...base, id: `${entry.messageId}:answer`, at: entry.startedAt ?? question.at, author: agent, text: "", answerTo: entry.messageId,
        stage: entry.startedAt !== undefined ? "working" : "queued", ...(entry.startedAt !== undefined ? { startedAt: entry.startedAt } : { ahead: entry.ahead }) }]
      : [];
    return [question, ...pending, ...(entry.answer === undefined ? [] : [{ ...base, id: `${entry.messageId}:answer`, at: entry.receipt.at,
      author: agent, text: entry.answer,
      replyTo: entry.messageId, ...(entry.answerFiles?.length ? { files: entry.answerFiles } : {}) }])];
  });
}

/** A late answer is unread even when its question predates the last read action. */
export function directUnread(core: HubCore, room: HubRoomListItem): number {
  if (room.state !== "active") return 0;
  return core.atomic(db => (directPostsAvailable(db)?(db.prepare("SELECT COUNT(*) AS n FROM hub_direct_posts p WHERE room_id=? AND NOT EXISTS(SELECT 1 FROM hub_direct_post_reads r WHERE r.post_id=p.id)").get(room.id) as {n:number}).n:0)+(db.prepare(`SELECT COUNT(*) AS n FROM hub_messages m WHERE m.room_id=? AND m.answer_id IS NOT NULL AND NOT EXISTS
    (SELECT 1 FROM hub_direct_room_reads r WHERE r.room_id=m.room_id AND r.message_id=m.id AND r.answer_id=m.answer_id)`).get(room.id) as { n: number }).n);
}
export function markDirectRead(core: HubCore, roomId: string, upTo: string): void {
  core.atomic(db => {
    const answer = upTo.endsWith(":answer"), id = upTo.replace(/:answer$/, "");
    const own=directPostsAvailable(db)?db.prepare("SELECT sequence FROM hub_direct_posts WHERE room_id=? AND id=?").get(roomId,id) as {sequence:number}|undefined:undefined;
    const target = own??db.prepare("SELECT sequence,answer_id FROM hub_messages WHERE room_id=? AND id=?").get(roomId, id) as { sequence: number; answer_id: string | null } | undefined;
    if (!target || answer && !("answer_id" in target&&target.answer_id)) throw new HubProtocolError("not-found");
    if(directPostsAvailable(db))db.prepare(`INSERT OR IGNORE INTO hub_direct_post_reads(post_id) SELECT id FROM hub_direct_posts WHERE room_id=? AND sequence${own||answer?"<=":"<"}?`).run(roomId,target.sequence);
    db.prepare(`INSERT INTO hub_direct_room_reads(room_id,message_id,answer_id)
      SELECT room_id,id,answer_id FROM hub_messages WHERE room_id=? AND sequence${own || answer ? "<=" : "<"}? AND answer_id IS NOT NULL
      ON CONFLICT(room_id,message_id) DO UPDATE SET answer_id=excluded.answer_id`).run(roomId, target.sequence);
  });
}
