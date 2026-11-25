import { RequestContextReferenceMap, type RequestContextRegistrationGate } from "./request-context-fence.js";
/** Fleet-only proof registry. Raw C tokens and contexts never cross the pane transport. */
import { createHash, createHmac } from "node:crypto";
import { captureRequestContextCall, type RequestContextCallLease } from "./request-context-call.js";
import type { RequestContextTurnSnapshot } from "./request-context-turns.js";
import { validatePaneMcpOwner, samePaneMcpOwner, type PaneMcpOwner } from "./runtime-pane-mcp-protocol.js";
import { validateRequestContextCallStamp, type RequestContextCallStamp } from "./request-context-call-protocol.js";
export interface RequestContextCallReference {
  contextId: string; rootContextId: string; proofSha256: string;
}
export class RequestContextPaneProofs {
  private readonly proofs = new RequestContextReferenceMap<string, { owner: PaneMcpOwner; lease: RequestContextCallLease }>(row=>row.lease.snapshot.context.ref.rootContextId,row=>`pane-proof:${row.owner.launchId}:${row.lease.snapshot.context.ref.contextId}`);
  constructor(private readonly secret: string,registration?:RequestContextRegistrationGate) { if (secret.length < 32) throw Error("Originating-call proof key unavailable");this.proofs.installRegistration(registration); }
  get drainRevision():string{return this.proofs.revision;}
  drainView(rootId:string){return this.proofs.view(rootId);}
  /** Mint under C's final write lock; retain() has already committed the immutable context. */
  mint(owner: PaneMcpOwner, snapshot: RequestContextTurnSnapshot, current: (captured: RequestContextTurnSnapshot) => boolean): RequestContextCallStamp {
    validatePaneMcpOwner(owner);
    if (owner.instance !== snapshot.owner.instance) throw Error("Originating-call launch differs");
    const lease = captureRequestContextCall(snapshot, current);
    const proof = createHmac("sha256", this.secret).update(JSON.stringify([owner.hostBootId, owner.paneId, owner.launchId, owner.agentId, owner.instance, lease.snapshotSha256])).digest("hex");
    const old = this.proofs.get(proof);
    if (old && (!samePaneMcpOwner(old.owner, owner) || old.lease.snapshotSha256 !== lease.snapshotSha256)) throw Error("Originating-call proof conflict");
    if (!old && this.proofs.size >= 65_536) throw Error("Originating-call proof registry requires launch retirement");
    this.proofs.set(proof, { owner: Object.freeze({ ...owner }), lease });
    return Object.freeze({ version: 1, coverage: "covered", proof });
  }
  resolve(owner: PaneMcpOwner, raw: unknown): { lease: RequestContextCallLease; reference: RequestContextCallReference } {
    const stamp = validateRequestContextCallStamp(raw);
    if (stamp.coverage !== "covered") throw Error("Originating call is not covered");
    const row = this.proofs.get(stamp.proof);
    if (!row || !samePaneMcpOwner(row.owner, owner) || !row.lease.current()) throw Error("Originating-call proof is stale or unavailable");
    return { lease: row.lease, reference: Object.freeze({ contextId: row.lease.snapshot.context.ref.contextId,
      rootContextId: row.lease.snapshot.context.ref.rootContextId, proofSha256: createHash("sha256").update(stamp.proof).digest("hex") }) };
  }
  /** Retained contexts must not be collected before their launch ledger retires. Never time-prune these refs. */
  retire(owner: PaneMcpOwner): void { for (const [proof, row] of this.proofs) if (samePaneMcpOwner(row.owner, owner)) this.proofs.delete(proof); }
}
