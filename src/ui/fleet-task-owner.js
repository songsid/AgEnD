// Who a card is with, on the board. The assignee's avatar and name on a tile (or a list row) is a button: it opens
// the same picker the card's page has for "Assignee" (nobody, each instance, Other…; the choice saves at once, through the
// board's own write — fleet-tasks.js — with the same 409 and error handling), and pointing at it (or the keyboard's focus
// on it) shows a small card: the instance, its state, what it is doing, how many cards it holds, and two things the card's
// page already has (is it the project's lead, who dispatched this card). Over a read-only link the avatar is not a button:
// it shows the card and changes nothing.
//
// The info card is built ONLY from what the viewer already has — the board's cards (a read-only link's board has left out
// the cards of instances kept out of sight) and the instances the dashboard shows them — so it can name nothing the page
// does not: an instance the viewer does not see has no state line, and a dispatcher that is not one of the viewer's
// instances is left out. No style attribute (the CSP): the card is placed through the CSSOM, as the card menu is.
import { html, useEffect, useLayoutEffect, useRef, useState } from "/assets/app-html.js";
import { t, register } from "/assets/app-i18n.js";
import { appStore } from "/assets/app-store.js";
import { detailsPath } from "/assets/app-route.js";
import { Icon } from "/assets/ui-icons.js";
import { Who, boardReadOnly } from "./fleet-task-common.js";
import { instanceStates } from "./fleet-task-run.js";

register("taskowner", {
  en: {
    change: "Change assignee", assign: "Assign", changeOf: "{0}: change assignee", info: "{0}: details",
    conflict: "{0} changed while you were choosing. The board is up to date: choose again.",
    running: "Running", needs: "Needs you", stuck: "Looks stuck", idle: "Idle", offline: "Offline",
    person: "Person", openAgent: "Open Agent page",
    now: "Now", nowNothing: "Nothing in progress", cards: "Cards", cardsN: "{0} open", lead: "Role", leadValue: "Project lead", dispatcher: "Dispatched by",
    part_claimed: "{0} in progress", part_open: "{0} to do", part_blocked: "{0} blocked", part_review: "{0} to confirm",
  },
  "zh-TW": {
    change: "切換負責人", assign: "指派", changeOf: "{0}：切換負責人", info: "{0} 的資訊",
    conflict: "{0} 在你選擇時被改過了。看板已更新，請再選一次。",
    running: "執行中", needs: "等你回應", stuck: "似乎卡住", idle: "閒置", offline: "離線",
    person: "人", openAgent: "開啟 Agent 頁面",
    now: "目前", nowNothing: "沒有進行中的卡", cards: "手上", cardsN: "{0} 張", lead: "角色", leadValue: "專案 leader", dispatcher: "派工者",
    part_claimed: "{0} 進行中", part_open: "{0} 待辦", part_blocked: "{0} 卡住", part_review: "{0} 待確認",
  },
});

// ── What the card says (pure: tests import these) ────────────

/** A card that is work in itself: a sub task, or a main task without sub tasks (a main task that follows its sub tasks is not). */
const isWork = (c) => !(c.kind === "main" && c.progress && c.progress.total > 0);

/**
 * What the board knows of `name`'s hands: the cards it is on, finished ones left out — `doing` (in progress, the work itself),
 * `by` status, `total` — and, for the card the avatar is on, whether `name` leads its project and who dispatched it. Only the
 * `cards` the viewer was sent count, so it cannot say more than the board does.
 */
export function ownerFacts(name, card, cards, lead = null) {
  const mine = (Array.isArray(cards) ? cards : []).filter((c) => c && c.assignee === name && c.status !== "done" && c.status !== "cancelled" && isWork(c));
  const by = { claimed: 0, open: 0, blocked: 0, review: 0 };
  for (const c of mine) if (c.status in by) by[c.status]++;
  return { doing: mine.filter((c) => c.status === "claimed"), by, total: mine.length, lead: !!lead && lead === name, dispatcher: card ? card.dispatcher || null : null };
}

/**
 * The state of `name` in words, or null: the viewer does not see that instance (no state is claimed for it — "offline" would
 * say something the page does not know). Running, needs you and stuck are the dashboard's own; every other state (stopped,
 * crashed, paused, starting) is "offline" here.
 */
export function ownerState(name, store = appStore.get()) {
  const state = instanceStates(store, [name]).get(name);
  if (!state) return null;
  const word = state === "working" ? "running" : state === "needs" || state === "stuck" || state === "idle" ? state : "offline";
  return { state: word, text: t(`taskowner.${word}`) };
}

