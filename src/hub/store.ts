/** S1's metadata repository. S5 supplies an already-private SQLite DB and audit writer. */
import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { epoch, hash, person, uuid, validated, parseStrictJson, HubProtocolError } from "./validation.js";
import type { HubAuditRecord } from "./types.js";
const pairing = z.strictObject({ id: uuid, owner: person, codeHash: hash.nullable(), expiresAt: epoch,
  fleetId: uuid.nullable(), claimHash: hash.nullable(), fingerprint: hash.nullable(), ownerConfirmed: z.boolean(), adminApproved: z.boolean(),
  state: z.enum(["offered", "pending", "claimed", "revoked"]) });
const fleet = z.strictObject({ id: uuid, owner: person, credentialHash: hash.nullable(), generation: epoch,
  status: z.enum(["active", "revoked"]) });
const stateSchema = z.strictObject({ v: z.literal(1), revision: epoch, revocationVersion: epoch, nextLinkEpoch: epoch,
  pairings: z.array(pairing).max(64), fleets: z.array(fleet).max(256),
  buckets: z.array(z.strictObject({ key: hash, since: epoch, attempts: epoch })).max(1024) });
export type HubTransportState = z.infer<typeof stateSchema>;
export interface HubVersionFloor {
  /** Private durable companion, not part of a restorable older DB snapshot. Missing/corrupt existing state must throw. */
  read(): number;
  /** Raise durably BEFORE DB commit. A crash between these writes deliberately freezes the old DB. */
  raise(revision: number): void;
}
export interface HubTransportStoreOptions {
  floor: HubVersionFloor;
  /** Must write into this exact DB transaction synchronously; missing/failed audit refuses the mutation. */
  appendAudit(record: HubAuditRecord, database: Database.Database): void;
}
export function migrateHubTransportStore(db: Database.Database): void {
  db.exec("CREATE TABLE IF NOT EXISTS hub_transport_state (singleton INTEGER PRIMARY KEY CHECK(singleton=1), state TEXT NOT NULL)");
}
export const HUB_TRANSPORT_MIGRATION = Object.freeze({ component: "s1-transport", version: 1, up: migrateHubTransportStore });
/** No file opening or migration on import/construction; initialization is explicit and belongs to S5. */
export class HubTransportStore {
  private failed = false;
  constructor(private readonly db: Database.Database, private readonly options: HubTransportStoreOptions) {}
  initialize(): void {
    if (this.db.prepare("SELECT 1 FROM hub_transport_state WHERE singleton=1").get()) throw new HubProtocolError("conflict");
    if (this.options.floor.read() !== 0) throw new HubProtocolError("uncertain");
    const initial: HubTransportState = { v: 1, revision: 0, revocationVersion: 0, nextLinkEpoch: 0, pairings: [], fleets: [], buckets: [] };
    this.db.prepare("INSERT INTO hub_transport_state(singleton,state) VALUES(1,?)").run(JSON.stringify(initial));
  }
  read(): HubTransportState {
    if (this.failed) throw new HubProtocolError("uncertain");
    try {
      const row = this.db.prepare("SELECT state FROM hub_transport_state WHERE singleton=1").get() as { state: string } | undefined;
      if (!row) throw new HubProtocolError("uncertain");
      const state = validated(stateSchema, parseStrictJson(row.state, 2 * 1024 * 1024)), floor = this.options.floor.read();
      if (!Number.isSafeInteger(floor) || floor < 0 || floor !== state.revision
        || new Set(state.pairings.map(x => x.id)).size !== state.pairings.length
        || new Set(state.fleets.map(x => x.id)).size !== state.fleets.length) throw new HubProtocolError("uncertain");
      return state;
    } catch { this.failed = true; throw new HubProtocolError("uncertain"); }
  }
  mutate<T>(event: Omit<HubAuditRecord, "id" | "sequence" | "policyVersion">, change: (state: HubTransportState) => T): T {
    let writing = false;
    try {
      return this.db.transaction(() => {
        const state = this.read(), result = change(state);
        if (result && typeof (result as { then?: unknown }).then === "function") throw new HubProtocolError();
        state.revision++;
        validated(stateSchema, state);
        writing = true;
        // The independent floor advances before either transactional write. An audit/DB failure must
        // remain unconfirmed after restart, rather than silently restoring the prior authorization.
        this.options.floor.raise(state.revision);
        const audited: unknown = this.options.appendAudit({ ...event, id: randomUUID(), sequence: state.revision, policyVersion: state.revocationVersion }, this.db);
        if (audited && typeof (audited as { then?: unknown }).then === "function") {
          void Promise.resolve(audited).catch(() => {}); throw new HubProtocolError("uncertain");
        }
        this.db.prepare("UPDATE hub_transport_state SET state=? WHERE singleton=1").run(JSON.stringify(state));
        return result;
      }).immediate();
    } catch (error) {
      // Validation/refusal may occur before any write. An advanced floor or failed writer freezes every future read.
      if (writing) this.failed = true;
      try { this.read(); } catch { this.failed = true; }
      throw error;
    }
  }
}
