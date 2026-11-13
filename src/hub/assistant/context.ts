import type { RoomAssistantContextMessage } from "./types.js";

/** Keep the latest thirty rows plus at most one older replied-to anchor, in the server's oldest-first order. */
export function roomAssistantContext(rows: readonly RoomAssistantContextMessage[]): RoomAssistantContextMessage[] {
  const recent = rows.slice(-30), anchor = rows.find(row => row.repliedTo === true);
  const selected = anchor && !recent.includes(anchor) ? [anchor, ...recent] : recent;
  return selected.map(row => ({ author: row.author, text: row.text, at: row.at, ...(row.repliedTo === true ? { repliedTo: true as const } : {}) }));
}
