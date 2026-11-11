/** Cold directory recovery participant, called by the runtime before mounting. The shared writer owns every file write. */
import { createHubAudit } from "./audit/index.js";
import { assertHubMigrationsCurrent, bindHubInstance, HubStateError, inspectStateSet, openHubDatabase,
  type HubMigration, type HubStateSet } from "./db.js";
import { SERVER_SET, readKeyFile } from "./compose/storage.js";
import { readHubIdentity, readHubMemberTls } from "./tls.js";
import { HubTransportStore } from "./store.js";
import { HubFileVersionFloor } from "./version-floor.js";
import { createHubDirectorySettingsDecision, type HubDirectorySettingsDecision } from "./settings-directory-decision.js";
import { createHubDirectoryNotices, type HubDirectoryNotices } from "./settings-directory-notices.js";
import { HUB_DIRECTORY_RECOVERY_MIGRATION } from "./settings-directory-recovery-intent.js";
import { createHubDirectoryMountBarrier } from "./settings-directory-mount.js";
import { createHubGroupPolicyStore } from "./group-policy/store.js";
import { parseGroupPolicy } from "./group-policy/model.js";
import { readPrivateFile } from "./private-files.js";
import { BIND_PASSWORD_REF, BIND_SECRET_REL } from "./init/layout.js";
import type { HubDirectory, HubDirectoryConfig } from "./directory/index.js";
import type { HubMountedDirectory } from "./settings-directory-runtime.js";
import type { PersonKey } from "./types.js";
import {createHubWebAddressDecision,type HubWebAddressDecision} from "./settings-web-address-decision.js";
import { createHubMemberAddressDecision, type HubMemberAddressDecision } from "./settings-member-address-decision.js";

export interface HubDirectoryRecoveryOptions {
  home: string; hubId: string; memberOrigin: string;
  /** The complete build registry; recovery never calls its migration functions. */
  migrations: readonly HubMigration[];
  /** Internal layout seam for isolated composition tests. Production uses SERVER_SET. */
  stateSet?: HubStateSet;
}
function openState(options: HubDirectoryRecoveryOptions) {
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
      ...(options.migrations.some(m => m.component === HUB_DIRECTORY_RECOVERY_MIGRATION.component)
        ? ["SELECT operation_id,expires_at,state,completed_at FROM hub_settings_mount_recovery LIMIT 0"] : []),
    ]) db.prepare(sql).all();
    bindHubInstance(db, hubId, "complete", 0);
    key = readKeyFile(home, set.keys[0]!);
    const audit = createHubAudit({ db, contentKey: key });
    const transport = new HubTransportStore(db, { floor: new HubFileVersionFloor(home, set.floors[0]!),
      appendAudit: (record, owning) => audit.appendInTransaction(record, owning) });
    const decision = createHubDirectorySettingsDecision({ db, transport, hubId });
    decision.inspect(); // A raised/missing floor, lost head or browser epoch is never initialized to zero.
    return { decision, db, transport, audit, close() { try { db.close(); } finally { key?.fill(0); } } };
  } catch (error) { try { db.close(); } finally { key?.fill(0); } throw error; }
}
function withState<T>(options: HubDirectoryRecoveryOptions, work: (participant: ReturnType<typeof openState>) => T): T {
  const state = openState(options);
  try {
    const result = work(state);
    if (result && (typeof result === "object" || typeof result === "function") && typeof (result as { then?: unknown }).then === "function") {
      try { (result as unknown as PromiseLike<unknown>).then(undefined, () => undefined); } catch { /* refused below */ }
      throw new HubStateError("hub-storage", "directory recovery must be synchronous");
    }
    return result;
  } finally { state.close(); }
}

export function withHubDirectoryRecovery<T>(options: HubDirectoryRecoveryOptions, work: (decision: HubDirectorySettingsDecision) => T): T {
  return withState(options, ({ decision }) => work(decision));
}

/** The same existing-state/floor checks; never create or migrate a database during address completion. */
export function withHubWebAddressRecovery<T>(options: HubDirectoryRecoveryOptions & {initial:{certificateFile:string;keyFile:string}},
  work:(decision:HubWebAddressDecision)=>T):T {
  return withState(options,({db,audit})=>work(createHubWebAddressDecision({db,audit,home:options.home,hubId:options.hubId,initial:options.initial})));
}

/** A member operation can crash between identity selection and config installation. Only this existing-state
 * participant admits an internally coherent stored origin; the writer must match both exact image hashes to SQL.
 * Normal mount/directory/web-address access still require the configured origin above. */
