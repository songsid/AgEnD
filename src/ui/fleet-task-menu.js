// #2246 follow-up, after Linear (as Circle, ln-dev7/circle, draws it): a card's own menu on the task board, and
// stepping from the open card to the next. A right click on a card — a board tile, a list row, a waiting row — or the
// keyboard's menu key (Shift+F10) on it opens its menu there: open it; confirm, send back or answer it when it waits for
// you; move it to another status; give it to another instance; change its priority; copy its link or number; cancel
// it. Each choice goes through the same calls and questions as the card's dialog (a reason to block, to send back).
// The dialog's Previous / Next (K / J) walk the cards in the order the page showed them when the card was opened.
// No style attribute anywhere (the CSP): the menu is placed through the CSSOM.
import { html, useEffect, useLayoutEffect, useRef } from "/assets/app-html.js";
import { t, register } from "/assets/app-i18n.js";
import { Icon } from "/assets/ui-icons.js";
import { COLUMNS, followsSubs, waitsForYou } from "./fleet-task-common.js";

register("taskmenu", {
  en: {
    label: "{0}: actions", open: "Open", moveTo: "Move to", assignee: "Assignee", priority: "Priority",
    copyLink: "Copy link", copyId: "Copy card number", copied: "Copied {0}", cancel: "Cancel this card…",
    prev: "Previous card (K)", next: "Next card (J)", position: "{0} / {1}",
  },
  "zh-TW": {
    label: "{0}：動作", open: "打開", moveTo: "移到", assignee: "負責人", priority: "優先度",
    copyLink: "複製連結", copyId: "複製卡號", copied: "已複製 {0}", cancel: "取消這張卡…",
    prev: "上一張（K）", next: "下一張（J）", position: "{0} / {1}",
  },
});

// ── What a card's menu offers (pure: tests import these) ─────

const PRIORITIES = ["urgent", "high", "normal", "low"];

/**
 * The statuses a person may move a card to by hand, as a drop on the board allows: any, except that a main task that
 * follows its sub tasks is only confirmed or sent back from review, blocked, or resumed when blocked.
 */
export function movesFor(card) {
  if (card.status === "cancelled") return [];
  const derived = followsSubs(card);
  return COLUMNS.filter((to) => to !== card.status && (!derived || (card.status === "review" && (to === "done" || to === "claimed"))
    || (to === "blocked" && card.status !== "done") || (card.status === "blocked" && to === "claimed")));
}

/**
 * A card's menu items. `act` runs a choice: { kind: "open" | "confirm" | "sendBack" | "answer" | "move" | "assign" |
 * "assignOther" | "priority" | "copyLink" | "copyId" | "cancel", to?, value? }. `names`: the assignees offered (the
 * project's — a fleet can have dozens of instances; Other… names any). Over the public link only open and copy.
 */
