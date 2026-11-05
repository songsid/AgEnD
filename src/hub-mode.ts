/**
 * AgEnD Hub P1 (docs/design/hub.md §1; fleet decision 7e5b8a8f): whether the web shows the Hub's UI, and which.
 * Both switches are OFF by default and independent: `hub.enabled` (this instance is a Hub) and `hub_member.enabled`
 * (this fleet may connect to a Hub). Off: the app shell carries no Hub mark, no Hub module loads and `/hub*` is not
 * mounted (the ordinary not-found).
 *
 * Until slice 1's HubMode exists this reads the two switches; slice 1 replaces the body with HubMode.serverEnabled() /
 * memberEnabled() (which also require a valid, locally confirmed initialization manifest).
 */
import type { FleetConfig } from "./types.js";

/** Longest Hub name shown in the brand. */
export const HUB_NAME_MAX = 60;

export function hubModeOf(config: FleetConfig | null | undefined): { server: boolean; member: boolean; name: string } {
  const server = config?.hub?.enabled === true;
  const member = config?.hub_member?.enabled === true;
  const name = server && typeof config?.hub?.name === "string" ? hubNameOf(config.hub.name) : "";
  return { server, member, name };
}

/** A Hub name as the brand shows it: one line, no control characters, at most HUB_NAME_MAX characters. */
export function hubNameOf(raw: string): string {
  return [...raw.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim()].slice(0, HUB_NAME_MAX).join("");
}
