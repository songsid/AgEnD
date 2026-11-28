// What is new for this person on the board (Fleet › Tasks; docs/design/task-board.md, "Unread"): a dot with the number on the card that has
// something new (the board's tile, the list's row), and a strip at the top of Home and of a project's board that names the cards and says
// why — "dev answered you", "web-user replied to your comment", "dev mentioned you", "Waiting for your confirmation". Opening a card marks
// it read (task-unread.js). The numbers come from the app store (`taskUnread`, read from the server by task-unread.js): nothing here
// asks for anything, stores anything or carries a comment's words. A tile and a row never subscribe to the store themselves: the board reads
// it once (`useUnreadCards`) and redraws only when it changes. No style attribute anywhere (the CSP).
import { html, useEffect, useRef, useState } from "/assets/app-html.js";
import { t, register } from "/assets/app-i18n.js";
import { appStore } from "/assets/app-store.js";
import { Icon } from "/assets/ui-icons.js";
import { relTime } from "./fleet-task-common.js";
import { installTaskUnread } from "./task-unread.js";

register("taskunread", {
  en: {
    title: "{0} task cards with new replies", titleOne: "1 task card has new replies", mark: "{0} new", markTip: "New for you: {0}",
    "reason.answer": "{0} answered you", "reason.reply": "{0} replied to your comment", "reason.mention": "{0} mentioned you",
    "reason.review": "Waiting for your confirmation", "reason.blocked": "Waiting for your answer", more: "+{0} more", seeMore: "{0} more cards",
    short_answer: "Answered", short_reply: "Replied", short_mention: "Mentioned", short_review: "To confirm", short_blocked: "To answer",
  },
  "zh-TW": {
    title: "{0} 張任務卡有新回覆", titleOne: "1 張任務卡有新回覆", mark: "{0} 則新動態", markTip: "給你的新動態：{0}",
    "reason.answer": "{0} 回覆了你", "reason.reply": "{0} 回覆了你的留言", "reason.mention": "{0} 提到了你",
    "reason.review": "等你確認", "reason.blocked": "等你回答", more: "另外 {0} 則", seeMore: "還有 {0} 張卡",
    short_answer: "已回覆", short_reply: "回覆你", short_mention: "提到你", short_review: "待確認", short_blocked: "待回答",
  },
});

const EMPTY = Object.freeze({});
/** The strongest first: what a card with several reasons says (the server orders them so, and sends them so). */
const SHOWN = 5;

/** The unread by card number the board draws marks from, redrawing the board only when the store's unread itself changes. */
export function useUnreadCards() {
  const [, redraw] = useState(0);
  const seen = useRef(null);
  seen.current = appStore.get().taskUnread || null;
  useEffect(() => {
    installTaskUnread();                               // a tab from before an upgrade has this panel but not the new app.js
    const changed = () => (appStore.get().taskUnread || null) !== seen.current;
    if (changed()) redraw((n) => n + 1);
    return appStore.subscribe(() => { if (changed()) redraw((n) => n + 1); });
  }, []);
  const u = seen.current;
  return (u && u.enabled && u.cards) || EMPTY;
}

/**
 * A card's mark: its own unread and, for a main task, its sub tasks' (a reply on a sub task is news on the main task's tile too) —
 * `{ n, reasons }` (reasons strongest first, each once), or null when none. Pure: tests import it.
 */
export function markFor(card, subs, unread) {
  const own = unread && unread[card.id];
  const list = [own, ...(subs || []).map((s) => unread && unread[s.id])].filter(Boolean);
  if (!list.length) return null;
  const order = ["review", "blocked", "reply", "answer", "mention"];
  const reasons = order.filter((r) => list.some((u) => (u.reasons || []).includes(r)));
  return { n: list.reduce((a, u) => a + (u.n || 0), 0), reasons };
}

/** The strip's heading: how many cards (one has its own sentence: "1 cards" is not English). */
export const stripTitle = (n) => (n === 1 ? t("taskunread.titleOne") : t("taskunread.title", n));

/** The words for one card's reason: who did it (the card's newest) and what. */
export const reasonText = (u) => {
  const r = (u.reasons && u.reasons[0]) || "answer";
  return t(`taskunread.reason.${r}`, u.by || "");
};

/** The dot on a tile or a row: the number, and — to a screen reader — what is new. Nothing when there is none. */
export function UnreadMark({ unread }) {
  if (!unread || !unread.n) return null;
  const why = t(`taskunread.short_${(unread.reasons && unread.reasons[0]) || "answer"}`);
  return html`<span class="tb-unread" role="img" aria-label=${t("taskunread.markTip", why)} title=${t("taskunread.markTip", why)}><span class="tb-unread-dot" aria-hidden="true"></span>${unread.n > 1 ? html`<span class="tb-unread-n">${unread.n}</span>` : null}</span>`;
}

/**
 * The strip: the cards with something new, newest first (the first few; a line says how many more), each with its number, title
 * and why. `cards`: the board's cards, for their titles (a card the board does not carry shows its number). Nothing when there is nothing.
 */
export function UnreadStrip({ cards, onOpen }) {
  const unread = useUnreadCards();
  const codes = Object.keys(unread).sort((a, b) => (unread[a].at < unread[b].at ? 1 : unread[a].at > unread[b].at ? -1 : 0));
  if (!codes.length) return null;
  const byId = new Map((cards || []).map((c) => [c.id, c]));
  const shown = codes.slice(0, SHOWN);
  return html`<section class="tb-waiting tb-unread-strip" aria-label=${stripTitle(codes.length)}>
    <h3 class="tb-section-title"><${Icon} name="bell" size=${16} />${stripTitle(codes.length)}</h3>
    <ul class="rows">${shown.map((code) => {
      const u = unread[code], card = byId.get(code);
      return html`<li key=${code} class="row-item tb-unread-row" data-unread=${code}>
        <button type="button" class="tb-wait-title" onClick=${() => onOpen(code)}><span class="tb-code">${code}</span> ${card ? card.title : ""}</button>
        <span class="muted tb-unread-meta">${reasonText(u)}${u.n > 1 ? ` · ${t("taskunread.more", u.n - 1)}` : ""} · ${relTime(u.at)}</span>
      </li>`;
    })}</ul>
    ${codes.length > shown.length ? html`<p class="muted tb-unread-more">${t("taskunread.seeMore", codes.length - shown.length)}</p>` : null}
  </section>`;
}