export function cardMenuItems(card, { writable, names, act }) {
  const yours = writable && waitsForYou(card);
  const items = [{ key: "open", label: t("taskmenu.open"), icon: "external", onSelect: () => act({ kind: "open" }) }];
  if (yours && card.status === "review") {
    items.push({ key: "confirm", label: t("tasks.confirm"), icon: "check", onSelect: () => act({ kind: "confirm" }) });
    items.push({ key: "sendBack", label: t("tasks.sendBack"), icon: "back", onSelect: () => act({ kind: "sendBack" }) });
  }
  if (yours && card.status === "blocked") items.push({ key: "answer", label: t("tasks.answer"), icon: "chat", onSelect: () => act({ kind: "answer" }) });
  if (writable) {
    const moves = movesFor(card);
    if (moves.length) {
      items.push({ key: "h-move", heading: true, label: t("taskmenu.moveTo") });
      for (const to of moves) items.push({ key: `move-${to}`, label: t(`tasks.${to}`), dot: to, onSelect: () => act({ kind: "move", to }) });
    }
    if (card.status !== "done" && card.status !== "cancelled") {
      items.push({ key: "h-assignee", heading: true, label: t("taskmenu.assignee") });
      const all = [...new Set([...names, card.assignee].filter(Boolean))].sort((a, b) => a.localeCompare(b));
      for (const name of [...all, null]) {
        items.push({ key: `assign-${name ?? ""}`, label: name ?? t("tasks.nobody"), checked: card.assignee === name, onSelect: () => act({ kind: "assign", value: name }) });
      }
      items.push({ key: "assign-other", label: t("taskcard.other"), onSelect: () => act({ kind: "assignOther" }) });
    }
    items.push({ key: "h-priority", heading: true, label: t("taskmenu.priority") });
    for (const p of PRIORITIES) items.push({ key: `priority-${p}`, label: t(`tasks.${p}`), checked: card.priority === p, onSelect: () => act({ kind: "priority", value: p }) });
  }
  items.push({ key: "h-copy", heading: true, label: "" });
  items.push({ key: "copyLink", label: t("taskmenu.copyLink"), icon: "copy", onSelect: () => act({ kind: "copyLink" }) });
  items.push({ key: "copyId", label: t("taskmenu.copyId"), icon: "copy", onSelect: () => act({ kind: "copyId" }) });
  if (writable && card.status !== "done" && card.status !== "cancelled") {
    items.push({ key: "cancel", label: t("taskmenu.cancel"), icon: "trash", danger: true, onSelect: () => act({ kind: "cancel" }) });
  }
  return items;
}

/**
 * The card a right click (or the menu key) lands on: a board tile, a list row, a waiting row — its number, or null.
 * The browser's own menu stays, as on a chat message, with Shift, over selected text, and on a link or a field.
 */
export function cardAt(e) {
  const target = e && e.target;
  if (!target || typeof target.closest !== "function" || e.shiftKey) return null;
  const sel = globalThis.getSelection ? globalThis.getSelection() : null;
  if (sel && !sel.isCollapsed && String(sel).trim()) return null;
  if (target.closest("a[href], input, textarea, select, [contenteditable='true']")) return null;
  const el = target.closest("[data-tile], [data-row], [data-wait]");
  return el ? { id: el.getAttribute("data-tile") || el.getAttribute("data-row") || el.getAttribute("data-wait"), el } : null;
}

/** The cards in the page's order — the board's columns, the list's rows, the waiting rows — each once. */
export function pageOrder(root = globalThis.document) {
  if (!root || typeof root.querySelectorAll !== "function") return [];
  const ids = [...root.querySelectorAll(".tb [data-tile], .tb [data-row], .tb [data-wait]")]
    .map((el) => el.getAttribute("data-tile") || el.getAttribute("data-row") || el.getAttribute("data-wait"));
  return [...new Set(ids.filter(Boolean))];
}

/**
 * Where the open card is in a walk: the page's order when it is in it, else (a sub task opened from its main task)
 * among its main task's sub tasks; null with nowhere to step.
 */
export function stepsOf(trail, id, cards) {
  let ids = trail;
  if (!ids.includes(id)) {
    const card = cards.find((c) => c.id === id);
    if (!card || card.kind !== "sub") return null;
    ids = cards.filter((c) => c.kind === "sub" && c.parentId === card.parentId && c.status !== "cancelled").sort((a, b) => a.sort - b.sort).map((c) => c.id);
  }
  const i = ids.indexOf(id);
  if (i < 0 || ids.length < 2) return null;
  return { at: i + 1, total: ids.length, prev: ids[i - 1] ?? null, next: ids[i + 1] ?? null };
}

// ── The menu ──────────────────────────────────────────────

const ITEM = "[role=menuitem]:not([disabled]), [role=menuitemradio]:not([disabled])";

/**
 * A card's menu at a point (a right click's; under the card for the keyboard), kept inside the window. Arrow keys move,
 * Enter chooses, Esc or a click elsewhere closes it, and the focus goes back to the card.
 */
