/**
 * AgEnD Hub P1, slice 3: the pieces every S3 service shares — the clock, one atomic unit with its audit, the person
 * rows and the fresh directory check (with its concurrency bound). No I/O on import.
 */
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { HubProtocolError, person as personSchema, validated } from "../validation.js";
import { personKeyString } from "../identity.js";
import type { HubAuditRecord, HubRequestContext, HubTx, PersonKey } from "../types.js";
import { exposureOf, readExposure, readGrant, grantOf } from "../catalog.js";
import { HubGroupAuthorizationError, type HubGroupPermit } from "../group-policy/authorization.js";
import { HubGroupPolicyError, HubGroupReadOverload, type GroupCheckContext } from "../group-policy/store.js";
import { prepareGrantAccess, type HubGrantSubjectProof } from "../grant-access.js";
import type { HubHttpDeps, HubTxDatabase } from "./deps.js";
import { readHubSessionEpoch } from "../session-epoch.js";
import type { HubManagementPermission } from "../roles/authority.js";
import type { HubDirectoryDecisionProof } from "../directory-decision-proof.js";
import { createHubDirectoryAdmission, type HubDirectoryReads } from "../directory/admission.js";
export { DIRECTORY_PER_PERSON, DIRECTORY_TOTAL } from "../directory/admission.js";

export type HubAuditEvent = Omit<HubAuditRecord, "id" | "sequence" | "at" | "policyVersion"> & { at?: number };

export interface HubOperationPermit { readonly source?: HubGroupPermit["source"]; readonly grant?: HubGrantSubjectProof; assertCurrent(): void }
const LEGACY_OPERATION: HubOperationPermit = Object.freeze({ source: "legacy", assertCurrent() {} });

