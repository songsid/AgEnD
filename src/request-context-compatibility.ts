import {assertRequestContextResolutionGuard,REQUEST_CONTEXT_RESOLUTION_FUNCTION,REQUEST_CONTEXT_RESOLUTION_GUARD} from "./request-context-resolution.js";
import type Database from "better-sqlite3";

export const REQUEST_CONTEXT_DISPATCH_VERSION = 1 as const;
export const REQUEST_CONTEXT_VERSION_FUNCTION = "agend_request_context_dispatch_version";
const MARKER = "request_context_compatibility";
const PREFIX = "agend_rc_v1_";
const TABLES = ["deliveries", "delivery_attempts"] as const;
const OPERATIONS = ["INSERT", "UPDATE", "DELETE"] as const;
export type RequestContextDispatchVersion = 0 | typeof REQUEST_CONTEXT_DISPATCH_VERSION;
export interface RequestContextCompatibilityOptions {
  /** Trusted dispatcher integration only. No config/tool/web switch. Omitted means the legacy dispatcher. */
  requestContextDispatchVersion?: RequestContextDispatchVersion;
}
export class RequestContextCompatibilityError extends Error {
  constructor(message: string) { super(message); this.name = "RequestContextCompatibilityError"; }
}
function fail(message: string): never { throw new RequestContextCompatibilityError(message); }
function guardName(table: string, operation: string): string { return `${PREFIX}${table}_${operation.toLowerCase()}`; }
function guardSql(table: string, operation: string): string {
  return `CREATE TRIGGER ${guardName(table, operation)} BEFORE ${operation} ON ${table} BEGIN
    SELECT CASE WHEN COALESCE(${REQUEST_CONTEXT_VERSION_FUNCTION}(), 0) < ${REQUEST_CONTEXT_DISPATCH_VERSION}
      THEN RAISE(ABORT, 'request-context dispatch v1 required') END;
  END`;
}
const normalize = (sql: string): string => sql.replace(/\s+/g, " ").trim().replace(/;$/, "");
/** Registration is connection-local; OFF installs no persistent artifacts and changes no legacy row. */
export function registerRequestContextDispatcher(db: Database.Database, version: RequestContextDispatchVersion): void {
  if (version !== 0 && version !== REQUEST_CONTEXT_DISPATCH_VERSION) fail("Unsupported request-context dispatcher capability");
  db.function(REQUEST_CONTEXT_VERSION_FUNCTION, { deterministic: true }, () => version);
  db.function(REQUEST_CONTEXT_RESOLUTION_FUNCTION,{deterministic:true},()=>version===1?1:0);
}
/** Must run before legacy initialization/recovery, including for the capability-0 bridge itself. */
export function assertRequestContextCompatibility(db: Database.Database, version: RequestContextDispatchVersion): "inactive" | "active" {
  const artifacts = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name=? OR (type='trigger' AND substr(name,1,?)=?)")
    .all(MARKER, PREFIX.length, PREFIX) as Array<{ type: string; name: string; tbl_name: string; sql: string | null }>;
  const resolution=assertRequestContextResolutionGuard(db);
  if (!artifacts.length) {if(resolution)fail("Resolution requires request-context barrier");return "inactive";}
  const marker = artifacts.find(row => row.name === MARKER);
  if (!marker || marker.type !== "table") fail("Invalid request-context compatibility barrier");
  const rows = db.prepare(`SELECT singleton,required_dispatch_version FROM ${MARKER}`).all() as Array<{ singleton: number; required_dispatch_version: number }>;
  if (rows.length !== 1 || rows[0]!.singleton !== 1 || !Number.isSafeInteger(rows[0]!.required_dispatch_version)
    || rows[0]!.required_dispatch_version < 1) fail("Invalid request-context compatibility marker");
  const required = rows[0]!.required_dispatch_version;
  if (required !== REQUEST_CONTEXT_DISPATCH_VERSION || version < required) {
    fail(`request-context dispatch v${required} required; this dispatcher supports v${version}`);
  }
  if (resolution && !artifacts.some(row=>row.name===REQUEST_CONTEXT_RESOLUTION_GUARD))fail("Missing resolution guard");
  if (artifacts.length !== 1 + TABLES.length * OPERATIONS.length + (resolution?1:0)) fail("Invalid request-context barrier guard set");
  for (const table of TABLES) for (const operation of OPERATIONS) {
    const guard = artifacts.find(row => row.name === guardName(table, operation));
    if (!guard || guard.type !== "trigger" || guard.tbl_name !== table || !guard.sql
      || normalize(guard.sql) !== normalize(guardSql(table, operation))) fail("Missing or changed request-context barrier guard");
  }
  return "active";
}
/**
 * Future controlled cutover only. No production call in the bridge. Marker and guards commit atomically;
 * there is intentionally no unguarded deactivation API before the drain contract exists.
 */
export function activateRequestContextBarrier(db: Database.Database, version: RequestContextDispatchVersion): void {
  if (version !== REQUEST_CONTEXT_DISPATCH_VERSION) fail("request-context dispatch v1 required before barrier activation");
  const actual = db.prepare(`SELECT ${REQUEST_CONTEXT_VERSION_FUNCTION}() AS version`).get() as { version: number };
  if (actual.version !== version) fail("request-context dispatch v1 is not installed on this connection");
  db.transaction(() => {
    if (assertRequestContextCompatibility(db, version) === "active") return;
    db.exec(`CREATE TABLE ${MARKER} (singleton INTEGER PRIMARY KEY CHECK(singleton=1), required_dispatch_version INTEGER NOT NULL)`);
    for (const table of TABLES) for (const operation of OPERATIONS) db.exec(guardSql(table, operation));
    db.prepare(`INSERT INTO ${MARKER} VALUES (1,?)`).run(REQUEST_CONTEXT_DISPATCH_VERSION);
    assertRequestContextCompatibility(db, version);
  })();
}
