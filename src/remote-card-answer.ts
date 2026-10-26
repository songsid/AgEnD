/**
 * #2675: answer a card a CLI shows in place of its composer (kiro V3's Question and MCP `Input requested` cards) on a
 * person's behalf, from the chat. Every key goes on a freshly read card under the pane write lock: the same card
 * (identity), the expected page, and the `❯` on the expected row — walked there one verified step at a time, never a
 * blind key. When anything differs (the card was answered in the pane, another card replaced it, a key did not take),
 * it stops with no further key and says where.
 */
import type { RemoteCard, RemoteInputCard, RemoteQuestionCard } from "./backend/types.js";

export type RemoteCardKey = "Up" | "Down" | "Enter" | "Escape" | "Space";

export interface RemoteCardIo {
  /** Run `fn` holding the pane write lock. */
  locked<T>(fn: () => Promise<T>): Promise<T>;
  /** The pane, or null when it could not be read (a failed capture, another spawn): unknown, never "no card". */
  read(): Promise<string | null>;
  key(key: RemoteCardKey): Promise<boolean>;
  /** Bracketed paste, no Enter. */
  paste(text: string): Promise<boolean>;
  sleep(ms: number): Promise<void>;
  /** Monotonic milliseconds. */
  now(): number;
}

export type RemoteCardAction =
  /** Question: choose option `n` (1-based). */
  | { kind: "option"; n: number }
  /** Question: answer in words (the card's typed answer). */
  | { kind: "text"; text: string }
  /** Question: Esc — the card says `Cancelled`. */
  | { kind: "skip" }
  /** Question, sub-options page: submit with every box ticked (only: null), or with only box `only` (1-based). */
  | { kind: "suboptions"; only: number | null }
  /** Question, sub-options page: back to the options. */
  | { kind: "back" }
  /** MCP input: the card's Decline row. */
  | { kind: "decline" }
  /** MCP input: Esc. */
  | { kind: "cancel" };

export type RemoteCardOutcome =
  /** The card closed (or another one replaced it) after our answer. */
  | { outcome: "answered" }
  /** Choosing the option opened its sub-options page: the card is still there, as a new card to post. */
  | { outcome: "suboptions" }
  /** Back on the options page. */
  | { outcome: "back" }
  /** The card is not the one asked about any more (answered in the pane, replaced, or gone). No key was sent. */
  | { outcome: "stale" }
  /** The action does not apply to the card as it is now (another page, no typed answer, no Decline). No key was sent. */
  | { outcome: "refused"; reason: string }
  /** A step did not verify; no key after it. `step` names it for the log. */
  | { outcome: "stopped"; step: string };

/** Keys are this far apart at least: the TUI redraws between them. */
const STEP_SETTLE_MS = 120;
/** How long one key's effect may take to show. */
const STEP_WAIT_MS = 2_000;
/** How long the card may take to close (or change) after the submitting key. */
const RESULT_WAIT_MS = 3_000;
/** No card has more rows than this to walk. */
const MAX_STEPS = 64;

/** The answer as the card's typed-answer row would show it: one line (tui.js turns line breaks into spaces). */
export function remoteCardTypedText(text: string): string {
  return text.replace(/\r\n|\r|\n/g, " ").trim();
}

const squash = (text: string) => text.replace(/\s+/g, " ").trim();

/**
 * The typed-answer row shows the whole answer: exactly it, or — when the answer is longer than the row — a full row
 * (it reaches the card's right edge, so it was clipped there) that is the answer's start or its end. A row with a
 * part of the answer and room to spare is a paste that did not all land.
 */
function typedIsAll(card: RemoteQuestionCard, text: string): boolean {
  const shown = squash(card.typed ?? ""), want = squash(text);
  if (!shown) return false;
  if (shown === want) return true;
  const full = (card.typed ?? "").trimEnd().length >= card.rowWidth - TYPED_ROW_SLACK;
  return full && want.length > shown.length && (want.startsWith(shown) || want.endsWith(shown));
}
/** How far short of the card's width a clipped typed-answer row may end (its ` ❯ ` and the TUI's padding and cursor). */
const TYPED_ROW_SLACK = 8;

