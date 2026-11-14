/** The installed release decides the default: on for -alpha and -beta prereleases, off for stable (leader, 2.4.0-beta.1); source checkout/branch names never enable trust. */
export function hubPilotTrustSettings(raw: unknown, version: string | null): { enabled: boolean } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw Error("invalid_hub_pilot_trust");
  const member = Object.hasOwn(raw, "hub_member") ? (raw as Record<string, unknown>).hub_member : undefined;
  if (member !== undefined && (!member || typeof member !== "object" || Array.isArray(member))) throw Error("invalid_hub_pilot_trust");
  const value = member && Object.hasOwn(member, "pilot_trust") ? (member as Record<string, unknown>).pilot_trust : undefined;
  if (value !== undefined && typeof value !== "boolean") throw Error("invalid_hub_pilot_trust");
  return { enabled: value ?? /^\d+\.\d+\.\d+-(?:alpha|beta)(?:\.|$)/.test(version ?? "") };
}
