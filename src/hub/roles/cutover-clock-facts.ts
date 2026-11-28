/** Pure historical-marker computation only; never a currentness or authorization result. */
import { personKeyString } from "../identity.js";
import { parseHubRoleCutoverMarker } from "./cutover-marker.js";

export interface HubRoleCutoverClockFacts {
  readonly rootKey: string;
  readonly realm: string;
  readonly at: number;
  readonly fromRevision: number;
  readonly transportRevision: number;
  readonly authorizationVersion: number;
}

/** One slot per clock. Its caller must still perform every fresh read and confirmation. */
export function createHubRoleCutoverClockFacts() {
  let slot: { raw: string; hubId: string; facts: HubRoleCutoverClockFacts } | undefined;
  return {
    read(raw: string, hubId: string): HubRoleCutoverClockFacts {
      if (slot?.raw === raw && slot.hubId === hubId) return slot.facts;
      // Only the full successful parser may populate the slot. No marker graph or error is retained.
      const { marker } = parseHubRoleCutoverMarker(raw, hubId);
      const facts = Object.freeze({
        rootKey: personKeyString(marker.root), realm: marker.realm, at: marker.at,
        fromRevision: marker.fromRevision, transportRevision: marker.transportRevision,
        authorizationVersion: marker.authorizationVersion,
      });
      slot = { raw, hubId, facts };
      return facts;
    },
    // Disposal clears computation only; the owning clock separately refuses use after close.
    close() { slot = undefined; },
  };
}
