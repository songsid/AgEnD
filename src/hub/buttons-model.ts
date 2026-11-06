/** Pure, bounded buttons-v1 data. No timers, stores, connections or identity/authority on import. */
import { createHash, randomBytes } from "node:crypto";
import { parseReplyButtons, type ReplyButton } from "../reply-buttons.js";
import { parsePoll, type PollConfig } from "../reply-polls.js";
import type { HubAnswerButtons } from "./types.js";
import { HubProtocolError, scalarString } from "./validation.js";

/** The wire uses normalized reply models. Reject noncanonical fields rather than silently changing signed bytes. */
export function validHubAnswerButtons(b: HubAnswerButtons): boolean {
  if (!/^[a-f0-9]{32}$/.test(b.id) || !Array.isArray(b.labels) || b.labels.length === 0
    || b.values !== undefined && (!Array.isArray(b.values) || b.values.length !== b.labels.length)) return false;
  if (b.labels.some(v => typeof v !== "string" || !scalarString(v)) || b.values?.some(v => typeof v !== "string" || !scalarString(v))) return false;
  const raw = b.labels.map((label, i) => ({ label, ...(b.values ? { value: b.values[i] } : {}) }));
  const parsed = parseReplyButtons(raw, { text: "buttons-v1" });
  if (!parsed || "error" in parsed || parsed.buttons.some((v, i) => v.label !== b.labels[i] || v.value !== (b.values?.[i] ?? b.labels[i]))) return false;
  if (!b.poll) return true;
  if (typeof b.poll.question !== "string" || !scalarString(b.poll.question)) return false;
  const p = parsePoll({ seconds: b.poll.seconds, multi: b.poll.multi, reveal: b.poll.reveal, show_voters: b.poll.showVoters }, parsed.buttons, b.poll.question);
  return !!p && "poll" in p && p.poll.question === b.poll.question;
}

/** Covers every choice, its order, the exact set and all poll settings. Absent values remain distinct from present. */
export function buttonsDigest(b: HubAnswerButtons | undefined): string | undefined {
  if (!b) return undefined;
  const p = b.poll;
  return createHash("sha256").update(JSON.stringify(["agend-hub-answer-buttons-v1", b.id, b.labels, b.values ?? null,
    p ? [p.seconds, p.multi, p.reveal, p.showVoters, p.question] : null])).digest("hex");
}

/** Snapshot before any lease/network await; caller mutation cannot alter the answer after it is authorized. */
export function prepareHubAnswerButtons(buttons: readonly ReplyButton[] | undefined, poll?: PollConfig): HubAnswerButtons | undefined {
  if (!buttons?.length) return undefined;
  const b: HubAnswerButtons = { id: randomBytes(16).toString("hex"), labels: Object.freeze(buttons.map(v => v.label)),
    values: Object.freeze(buttons.map(v => v.value)), ...(poll ? { poll: Object.freeze({ ...poll }) } : {}) };
  if (!validHubAnswerButtons(b)) throw new HubProtocolError("invalid");
  return Object.freeze(b);
}