export function CardMenu({ at, items, label, onClose }) {
  const list = useRef(null);
  useLayoutEffect(() => {
    const el = list.current;
    if (!el) return;
    const w = globalThis.innerWidth || Infinity, h = globalThis.innerHeight || Infinity;
    const r = typeof el.getBoundingClientRect === "function" ? el.getBoundingClientRect() : { width: 0, height: 0 };
    el.style.left = `${Math.max(8, Math.min(at.x, w - r.width - 8))}px`;
    el.style.top = `${Math.max(8, Math.min(at.y, h - r.height - 8))}px`;
  }, [at.x, at.y]);
  useEffect(() => {
    const first = list.current && list.current.querySelector(ITEM);
    if (first) first.focus();
    const outside = (e) => { if (list.current && !list.current.contains(e.target)) onClose(false); };
    const away = () => onClose(false);
    document.addEventListener("pointerdown", outside, true);
    globalThis.addEventListener?.("resize", away);
    return () => { document.removeEventListener("pointerdown", outside, true); globalThis.removeEventListener?.("resize", away); };
  }, []);
  function onKey(e) {
    const all = [...list.current.querySelectorAll(ITEM)];
    const i = all.indexOf(document.activeElement);
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(true); }
    else if (e.key === "ArrowDown") { e.preventDefault(); (all[(i + 1) % all.length] || all[0])?.focus(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); (all[(i - 1 + all.length) % all.length] || all[0])?.focus(); }
    else if (e.key === "Home") { e.preventDefault(); all[0]?.focus(); }
    else if (e.key === "End") { e.preventDefault(); all[all.length - 1]?.focus(); }
    else if (e.key === "Tab") onClose(false);
  }
  const choose = (item) => { onClose(true); item.onSelect(); };
  return html`<div data-trust="menu" ref=${list} class="menu-list tb-card-menu" role="menu" aria-label=${label} onKeyDown=${onKey} onContextMenu=${(e) => e.preventDefault()}>
    ${items.map((item) => item.heading
      ? html`<div key=${item.key} class=${`menu-heading${item.label ? "" : " bare"}`} role="presentation">${item.label}</div>`
      : item.checked !== undefined
        ? html`<button key=${item.key} type="button" role="menuitemradio" aria-checked=${item.checked ? "true" : "false"} class="menu-item menu-radio" onClick=${() => choose(item)}>
          <span class="menu-tick" aria-hidden="true">${item.checked ? html`<${Icon} name="check" size=${16} />` : null}</span><span>${item.label}</span></button>`
        : html`<button key=${item.key} type="button" role="menuitem" class=${`menu-item${item.danger ? " danger" : ""}`} onClick=${() => choose(item)}>
          ${item.dot ? html`<span class=${`tb-dot st-${item.dot}`} aria-hidden="true"></span>` : item.icon ? html`<${Icon} name=${item.icon} size=${16} />` : null}<span>${item.label}</span></button>`)}
  </div>`;
}

/** The open card's Previous / Next, with where it is ("3 of 12"), for the dialog's header. */
export function StepButtons({ steps, onOpen }) {
  // K / J step as Linear's do — not while typing (a field, a select, an editable text) nor with a modifier.
  useEffect(() => {
    const onKey = (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || (e.key !== "j" && e.key !== "k")) return;
      const el = e.target;
      if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName || ""))) return;
      const to = e.key === "j" ? steps.next : steps.prev;
      if (!to) return;
      e.preventDefault();
      onOpen(to);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [steps.prev, steps.next]);
  return html`<span class="tc-steps">
    <button type="button" class="icon-btn" disabled=${!steps.prev} title=${t("taskmenu.prev")} aria-label=${t("taskmenu.prev")} onClick=${() => steps.prev && onOpen(steps.prev)}><${Icon} name="up" size=${16} /></button>
    <span class="muted tc-step-at" aria-live="polite">${t("taskmenu.position", steps.at, steps.total)}</span>
    <button type="button" class="icon-btn" disabled=${!steps.next} title=${t("taskmenu.next")} aria-label=${t("taskmenu.next")} onClick=${() => steps.next && onOpen(steps.next)}><${Icon} name="down" size=${16} /></button>
  </span>`;
}
