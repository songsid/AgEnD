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

/**
 * M-3596: a 1:1 room's status line, as the Fleet chat's work bar says it — from the open question's answer row (no text
 * yet: working once the agent was handed it, else queued with how many came first) and the agent's presence. Words from
 * hroom, never copied. → { kind: "working", text, since } | { kind: "awaiting", text } | null (nothing open).
 */
export function directStatus(messages, agent) {
  const rows = Array.isArray(messages) ? messages.filter((m) => m && m.answerTo && !m.text && m.author && m.author.kind === "agent"
    && (m.stage === "working" || m.stage === "queued")) : [];
  const name = String((agent && agent.name) || (rows[0] && rows[0].author.name) || "");
  const working = rows.find((m) => m.stage === "working");
  if (working) return { kind: "working", text: hroom("workingOne", name), since: typeof working.startedAt === "number" ? working.startedAt : working.at };
  const queued = rows.find((m) => m.stage === "queued");
  if (!queued) return null;
  const presence = agent && agent.presence, ahead = typeof queued.ahead === "number" ? queued.ahead : 0;
  const text = presence === "paused" ? hroom("waitPaused", name)
    : presence === "offline" || presence === "later" ? hroom("waitOffline", name)
    : ahead > 1 ? hroom("waitBehindMany", name, ahead) : ahead === 1 ? hroom("waitBehindOne", name)
    : presence === "working" ? hroom("waitBusy", name) : hroom("waitStart", name);
  return { kind: "awaiting", text };
}
