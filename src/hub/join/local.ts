/** One private Fleet operation. Original requester + confirmer authority survives Settings completion, never its execution token. */
import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, randomInt, randomUUID } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { CompanyJoinClient, CompanyJoinRemoteError, CompanyJoinReachError } from "./client.js";
import { hostname } from "node:os";
import { readDisplay, saveStartDisplay, settleDisplay, type CompanyDisplay } from "./display.js";
import { CompanyTrustStore, CompanyIdentityChanged } from "./trust.js";
import { ENROLMENT_CODE, normalEnrolmentCode, parseCompanyAddress } from "./descriptor.js";
export { ENROLMENT_CODE, normalEnrolmentCode } from "./descriptor.js";
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
const deliveredSchema = remoteSchema.extend({ owner: person, credential: token, hub: profileSchema.shape.hub, certificatePem: profileSchema.shape.certificatePem,
  // M-2921 / S1.3: display only, sent when asked for (X-AgEnD-Join-Display); a Hub that predates them sends neither.
  ownerLabel: z.string().max(200).optional(), hubName: z.string().max(200).optional() });
const pushedSchema = z.strictObject({ requestId: uuid, expiresAt: epoch, browserAction: z.string().max(2048) });
interface Options {
  home: string; client?: Pick<CompanyJoinClient, "discover" | "command">; now?(): number; schedule?: false;
  /** Relevant membership/binding incarnation only; unrelated Settings edits do not revoke consent. */
  snapshot(): JoinLocalSnapshot;
  /** Synchronous, already-confirmed internal patch. accept() captures ONLY that owned write, before yielding. */
  enableMembership(current: () => boolean, accept: () => void): void;
  activate(): void; link(): "online" | "offline";
}
interface Operation { record: LocalJoinJournal; authority: JoinLocalAuthority; generation: number; busy?: Promise<void>; nextPollAt?: number;
  /** S1 (M-2921): what holds the pending request at the Hub right now (from its last status; not saved — the next poll says again). */
  waiting?: JoinWaiting | null }
