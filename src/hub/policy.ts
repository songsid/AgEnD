/**
 * AgEnD Hub P1, slice 3: authorization now (hub.md §2 "Durable delivery", §3, §5 HubPolicy).
 *
 * Every boundary — admission, begin, each tool, answer release, and each room read or dispatch — re-resolves the facts
 * from the persisted message and the current link. The facts are: the same asker, owner, grant and exposure revision,
 * the room open, the grant active in its window, the exposure published and not frozen, and both people eligible in
 * the directory NOW. Nothing a caller sends (a person field, a lease DTO) stands in for them.
 * A lease is a server-owned record: one exact operation (its digest), this link epoch, at most five seconds.
 */
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { HubProtocolError } from "./validation.js";
import { operationDigest, personKeyString } from "./identity.js";
import { validateAuthorization } from "./protocol.js";
import type { HubAuthorizationLease, HubAuthorizationRequest, HubAuthorizationResult, HubExposure, HubGrant } from "./types.js";
import type { HubLinkContext } from "./server.js";
import { exposureOf, grantApplies, grantOf, readExposure, readGrant } from "./catalog.js";
import { personFromString, type HubCore, type HubOperationPermit } from "./http/core.js";

export const LEASE_MS = 5_000;
/** M-3600: how long a member's authorize waits before its one retry of a transient refusal. */
export const AUTHORIZE_RETRY_MS = 300;
type AuthorizeStage = "message" | "asker-directory" | "owner-directory" | "grant" | "link";
/** M-3600: the step an operation() was on when it threw, for authorize's log. The error itself is never replaced. */
interface AuthorizeTrace { stage: AuthorizeStage }
/** A refusal's cause for the Hub's log: stage + code only (never content, names or directory text). */
function causeCode(e: unknown): string {
  if (e instanceof HubProtocolError) return e.code;
  const name = e instanceof Error ? e.name : typeof e;
  return /^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(name) ? name : "error";
}
/** Worth one more try: the directory, the group/grant check or the database could not answer. A real refusal is not. */
function transient(stage: AuthorizeStage, e: unknown): boolean {
  if (stage === "message" || stage === "link") return false;
  return !(e instanceof HubProtocolError) || e.code === "unavailable" || e.code === "backpressure";
}
/** P1 question lifetime (hub.md §2: at most 24 hours). */
export const QUESTION_LIFETIME_MS = 24 * 60 * 60_000;
export const TERMINAL = new Set(["rejected", "cancelled", "failed"]);
const POSITIVE = ["delivered", "consumed", "answered"];

export interface MessageRow {
  id: string; room_id: string; idempotency_key: string; sequence: number; fleet_id: string|null; exposure_id: string; exposure_revision: number;
  grant_id: string; grant_revision: number; asker: string; owner: string; content_digest: string; question_ref: string;
  stage: string; member_sequence: number; reason_code: string | null; stage_at: number; sent_epoch: number;
  answer_id: string | null; answer_digest: string | null; answer_ref: string | null; created_at: number; expires_at: number;
}
export const readMessage = (db: Database.Database, id: string) => db.prepare("SELECT * FROM hub_messages WHERE id=?").get(id) as MessageRow | undefined;

export type Facts = { ok: true; exposure: HubExposure; grant: HubGrant } | { ok: false; reason: "revoked" | "stale" | "expired" | "denied" };
/** The message's room, grant and exposure as they are now — the synchronous half of "authorize now". */
export function messageFacts(db: Database.Database, msg: MessageRow, now: number, permit?: HubOperationPermit): Facts {
  if (msg.expires_at <= now) return { ok: false, reason: "expired" };
  if (TERMINAL.has(msg.stage)) return { ok: false, reason: "denied" };
  const room = db.prepare("SELECT state FROM hub_rooms WHERE id=?").get(msg.room_id) as { state: string } | undefined;
  if (!room || room.state !== "active") return { ok: false, reason: "revoked" };
  const g = readGrant(db, msg.grant_id), e = readExposure(db, msg.exposure_id);
  if (!g || !e) return { ok: false, reason: "revoked" };
  const grant = grantOf(g), exposure = exposureOf(e);
  if (grant.revision !== msg.grant_revision || exposure.revision !== msg.exposure_revision) return { ok: false, reason: "stale" };
  if (exposure.state !== "published" || exposure.fleetId !== msg.fleet_id || personKeyString(exposure.owner) !== msg.owner) return { ok: false, reason: "revoked" };
  if (!grantApplies(grant, exposure, personFromString(msg.asker), now, permit?.grant)) return { ok: false, reason: "revoked" };
  return { ok: true, exposure, grant };
}

export class HubPolicyService {
  constructor(private readonly core: HubCore, private readonly log?: (level: "info" | "warn", message: string, meta?: Record<string, unknown>) => void,
    private readonly retryMs = AUTHORIZE_RETRY_MS) {}

  /** Both people of a message are eligible in the directory now (two fresh lookups, bounded). */
  async peopleEligible(msg: Pick<MessageRow, "asker" | "owner">): Promise<boolean> {
    return (await this.core.eligible(personFromString(msg.asker))) && (await this.core.eligible(personFromString(msg.owner)));
  }

