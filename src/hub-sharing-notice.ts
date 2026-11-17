/** A bounded display projection. Only the paired member journal, never this notice, authorizes Undo. */
import { z } from "zod";
const label = z.string().max(256);
export const hubSharingNoticeSchema = z.strictObject({
  key: z.string().regex(/^[a-f0-9]{64}$/), hubName: label, byName: label,
  at: z.number().int().nonnegative(), undoUntil: z.number().int().nonnegative(), version: z.number().int().min(1).max(1000),
  state: z.enum(["pending", "complete", "undoing", "undone"]),
  rows: z.array(z.strictObject({ name: label, kind: z.enum(["agent", "classic-room"]), action: z.enum(["share", "stop"]),
    state: z.enum(["pending", "shared", "stopped", "refused", "undone", "changed"]), code: label.optional() })).min(1).max(64),
}).refine(value => value.undoUntil === value.at + 24 * 60 * 60_000);
export type HubSharingNotice = z.infer<typeof hubSharingNoticeSchema>;
export interface HubSharingController {
  view(key: string): HubSharingNotice | null;
  undo(key: string, actor: string, authorized: () => boolean): Promise<HubSharingNotice>;
}

/** Locale is supplied by the Fleet; browser rendering uses the same keys in its locale namespace. */
export function hubSharingNoticeText(value: HubSharingNotice, tr: (key: string, ...args: string[]) => string): string {
  if (value.state === "pending") return tr("hub_sharing.pending", value.byName, value.hubName);
  const lines: string[] = value.state === "undone" ? [tr("hub_sharing.undone_by")] : [];
  const shared = value.rows.filter(row => row.state === "shared").map(row => row.name);
  const stopped = value.rows.filter(row => row.state === "stopped").map(row => row.name);
  if (shared.length) lines.push(tr("hub_sharing.shared", value.byName, shared.join(", "), value.hubName));
  if (stopped.length) lines.push(tr("hub_sharing.stopped", value.byName, stopped.join(", "), value.hubName));
  for (const row of value.rows) {
    if (row.state === "undone") lines.push(tr(row.action === "share" ? "hub_sharing.undone_share" : "hub_sharing.undone_stop", row.name));
    if (row.state === "changed") lines.push(tr("hub_sharing.changed", row.name));
    if (row.state === "refused") lines.push(tr("hub_sharing.refused", row.name, tr(`hub_sharing.reason.${row.code ?? "unavailable"}`)));
  }
  if (value.rows.some(row => row.kind === "classic-room" && row.state === "shared")) lines.push(tr("hub_sharing.classic"));
  return lines.join("\n");
}