export class HubCore {
  /** Captured at HTTP mount. A held continuation never silently adopts a newer directory epoch. */
  readonly directoryEpoch: number;
  private readonly directoryReads: HubDirectoryReads;
  constructor(readonly deps: HubHttpDeps, private readonly sql: HubTxDatabase, private readonly lifetime: () => boolean = () => true) {
    this.directoryEpoch = deps.uow.atomic(tx => readHubSessionEpoch(sql(tx)));
    this.directoryReads = deps.directoryReads ?? createHubDirectoryAdmission(() => this.live());
  }
  now(): number { return this.deps.now?.() ?? Date.now(); }
  /** Refuses once the server is fenced (and before every write: a stale continuation never commits). */
  live(): boolean { try { return this.lifetime() === true && this.deps.current().serverEnabled() === true; } catch { return false; } }
  check(): void { if (!this.live()) throw new HubProtocolError("unavailable"); }
  async management(ctx: HubRequestContext, permission: HubManagementPermission) {
    this.check();
    const management = this.deps.management;
    if (management) {
      const require = management.require;
      try {
        const permit = await require.call(management, ctx, permission);
        let retired = false;
        const check = () => {
          this.check();
          if (retired || this.deps.management !== management || management.require !== require) throw new HubProtocolError("unavailable");
        };
        const assertCurrent = () => {
          try {
            check();
            permit.assertCurrent();
          } catch (error) { retired = true; throw error; }
        };
        assertCurrent();
        const assertDecision = permit.assertDirectoryDecision;
        return { ...permit, assertCurrent, ...(assertDecision ? { assertDirectoryDecision: (proof: HubDirectoryDecisionProof) => {
          try {
            check();
            if (permit.assertDirectoryDecision !== assertDecision) throw new HubProtocolError("unavailable");
            const sample = assertDecision.call(permit, proof); check(); return sample;
          } catch (error) { retired = true; throw error; }
        } } : {}) };
      } catch (error) {
        // Preserve the real session's signed-out answer after a held proof read; a stale reader never restores the permit.
        if (ctx.isCurrent?.() === false) await ctx.current();
        throw error;
      }
    }
    const actor = await ctx.requireAdmin(), current = ctx.isCurrent?.bind(ctx);
    const assertCurrent = () => { this.check(); if (current && current() !== true) throw new HubProtocolError("revoked"); };
    assertCurrent(); return { actor, assertCurrent };
  }
  /** One synchronous unit of work on the Hub DB; a promise returned from `work` is refused. */
  atomic<T>(work: (db: Database.Database, tx: HubTx) => T, permit?: Pick<HubOperationPermit, "assertCurrent">): T {
    this.check();
    return this.deps.uow.atomic((tx) => {
      this.check();
      const db = this.sql(tx);
      const assertEpoch = () => { if (readHubSessionEpoch(db) !== this.directoryEpoch) throw new HubProtocolError("unavailable"); };
      assertEpoch();
      permit?.assertCurrent();
      const out = work(db, tx);
      if (out && typeof (out as { then?: unknown }).then === "function") throw new HubProtocolError("invalid");
      permit?.assertCurrent();
      assertEpoch();
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
  /** Shared physical read owner; the returned fence retains the exact policy, binding and caller. */
  async grantDirectoryRead<T>(actor: PersonKey, ctx: GroupCheckContext, read: () => Promise<T>): Promise<{ value: T; permit: HubOperationPermit }> {
    const selected = this.deps.grantDirectory;
    if (!selected) throw new HubProtocolError("unavailable");
    let policy: ReturnType<typeof selected.policy>, image: string, binding: string;
    try {
      if (selected.binding().kind !== "ready") throw new Error("binding unavailable");
      policy = selected.policy(); image = JSON.stringify(policy.read()); binding = JSON.stringify(selected.binding());
    } catch { throw new HubProtocolError("unavailable"); }
    const assertCurrent = () => {
      this.check();
      if (!ctx.current()) throw new HubProtocolError("revoked");
      try {
        if (this.deps.grantDirectory !== selected || selected.policy() !== policy
          || JSON.stringify(policy.read()) !== image || JSON.stringify(selected.binding()) !== binding) throw new Error("binding changed");
      } catch { throw new HubProtocolError("unavailable"); }
    };
    assertCurrent();
    let value: T;
    try { value = await policy.withDirectoryRead(actor, read); }
    catch (e) { assertCurrent(); throw new HubProtocolError(e instanceof HubGroupReadOverload ? "backpressure" : "unavailable"); }
    assertCurrent(); return { value, permit: { assertCurrent } };
  }
  grantAccess(ids: readonly string[], asker: PersonKey, ctx: GroupCheckContext): Promise<HubGrantSubjectProof> {
    return prepareGrantAccess(this, ids, asker, ctx);
  }
  async withGrant(permit: HubOperationPermit, ids: readonly string[], asker: PersonKey, ctx: GroupCheckContext, refusal: "revoked" | "not-found" = "revoked"): Promise<HubOperationPermit> {
    const grant = await this.grantAccess(ids, asker, ctx);
    this.atomic(db => { for (const id of ids) {
      const row = readGrant(db, id);
      if (!row || !grant.allows(grantOf(row), asker)) throw new HubProtocolError(refusal);
    } }, grant);
    return { grant, assertCurrent() { grant.assertCurrent(); permit.assertCurrent(); } };
  }
  async exposureGrant(exposureId: string, grantId: string, asker: PersonKey, ctx: GroupCheckContext, refusal: "revoked" | "not-found" = "revoked"): Promise<HubOperationPermit> {
    const base = await this.groupExposure(exposureId, asker, ctx), permit = await this.withGrant(base, [grantId], asker, ctx, refusal);
    this.atomic(db => {
      const grant = readGrant(db, grantId), exposure = readExposure(db, exposureId);
      if (!grant || !exposure || grant.exposure_id !== exposure.id || grant.owner !== exposure.owner) throw new HubProtocolError(refusal);
    }, permit);
    return permit;
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
    return this.exposurePermission(exposureId, asker, ctx, false);
  }
  /** Only the owner-sharing writer: it separately fences the exact before/after row inside its transaction. */
  async sharingPermission(exposureId: string, ctx: GroupCheckContext): Promise<HubOperationPermit> {
    return this.exposurePermission(exposureId, null, ctx, true);
  }
  private async exposurePermission(exposureId: string, asker: PersonKey | null, ctx: GroupCheckContext, sharingChange: boolean): Promise<HubOperationPermit> {
    const groups = this.deps.groups;
    const exposure = this.atomic(db => { const row = readExposure(db, exposureId); return row && exposureOf(row); });
    if (!exposure) throw new HubProtocolError("not-found");
    const bytes = (e: typeof exposure) => {
      if (!sharingChange) return JSON.stringify(e);
      const { sharingEpoch: _epoch, ...rest } = e;
      return JSON.stringify({ ...rest, state: rest.state === "paused" ? "published" : rest.state });
    };
    const serializedExposure = bytes(exposure);
    const assertExposure = () => {
      if (!this.live() || ctx.current() !== true) throw new HubProtocolError("unavailable");
      const row = this.atomic(db => readExposure(db, exposureId));
      if (this.deps.groups !== groups || !row || bytes(exposureOf(row)) !== serializedExposure) throw new HubProtocolError("stale");
    };
    if (!groups) { assertExposure(); return { source: "legacy", assertCurrent: assertExposure }; }
    const fleet = this.deps.store.read().fleets.find(f => f.id === exposure.fleetId);
    if (!fleet || personKeyString(fleet.owner) !== personKeyString(exposure.owner)) throw new HubProtocolError("revoked");
    const serializedFleet = JSON.stringify(fleet), permits: HubOperationPermit[] = [];
    if (asker) permits.push(await this.groupAsker(asker, ctx));
    const fleetPermit = await this.group(() => groups.check({ kind: "fleet", id: fleet.id, revision: fleet.generation, owner: fleet.owner }, ctx));
    permits.push(fleetPermit);
    if (fleet.status !== "active" && fleetPermit.source !== "legacy") throw new HubProtocolError("revoked");
    permits.push(await this.group(() => groups.check({ kind: "exposure", id: exposure.id, revision: exposure.revision, owner: exposure.owner }, ctx)));
    const permit = { assertCurrent: () => {
      assertExposure();
      if (!this.live() || ctx.current() !== true || this.deps.groups !== groups) throw new HubProtocolError("unavailable");
      for (const proof of permits) proof.assertCurrent();
      const row = this.atomic(db => readExposure(db, exposure.id));
      if (!row || bytes(exposureOf(row)) !== serializedExposure
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
  /** These wrappers share one bounded identity selection path; their callers own the operation's authority check. */
  async lookupPairingOwner(login: string): Promise<PersonKey | null> {
    return this.lookupSelectedPerson(login, "pairing");
  }
  async lookupGrantRecipient(login: string): Promise<PersonKey | null> {
    return this.lookupSelectedPerson(login, "grant");
  }
  /** One physical login read; callers retain their own sign-in throttle and authority fences. */
  async directoryLogin<T>(login: string, work: () => Promise<T>): Promise<T> {
    this.check();
    try { return await this.directoryReads.withLoginRead(login, work); }
    catch (error) {
      if (error instanceof HubGroupReadOverload) throw new HubProtocolError("backpressure");
      if (error instanceof HubGroupPolicyError) throw new HubProtocolError("unavailable");
      throw error;
    }
  }
  private async lookupSelectedPerson(login: string, operation: "pairing" | "grant"): Promise<PersonKey | null> {
    const lookup = operation === "pairing" ? this.deps.directory.lookupForPairing : this.deps.directory.lookupForGrant;
    if (!lookup) return personByLogin(this, login); // Older injected drivers retain the same known-person behavior.
    this.check();
    let result;
    try { result = await this.directoryLogin(login, () => lookup.call(this.deps.directory, login)); }
    catch (error) { throw new HubProtocolError(error instanceof HubProtocolError && error.code === "backpressure" ? "backpressure" : "unavailable"); }
    this.check();
    if (!result.ok) {
      if (result.reason === "unavailable") throw new HubProtocolError("unavailable");
      return null;
    }
    const selected = validated(personSchema, result.person.key);
    if (selected.realm !== this.deps.directory.realm || typeof result.person.login !== "string"
      || result.person.login.toLowerCase() !== login.toLowerCase()) throw new HubProtocolError("unavailable");
    // The directory's fresh immutable-id recheck, not the login or cached person rows, decides the selected identity.
    const current = await this.current(selected);
    return current && current.login.toLowerCase() === login.toLowerCase() ? selected : null;
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
    const selected = Object.freeze(validated(personSchema, person)), id = personKeyString(selected);
    try { return await this.directoryReads.withDirectoryRead(selected, async () => {
      const r = await this.deps.directory.checkEligibility(selected);
      const ok = r.eligible && personKeyString(r.person.key) === id;
      this.check();
      this.atomic((db) => {
        db.prepare("UPDATE hub_people SET status=?, last_checked_at=? WHERE person=?")
          .run(ok ? "active" : r.eligible ? "unknown" : r.reason === "unavailable" ? "unknown" : "disabled", this.now(), id);
        if (ok && r.eligible && typeof r.person.login === "string" && r.person.login) db.prepare("UPDATE hub_people SET login_label=? WHERE person=?").run(r.person.login.slice(0, 256), id);
        if (!ok && !(!r.eligible && r.reason === "unavailable")) db.prepare("UPDATE hub_sessions SET state='ended' WHERE person=? AND state='active'").run(id);
      });
      return ok && r.eligible ? { login: r.person.login, ...(r.person.displayName ? { displayName: r.person.displayName } : {}) } : null;
    }); } catch (error) {
      if (error instanceof HubGroupReadOverload) throw new HubProtocolError("backpressure");
      if (error instanceof HubGroupPolicyError) throw new HubProtocolError("unavailable");
      throw error;
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
  const permit = await core.management(ctx, "join.manage"); permit.assertCurrent();
  const login = input.trim();
  if (!login || login.length > 256) return null;
  const owner = await core.lookupPairingOwner(login);
  await ctx.current(); // No stale admin session may use a lookup completed after it was signed out.
  permit.assertCurrent();
  return owner;
}
