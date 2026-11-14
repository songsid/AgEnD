/**
 * Hub rooms presence (docs/design/hub-rooms-ux.md §5): the status dot and word for a
 * member, the agents sort order, the Members/Agents header counts, and the
 * overflow split behind "… 其餘 N 個". Pure helpers, no DOM: words come from
 * hub-room-strings.js (namespace hubRoom) in the viewer's language, so this
 * module imports it for its registration side effect and reads through hroom.
 */
import { hroom } from "./hub-room-strings.js";

/** Spec §5 rows, in list order: 處理中, 待命, 暫停, 離線, 上線時回答. */
const GROUP_ORDER = ["working", "idle", "paused", "offline", "later"];

/** Presence value → status dot (spec §5 colours: green idle counts as online). */
const DOT = { online: "online", idle: "online", working: "working", paused: "paused", offline: "offline", later: "offline" };

/** Presence value → hubRoom word key. */
const WORD = { online: "stOnline", idle: "stIdle", working: "stWorking", paused: "stPaused", offline: "stOffline", later: "stLater" };

/**
 * Fixture/server presence-note display text → hubRoom reason key. The note arrives
 * as display text (the fixture's contract), so the known ones map back to their
 * keys here; anything else passes through unchanged (it is text, never a key).
 * Once R2 serves presenceReason codes, those win over this legacy text path.
 */
const NOTE_KEY = { "額度用完": "pauseQuota", "等待登入": "pauseSignIn", "等待核准": "pauseApproval", "需要更新 AgEnD": "needsUpdate" };

/**
 * R2 presenceReason codes → display overrides (hub-rooms track R/C contract).
 * A mapped reason wins over any legacy presenceNote text, but only when the
 * member's presence matches: patches can merge a stale reason onto a newer
 * presence that omits it, so a lingering reason must never override a fresh
 * presence. An unmapped code is ignored so the presence mapping stands and
 * no raw code ever reaches the UI.
 * - quota/auth/approval/operator/capacity apply to paused only (yellow; only
 *   the first three have a reason word, there is no operator/capacity word
 *   in hubRoom yet).
 * - update applies to offline only (grey with its own word).
 * - idle: no-op, the presence already says idle (autowake sleep).
 * - error/stuck/unknown: no mapping defined — the presence mapping stands.
 * - stopped/crashed: grey dot (offline) + the "stopped" word, gated on
 *   presence "paused" as C only sends these paused (crashed is normalised
 *   to stopped server-side, so both map to stStopped here).
 */
const REASON = {
  quota: { when: ["paused"], dot: "paused", word: "stPaused", noteKey: "pauseQuota" },
  auth: { when: ["paused"], dot: "paused", word: "stPaused", noteKey: "pauseSignIn" },
  approval: { when: ["paused"], dot: "paused", word: "stPaused", noteKey: "pauseApproval" },
  update: { when: ["offline"], dot: "offline", word: "needsUpdate" },
  operator: { when: ["paused"], dot: "paused", word: "stPaused" },
  capacity: { when: ["paused"], dot: "paused", word: "stPaused" },
  stopped: { when: ["paused"], dot: "offline", word: "stStopped" },
  crashed: { when: ["paused"], dot: "offline", word: "stStopped" },
};

const groupIndex = (presence) => { const i = GROUP_ORDER.indexOf(presence); return i < 0 ? GROUP_ORDER.length : i; };

/**
 * One member's status: { dot, word, noteKey?, noteText? }. dot is the status
 * colour; word is always a hubRoom key; noteKey is too when the member's
 * presenceNote matches a known reason, while an unrecognised note goes to
 * noteText and is shown verbatim — never passed through hroom, so an unknown
 * reason can never render as a raw hubRoom.* key. An offline member whose note
 * is 需要更新 AgEnD shows as offline with its own word; a paused room assistant
 * shows 暫時無法回答.
 */
export function presenceView(member) {
  const presence = member?.presence;
  if (member?.kind === "assistant") {
    return presence === "paused"
      ? { dot: "paused", word: "stAssistantDown" }
      : { dot: DOT[presence] ?? "offline", word: WORD[presence] ?? "stOffline" };
  }
  const reason = REASON[member?.presenceReason];
  if (reason && reason.when.includes(presence)) return { dot: reason.dot, word: reason.word, ...(reason.noteKey ? { noteKey: reason.noteKey } : {}) };
  const noteKey = NOTE_KEY[member?.presenceNote];
  if (presence === "offline" && noteKey === "needsUpdate") return { dot: "offline", word: "needsUpdate" };
  const view = { dot: DOT[presence] ?? "offline", word: WORD[presence] ?? "stOffline" };
  if (noteKey) view.noteKey = noteKey;
  else if (member?.presenceNote) view.noteText = member.presenceNote;
  return view;
}

/**
 * The Fleet sidebar dot class for a presence value, or for a presence + reason
 * pair (shared with the list rows). A reason the table knows wins when its
 * `when` gate matches the presence — so a stopped agent reads grey, not yellow.
 * Unknown or gated-out reasons fall back to the plain presence dot.
 */
const DOT_CLASS = { online: "ok", idle: "ok", working: "busy", paused: "warn", offline: "off", later: "off" };
export function presenceDot(presence, reason) {
  const r = typeof reason === "string" ? REASON[reason] : undefined;
  const dot = (r && r.when.includes(presence) ? r.dot : undefined) ?? DOT[presence] ?? "offline";
  return DOT_CLASS[dot] ?? "off";
}

/**
 * The Agents list order (spec §5): working, then idle (待命), paused, offline,
 * reply-later; stable by name within each group. Only kind "agent"/"later"
 * members sort here — people have their own row and the room assistant has its.
 */
export function sortAgents(members) {
  return members
    .filter((m) => m.kind === "agent" || m.kind === "later")
    .map((m, i) => [m, i])
    .sort(([a, ai], [b, bi]) => groupIndex(a.presence) - groupIndex(b.presence) || (a.name < b.name ? -1 : a.name > b.name ? 1 : ai - bi))
    .map(([m]) => m);
}

/** "Agent · 12（線上 9）" and "成員 · 3（線上 2）" in the viewer's language. */
export function headerCounts(members) {
  const agents = members.filter((m) => m.kind === "agent" || m.kind === "later");
  const people = members.filter((m) => m.kind === "person");
  const online = (list) => list.filter((m) => m.presence === "online" || m.presence === "idle" || m.presence === "working").length;
  return {
    agent: hroom("agentsHead", agents.length, online(agents)),
    member: hroom("membersHead", people.length, online(people)),
  };
}

/** The first `limit` rows shown, the rest folded behind "… 其餘 N 個". */
export function collapse(list, limit = 8) {
  return { shown: list.slice(0, limit), rest: Math.max(0, list.length - limit) };
}
