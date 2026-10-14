/**
 * #1823: poll mode for a reply's buttons — a Kahoot-style timed vote. Everyone who may talk to the instance there may
 * vote, once each, and may change their vote; at the deadline the agent gets the results as one message. AgEnD only
 * counts votes: right answers, scores and leaderboards are the agent's, from the results. Design: issue #1823.
 *
 * This file is the pure part: the `poll` argument, a voter's ballot, the tally, what the platforms show, and the results
 * text. The store (reply-buttons.ts) and the controller (reply-buttons-controller.ts) do the rest.
 */
import { t } from "./locale.js";
import type { ReplyButton } from "./reply-buttons.js";

export const POLL_SECONDS_MIN = 10;
export const POLL_SECONDS_MAX = 24 * 60 * 60;
export const POLL_OPTIONS_MIN = 2;
/** How much of the reply's text the results quote as the question. */
export const POLL_QUESTION_MAX = 300;
/** Inert callbacks: the status button, and a closed poll's options. Never a set id (`rb:<32 hex>:<i>`). */
export const POLL_STATUS_CALLBACK = "rb:poll";
export const POLL_CLOSED_CALLBACK = "rb:pollclosed";

export type PollReveal = "close" | "live";
export interface PollConfig {
  seconds: number;
  /** Several options per voter (a click toggles one). */
  multi: boolean;
  /** "close" (default, Kahoot): only "N answered" while open. "live": the counts too. */
  reveal: PollReveal;
  /** At close, one follow-up message names who picked what. */
  showVoters: boolean;
  /** The reply's text, cut: what the results quote as the question. */
  question: string;
}

/** One voter's ballot. `at` is when it last changed (wall clock); the results give it as ms since the poll opened. */
export interface PollBallot { voter: string; name: string; options: number[]; at: number }

/**
 * The reply's `poll`, checked against its buttons: null when there is none, `{ error }` when it cannot be sent as given.
 * Like `buttons`, it is checked here because MCP does not validate a tool's arguments at run time.
 */
export function parsePoll(raw: unknown, buttons: readonly ReplyButton[] | null, text: unknown): { poll: PollConfig } | { error: string } | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) return { error: "poll must be { seconds, multi?, reveal?, show_voters? }" };
  if (!buttons || buttons.length < POLL_OPTIONS_MIN) return { error: `a poll needs at least ${POLL_OPTIONS_MIN} buttons: its options` };
  const p = raw as Record<string, unknown>;
  const known = new Set(["seconds", "multi", "reveal", "show_voters"]);
  const unknown = Object.keys(p).find(k => !known.has(k));
  if (unknown) return { error: `poll.${unknown} is not a poll option (seconds, multi, reveal, show_voters)` };
  const { seconds, multi, reveal, show_voters: showVoters } = p;
  if (typeof seconds !== "number" || !Number.isInteger(seconds) || seconds < POLL_SECONDS_MIN || seconds > POLL_SECONDS_MAX) {
    return { error: `poll.seconds must be a whole number from ${POLL_SECONDS_MIN} to ${POLL_SECONDS_MAX} (24 h)` };
  }
  if (multi !== undefined && typeof multi !== "boolean") return { error: "poll.multi must be true or false" };
  if (reveal !== undefined && reveal !== "close" && reveal !== "live") return { error: "poll.reveal must be \"close\" or \"live\"" };
  if (showVoters !== undefined && typeof showVoters !== "boolean") return { error: "poll.show_voters must be true or false" };
  const question = typeof text === "string" ? text.trim().replace(/\s+/g, " ") : "";
  return {
    poll: {
      seconds, multi: multi === true, reveal: reveal === "live" ? "live" : "close", showVoters: showVoters === true,
      question: question.length > POLL_QUESTION_MAX ? `${question.slice(0, POLL_QUESTION_MAX - 1)}…` : question,
    },
  };
}

/**
 * A voter's ballot after one click. One choice: the clicked option (clicking the one already chosen changes nothing).
 * Several: the click toggles that option; an empty ballot withdraws the voter.
 */
export function nextBallot(current: readonly number[] | null, index: number, multi: boolean): { options: number[]; changed: boolean } {
  const before = current ?? [];
  if (!multi) {
    const same = before.length === 1 && before[0] === index;
    return { options: [index], changed: !same };
  }
  const options = before.includes(index) ? before.filter(i => i !== index) : [...before, index].sort((a, b) => a - b);
  return { options, changed: true };
}

/** How many ballots chose each option. */
export function pollCounts(optionCount: number, ballots: readonly PollBallot[]): number[] {
  const counts = new Array<number>(optionCount).fill(0);
  for (const b of ballots) for (const i of b.options) if (i >= 0 && i < optionCount) counts[i]!++;
  return counts;
}

/**
 * What a platform shows, ready to lay out: the options (a count after the label when revealed), and one status line.
 * `deadline` is a wall-clock instant; a platform that cannot count down by itself shows `pollRemaining` of it.
 */
