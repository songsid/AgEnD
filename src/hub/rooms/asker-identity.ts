/** Immediate authenticated author of a retained post. Display projections never mint person identity. */
import type Database from 'better-sqlite3';
import type {RoomPostRow} from './agents.js';
import {personFromString} from '../http/core.js';import {personKeyString} from '../identity.js';
import {roomAskerSchema} from '../room-asker-identity-model.js';
export function roomPostAsker(db:Database.Database,post:RoomPostRow){
 try {
  const operations=db.prepare('SELECT exposure_id,owner,room_id,fleet_id,via_name FROM hub_room_agent_operations WHERE post_id=? LIMIT 2').all(post.id)as{exposure_id:string;owner:string;room_id:string;fleet_id:string;via_name:string|null}[];
  const app=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='hub_mcp_room_posts'").get()
   ? db.prepare('SELECT app_id,app_name FROM hub_mcp_room_posts WHERE post_id=?').get(post.id)as{app_id:string;app_name:string}|undefined:undefined;
  if(operations.length){const op=operations[0]!;if(operations.length!==1||app||op.room_id!==post.room_id||op.owner!==post.author_subject)return null;
   const source=db.prepare('SELECT id,fleet_id,owner,display_name FROM hub_exposures WHERE id=?').get(op.exposure_id)as{id:string;fleet_id:string|null;owner:string;display_name:string}|undefined;
   if(!source||source.owner!==op.owner||(source.fleet_id??'')!==(op.fleet_id??''))return null;
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
