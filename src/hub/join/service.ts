/** Company-account enrollment authority. No browser cookie, display projection or earlier login is a final permit. */
import type Database from "better-sqlite3";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { HubProtocolError, hash, plain, uuid, person, validated, parseStrictJson } from "../validation.js";
import { canonicalArguments, personKeyString, sha256 } from "../identity.js";
import type { HubRequestContext, PersonKey } from "../types.js";
import type { HubTransportStore } from "../store.js";
import type { HubAuditStore } from "../audit/index.js";
import type { HubPairingNotices } from "../pairing-notices.js";
import type { HubGroupAuthorization, HubGroupPermit } from "../group-policy/authorization.js";
import { HubGroupAuthorizationError } from "../group-policy/authorization.js";
import { HubGroupEnrollmentRefusal } from "../group-policy/resources.js";
import { HubGroupPolicyError } from "../group-policy/store.js";
import { HUB_SESSION_IDLE } from "../sessions.js";
import { automaticFleetSlots, enrollmentThrottled, spendEnrollmentBudget } from "../enrollment-budget.js";
import { CompanyJoinRecords, type JoinRecord } from "./store.js";
import { browserOriginProof, companyIdentityDigest, joinKeyThumbprint, joinPurpose, pkceChallenge, validateJoinBinding,
  verifierSchema, verifyJoinProof, type JoinBinding, type JoinIdentity, type JoinPurpose, type JoinProof } from "./protocol.js";
import { createJoinSealer, type DeliveryBinding } from "./receipt.js";

import { companyInvitationClaims, verifyCompanyInvitation, type CompanyInvitationClaims } from "./invitation.js";
const invitationRecord = z.strictObject({ claims: companyInvitationClaims, digest: hash, requestId: uuid.nullable(), consumed: z.boolean() });

export class CompanyJoinLimit extends HubProtocolError { constructor() { super("backpressure"); } }
const pushPayload = z.strictObject({ label: plain(120).refine(s => s.trim().length > 0), stateHash: hash,
  invitation: z.string().max(8192).nullable() });
