/** Bounded public setup errors; importing the fleet route must not load Hub initialization. */
export type HubWebInitCode = "invalid" | "denied" | "stale" | "expired" | "busy" | "initialized" | "unavailable" | "directory" | "trust" | "network" | "incomplete";
export class HubWebInitError extends Error {
  constructor(readonly code: HubWebInitCode) { super(code); }
}
