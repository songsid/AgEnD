/** Immediate authenticated author of a retained post. Display projections never mint person identity. */
import type Database from 'better-sqlite3';
import type {RoomPostRow} from './agents.js';
import {personFromString} from '../http/core.js';import {personKeyString} from '../identity.js';
import {roomAskerSchema} from '../room-asker-identity-model.js';
export function roomPostAsker(db:Database.Database,post:RoomPostRow){
 try {
  const operations=db.prepare('SELECT exposure_id,owner,room_id,fleet_id,via_name FROM hub_room_agent_operations WHERE post_id=? LIMIT 2').all(post.id)as{exposure_id:string;owner:string;room_id:string;fleet_id:string;via_name:string|null}[];
  // No product path drops this table. With it absent, ctx.application cannot commit a person-looking post:
  // service.post writes its app companion in the SAME transaction, and a missing table rolls that post back.
  const app=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='hub_mcp_room_posts'").get()
   ? db.prepare('SELECT app_id,app_name FROM hub_mcp_room_posts WHERE post_id=?').get(post.id)as{app_id:string;app_name:string}|undefined:undefined;
  if(operations.length){const op=operations[0]!;if(operations.length!==1||app||op.room_id!==post.room_id||op.owner!==post.author_subject)return null;
   const source=db.prepare('SELECT id,fleet_id,owner,display_name FROM hub_exposures WHERE id=?').get(op.exposure_id)as{id:string;fleet_id:string|null;owner:string;display_name:string}|undefined;
   if(!source||source.owner!==op.owner||(source.fleet_id??'')!==(op.fleet_id??''))return null;
   // On-behalf projections use the operation's frozen via_name: it names the agent, never the displayed person.
   return roomAskerSchema.parse({kind:'agent',id:`exposure/${source.id}`,displayName:op.via_name??(post.author_kind==='agent'?post.author_name:source.display_name)});
  }
  if(app){if(post.author_kind!=='person')return null;const principal=personKeyString(personFromString(post.author_subject));return roomAskerSchema.parse({kind:'assistant',id:`application/${app.app_id}/principal/${principal}`,displayName:app.app_name});}
  if(post.author_kind==='person')return roomAskerSchema.parse({kind:'person',id:personKeyString(personFromString(post.author_subject)),displayName:post.author_name});
  if(post.author_kind==='assistant'&&post.author_id==='assistant'&&post.author_subject==='assistant')return roomAskerSchema.parse({kind:'assistant',id:`room/${post.room_id}/assistant`,displayName:post.author_name});
  if(post.author_kind==='system'&&post.author_id==='poll-closed'&&post.author_subject==='system')return roomAskerSchema.parse({kind:'assistant',id:`room/${post.room_id}/poll`,displayName:'Poll results'});
  if(post.author_kind==='agent'&&post.stage==='answered'&&post.delivery_id){
   // A room answer has its authenticated delivery receipt, not a room.post operation.
   const d=db.prepare("SELECT exposure_id,owner,reply_id,room_id,state,answer_id,sent_epoch FROM hub_room_deliveries WHERE id=?").get(post.delivery_id)as{exposure_id:string;owner:string;reply_id:string;room_id:string;state:string;answer_id:string|null;sent_epoch:number}|undefined;
   if(d&&d.reply_id===post.id&&d.room_id===post.room_id&&d.exposure_id===post.author_id&&d.owner===post.author_subject&&d.state==='answered'&&d.answer_id&&d.sent_epoch>0)
    return roomAskerSchema.parse({kind:'agent',id:`exposure/${d.exposure_id}`,displayName:post.author_name});
  }
  // An agent-looking post without its authenticated operation/answer receipt is not promoted from name/owner fields.
  return null;
 }catch{return null;}
}

export interface RoomAskerDeliveryBinding {parent_id:string;room_id:string;asker:string;asker_member:string;source_exposure_id:string|null}
/** Delivery permission principal and immediate author are distinct for agents/automation, but must have an exact recorded relationship. */
export function roomDeliveryAsker(db:Database.Database,post:RoomPostRow,d:RoomAskerDeliveryBinding){
 try{
  if(post.id!==d.parent_id||post.room_id!==d.room_id)return null;
  const member=db.prepare('SELECT kind,subject FROM hub_room_members WHERE id=? AND room_id=?').get(d.asker_member,d.room_id)as{kind:string;subject:string}|undefined;
  if(!member)return null;
  const subject=roomPostAsker(db,post);if(!subject)return null;
  if(subject.kind==='person'||subject.id.startsWith('application/')){
   if(d.source_exposure_id||d.asker!==post.author_subject||member.kind!=='person'||member.subject!==d.asker||post.author_id!==d.asker_member)return null;
  }else if(subject.kind==='agent'){
   if(d.asker!==post.author_subject||!d.source_exposure_id||subject.id!==`exposure/${d.source_exposure_id}`||member.kind!=='agent'||member.subject!==d.source_exposure_id)return null;
   const op=db.prepare('SELECT member_id FROM hub_room_agent_operations WHERE post_id=?').get(post.id)as{member_id:string}|undefined;
   if(op&&op.member_id!==d.asker_member)return null;
  }else if(subject.id===`room/${post.room_id}/poll`){
   const original=db.prepare("SELECT d.asker,d.asker_member FROM hub_room_buttons b JOIN hub_room_deliveries d ON d.id=b.delivery_id WHERE b.result_post=? AND b.room_id=? AND b.state='closed'").get(post.id,post.room_id)as{asker:string;asker_member:string}|undefined;
   if(d.source_exposure_id||!original||original.asker!==d.asker||original.asker_member!==d.asker_member)return null;
  }else if(subject.id===`room/${post.room_id}/assistant`){
   const original=db.prepare("SELECT asker,asker_member FROM hub_room_assistant_calls WHERE id=? AND reply_id=? AND room_id=? AND state='answered'").get(post.delivery_id??'',post.id,post.room_id)as{asker:string;asker_member:string}|undefined;
   if(d.source_exposure_id||!original||original.asker!==d.asker||original.asker_member!==d.asker_member)return null;
  }else return null;
  return subject;
 }catch{return null;}
}
