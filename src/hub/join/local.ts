/** One private Fleet operation. Original requester + confirmer authority survives Settings completion, never its execution token. */
import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, randomInt, randomUUID } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { CompanyJoinClient, CompanyJoinRemoteError } from "./client.js";
import { CompanyTrustStore, CompanyIdentityChanged } from "./trust.js";
import { parseCompanyAddress } from "./descriptor.js";
import { canonicalFleetOrigin, companyIdentityDigest, pkceChallenge, requireSeparateJoinHosts, CompanyBrowserHostnameConflict } from "./protocol.js";
import { hash, uuid, epoch, person, token, validated, HubProtocolError, parseStrictJson } from "../validation.js";
import { sha256, issuerKeyId } from "../identity.js";
import { HubMemberProfileStore, profileSchema, validateHubBinding, type HubMemberProfile } from "../profile.js";
import { ensurePrivateDirectory, readPrivateFile } from "../private-files.js";
import { syncJoinPrivate, writeJoinPrivate, createJoinPrivate } from "./private.js";
import { createLocalJoin, currentLocalJoinId, readLocalJoin, saveLocalJoin, selectLocalJoin,
  type LocalJoinJournal, type JoinLocalSnapshot, type JoinLocalAuthority, type JoinLocalSession } from "./local-journal.js";
export type { JoinLocalAuthority, JoinLocalSession } from "./local-journal.js";
const remoteSchema = z.strictObject({ state: z.enum(["pending", "identity-approved", "issued", "acknowledged", "undeliverable", "ended", "revoked"]),
  reason: z.string().max(64).nullable(), issued: z.boolean(), fleetId: uuid.nullable(), generation: epoch.nullable(),
  outerDeadline: epoch, redeemDeadline: epoch.nullable(), deliveryDeadline: epoch.nullable() });
