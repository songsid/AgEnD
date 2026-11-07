/**
 * AgEnD Hub P1, slice 3: the pieces every S3 service shares — the clock, one atomic unit with its audit, the person
 * rows and the fresh directory check (with its concurrency bound). No I/O on import.
 */
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { HubProtocolError, person as personSchema, validated } from "../validation.js";
import { personKeyString, sha256 } from "../identity.js";
import type { HubAuditRecord, HubRequestContext, HubTx, PersonKey } from "../types.js";
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
  live(): boolean { try { return this.deps.current().serverEnabled() === true; } catch { return false; } }
  check(): void { if (!this.live()) throw new HubProtocolError("unavailable"); }
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
  /** The admin pairing path's service lookup shares the eligibility concurrency budget, never an allow cache. */
  async lookupPairingOwner(login: string): Promise<PersonKey | null> {
    const lookup = this.deps.directory.lookupForPairing;
    if (!lookup) return personByLogin(this, login); // Older injected drivers retain the same known-person behavior.
    const key = `pairing-owner:${sha256(login.toLowerCase())}`, mine = this.inflight.get(key) ?? 0;
    if (mine >= DIRECTORY_PER_PERSON || this.total >= DIRECTORY_TOTAL) throw new HubProtocolError("backpressure");
    this.check(); this.inflight.set(key, mine + 1); this.total++;
    let result;
    try { result = await lookup.call(this.deps.directory, login); }
    catch { throw new HubProtocolError("unavailable"); }
    finally {
      const n = (this.inflight.get(key) ?? 1) - 1;
      if (n > 0) this.inflight.set(key, n); else this.inflight.delete(key);
      this.total--;
    }
    this.check();
    if (!result.ok) {
      if (result.reason === "unavailable") throw new HubProtocolError("unavailable");
      return null;
    }
    const owner = validated(personSchema, result.person.key);
    if (owner.realm !== this.deps.directory.realm || typeof result.person.login !== "string"
      || result.person.login.toLowerCase() !== login.toLowerCase()) throw new HubProtocolError("unavailable");
    // The directory's fresh immutable-id lookup, not the login or cached person rows, decides ownership.
    const current = await this.current(owner);
    return current && current.login.toLowerCase() === login.toLowerCase() ? owner : null;
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

/** Only the existing authenticated Hub-admin pairing operation may select an unsigned-in directory owner. */
export async function pairingOwnerByLogin(core: HubCore, ctx: HubRequestContext, input: string): Promise<PersonKey | null> {
  await ctx.requireAdmin();
  const login = input.trim();
  if (!login || login.length > 256) return null;
  const owner = await core.lookupPairingOwner(login);
  await ctx.current(); // No stale admin session may use a lookup completed after it was signed out.
  return owner;
}