const redeemPayload = z.strictObject({ verifier: verifierSchema });
const ackPayload = redeemPayload.extend({ credentialHash: hash, profileDigest: hash, journalCommitId: uuid });
export interface CompanyJoinOptions {
  home: string; db: Database.Database; store: HubTransportStore; audit: Pick<HubAuditStore, "appendInTransaction">;
  identity: JoinIdentity; certificatePem: string; groups: HubGroupAuthorization; notices: HubPairingNotices;
  administrator: PersonKey; eventDays: number; current(): boolean; now?(): number;
  signInvitation(claims: CompanyInvitationClaims): string;
  connected?(fleetId: string): boolean;
  descriptor: ReturnType<typeof import("./descriptor.js").signCompanyDescriptor>;
}
export class HubCompanyJoin {
  readonly records: CompanyJoinRecords;
  private sealer?: ReturnType<typeof createJoinSealer>;
  constructor(private readonly options: CompanyJoinOptions) { this.records = new CompanyJoinRecords(options.db, () => this.now()); }
  private now(): number { return this.options.now?.() ?? Date.now(); }
  private check(): void { if (!this.options.current()) throw new HubProtocolError("unavailable"); }
  private atomic<T>(work: () => T): T { this.check(); return this.options.db.transaction(work).immediate(); }
  private audit(action: string, requestId: string, owner?: PersonKey, fleetId?: string): void {
    const result: unknown = this.options.audit.appendInTransaction({ id: randomUUID(), sequence: 0, policyVersion: this.options.store.read().revocationVersion,
      at: this.now(), requestId, actor: owner ? { kind: "person", person: owner } : { kind: "local-host" },
      action, result: "completed", ...(fleetId ? { fleetId } : {}) }, this.options.db);
    if (result && typeof (result as { then?: unknown }).then === "function") {
      void Promise.resolve(result).catch(() => {}); throw new HubProtocolError("uncertain");
    }
  }
  private seal() {
    return this.sealer ??= createJoinSealer(this.options.home, () => !!this.options.db.prepare(
      "SELECT 1 FROM hub_company_join_requests WHERE json_extract(body,'$.receipt') IS NOT NULL LIMIT 1").get());
  }
  control(): { enabled: boolean; revision: number } {
    this.check();
    const row = this.options.db.prepare("SELECT enabled,revision FROM hub_company_join_control WHERE singleton=1").get() as { enabled: number; revision: number };
    if (!row || ![0, 1].includes(row.enabled) || !Number.isSafeInteger(row.revision) || row.revision < 1) throw new HubProtocolError("uncertain");
    return { enabled: row.enabled === 1, revision: row.revision };
  }
  adminView() {
    return { ...this.control(), companyLink: this.options.identity.webOrigin + "/join-info#hub=" + Buffer.from(JSON.stringify(this.options.descriptor)).toString("base64url") };
  }
  metadata() {
    const control = this.control();
    return { v: 1 as const, hub: this.options.identity, identityDigest: companyIdentityDigest(this.options.identity),
      certificatePem: this.options.certificatePem, features: control.enabled ? ["company-join-v1"] : [] };
  }
  async configure(ctx: HubRequestContext, input: unknown) {
    const body = validated(z.strictObject({ enabled: z.boolean(), expectedRevision: z.number().int().min(1) }), input);
    await ctx.requireAdmin(); if (ctx.isCurrent?.() !== true) throw new HubProtocolError("revoked");
    if (body.enabled) this.seal();
    this.atomic(() => {
      const before = this.control();
      if (before.revision !== body.expectedRevision) throw new HubProtocolError("conflict");
      if (before.revision === Number.MAX_SAFE_INTEGER) throw new HubProtocolError("unavailable");
      this.options.db.prepare("UPDATE hub_company_join_control SET enabled=?,revision=? WHERE singleton=1")
        .run(Number(body.enabled), before.revision + 1);
      if (!body.enabled) {
        const rows = this.options.db.prepare("SELECT id FROM hub_company_join_requests WHERE stage IN('pending','identity-approved','issued')").all() as { id: string }[];
        for (const { id } of rows) this.end(this.records.get(id), "disabled");
      }
      this.audit("company-join.configured", ctx.requestId, this.options.administrator);
      if (ctx.isCurrent?.() !== true) throw new HubProtocolError("revoked");
    });
    return this.adminView();
  }
  retained(): number {
    const rows = this.options.db.prepare("SELECT body FROM hub_company_join_invites").all() as { body: string }[];
    const offers = rows.map(row => validated(invitationRecord, parseStrictJson(row.body))).filter(r => !r.consumed && r.claims.expiresAt > this.now()
      && (r.requestId === null || this.records.get(r.requestId).owner === null)).length;
    return this.records.retained() + offers;
  }
  private readInvitation(id: string) {
    const row = this.options.db.prepare("SELECT body FROM hub_company_join_invites WHERE id=?").get(validated(uuid, id)) as { body: string } | undefined;
    if (!row) throw new HubProtocolError("denied");
    return validated(invitationRecord, parseStrictJson(row.body));
  }
  private invitation(r: JoinRecord) {
    if (!r.invitationId) return null;
    const row = this.readInvitation(r.invitationId);
    if (row.requestId !== r.binding.requestId || row.consumed !== (r.issuedHash !== null)
      || !r.approvedBy || personKeyString(row.claims.approvedBy) !== personKeyString(r.approvedBy)
      || personKeyString(row.claims.approvedBy) !== personKeyString(this.options.administrator)
      || r.owner && personKeyString(row.claims.owner) !== personKeyString(r.owner)
      || companyIdentityDigest(row.claims.hub) !== companyIdentityDigest(r.binding.hub)) throw new HubProtocolError("denied");
    return row;
  }
  async createInvitation(ctx: HubRequestContext, input: PersonKey) {
    this.enabled(); const admin = await ctx.requireAdmin(), owner = validated(person, input);
    if (admin.kind !== "directory" || personKeyString(admin.person) !== personKeyString(this.options.administrator) || ctx.isCurrent?.() !== true)
      throw new HubProtocolError("denied");
    const now = this.now(), claims: CompanyInvitationClaims = { v: 2, id: randomUUID(), hub: this.options.identity, owner,
      approvedBy: admin.person, nonce: randomBytes(32).toString("hex"), createdAt: now, expiresAt: now + 600_000 };
    const invitation = this.options.signInvitation(claims);
    if (canonicalArguments(verifyCompanyInvitation(invitation, now)) !== canonicalArguments(claims)) throw new HubProtocolError("uncertain");
    this.atomic(() => {
      if (ctx.isCurrent?.() !== true || !this.control().enabled) throw new HubProtocolError("revoked");
      const pending = this.options.store.read().pairings.filter(p => p.expiresAt > this.now()).length;
      if (pending + this.retained() >= 64) throw new HubProtocolError("backpressure");
      this.options.db.prepare("DELETE FROM hub_company_join_invites WHERE json_extract(body,'$.claims.expiresAt')<=?").run(this.now());
      const count = (this.options.db.prepare("SELECT COUNT(*) n FROM hub_company_join_invites").get() as { n: number }).n;
      if (count >= 1024) throw new HubProtocolError("backpressure");
      this.options.db.prepare("INSERT INTO hub_company_join_invites VALUES(?,?)").run(claims.id, canonicalArguments({ claims, digest: sha256(invitation), requestId: null, consumed: false }));
      this.audit("company-join.invitation-issued", ctx.requestId, admin.person);
      if (ctx.isCurrent?.() !== true) throw new HubProtocolError("revoked");
    });
    return { invitation, url: this.options.identity.webOrigin + "/join-info#invite=" + invitation, expiresAt: claims.expiresAt };
  }
  private enabled(): void { if (!this.control().enabled) throw new HubProtocolError("denied"); }
  /** Called only inside the group-policy update's owning transaction; never reads the directory. */
  policyUpdated(policy: import("../group-policy/model.js").HubGroupPolicy): void {
    if (!this.options.db.inTransaction) throw new HubProtocolError("uncertain");
    const denied = new Set(policy.denies.filter(d => d.deny.includes("pair_fleet")).map(d => personKeyString(d.person)));
    const rows = this.options.db.prepare("SELECT id FROM hub_company_join_requests WHERE stage IN('identity-approved','issued')").all() as { id: string }[];
    for (const { id } of rows) {
      const r = this.records.get(id);
      if (r.owner && (denied.has(personKeyString(r.owner)) || !r.invitationId && policy.state !== "enabled")) {
        this.end(r, "authority"); this.audit("company-join.policy-cancelled", id, r.owner);
      }
    }
  }
  private bound(input: unknown): JoinBinding {
    const b = validateJoinBinding(input);
    if (companyIdentityDigest(b.hub) !== companyIdentityDigest(this.options.identity)) throw new HubProtocolError("denied");
    return b;
  }
  challenge(binding: unknown, purpose: unknown) {
    this.check(); const b = this.bound(binding), p = validated(joinPurpose, purpose);
    if (p === "push") this.enabled(); else this.exact(b);
    return this.atomic(() => {
      this.options.db.prepare("DELETE FROM hub_company_join_nonces WHERE expires_at<=?").run(this.now());
      if ((this.options.db.prepare("SELECT COUNT(*) n FROM hub_company_join_nonces").get() as { n: number }).n >= 256)
        throw new HubProtocolError("backpressure");
      const nonce = randomBytes(32).toString("hex"), expiresAt = this.now() + 30_000;
      this.options.db.prepare("INSERT INTO hub_company_join_nonces VALUES(?,?,?,?)").run(nonce, this.records.bindingDigest(b), p, expiresAt);
      return { nonce, expiresAt };
    });
  }
  private consume(binding: JoinBinding, purpose: JoinPurpose, proof: unknown, payload: unknown): JoinProof {
    const p = verifyJoinProof(binding, purpose, proof, payload, this.now());
    this.atomic(() => {
      const removed = this.options.db.prepare("DELETE FROM hub_company_join_nonces WHERE nonce=? AND binding=? AND purpose=? AND expires_at=? AND expires_at>?")
        .run(p.nonce, this.records.bindingDigest(binding), purpose, p.expiresAt, this.now());
      if (removed.changes !== 1) throw new HubProtocolError("conflict");
    });
    return p;
  }
  push(binding: unknown, input: unknown, proof: unknown) {
    this.enabled(); const b = this.bound(binding), p = validated(pushPayload, input);
    this.consume(b, "push", proof, p);
    const invite = p.invitation ? verifyCompanyInvitation(p.invitation, this.now()) : null;
    if (invite && (companyIdentityDigest(invite.hub) !== companyIdentityDigest(b.hub)
      || personKeyString(invite.approvedBy) !== personKeyString(this.options.administrator))) throw new HubProtocolError("denied");
    const now = invite?.createdAt ?? this.now(), outerDeadline = now + 600_000;
    const record: JoinRecord = { v: 1, binding: b, version: 1, label: p.label, stateHash: p.stateHash, stage: "pending", createdAt: now,
      outerDeadline, retainUntil: Math.max(outerDeadline, now + this.options.eventDays * 86_400_000), browserHash: null, browserOrigin: null,
      owner: null, sessionId: null, approvedAt: null, redeemDeadline: null, deliveryDeadline: null, issuedHash: null,
      reason: null, delivery: null, receipt: null, invitationId: invite?.id ?? null, approvedBy: invite?.approvedBy ?? null };
    this.atomic(() => {
      if (invite) {
        const before = this.readInvitation(invite.id);
        if (before.digest !== sha256(p.invitation!) || before.requestId !== null || before.consumed || before.claims.expiresAt <= this.now()) throw new HubProtocolError("conflict");
        const updated = this.options.db.prepare("UPDATE hub_company_join_invites SET body=? WHERE id=? AND body=?").run(canonicalArguments({ ...before, requestId: b.requestId }), invite.id, canonicalArguments(before));
        if (updated.changes !== 1) throw new HubProtocolError("conflict");
      }
      this.records.insert(record); this.audit("company-join.requested", b.requestId);
    });
    return { requestId: b.requestId, expiresAt: outerDeadline, browserAction: this.options.identity.webOrigin + "/hub/join/open" };
  }
  private exact(binding: JoinBinding): JoinRecord {
    const r = this.records.get(binding.requestId);
    if (this.records.bindingDigest(r.binding) !== this.records.bindingDigest(binding)) throw new HubProtocolError("denied");
    return r;
  }
  browserOpen(id: string, state: string, origin: unknown): string {
    this.enabled(); const r = this.records.get(id);
    browserOriginProof(origin, r.binding.fleetOrigin); // MUST precede state/cookie mutation and any AD work.
    const supplied = sha256(validated(hash, state));
    if (!timingSafeEqual(Buffer.from(supplied, "hex"), Buffer.from(r.stateHash, "hex"))) throw new HubProtocolError("denied");
    const cookie = randomBytes(32).toString("hex");
    this.atomic(() => {
      if (!this.records.current(r) || r.stage !== "pending" || r.browserHash !== null) throw new HubProtocolError("conflict");
      if (r.outerDeadline <= this.now()) throw new HubProtocolError("expired");
      this.records.save({ ...r, browserHash: sha256(cookie), browserOrigin: r.binding.fleetOrigin, version: r.version + 1 }, r.version);
    });
    return cookie;
  }
  private browser(cookie: string, requestId: string): JoinRecord {
    validated(hash, cookie); this.check();
    const r = this.records.get(requestId);
    if (r.browserHash !== sha256(cookie) || r.browserOrigin !== r.binding.fleetOrigin) throw new HubProtocolError("denied");
    return this.expire(r);
  }
  browserView(cookie: string, requestId: string) {
    const r = this.browser(cookie, requestId);
    return { requestId: r.binding.requestId, label: r.label, fleetOrigin: r.binding.fleetOrigin, returnPath: r.binding.fleetOrigin + "/settings/hub", connected: !!r.issuedHash && this.options.connected?.(r.binding.fleetId) === true, ...this.view(r) };
  }
  private session(r: JoinRecord): boolean {
    if (!r.owner || !r.sessionId) return false;
    const row = this.options.db.prepare("SELECT s.person,s.state,s.expires_at,s.seen_at,p.status FROM hub_sessions s JOIN hub_people p ON p.person=s.person WHERE s.id=?")
      .get(r.sessionId) as { person: string; state: string; expires_at: number; seen_at: number; status: string } | undefined;
    return !!row && row.person === personKeyString(r.owner) && row.state === "active" && row.expires_at > this.now()
      && this.now() - row.seen_at <= HUB_SESSION_IDLE && row.status === "active";
  }
  private live(r: JoinRecord): boolean {
    return this.options.current() && this.control().enabled && this.records.current(r) && this.session(r) && this.now() < r.outerDeadline;
  }
  private groupError(error: unknown): never {
    if (error instanceof HubGroupAuthorizationError && error.reason === "denied"
      || error instanceof HubGroupEnrollmentRefusal && error.outcome === "denied") throw new HubProtocolError("denied");
    if (error instanceof HubGroupPolicyError) throw new HubProtocolError("unavailable");
    throw error;
  }
  async approve(ctx: HubRequestContext, cookie: string, requestId: string) {
    this.enabled(); const r = this.browser(cookie, requestId), actor = await ctx.current();
    if (actor.kind !== "directory" || ctx.isCurrent?.() !== true || !this.records.current(r) || r.stage !== "pending") throw new HubProtocolError("conflict");
    const owner = validated(person, actor.person), key = personKeyString(owner), now = this.now(), invitation = this.invitation(r);
    if (invitation && personKeyString(invitation.claims.owner) !== key) throw new HubProtocolError("denied");
    let expected = r;
    const live = () => ctx.isCurrent?.() === true && this.options.current() && this.control().enabled && this.records.current(expected) && this.now() < r.outerDeadline;
    const initial = this.options.store.read();
    if (enrollmentThrottled(initial, `quick:${key}`, 5, now) || enrollmentThrottled(initial, "quick:all", 48, now)) throw new HubProtocolError("backpressure");
    this.atomic(() => this.options.store.mutate({ at: now, requestId: ctx.requestId, actor: { kind: "person", person: owner }, action: "company-join.admission", result: "allowed" }, state => {
      if (!live()) throw new HubProtocolError("revoked");
      if (!spendEnrollmentBudget(state, `quick:${key}`, 5, now) || !spendEnrollmentBudget(state, "quick:all", 48, now)) throw new HubProtocolError("backpressure");
    }));
    let permit;
    try {
      const resource = { kind: "fleet" as const, id: r.binding.fleetId, revision: 1, owner }, context = { requestId: ctx.requestId, current: live };
      permit = invitation ? await this.options.groups.prepareManualEnrollment(resource, invitation.claims.approvedBy, context) : await this.options.groups.prepareEnrollment(resource, context);
    }
    catch (error) { if (!live()) throw new HubProtocolError("revoked"); return this.groupError(error); }
    if (permit.source !== (r.invitationId ? "manual" : "group") || !r.invitationId && permit.maxFleets < 1) throw new HubProtocolError("denied");
    this.atomic(() => {
      permit.assertCurrent(); if (!live()) throw new HubProtocolError("revoked");
      const transport = this.options.store.read();
      if (!invitation && (transport.pairings.some(p => p.expiresAt > this.now() && personKeyString(p.owner) === key && ["offered", "pending"].includes(p.state))
        || this.records.reservations(owner) > 0)) throw new HubProtocolError("conflict");
      if (!invitation && transport.pairings.filter(p => p.expiresAt > this.now()).length + this.retained() >= 48) throw new HubProtocolError("backpressure");
      if (!invitation && automaticFleetSlots(transport, owner, this.now(), this.records.reservations(owner)) >= permit.maxFleets) throw new CompanyJoinLimit();
      const at = this.now();
      expected = { ...r, owner, sessionId: actor.sessionId, approvedAt: at, redeemDeadline: Math.min(at + 60_000, r.outerDeadline),
        stage: "identity-approved", version: r.version + 1 };
      this.records.save(expected, r.version);
      this.audit("company-join.identity-approved", ctx.requestId, owner);
      permit.assertCurrent(); if (ctx.isCurrent?.() !== true) throw new HubProtocolError("revoked");
    });
    return { state: "identity-approved" };
  }
  private end(r: JoinRecord, reason: NonNullable<JoinRecord["reason"]>): JoinRecord {
    const next: JoinRecord = { ...r, stage: r.issuedHash ? "undeliverable" : "ended", reason, receipt: null, version: r.version + 1 };
    this.records.save(next, r.version); return next;
  }
  private expire(input: JoinRecord): JoinRecord {
    if (input.issuedHash && input.stage !== "revoked") {
      const fleet = this.options.store.read().fleets.find(f => f.id === input.binding.fleetId);
      if (!fleet || fleet.status !== "active" || fleet.generation !== 1 || fleet.credentialHash !== input.issuedHash
        || !input.owner || personKeyString(fleet.owner) !== personKeyString(input.owner)) {
        return this.atomic(() => {
          if (!this.records.current(input)) throw new HubProtocolError("conflict");
          const ended: JoinRecord = { ...input, stage: "revoked", reason: "revoked", receipt: null, version: input.version + 1 };
          this.records.save(ended, input.version); this.audit("company-join.revoked-result", input.binding.requestId, input.owner ?? undefined);
          return ended;
        });
      }
    }
    if (!["pending", "identity-approved", "issued"].includes(input.stage)) return input;
    const deadline = input.stage === "issued" ? input.deliveryDeadline! : input.stage === "identity-approved" ? input.redeemDeadline! : input.outerDeadline;
    if (this.now() < Math.min(deadline, input.outerDeadline)) return input;
    return this.atomic(() => {
      const r = this.records.get(input.binding.requestId);
      if (!this.records.current(input)) return r;
      const ended = this.end(r, "expired"); this.audit("company-join.expired", r.binding.requestId, r.owner ?? undefined); return ended;
    });
  }
  private view(r: JoinRecord) {
    return { state: r.stage, reason: r.reason, issued: r.issuedHash !== null, fleetId: r.issuedHash ? r.binding.fleetId : null,
      generation: r.issuedHash ? 1 : null, outerDeadline: r.outerDeadline, redeemDeadline: r.redeemDeadline, deliveryDeadline: r.deliveryDeadline };
  }
  status(binding: unknown, proof: unknown, payload: unknown, purpose: "status" | "tombstone" = "status") {
    const b = this.bound(binding); validated(z.strictObject({}), payload); this.consume(b, purpose, proof, payload);
    return this.view(this.expire(this.exact(b)));
  }
  cancel(binding: unknown, proof: unknown, payload: unknown) {
    const b = this.bound(binding); validated(z.strictObject({}), payload); this.consume(b, "cancel", proof, payload);
    return this.atomic(() => {
      const r = this.exact(b);
      if (["pending", "identity-approved", "issued"].includes(r.stage)) {
        const ended = this.end(r, "cancelled"); this.audit("company-join.cancelled", b.requestId, r.owner ?? undefined); return this.view(ended);
      }
      return this.view(r);
    });
  }
  private resource(r: JoinRecord) {
    if (!r.owner) throw new HubProtocolError("denied");
    return { kind: "fleet" as const, id: r.binding.fleetId, revision: 1, owner: r.owner };
  }
  private provenance(r: JoinRecord): { source: "group" | "manual"; revision: number; digest: string } {
    const resource = this.resource(r), raw = this.options.db.prepare("SELECT body,source,state,revision FROM hub_group_resources WHERE resource_key=?")
      .get(JSON.stringify(["fleet", resource.id, 1])) as { body: string; source: "group" | "manual"; state: string; revision: number } | undefined;
    if (!raw || raw.state !== "active" || raw.source !== (r.invitationId ? "manual" : "group") || raw.revision < 1
      || canonicalArguments(parseStrictJson(raw.body)) !== canonicalArguments(resource)) throw new HubProtocolError("denied");
    const events = this.options.db.prepare("SELECT body FROM hub_group_resource_events WHERE json_extract(body,'$.resource.kind')='fleet' AND json_extract(body,'$.resource.id')=? AND json_extract(body,'$.resource.revision')=1 ORDER BY rowid LIMIT 257")
      .all(resource.id) as { body: string }[];
    if (!events.length || events.length > 256) throw new HubProtocolError("unavailable");
    return { source: raw.source, revision: raw.revision, digest: sha256(canonicalArguments({ row: raw, events: events.map(e => parseStrictJson(e.body)) })) };
  }
  private assertIssued(r: JoinRecord): DeliveryBinding {
    if (!r.owner || !r.issuedHash || !r.delivery || r.stage !== "issued" || !r.receipt || !this.live(r)
      || r.deliveryDeadline === null || this.now() >= r.deliveryDeadline) throw new HubProtocolError("revoked");
    const fleet = this.options.store.read().fleets.find(f => f.id === r.binding.fleetId);
    if (!fleet || fleet.status !== "active" || fleet.generation !== 1 || fleet.credentialHash !== r.issuedHash
      || personKeyString(fleet.owner) !== personKeyString(r.owner)) throw new HubProtocolError("revoked");
    const source = this.provenance(r);
    const expected: DeliveryBinding = { ...r.delivery, hubIdentityDigest: companyIdentityDigest(this.options.identity),
      requestId: r.binding.requestId, operationId: r.binding.operationId, owner: r.owner, fleetId: r.binding.fleetId, generation: 1,
      joinKeyThumbprint: joinKeyThumbprint(r.binding.publicKey), verifierS256: r.binding.verifierS256, issuedCredentialHash: r.issuedHash,
      resourceRevision: source.revision, committedSource: source.source, provenanceDigest: source.digest,
      deliveryDeadline: r.deliveryDeadline, outerDeadline: r.outerDeadline };
    if (canonicalArguments(expected) !== canonicalArguments(r.delivery)) throw new HubProtocolError("denied");
    return expected;
  }
  private async resourcePermit(r: JoinRecord, current: () => boolean = () => this.live(r)): Promise<HubGroupPermit> {
    if (!this.live(r)) throw new HubProtocolError("revoked");
    let permit;
    try { permit = await this.options.groups.check(this.resource(r), { requestId: r.binding.requestId, current }); }
    catch (error) {
      if (error instanceof HubGroupAuthorizationError && ["denied", "resume-required"].includes(error.reason)) {
        this.atomic(() => {
          if (this.records.current(r)) {
            this.end(r, "authority"); this.audit("company-join.delivery-refused", r.binding.requestId, r.owner ?? undefined);
          }
        });
      }
      return this.groupError(error);
    }
    if (permit.source !== (r.invitationId ? "manual" : "group")) throw new HubProtocolError("denied");
    permit.assertCurrent(); this.assertIssued(r); return permit;
  }
  private async reveal(r: JoinRecord) {
    const permit = await this.resourcePermit(r);
    return this.atomic(() => {
      permit.assertCurrent(); const binding = this.assertIssued(r);
      const credential = this.seal().open(binding, r.receipt, this.now());
      permit.assertCurrent(); this.assertIssued(r);
      return { ...this.view(r), owner: r.owner, credential, hub: this.options.identity, certificatePem: this.options.certificatePem };
    });
  }
  async redeem(binding: unknown, proof: unknown, payload: unknown) {
    const b = this.bound(binding), p = validated(redeemPayload, payload); this.consume(b, "redeem", proof, p);
    if (pkceChallenge(p.verifier) !== b.verifierS256) throw new HubProtocolError("denied");
    let expected = this.expire(this.exact(b));
    if (expected.stage === "issued") return this.reveal(expected); // SAME result, never enrollment
    if (expected.stage !== "identity-approved" || !expected.owner) throw new HubProtocolError("expired");
    const owner = expected.owner;
    const live = () => this.live(expected) && expected.redeemDeadline !== null && this.now() < expected.redeemDeadline;
    if (!live()) throw new HubProtocolError("revoked");
    const sealer = this.seal();
    let permit, eligibility;
    try {
      const invitation = this.invitation(expected), context = { requestId: b.requestId, current: live };
      eligibility = await this.options.groups.prepareOwnerEligibility(owner, context);
      permit = invitation ? await this.options.groups.prepareManualEnrollment(this.resource(expected), invitation.claims.approvedBy, context)
        : await this.options.groups.prepareEnrollment(this.resource(expected), context);
    }
    catch (error) { if (!live()) throw new HubProtocolError("revoked"); return this.groupError(error); }
    if (permit.source !== (expected.invitationId ? "manual" : "group") || !expected.invitationId && permit.maxFleets < 1) throw new HubProtocolError("denied");
    const credential = randomBytes(32).toString("hex"), issuedHash = sha256(credential);
    this.atomic(() => {
      eligibility.assertCurrent(); permit.assertCurrent(); if (!live()) throw new HubProtocolError("revoked");
      this.options.store.mutate({ at: this.now(), requestId: b.requestId, actor: { kind: "person", person: owner },
        fleetId: b.fleetId, action: expected.invitationId ? "company-join.admin-approved" : "company-join.group-approved", result: "allowed" }, state => {
        if (!live()) throw new HubProtocolError("revoked");
        if (!expected.invitationId && automaticFleetSlots(state, owner, this.now(), this.records.reservations(owner, b.requestId)) >= permit.maxFleets) throw new CompanyJoinLimit();
        if (state.fleets.length >= 256 || state.fleets.some(f => f.id === b.fleetId)) throw new HubProtocolError("backpressure");
        state.fleets.push({ id: b.fleetId, owner, credentialHash: issuedHash, generation: 1, status: "active", label: expected.label });
      });
      permit.commit(this.options.db);
      const source = this.provenance({ ...expected, owner });
      const issuedAt = this.now(), deliveryDeadline = Math.min(issuedAt + 120_000, expected.outerDeadline);
      const delivery: DeliveryBinding = { hubIdentityDigest: companyIdentityDigest(this.options.identity), requestId: b.requestId,
        operationId: b.operationId, owner, fleetId: b.fleetId, generation: 1, joinKeyThumbprint: joinKeyThumbprint(b.publicKey),
        verifierS256: b.verifierS256, issuedCredentialHash: issuedHash, resourceRevision: source.revision, committedSource: source.source,
        provenanceDigest: source.digest, issuedAt, deliveryDeadline, outerDeadline: expected.outerDeadline };
      const receipt = sealer.seal(delivery, credential);
      this.options.db.prepare("INSERT INTO hub_company_join_cipher_nonces VALUES(?,?)").run(receipt.keyId, receipt.nonce);
      this.options.notices.enqueue(this.options.db, { fleetId: b.fleetId, generation: 1, owner, label: expected.label,
        at: issuedAt, initiatingSessionId: expected.sessionId!, source: source.source }, this.options.store.read());
      const next: JoinRecord = { ...expected, stage: "issued", delivery, receipt, issuedHash, deliveryDeadline, version: expected.version + 1 };
      if (expected.invitationId) {
        const invitation = this.invitation(expected)!;
        const changed = this.options.db.prepare("UPDATE hub_company_join_invites SET body=? WHERE id=? AND body=?")
          .run(canonicalArguments({ ...invitation, consumed: true }), expected.invitationId, canonicalArguments(invitation));
        if (changed.changes !== 1) throw new HubProtocolError("conflict");
      }
      this.records.save(next, expected.version); expected = next;
      eligibility.assertCurrent(); permit.assertCurrent(); this.assertIssued(expected);
    });
    try { this.options.notices.committed(); } catch { /* required outbox is already durable; transport retries */ }
    return this.reveal(expected);
  }
  async acknowledge(binding: unknown, proof: unknown, payload: unknown) {
    const b = this.bound(binding), p = validated(ackPayload, payload); this.consume(b, "ack", proof, p);
    if (pkceChallenge(p.verifier) !== b.verifierS256) throw new HubProtocolError("denied");
    const r = this.expire(this.exact(b));
    if (!r.issuedHash || r.issuedHash !== p.credentialHash) throw new HubProtocolError("denied");
    if (r.stage === "acknowledged") return this.view(r);
    let expected = r;
    const permit = await this.resourcePermit(r, () => this.live(expected));
    return this.atomic(() => {
      permit.assertCurrent(); this.assertIssued(r);
      const next: JoinRecord = { ...r, receipt: null, stage: "acknowledged", version: r.version + 1 };
      this.records.save(next, r.version); expected = next;
      this.audit("company-join.delivery-acknowledged", b.requestId, r.owner!, b.fleetId);
      permit.assertCurrent();
      if (!this.session(next) || !this.records.current(next) || !this.options.current() || !this.control().enabled
        || this.now() >= next.deliveryDeadline! || this.now() >= next.outerDeadline) throw new HubProtocolError("revoked");
      const fleet = this.options.store.read().fleets.find(f => f.id === b.fleetId);
      if (!fleet || fleet.status !== "active" || fleet.generation !== 1 || fleet.credentialHash !== next.issuedHash
        || personKeyString(fleet.owner) !== personKeyString(next.owner!)) throw new HubProtocolError("revoked");
      this.provenance(next);
      return this.view(next);
    });
  }
}
