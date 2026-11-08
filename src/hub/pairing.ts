import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { HubProtocolError, hash, person, token, uuid, validated } from "./validation.js";
import { personKeyString, sha256 } from "./identity.js";
import type { HubTransportState, HubTransportStore } from "./store.js";
import type { HubActor, HubDirectory, HubRequestContext, PersonKey } from "./types.js";
import type Database from "better-sqlite3";
import { HubGroupAuthorizationError, type HubGroupAuthorization, type HubGroupEnrollmentPermit } from "./group-policy/authorization.js";
import { HubGroupPolicyError } from "./group-policy/store.js";
import { HubGroupEnrollmentRefusal } from "./group-policy/resources.js";
const TTL = 10 * 60_000;
const secret = () => randomBytes(32).toString("hex");
export interface HubPairingIdentity {
  hubId: string; memberOrigin: string; webOrigin: string; spkiSha256: string; issuerPublicKey: string;
}
export function hubPairingFingerprint(identity: HubPairingIdentity, pairId: string, owner: PersonKey, claimDigest: string): string {
  validated(uuid, identity.hubId); validated(hash, identity.spkiSha256); validated(uuid, pairId); validated(hash, claimDigest); validated(person, owner);
  return sha256(JSON.stringify(["agend-hub-pair-v1", identity.hubId, identity.memberOrigin, identity.spkiSha256,
    identity.issuerPublicKey, identity.webOrigin, pairId, owner.realm, owner.objectId, claimDigest]));
}
export function displayHubFingerprint(fingerprint: string): string {
  return validated(hash, fingerprint).slice(0, 32).toUpperCase().match(/.{4}/g)!.join("-");
}
const pairBody = z.strictObject({ code: z.string().regex(/^[a-f0-9]{12}$/) });
const claimBody = z.strictObject({ pairingId: uuid, fleetId: uuid, claimSecret: token });
export class HubPairingService {
  constructor(private readonly options: { store: HubTransportStore; identity: HubPairingIdentity; directory: HubDirectory;
    enabled(): boolean; now?: () => number; fenceFleet(fleetId: string, reason: "replaced" | "revoked"): void;
    /** Required when composed with a live member server; reconnect other links after a global version commit. */
    refreshAuthorization?(): void;
    /** S5 owns this DB. No transaction is held across directory work; provenance and the actual fleet commit together. */
    enrollment?: { prepare: HubGroupAuthorization["prepareEnrollment"]; prepareManual?: HubGroupAuthorization["prepareManualEnrollment"];
      atomic<T>(work: (database: Database.Database) => T): T } }) {}
  private now(): number { return this.options.now?.() ?? Date.now(); }
  private check(): void { if (!this.options.enabled()) throw new HubProtocolError("unavailable"); }
  private audit(actor: HubActor | { kind: "member"; fleetId: string }, action: string, requestId: string) {
    return { at: this.now(), requestId, actor: actor.kind === "directory" ? { kind: "person" as const, person: actor.person } : actor.kind === "member" ? actor : { kind: "local-host" as const }, action, result: "allowed" as const };
  }
  private budget(state: HubTransportState, key: string, maximum = 10): boolean {
    const now = this.now(); state.buckets = state.buckets.filter(x => now - x.since < 60_000);
    const digest = sha256(key), row = state.buckets.find(x => x.key === digest);
    if (!row) { if (state.buckets.length >= 1024) return false; state.buckets.push({ key: digest, since: now, attempts: 1 }); return true; }
    row.attempts = Math.min(row.attempts + 1, maximum + 1); return row.attempts <= maximum;
  }
  async create(ctx: HubRequestContext, owner: PersonKey): Promise<{ pairingId: string; code: string; expiresAt: number }> {
    validated(person, owner); this.check();
    const eligible = await this.options.directory.checkEligibility(owner);
    if (!eligible.eligible || personKeyString(eligible.person.key) !== personKeyString(owner)) throw new HubProtocolError("denied");
    const admin = await ctx.requireAdmin(); this.check();
    const id = randomUUID(), code = randomBytes(6).toString("hex"), expiresAt = this.now() + TTL;
    this.options.store.mutate(this.audit(admin, "pairing.created", ctx.requestId), state => {
      state.pairings = state.pairings.filter(p => p.expiresAt > this.now());
      if (state.pairings.length >= 64) throw new HubProtocolError("backpressure");
      state.pairings.push({ id, owner: { ...owner }, codeHash: sha256(code), expiresAt, fleetId: null, claimHash: null, fingerprint: null,
        ownerConfirmed: false, adminApproved: false, state: "offered" });
    });
    return { pairingId: id, code, expiresAt };
  }
  /** Unauthenticated bootstrap accepts a code only: no cookies, passwords, exports or directory attributes. */
  pair(input: unknown): { pairingId: string; fleetId: string; claimSecret: string; fingerprint: string; expiresAt: number; hub: HubPairingIdentity; owner: PersonKey } {
    const { code } = validated(pairBody, input); this.check();
    const invalid = this.options.store.read().buckets.find(b => b.key === sha256("pair:invalid"));
    if (invalid && this.now() - invalid.since < 60_000 && invalid.attempts > 10
      && !this.options.store.read().pairings.some(p => p.codeHash === sha256(code))) throw new HubProtocolError("denied");
    const claimSecret = secret(), claimHash = sha256(claimSecret), fleetId = randomUUID();
    const result = this.options.store.mutate(this.audit({ kind: "member", fleetId }, "pairing.claim-requested", randomUUID()), state => {
      const p = state.pairings.find(p => p.codeHash === sha256(code) && p.state === "offered" && p.expiresAt > this.now());
      if (!p) { this.budget(state, "pair:invalid"); return null; }
      if (!this.budget(state, `pair:${p.id}`)) return null;
      p.codeHash = null; p.claimHash = claimHash; p.fleetId = fleetId; p.state = "pending";
      p.fingerprint = hubPairingFingerprint(this.options.identity, p.id, p.owner, claimHash);
      return { pairingId: p.id, fleetId, claimSecret, fingerprint: p.fingerprint, expiresAt: p.expiresAt, hub: { hubId: this.options.identity.hubId, memberOrigin: this.options.identity.memberOrigin, webOrigin: this.options.identity.webOrigin, spkiSha256: this.options.identity.spkiSha256, issuerPublicKey: this.options.identity.issuerPublicKey }, owner: { ...p.owner } };
    });
    if (!result) throw new HubProtocolError("denied"); return result;
  }
  async confirmOwner(ctx: HubRequestContext, pairId: string, fingerprint: string): Promise<void> {
    validated(uuid, pairId); validated(hash, fingerprint); const owner = await ctx.requirePerson(); this.check();
    this.options.store.mutate(this.audit({ kind: "directory", person: owner, sessionId: "" }, "pairing.owner-confirmed", ctx.requestId), state => {
      const p = state.pairings.find(p => p.id === pairId);
      if (!p || p.state !== "pending" || p.expiresAt <= this.now() || p.fingerprint !== fingerprint || personKeyString(p.owner) !== personKeyString(owner)) throw new HubProtocolError("denied");
      p.ownerConfirmed = true;
    });
  }
  async approve(ctx: HubRequestContext, pairId: string, fingerprint: string): Promise<void> {
    validated(uuid, pairId); validated(hash, fingerprint); const found = await ctx.requireAdmin(); this.check();
    const admin = found.kind === "directory" ? { ...found, person: validated(person, found.person) } : found;
    const enrollment = this.options.enrollment;
    let proof: HubGroupEnrollmentPermit | undefined;
    const selected = this.options.store.read().pairings.find(p => p.id === pairId);
    if (enrollment?.prepareManual) {
      if (admin.kind !== "directory" || !selected || selected.state !== "pending" || !selected.ownerConfirmed
        || selected.expiresAt <= this.now() || selected.fingerprint !== fingerprint || !selected.fleetId) throw new HubProtocolError("denied");
      const owner = validated(person, selected.owner), who = validated(person, admin.person);
      const eligible = await this.options.directory.checkEligibility(owner);
      if (!eligible.eligible) throw new HubProtocolError(eligible.reason === "unavailable" ? "unavailable" : "denied");
      if (personKeyString(eligible.person.key) !== personKeyString(owner)) throw new HubProtocolError("denied");
      const again = await ctx.requireAdmin(); this.check();
      if (again.kind !== "directory" || personKeyString(again.person) !== personKeyString(who)) throw new HubProtocolError("denied");
      try {
        proof = await enrollment.prepareManual({ kind: "fleet", id: selected.fleetId, revision: 1, owner }, who,
          { requestId: ctx.requestId, current: () => this.options.enabled() && selected.expiresAt > this.now() && (ctx.isCurrent?.() ?? true) });
      } catch (error) {
        if ((error instanceof HubGroupEnrollmentRefusal && error.outcome === "denied")
          || (error instanceof HubGroupAuthorizationError && error.reason === "denied")) throw new HubProtocolError("denied");
        if (error instanceof HubGroupPolicyError) throw new HubProtocolError("unavailable");
        throw error;
      }
    }
    const write = () => this.options.store.mutate(this.audit(admin, "pairing.approved", ctx.requestId), state => {
      const p = state.pairings.find(p => p.id === pairId);
      if (!p || p.state !== "pending" || p.expiresAt <= this.now() || p.fingerprint !== fingerprint || !p.ownerConfirmed) throw new HubProtocolError("denied");
      if (proof && (!selected || p.fleetId !== selected.fleetId || personKeyString(p.owner) !== personKeyString(selected.owner))) throw new HubProtocolError("denied");
      proof?.assertCurrent();
      p.adminApproved = true;
      if (admin.kind === "directory") p.approvedBy = validated(person, admin.person);
    });
    try {
      if (proof && enrollment) enrollment.atomic(() => { write(); proof!.assertCurrent(); });
      else write();
    } catch (error) {
      if (error instanceof HubGroupPolicyError) throw new HubProtocolError("unavailable");
      throw error;
    }
  }
  private throttled(state: HubTransportState, key: string, maximum: number): boolean {
    const bucket = state.buckets.find(b => b.key === sha256(key));
    return !!bucket && this.now() - bucket.since < 60_000 && bucket.attempts >= maximum;
  }
  async claim(input: unknown): Promise<{ status: "pending" } | { status: "approved"; fleetId: string; credential: string }> {
    const body = validated(claimBody, input); this.check(); const credential = secret();
    const matches = (p: HubTransportState["pairings"][number]) => p.id === body.pairingId && p.fleetId === body.fleetId && p.claimHash === sha256(body.claimSecret)
      && p.state === "pending" && p.expiresAt > this.now();
    const initial = this.options.store.read(), offered = initial.pairings.find(matches);
    const owner = offered ? validated(person, offered.owner) : null, enrollment = this.options.enrollment;
    const key = offered ? `claim:${offered.id}` : "claim:invalid", maximum = offered ? 60 : 10;
    // Already-throttled requests publish no additional audit/floor write. Valid claims have their own budget.
    if (this.throttled(initial, key, maximum)) throw new HubProtocolError("denied");
    let eligible = false;
    if (owner) {
      const result = await this.options.directory.checkEligibility(Object.freeze({ ...owner }));
      eligible = result.eligible && personKeyString(result.person.key) === personKeyString(owner);
    }
    this.check();
    let prepared: HubGroupEnrollmentPermit | undefined, enrollmentRefusal: HubProtocolError | undefined;
    const selected = this.options.store.read().pairings.find(matches);
    if (enrollment && eligible && owner && selected?.ownerConfirmed && selected.adminApproved
      && personKeyString(selected.owner) === personKeyString(owner) && selected.fingerprint === offered?.fingerprint) {
      try {
        const resource = { kind: "fleet" as const, id: body.fleetId, revision: 1, owner };
        const context = { requestId: randomUUID(), current: () => this.options.enabled() && selected.expiresAt > this.now() };
        if (enrollment.prepareManual) {
          // An old boolean approval is not an authenticated manual-grant identity. It needs a new explicit approval.
          if (selected.approvedBy) prepared = await enrollment.prepareManual(resource, selected.approvedBy, context);
        } else prepared = await enrollment.prepare(resource, context);
      } catch (error) {
        if ((error instanceof HubGroupAuthorizationError && error.reason === "denied")
          || (error instanceof HubGroupEnrollmentRefusal && error.outcome === "denied")) enrollmentRefusal = new HubProtocolError("denied");
        else if (error instanceof HubGroupPolicyError) enrollmentRefusal = new HubProtocolError("unavailable");
        else throw error;
      }
    }
    this.check();
    const event = { ...this.audit({ kind: "member" as const, fleetId: body.fleetId }, "pairing.claimed", randomUUID()), result: "denied" as "allowed" | "denied" };
    const write = () => this.options.store.mutate(event, state => {
      // Recheck after directory I/O: concurrent polling or claim consumption cannot bypass the durable budget.
      const p = state.pairings.find(matches), liveKey = p ? `claim:${p.id}` : "claim:invalid", limit = p ? 60 : 10;
      if (this.throttled(state, liveKey, limit)) throw new HubProtocolError("denied");
      if (!this.budget(state, liveKey, limit) || !p || !eligible || !owner || personKeyString(p.owner) !== personKeyString(owner)
        || p.fingerprint !== offered?.fingerprint) return null;
      // Group refusal still consumes the existing durable claim budget, without issuing authority or provenance.
      if (enrollmentRefusal) return null;
      if (!p.ownerConfirmed || !p.adminApproved) { event.result = "allowed"; event.action = "pairing.claim-pending"; return { status: "pending" as const }; }
      // Confirmations may arrive during the eligibility await. A later claim must obtain its own preparation first.
      if (enrollment && !prepared) { event.result = "allowed"; event.action = "pairing.claim-pending"; return { status: "pending" as const }; }
      prepared?.assertCurrent();
      if (prepared?.source === "group" && state.fleets.filter(f => f.status === "active" && f.credentialHash
        && personKeyString(f.owner) === personKeyString(owner)).length >= prepared.maxFleets) return null;
      if (state.fleets.length >= 256) throw new HubProtocolError("backpressure");
      p.state = "claimed"; p.claimHash = null;
      state.fleets.push({ id: body.fleetId, owner: p.owner, credentialHash: sha256(credential), generation: 1, status: "active" });
      event.result = "allowed";
      return { status: "approved" as const, fleetId: body.fleetId, credential };
    });
    let outcome: ReturnType<typeof write>;
    try {
      outcome = prepared && enrollment ? enrollment.atomic(database => {
        const result = write();
        if (result?.status === "approved") {
          prepared.commit(database);
          const committed = this.options.store.read(), fleet = committed.fleets.find(f => f.id === body.fleetId), pairing = committed.pairings.find(p => p.id === body.pairingId);
          if (!fleet || fleet.status !== "active" || fleet.generation !== 1 || fleet.credentialHash !== sha256(credential)
            || !owner || personKeyString(fleet.owner) !== personKeyString(owner) || pairing?.state !== "claimed" || pairing.claimHash !== null
            || pairing.fleetId !== body.fleetId || personKeyString(pairing.owner) !== personKeyString(owner) || !pairing.ownerConfirmed || !pairing.adminApproved
            || pairing.fingerprint !== selected?.fingerprint || pairing.expiresAt !== selected.expiresAt
            || JSON.stringify(pairing.approvedBy) !== JSON.stringify(selected.approvedBy)) throw new HubProtocolError("unavailable");
        }
        prepared.assertCurrent(); return result;
      }) : write();
    } catch (error) {
      if (error instanceof HubGroupPolicyError) throw new HubProtocolError("unavailable");
      throw error;
    }
    if (enrollmentRefusal) throw enrollmentRefusal;
    if (!outcome) throw new HubProtocolError("denied"); return outcome;
  }
  authenticate(credential: string): { fleetId: string; owner: PersonKey; generation: number } {
    validated(token, credential); this.check(); const digest = Buffer.from(sha256(credential), "hex");
    const fleet = this.options.store.read().fleets.find(f => f.status === "active" && f.credentialHash && timingSafeEqual(digest, Buffer.from(f.credentialHash, "hex")));
    if (!fleet) throw new HubProtocolError("denied"); return { fleetId: fleet.id, owner: fleet.owner, generation: fleet.generation };
  }
  bindingCurrent(fleetId: string, generation: number, revocationVersion?: number): boolean {
    try { this.check(); const state = this.options.store.read(), f = state.fleets.find(f => f.id === fleetId);
      return f?.status === "active" && f.generation === generation && (revocationVersion === undefined || state.revocationVersion === revocationVersion);
    } catch { return false; }
  }
  async connect(credential: string): Promise<{ fleetId: string; owner: PersonKey; generation: number; linkEpoch: number; revocationVersion: number }> {
    let f = this.authenticate(credential);
    const eligible = await this.options.directory.checkEligibility(f.owner);
    if (!eligible.eligible || personKeyString(eligible.person.key) !== personKeyString(f.owner)) throw new HubProtocolError("denied");
    f = this.authenticate(credential); this.options.fenceFleet(f.fleetId, "replaced");
    return this.options.store.mutate(this.audit({ kind: "member", fleetId: f.fleetId }, "member.connected", randomUUID()), state => {
      const current = state.fleets.find(x => x.id === f.fleetId);
      if (!current || current.generation !== f.generation || current.status !== "active") throw new HubProtocolError("stale");
      state.nextLinkEpoch++; return { ...f, linkEpoch: state.nextLinkEpoch, revocationVersion: state.revocationVersion };
    });
  }
  async revoke(ctx: HubRequestContext, fleetId: string): Promise<void> {
    validated(uuid, fleetId); const admin = await ctx.requireAdmin(); this.check(); this.options.fenceFleet(fleetId, "revoked");
    this.options.store.mutate(this.audit(admin, "member.revoked", ctx.requestId), state => {
      const f = state.fleets.find(f => f.id === fleetId); if (!f) throw new HubProtocolError("not-found");
      f.status = "revoked"; f.credentialHash = null; f.generation++; state.revocationVersion++;
    });
    // The version is global. Other members keep their credentials and reconnect immediately,
    // rather than keeping a stale socket until its next heartbeat. Never refresh before commit.
    this.options.refreshAuthorization?.();
  }
}