export function withHubMemberAddressRecovery<T>(options: HubDirectoryRecoveryOptions, work: (decision: HubMemberAddressDecision) => T): T {
  const material = readHubMemberTls({ home: options.home });
  if (material.identity.hubId !== options.hubId) throw new HubStateError("hub-state-mismatch", "Member address identity differs");
  return withState({ ...options, memberOrigin: material.metadata.memberOrigin }, ({ db, transport }) =>
    work(createHubMemberAddressDecision({ db, transport, home: options.home, hubId: options.hubId })));
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

/** Private physical owner retained by the runtime when construction failed but driver cleanup is unconfirmed. */
export class HubDirectoryColdCleanupError extends HubStateError {
  constructor(readonly close: () => Promise<void>) { super("service-unavailable", "Directory construction cleanup is unconfirmed"); }
}

/** Explicit local settings access only. No listener, migration, state creation, or directory network at construction. */
export async function createHubDirectoryColdSettings(options: HubDirectoryRecoveryOptions & {
  hub: Record<string, unknown>; generation: string; current(): boolean;
  createDirectory(config: HubDirectoryConfig, secrets: { bindPassword: string }): HubDirectory;
}): Promise<HubMountedDirectory & { fence(): void; close(): Promise<void> }> {
  const hub = structuredClone(options.hub), owner = options.current.bind(options);
  if (owner() !== true || hub.hubId !== options.hubId || hub.memberOrigin !== options.memberOrigin) throw new HubStateError("service-unavailable", "The directory settings source changed");
  const state = openState(options), active = new Set<Promise<unknown>>();
  let directory: HubDirectory | undefined, closed = false, closing: Promise<void> | null = null;
  try {
    const barrier = createHubDirectoryMountBarrier({ home: options.home, hub, decision: state.decision, current: () => !closed && owner() === true });
    const config = structuredClone(hub.directory) as HubDirectoryConfig;
    if (config.bindPasswordRef !== BIND_PASSWORD_REF) throw new HubStateError("hub-directory-secret", "The directory secret reference is invalid");
    const bindPassword = readPrivateFile(options.home, BIND_SECRET_REL, 4096, { preserveBom: true });
    const { bindPasswordRef: _ref, ...directoryConfig } = config;
    directory = options.createDirectory(directoryConfig as HubDirectoryConfig, { bindPassword });
    const acceptedDirectory = directory;
    const policy = createHubGroupPolicyStore({ db: state.db, audit: state.audit, hubId: options.hubId, realm: config.realm,
      generation: options.generation, directory, current: barrier.current });
    const fence = () => { closed = true; barrier.close(); };
    const lease = Object.freeze({
      decision: state.decision,
      recoveryMode: hub.enabled === false ? "off" as const : "held" as const,
      current: barrier.current,
      source: () => state.db.transaction(() => {
        const stamp = barrier.capture();
        const previous = state.decision.proofBasis()?.policy ?? parseGroupPolicy(JSON.parse(
          (state.db.prepare("SELECT body FROM hub_group_policy WHERE singleton=1").get() as { body: string }).body));
        return { directory: acceptedDirectory, config: structuredClone(directoryConfig) as HubDirectoryConfig, bindPassword,
          administrator: structuredClone(hub.administrator) as PersonKey,
          groups: previous.groups.map(g => ({ key: { ...g.group }, dn: g.dn })), ...stamp, current: barrier.current };
      })(),
      sessions(): never { throw new HubStateError("service-unavailable", "A local recovery source has no Hub browser sessions"); },
      withDirectoryRead<T>(person: PersonKey, work: () => Promise<T>): Promise<T> {
        // Register ownership before dispatch: the callback may synchronously re-enter close().
        let resolve!: (value: T | PromiseLike<T>) => void, reject!: (error: unknown) => void;
        const pending = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); active.add(pending);
        void pending.finally(() => active.delete(pending)).catch(() => {});
        void policy.withDirectoryRead(person, work).then(resolve, reject); return pending;
      },
      fence,
      close(): Promise<void> {
        fence();
        return closing ??= (async () => {
          await Promise.allSettled([...active]);
          await (acceptedDirectory as HubDirectory & { close?(): Promise<void> }).close?.();
          state.close();
        })().catch(error => { closing = null; throw error; });
      },
    });
    barrier.assertCurrent(); // Construction callbacks cannot publish changed material.
    return lease;
  } catch (error) {
    closed = true;
    const cleanup = async () => {
      await (directory as (HubDirectory & { close?(): Promise<void> }) | undefined)?.close?.();
      state.close();
    };
    try { await cleanup(); }
    catch { throw new HubDirectoryColdCleanupError(cleanup); }
    throw error;
  }
}
