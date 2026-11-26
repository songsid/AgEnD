/** B-owned exact return bindings. No production owner installs this before L. */
import type Database from "better-sqlite3";
import {z} from "zod";
import {RequestContextStore,requestContextDigest,requestContextJson,type RequestContextOperationRecord} from "./request-context-store.js";
import type {RequestContextV1} from "./request-context-protocol.js";
import {assertRequestContextRootOpen} from "./request-context-fence.js";
export const REQUEST_CONTEXT_RETURNS_TABLE="request_context_returns_v1";
const RETURN_GUARD="agend_rc_returns_v1_operation_guard",RETURN_VERSION_FUNCTION="agend_request_context_return_version";
const guardSql=`CREATE TRIGGER ${RETURN_GUARD} BEFORE INSERT ON request_context_operations_v1 BEGIN SELECT CASE WHEN COALESCE(${RETURN_VERSION_FUNCTION}(),0)<1 THEN RAISE(ABORT,'request-context return dispatcher required') END; END`;
function artifacts(db:Database.Database):Array<{name:string;sql:string}>{return db.prepare("SELECT name,sql FROM sqlite_master WHERE name IN (?,?,?) OR (type='trigger' AND substr(name,1,20)='agend_rc_returns_v1_')").all(REQUEST_CONTEXT_RETURNS_TABLE,"request_context_one_open_return_v1",RETURN_GUARD)as Array<{name:string;sql:string}>;}
export function registerRequestContextReturnDispatcher(db:Database.Database,version:number):void {if(version!==0&&version!==1)throw Error("request-context return dispatcher is unsupported");db.function(RETURN_VERSION_FUNCTION,{deterministic:true},()=>version);}

const text=z.string().min(1).max(512),peer=z.strictObject({instance:text,incarnation:text});
const recordSchema=z.strictObject({requestDeliveryId:z.uuid(),rootContextId:z.uuid(),requesterContextId:z.uuid(),requester:peer,responder:peer,receivingChildContextId:z.uuid(),selector:text,
 state:z.enum(["open","answered","closed"]),responseOperationId:text.nullable(),responseDeliveryId:z.uuid().nullable(),closeReason:z.enum(["not-delivered","work-closed","generation-retired"]).nullable()});
