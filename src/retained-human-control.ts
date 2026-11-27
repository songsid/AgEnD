/** Private in-process dispatch proof. Strings in a payload or serialized IPC cannot manufacture it. */
import type { ClaimedOutboxDelivery } from "./delivery-outbox.js";
import { requestContextDigest } from "./request-context-store.js";
const marker = Symbol("retained-human-control");
export interface RetainedHumanControl {
 readonly deliveryId: string; readonly targetDaemonBootId: string; readonly attemptNo: number; readonly payloadSha256: string;
}
export function markRetainedHumanControl(payload: Record<string, unknown>, claimed: ClaimedOutboxDelivery): void {
 Object.defineProperty(payload, marker, { enumerable: true, value: Object.freeze({ deliveryId: claimed.deliveryId,
  targetDaemonBootId: claimed.targetDaemonBootId, attemptNo: claimed.attemptNo, payloadSha256: requestContextDigest(claimed.payload) }) });
}
/** Object spreads preserve it until final preparation; JSON deliberately does not. */
export function retainedHumanControl(payload: object): RetainedHumanControl | undefined {
 return (payload as { [marker]?: RetainedHumanControl })[marker];
}
