/**
 * AgEnD Hub P1, slice 3: the pieces every S3 service shares — the clock, one atomic unit with its audit, the person
 * rows and the fresh directory check (with its concurrency bound). No I/O on import.
 */
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { HubProtocolError } from "../validation.js";
import { personKeyString } from "../identity.js";
import type { HubAuditRecord, HubTx, PersonKey } from "../types.js";
import type { HubHttpDeps, HubTxDatabase } from "./deps.js";

export type HubAuditEvent = Omit<HubAuditRecord, "id" | "sequence" | "at" | "policyVersion"> & { at?: number };

/** At most this many directory checks in flight per person, and in all; more is backpressure (429), never a cached allow. */
export const DIRECTORY_PER_PERSON = 4;
export const DIRECTORY_TOTAL = 32;

export class HubCore {
  private readonly inflight = new Map<string, number>();
  private total = 0;
  constructor(readonly deps: HubHttpDeps, private readonly sql: HubTxDatabase) {}
  now(): number { return this.deps.now?.() ?? Date.now(); }
  /** Refuses once the server is fenced (and before every write: a stale continuation never commits). */
  check(): void { if (!this.deps.current()) throw new HubProtocolError("unavailable"); }
  /** One synchronous unit of work on the Hub DB; a promise returned from `work` is refused. */
  atomic<T>(work: (db: Database.Database, tx: HubTx) => T): T {
    this.check();
    return this.deps.uow.atomic((tx) => {
      this.check();
      const out = work(this.sql(tx), tx);
      if (out && typeof (out as { then?: unknown }).then === "function") throw new HubProtocolError("invalid");
      return out;
    });
  }
  /** Audit inside the caller's transaction: a failed append aborts the whole unit (hub.md §4). */
  audit(tx: HubTx, event: HubAuditEvent): void {
    const { at, ...rest } = event;
    let policyVersion = 0;
    try { policyVersion = this.deps.store.read().revocationVersion; } catch { throw new HubProtocolError("uncertain"); }
    this.deps.audit.append(tx, { ...rest, id: randomUUID(), sequence: 0, at: at ?? this.now(), policyVersion });
  }
  revocationVersion(): number {
    try { return this.deps.store.read().revocationVersion; } catch { throw new HubProtocolError("uncertain"); }
  }
  /**
   * A fresh directory eligibility check (no allow-cache). Ineligible or unreachable is denied; the person's row records
   * what was seen. Bounded per person and in all — over the bound is "backpressure".
   */
  async eligible(person: PersonKey): Promise<boolean> {
    const id = personKeyString(person);
    const mine = this.inflight.get(id) ?? 0;
    if (mine >= DIRECTORY_PER_PERSON || this.total >= DIRECTORY_TOTAL) throw new HubProtocolError("backpressure");
    this.inflight.set(id, mine + 1); this.total++;
    try {
      const r = await this.deps.directory.checkEligibility(person);
      const ok = r.eligible && personKeyString(r.person.key) === id;
      this.check();
      this.atomic((db) => {
        db.prepare("UPDATE hub_people SET status=?, last_checked_at=? WHERE person=?")
          .run(ok ? "active" : r.eligible ? "unknown" : r.reason === "unavailable" ? "unknown" : "disabled", this.now(), id);
        if (!ok && !(!r.eligible && r.reason === "unavailable")) db.prepare("UPDATE hub_sessions SET state='ended' WHERE person=? AND state='active'").run(id);
      });
      return ok;
    } finally {
      const n = (this.inflight.get(id) ?? 1) - 1;
      if (n > 0) this.inflight.set(id, n); else this.inflight.delete(id);
      this.total--;
    }
  }
}

export const personFromRow = (row: { realm: string; object_id: string }): PersonKey => ({ realm: row.realm, objectId: row.object_id });
export function personFromString(id: string): PersonKey {
  const at = id.indexOf("/");
  return { realm: id.slice(0, at), objectId: id.slice(at + 1) };
}