/** The dispatcher the card may name: a person, or an instance the viewer sees (one kept out of sight is not named). */
export function visibleDispatcher(dispatcher, store = appStore.get()) {
  if (!dispatcher || !dispatcher.name) return null;
  if (dispatcher.kind !== "instance") return dispatcher.name;
  return ((store && store.instances) || []).some((i) => i.name === dispatcher.name) ? dispatcher.name : null;
}

const PARTS = ["claimed", "open", "blocked", "review"];

// ── The card ─────────────────────────────────────────────────

/**
 * The info card's body (pure of the DOM: tests draw it with facts). An instance: its state, what it is doing, how many cards it
 * holds, and — where the card is the board's own — two facts the card's page has; and, when `link` is given, a way to its Agent page.
 * A person (`kind: "person"`): the name and that it is a person, nothing else, no link.
 */
export function OwnerCard({ name, kind = "instance", card, facts, state, dispatcher, id, link = "" }) {
  const person = kind === "person";
  const first = !person && facts.doing[0];
  const parts = person ? [] : PARTS.filter((s) => facts.by[s]).map((s) => t(`taskowner.part_${s}`, facts.by[s]));
  return html`<div class="tb-owner-card" role="dialog" aria-label=${name} id=${id}>
    <div class="toc-head"><${Who} name=${name} plain /><span class="toc-spacer"></span>
      ${person ? html`<span class="tb-tag toc-person">${t("taskowner.person")}</span>`
        : state ? html`<span class=${`tr-mark s-${state.state === "running" ? "working" : state.state}${state.state === "offline" || state.state === "idle" ? " shared" : ""}`}><span class="tr-dot" aria-hidden="true"></span>${state.text}</span>` : null}</div>
    ${person ? null : html`<dl class="toc-rows">
      <dt>${t("taskowner.now")}</dt>
      <dd>${first ? html`<span class="tb-now-label st-claimed">${t("tasks.nowDoing")}</span> <span class="tb-code">${first.id}</span> ${first.title}${facts.doing.length > 1 ? html` <span class="muted">${t("tasks.moreCards", facts.doing.length - 1)}</span>` : null}`
        : html`<span class="muted">${t("taskowner.nowNothing")}</span>`}</dd>
      <dt>${t("taskowner.cards")}</dt>
      <dd>${t("taskowner.cardsN", facts.total)}${parts.length ? html` <span class="muted">· ${parts.join(" · ")}</span>` : null}</dd>
      ${facts.lead ? html`<dt>${t("taskowner.lead")}</dt><dd>${t("taskowner.leadValue")}</dd>` : null}
      ${dispatcher ? html`<dt>${t("taskowner.dispatcher")}</dt><dd>${dispatcher}</dd>` : null}
    </dl>`}
    ${link ? html`<a class="toc-open" href=${link}>${t("taskowner.openAgent")}<${Icon} name="forward" size=${14} /></a>` : null}
  </div>`;
}

// One info card at a time (pointing at a second avatar while the first still has the keyboard's focus), and none when the
// focus comes back to an avatar from the picker it opened (the board calls `quietInfo` before it gives the focus back).
let current = null, quietUntil = 0;
export const quietInfo = (ms = 500) => { quietUntil = Date.now() + ms; };
const CLOSE_GRACE_MS = 180;

/**
 * What every avatar with an info card does (the board's and the activity's): the card shows after a short pause on the pointer,
 * at once for the keyboard's focus, and on a tap (`toggleOnClick`: a phone has no hover). The pointer can go from the avatar into
 * the card — they are one element's children, and a short grace covers the gap — so the card's link can be clicked; the keyboard
 * can Tab into it. Esc, a tap or click outside, a scroll or a resize close it; Esc gives the focus back to the avatar.
 * `bind` goes on the element holding the avatar and the card; `anchor` is the avatar's own element.
 */
