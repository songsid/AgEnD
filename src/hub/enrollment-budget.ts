/** Shared S-90 admission counters: new company joins and legacy quick pairing spend the same budget. */
import type { HubTransportState } from "./store.js";
import type { PersonKey } from "./types.js";
import { personKeyString, sha256 } from "./identity.js";
export function enrollmentThrottled(state: HubTransportState, key: string, maximum: number, now: number): boolean {
  const row = state.buckets.find(b => b.key === sha256(key));
  return !!row && now - row.since < 60_000 && row.attempts >= maximum;
}
export function spendEnrollmentBudget(state: HubTransportState, key: string, maximum: number, now: number): boolean {
  state.buckets = state.buckets.filter(row => now - row.since < 60_000);
  const digest = sha256(key), row = state.buckets.find(b => b.key === digest);
  if (!row) {
    if (state.buckets.length >= 1024) return false;
    state.buckets.push({ key: digest, since: now, attempts: 1 }); return true;
  }
  row.attempts = Math.min(row.attempts + 1, maximum + 1); return row.attempts <= maximum;
}
export function automaticFleetSlots(state: HubTransportState, owner: PersonKey, now: number, extra = 0, except?: string): number {
  const key = personKeyString(owner);
  return extra + state.fleets.filter(f => f.status === "active" && f.credentialHash && personKeyString(f.owner) === key).length
    + state.pairings.filter(p => p.automatic && p.id !== except && p.expiresAt > now
      && ["offered", "pending"].includes(p.state) && personKeyString(p.owner) === key).length;
}