  /** Group authority is re-resolved for this exact message, never borrowed from its admission lease. */
  async operation(msg: MessageRow, link: HubLinkContext, trace: AuthorizeTrace = { stage: "message" }): Promise<HubOperationPermit> {
    const finishTiming = this.core.sendTiming?.start("authorize.resolve");
    try {
    const identity = (m: MessageRow) => JSON.stringify([m.id, m.fleet_id, m.asker, m.owner, m.grant_id, m.grant_revision, m.exposure_id, m.exposure_revision, m.content_digest]);
    trace.stage = "message";
    const row = this.core.atomic(db => readMessage(db, msg.id));
    if (!row || identity(row) !== identity(msg) || row.fleet_id !== link.fleetId || row.owner !== personKeyString(link.owner)) throw new HubProtocolError("stale");
    const image = identity(row), epoch = link.linkEpoch;
    // M-3600: each directory lookup is its own step, so a refusal's log names which one could not answer.
    trace.stage = "asker-directory";
    // A directory that could not answer is "unavailable" (retried once by authorize), never a revocation.
    const finishAsker = this.core.sendTiming?.start("authorize.asker-directory");
    let askerEligible: boolean;
    try { askerEligible = await this.core.eligibleOrUnavailable(personFromString(row.asker)); } finally { finishAsker?.(); }
    if (!askerEligible) throw new HubProtocolError("revoked");
    trace.stage = "owner-directory";
    const finishOwner = this.core.sendTiming?.start("authorize.owner-directory");
    let ownerEligible: boolean;
    try { ownerEligible = await this.core.eligibleOrUnavailable(personFromString(row.owner)); } finally { finishOwner?.(); }
    if (!ownerEligible) throw new HubProtocolError("revoked");
    trace.stage = "grant";
    const finishGrant = this.core.sendTiming?.start("authorize.grant");
    let permit: HubOperationPermit;
    try { permit = await this.core.exposureGrant(row.exposure_id, row.grant_id, personFromString(row.asker),
      { requestId: randomUUID(), current: () => link.current() }); } finally { finishGrant?.(); }
    trace.stage = "link";
    if (!link.current()) throw new HubProtocolError("stale");
    const assertCurrent = () => {
      permit.assertCurrent();
      const fresh = this.core.atomic(db => readMessage(db, row.id));
      if (!fresh || identity(fresh) !== image || !link.current() || link.linkEpoch !== epoch || link.fleetId !== row.fleet_id
        || personKeyString(link.owner) !== row.owner) throw new HubProtocolError("stale");
    };
    assertCurrent(); return { grant: permit.grant, assertCurrent };
    } finally { finishTiming?.(); }
  }

