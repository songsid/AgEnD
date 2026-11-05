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
import { personFromString, type HubCore } from "./http/core.js";

export const LEASE_MS = 5_000;
/** P1 question lifetime (hub.md §2: at most 24 hours). */
export const QUESTION_LIFETIME_MS = 24 * 60 * 60_000;
export const TERMINAL = new Set(["rejected", "cancelled", "failed"]);
const POSITIVE = ["delivered", "consumed", "answered"];

export interface MessageRow {
  id: string; room_id: string; idempotency_key: string; sequence: number; fleet_id: string; exposure_id: string; exposure_revision: number;
  grant_id: string; grant_revision: number; asker: string; owner: string; content_digest: string; question_ref: string;
  stage: string; member_sequence: number; reason_code: string | null; stage_at: number; sent_epoch: number;
  answer_id: string | null; answer_digest: string | null; answer_ref: string | null; created_at: number; expires_at: number;
}
export const readMessage = (db: Database.Database, id: string) => db.prepare("SELECT * FROM hub_messages WHERE id=?").get(id) as MessageRow | undefined;

export type Facts = { ok: true; exposure: HubExposure; grant: HubGrant } | { ok: false; reason: "revoked" | "stale" | "expired" | "denied" };
/** The message's room, grant and exposure as they are now — the synchronous half of "authorize now". */
export function messageFacts(db: Database.Database, msg: MessageRow, now: number): Facts {
  if (msg.expires_at <= now) return { ok: false, reason: "expired" };
  if (TERMINAL.has(msg.stage)) return { ok: false, reason: "denied" };
  const room = db.prepare("SELECT state FROM hub_rooms WHERE id=?").get(msg.room_id) as { state: string } | undefined;
  if (!room || room.state !== "active") return { ok: false, reason: "revoked" };
  const g = readGrant(db, msg.grant_id), e = readExposure(db, msg.exposure_id);
  if (!g || !e) return { ok: false, reason: "revoked" };
  const grant = grantOf(g), exposure = exposureOf(e);
  if (grant.revision !== msg.grant_revision || exposure.revision !== msg.exposure_revision) return { ok: false, reason: "stale" };
  if (exposure.state !== "published" || exposure.fleetId !== msg.fleet_id || personKeyString(exposure.owner) !== msg.owner) return { ok: false, reason: "revoked" };
  if (!grantApplies(grant, exposure, personFromString(msg.asker), now)) return { ok: false, reason: "revoked" };
  return { ok: true, exposure, grant };
}

export class HubPolicyService {
  constructor(private readonly core: HubCore) {}

  /** Both people of a message are eligible in the directory now (two fresh lookups, bounded). */
  async peopleEligible(msg: Pick<MessageRow, "asker" | "owner">): Promise<boolean> {
    return (await this.core.eligible(personFromString(msg.asker))) && (await this.core.eligible(personFromString(msg.owner)));
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
    let eligible: boolean;
    try { eligible = await this.peopleEligible(first); } catch (e) { return refuse(e instanceof HubProtocolError && e.code === "backpressure" ? "unavailable" : "unavailable", first); }
    if (!eligible) return refuse("revoked", first);
    if (!link.current()) return { ok: false, reasonCode: "stale" };
    const now = this.core.now();
    try {
      return this.core.atomic((db, tx) => {
        const msg = readMessage(db, request.messageId)!;
        const facts = messageFacts(db, msg, now);
        if (!facts.ok) throw new HubProtocolError(facts.reason);
        if (request.phase === "admit" && msg.stage !== "queued") throw new HubProtocolError("conflict");
        if ((request.phase === "begin" || request.phase === "tool") && (msg.stage === "answered" || msg.answer_id)) throw new HubProtocolError("conflict");
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
      });
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