function useInfoCard(enabled, { toggleOnClick = false, delay = 220 } = {}) {
  const [shown, setShown] = useState(false);
  const timer = useRef(0), grace = useRef(0), quiet = useRef(false), hush = useRef(0), touch = useRef(false), box = useRef(null), anchor = useRef(null);
  const clear = () => { if (timer.current) clearTimeout(timer.current); timer.current = 0; if (grace.current) clearTimeout(grace.current); grace.current = 0; };
  const hide = () => { clear(); setShown(false); if (current === hide) current = null; };
  const hideRef = useRef(hide);
  hideRef.current = hide;
  useEffect(() => () => { clear(); if (current === hideRef.current) current = null; }, []);
  const show = () => { clear(); if (current && current !== hide) current(); current = hide; setShown(true); };
  useEffect(() => {
    if (!shown) return undefined;
    const away = () => hide();
    const outside = (e) => { if (box.current && e.target && box.current.contains && !box.current.contains(e.target)) hide(); };
    globalThis.addEventListener?.("scroll", away, true);
    globalThis.addEventListener?.("resize", away);
    globalThis.document?.addEventListener?.("pointerdown", outside, true);
    return () => { globalThis.removeEventListener?.("scroll", away, true); globalThis.removeEventListener?.("resize", away); globalThis.document?.removeEventListener?.("pointerdown", outside, true); };
  }, [shown]);
  // A finger has no hover: the mouse events a browser makes up after a tap (it "moves" the mouse to the tap, then away to something
  // else) must neither open the card nor close it — the tap does, and a tap outside.
  const pointer = (e) => { touch.current = e.pointerType === "touch" || e.pointerType === "pen"; };
  const bind = {
    onPointerEnter: pointer,
    onPointerDown: pointer,
    onMouseEnter: () => { if (touch.current) return; if (grace.current) { clearTimeout(grace.current); grace.current = 0; } if (!enabled || quiet.current || shown) return; if (timer.current) clearTimeout(timer.current); timer.current = setTimeout(() => { timer.current = 0; show(); }, delay); },
    onMouseLeave: () => {
      if (touch.current) return;
      quiet.current = false;
      if (timer.current) { clearTimeout(timer.current); timer.current = 0; }
      if (shown) grace.current = setTimeout(() => { grace.current = 0; hide(); }, CLOSE_GRACE_MS);
    },
    // Only the keyboard's focus shows it: a tap focuses the button too (a tap then toggles it, or opens the picker).
    onFocusIn: (e) => {
      if (!enabled || quiet.current || Date.now() < quietUntil || Date.now() < hush.current) return;
      let key = true;
      try { if (globalThis.CSS?.supports?.("selector(:focus-visible)")) key = e.target.matches(":focus-visible"); } catch { key = true; }
      if (key) show();
    },
    // Focus moving from the avatar into the card (its link) keeps it open; anywhere else closes it.
    onFocusOut: (e) => { quiet.current = false; const to = e.relatedTarget; if (to && box.current && box.current.contains && box.current.contains(to)) return; hide(); },
    // Esc closes it and the focus goes back to the avatar — which is not a reason to open it again (the focus comes from the card's link).
    onKeyDown: (e) => { if (e.key === "Escape" && shown) { e.stopPropagation(); hush.current = Date.now() + 400; hide(); anchor.current && anchor.current.focus && anchor.current.focus(); } },
  };
  const onAnchorClick = () => {
    if (!toggleOnClick) { quiet.current = true; hide(); return; }
    if (shown) { quiet.current = true; hide(); } else if (enabled) show();
  };
  return { shown, bind, box, anchor, onAnchorClick };
}

/** Above the avatar when there is room (a tile's foot is at the bottom), else under it; kept inside the window. */
function place(card, anchor) {
  if (!card || !anchor || typeof card.getBoundingClientRect !== "function") return;
  const a = anchor.getBoundingClientRect(), r = card.getBoundingClientRect();
  const w = globalThis.innerWidth || Infinity, h = globalThis.innerHeight || Infinity;
  let top = a.top - r.height - 6;
  if (top < 8) top = Math.min(a.bottom + 6, h - r.height - 8);
  card.style.left = `${Math.max(8, Math.min(a.left, w - r.width - 8))}px`;
  card.style.top = `${Math.max(8, top)}px`;
}

let seq = 0;

/** The instances the viewer is shown (the dashboard's list), as names. */
const shownNames = (store = appStore.get()) => ((store && store.instances) || []).map((i) => i.name);

/**
 * Whether a name gets an info card, and a link to its Agent page. An instance the viewer is shown: a card, and a link unless the
 * session is read-only (a guest, a public link: the Agent page needs a sign-in). A name that is not one of the viewer's instances
 * (a person, an instance removed from the fleet, one kept out of sight): a card only to a viewer who is not read-only — on a
 * read-only link it has none, and never a link. Pure of the DOM: tests import it.
 */
