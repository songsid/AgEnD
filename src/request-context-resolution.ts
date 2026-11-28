/** Explicit owner abandonment; never delivery, permission, D1 or replay evidence. */
import type Database from "better-sqlite3";
import {z} from "zod";
import {parseStrictJson} from "./hub/validation.js";
import {requestContextDigest} from "./request-context-store.js";

export const REQUEST_CONTEXT_RESOLUTION_FUNCTION="agend_request_context_resolution_version";
export const REQUEST_CONTEXT_RESOLUTION_GUARD="agend_rc_v1_drain_resolution_update";
export const REQUEST_CONTEXT_RESOLUTION_GUARD_SQL=`CREATE TRIGGER ${REQUEST_CONTEXT_RESOLUTION_GUARD} BEFORE UPDATE ON request_context_drain_v1 BEGIN
  SELECT CASE WHEN COALESCE(${REQUEST_CONTEXT_RESOLUTION_FUNCTION}(),0) < 1
    THEN RAISE(ABORT, 'request-context resolution v1 required') END;
END`;
const sha=z.string().regex(/^[a-f0-9]{64}$/);
const receipt=z.strictObject({receiptId:z.uuid(),inputSha256:sha,receiptSha256:sha});
const schema=z.strictObject({version:z.literal(1),rootId:z.uuid(),fenceEpoch:z.uuid(),owner:z.string().min(1).max(256),
  ownerBinding:sha,blockerSha256:sha,closedAt:z.number().int().nonnegative().safe(),receipts:z.array(receipt).max(64)});
export type RequestContextResolution=Readonly<z.infer<typeof schema>>;
const MAX_BYTES=32768;
const normalize=(sql:string)=>sql.replace(/\s+/g," ").trim().replace(/;$/,"");
export function decodeRequestContextResolution(raw:string,digest:string):RequestContextResolution {
  const value=schema.parse(parseStrictJson(raw,MAX_BYTES));
  if(new Set(value.receipts.map(row=>row.receiptId)).size!==value.receipts.length||requestContextDigest(value)!==digest)throw Error("Invalid request-context resolution image");
  return value;
}
/** The guard is permanent. E collection retains the F resolution tombstones. */
export function assertRequestContextResolutionGuard(db:Database.Database):boolean {
  const guard=db.prepare("SELECT type,tbl_name,sql FROM sqlite_master WHERE name=?").get(REQUEST_CONTEXT_RESOLUTION_GUARD) as {type:string;tbl_name:string;sql:string}|undefined;
  const columns=db.pragma("table_info(request_context_drain_v1)") as Array<{name:string}>;
  const count=columns.filter(row=>["resolution_json","resolution_sha256"].includes(row.name)).length;
  if(!guard&&!count)return false;
  if(!guard||count!==2||guard.type!=="trigger"||guard.tbl_name!=="request_context_drain_v1"
    ||normalize(guard.sql)!==normalize(REQUEST_CONTEXT_RESOLUTION_GUARD_SQL))throw Error("Invalid request-context resolution guard");
  return true;
}
export function readRequestContextResolution(db:Database.Database,rootId:string):RequestContextResolution|null {
  z.uuid().parse(rootId);
  if(!assertRequestContextResolutionGuard(db))return null;
  const row=db.prepare("SELECT resolution_json,resolution_sha256 FROM request_context_drain_v1 WHERE root_id=?").get(rootId) as {resolution_json:string|null;resolution_sha256:string|null}|undefined;
  if(!row||row.resolution_json===null&&row.resolution_sha256===null)return null;
  if(typeof row.resolution_json!=="string"||typeof row.resolution_sha256!=="string")throw Error("Incomplete request-context resolution");
  const value=decodeRequestContextResolution(row.resolution_json,row.resolution_sha256);
  if(value.rootId!==rootId)throw Error("Request-context resolution root changed");
  return value;
}
/** Call only within the root transaction after positive owner retirement and all F rechecks. */
export function writeRequestContextResolution(db:Database.Database,value:RequestContextResolution):void {
  schema.parse(value);const raw=JSON.stringify(value),digest=requestContextDigest(value);
  decodeRequestContextResolution(raw,digest);
  if(!db.inTransaction)throw Error("Request-context resolution requires its root transaction");
  const existing=readRequestContextResolution(db,value.rootId);
  if(existing){if(requestContextDigest(existing)!==digest)throw Error("Request-context resolution changed");return;}
  if(!assertRequestContextResolutionGuard(db)){
    db.exec("ALTER TABLE request_context_drain_v1 ADD COLUMN resolution_json TEXT");
    db.exec("ALTER TABLE request_context_drain_v1 ADD COLUMN resolution_sha256 TEXT");
    db.exec(REQUEST_CONTEXT_RESOLUTION_GUARD_SQL);
  }
  if(db.prepare("UPDATE request_context_drain_v1 SET resolution_json=?,resolution_sha256=? WHERE root_id=? AND epoch=? AND owner=? AND resolution_json IS NULL AND resolution_sha256 IS NULL")
    .run(raw,digest,value.rootId,value.fenceEpoch,value.owner).changes!==1)throw Error("Request-context resolution fence changed");
}

/** Audit state for a manifest-verified Go back snapshot. No clock ordering and no subset adoption. */
export function readRequestContextResolutionHistory(db:Database.Database):Readonly<{guard:boolean;history:readonly RequestContextResolution[]}> {
 const guard=assertRequestContextResolutionGuard(db);if(!guard)return {guard:false,history:[]};
 const rows=db.prepare("SELECT root_id FROM request_context_drain_v1 WHERE resolution_json IS NOT NULL OR resolution_sha256 IS NOT NULL ORDER BY root_id LIMIT 10001").all() as Array<{root_id:string}>;
 if(rows.length>10000)throw Error("Request-context resolution history exceeds its bound");
 return {guard:true,history:rows.map(row=>{const value=readRequestContextResolution(db,row.root_id);if(!value)throw Error("Resolution history unavailable");return value;})};
}
/** Shared by activation's guard and the updater port; callers hold the restore fence. */
export function requestContextResolutionHistoriesEqual(live:Database.Database,snapshot:Database.Database):boolean {
 const left=readRequestContextResolutionHistory(live),right=readRequestContextResolutionHistory(snapshot);
 return left.guard===right.guard&&JSON.stringify(left.history)===JSON.stringify(right.history);
}
