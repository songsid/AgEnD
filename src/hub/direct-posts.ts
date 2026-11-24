/** Standalone agent messages use room-post authority, never a question's spent answer lease. */
import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { HubHttpMigration } from "./http/schema.js";
import { personFromString, type HubCore } from "./http/core.js";
import { personKeyString } from "./identity.js";
import { readExposure, readGrant, grantOf, grantApplies, exposureOf } from "./catalog.js";
import { HubProtocolError, validated } from "./validation.js";
import { roomPostSchema } from "./protocol.js";
import type { HubLinkContext } from "./server.js";
import type { HubRoomPostResult } from "./types.js";
import {HUB_DIRECT_POST_CAPABILITY} from "./direct-posts-model.js";
export {HUB_DIRECT_POST_CAPABILITY} from "./direct-posts-model.js";
export const HUB_DIRECT_POSTS_MIGRATION: HubHttpMigration = { component:"s3-direct-posts",version:1,up(db) { db.exec(`
CREATE TABLE hub_direct_posts(id TEXT PRIMARY KEY,room_id TEXT NOT NULL REFERENCES hub_rooms(id),sequence INTEGER NOT NULL,
 exposure_id TEXT NOT NULL,fleet_id TEXT NOT NULL,owner TEXT NOT NULL,exposure_revision INTEGER NOT NULL,
 operation_id TEXT NOT NULL,digest TEXT NOT NULL,duplicate_digest TEXT NOT NULL,content_ref TEXT NOT NULL,created_at INTEGER NOT NULL,
 UNIQUE(exposure_id,operation_id),UNIQUE(room_id,sequence));
CREATE INDEX hub_direct_posts_room ON hub_direct_posts(room_id,sequence);
CREATE TABLE hub_direct_post_reads(post_id TEXT PRIMARY KEY REFERENCES hub_direct_posts(id) ON DELETE CASCADE);
CREATE TABLE hub_direct_mutes(room_id TEXT PRIMARY KEY REFERENCES hub_rooms(id) ON DELETE CASCADE,muted INTEGER NOT NULL CHECK(muted IN(0,1)));
`); } };
export function directPostsAvailable(db: Database.Database): boolean { return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='hub_direct_posts'").get(); }
export function nextDirectSequence(db: Database.Database, room: string): number {
  const q=(db.prepare("SELECT MAX(sequence) AS n FROM hub_messages WHERE room_id=?").get(room) as {n:number|null}).n??0;
  const p=directPostsAvailable(db)?(db.prepare("SELECT MAX(sequence) AS n FROM hub_direct_posts WHERE room_id=?").get(room) as {n:number|null}).n??0:0;
  return Math.max(q,p)+1;
}
export interface DirectPostRow {id:string;room_id:string;sequence:number;content_ref:string;created_at:number;exposure_id:string;owner:string;fleet_id:string;exposure_revision:number;operation_id:string;digest:string;duplicate_digest:string}
export class HubDirectPosts {
  constructor(private core:HubCore,private changed:(roomId:string,asker:string,id?:string)=>void) {}
  muted(room:string):boolean {return this.core.atomic(db=>directPostsAvailable(db)&&!!(db.prepare("SELECT muted FROM hub_direct_mutes WHERE room_id=?").get(room) as {muted:number}|undefined)?.muted);}
  setMuted(room:string,asker:string,muted:boolean):void {
    this.core.atomic((db,tx)=>{
      const row=db.prepare("SELECT asker FROM hub_rooms WHERE id=?").get(room) as {asker:string}|undefined;
      if(!row||row.asker!==asker)throw new HubProtocolError("not-found");
      db.prepare("INSERT INTO hub_direct_mutes(room_id,muted) VALUES(?,?) ON CONFLICT(room_id) DO UPDATE SET muted=excluded.muted").run(room,+muted);
      this.core.audit(tx,{actor:{kind:"person",person:personFromString(asker)},requestId:room,result:"completed",action:"direct-messages.mute",roomId:room,reasonCode:muted?"muted":"unmuted"});
    });this.changed(room,asker);
  }
  async rooms(exposureId:string,link:HubLinkContext):Promise<{id:string;name:string;kind:"direct"}[]> {
    const rows=this.core.atomic(db=>db.prepare(`SELECT r.id,r.asker,r.grant_id FROM hub_rooms r JOIN hub_exposures e ON e.id=r.exposure_id
      WHERE r.exposure_id=? AND e.owner=? AND e.fleet_id=? AND r.owner_at_creation=e.owner AND r.state='active' AND EXISTS(SELECT 1 FROM hub_messages m WHERE m.room_id=r.id) ORDER BY r.created_at DESC LIMIT 201`).all(exposureId,personKeyString(link.owner),link.fleetId) as {id:string;asker:string;grant_id:string}[]);
    const out:{id:string;name:string;kind:"direct"}[]=[];
    for(const r of rows){try{
      if(!await this.core.eligible(personFromString(r.asker)))continue;
      const permit=await this.core.exposureGrant(exposureId,r.grant_id,personFromString(r.asker),{requestId:r.id,current:()=>link.current()&&this.core.live()});
      const name=this.core.atomic(db=>{
        const e=readExposure(db,exposureId),g=readGrant(db,r.grant_id);
        if(!e||e.state!=="published"||e.sharing_paused||e.frozen_through>=e.revision||!g||!grantApplies(grantOf(g),exposureOf(e),personFromString(r.asker),this.core.now(),permit.grant))return null;
        return (db.prepare("SELECT display_name FROM hub_people WHERE person=? UNION ALL SELECT display_name FROM hub_room_people WHERE person=? LIMIT 1").get(r.asker,r.asker) as {display_name:string}|undefined)?.display_name??r.asker;
      },permit);if(name!==null)out.push({id:r.id,name,kind:"direct"});
    }catch(error){if(!(error instanceof HubProtocolError))throw error;}}
    return out;
  }
  async post(input:unknown,link:HubLinkContext):Promise<HubRoomPostResult> {
    const body=validated(roomPostSchema,input);
    const refuse=(code:"denied"|"revoked"|"stale"|"not-found"|"conflict",message:string):HubRoomPostResult=>({ok:false,code,message});
    if(!body.direct||![HUB_DIRECT_POST_CAPABILITY,"room-post-v1","room-ask-v1","welcome-caps-v1"].every(f=>link.features.has(f)))return refuse("denied","This Hub does not support agent messages in one-to-one chats.");
    const room=this.core.atomic(db=>db.prepare("SELECT * FROM hub_rooms WHERE id=?").get(body.room) as {id:string;asker:string;exposure_id:string;owner_at_creation:string;grant_id:string;state:string}|undefined);
    if(!room||room.exposure_id!==body.exposureId)return refuse("not-found","Use an existing one-to-one chat from hub_room_list.");
    const current=()=>this.core.live()&&link.current();
    const owned=()=>this.core.atomic(db=>{const e=readExposure(db,body.exposureId);if(!e||e.fleet_id!==link.fleetId||e.owner!==personKeyString(link.owner)||e.owner!==room.owner_at_creation)throw new HubProtocolError("denied");return e;});
    if(!current())return refuse("stale","The sending agent connection is no longer current.");
    const source=owned();
    if(source.state!=="published"||source.frozen_through>=source.revision)return refuse("revoked","This agent is no longer shared; its owner needs to share it again.");
    if(source.sharing_paused)return refuse("denied","The owner paused this agent's sharing.");
    if(!await this.core.eligible(link.owner)||!await this.core.eligible(personFromString(room.asker)))return refuse("revoked","The person or agent owner is no longer active on this Hub.");
    const permit=await this.core.exposureGrant(source.id,room.grant_id,personFromString(room.asker),{requestId:body.idempotencyKey,current});
    const personName=this.core.atomic(db=>(db.prepare("SELECT display_name FROM hub_people WHERE person=?").get(room.asker) as {display_name:string}|undefined)?.display_name??room.asker);
    const digest=createHash("sha256").update(JSON.stringify(body)).digest("hex");
    const duplicate=createHash("sha256").update(JSON.stringify([body.text,(body.attachments??[]).map(f=>f.sha256).sort()])).digest("hex");
    let added=false;
    const result=this.core.atomic((db,tx):HubRoomPostResult=>{
      permit.assertCurrent();if(!current())throw new HubProtocolError("stale");
      const e=owned(),r=db.prepare("SELECT state FROM hub_rooms WHERE id=?").get(room.id) as {state:string};
      if(e.revision!==source.revision||e.state!=="published"||e.frozen_through>=e.revision)return refuse("revoked","This agent's sharing changed; its owner needs to share it again.");
      if(e.sharing_paused)return refuse("denied","The owner paused this agent's sharing.");
      if(r.state!=="active")return refuse("revoked","This one-to-one chat is closed.");
      const g=readGrant(db,room.grant_id);
      if(!g||!grantApplies(grantOf(g),exposureOf(e),personFromString(room.asker),this.core.now(),permit.grant))return refuse("revoked","The person is no longer allowed to ask this agent, or their permission expired.");
      if(!db.prepare("SELECT 1 FROM hub_messages WHERE room_id=? LIMIT 1").get(room.id))return refuse("not-found","The person must ask this agent in this chat first.");
      if(this.muted(room.id))return refuse("denied","The person turned off this agent's own messages in this chat.");
      const old=db.prepare("SELECT * FROM hub_direct_posts WHERE exposure_id=? AND operation_id=?").get(e.id,body.idempotencyKey) as DirectPostRow|undefined;
      if(old){if(old.digest!==digest||old.exposure_revision!==e.revision||old.owner!==e.owner||old.fleet_id!==link.fleetId)return refuse("conflict","This operation already names a different message.");return {ok:true,roomId:room.id,messageId:old.id,at:old.created_at,message:`Delivered to ${personName}.`};}
      const last=db.prepare("SELECT duplicate_digest,created_at FROM hub_direct_posts WHERE room_id=? AND exposure_id=? ORDER BY sequence DESC LIMIT 1").get(room.id,e.id) as {duplicate_digest:string;created_at:number}|undefined;
      const answered=db.prepare("SELECT id,answer_ref,stage_at FROM hub_messages WHERE room_id=? AND exposure_id=? AND answer_ref IS NOT NULL ORDER BY stage_at DESC,sequence DESC LIMIT 1").get(room.id,e.id) as {id:string;answer_ref:string;stage_at:number}|undefined;
      let previous=last;
      if(answered&&(!previous||answered.stage_at>previous.created_at)){
        const answer=this.core.deps.content.get(answered.answer_ref)?.answer;
        const refs=this.core.deps.attachments?.forMessage(db,answered.id,"answer")??[];
        previous=answer===undefined?undefined:{created_at:answered.stage_at,duplicate_digest:createHash("sha256").update(JSON.stringify([answer,refs.map(f=>f.sha256).sort()])).digest("hex")};
      }
      if(previous&&previous.duplicate_digest===duplicate&&this.core.now()-previous.created_at<60_000)return refuse("conflict","This agent already sent the same text and files in this chat within a minute.");
      const id=randomUUID(),at=this.core.now(),ref=this.core.deps.content.put(tx,{answer:body.text});
      if(body.attachments?.length){if(!this.core.deps.attachments)throw new HubProtocolError("unavailable");this.core.deps.attachments.bindAnswer(db,body.attachments,id,room.id,link.fleetId);}
      db.prepare("INSERT INTO hub_direct_posts VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run(id,room.id,nextDirectSequence(db,room.id),e.id,link.fleetId,e.owner,e.revision,body.idempotencyKey,digest,duplicate,ref,at);
      this.core.audit(tx,{actor:{kind:"member",fleetId:link.fleetId},requestId:body.idempotencyKey,result:"completed",action:"direct-message.post",contentRef:ref,roomId:room.id,messageId:id,fleetId:link.fleetId});added=true;
      return {ok:true,roomId:room.id,messageId:id,at,message:`Delivered to ${personName}.`};
    },permit);
    if(added&&result.ok)this.changed(room.id,room.asker,result.messageId);return result;
  }
}