export interface PollRender {
  options: Array<{ id: string; label: string }>;
  status: string;
  deadline: number;
  closed: boolean;
}

export function pollRender(
  labels: readonly string[], callbacks: readonly string[], poll: PollConfig, ballots: readonly PollBallot[], deadline: number, closed: boolean,
): PollRender {
  const counts = pollCounts(labels.length, ballots);
  const reveal = closed || poll.reveal === "live";
  const total = ballots.length;
  const options = labels.map((label, i) => ({
    id: closed ? `${POLL_CLOSED_CALLBACK}:${i}` : callbacks[i]!,
    label: reveal ? `${label} · ${counts[i]}${closed && total ? ` (${Math.round((counts[i]! / total) * 100)}%)` : ""}` : label,
  }));
  return { options, status: closed ? t("poll.status_closed", total) : t("poll.status_open", total), deadline, closed };
}

/**
 * The time left as a platform that cannot count down by itself shows it, rounded up to the step it is redrawn at (a
 * label is never ahead of the clock): seconds in the last two minutes, minutes up to an hour, then hours and minutes.
 */
export function pollRemaining(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  if (s <= 120) {
    const r = Math.ceil(s / 5) * 5;
    return `${Math.floor(r / 60)}:${String(r % 60).padStart(2, "0")}`;
  }
  const m = Math.ceil(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min`;
}

/** How often a countdown that is redrawn (Telegram) is redrawn, for the time left: inside the platforms' edit limits. */
export function pollTickMs(remainingMs: number): number {
  if (remainingMs <= 2 * 60_000) return 5_000;
  if (remainingMs <= 10 * 60_000) return 30_000;
  return 5 * 60_000;
}

/** Telegram's limit on a click's toast (answerCallbackQuery text); Discord's ephemeral reply allows more. */
export const POLL_NOTICE_MAX = 200;
/** What a voter is told, privately, after a click — cut to fit a Telegram toast (several long options can exceed it). */
export function pollVoteNotice(labels: readonly string[], options: readonly number[]): string {
  const notice = options.length ? t("poll.voted", options.map(i => labels[i] ?? "?").join(", ")) : t("poll.withdrawn");
  if (notice.length <= POLL_NOTICE_MAX) return notice;
  // Cut on whole characters: half of a surrogate pair (an emoji) would be replaced or refused (#1824 review).
  let out = "";
  for (const ch of notice) { if (out.length + ch.length > POLL_NOTICE_MAX - 1) break; out += ch; }
  return `${out}…`;
}

/**
 * The results, as the one inbound message the agent gets. Per option: its count and voters, each with a stable id and
 * the ms from the poll opening to their ballot's last change. `closedAt` later than the deadline (AgEnD was not running
 * then) is said, so the agent does not read the lateness as slow voters.
 */
export function pollResultsText(
  set: { id: string; buttons: readonly ReplyButton[]; createdAt: number; expiresAt: number },
  poll: PollConfig, ballots: readonly PollBallot[], closedAt: number,
): string {
  const counts = pollCounts(set.buttons.length, ballots);
  const late = closedAt - set.expiresAt > 5_000 ? ` · closed ${Math.round((closedAt - set.expiresAt) / 1000)} s late (AgEnD was not running at the deadline)`
    : set.expiresAt - closedAt > 1_000 ? ` · closed early by close_poll after ${Math.round((closedAt - set.createdAt) / 1000)} s` : " · closed on time";
  const head = `[poll results] poll ${set.id.slice(0, 8)} · ${poll.multi ? "multiple choice" : "single choice"} · ${poll.seconds} s · ${ballots.length} voted${late}`;
  const lines = [head];
  if (poll.question) lines.push(`Q: ${poll.question}`);
  const byTime = [...ballots].sort((a, b) => a.at - b.at || a.voter.localeCompare(b.voter));
  set.buttons.forEach((b, i) => {
    const label = b.value === b.label ? b.label : `${b.label} (value: ${b.value})`;
    const voters = byTime.filter(v => v.options.includes(i)).map(v => `${v.name} [${v.voter}] ${Math.max(0, v.at - set.createdAt)} ms`);
    lines.push(`${i + 1}) ${label} — ${counts[i]}${voters.length ? `: ${voters.join("; ")}` : ""}`);
  });
  lines.push("ms = time from the poll opening to the voter's last change. AgEnD only counts votes: post the answer and any scores yourself.");
  return lines.join("\n");
}

/** With `show_voters`: who picked what, as the follow-up message under a closed poll. */
export function pollVotersText(labels: readonly string[], ballots: readonly PollBallot[]): string {
  const byTime = [...ballots].sort((a, b) => a.at - b.at || a.voter.localeCompare(b.voter));
  const lines = labels.map((label, i) => {
    const names = byTime.filter(v => v.options.includes(i)).map(v => v.name);
    return `${label} (${names.length}): ${names.length ? names.join(", ") : "—"}`;
  });
  return `${t("poll.voters_title")}\n${lines.join("\n")}`;
}
