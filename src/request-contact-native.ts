/**
 * S-229 (slice K): the Discord/Telegram face of slice I's same card. General and the system post the card that
 * RequestContactCards.prepareForNativePost returns (authority none, canDecide false); only the platform callback's
 * person, on the bot that posted it, decides — through the same cards.decide writer and CAS snapshot as the web.
 * Text only here: no store, adapter or permission is read.
 */
import type { ContactPerson } from "./contact-auth-types.js";
import { getLocale, t } from "./locale.js";
import type { RequestContactCardV1, RequestContactPrincipal } from "./request-contact-types.js";

export type NativeContactAction = "approve" | "decline" | "cancel";
export interface NativeContactCardView { message: string; choices: Array<{ action: NativeContactAction; label: string }> }

const zh = (): boolean => getLocale() === "zh-TW";
/** The short id people see on every contact surface: R + 8 hex. */
export const nativeShortId = (id: string): string => /^R[a-f0-9]{8}-/.test(id) ? id.slice(0, 9) : id;

/** Who asked, in words; a Hub person is marked as such and never presented as a native account. */
export function nativeRequesterLabel(card: RequestContactCardV1): string | null {
  const actor = card.requester;
  if (!actor || actor.kind === "unknown") return null;
  const name = actor.displayName || (actor.platform === "hub" ? t("contactCard.someone") : actor.platform === "host" ? t("contactProposal.host") : t("contactCard.someone"));
  return actor.platform === "hub" ? `${name}${zh() ? "（Hub）" : " (Hub)"}` : name;
}

const expiresIn = (card: RequestContactCardV1, now: number): string => {
  const left = Date.parse(card.ticket.expiresAt) - now;
  return left < 2 * 3_600_000 ? t("contactHeld.minutes", Math.max(1, Math.round(left / 60_000))) : t("contactHeld.hours", Math.round(left / 3_600_000));
};

/**
 * The card: a question title, the held message, one meta line (who asked · #id · expiry) and one scope sentence.
 * A General proposal leads with its one suggestion and offers only that choice plus Not now.
 */
export function nativeContactCardText(card: RequestContactCardV1, opts: { now?: number; proposal?: "approve-once" | "decline" } = {}): NativeContactCardView {
  const now = opts.now ?? Date.now(), root = card.approvalScope === "root-request";
  const quote = card.ticket.message.length > 300 ? `${card.ticket.message.slice(0, 299)}…` : card.ticket.message;
  const asker = nativeRequesterLabel(card);
  const meta = [...(asker ? [t("contactCard.asked", asker)] : []), `#${nativeShortId(card.ticket.id)}`, t("contactCard.expires", expiresIn(card, now))].join(" · ");
  const approve = t(root ? "contactCard.continue" : "contactHeld.approve"), decline = t("contactHeld.decline");
  const lines = [
    ...(opts.proposal ? [t("contactCard.suggests", opts.proposal === "decline" ? decline : approve)] : []),
    t("contactCard.title", card.sourceLabel, card.targetLabel),
    `> ${quote.replace(/\s*\n+\s*/g, " ")}`,
    meta,
    t(root ? "contactCard.scope_root" : "contactCard.scope_once"),
  ];
  const choices: NativeContactCardView["choices"] = opts.proposal
    ? [{ action: opts.proposal === "decline" ? "decline" : "approve", label: opts.proposal === "decline" ? decline : approve }, { action: "cancel", label: t("contactCard.not_now") }]
    : [{ action: "approve", label: approve }, { action: "decline", label: decline }];
  return { message: lines.join("\n"), choices };
}

/**
 * The person behind a native click. Verified means exactly: the platform reported this user clicking a button the
 * same bot posted (the nonce already binds adapter, chat, thread and message). Never the bot itself; never another
 * adapter's world. `current` re-checks the adapter at every awaited step and inside the writer.
 */
export function nativeContactPrincipal(input: {
  adapter: { id: string; type: string; getBotUserId?(): string | undefined } | undefined;
  adapterId: string; userId: string | undefined; username?: string; nonce: string;
  live(): boolean;
}): RequestContactPrincipal | null {
  const { adapter, adapterId, userId } = input;
  if (!adapter || !userId || adapter.id !== adapterId || (adapter.type !== "discord" && adapter.type !== "telegram")) return null;
  if (userId === adapter.getBotUserId?.() || !input.live()) return null;
  const person: ContactPerson = { platform: adapter.type, adapterId, userId, label: input.username || userId };
  return { person, binding: `native:${adapterId}:${input.nonce}`, verified: true,
    current: () => input.live() && userId !== adapter.getBotUserId?.() };
}

/** What the card says once it is closed, read from the committed card (never from the click alone). */
export function nativeContactOutcome(card: RequestContactCardV1 | null, mine: { decided: boolean; by?: ContactPerson }): string {
  if (!card) return t("contactHeld.closed");
  const root = card.approvalScope === "root-request", state = card.ticket.state;
  if (mine.decided && mine.by) {
    if (state === "approved" || state === "delivered") return t(root ? "contactCard.continued" : "contactHeld.approved", mine.by.label);
    if (state === "declined") return t("contactHeld.declined", mine.by.label);
  }
  if (state === "approved" || state === "delivered") return t(root ? "contactCard.continued_elsewhere" : "contactHeld.approvedElsewhere");
  if (state === "declined") return t("contactHeld.declinedElsewhere");
  if (state === "expired") return t("contactHeld.expired");
  return t("contactHeld.closed");
}

/** I's stable decision codes, sorted by what a native card does next. */
export function nativeDecisionFailure(error: unknown): "outcome" | "changed" | "failed" {
  const code = error instanceof Error ? error.message : "";
  if (code === "already-decided" || code === "expired") return "outcome";
  if (code === "conflict" || code === "policy-conflict" || code === "operation-conflict") return "changed";
  return "failed";
}
