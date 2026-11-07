/**
 * AgEnD Hub P1, slice 3: the pieces every S3 service shares — the clock, one atomic unit with its audit, the person
 * rows and the fresh directory check (with its concurrency bound). No I/O on import.
 */
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { HubProtocolError } from "../validation.js";
import { personKeyString } from "../identity.js";
import type { HubAuditRecord, HubRequestContext, HubTx, PersonKey } from "../types.js";
import { exposureOf, readExposure } from "../catalog.js";
import { HubGroupAuthorizationError, type HubGroupPermit } from "../group-policy/authorization.js";
import { HubGroupPolicyError, type GroupCheckContext } from "../group-policy/store.js";
import type { HubHttpDeps, HubTxDatabase } from "./deps.js";

export type HubAuditEvent = Omit<HubAuditRecord, "id" | "sequence" | "at" | "policyVersion"> & { at?: number };

/** At most this many directory checks in flight per person, and in all; more is backpressure (429), never a cached allow. */
export const DIRECTORY_PER_PERSON = 4;
export const DIRECTORY_TOTAL = 32;

export interface HubOperationPermit { readonly source?: HubGroupPermit["source"]; assertCurrent(): void }
const LEGACY_OPERATION: HubOperationPermit = Object.freeze({ source: "legacy", assertCurrent() {} });

export class HubCore {
  private readonly inflight = new Map<string, number>();
  private total = 0;
  constructor(readonly deps: HubHttpDeps, private readonly sql: HubTxDatabase, private readonly lifetime: () => boolean = () => true) {}
  now(): number { return this.deps.now?.() ?? Date.now(); }
  /** Refuses once the server is fenced (and before every write: a stale continuation never commits). */
  live(): boolean { try { return this.lifetime() === true && this.deps.current().serverEnabled() === true; } catch { return false; } }
  check(): void { if (!this.live()) throw new HubProtocolError("unavailable"); }
  /** One synchronous unit of work on the Hub DB; a promise returned from `work` is refused. */
  atomic<T>(work: (db: Database.Database, tx: HubTx) => T, permit?: HubOperationPermit): T {
    this.check();
    return this.deps.uow.atomic((tx) => {
      this.check();
      permit?.assertCurrent();
      const out = work(this.sql(tx), tx);
      if (out && typeof (out as { then?: unknown }).then === "function") throw new HubProtocolError("invalid");
      permit?.assertCurrent();
      return out;
    });
  }
  /** A group refusal is bounded protocol data, never a directory exception or DN. */
  private async group(work: () => Promise<HubGroupPermit>): Promise<HubOperationPermit> {
    try {
      const permit = await work();
      return { source: permit.source, assertCurrent() {
        try { permit.assertCurrent(); } catch { throw new HubProtocolError("unavailable"); }
      } };
    } catch (error) {
      if (error instanceof HubGroupAuthorizationError && (error.reason === "denied" || error.reason === "resume-required")) throw new HubProtocolError("denied");
      if (error instanceof HubGroupPolicyError) throw new HubProtocolError("unavailable");
      throw error;
    }
  }
  /** A synchronous session fence is mandatory when group checks can await LDAP. */
  groupContext(ctx: HubRequestContext): GroupCheckContext {
    const fence = ctx.isCurrent?.bind(ctx);
    return { requestId: ctx.requestId, current: () => this.live() && fence?.() === true };
  }
  async groupAsker(person: PersonKey, ctx: GroupCheckContext): Promise<HubOperationPermit> {
    const groups = this.deps.groups;
    if (!groups) return LEGACY_OPERATION;
    const permit = await this.group(() => groups.asker(person, ctx));
    return { source: permit.source, assertCurrent: () => {
      if (this.deps.groups !== groups) throw new HubProtocolError("unavailable");
      permit.assertCurrent();
    } };
  }
  /** Fresh asker + exact fleet/exposure provenance. An allow is for this operation only. */
  async groupExposure(exposureId: string, asker: PersonKey | null, ctx: GroupCheckContext): Promise<HubOperationPermit> {
    const groups = this.deps.groups;
    if (!groups) return LEGACY_OPERATION;
    const exposure = this.atomic(db => { const row = readExposure(db, exposureId); return row && exposureOf(row); });
    if (!exposure) throw new HubProtocolError("not-found");
    const fleet = this.deps.store.read().fleets.find(f => f.id === exposure.fleetId);
    if (!fleet || personKeyString(fleet.owner) !== personKeyString(exposure.owner)) throw new HubProtocolError("revoked");
    const serializedExposure = JSON.stringify(exposure), serializedFleet = JSON.stringify(fleet), permits: HubOperationPermit[] = [];
    if (asker) permits.push(await this.groupAsker(asker, ctx));
    const fleetPermit = await this.group(() => groups.check({ kind: "fleet", id: fleet.id, revision: fleet.generation, owner: fleet.owner }, ctx));
    permits.push(fleetPermit);
    if (fleet.status !== "active" && fleetPermit.source !== "legacy") throw new HubProtocolError("revoked");
    permits.push(await this.group(() => groups.check({ kind: "exposure", id: exposure.id, revision: exposure.revision, owner: exposure.owner }, ctx)));
    const permit = { assertCurrent: () => {
      if (!this.live() || ctx.current() !== true || this.deps.groups !== groups) throw new HubProtocolError("unavailable");
      for (const proof of permits) proof.assertCurrent();
      const row = this.atomic(db => readExposure(db, exposure.id));
      if (!row || JSON.stringify(exposureOf(row)) !== serializedExposure
        || JSON.stringify(this.deps.store.read().fleets.find(f => f.id === fleet.id)) !== serializedFleet) throw new HubProtocolError("stale");
    } };
    permit.assertCurrent(); return permit;
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
  async eligible(person: PersonKey): Promise<boolean> { return (await this.current(person)) !== null; }
  /**
   * The person as the directory has them now (its current login and name), or null when they are not eligible. The
   * person's row takes the current login label, so a rename never leaves an old label pointing at them.
   */
  async current(person: PersonKey): Promise<{ login: string; displayName?: string } | null> {
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
        if (ok && r.eligible && typeof r.person.login === "string" && r.person.login) db.prepare("UPDATE hub_people SET login_label=? WHERE person=?").run(r.person.login.slice(0, 256), id);
        if (!ok && !(!r.eligible && r.reason === "unavailable")) db.prepare("UPDATE hub_sessions SET state='ended' WHERE person=? AND state='active'").run(id);
      });
      return ok && r.eligible ? { login: r.person.login, ...(r.person.displayName ? { displayName: r.person.displayName } : {}) } : null;
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

/**
 * A login label → the one Hub person it names NOW: exactly one row carries it (a shared or unknown label is refused),
 * and the directory's current login for that person is still that label (a rename — and a colleague later given the old
 * login — never redirects a grant or a pairing to the wrong person). Null otherwise.
 */
export async function personByLogin(core: HubCore, login: string): Promise<PersonKey | null> {
  const label = login.trim();
  if (!label) return null;
  const id = core.atomic((db) => {
    const rows = db.prepare("SELECT person FROM hub_people WHERE login_label=? COLLATE NOCASE").all(label) as { person: string }[];
    return rows.length === 1 ? rows[0]!.person : null;
  });
  if (!id) return null;
  const person = personFromString(id), now = await core.current(person);
  return now && now.login.toLowerCase() === label.toLowerCase() ? person : null;
}
