/** Pure shared naming; importing this module never loads or migrates configuration. */
export function sanitizeInstanceName(name: string): string {
  const sanitized = name.toLowerCase().replace(/[^\p{L}\d-]/gu, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return sanitized || "project";
}

/** Keep the primary bot's historical name and suffix explicit non-primary adapter registrations. */
export function classicInstanceName(sanitizedName: string, channelId: string, adapterId?: string): string {
  const suffix = channelId.slice(-4);
  const base = `classic-${sanitizedName}-${suffix}`;
  return adapterId ? `${base}-${sanitizeInstanceName(adapterId)}` : base;
}
