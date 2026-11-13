/**
 * Hub rooms list (docs/design/hub-rooms-ux.md §2): grouping into the 「房間」 and
 * 「Agent」 groups and one row's view. Pure helpers, no DOM: words come from
 * hub-room-strings.js (namespace hubRoom) in the viewer's language. Agent dots
 * reuse presenceView so the list and the detail agree.
 */
import { hroom } from "./hub-room-strings.js";
import { presenceView } from "./hub-room-presence.js";

/** Spec §2 order within a group: archived last; unread first, then by lastAt. */
function byRecency(a, b) {
  return (a.archived ? 1 : 0) - (b.archived ? 1 : 0)
    || (((a.unread ?? 0) > 0) ? 0 : 1) - (((b.unread ?? 0) > 0) ? 0 : 1)
    || (b.lastAt || 0) - (a.lastAt || 0);
}

/**
 * The sidebar groups: 「房間」 (group rooms) then 「Agent」 (direct chats, with
 * 「Hub 助理」 last). Order inside a group is unread first, then most recent;
 * archived rooms sink to their group's end either way.
 */
export function groupRooms(list) {
  const rooms = list.filter((r) => r.kind === "group").sort(byRecency);
  const direct = list.filter((r) => r.kind !== "group").sort(byRecency);
  const hubAssistant = direct.filter((r) => r.assistant);
  const rest = direct.filter((r) => !r.assistant);
  return [
    { key: "roomsGroup", label: hroom("roomsGroup"), rooms },
    { key: "agentsGroup", label: hroom("agentsGroup"), rooms: [...rest, ...hubAssistant] },
  ];
}

const firstChar = (name) => [...String(name ?? "")][0] ?? "";

const ownerName = (agent) => {
  if (!agent) return "";
  return typeof agent.owner === "string" ? agent.owner : agent.owner?.name ?? "";
};

/**
 * One list row: { avatar, title, line2, mentioned, dot, unread }. Square
 * avatar with the room name's first character for groups, round for chats.
 * line2 is the counts ("3 人 · 12 個 Agent"), the owner's name, or
 * 「Hub 提供」 for the Hub assistant. A group row has no dot; a direct chat
 * takes its agent's dot; a limited item from an old server (no presence,
 * no unread) gets neither.
 */
export function rowView(item) {
  const group = item.kind === "group";
  const agent = !group && item.agent ? item.agent : null;
  let dot = null;
  if (agent && agent.presence) {
    dot = presenceView({ kind: "agent", presence: agent.presence, ...(agent.presenceNote ? { presenceNote: agent.presenceNote } : {}) }).dot;
  }
  const line2 = group
    ? hroom("roomSub", item.people ?? 0, item.agents ?? 0)
    : item.assistant
      ? hroom("providedByHub")
      : ownerName(agent);
  return {
    avatar: group ? { shape: "square", text: firstChar(item.name) } : { shape: "round" },
    title: String(item.name ?? ""),
    line2,
    mentioned: !!item.mentioned,
    dot,
    unread: item.limited ? null : (item.unread ?? 0),
  };
}