const deliveredSchema = remoteSchema.extend({ owner: person, credential: token, hub: profileSchema.shape.hub, certificatePem: profileSchema.shape.certificatePem });
const pushedSchema = z.strictObject({ requestId: uuid, expiresAt: epoch, browserAction: z.string().max(2048) });
interface Options {
  home: string; client?: Pick<CompanyJoinClient, "discover" | "command">; now?(): number; schedule?: false;
  /** Relevant membership/binding incarnation only; unrelated Settings edits do not revoke consent. */
  snapshot(): JoinLocalSnapshot;
  /** Synchronous, already-confirmed internal patch. accept() captures ONLY that owned write, before yielding. */
  enableMembership(current: () => boolean, accept: () => void): void;
  activate(): void; link(): "online" | "offline";
}
interface Operation { record: LocalJoinJournal; authority: JoinLocalAuthority; generation: number; busy?: Promise<void>; nextPollAt?: number }
const sameSnapshot = (a: JoinLocalSnapshot, b: JoinLocalSnapshot) => a.membership === b.membership && a.binding === b.binding;
export class CompanyJoinController {
  private readonly client: Pick<CompanyJoinClient, "discover" | "command">;
  private active: Operation | null = null; private generation = 0; private closed = false; private timer?: NodeJS.Timeout; private starting = false;
  constructor(private readonly options: Options) {
    this.client = options.client ?? new CompanyJoinClient();
    if (options.schedule !== false) {
      const schedule = () => { this.timer = setTimeout(() => {
        if (this.closed) return; const op = this.active; if (op) void this.advance(op); schedule();
      }, 1250 + randomInt(501)); this.timer.unref(); };
      schedule();
    }
  }
  private now() { return this.options.now?.() ?? Date.now(); }
  private own(r: LocalJoinJournal, session: JoinLocalSession): void {
    if (this.closed || !session.current() || r.sessionId !== session.sessionId || r.authorityEpoch !== session.authorityEpoch)
      throw new HubProtocolError("denied");
  }
  private live(op: Operation): boolean {
    return !this.closed && this.active === op && op.generation === this.generation && op.authority.session.current()
      && op.authority.confirmedCurrent() && sameSnapshot(op.record.snapshot, this.options.snapshot()) && this.now() < op.record.deadline
      && !["cancelled", "ended"].includes(op.record.stage);
  }
  private persist(op: Operation, patch: Partial<LocalJoinJournal>, current: () => boolean = () => this.live(op)): void {
    const next = { ...op.record, ...patch }; saveLocalJoin(this.options.home, next, current); op.record = next;
  }
  private expiredUnissued(r: LocalJoinJournal): boolean {
    // A lost redeem reply may have issued a credential. Its exact recovery remains required after expiry.
    return !r.issued && r.outcomeKnown && this.now() >= r.deadline;
  }
  private view(r: LocalJoinJournal) {
    const expired = this.expiredUnissued(r) && !["cancelled", "ended"].includes(r.stage);
    return { operationId: r.operationId, handoffId: r.handoffId, state: expired ? "ended" : r.stage === "active" ? "saved" : r.stage === "pending" ? "awaiting-sign-in" : r.stage === "preparing" ? "joining" : r.stage,
      reason: expired ? "expired" : r.reason, hubOrigin: r.binding.hub.webOrigin, expiresAt: r.deadline, issued: r.issued, outcomeKnown: r.outcomeKnown,
      fleetId: r.issued ? r.binding.fleetId : null, ...(r.stage === "active" ? { link: this.options.link() } : {}) };
  }
  private assertUnbound(): void {
    if (this.bound()) throw new HubProtocolError("conflict");
  }
  bound(): boolean {
    const state = this.memberState();
    // Even an incomplete/disconnected binding must be explicitly retired through its existing local flow first.
    if (state.hubId !== undefined) return true;
    const root = join(this.options.home, "hub-member");
    if (!existsSync(root)) return false;
    return readdirSync(root, { withFileTypes: true }).some(entry => {
      if (!uuid.safeParse(entry.name).success) return false;
      if (!entry.isDirectory() || existsSync(join(root, entry.name, "pending.json"))) return true;
      const digest = new HubMemberProfileStore(this.options.home, entry.name).profileDigest();
      return digest !== null && !state.retired.some(r => r.hubId === entry.name && r.profile === digest);
    });
  }
  private memberState(): { hubId?: string; retired: Array<{ hubId: string; profile: string | null }> } {
    const path = "hub-member/state.json";
    if (!existsSync(join(this.options.home, path))) return { retired: [] as Array<{ hubId: string; profile: string | null }> };
    return validated(z.object({ hubId: uuid.optional(), retired: z.array(z.strictObject({ hubId: uuid, profile: hash.nullable() })).max(1024).default([]) }).passthrough(), parseStrictJson(readPrivateFile(this.options.home, path)));
  }
  private retiredProfile(hubId: string): string | null {
    const digest = new HubMemberProfileStore(this.options.home, hubId).profileDigest();
    return digest !== null && this.memberState().retired.some(r => r.hubId === hubId && r.profile === digest) ? digest : null;
  }
  private priorBlocks(prior: LocalJoinJournal): boolean {
    if (prior.issued) return !(prior.outcomeKnown && prior.stage === "active" && prior.profileDigest && this.retiredProfile(prior.binding.hub.hubId) === prior.profileDigest);
    return !this.expiredUnissued(prior) && (!prior.outcomeKnown || !["cancelled", "ended"].includes(prior.stage));
  }
  current(session: JoinLocalSession) {
    if (this.closed || !session.current()) throw new HubProtocolError("denied");
    const id = currentLocalJoinId(this.options.home); if (!id) return null;
    const r = readLocalJoin(this.options.home, id);
    // The no-handle discovery route reveals only this session's operation. Exact handles still require own().
    if (r.sessionId !== session.sessionId || r.authorityEpoch !== session.authorityEpoch) return null;
    this.own(r, session); return this.view(r);
  }
  async repairTrust(addressInput: string, authority: JoinLocalAuthority): Promise<void> {
    this.assertUnbound();
    const address = parseCompanyAddress(addressInput);
    if (address.expected === null || address.invitation) throw new HubProtocolError("invalid");
    const id = currentLocalJoinId(this.options.home), prior = id ? readLocalJoin(this.options.home, id) : null;
    if (prior && this.priorBlocks(prior)) throw new HubProtocolError("conflict");
    const snapshot = this.options.snapshot(), generation = this.generation;
    const current = () => !this.closed && !this.starting && generation === this.generation && sameSnapshot(snapshot, this.options.snapshot())
      && authority.session.current() && authority.confirmedCurrent();
    if (!current()) throw new HubProtocolError("denied");
    const metadata = await this.client.discover(address.webOrigin, current);
    if (!current()) throw new HubProtocolError("stale");
    new CompanyTrustStore(this.options.home).repair(metadata.hub, address.expected, current);
  }
  async start(input: { address: string; label: string; fleetOrigin: string; handoffId?: string }, authority: JoinLocalAuthority) {
    const body = validated(z.strictObject({ address: z.string().max(8192), label: z.string().trim().min(1).max(120), fleetOrigin: z.string().max(2048), handoffId: uuid.optional() }), input);
    canonicalFleetOrigin(body.fleetOrigin);
    if (this.closed || this.starting || !authority.session.current() || !authority.confirmedCurrent()) throw new HubProtocolError("denied");
    this.assertUnbound();
    const priorId = currentLocalJoinId(this.options.home);
    if (priorId) {
      const prior = readLocalJoin(this.options.home, priorId);
      if (this.priorBlocks(prior)) throw new HubProtocolError("conflict");
    }
    this.starting = true; const gen = ++this.generation, snapshot = this.options.snapshot(), started = this.now();
    const current = () => !this.closed && gen === this.generation && sameSnapshot(snapshot, this.options.snapshot())
      && authority.session.current() && authority.confirmedCurrent() && this.now() < started + 600_000;
    try {
      const address = parseCompanyAddress(body.address);
      requireSeparateJoinHosts(body.fleetOrigin, address.webOrigin);
      const metadata = await this.client.discover(address.webOrigin, current);
      if (!current()) throw new HubProtocolError("stale");
      requireSeparateJoinHosts(body.fleetOrigin, metadata.hub.webOrigin);
      // An established legacy binding is an additional trust anchor, never a way to forget a mismatched pin.
      let existing = null;
      try {
        if (existsSync(join(this.options.home, "hub-member/state.json"))) {
          const s = parseStrictJson(readPrivateFile(this.options.home, "hub-member/state.json")) as { hubId?: string };
          if (s.hubId) existing = new HubMemberProfileStore(this.options.home, s.hubId).readProfile().hub;
        }
      } catch { throw new HubProtocolError("uncertain"); }
      new CompanyTrustStore(this.options.home).checkAndPin(metadata.hub, address.expected, existing, current);
      const folder = ensurePrivateDirectory(this.options.home, "hub-member/company-joins");
      if (readdirSync(folder).length >= 1024) throw new HubProtocolError("backpressure");
      const key = generateKeyPairSync("ed25519"), verifier = randomBytes(32).toString("base64url"), operationId = randomUUID(), browserState = randomBytes(32).toString("hex");
      const record: LocalJoinJournal = { v: 1, operationId, handoffId: body.handoffId ?? randomUUID(), binding: { hub: metadata.hub, requestId: randomUUID(), operationId, fleetId: randomUUID(),
        publicKey: key.publicKey.export({ type: "spki", format: "pem" }).toString(), fleetOrigin: body.fleetOrigin, verifierS256: pkceChallenge(verifier) },
        privateKey: key.privateKey.export({ type: "pkcs8", format: "pem" }).toString(), verifier, browserState, certificatePem: metadata.certificatePem,
        sessionId: authority.session.sessionId, authorityEpoch: authority.session.authorityEpoch, hostConfirmed: authority.session.hostHere,
        snapshot, createdAt: started, deadline: started + 600_000, stage: "preparing", reason: null, issued: false, outcomeKnown: true, issuedHash: null,
        profileDigest: null, replaceProfile: this.retiredProfile(metadata.hub.hubId), intendedBinding: null, enableIntent: false, journalCommitId: randomUUID(), remoteState: null };
      createLocalJoin(this.options.home, record, current); selectLocalJoin(this.options.home, operationId, current);
      const op: Operation = { record, authority, generation: gen }; this.active = op;
      try {
        const pushed = validated(pushedSchema, await this.client.command(record.binding, "push", { label: body.label, stateHash: sha256(browserState), invitation: address.invitation ?? null }, key.privateKey, () => this.live(op)));
        if (pushed.requestId !== record.binding.requestId || pushed.browserAction !== metadata.hub.webOrigin + "/hub/join/open" || pushed.expiresAt <= this.now()) throw new HubProtocolError("denied");
        this.persist(op, { stage: "pending", deadline: Math.min(record.deadline, pushed.expiresAt) });
      } catch (error) { this.hold(op, error); }
      return this.view(op.record);
    } finally { this.starting = false; }
  }
  private reason(error: unknown): string {
    if (error instanceof CompanyBrowserHostnameConflict) return "separate-hostnames";
    if (error instanceof CompanyIdentityChanged) return "identity-changed";
    if (error instanceof CompanyJoinRemoteError) return error.code;
    if (error instanceof HubProtocolError) return error.code;
    return "unsaved";
  }
  private hold(op: Operation, error: unknown): void {
    if (this.closed || this.active !== op || op.generation !== this.generation || ["cancelled", "ended", "active"].includes(op.record.stage)) return;
    try { this.reconcileSettlement(op); } catch { /* Preserve the intent for a later exact recovery. */ }
    // Persist the fence even after authority loss. This only withdraws the existing operation; it never adds authority.
    const reason = !op.authority.session.current() || !op.authority.confirmedCurrent() || !sameSnapshot(op.record.snapshot, this.options.snapshot()) ? "authority"
      : this.now() >= op.record.deadline ? "expired" : this.reason(error);
    try { this.persist(op, { stage: "held", reason }, () => !this.closed && this.active === op && op.generation === this.generation); }
    catch { op.record = { ...op.record, stage: "held", reason: "unsaved" }; }
  }
  private restore(id: string, session: JoinLocalSession): Operation {
    const r = readLocalJoin(this.options.home, id); this.own(r, session);
    if (this.active?.record.operationId === id) return this.active;
    if (currentLocalJoinId(this.options.home) !== id) throw new HubProtocolError("conflict");
    const op: Operation = { record: r, authority: { session, confirmedCurrent: () => r.hostConfirmed && session.hostHere && session.current() }, generation: ++this.generation };
    this.active = op;
    if (r.stage !== "active" && (!r.hostConfirmed || !session.hostHere)) {
      if (!["cancelled", "ended"].includes(r.stage) && r.reason !== "authority") this.persist(op, { stage: "held", reason: "confirmation-required" }, () => !this.closed && session.current());
    } else this.reconcileSettlement(op);
    return op;
  }
  /** Intent precedes every owned marker/config write. Recovery adopts only its exact digest and switch value. */
  private reconcileSettlement(op: Operation): void {
    const r = op.record, actual = this.options.snapshot();
    if (sameSnapshot(r.snapshot, actual) || !r.intendedBinding || r.reason === "authority" || ["cancelled", "ended", "active"].includes(r.stage)) return;
    if (!op.authority.session.current() || !op.authority.confirmedCurrent() || this.now() >= r.deadline
      || actual.binding !== r.intendedBinding || actual.membership !== r.snapshot.membership && !(r.enableIntent && actual.membership)) return;
    this.persist(op, { snapshot: actual }, () => !this.closed && this.active === op && op.generation === this.generation
      && op.authority.session.current() && op.authority.confirmedCurrent() && sameSnapshot(actual, this.options.snapshot()));
  }
  async status(id: string, session: JoinLocalSession) {
    const op = this.restore(id, session);
    if (!op.record.outcomeKnown && ["held", "cancelled", "ended"].includes(op.record.stage)) {
      try {
        const result = validated(remoteSchema, await this.client.command(op.record.binding, "tombstone", {}, createPrivateKey(op.record.privateKey), () => !this.closed && session.current()));
        this.persist(op, { issued: result.issued, outcomeKnown: true, remoteState: result.state }, () => !this.closed && session.current());
      } catch { /* Retain the unknown result; no fresh enrollment. */ }
    }
    await this.advance(op); return this.view(op.record);
  }
  bridge(id: string, session: JoinLocalSession) {
    const op = this.restore(id, session);
    if (!this.live(op) || op.record.stage !== "pending") throw new HubProtocolError("expired");
    return { action: op.record.binding.hub.webOrigin + "/hub/join/open", requestId: op.record.binding.requestId, state: op.record.browserState };
  }
  async resume(id: string, authority: JoinLocalAuthority) {
    const r = readLocalJoin(this.options.home, id); this.own(r, authority.session);
    if (!authority.confirmedCurrent() || r.reason === "authority"
      || ["cancelled", "ended"].includes(r.stage) || this.now() >= r.deadline) throw new HubProtocolError("denied");
    const op: Operation = { record: r, authority, generation: ++this.generation }; this.active = op;
    this.reconcileSettlement(op);
    if (!sameSnapshot(op.record.snapshot, this.options.snapshot())) throw new HubProtocolError("denied");
    this.persist(op, { stage: r.profileDigest ? "durable" : "pending", reason: null });
    await this.advance(op); return this.view(op.record);
  }
  private advance(op: Operation): Promise<void> {
    if (op.busy) return op.busy;
    if (["active", "held", "cancelled", "ended"].includes(op.record.stage)) return Promise.resolve();
    if (this.now() < (op.nextPollAt ?? 0)) return Promise.resolve();
    op.nextPollAt = this.now() + 1250 + randomInt(501);
    op.busy = this.step(op).catch(error => this.hold(op, error)).finally(() => { op.busy = undefined; });
    return op.busy;
  }
  private async step(op: Operation): Promise<void> {
    const current = () => this.live(op); if (!current()) throw new HubProtocolError("stale");
    const r = op.record, key = createPrivateKey(r.privateKey);
    const status = validated(remoteSchema, await this.client.command(r.binding, "status", {}, key, current));
    if (!current()) throw new HubProtocolError("stale");
    if (status.issued && (status.fleetId !== r.binding.fleetId || status.generation !== 1)) throw new HubProtocolError("denied");
    this.persist(op, { issued: status.issued, outcomeKnown: true, remoteState: status.state });
    if (["ended", "undeliverable", "revoked"].includes(status.state)) {
      this.persist(op, { stage: "ended", reason: status.reason ?? status.state }); return;
    }
    if (status.state === "pending") return;
    if (status.state === "acknowledged") {
      if (!r.profileDigest || !r.issuedHash) throw new HubProtocolError("uncertain");
      return this.activate(op, current);
    }
    this.persist(op, { outcomeKnown: false }); // A dropped response may follow a completed Hub issuance.
    const delivered = validated(deliveredSchema, await this.client.command(r.binding, "redeem", { verifier: r.verifier }, key, current));
    if (!current() || delivered.state !== "issued" || delivered.fleetId !== r.binding.fleetId || delivered.generation !== 1
      || companyIdentityDigest(delivered.hub) !== companyIdentityDigest(r.binding.hub)) throw new HubProtocolError("denied");
    this.persist(op, { issued: true, outcomeKnown: true, issuedHash: sha256(delivered.credential) });
    const profile: HubMemberProfile = validateHubBinding(validated(profileSchema, { v: 1, hub: delivered.hub, owner: delivered.owner,
      fleetId: r.binding.fleetId, credential: delivered.credential, issuerKeyId: issuerKeyId(createPublicKey(delivered.hub.issuerPublicKey)), certificatePem: delivered.certificatePem }));
    const store = new HubMemberProfileStore(this.options.home, profile.hub.hubId), prior = store.profileDigest();
    if (prior !== null && prior !== r.profileDigest && prior !== r.replaceProfile) throw new HubProtocolError("conflict");
    if (r.issuedHash && r.issuedHash !== sha256(profile.credential)) throw new HubProtocolError("denied");
    // Adopt a journal-aware marker BEFORE saving a profile. Any crash from here fails closed until that exact journal is active.
    const statePath = "hub-member/state.json";
    const state = existsSync(join(this.options.home, statePath)) ? parseStrictJson(readPrivateFile(this.options.home, statePath)) as Record<string, unknown> : {};
    if (state.hubId && state.hubId !== profile.hub.hubId) throw new HubProtocolError("conflict");
    const expectedDigest = sha256(JSON.stringify(profile));
    const marker = { operationId: r.operationId, profileDigest: expectedDigest, journalCommitId: r.journalCommitId };
    const stateValue = JSON.stringify({ ...state, hubId: profile.hub.hubId, companyJoin: marker });
    this.persist(op, { profileDigest: expectedDigest, intendedBinding: sha256(stateValue) });
    if (!current()) throw new HubProtocolError("stale");
    if (existsSync(join(this.options.home, statePath))) writeJoinPrivate(this.options.home, statePath, stateValue, current);
    else createJoinPrivate(this.options.home, statePath, stateValue);
    op.record = { ...op.record, snapshot: this.options.snapshot() };
    store.saveProfile(profile, prior, current);
    syncJoinPrivate(this.options.home, `hub-member/${profile.hub.hubId}/pairing.json`);
    if (store.profileDigest() !== expectedDigest || !current()) throw new HubProtocolError("stale");
    this.persist(op, { stage: "durable", issued: true, issuedHash: sha256(profile.credential), profileDigest: expectedDigest });
    this.persist(op, { enableIntent: true });
    this.options.enableMembership(current, () => { if (!op.authority.session.current() || !op.authority.confirmedCurrent()) throw new HubProtocolError("stale"); op.record = { ...op.record, snapshot: this.options.snapshot() }; });
    this.persist(op, {});
    const ack = validated(remoteSchema, await this.client.command(r.binding, "ack", { verifier: r.verifier, credentialHash: sha256(profile.credential),
      profileDigest: expectedDigest, journalCommitId: r.journalCommitId }, key, current));
    if (ack.state !== "acknowledged" || !current()) throw new HubProtocolError("stale");
    this.activate(op, current);
  }
  private activate(op: Operation, current: () => boolean): void {
    const r = op.record, store = new HubMemberProfileStore(this.options.home, r.binding.hub.hubId);
    if (!current() || !r.profileDigest || !r.issuedHash || store.profileDigest() !== r.profileDigest || sha256(store.readProfile().credential) !== r.issuedHash)
      throw new HubProtocolError("stale");
    syncJoinPrivate(this.options.home, `hub-member/${r.binding.hub.hubId}/pairing.json`);
    this.persist(op, { stage: "active", reason: null });
    if (!current()) throw new HubProtocolError("stale");
    this.options.activate();
  }
  async cancel(id: string, session: JoinLocalSession) {
    const op = this.restore(id, session); this.own(op.record, session);
    if (op.record.stage === "active") throw new HubProtocolError("conflict");
    op.generation = ++this.generation;
    this.persist(op, { stage: "cancelled", reason: "cancelled" }, () => !this.closed && session.current());
    const current = () => !this.closed && session.current() && this.active === op && op.record.stage === "cancelled";
    try {
      const result = validated(remoteSchema, await this.client.command(op.record.binding, "cancel", {}, createPrivateKey(op.record.privateKey), current));
      this.persist(op, { issued: result.issued, outcomeKnown: true, remoteState: result.state }, current);
    } catch { /* Exact result may be unknown; retain this journal, key and cancellation. Never start another issuance. */ }
    return this.view(op.record);
  }
  invalidate(): void { const op = this.active; if (op && op.record.stage !== "active") {
    try { this.persist(op, { stage: "held", reason: "authority" }, () => !this.closed); } catch { op.record = { ...op.record, stage: "held", reason: "authority" }; }
    ++this.generation;
  } else if (!op && !this.closed) {
    // A config change can precede the first status read after restart. Withdraw the durable pending consent too.
    try { const id = currentLocalJoinId(this.options.home); if (id) { const r = readLocalJoin(this.options.home, id);
      if (!["active", "cancelled", "ended"].includes(r.stage)) saveLocalJoin(this.options.home, { ...r, stage: "held", reason: "authority" }, () => !this.closed);
    } } catch { /* Unreadable private state already refuses recovery. */ }
    ++this.generation;
  } }
  close(): void { this.closed = true; ++this.generation; if (this.timer) clearTimeout(this.timer); }
}
