/** Narrowing only, inside the caller's owning transport transaction. Never discard history. */
import type { HubTransportState } from "./store.js";
export function revokeHubFleet(state: HubTransportState, fleet: HubTransportState["fleets"][number]): void {
  fleet.status = "revoked"; fleet.credentialHash = null; fleet.generation++; state.revocationVersion++;
}