export function infoFor(name, { kind = "", store = appStore.get(), readOnly = boardReadOnly() } = {}) {
  if (!name || kind === "none") return { card: false, link: "" };
  if (kind === "person") return { card: true, link: "" };
  const seen = shownNames(store).includes(name);
  if (seen) return { card: true, link: readOnly ? "" : detailsPath(name) };
  return { card: !readOnly && kind !== "instance", link: "" };
}

/**
 * The assignee on a tile or a row. `canAssign`: the viewer may change it (the card is not finished, the session is not
 * read-only — `boardReadOnly`); `onPick(card, button)` opens the picker (the board draws it, where menus are not clipped by
 * the columns' scroll box). `cards`: the board's, for what the instance is doing; `lead`: the project's lead instance, if any.
 */
export function OwnerChip({ card, cards = [], lead = null, canAssign = false, onPick }) {
  const name = card.assignee;
  const pop = useRef(null);
  const id = useRef(`toc-${++seq}`);
  const store = appStore.get();
  const about = infoFor(name, { store });
  const { shown, bind, box, anchor, onAnchorClick } = useInfoCard(about.card);
  const allowed = canAssign && !boardReadOnly() && typeof onPick === "function";
  useLayoutEffect(() => { if (shown) place(pop.current, anchor.current); }, [shown]);
  let info = null;
  if (shown && name && about.card) {
    info = html`<${OwnerCard} id=${id.current} name=${name} card=${card} facts=${ownerFacts(name, card, cards, lead)} state=${ownerState(name, store)} dispatcher=${visibleDispatcher(card.dispatcher, store)} link=${about.link} />`;
  }
  const label = name ? t(allowed ? "taskowner.changeOf" : "taskowner.info", name) : t("taskowner.assign");
  const body = html`<${Who} name=${name} empty=${t("tasks.nobody")} plain />`;
  return html`<span class="tb-owner" ref=${box} ...${bind}>
    ${allowed
      ? html`<button ref=${anchor} type="button" class="tb-owner-btn" aria-haspopup="menu" aria-label=${label} aria-describedby=${info ? id.current : undefined}
          onClickCapture=${onAnchorClick} onClick=${(e) => { e.stopPropagation(); onPick(card, e.currentTarget); }}>${body}</button>`
      : html`<span ref=${anchor} class="tb-owner-btn is-static" tabindex=${name && about.card ? "0" : undefined} role=${name && about.card ? "group" : undefined} aria-label=${name && about.card ? label : undefined} aria-describedby=${info ? id.current : undefined}>${body}</span>`}
    ${info ? html`<div class="tb-owner-pop" ref=${pop}>${info}</div>` : null}
  </span>`;
}

/**
 * An author's avatar and name in the activity stream (a comment's or a progress note's head): a button that shows the same info
 * card as the board's avatar — pointing at it, the keyboard's focus, a tap — with the link to the instance's Agent page.
 * `kind`: "person" | "instance" (what the entry says; "" for an older one). `cards` and `lead` (the board's cards and the project's
 * lead) are what the card says of an instance. An author with no card to show (an instance the viewer does not see) is the plain
 * avatar and name: nothing to point at.
 */
export function WhoCard({ name, kind = "", presence = false, cards = [], lead = null }) {
  const pop = useRef(null);
  const id = useRef(`toc-${++seq}`);
  const store = appStore.get();
  const person = kind === "person";
  const about = infoFor(name, { kind, store });
  const { shown, bind, box, anchor, onAnchorClick } = useInfoCard(about.card, { toggleOnClick: true });
  useLayoutEffect(() => { if (shown) place(pop.current, anchor.current); }, [shown]);
  if (!about.card) return html`<${Who} name=${name} presence=${presence} plain />`;
  const info = shown ? html`<${OwnerCard} id=${id.current} name=${name} kind=${person ? "person" : "instance"} facts=${ownerFacts(name, null, cards, lead)} state=${person ? null : ownerState(name, store)} link=${about.link} />` : null;
  return html`<span class="tl-who-wrap" ref=${box} ...${bind}>
    <button ref=${anchor} type="button" class="tl-who-btn" aria-haspopup="dialog" aria-expanded=${shown ? "true" : "false"} aria-describedby=${info ? id.current : undefined} onClick=${onAnchorClick}>
      <${Who} name=${name} presence=${presence} plain /></button>
    ${info ? html`<div class="tb-owner-pop" ref=${pop}>${info}</div>` : null}
  </span>`;
}

/** What workers show beside the owner on a main task that follows its sub tasks: only those who are not the owner. */
export const otherWorkers = (workers, owner) => workers.filter((w) => w && w !== owner);
