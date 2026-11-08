/** Cold directory recovery participant, called by the runtime before mounting. The shared writer owns every file write. */
import { createHubAudit } from "./audit/index.js";
import { assertHubMigrationsCurrent, bindHubInstance, HubStateError, inspectStateSet, openHubDatabase,
  type HubMigration, type HubStateSet } from "./db.js";
import { SERVER_SET, readKeyFile } from "./compose/storage.js";
import { readHubIdentity } from "./tls.js";
import { HubTransportStore } from "./store.js";
import { HubFileVersionFloor } from "./version-floor.js";
import { createHubDirectorySettingsDecision, type HubDirectorySettingsDecision } from "./settings-directory-decision.js";

export function withHubDirectoryRecovery<T>(options: {
  home: string; hubId: string; memberOrigin: string;
  /** The complete build registry; recovery never calls its migration functions. */
  migrations: readonly HubMigration[];
  /** Internal layout seam for isolated composition tests. Production uses SERVER_SET. */
  stateSet?: HubStateSet;
}, work: (decision: HubDirectorySettingsDecision) => T): T {
  const { home, hubId, memberOrigin } = options, set = structuredClone(options.stateSet ?? SERVER_SET);
  if (set.floors.length !== 1 || set.keys.length !== 1 || inspectStateSet(home, set) !== "complete") {
    throw new HubStateError("hub-state-mismatch", "directory recovery requires the complete existing state set");
  }
  if (readHubIdentity({ home, memberOrigin }).hubId !== hubId) throw new HubStateError("hub-state-mismatch", "directory recovery identity differs");
  const db = openHubDatabase(home, set.database, { create: false });
  let key: Buffer | undefined;
  try {
    assertHubMigrationsCurrent(db, options.migrations);
    // A registry row alone cannot replace the authority tables. These reads never recreate a lost component.
    for (const sql of [
      "SELECT singleton,operation_id,directory_epoch FROM hub_settings_head LIMIT 0",
      "SELECT id,body FROM hub_settings_operations LIMIT 0",
      "SELECT id,operation_id,body FROM hub_settings_security_notices LIMIT 0",
      "SELECT notice_id,kind,target,state FROM hub_settings_security_targets LIMIT 0",
    ]) db.prepare(sql).all();
    bindHubInstance(db, hubId, "complete", 0);
    key = readKeyFile(home, set.keys[0]!);
    const audit = createHubAudit({ db, contentKey: key });
    const transport = new HubTransportStore(db, { floor: new HubFileVersionFloor(home, set.floors[0]!),
      appendAudit: (record, owning) => audit.appendInTransaction(record, owning) });
    const decision = createHubDirectorySettingsDecision({ db, transport, hubId });
    decision.inspect(); // A raised/missing floor, lost head or browser epoch is never initialized to zero.
    const result = work(decision);
    if (result && (typeof result === "object" || typeof result === "function") && typeof (result as { then?: unknown }).then === "function") {
      try { (result as unknown as PromiseLike<unknown>).then(undefined, () => undefined); } catch { /* refused below */ }
      throw new HubStateError("hub-storage", "directory recovery must be synchronous");
    }
    return result;
  } finally { db.close(); key?.fill(0); }
}
