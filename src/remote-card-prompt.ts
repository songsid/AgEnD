/**
 * #2675: how a card a CLI shows in place of its composer is put to a person in the chat — the message, its buttons
 * (platform) and actions (dashboard), and the action a button id stands for. Pure: the fleet posts it and keys the
 * answer (remote-card-answer.ts through the daemon).
 */
import type { RemoteCard } from "./backend/types.js";
import type { RemoteCardAction, RemoteCardOutcome } from "./remote-card-answer.js";
import { t } from "./locale.js";

/** Buttons per card at most: Discord's 25 less room for Skip / Back. Beyond it the card is answered in words or the pane. */
export const REMOTE_CARD_MAX_OPTIONS = 20;
/** A button label's length at most (Discord's limit is 80; long ones are clipped with an ellipsis). */
const LABEL_MAX = 60;
/** A typed answer's length at most. */
export const REMOTE_CARD_TEXT_MAX = 4_000;

const clip = (text: string, max = LABEL_MAX) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

export interface RemoteCardPrompt {
  message: string;
  /** The platform's buttons: `action` is the id after `<prefix><nonce>:`. */
  choices: Array<{ action: string; label: string }>;
  /** The dashboard's extra action: the typed answer, which the platform takes as a reply to the message instead. */
  webInput: { action: string; label: string } | null;
}

/** The message and buttons for `card`, asked by `instance`. */
export function remoteCardPrompt(instance: string, card: RemoteCard): RemoteCardPrompt {
  if (card.kind === "input") {
    return {
      message: [t("card.input_intro", card.server, instance), ...card.rows.map(row => `  ${row}`), t("card.input_hint")].join("\n"),
      choices: [
        ...(card.actions.includes("Decline") ? [{ action: "decline", label: t("card.decline") }] : []),
        { action: "cancel", label: t("card.cancel") },
      ],
      webInput: null,
    };
  }
  if (card.page === "suboptions") {
    const titles = card.options.map(option => option.title);
    return {
      message: [t("card.sub_intro", instance), card.question, ...card.options.map(o => `${o.checked ? "☑" : "☐"} ${o.title}`)].join("\n"),
      choices: [
        { action: "sub-all", label: clip(t("card.sub_all", titles.join(", "))) },
        ...(card.options.length <= REMOTE_CARD_MAX_OPTIONS && card.options.length > 1
          ? card.options.map(o => ({ action: `sub-${o.n}`, label: clip(t("card.sub_only", o.title)) })) : []),
        { action: "back", label: t("card.back") },
      ],
      webInput: null,
    };
  }
  const listed = card.options.map(o => {
    const title = `${o.n}. ${o.title}${o.recommended ? ` ${t("card.recommended")}` : ""}`;
    return o.description ? `${title} — ${o.description}` : title;
  });
  const buttons = card.options.length <= REMOTE_CARD_MAX_OPTIONS
    ? card.options.map(o => ({ action: `opt-${o.n}`, label: clip(`${o.n}. ${o.title}${o.recommended ? " ★" : ""}`) })) : [];
  return {
    message: [t("card.question_intro", instance), card.question, ...listed, card.freeText ? t("card.question_hint_text") : t("card.question_hint")].join("\n"),
    choices: [...buttons, { action: "skip", label: t("card.skip") }],
    webInput: card.freeText ? { action: "text", label: t("card.answer_in_words") } : null,
  };
}

/** The action a button id stands for (null: not one of ours). `text` takes the typed answer. */
export function remoteCardAction(action: string, text?: string): RemoteCardAction | null {
  const option = /^opt-(\d{1,2})$/.exec(action);
  if (option) return { kind: "option", n: Number(option[1]) };
  const sub = /^sub-(\d{1,2}|all)$/.exec(action);
  if (sub) return { kind: "suboptions", only: sub[1] === "all" ? null : Number(sub[1]) };
  switch (action) {
    case "back": case "skip": case "decline": case "cancel": return { kind: action };
    case "text": return typeof text === "string" && text.trim() ? { kind: "text", text: text.slice(0, REMOTE_CARD_TEXT_MAX) } : null;
    default: return null;
  }
}

/** What the person chose, in words, for the outcome line (never the typed answer itself: it is in their own message). */
export function remoteCardChoiceLabel(card: { kind: RemoteCard["kind"]; options?: Array<{ n: number; title: string }> }, action: RemoteCardAction): string {
  switch (action.kind) {
    case "option": return clip(card.options?.find(o => o.n === action.n)?.title ?? `#${action.n}`);
    case "suboptions": return action.only === null ? t("card.sub_all_short") : clip(t("card.sub_only", card.options?.find(o => o.n === action.only)?.title ?? `#${action.only}`));
    case "text": return t("card.in_words");
    case "skip": return t("card.skip");
    case "back": return t("card.back");
    case "decline": return t("card.decline");
    case "cancel": return t("card.cancel");
  }
}

/** The line the card's message collapses to once a person's answer was keyed in (or was not). */
export function remoteCardOutcomeText(instance: string, who: string, choice: string, outcome: RemoteCardOutcome): string {
  switch (outcome.outcome) {
    case "answered": return t("card.answered", who, choice);
    case "suboptions": return t("card.opened_sub", who, choice);
    case "back": return t("card.went_back", who);
    case "stale": return t("card.stale", instance);
    case "refused": return t("card.refused", instance);
    case "stopped": return t("card.stopped", instance);
  }
}
