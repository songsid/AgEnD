/** Pure Settings policy: importing this while membership is off mounts no Hub code. */
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
export function hubMembershipSettings(raw: unknown): { enabled: boolean } {
  if (!object(raw)) throw Error("invalid_hub_membership");
  const member = Object.hasOwn(raw, "hub_member") ? raw.hub_member : undefined;
  if (member === undefined) return { enabled: false };
  if (!object(member)) throw Error("invalid_hub_membership");
  const enabled = Object.hasOwn(member, "enabled") ? member.enabled : undefined;
  if (enabled !== undefined && typeof enabled !== "boolean") throw Error("invalid_hub_membership");
  return { enabled: enabled === true };
}
export function parseHubMembership(input: unknown): { enabled: boolean } {
  if (!object(input) || Object.keys(input).length !== 1 || !Object.hasOwn(input, "enabled") || typeof input.enabled !== "boolean") throw Error("invalid_hub_membership");
  return { enabled: input.enabled };
}