/** S1: the Hub's nonterminal obstructions on a pending request (cleared once approved; the same request can go on after). */
const JOIN_WAITING = ["offer-pending", "limit-reached", "denied", "backpressure"] as const;
export type JoinWaiting = typeof JOIN_WAITING[number];
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
      fleetId: r.issued ? r.binding.fleetId : null, ...(r.stage === "active" ? { link: this.options.link() } : {}),
      waiting: r.stage === "pending" && !expired && this.active?.record.operationId === r.operationId ? this.active.waiting ?? null : null };
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
  /**
   * alpha.2 findings 3/4: a HELD attempt another private admin session started (another tab, a new browser session, a
   * restart's new cookie) is taken over by this one: its journal is re-bound to this session, so Recover (a confirmed
   * resume) and Cancel work from any admin session, not only the tab that started it. An attempt still in flight
   * (preparing / pending / durable) is never taken: its own tab is mid-sign-in. Re-binding adds no authority — resume still
   * needs this session's confirmation, and cancel only withdraws.
   */
  private adopt(id: string, session: JoinLocalSession, hostConfirmed: boolean): void {
    const r = readLocalJoin(this.options.home, id);
    if (r.sessionId === session.sessionId && r.authorityEpoch === session.authorityEpoch) return;
    if (this.closed || !session.current() || currentLocalJoinId(this.options.home) !== id || r.stage !== "held" || !this.priorBlocks(r))
      throw new HubProtocolError("denied");
    if (this.active?.record.operationId === id) this.active = null;
    ++this.generation;
    saveLocalJoin(this.options.home, { ...r, sessionId: session.sessionId, authorityEpoch: session.authorityEpoch, hostConfirmed },
      () => !this.closed && session.current());
  }
  /**
   * alpha.2 finding 3: a new Start retires a held attempt that never issued a credential — only when the Hub confirms it
   * cannot: its cancel answers issued:false, or the Hub has no such request (its push was refused, e.g. an ended join code).
   * Any other answer (unreachable, issued, unknown) keeps the fence: no second enrolment while one may still complete.
   */
  private async retireRefused(prior: LocalJoinJournal, current: () => boolean): Promise<boolean> {
    if (prior.stage !== "held" || prior.issued || !prior.outcomeKnown) return false;
    let patch: Partial<LocalJoinJournal>;
    try {
      const result = validated(remoteSchema, await this.client.command(prior.binding, "cancel", {}, createPrivateKey(prior.privateKey), current));
      if (result.issued) return false;
      patch = { stage: "cancelled", reason: "superseded", outcomeKnown: true, remoteState: result.state };
    } catch (error) {
      if (!(error instanceof CompanyJoinRemoteError && error.code === "not-found")) return false;
      patch = { stage: "cancelled", reason: "superseded" };
    }
    if (!current() || currentLocalJoinId(this.options.home) !== prior.operationId) return false;
    if (this.active?.record.operationId === prior.operationId) this.active = null;
    ++this.generation;
    saveLocalJoin(this.options.home, { ...prior, ...patch }, current);
    return !this.priorBlocks(readLocalJoin(this.options.home, prior.operationId));
  }
  current(session: JoinLocalSession) {
    if (this.closed || !session.current()) throw new HubProtocolError("denied");
    const id = currentLocalJoinId(this.options.home); if (!id) return null;
    const r = readLocalJoin(this.options.home, id);
    // The no-handle discovery route reveals this session's operation. Another session's attempt is shown only while it
    // blocks a new one (alpha.2 rehearsal findings 3/4: a new tab saw an empty box and every Start refused "conflict"):
    // flagged foreign, without its handoff. Acting on it still goes through adopt() (held only) or a new Start.
    if (r.sessionId !== session.sessionId || r.authorityEpoch !== session.authorityEpoch)
      return this.priorBlocks(r) ? { ...this.view(r), handoffId: null, foreign: true } : null;
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
  private probes = new Map<string, number[]>();
  /**
   * M-2921 (spec 1.1, "Probe"): what the Fleet would join, READ ONLY — the Hub's public metadata over CA-validated HTTPS,
   * exactly as start fetches it, and nothing else: no pin, no journal, no handoff, no push (A-L4). 10 per session per
   * minute. Answers the display name (an older Hub: null, and the page shows the host), whether the Hub takes company
   * joins, how its identity compares with the saved pin, whether the two host names differ, and this computer's name as
   * the suggested Fleet label. A Hub that cannot be read: { ok: false, reason: unreachable | certificate | not-hub }.
   */
  async probe(input: { address: string; fleetOrigin: string }, session: JoinLocalSession): Promise<
    | { ok: true; hubName: string | null; webOrigin: string; companyJoin: boolean; identity: "new" | "known" | "changed"; separateHosts: boolean; suggestedLabel: string; features: string[] }
    | { ok: false; reason: "unreachable" | "certificate" | "not-hub" | "limited" }> {
    const body = validated(z.strictObject({ address: z.string().max(8192), fleetOrigin: z.string().max(2048) }), input);
    canonicalFleetOrigin(body.fleetOrigin);
    if (this.closed || !session.current()) throw new HubProtocolError("denied");
    const now = this.now(), recent = (this.probes.get(session.sessionId) ?? []).filter(t => t > now - 60_000);
    if (recent.length >= 10) return { ok: false, reason: "limited" };
    recent.push(now); this.probes.set(session.sessionId, recent);
    if (this.probes.size > 256) for (const [k, v] of this.probes) if (!v.some(t => t > now - 60_000)) this.probes.delete(k);
    const address = parseCompanyAddress(body.address);
    const current = () => !this.closed && session.current();
    const suggestedLabel = probeLabel();
    let metadata;
    try { metadata = await this.client.discover(address.webOrigin, current, { display: true }); }
    catch (error) {
      if (error instanceof CompanyJoinReachError) return { ok: false, reason: error.kind };
      if (error instanceof CompanyJoinRemoteError && error.code === "incompatible")
        return { ok: true, hubName: null, webOrigin: address.webOrigin, companyJoin: false, identity: "new", separateHosts: separateHosts(body.fleetOrigin, address.webOrigin), suggestedLabel, features: [] };
      if (error instanceof CompanyIdentityChanged)
        return { ok: true, hubName: null, webOrigin: address.webOrigin, companyJoin: true, identity: "changed", separateHosts: separateHosts(body.fleetOrigin, address.webOrigin), suggestedLabel, features: [] };
      throw error;
    }
    let existing = null;
    try {
      if (existsSync(join(this.options.home, "hub-member/state.json"))) {
        const s = parseStrictJson(readPrivateFile(this.options.home, "hub-member/state.json")) as { hubId?: string };
        if (s.hubId) existing = new HubMemberProfileStore(this.options.home, s.hubId).readProfile().hub;
      }
    } catch { existing = null; }
    const fingerprint = companyIdentityDigest(metadata.hub);
    const identity = address.expected !== null && address.expected !== fingerprint ? "changed" : new CompanyTrustStore(this.options.home).peek(metadata.hub, existing);
    return { ok: true, hubName: metadata.name ?? null, webOrigin: metadata.hub.webOrigin, companyJoin: true, identity,
      separateHosts: separateHosts(body.fleetOrigin, metadata.hub.webOrigin), suggestedLabel, features: [...metadata.features] };
  }
  /** M-2921: what the connected card shows about the current Hub connection (display only), or null. */
  display(): CompanyDisplay | null {
    try {
      if (!existsSync(join(this.options.home, "hub-member/state.json"))) return null;
      const s = parseStrictJson(readPrivateFile(this.options.home, "hub-member/state.json")) as { hubId?: string };
      return s.hubId ? readDisplay(this.options.home, s.hubId) : null;
    } catch { return null; }
  }
  /**
   * M-2921 (spec 1.3): one press repairs a held connection — as one claimed operation: disconnect it (if it is not yet),
   * start over (the binding retires), then start again with the address and label saved for it, expecting the saved
   * identity (a changed Hub still stops at E8), and asking the Hub to retire the old Fleet in the same issue
   * (`supersedes`, when the Hub takes it). The admin's press is the consent for all of it (O1). A step that fails leaves
   * what the steps before it did, and the button can be pressed again. No saved address: "invalid" (the page offers 其他方式).
   */
  async reconnect(input: { hubId: string; binding: string; address: string; fleetOrigin: string; handoffId?: string }, authority: JoinLocalAuthority, pairing: ReconnectPairing) {
    const body = validated(z.strictObject({ hubId: uuid, binding: hash, address: z.string().max(2048), fleetOrigin: z.string().max(2048), handoffId: uuid.optional() }), input);
    if (this.closed || !authority.session.current() || !authority.confirmedCurrent()) throw new HubProtocolError("denied");
    const bound = pairing.boundHub();
    if (!bound || bound.hubId !== body.hubId || bound.binding !== body.binding) throw new HubProtocolError("conflict");
    const display = readDisplay(this.options.home, body.hubId);
    if (!display) throw new HubProtocolError("invalid");
    if (display.webOrigin !== body.address) throw new HubProtocolError("conflict");    // the address the admin confirmed is the saved one
    let profile: HubMemberProfile;
    try { profile = new HubMemberProfileStore(this.options.home, body.hubId).readProfile(); } catch { throw new HubProtocolError("uncertain"); }
    await this.leaveExactly(body, authority, pairing);
    // The page's waiting tab (opened in the press) follows this handoff to the Hub's sign-in, as Start's does.
    return this.start({ address: display.webOrigin, label: display.label || probeLabel() || "Fleet", fleetOrigin: body.fleetOrigin, ...(body.handoffId ? { handoffId: body.handoffId } : {}) }, authority,
      { expected: companyIdentityDigest(profile.hub), supersedes: { fleetId: profile.fleetId, credential: profile.credential } });
  }
  /**
   * M-2921 (spec 1.3): 「移除這個連接」 — one confirmed press: disconnect (member.leave first, when the Hub takes it) and
   * start over, so the Fleet is unpaired and the old binding retired. A disconnected binding only starts over.
   */
  async remove(input: { hubId: string; binding: string; address: string }, authority: JoinLocalAuthority, pairing: ReconnectPairing) {
    const body = validated(z.strictObject({ hubId: uuid, binding: hash, address: z.string().max(2048) }), input);
    if (this.closed || !authority.session.current() || !authority.confirmedCurrent()) throw new HubProtocolError("denied");
    const bound = pairing.boundHub();
    if (!bound || bound.hubId !== body.hubId || bound.binding !== body.binding) throw new HubProtocolError("conflict");
    const display = readDisplay(this.options.home, body.hubId);                         // the address the admin confirmed (none saved: the Hub's own)
    let origin: string | null = display?.webOrigin ?? null;
    if (!origin) { try { origin = new HubMemberProfileStore(this.options.home, body.hubId).readProfile().hub.webOrigin; } catch { origin = null; } }
    if (origin !== body.address) throw new HubProtocolError("conflict");
    return { left: await this.leaveExactly(body, authority, pairing) };
  }
  /**
   * Reconnect's and remove's shared first half: disconnect exactly this pairing (unless it already is), then start over.
   * #3675 r1 P2: the confirmation is asked again after the disconnect's member.leave wait — inside the disconnect, before its
   * fence and tombstone, and here before the start over — and the start over is only for the same exact binding.
   */
  private async leaveExactly(body: { hubId: string; binding: string }, authority: JoinLocalAuthority, pairing: ReconnectPairing): Promise<boolean> {
    const live = () => !this.closed && authority.session.current() && authority.confirmedCurrent();
    const view = pairing.view();
    let left = false;
    if (view.state === "paired" || view.state === "held" && view.hold !== "disconnected") {
      const out = await pairing.disconnect({ hubId: body.hubId, binding: body.binding }, live);
      if (!live()) throw new HubProtocolError("denied");
      if (!out.ok) throw new HubProtocolError(out.error === "unsaved" ? "unavailable" : "conflict");
      left = out.left === true;
    }
    if (!live()) throw new HubProtocolError("denied");
    const still = pairing.boundHub();
    if (!still || still.hubId !== body.hubId || still.binding !== body.binding) throw new HubProtocolError("conflict");
    pairing.cancel();
    return left;
  }
  async start(input: { address: string; label: string; fleetOrigin: string; handoffId?: string; code?: string }, authority: JoinLocalAuthority,
    internal: { expected?: string; supersedes?: { fleetId: string; credential: string } } = {}) {
    // M-2921 / Phase B: an enrolment code typed with the address goes to the Hub only when it takes one (enrolment-code-v1).
    const body = validated(z.strictObject({ address: z.string().max(8192), label: z.string().trim().min(1).max(120), fleetOrigin: z.string().max(2048), handoffId: uuid.optional(),
      code: z.string().regex(ENROLMENT_CODE).optional() }), input);
    canonicalFleetOrigin(body.fleetOrigin);
    const code = body.code ? normalEnrolmentCode(body.code) : undefined;
    if (this.closed || this.starting || !authority.session.current() || !authority.confirmedCurrent()) throw new HubProtocolError("denied");
    this.assertUnbound();
    const priorId = currentLocalJoinId(this.options.home);
    if (priorId) {
      const prior = readLocalJoin(this.options.home, priorId);
      if (this.priorBlocks(prior)) {
        this.starting = true;
        try {
          const retired = await this.retireRefused(prior, () => !this.closed && authority.session.current() && authority.confirmedCurrent());
          if (!retired) throw new HubProtocolError("conflict");
        } finally { this.starting = false; }
        if (this.closed || this.starting || !authority.session.current() || !authority.confirmedCurrent()) throw new HubProtocolError("denied");
        this.assertUnbound();
      }
    }
    this.starting = true; const gen = ++this.generation, snapshot = this.options.snapshot(), started = this.now();
    const current = () => !this.closed && gen === this.generation && sameSnapshot(snapshot, this.options.snapshot())
      && authority.session.current() && authority.confirmedCurrent() && this.now() < started + 600_000;
    try {
      const address = parseCompanyAddress(body.address);
      if (code && address.invitation) throw new HubProtocolError("invalid");   // B1: a code and an invitation together are refused
      requireSeparateJoinHosts(body.fleetOrigin, address.webOrigin);
      const metadata = await this.client.discover(address.webOrigin, current);
      if (!current()) throw new HubProtocolError("stale");
      requireSeparateJoinHosts(body.fleetOrigin, metadata.hub.webOrigin);
      if (code && !metadata.features.includes("enrolment-code-v1")) throw new CompanyJoinRemoteError("incompatible");   // before any pin or journal
      // An established legacy binding is an additional trust anchor, never a way to forget a mismatched pin.
      let existing = null;
      try {
        if (existsSync(join(this.options.home, "hub-member/state.json"))) {
          const s = parseStrictJson(readPrivateFile(this.options.home, "hub-member/state.json")) as { hubId?: string };
          if (s.hubId) existing = new HubMemberProfileStore(this.options.home, s.hubId).readProfile().hub;
        }
      } catch { throw new HubProtocolError("uncertain"); }
      new CompanyTrustStore(this.options.home).checkAndPin(metadata.hub, address.expected ?? internal.expected ?? null, existing, current);
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
        try { saveStartDisplay(this.options.home, operationId, metadata.hub.webOrigin, body.label); } catch { /* display only */ }
        const pushed = validated(pushedSchema, await this.client.command(record.binding, "push", { label: body.label, stateHash: sha256(browserState), invitation: address.invitation ?? null,
          ...(code ? { code } : {}),
          // S1.4: retire the old Fleet in the same issue — only when the Hub takes it (an older Hub's push is strict).
          ...(internal.supersedes && metadata.features.includes("join-supersedes-v1") ? { supersedes: internal.supersedes } : {}) }, key.privateKey, () => this.live(op)));
        if (pushed.requestId !== record.binding.requestId || pushed.browserAction !== metadata.hub.webOrigin + "/hub/join/open" || pushed.expiresAt <= this.now()) throw new HubProtocolError("denied");
        this.persist(op, { stage: "pending", deadline: Math.min(record.deadline, pushed.expiresAt) });
      } catch (error) {
        // alpha.2 finding 3: the Hub refusing the push of a join code is about the code (ended, mistyped) as much as the account.
        this.hold(op, code && op.record.stage === "preparing" && error instanceof CompanyJoinRemoteError && error.code === "denied" ? new CompanyJoinRemoteError("code-denied") : error);
      }
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
    if (!authority.confirmedCurrent()) throw new HubProtocolError("denied");
    this.adopt(id, authority.session, authority.session.hostHere);
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
    op.waiting = status.state === "pending" && (JOIN_WAITING as readonly string[]).includes(status.reason ?? "") ? status.reason as JoinWaiting : null;
    if (["ended", "undeliverable", "revoked"].includes(status.state)) {
      this.persist(op, { stage: "ended", reason: status.reason ?? status.state }); return;
    }
    if (status.state === "pending") return;
    if (status.state === "acknowledged") {
      if (!r.profileDigest || !r.issuedHash) throw new HubProtocolError("uncertain");
      return this.activate(op, current);
    }
    this.persist(op, { outcomeKnown: false }); // A dropped response may follow a completed Hub issuance.
    const delivered = validated(deliveredSchema, await this.client.command(r.binding, "redeem", { verifier: r.verifier }, key, current, { display: true }));
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
    try { settleDisplay(this.options.home, r.operationId, profile.hub.hubId, { hubName: delivered.hubName, ownerLabel: delivered.ownerLabel }); } catch { /* display only */ }
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
    this.adopt(id, session, false);
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

/** M-2921: this computer's name as the suggested Fleet label (its first label, at most 120 characters); "" when none. */
export function probeLabel(name: string = hostname()): string {
  return (name.split(".")[0] ?? "").trim().slice(0, 120);
}
/** M-2921: the Fleet's and the Hub's browser host names differ (a different port is not enough). */
function separateHosts(fleetOrigin: string, hubWebOrigin: string): boolean {
  try { requireSeparateJoinHosts(fleetOrigin, hubWebOrigin); return true; } catch (error) { if (error instanceof CompanyBrowserHostnameConflict) return false; throw error; }
}

/** M-2921: what reconnect needs of the member pairing (pairing-api's own methods). */
export interface ReconnectPairing {
  boundHub(): { hubId: string; binding: string | null } | null;
  view(): { state: string; hold?: string };
  disconnect(expected: { hubId?: unknown; binding?: unknown }, current?: () => boolean): Promise<{ ok: true; remote: "pending"; left?: boolean } | { ok: false; error: "unsaved" | "conflict" }>;
  cancel(): unknown;
}

