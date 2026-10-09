import type { InteractionSnapshot } from "../../src/backend/types.js";

/** Inert resident generation for command fixtures; no backend or pane IO. */
export function cachedCommandDaemon(name: string) {
  const owner = { bootId: `fixture-${name}`, spawnGeneration: 1, launchAttempt: 1, launchFenceEpoch: 0 };
  return { getInteractionSnapshot: (): InteractionSnapshot => ({
    phase: "clear", kind: null, reason: null, episode: null, owner: { ...owner },
    since: null, observedAt: null, confirmedAt: null, ageMs: null, stale: false, suspected: false,
  }) };
}
