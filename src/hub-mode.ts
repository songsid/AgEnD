/**
 * AgEnD Hub P1 (docs/design/hub.md §1; fleet decision 7e5b8a8f): what the fleet's web shows of the Hub. The member
 * switch `hub_member.enabled` (off by default) marks this fleet's pages `data-hub="member"`; the Hub's own shell is served
 * only by a Hub's separate listener and origin (slice 1), never derived here. Until slice 1's HubMode exists this reads
 * the switch; slice 1 replaces the body with HubMode.memberEnabled() (which also requires a valid initialization).
 */

/** Longest Hub name shown in the brand. */
export const HUB_NAME_MAX = 60;

/** Any fleet config shape (or none): the switch is read defensively, true only when exactly `true`. */
export type HubSwitches = unknown;

export function hubModeOf(config: HubSwitches): { member: boolean } {
  const c = (config && typeof config === "object" ? config : {}) as { hub_member?: { enabled?: unknown } };
  return { member: c.hub_member?.enabled === true };
}

/** A Hub name as the brand shows it: one line, no control characters, at most HUB_NAME_MAX characters. */
export function hubNameOf(raw: string): string {
  return [...raw.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim()].slice(0, HUB_NAME_MAX).join("");
}
