/** Cold directory recovery participant, called by the runtime before mounting. The shared writer owns every file write. */
import { createHubAudit } from "./audit/index.js";
import { assertHubMigrationsCurrent, bindHubInstance, HubStateError, inspectStateSet, openHubDatabase,
  type HubMigration, type HubStateSet } from "./db.js";
import { SERVER_SET, readKeyFile } from "./compose/storage.js";
import { readHubIdentity } from "./tls.js";
import { HubTransportStore } from "./store.js";
import { HubFileVersionFloor } from "./version-floor.js";
import { createHubDirectorySettingsDecision, type HubDirectorySettingsDecision } from "./settings-directory-decision.js";
import { createHubDirectoryNotices, type HubDirectoryNotices } from "./settings-directory-notices.js";

export interface HubDirectoryRecoveryOptions {
  home: string; hubId: string; memberOrigin: string;
  /** The complete build registry; recovery never calls its migration functions. */
  migrations: readonly HubMigration[];
  /** Internal layout seam for isolated composition tests. Production uses SERVER_SET. */
  stateSet?: HubStateSet;
}
function withState<T>(options: HubDirectoryRecoveryOptions, work: (participant: {
  decision: HubDirectorySettingsDecision; db: ReturnType<typeof openHubDatabase>; transport: HubTransportStore; audit: ReturnType<typeof createHubAudit>;
}) => T): T {
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
    const result = work({ decision, db, transport, audit });
    if (result && (typeof result === "object" || typeof result === "function") && typeof (result as { then?: unknown }).then === "function") {
      try { (result as unknown as PromiseLike<unknown>).then(undefined, () => undefined); } catch { /* refused below */ }
      throw new HubStateError("hub-storage", "directory recovery must be synchronous");
    }
    return result;
  } finally { db.close(); key?.fill(0); }
}

export function withHubDirectoryRecovery<T>(options: HubDirectoryRecoveryOptions, work: (decision: HubDirectorySettingsDecision) => T): T {
  return withState(options, ({ decision }) => work(decision));
}

/** Host-only cold access. A held/off listener is not permission to create/migrate state or start a directory client. */
export function withHubDirectoryNoticeRecovery<T>(options: HubDirectoryRecoveryOptions & { hostSink: string; current(): boolean },
  work: (notices: Readonly<Pick<HubDirectoryNotices, "forHost" | "acknowledgeHost">>) => T): T {
  const snapshot = { ...options, migrations: options.migrations.map(row => ({ ...row })),
    ...(options.stateSet ? { stateSet: structuredClone(options.stateSet) } : {}) }, current = options.current.bind(options);
  if (current() !== true) throw new HubStateError("service-unavailable", "The host notice authority is unavailable");
  return withState(snapshot, ({ db, transport, audit }) => {
    const notices = createHubDirectoryNotices({ db, transport, audit, hubId: snapshot.hubId, hostSink: snapshot.hostSink, current });
    try { return work(Object.freeze({ forHost: notices.forHost, acknowledgeHost: notices.acknowledgeHost })); }
    finally { notices.close(); }
  });
}
