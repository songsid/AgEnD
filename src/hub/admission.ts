/** Only this adapter admits a signed external question into a restricted outbox. No local human authority. */
import { createPublicKey } from "node:crypto";
import { personKeyString, verifyAsker } from "./identity.js";
import { validated, HubProtocolError } from "./validation.js";
import { revocationSchema } from "./protocol.js";
import { HubMemberJournal } from "./member-journal.js";
import type { HubMemberTransport, HubQuestion, HubReceipt, HubExposure, HubReconcile, HubRevocation, HubMemberAdmission } from "./types.js";
import type { HubMemberProfile } from "./profile.js";
export interface HubAdmissionBinding { profile: HubMemberProfile; linkEpoch: number; revocationVersion: number; current(): boolean }
export interface HubAdmissionOptions {
  journal: HubMemberJournal; transport: HubMemberTransport;
  binding(): HubAdmissionBinding;
  /** Current member-owned consent, not the Hub's mirrored exposure or question fields. */
  exposure(id: string): HubExposure | null;
  fenceLocal(messageId: string): void;
  hold(messageId: string, reason: "unavailable" | "denied" | "uncertain"): void;
  now?: () => number;
}
export class HubMemberAdmissionAdapter implements HubMemberAdmission {
  constructor(private readonly options: HubAdmissionOptions) {}
  private binding(): HubAdmissionBinding { const b = this.options.binding(); if (!b.current()) throw new HubProtocolError("unavailable"); return b; }
  private owns(q: HubQuestion, b: HubAdmissionBinding): boolean {
    const e = this.options.exposure(q.identity.exposureId);
    const identity = q.identity;
    return !!e && e.state === "published" && e.id === identity.exposureId && e.fleetId === b.profile.fleetId
      && identity.destinationFleetId === b.profile.fleetId && identity.issuer === b.profile.hub.hubId && identity.issuerKeyId === b.profile.issuerKeyId
      && personKeyString(identity.owner) === personKeyString(b.profile.owner) && identity.revocationVersion === b.revocationVersion
      && identity.expiresAt > (this.options.now?.() ?? Date.now())
      && personKeyString(e.owner) === personKeyString(b.profile.owner) && e.revision === identity.exposureRevision;
  }
  async admit(question: HubQuestion): Promise<HubReceipt> {
    const b = this.binding();
    try {
      const identity = verifyAsker(question.identity, question.text, { hubId: b.profile.hub.hubId, issuerKeyId: b.profile.issuerKeyId,
        issuerPublicKey: createPublicKey(b.profile.hub.issuerPublicKey), fleetId: b.profile.fleetId, owner: b.profile.owner,
        revocationVersion: b.revocationVersion, now: this.options.now?.() ?? Date.now() });
      const q = { text: question.text, identity };
      if (!this.owns(q, b)) throw new HubProtocolError("denied");
      const prepared = this.options.journal.prepare(q);
      if (prepared.receipt) return prepared.receipt; // exact durable duplicate; never enqueues or executes again
      const request = { messageId: identity.messageId, operationId: prepared.operationId, exposureRevision: identity.exposureRevision, phase: "admit" as const };
      const lease = await this.options.transport.authorize(request);
      const current = () => {
        const live = this.options.binding();
        return b.current() && live.current() && live.linkEpoch === b.linkEpoch && live.revocationVersion === b.revocationVersion && this.owns(q, live);
      };
      if (!current()) throw new HubProtocolError("stale");
      return this.options.journal.commitAdmission(q, request, lease, { current, linkEpoch: b.linkEpoch, revocationVersion: b.revocationVersion });
    } catch (error) {
      this.options.hold(question.identity.messageId, error instanceof HubProtocolError && error.code === "denied" ? "denied" : "unavailable"); throw error;
    }
  }
  async reconcile(input: HubReconcile): Promise<readonly HubReceipt[]> {
    this.binding(); return this.options.journal.reconcile(input.afterReceiptSequence, input.messages);
  }
  async fence(input: HubRevocation): Promise<void> {
    const revocation = validated(revocationSchema, input); this.binding();
    const receipts = this.options.journal.fence(revocation, this.options.fenceLocal);
    for (const receipt of receipts) if (receipt.stage === "uncertain") this.options.hold(receipt.messageId, "uncertain");
  }
}
