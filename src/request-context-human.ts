/** Accepted human ingress is retained separately from the strict receipt format, before input intent. */
import type Database from "better-sqlite3";
import { z } from "zod";
import { getHumanReceipt, humanBodyHash, isWebSessionIdentity, type HumanOrigin } from "./human-delivery-receipts.js";
import { RequestContextV1Schema, type RequestContextV1 } from "./request-context-protocol.js";
import { RequestContextStore, requestContextDigest, requestContextJson } from "./request-context-store.js";
const TABLE="request_context_human_inputs_v1";
const routeSchema=z.strictObject({kind:z.enum(["room","web","instance"]),adapterId:z.string().max(256).optional(),chatId:z.string().max(256).optional(),threadId:z.string().max(256).optional(),messageId:z.string().max(256).optional(),sessionHandle:z.string().regex(/^[a-f0-9]{16}$/).optional()});
const classicSchema=z.strictObject({adapterId:z.string().min(1).max(256),roomId:z.string().min(1).max(256),kind:z.enum(["guild","group","user"]),id:z.string().min(1).max(256),restrictedAtAdmission:z.boolean(),path:z.literal("registered-room")});
export type RequestHumanClassicBasis=Readonly<z.infer<typeof classicSchema>>;
export type RequestHumanRoute=Readonly<z.infer<typeof routeSchema>>;
export interface RequestHumanAdmissionFacts {
 readonly incarnation:string;
 /** Actual accepted room policy, not a field from the incoming body or agent metadata. Null is ordinary Fleet ingress. */
 readonly room:Readonly<{restricted:boolean}>|null;
 /** Required for web input, captured from the admitted SessionRecord by its producer. */
 readonly web:Readonly<{guest:boolean}>|null;
 readonly route:RequestHumanRoute;
 readonly classic?:Readonly<Omit<RequestHumanClassicBasis,"restrictedAtAdmission"|"path">>|null;
 /** Resolve only configured/live platform namespaces, never parse an adapter's display name. */
 platform(adapterId:string):"discord"|"telegram"|null;
}
export function requestHumanContextId(receiptId:string,kind:"root"|"audience"="root"):string {
 z.uuid().parse(receiptId);const chars=requestContextDigest(["human-input-v1",kind,receiptId]).slice(0,32).split("");
 chars[12]="8";chars[16]=((parseInt(chars[16]!,16)&3)|8).toString(16);const s=chars.join("");
 return `${s.slice(0,8)}-${s.slice(8,12)}-${s.slice(12,16)}-${s.slice(16,20)}-${s.slice(20)}`;
}
function evidence(row:NonNullable<ReturnType<typeof getHumanReceipt>>):string {
 return requestContextDigest([row.receipt_id,row.message_id,row.target_instance,row.original_sha256,row.origin_json,row.authority_json,row.input_kind]);
}
export class RequestHumanInputStore {
 constructor(private readonly db:Database.Database,private readonly writable:()=>void){}
 read(receiptId:string):Readonly<{context:RequestContextV1;route:RequestHumanRoute}>|null {
  z.uuid().parse(receiptId);
  if(!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(TABLE))return null;
  const saved=this.db.prepare(`SELECT root_id,image_json,image_sha256 FROM ${TABLE} WHERE receipt_id=?`).get(receiptId) as {root_id:string;image_json:string;image_sha256:string}|undefined;
  if(!saved)return null;
  const receipt=getHumanReceipt(this.db,receiptId),image=z.strictObject({receiptEvidence:z.string(),context:RequestContextV1Schema,route:routeSchema,classic:classicSchema.nullable()}).parse(JSON.parse(saved.image_json));
  const retained=new RequestContextStore(this.db).context(image.context.ref.contextId);
  if(saved.root_id!==image.context.ref.rootContextId||!receipt||evidence(receipt)!==image.receiptEvidence||humanBodyHash(receipt.original_body)!==receipt.original_sha256
    ||requestContextDigest(image)!==saved.image_sha256||!retained||requestContextJson(retained)!==requestContextJson(image.context)
    ||image.context.rootEvidenceRef!==`human:${receipt.message_id}`||image.context.ref.contextId!==requestHumanContextId(receiptId)
    ||image.context.source.instance!==receipt.target_instance||image.context.sourceAudience.ref!==requestHumanContextId(receiptId,"audience")
    ||image.context.sourceAudience.kind!==image.route.kind)throw Error("Accepted human input evidence is unavailable");
  return Object.freeze({context:retained,route:Object.freeze(image.route)});
 }
 /** Historical SDK basis; like read(), this is evidence, never current membership or an active lease. */
 classicBasis(receiptId:string):RequestHumanClassicBasis|null {
  if(!this.read(receiptId))return null;
  const row=this.db.prepare(`SELECT image_json FROM ${TABLE} WHERE receipt_id=?`).get(receiptId) as {image_json:string};
  const classic=JSON.parse(row.image_json).classic;return classic===null?null:Object.freeze(classicSchema.parse(classic));
 }
 /** The owning outbox wraps receipt creation and this capture in one transaction. */
 record(receiptId:string,facts:RequestHumanAdmissionFacts):Readonly<{context:RequestContextV1;route:RequestHumanRoute}> {
  this.writable();
  return this.db.transaction(()=>{
   const receipt=getHumanReceipt(this.db,receiptId);if(!receipt)throw Error("Accepted human receipt is unavailable");
   const origin=JSON.parse(receipt.origin_json) as HumanOrigin,authority=receipt.authority_json?JSON.parse(receipt.authority_json):null,route=routeSchema.parse(facts.route);
   if(origin.platform==="web"&&(!facts.web||route.kind!=="web")||origin.platform!=="web"&&facts.web!==null)throw Error("Accepted human ingress is unavailable");
   const classic=facts.classic?classicSchema.parse({...facts.classic,restrictedAtAdmission:facts.room?.restricted,path:"registered-room"}):null;
   if(origin.platform!=="web"&&facts.room&&!classic||classic&&(!facts.room||origin.platform==="web"||classic.adapterId!==origin.adapter_id
     ||(origin.platform==="discord"?classic.kind!=="guild":classic.kind==="guild")||classic.kind==="user"&&classic.id!==origin.user_id))throw Error("Accepted Classic admission basis is unavailable");
   let actor:RequestContextV1["initiatingActor"]={kind:"unknown",reason:"unidentified"};
   const identity=origin.platform==="web"&&isWebSessionIdentity(origin.web_identity)?origin.web_identity:null;
   const native=origin.platform!=="web"&&origin.adapter_id&&origin.user_id?{platform:origin.platform,userId:origin.user_id}:null;
   const webActor:{platform:"discord"|"telegram"|"host"|null;userId:string}|null=identity?{platform:identity.platform,userId:identity.user_id}
    :origin.platform==="web"&&["web-verified","web-guest"].includes(authority?.kind)&&authority.actor
     ?{platform:authority.actor.adapter_id==="host"&&authority.actor.user_id==="operator"?"host":facts.platform(authority.actor.adapter_id),userId:authority.actor.user_id}:null;
   const person=native??webActor;
   if(person?.platform)actor={kind:"person",platform:person.platform,userId:person.userId};
   const ingress:RequestContextV1["ingress"]=(facts.web?.guest||authority?.kind==="web-guest")?"guest":actor.kind==="unknown"?"restricted-room":facts.room?facts.room.restricted?"restricted-room":"free-room":"owner";
   const id=requestHumanContextId(receiptId),context=RequestContextV1Schema.parse({ref:{version:1,contextId:id,rootContextId:id},rootEvidenceRef:`human:${receipt.message_id}`,initiatingActor:actor,ingress,
    source:{instance:receipt.target_instance,incarnation:facts.incarnation},sourceAudience:{kind:route.kind,ref:requestHumanContextId(receiptId,"audience")}});
   const image={receiptEvidence:evidence(receipt),context,route,classic},previous=this.read(receiptId);
   if(previous){const saved=this.db.prepare(`SELECT image_sha256 FROM ${TABLE} WHERE receipt_id=?`).get(receiptId) as {image_sha256:string};if(saved.image_sha256!==requestContextDigest(image))throw Error("Accepted human input changed");return previous;}
   if(receipt.state!=="queued"||receipt.owner_key!==null||receipt.wire_body!==null||receipt.proof_tag!==null)throw Error("Human ingress must be captured before input");
   new RequestContextStore(this.db).recordContext(context);
   this.db.exec(`CREATE TABLE IF NOT EXISTS ${TABLE}(receipt_id TEXT PRIMARY KEY REFERENCES human_delivery_receipts(receipt_id) ON DELETE CASCADE,root_id TEXT NOT NULL UNIQUE REFERENCES request_contexts_v1(context_id),image_json TEXT NOT NULL,image_sha256 TEXT NOT NULL)`);
   this.db.prepare(`INSERT INTO ${TABLE} VALUES (?,?,?,?)`).run(receiptId,context.ref.rootContextId,requestContextJson(image),requestContextDigest(image));
   this.writable();return this.read(receiptId)!;
  })();
 }
}

/** An accepted but unproven human input is a durable work reference; an age timer never settles it. */
export function requestHumanInputBlockers(db:Database.Database,rootId:string):string[]{
 if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(TABLE))return [];
 const rows=db.prepare(`SELECT receipt_id FROM ${TABLE} WHERE root_id=? LIMIT 65`).all(rootId) as Array<{receipt_id:string}>;
 const store=new RequestHumanInputStore(db,()=>{throw Error("Read-only human input inspection");});
 return rows.flatMap(row=>{
  const input=store.read(row.receipt_id),receipt=getHumanReceipt(db,row.receipt_id);
  if(!input||!receipt)throw Error("Accepted human input evidence is unavailable");
  return receipt.state==="delivered"?[]:[`human-input:${receipt.message_id}`];
 });
}
