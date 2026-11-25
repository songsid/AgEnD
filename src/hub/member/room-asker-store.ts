/** Optional provenance companion. Never adds a component/field to the legacy selected state set. */
import {createCipheriv,createDecipheriv,createHash,hkdfSync,randomBytes} from 'node:crypto';
import {existsSync,statSync} from 'node:fs';import {join} from 'node:path';
import type Database from 'better-sqlite3';import {z} from 'zod';
import {openHubDatabase} from '../db.js';
import {HubProtocolError,epoch,hash,plain,uuid,validated} from '../validation.js';
import {roomAskerIdentitySchema,type HubRoomAskerIdentity,type RoomAskerDestination,type VerifiedHubAsker} from '../room-asker-identity-model.js';
import {verifyRoomAsker,roomAskerSnapshot,roomAskIdentityDigest,type RoomAskerBinding} from '../room-asker-identity.js';

export const ROOM_ASKER_MAX_ROWS=4096,ROOM_ASKER_MAX_DB_BYTES=32*1024*1024;
const destinationSchema=z.strictObject({agent:plain(256).refine(s=>s.length>0),exposureId:uuid,incarnation:plain(256).refine(s=>s.length>0)});
const savedSchema=z.strictObject({v:z.literal(1),proof:roomAskerIdentitySchema,destination:destinationSchema,journalDigest:hash,admittedAt:epoch});
type Saved=z.infer<typeof savedSchema>;
type Row={message_id:string;phase:'prepared'|'committed';value:string};
export interface RoomAskerAccepted {ask:unknown;destination:RoomAskerDestination;journalDigest:string}
interface Options {
 home:string;binding:string;encryptionKey:Buffer;
 identity:Omit<RoomAskerBinding,'now'|'linkEpoch'|'exposureRevision'>;
 now?:()=>number;maxRows?:number;
}
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
export class HubRoomAskerStore {
 private readonly db:Database.Database;private readonly key:Buffer;private readonly binding:string;private readonly now:()=>number;
 readonly path:string;
 constructor(private readonly options:Options){
  if(options.encryptionKey.length!==32||!options.binding||(options.maxRows!==undefined&&(!Number.isSafeInteger(options.maxRows)||options.maxRows<1||options.maxRows>ROOM_ASKER_MAX_ROWS)))throw new HubProtocolError('invalid');
  this.now=options.now??Date.now;this.binding=createHash('sha256').update(options.binding).digest('hex');
  this.key=Buffer.from(hkdfSync('sha256',options.encryptionKey,Buffer.from(this.binding),Buffer.from('hub-room-asker-companion-v1'),32));
  const rel=`hub/member-room-askers-${this.binding}.sqlite`;this.path=join(options.home,rel);
  const existed=existsSync(this.path);if(existed&&statSync(this.path).size>ROOM_ASKER_MAX_DB_BYTES)throw new HubProtocolError("backpressure");
  const db=this.db=openHubDatabase(options.home,rel,{create:!existed});
  try{
   // A separate, small rollback journal avoids an independently growing WAL. No pragma touches the main DB.
   db.pragma('journal_mode = DELETE');const page=Number(db.pragma('page_size',{simple:true}));
   db.pragma(`max_page_count = ${Math.floor(ROOM_ASKER_MAX_DB_BYTES/page)}`);
   if(existed&&!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='room_asker_companion'").get())throw new HubProtocolError('uncertain');
   if(!existed)db.exec('CREATE TABLE room_asker_companion(message_id TEXT PRIMARY KEY,phase TEXT NOT NULL,value TEXT NOT NULL)');
   if(this.rows().length>this.limit())throw new HubProtocolError('backpressure');
   for(const row of this.rows())this.read(row);
  }catch(error){db.close();throw error;}
 }
 private limit(){return Math.min(ROOM_ASKER_MAX_ROWS,this.options.maxRows??ROOM_ASKER_MAX_ROWS);}
 private rows():Row[]{return this.db.prepare('SELECT * FROM room_asker_companion LIMIT ?').all(this.limit()+1)as Row[];}
 private row(id:string):Row|undefined{return this.db.prepare('SELECT * FROM room_asker_companion WHERE message_id=?').get(id)as Row|undefined;}
 private aad(id:string,phase:string){return Buffer.from(JSON.stringify(['hub-room-asker-companion-v1',this.binding,id,phase]));}
 private read(row:Row):Saved{
  try{
   if(!['prepared','committed'].includes(row.phase))throw Error();
   const bytes=Buffer.from(row.value,'base64');if(bytes.length<28||bytes.length>8192)throw Error();
   const decipher=createDecipheriv('aes-256-gcm',this.key,bytes.subarray(0,12));decipher.setAAD(this.aad(row.message_id,row.phase));decipher.setAuthTag(bytes.subarray(12,28));
   const saved=validated(savedSchema,JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)),decipher.final()]).toString('utf8')));
   if(saved.proof.messageId!==row.message_id||saved.proof.exposureId!==saved.destination.exposureId)throw Error();return saved;
  }catch{throw new HubProtocolError('uncertain');}
 }
 private write(id:string,phase:Row['phase'],saved:Saved){
  const bytes=Buffer.from(JSON.stringify(saved));if(bytes.length>4096)throw new HubProtocolError('backpressure');
  const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',this.key,iv);cipher.setAAD(this.aad(id,phase));const encrypted=Buffer.concat([cipher.update(bytes),cipher.final()]);
  this.db.prepare('INSERT INTO room_asker_companion VALUES(?,?,?) ON CONFLICT(message_id) DO UPDATE SET phase=excluded.phase,value=excluded.value').run(id,phase,Buffer.concat([iv,cipher.getAuthTag(),encrypted]).toString('base64'));
 }
 private matches(saved:Saved,accepted:RoomAskerAccepted){const a=saved.destination,b=accepted.destination;return saved.journalDigest===accepted.journalDigest&&a.agent===b.agent&&a.exposureId===b.exposureId&&a.incarnation===b.incarnation&&saved.proof.contentDigest===roomAskIdentityDigest(accepted.ask);}
 private authenticate(saved:Saved,ask:unknown){return verifyRoomAsker(saved.proof,ask,{...this.options.identity,linkEpoch:saved.proof.linkEpoch,exposureRevision:saved.proof.exposureRevision,now:saved.admittedAt});}
 /** FIRST admission uses our clock. A replay cannot refresh admittedAt/retainedUntil. */
 prepare(input:unknown,accepted:RoomAskerAccepted,current:Pick<RoomAskerBinding,'linkEpoch'|'exposureRevision'>,mode:{replay?:boolean;legacyAbsent?:boolean;canCollect?(messageId:string):boolean}={}):void{
  const admittedAt=this.now();
  // A retained, previously authenticated admission may be retried after transport expiry.
  // Re-signed transport retries must bind the same subject/deadline, and never replace it.
  const candidate=validated(roomAskerIdentitySchema,input),existing=this.row(candidate.messageId);
  if(existing){const saved=this.read(existing);this.authenticate(saved,accepted.ask);if(!same(saved.proof,candidate))verifyRoomAsker(candidate,accepted.ask,{...this.options.identity,...current,now:admittedAt});if(saved.proof.retainedUntil<=admittedAt||!same(saved.proof.subject,candidate.subject)||saved.proof.retainedUntil!==candidate.retainedUntil)throw new HubProtocolError('conflict');
   if(!this.matches(saved,accepted)){
    // The adapter proved there is NO legacy row. Only a prepared orphan can receive the retry's new cid digest.
    // Keep its original verified proof/admittedAt/deadline; this is not a new admission or an input replay.
    const a=saved.destination,b=accepted.destination;
    if(!mode.legacyAbsent||existing.phase!=='prepared'||a.agent!==b.agent||a.exposureId!==b.exposureId||a.incarnation!==b.incarnation)throw new HubProtocolError('conflict');
    this.db.transaction(()=>{const row=this.row(candidate.messageId);if(!row||row.phase!=='prepared'||row.value!==existing.value)throw new HubProtocolError('conflict');this.write(candidate.messageId,'prepared',{...saved,journalDigest:validated(hash,accepted.journalDigest)});}).immediate();
   }return;}
  if(mode.replay)throw new HubProtocolError("denied");
  const proof=verifyRoomAsker(candidate,accepted.ask,{...this.options.identity,...current,now:admittedAt});
  const destination=validated(destinationSchema,accepted.destination);if(proof.exposureId!==destination.exposureId)throw new HubProtocolError('denied');
  this.db.transaction(()=>{
   const old=this.row(proof.messageId);
   if(old){const saved=this.read(old);this.authenticate(saved,accepted.ask);if(!this.matches(saved,accepted)||!same(saved.proof.subject,proof.subject)||saved.proof.retainedUntil!==proof.retainedUntil)throw new HubProtocolError('conflict');return;}
   // Expiry removes identity, never the distinction from legacy input. GC needs an authenticated terminal/absent legacy read.
   for(const row of this.rows())if(this.read(row).proof.retainedUntil<=admittedAt&&mode.canCollect?.(row.message_id)===true)this.db.prepare('DELETE FROM room_asker_companion WHERE message_id=?').run(row.message_id);
   if((this.db.prepare('SELECT count(*) AS n FROM room_asker_companion').get()as{n:number}).n>=this.limit())throw new HubProtocolError('backpressure');
   this.write(proof.messageId,'prepared',{v:1,proof,destination,journalDigest:validated(hash,accepted.journalDigest),admittedAt});
  }).immediate();
 }
 /** Caller supplies a freshly authenticated read of the actually committed legacy row. */
 commit(messageId:string,accepted:RoomAskerAccepted):void{
  this.db.transaction(()=>{const row=this.row(messageId);if(!row)throw new HubProtocolError('uncertain');const saved=this.read(row);this.authenticate(saved,accepted.ask);if(!this.matches(saved,accepted))throw new HubProtocolError('conflict');if(row.phase!=='committed')this.write(messageId,'committed',saved);}).immediate();
 }
 /** No new input may pass a prepared/mismatched row, even if it is retried without the optional wire proof. */
 permitsInput(messageId:string,accepted:RoomAskerAccepted):boolean{
  try{const row=this.row(messageId);if(!row)return true;const saved=this.read(row);this.authenticate(saved,accepted.ask);return row.phase==='committed'&&saved.proof.retainedUntil>this.now()&&this.matches(saved,accepted);}catch{return false;}
 }
 get(messageId:string,accepted:RoomAskerAccepted):VerifiedHubAsker|null{
  try{const row=this.row(messageId);if(!row||row.phase!=='committed')return null;const saved=this.read(row);if(saved.proof.retainedUntil<=this.now()||!this.matches(saved,accepted))return null;this.authenticate(saved,accepted.ask);return roomAskerSnapshot(saved.proof);}catch{return null;}
 }
 /** Recovery never invents a legacy row; it may finish only an exact authenticated two-phase binding. */
 recover(accepted:(messageId:string)=>RoomAskerAccepted|null):void{for(const row of this.rows()){if(row.phase!=='prepared')continue;const current=accepted(row.message_id);if(current)this.commit(row.message_id,current);}}
 close(){this.db.close();this.key.fill(0);}
}