  /** A member's `authorize.request` on its current link → a lease for exactly that operation, or a bounded refusal. */
  async authorize(input: HubAuthorizationRequest, link: HubLinkContext): Promise<HubAuthorizationResult> {
    let request: HubAuthorizationRequest;
    try { request = validateAuthorization(input); } catch { return { ok: false, reasonCode: "invalid" }; }
    const refuse = (reasonCode: "denied" | "stale" | "revoked" | "expired" | "unavailable" | "not-found" | "conflict", msg?: MessageRow): HubAuthorizationResult => {
      try {
        this.core.atomic((_db, tx) => this.core.audit(tx, { requestId: randomUUID(), actor: { kind: "member", fleetId: link.fleetId }, action: `authorize.${request.phase}`,
          result: "denied", reasonCode, messageId: request.messageId, fleetId: link.fleetId, ...(msg ? { roomId: msg.room_id, exposureId: msg.exposure_id, ownerAtEvent: personFromString(msg.owner), grantId: msg.grant_id, grantRevision: msg.grant_revision } : {}) }));
      } catch { /* the refusal stands even when its audit cannot be written */ }
      return { ok: false, reasonCode };
    };
    let first: MessageRow | undefined;
    try { first = this.core.atomic((db) => readMessage(db, request.messageId)); } catch { return { ok: false, reasonCode: "unavailable" }; }
    // Another fleet's message is "not-found": a member never learns what it was not sent.
    if (!first || first.fleet_id !== link.fleetId) return refuse("not-found");
    if (request.exposureRevision !== first.exposure_revision) return refuse("stale", first);
    let permit!: HubOperationPermit;   // assigned by the first operation() or its one retry; every other path returns
    const trace: AuthorizeTrace = { stage: "message" };
    const meta = (e: unknown, attempt: number) => ({ phase: request.phase, messageId: request.messageId, fleetId: link.fleetId, attempt, stage: trace.stage, code: causeCode(e) });
    const denial = (x: unknown) => x instanceof HubProtocolError && (x.code === "revoked" || x.code === "denied") ? x.code : null;
    try { permit = await this.operation(first, link, trace); }
    catch (e) {
      // M-3600: a directory, grant or database step that could not answer gets one more try (a member's question was held for
      // a link round-trip on a single slow lookup). A real refusal, a changed message or a dropped link never does.
      let last: unknown = e, attempt = 1, retried = false;
      if (!denial(e) && transient(trace.stage, e) && link.current()) {
        this.log?.("info", "Hub authorize retrying after a transient refusal", meta(e, 1));
        await new Promise(resolve => setTimeout(resolve, this.retryMs));
        if (link.current()) {
          attempt = 2;
          try { permit = await this.operation(first, link, trace); retried = true; }
          catch (again) { last = again; }
        }
      }
      if (!retried) {
        const code = denial(last);
        if (!code) this.log?.("warn", "Hub authorize refused", meta(last, attempt));
        return refuse(code ?? "unavailable", first);
      }
    }
    if (!link.current()) return { ok: false, reasonCode: "stale" };
    const now = this.core.now();
    try {
      return this.core.atomic((db, tx) => {
        const msg = readMessage(db, request.messageId)!;
        const facts = messageFacts(db, msg, now, permit);
        if (!facts.ok) throw new HubProtocolError(facts.reason);
        if (request.phase === "admit" && msg.stage !== "queued") throw new HubProtocolError("conflict");
        if ((request.phase === "begin" || request.phase === "tool") && (msg.stage === "answered" || msg.answer_id)) throw new HubProtocolError("conflict");
        if (facts.exposure.kind==="personal")throw new HubProtocolError("denied");
        if (request.phase === "tool" && !facts.exposure.allowedTools.includes(request.tool.name)) throw new HubProtocolError("denied");
        if (request.phase === "release-answer" && msg.answer_id
          && (msg.answer_id !== request.answer.answerId || msg.answer_digest !== request.answer.contentDigest)) throw new HubProtocolError("conflict");
        if (!link.current()) throw new HubProtocolError("stale");
        const lease: HubAuthorizationLease = { decisionId: randomUUID(), messageId: msg.id, operationId: request.operationId, phase: request.phase,
          operationDigest: operationDigest(request), revocationVersion: this.core.revocationVersion(), exposureRevision: msg.exposure_revision,
          linkEpoch: link.linkEpoch, expiresAt: now + LEASE_MS };
        db.prepare(`INSERT INTO hub_leases(decision_id, fleet_id, link_epoch, message_id, operation_id, phase, operation_digest, exposure_revision, revocation_version, expires_at)
          VALUES(?,?,?,?,?,?,?,?,?,?)`).run(lease.decisionId, link.fleetId, lease.linkEpoch, lease.messageId, lease.operationId, lease.phase, lease.operationDigest,
          lease.exposureRevision, lease.revocationVersion, lease.expiresAt);
        this.core.audit(tx, { requestId: lease.decisionId, actor: { kind: "member", fleetId: link.fleetId }, action: `authorize.${request.phase}`, result: "allowed",
          messageId: msg.id, roomId: msg.room_id, fleetId: link.fleetId, exposureId: msg.exposure_id, ownerAtEvent: personFromString(msg.owner),
          grantId: msg.grant_id, grantRevision: msg.grant_revision });
        return { ok: true as const, lease };
      }, permit);
    } catch (e) {
      const code = e instanceof HubProtocolError ? e.code : "unavailable";
      return refuse((["denied", "stale", "revoked", "expired", "conflict"] as const).find((c) => c === code) ?? "unavailable", first);
    }
  }

  /**
   * The release lease an answer frame carries, checked against the Hub's own record of it: same fleet, link epoch,
   * message, exact answer id/digest (via the operation digest), unexpired, unused. It is then spent.
   */
  spendReleaseLease(db: Database.Database, lease: HubAuthorizationLease, answer: { messageId: string; answerId: string; contentDigest: string }, link: HubLinkContext, now: number): void {
    const row = db.prepare("SELECT * FROM hub_leases WHERE decision_id=?").get(lease.decisionId) as
      { fleet_id: string; link_epoch: number; message_id: string; operation_id: string; phase: string; operation_digest: string; exposure_revision: number; revocation_version: number; expires_at: number; consumed: number } | undefined;
    if (!row || row.fleet_id !== link.fleetId || row.link_epoch !== link.linkEpoch || row.phase !== "release-answer" || row.message_id !== answer.messageId) throw new HubProtocolError("denied");
    const expected = operationDigest({ messageId: answer.messageId, operationId: row.operation_id, exposureRevision: row.exposure_revision, phase: "release-answer",
      answer: { answerId: answer.answerId, contentDigest: answer.contentDigest } });
    if (row.operation_digest !== expected || lease.operationDigest !== expected || lease.operationId !== row.operation_id || lease.linkEpoch !== row.link_epoch
      || lease.expiresAt !== row.expires_at || lease.exposureRevision !== row.exposure_revision || lease.revocationVersion !== row.revocation_version) throw new HubProtocolError("denied");
    if (row.expires_at <= now) throw new HubProtocolError("expired");
    if (row.consumed) throw new HubProtocolError("conflict");
    db.prepare("UPDATE hub_leases SET consumed=1 WHERE decision_id=?").run(lease.decisionId);
  }
}

export { POSITIVE };
