/** Suggested values are presented for owner confirmation, never applied to an existing Hub. No I/O on import. */
export const HUB_RETENTION_DEFAULTS = Object.freeze({ contentDays: 7, eventDays: 30 });
export interface HubRetentionPolicy { contentDays: number; eventDays: number }
export interface HubRetentionView extends HubRetentionPolicy { revision: number }
export function retentionDays(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= 3650;
}
export function parseHubRetention(input: unknown): HubRetentionView {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw Error("invalid_retention");
  const p = input as Record<string, unknown>;
  if (Object.keys(p).sort().join(",") !== "contentDays,eventDays,revision" || !retentionDays(p.contentDays) || !retentionDays(p.eventDays)
    || !Number.isSafeInteger(p.revision) || (p.revision as number) < 1) throw Error("invalid_retention");
  return { contentDays: p.contentDays, eventDays: p.eventDays, revision: p.revision as number };
}