export async function answerRemoteCard(
  io: RemoteCardIo,
  readCard: (pane: string) => RemoteCard | null,
  identity: string,
  action: RemoteCardAction,
): Promise<RemoteCardOutcome> {
  /** The card on screen (null: none), or undefined when the screen could not be read — which proves nothing. */
  const current = async (): Promise<RemoteCard | null | undefined> => {
    const pane = await io.read();
    return pane === null ? undefined : readCard(pane);
  };
  /** Poll until `done` holds for a card actually read (null: no card); false after the wait. Unread screens never count. */
  const waitFor = async (done: (card: RemoteCard | null) => boolean, ms = STEP_WAIT_MS): Promise<RemoteCard | null | false> => {
    const until = io.now() + ms;
    for (;;) {
      await io.sleep(STEP_SETTLE_MS);
      const card = await current();
      if (card !== undefined && done(card)) return card;
      if (io.now() >= until) return false;
    }
  };
  /** One key, sent only if the card read under the lock is this one and passes `check`. */
  const press = (check: (card: RemoteCard) => boolean, key: RemoteCardKey) => io.locked(async () => {
    const card = await current();
    if (!card || card.identity !== identity || !check(card)) return false;
    return io.key(key);
  });
  const ours = (card: RemoteCard | null | undefined): card is RemoteCard => card != null && card.identity === identity;
  /** After the submitting key: the card closed, or another card is there. */
  const closed = async (): Promise<RemoteCardOutcome> =>
    (await waitFor(card => !ours(card), RESULT_WAIT_MS)) === false ? { outcome: "stopped", step: "the card did not close" } : { outcome: "answered" };

  const first = await current();
  if (first === undefined) return { outcome: "stopped", step: "reading the screen" };
  if (!ours(first)) return { outcome: "stale" };

  if (first.kind === "input") {
    if (action.kind === "cancel") {
      if (!await press(card => card.kind === "input", "Escape")) return { outcome: "stale" };
      return closed();
    }
    if (action.kind !== "decline") return { outcome: "refused", reason: "not an action on an input request" };
    if (!first.actions.includes("Decline")) return { outcome: "refused", reason: "this request has no Decline" };
    return declineInput(first);
  }

  const question = first;
  switch (action.kind) {
    case "option": {
      if (question.page !== "options") return { outcome: "refused", reason: `the card is on its ${question.page} page` };
      if (!Number.isInteger(action.n) || action.n < 1 || action.n > question.options.length) return { outcome: "refused", reason: "no such option" };
      const target = action.n - 1;
      if (!await walk(target, "options")) return { outcome: "stopped", step: `moving to option ${action.n}` };
      if (!await press(card => onRow(card, "options", target), "Enter")) return { outcome: "stopped", step: "submitting the option" };
      const after = await waitFor(card => !ours(card) || (card.kind === "question" && card.page === "suboptions"), RESULT_WAIT_MS);
      if (after === false) return { outcome: "stopped", step: "the card did not close" };
      if (after?.kind === "question" && after.page === "suboptions" && after.title === question.title && after.question === question.question) return { outcome: "suboptions" };
      return { outcome: "answered" };
    }
    case "text": {
      const text = remoteCardTypedText(action.text);
      if (!text) return { outcome: "refused", reason: "an empty answer" };
      if (!question.freeText) return { outcome: "refused", reason: "this question takes no typed answer" };
      if (question.page !== "options") return { outcome: "refused", reason: `the card is on its ${question.page} page` };
      const pasted = await io.locked(async () => {
        const card = await current();
        if (!ours(card) || card.kind !== "question" || card.page !== "options") return false;
        return io.paste(text);
      });
      if (!pasted) return { outcome: "stopped", step: "typing the answer" };
      const shows = (card: RemoteCard | null) => ours(card) && card.kind === "question" && card.page === "freetext" && typedIsAll(card, text);
      if (await waitFor(shows) === false) return { outcome: "stopped", step: "the typed answer did not show" };
      if (!await press(card => shows(card), "Enter")) return { outcome: "stopped", step: "submitting the typed answer" };
      return closed();
    }
    case "skip": {
      if (question.page !== "options") return { outcome: "refused", reason: `the card is on its ${question.page} page` };
      if (!await press(card => card.kind === "question" && card.page === "options", "Escape")) return { outcome: "stale" };
      return closed();
    }
    case "back": {
      if (question.page !== "suboptions") return { outcome: "refused", reason: "the card is not on a sub-options page" };
      if (!await press(card => card.kind === "question" && card.page === "suboptions", "Escape")) return { outcome: "stale" };
      const back = await waitFor(card => card?.kind === "question" && card.page === "options" && card.question === question.question);
      return back === false ? { outcome: "stopped", step: "going back to the options" } : { outcome: "back" };
    }
    case "suboptions": {
      if (question.page !== "suboptions") return { outcome: "refused", reason: "the card is not on a sub-options page" };
      if (action.only !== null && (!Number.isInteger(action.only) || action.only < 1 || action.only > question.options.length)) {
        return { outcome: "refused", reason: "no such sub-option" };
      }
      const want = question.options.map(option => action.only === null || option.n === action.only);
      for (let index = 0; index < want.length; index++) {
        const card = await current();
        if (!ours(card) || card.kind !== "question" || card.page !== "suboptions") return { outcome: "stopped", step: "reading the boxes" };
        if (card.options[index]?.checked === want[index]) continue;
        if (!await walk(index, "suboptions")) return { outcome: "stopped", step: `moving to sub-option ${index + 1}` };
        if (!await press(c => onRow(c, "suboptions", index) && (c as RemoteQuestionCard).options[index]?.checked !== want[index], "Space")) {
          return { outcome: "stopped", step: `ticking sub-option ${index + 1}` };
        }
        const toggled = await waitFor(c => ours(c) && c.kind === "question" && c.options[index]?.checked === want[index]);
        if (toggled === false) return { outcome: "stopped", step: `sub-option ${index + 1} did not toggle` };
      }
      const ready = (card: RemoteCard) => card.kind === "question" && card.page === "suboptions" && card.options.every((option, i) => option.checked === want[i]);
      if (!await press(ready, "Enter")) return { outcome: "stopped", step: "submitting the sub-options" };
      return closed();
    }
    default:
      return { outcome: "refused", reason: "not an action on a question" };
  }

  /** On `page`, with the `❯` on row `index`. */
  function onRow(card: RemoteCard, page: RemoteQuestionCard["page"], index: number): boolean {
    return card.kind === "question" && card.page === page && card.cursor === index;
  }

  /** Walk the `❯` to row `target`, one verified key at a time (no wrap-around: never past the list's ends). */
  async function walk(target: number, page: RemoteQuestionCard["page"]): Promise<boolean> {
    for (let steps = 0; steps < MAX_STEPS; steps++) {
      const card = await current();
      if (!ours(card) || card.kind !== "question" || card.page !== page || card.cursor === null) return false;
      const from = card.cursor;
      if (from === target) return true;
      const key = from < target ? "Down" : "Up";
      if (!await press(c => onRow(c, page, from), key)) return false;
      const next = from + (key === "Down" ? 1 : -1);
      if (await waitFor(c => c !== null && onRow(c, page, next) && c.identity === identity) === false) return false;
    }
    return false;
  }

  /** Walk the input card's `❯` to its Decline row, then Enter on it. */
  async function declineInput(start: RemoteInputCard): Promise<RemoteCardOutcome> {
    const declineAt = start.actions.indexOf("Decline");
    for (let steps = 0; steps < MAX_STEPS; steps++) {
      const card = await current();
      if (!ours(card) || card.kind !== "input") return { outcome: "stopped", step: "reading the request" };
      if (card.cursorRow === "Decline") {
        if (!await press(c => c.kind === "input" && c.cursorRow === "Decline", "Enter")) return { outcome: "stopped", step: "declining" };
        return closed();
      }
      // Fields come before the actions; only an action after Decline (url mode's Cancel) is below it.
      const at = card.actions.indexOf(card.cursorRow);
      const key = at > declineAt ? "Up" : "Down";
      const from = card.cursorRow;
      if (!await press(c => c.kind === "input" && c.cursorRow === from, key)) return { outcome: "stopped", step: "moving to Decline" };
      if (await waitFor(c => ours(c) && c.kind === "input" && c.cursorRow !== from) === false) return { outcome: "stopped", step: "moving to Decline" };
    }
    return { outcome: "stopped", step: "moving to Decline" };
  }
}
