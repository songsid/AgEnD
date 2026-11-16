/** Refusal feedback is separate from accepted post/answer content and never becomes a question/delivery statistic. */
import type Database from "better-sqlite3";
import {createHash,randomUUID} from "node:crypto";
import type {HubCore} from "../http/core.js";
import type {HubTx} from "../types.js";
import {personFromString} from "../http/core.js";
import {roomMentionFeedbackSchema,type HubRoomMentionFeedback} from "../room-mention-feedback-model.js";
import {HubProtocolError} from "../validation.js";
const hash=(s:string)=>createHash("sha256").update(s).digest("hex");
export function recordPersonalMentionRefusals(core:HubCore,db:Database.Database,tx:HubTx,
  post:{id:string;room_id:string;author_subject:string},sourceId:string,names:readonly string[]):void {
  if(!names.length||!core.deps.personal)return;
  const existing=db.prepare("SELECT 1 FROM hub_personal_mention_refusals WHERE post_id=?").get(post.id);if(existing)return;
  const value=roomMentionFeedbackSchema.parse({id:randomUUID(),refusals:names.map(name=>({code:"personal-people-only",name}))});
  const bytes=JSON.stringify(value),ref=core.deps.content.put(tx,{question:bytes});
  core.audit(tx,{requestId:post.id,actor:{kind:"person",person:personFromString(post.author_subject)},action:"room.mention-refused",result:"denied",
    reasonCode:"personal-people-only",roomId:post.room_id,messageId:post.id,exposureId:sourceId,contentRef:ref});
  db.prepare("INSERT INTO hub_personal_mention_refusals VALUES(?,?,?,?,?)").run(post.id,sourceId,value.id,ref,hash(bytes));
}
export function personalMentionRefusals(core:HubCore,postId:string,sourceId:string):HubRoomMentionFeedback|undefined {
  if(!core.deps.personal)return;
  return core.atomic(db=>{
    const row=db.prepare("SELECT content_ref,digest FROM hub_personal_mention_refusals WHERE post_id=? AND source_exposure_id=?").get(postId,sourceId) as {content_ref:string;digest:string}|undefined;
    if(!row)return;
    const bytes=core.deps.content.get(row.content_ref)?.question;if(bytes===undefined)return;
    if(hash(bytes)!==row.digest)throw new HubProtocolError("uncertain");
    return roomMentionFeedbackSchema.parse(JSON.parse(bytes));
  });
}