export type RequestContextReturnRecord=z.infer<typeof recordSchema>;
export function requestContextDeliveryChildId(deliveryId:string,target:{instance:string;incarnation:string}):string {
 const digits=requestContextDigest(["admitted-delivery-v1",deliveryId,target]).slice(0,32).split("");digits[12]="8";digits[16]=((parseInt(digits[16]!,16)&3)|8).toString(16);const value=digits.join("");
 return `${value.slice(0,8)}-${value.slice(8,12)}-${value.slice(12,16)}-${value.slice(16,20)}-${value.slice(20)}`;
}
const exists=(db:Database.Database)=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(REQUEST_CONTEXT_RETURNS_TABLE);
export function assertRequestContextReturnsCompatibility(db:Database.Database,version:number):void {
 const rows=artifacts(db);if(version!==0&&version!==1||rows.length&&(version!==1||rows.length!==3||!rows.some(row=>row.name===REQUEST_CONTEXT_RETURNS_TABLE)))throw Error("request-context return dispatcher is unsupported");
}
export class RequestContextReturns {
 private readonly contexts:RequestContextStore;
 private validateSchema:()=>void=()=>{};private schemaVersion=-1;
 constructor(private readonly db:Database.Database,private readonly ready:()=>void,private readonly readOnly=false){ready();this.contexts=new RequestContextStore(db);
  const tableSql=`CREATE TABLE ${REQUEST_CONTEXT_RETURNS_TABLE} (
   request_delivery_id TEXT PRIMARY KEY REFERENCES request_context_operations_v1(delivery_id),root_context_id TEXT NOT NULL REFERENCES request_contexts_v1(context_id),requester_context_id TEXT NOT NULL REFERENCES request_contexts_v1(context_id),
   requester_instance TEXT NOT NULL,responder_instance TEXT NOT NULL,selector TEXT NOT NULL,state TEXT NOT NULL,
   response_operation_id TEXT UNIQUE,response_delivery_id TEXT UNIQUE REFERENCES request_context_operations_v1(delivery_id),record_json TEXT NOT NULL,record_sha256 TEXT NOT NULL)`,indexSql=`CREATE UNIQUE INDEX request_context_one_open_return_v1 ON ${REQUEST_CONTEXT_RETURNS_TABLE}(requester_instance,responder_instance,selector) WHERE state='open'`;
  const normalized=(value:string)=>value.replace(/\s+/g," ").trim().replace(/;$/,"");
  this.validateSchema=()=>{
   const schema=artifacts(db),expected=new Map([[REQUEST_CONTEXT_RETURNS_TABLE,tableSql],["request_context_one_open_return_v1",indexSql],[RETURN_GUARD,guardSql]]);
   if(schema.length!==3||schema.some(row=>!expected.has(row.name)||normalized(row.sql)!==normalized(expected.get(row.name)!)))throw Error("request-context return schema unavailable");
   if((db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name IN ('request_contexts_v1','request_context_operations_v1')").get()as {n:number}).n!==2)throw Error("request-context return parent schema unavailable");
   this.schemaVersion=Number(db.pragma("schema_version",{simple:true}));
  };
  if(!artifacts(db).length){
   if(readOnly)throw Error("request-context return schema unavailable");
   if((db.prepare(`SELECT ${RETURN_VERSION_FUNCTION}() version`).get()as {version:number}).version!==1)throw Error("request-context return dispatcher is unsupported");
   this.contexts.initialize();db.transaction(()=>{db.exec(tableSql);db.exec(indexSql);db.exec(guardSql);})();
  }
  this.validateSchema();
 }
 private checkedSchema():void {if(Number(this.db.pragma("schema_version",{simple:true}))!==this.schemaVersion)this.validateSchema();}
 private writable():void {this.ready();this.checkedSchema();if((this.db.prepare(`SELECT ${RETURN_VERSION_FUNCTION}() version`).get()as {version:number}).version!==1)throw Error("request-context return dispatcher is unsupported");if(this.readOnly)throw Error("request-context return reader is read-only");}
 private delivery(id:string):{state:string;payload:Record<string,unknown>;correlationId:string|null;targetSession:string|null} {
  const row=this.db.prepare("SELECT state,payload_json,correlation_id,target_session FROM deliveries WHERE delivery_id=?").get(id)as {state:string;payload_json:string;correlation_id:string|null;target_session:string|null}|undefined;
  if(!row)throw Error("request-context return delivery unavailable");return {state:row.state,payload:JSON.parse(row.payload_json),correlationId:row.correlation_id,targetSession:row.target_session};
 }
 private expected(op:RequestContextOperationRecord):Omit<RequestContextReturnRecord,"state"|"responseOperationId"|"responseDeliveryId"|"closeReason"> {
  const delivery=this.delivery(op.deliveryId),meta=delivery.payload.meta as Record<string,unknown>|undefined;
  if(!delivery.correlationId||delivery.targetSession&&delivery.targetSession!==op.binding.target.instance||meta?.from_instance&&meta.from_instance!==op.binding.source.instance)throw Error("request-context return session is not covered");
  return {requestDeliveryId:op.deliveryId,rootContextId:op.binding.rootContextId,requesterContextId:op.binding.contextId,requester:op.binding.source,responder:op.binding.target,receivingChildContextId:requestContextDeliveryChildId(op.deliveryId,op.binding.target),selector:delivery.correlationId};
 }
 private read(id:string):RequestContextReturnRecord|null {
  this.checkedSchema();
  const row=this.db.prepare(`SELECT * FROM ${REQUEST_CONTEXT_RETURNS_TABLE} WHERE request_delivery_id=?`).get(id)as Record<string,unknown>|undefined;if(!row)return null;
  const value=recordSchema.parse(JSON.parse(String(row.record_json))),op=this.contexts.forDelivery(id);
  if(!op||requestContextDigest(value)!==row.record_sha256||value.requestDeliveryId!==row.request_delivery_id||value.rootContextId!==row.root_context_id||value.requesterContextId!==row.requester_context_id||value.requester.instance!==row.requester_instance||value.responder.instance!==row.responder_instance||value.selector!==row.selector||value.state!==row.state||value.responseOperationId!==row.response_operation_id||value.responseDeliveryId!==row.response_delivery_id)throw Error("request-context return binding unavailable");
  const {state,responseOperationId,responseDeliveryId,closeReason,...immutable}=value;
  if(requestContextDigest(immutable)!==requestContextDigest(this.expected(op))||state==="open"&&(responseOperationId!==null||responseDeliveryId!==null||closeReason!==null)||state==="answered"&&(!responseOperationId||!responseDeliveryId||closeReason!==null)||state==="closed"&&(!closeReason||responseOperationId!==null||responseDeliveryId!==null))throw Error("request-context return binding conflict");
  if(state==="answered"){
   const response=this.contexts.operation(value.responder.instance,responseOperationId!);
   if(!response||response.deliveryId!==responseDeliveryId||response.binding.rootContextId!==value.rootContextId||response.binding.source.incarnation!==value.responder.incarnation||response.binding.target.instance!==value.requester.instance||response.binding.target.incarnation!==value.requester.incarnation)throw Error("request-context return response unavailable");
  }
  return value;
 }
 private write(value:RequestContextReturnRecord):void {
  this.writable();
  const checked=recordSchema.parse(value),json=requestContextJson(checked),hash=requestContextDigest(checked);
  this.db.prepare(`UPDATE ${REQUEST_CONTEXT_RETURNS_TABLE} SET state=?,response_operation_id=?,response_delivery_id=?,record_json=?,record_sha256=? WHERE request_delivery_id=?`).run(checked.state,checked.responseOperationId,checked.responseDeliveryId,json,hash,checked.requestDeliveryId);
 }
 private descends(contextId:string,expected:string):boolean {
  const seen=new Set<string>();for(let id:string|undefined=contextId;id;){if(id===expected)return true;if(seen.has(id)||seen.size>=256)throw Error("request-context return lineage unavailable");seen.add(id);const context=this.contexts.context(id);if(!context)throw Error("request-context return lineage unavailable");id=context.ref.parentContextId;}return false;
 }
 /** Called in the same transaction as the actual B operation, never for a held-only image. */
 admitted(op:RequestContextOperationRecord,context:RequestContextV1,inserted:boolean):void {
  this.writable();assertRequestContextRootOpen(this.db,op.binding.rootContextId);const delivery=this.delivery(op.deliveryId),meta=delivery.payload.meta as Record<string,unknown>|undefined;
  const bearing=op.binding.verb==="request_information"||op.binding.verb==="send_to_instance"&&meta?.requires_reply==="true";
  if(bearing){
   const previous=this.read(op.deliveryId),expected=this.expected(op);
   if(previous){const {state,responseOperationId,responseDeliveryId,closeReason,...immutable}=previous;if(requestContextDigest(expected)!==requestContextDigest(immutable))throw Error("request-context return registration conflict");}
   else {
    if(!inserted)throw Error("request-context return registration missing");
    const open=this.db.prepare(`SELECT request_delivery_id FROM ${REQUEST_CONTEXT_RETURNS_TABLE} WHERE requester_instance=? AND responder_instance=? AND selector=? AND state='open'`).get(expected.requester.instance,expected.responder.instance,expected.selector);
    if(open)throw Error("request-context return selector already pending");
    if((this.db.prepare(`SELECT COUNT(*) n FROM ${REQUEST_CONTEXT_RETURNS_TABLE} WHERE state='open'`).get()as {n:number}).n>=4096)throw Error("request-context return capacity reached");
    const record:RequestContextReturnRecord={...expected,state:"open",responseOperationId:null,responseDeliveryId:null,closeReason:null};
    this.db.prepare(`INSERT INTO ${REQUEST_CONTEXT_RETURNS_TABLE} VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(record.requestDeliveryId,record.rootContextId,record.requesterContextId,record.requester.instance,record.responder.instance,record.selector,record.state,null,null,requestContextJson(record),requestContextDigest(record));
   }
  }
  if(op.binding.verb!=="report_result"||!delivery.correlationId)return;
  const own=this.db.prepare(`SELECT request_delivery_id FROM ${REQUEST_CONTEXT_RETURNS_TABLE} WHERE response_operation_id=?`).get(op.binding.operationId)as {request_delivery_id:string}|undefined;
  if(own){const row=this.read(own.request_delivery_id)!;if(row.responseDeliveryId!==op.deliveryId||row.responder.instance!==op.binding.source.instance)throw Error("request-context return operation conflict");return;}
  const candidates=this.db.prepare(`SELECT request_delivery_id FROM ${REQUEST_CONTEXT_RETURNS_TABLE} WHERE requester_instance=? AND responder_instance=? AND selector=? AND root_context_id=?`).all(op.binding.target.instance,op.binding.source.instance,delivery.correlationId,op.binding.rootContextId)as Array<{request_delivery_id:string}>;
  const matched=candidates.map(row=>this.read(row.request_delivery_id)!).filter(row=>this.descends(context.ref.contextId,row.receivingChildContextId));
  if(!matched.length)return; // An ordinary same-root report is not claimed as an expected return.
  const open=matched.filter(row=>row.state==="open");if(open.length!==1)throw Error(open.length?"request-context return is ambiguous":"request-context return already completed");const row=open[0]!;
  if(row.responder.incarnation!==op.binding.source.incarnation||row.requester.incarnation!==op.binding.target.incarnation||delivery.targetSession&&delivery.targetSession!==row.requester.instance||meta?.from_instance&&meta.from_instance!==row.responder.instance||["failed","cancelled"].includes(this.delivery(row.requestDeliveryId).state))throw Error("request-context return peer is no longer current");
  const changed=this.db.prepare(`UPDATE ${REQUEST_CONTEXT_RETURNS_TABLE} SET state='answered',response_operation_id=?,response_delivery_id=? WHERE request_delivery_id=? AND state='open'`).run(op.binding.operationId,op.deliveryId,row.requestDeliveryId).changes;
  if(changed!==1)throw Error("request-context return already completed");this.write({...row,state:"answered",responseOperationId:op.binding.operationId,responseDeliveryId:op.deliveryId});
 }
 parentForResponse(deliveryId:string):RequestContextReturnRecord|null {
  const found=this.db.prepare(`SELECT request_delivery_id FROM ${REQUEST_CONTEXT_RETURNS_TABLE} WHERE response_delivery_id=?`).get(deliveryId)as {request_delivery_id:string}|undefined;return found?this.read(found.request_delivery_id):null;
 }
 get(requestDeliveryId:string):RequestContextReturnRecord|null{return this.read(requestDeliveryId);}
 close(requestDeliveryId:string,reason:"work-closed"|"generation-retired",proof:(row:Readonly<RequestContextReturnRecord>)=>boolean):void {
  this.writable();this.db.transaction(()=>{const row=this.read(requestDeliveryId);if(!row)throw Error("request-context return not found");if(row.state!=="open")return;if(!proof(Object.freeze(structuredClone(row))))throw Error("request-context return closure unproved");this.write({...row,state:"closed",closeReason:reason});if(!proof(Object.freeze(structuredClone(row))))throw Error("request-context return closure changed");})();
 }
 closeNonDelivery(root:string):void {
  this.writable();
  for(const {request_delivery_id:id}of this.db.prepare(`SELECT request_delivery_id FROM ${REQUEST_CONTEXT_RETURNS_TABLE} WHERE root_context_id=? AND state='open'`).all(root)as Array<{request_delivery_id:string}>){const row=this.read(id)!;if(["failed","cancelled"].includes(this.delivery(id).state))this.write({...row,state:"closed",closeReason:"not-delivered"});}
 }
 /** Read-only drain view: a proven failed/cancelled request cannot retain an expected answer. */
 blockers(root:string):string[]{
  const blockers:string[]=[];
  for(const {request_delivery_id:id}of this.db.prepare(`SELECT request_delivery_id FROM ${REQUEST_CONTEXT_RETURNS_TABLE} WHERE root_context_id=?`).all(root)as Array<{request_delivery_id:string}>){
   const row=this.read(id)!;if(row.state==="open"&&!["failed","cancelled"].includes(this.delivery(id).state))blockers.push(`expected-return:${row.requestDeliveryId}`);
   if(blockers.length>=65)break;
  }
  return blockers;
 }
}
/** F reads only; never initializes H tables while OFF. Malformed/unavailable state remains a blocker. */
export function requestContextReturnBlockers(db:Database.Database,root:string):string[]{
 if(!artifacts(db).length)return [];
 try{return new RequestContextReturns(db,()=>{},true).blockers(root);}catch{return ["expected-returns-unavailable"];}
}
