// Hub rooms WorkBar line and assistant footnote (hub-rooms-ux.md §3 處理中). Pure: a room GET
// answer or a message in, words out. Words come from hub-room-strings.js (hroom), never copied.
import { hroom } from "./hub-room-strings.js";

function workingOf(detail) {
  const members = detail && Array.isArray(detail.members) ? detail.members : [];
  return members.filter((m) => m && (m.kind === "agent" || m.kind === "assistant") && m.presence === "working");
}

function displayName(member) {
  return member.kind === "assistant" ? hroom("roomAssistant") : member.name;
}

/** One / several agents (and the room assistant) currently working; people never count. */
export function workingLine(detail) {
  const working = workingOf(detail);
  if (!working.length) return null;
  const names = working.map(displayName);
  const count = working.length;
  const text = count === 1 ? hroom("workingOne", names[0]) : hroom("workingMany", count);
  return { text, names, count };
}

/** Footnote under an assistant's answer; empty for anyone else. */
export function assistantFootnote(message) {
  const author = message && message.author;
  if (author && author.kind === "assistant" && message.answerTo) return hroom("basedOnRecent");
  return "";
}
